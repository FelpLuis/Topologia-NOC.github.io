import http from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { createHash, timingSafeEqual } from "node:crypto";
import { loadCollectorEnv, collectorConfig } from "./env.mjs";
import { collectZte, collectZteStates, closeZteSessions } from "./zte-cli.mjs";
import { collectIxc, collectIxcLoginStatuses, conexaoNoCliente } from "./ixc-client.mjs";
import { provisionPendingJobs } from "./provision.mjs";

await loadCollectorEnv();
const config = collectorConfig();

/* Três ritmos, não um.

   O ciclo completo (minutos) traz o cadastro: quem é o cliente, onde mora, em
   que caixa entra, qual o serial da ONU. Isso quase nunca muda e custa caro —
   varrer a baseinfo de cada PON e paginar o IXC inteiro.

   Os dois ciclos rápidos (10 s) trazem só estado, e correm em paralelo porque
   observam camadas diferentes: a OLT sabe se a ONU está acesa na fibra, o
   Radius do IXC sabe se o cliente autenticou. Cada um segue no seu passo — uma
   OLT lenta não pode segurar a leitura do Radius, e vice-versa. */
const state = {
  clients: [], boxes: [], alerts: [], syncedAt: null, errors: [],
  ixc: null, ixcStats: null, ixcSyncedAt: 0, publishedStatus: new Map(), hasSnapshot: false,
  syncing: null, ontSyncing: null, radiusSyncing: null,
  ont: new Map(), radius: new Map(),
  ontCycleMs: null, radiusCycleMs: null, ontSyncedAt: null, radiusSyncedAt: null,
};

const safeEqual = (a, b) => {
  const digest = (value) => createHash("sha256").update(String(value)).digest();
  return timingSafeEqual(digest(a), digest(b));
};
const authorized = (request) => safeEqual(request.headers.authorization || "", `Bearer ${config.token}`);

/* Um erro de uma fonte não pode apagar o de outra nem se acumular em duplicata:
   a lista guarda o último problema conhecido de cada origem. */
function registrarErro(origem, mensagem) {
  state.errors = [...state.errors.filter((entry) => (entry.source || entry.olt_id) !== origem),
    { source: origem, message: String(mensagem || "").slice(0, 400) }];
}
function limparErro(origem) {
  state.errors = state.errors.filter((entry) => (entry.source || entry.olt_id) !== origem);
}

async function loadMap() {
  try {
    const raw = await readFile(path.resolve("collector/client-map.json"), "utf8");
    return JSON.parse(raw);
  } catch (error) {
    if (error?.code === "ENOENT") return {};
    throw error;
  }
}

async function pushSnapshot() {
  const payload = { source: "Coletor ZTE + IXC Provedor", origin: "ont+ixc", synced_at: state.syncedAt,
    clients: state.clients, boxes: state.boxes, alerts: state.alerts };
  const response = await fetch(config.pushUrl, {
    method: "POST",
    headers: { Authorization: `Bearer ${config.pushToken}`, "Content-Type": "application/json" },
    body: JSON.stringify(payload), signal: AbortSignal.timeout(120000),
  });
  if (!response.ok) throw new Error(`Worker GPON: HTTP ${response.status}`);
}

/* O que conta como "mudou" para efeito de delta.

   Uptime fica de fora de propósito: ele avança um segundo por segundo, e
   incluí-lo faria todo cliente online virar uma linha do delta a cada ciclo —
   o parque inteiro no fio de 10 em 10 segundos, exatamente o que o delta
   existe para evitar. Vai no lugar dele o `conn_since`, que é estático durante
   a sessão e permite à tela derivar o uptime vivo sem tráfego nenhum.

   O consumo entra arredondado a MiB pelo mesmo motivo: em bytes crus, qualquer
   cliente passando tráfego reescreveria a própria linha todo ciclo. */
/* `Number(null)` é 0, então o consumo ausente virava "zerado" aqui — e a
   assinatura era calculada ora sobre o cliente (campo ausente → `undefined` →
   null) ora sobre a linha publicada (campo ausente → `null` → 0). As duas
   nunca batiam para quem o IXC não informa consumo, e essas ONUs voltavam no
   delta a cada 10 s sem ter mudado nada. */
const mib = (bytes) => {
  if (bytes === null || bytes === undefined || bytes === "") return null;
  const valor = Number(bytes);
  return Number.isFinite(valor) ? Math.round(valor / 1048576) : null;
};

/* A linha como ela vai no fio. A assinatura é calculada sobre ela, e não sobre
   o cliente: assim comparar e publicar enxergam exatamente o mesmo dado, e
   qualquer normalização feita aqui vale para os dois lados por construção. */
const linhaStatus = (client) => ({
  id: client.id, status: client.status, state_detail: client.state_detail,
  rx_power: client.rx_power ?? null, tx_power: client.tx_power ?? null,
  olt_id: client.olt_id || "", onu_index: client.onu_index || "",
  serial: client.serial || "", name: client.name || "",
  /* Tráfego e conexão viajam no mesmo delta do estado: é uma leitura só do
     Radius e uma escrita só no Worker, em vez de um segundo canal com o
     mesmo custo de paginação. */
  ip: client.ip || "", down_kbps: client.down_kbps ?? null, up_kbps: client.up_kbps ?? null,
  down_bytes: client.down_bytes ?? null, up_bytes: client.up_bytes ?? null,
  uptime_s: client.uptime_s ?? null, conn_since: client.conn_since || "", nas_id: client.nas_id || "",
});

const statusSignature = (linha) => JSON.stringify([
  linha.status || "unknown", linha.state_detail || "", linha.rx_power ?? null, linha.tx_power ?? null,
  linha.ip || "", linha.down_kbps ?? null, linha.up_kbps ?? null,
  linha.conn_since || "", linha.nas_id || "", mib(linha.down_bytes), mib(linha.up_bytes)
]);

async function enviarStatus(body) {
  const response = await fetch(config.pushUrl.replace(/\/ingest$/, "/status"), {
    method: "POST",
    headers: { Authorization: `Bearer ${config.pushToken}`, "Content-Type": "application/json" },
    body: JSON.stringify(body), signal: AbortSignal.timeout(60000),
  });
  if (!response.ok) throw new Error(`Worker GPON status: HTTP ${response.status}`);
}

/* Só o que mudou desde a última publicação vai no fio. O Worker guarda a linha
   do tempo a partir daqui, então cada mudança leva junto a identidade da ONU —
   sem ela o histórico seria uma lista de ids sem quem, onde nem em qual OLT. */
async function pushStatus(origem) {
  const changes = state.clients.map(linhaStatus)
    .filter((linha) => state.publishedStatus.get(linha.id) !== statusSignature(linha));
  /* Um ciclo sem mudança ainda precisa chegar ao Worker: é ele que registra o
     batimento na auditoria e distingue "a rede está estável" de "o coletor
     parou". O corpo vazio é barato. */
  await enviarStatus({ synced_at: state.syncedAt, origin: origem, changes });
  changes.forEach((linha) => state.publishedStatus.set(linha.id, statusSignature(linha)));
  return changes.length;
}

const radiusStatus = (value) => {
  const normalized = String(value || "").trim().toLowerCase();
  if (/^(s|sim|1|true|online|yes)$/.test(normalized)) return "online";
  if (/^(n|nao|não|0|false|offline|no)$/.test(normalized)) return "offline";
  return null;
};

/* O ciclo rápido passou a trazer a conexão inteira, e não só o "S"/"N" do
   login. O ciclo completo semeia o mapa a partir do cadastro, onde ainda pode
   haver só a string — por isso as duas formas são aceitas aqui. */
const radiusOnline = (entry) => radiusStatus(entry && typeof entry === "object" ? entry.online : entry);
const radiusDados = (entry) => (entry && typeof entry === "object" ? conexaoNoCliente(entry) : null);

/* Compara a leitura nova do Radius com a anterior, login a login, e devolve
   só quem mudou de fato — é o que vira linha em radius_logs. `enviarRadiusLogs`
   já existia pronta para receber esses eventos; faltava só quem os gerasse: a
   função nunca era chamada, então o log ficava sempre vazio mesmo com o
   Radius respondendo normalmente. O primeiro ciclo não gera avalanche de
   eventos porque `state.radius` já chega semeado pelo cadastro (syncFull),
   então "anterior" nunca é um mapa vazio de verdade. */
function radiusTransicoes(anterior, atual) {
  const eventos = [];
  for (const [login, entrada] of atual) {
    const depois = radiusOnline(entrada);
    if (!depois) continue; // leitura sem "S"/"N" reconhecível: nada para comparar
    const antes = radiusOnline(anterior?.get(login));
    if (antes === depois) continue;
    const cliente = state.clients.find((c) => String(c.ixc_login_id || "") === login);
    eventos.push({
      client_id: cliente?.id || `ixc-${login}`,
      ixc_login_id: login,
      username: entrada?.username || cliente?.username || "",
      status_before: antes || "",
      status_after: depois,
      detail: depois === "online" ? "Autenticação PPPoE aceita" : "PPPoE desconectado",
      olt_id: cliente?.olt_id || "",
      onu_index: cliente?.onu_index || "",
      serial: cliente?.serial || "",
      client_name: cliente?.name || "",
    });
  }
  return eventos;
}

/* ---- ingestão de logs RADIUS no Worker ----

   Cada ciclo rápido do Radius compara o status anterior com o novo: quando
   há transição (online → offline, offline → online), um evento é coletado e
   enviado ao Worker em /api/radius/ingest, que grava na tabela radius_logs.
   Isso isola a autenticação PPPoE da linha do tempo GPON, dando ao NOC um
   indicador direto de saúde do servidor RADIUS e ao HelpDesk o motivo exato
   de um cliente sem serviço. */
async function enviarRadiusLogs(events) {
  if (!events.length) return { sent: 0 };
  /* A rota do Worker é /api/radius/ingest, irmã de /api/gpon/ingest e não
     filha dela: recortar só o "/ingest" final montava /api/gpon/radius/ingest,
     que não existe. Todo ciclo com transição de PPPoE levava 404 e nenhum
     evento chegava a radius_logs — a tabela ficou vazia desde que passou a ser
     alimentada. O recorte inclui o "/gpon" justamente para trocar de irmã. */
  const radiusIngestUrl = config.pushUrl.replace(/\/gpon\/ingest$/, "/radius/ingest");
  const response = await fetch(radiusIngestUrl, {
    method: "POST",
    headers: { Authorization: `Bearer ${config.pushToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ events, synced_at: state.syncedAt || new Date().toISOString(), origin: "collector" }),
    signal: AbortSignal.timeout(30000),
  });
  if (!response.ok) throw new Error(`Worker RADIUS ingest: HTTP ${response.status}`);
  return response.json();
}

/* A ONU acesa e o cliente autenticado são duas perguntas diferentes, e o
   operador precisa das duas na mesma linha. A fibra manda: se a ONU não está
   working, não há autenticação que salve. Com a ONU de pé mas sem Radius, o
   cliente está fora do mesmo jeito — e o detalhe diz em qual camada, que é o
   que decide se o chamado é de campo ou de provisionamento. */
function combinarEstado(client) {
  const chave = String(client.ixc_login_id || "");
  const ont = state.ont.get(client.id);
  const entrada = chave && state.radius.has(chave) ? state.radius.get(chave) : null;
  const radius = radiusOnline(entrada);
  /* Tráfego e conexão vêm do Radius e valem qualquer que seja o veredito do
     estado: um cliente offline com IP e velocidade na ficha é o que mostra
     que o login existe e está provisionado — o contrário de um login que o
     IXC não conhece. Um cliente sem leitura nova mantém o que já tinha. */
  const conexao = radiusDados(entrada) || {};

  if (ont && ont.status !== "online")
    return { ...conexao, status: ont.status, state_detail: `ONU ${ont.detail || ont.status}` };
  if (radius === "offline")
    return { ...conexao, status: "offline", state_detail: ont ? "ONU ativa • Radius offline" : "Radius offline" };
  if (ont) return { ...conexao, status: "online", state_detail: radius === "online" ? "ONU working • Radius online" : "ONU working" };
  if (radius === "online") return { ...conexao, status: "online", state_detail: "Radius online" };
  return Object.keys(conexao).length ? conexao : null;
}

const montarAlertas = () => [
  ...state.clients.filter((c) => c.status !== "online").map((c) => ({
    level: "warning", client_id: c.id, title: `${c.name} — ${c.state_detail}`, detail: `${c.olt_id} • ${c.onu_index}` })),
  ...state.errors.map((e) => ({ level: "critical", title: `Falha ao consultar ${e.olt_id || e.source}`, detail: e.message })),
];

/* Recalcula o estado de todo mundo a partir das duas leituras e publica o
   delta. Barato: percorre a lista em memória, não fala com OLT nem com IXC. */
async function aplicarEstado(origem) {
  state.clients = state.clients.map((client) => {
    const combinado = combinarEstado(client);
    return combinado ? { ...client, ...combinado } : client;
  });
  state.alerts = montarAlertas();
  state.syncedAt = new Date().toISOString();
  const enviadas = await pushStatus(origem);
  limparErro("Worker GPON");
  return enviadas;
}

/* ---- ciclo completo: cadastro + estado ---- */
/* `forcar` é o caminho do botão "Atualizar" da tela: lê a OLT inteira e ignora
   a janela de recirculação do IXC, para a resposta ser fresca de verdade e não
   uma reedição da última coleta dentro do intervalo. */
async function syncFull(forcar = false) {
  if (state.syncing) return state.syncing;
  state.syncing = (async () => {
    const mapping = await loadMap(), collected = [];
    const refreshIxc = forcar || !state.ixc || Date.now() - state.ixcSyncedAt >= config.ixcIntervalMs;
    const [results, ixcResult] = await Promise.all([
      Promise.allSettled(config.devices.map((device) => collectZte(device))),
      refreshIxc ? collectIxc(config.ixc).then((value) => ({ value }), (error) => ({ error })) : Promise.resolve({ value: state.ixc }),
    ]);
    results.forEach((result, index) => {
      if (result.status === "fulfilled") { collected.push(...result.value); limparErro(config.devices[index].id); }
      else registrarErro(config.devices[index].id, result.reason?.message || String(result.reason));
    });
    if (ixcResult.value) {
      state.ixc = ixcResult.value; state.ixcStats = ixcResult.value.stats;
      if (refreshIxc) { state.ixcSyncedAt = Date.now(); limparErro("IXC"); }
    }
    else registrarErro("IXC", ixcResult.error?.message || String(ixcResult.error));

    /* A leitura completa também alimenta as duas fontes rápidas: sem isso o
       primeiro ciclo de 10 s compararia contra um mapa vazio e devolveria todo
       mundo ao estado bruto da OLT. */
    collected.forEach((onu) => state.ont.set(onu.id, { status: onu.status, detail: onu.state_detail }));

    let matchedIxc = 0;
    state.clients = collected.map((client) => {
      const ixc = state.ixc?.match(client);
      if (ixc) matchedIxc += 1;
      return { ...client, ...(ixc || {}), ...(mapping[`${client.olt_id}|${client.onu_index}`] || {}) };
    });
    /* A semeadura carrega a conexão inteira, e não só o "S"/"N": sem isso o
       primeiro ciclo rápido apagaria IP, velocidade e consumo que o cadastro
       acabou de trazer, e a ficha piscaria vazia entre os dois ritmos. */
    for (const client of state.clients)
      if (client.ixc_login_id && client.ixc_online !== undefined && !state.radius.has(String(client.ixc_login_id)))
        state.radius.set(String(client.ixc_login_id), {
          online: client.ixc_online, ip: client.ip, username: client.username,
          uptime_s: client.uptime_s ?? null, down_kbps: client.down_kbps ?? null, up_kbps: client.up_kbps ?? null,
          down_bytes: client.down_bytes ?? null, up_bytes: client.up_bytes ?? null,
          since: client.conn_since || "", nas_id: client.nas_id || "",
        });
    state.clients = state.clients.map((client) => {
      const combinado = combinarEstado(client);
      return combinado ? { ...client, ...combinado } : client;
    });

    state.boxes = Array.isArray(mapping.boxes) && mapping.boxes.length ? mapping.boxes : (state.ixc?.boxes || []);
    state.ixcStats = state.ixcStats ? { ...state.ixcStats, matchedOnus: matchedIxc } : null;
    state.alerts = montarAlertas();
    state.syncedAt = new Date().toISOString();
    state.ontSyncedAt = state.syncedAt;

    try {
      await pushSnapshot();
      state.publishedStatus = new Map(state.clients.map((client) => [client.id, statusSignature(linhaStatus(client))]));
      state.hasSnapshot = true;
      limparErro("Worker GPON");
    } catch (error) {
      registrarErro("Worker GPON", error?.message || String(error));
      state.alerts.push({ level: "critical", title: "Falha ao publicar mapa GPON", detail: state.errors.at(-1).message });
    }
    return state;
  })().finally(() => { state.syncing = null; });
  return state.syncing;
}

/* ---- ciclo rápido A: estado das ONUs direto na OLT ---- */
async function syncOnt() {
  if (!config.ontFast || state.ontSyncing || state.syncing || !state.hasSnapshot) return state.ontSyncing;
  const inicio = Date.now();
  state.ontSyncing = (async () => {
    const results = await Promise.allSettled(config.devices.map((device) => collectZteStates(device)));
    const leitura = new Map();
    let algumaFonte = false;
    results.forEach((result, index) => {
      if (result.status !== "fulfilled") return registrarErro(config.devices[index].id, result.reason?.message || String(result.reason));
      algumaFonte = true;
      limparErro(config.devices[index].id);
      result.value.forEach((onu) => leitura.set(onu.id, { status: onu.status, detail: onu.state_detail }));
    });
    /* Uma OLT que falhou não pode apagar as ONUs que ela reportava: a leitura
       nova só sobrescreve as entradas das OLTs que responderam. */
    if (!algumaFonte) return;
    leitura.forEach((valor, id) => state.ont.set(id, valor));
    state.ontCycleMs = Date.now() - inicio;
    state.ontSyncedAt = new Date().toISOString();
    await aplicarEstado("ont");
  })().catch((error) => {
    registrarErro("ONT", error?.message || String(error));
  }).finally(() => { state.ontSyncing = null; });
  return state.ontSyncing;
}

/* ---- ciclo rápido B: autenticação no Radius do IXC ---- */
async function syncRadius() {
  if (state.radiusSyncing || state.syncing || !state.clients.length || !state.hasSnapshot) return state.radiusSyncing;
  const inicio = Date.now();
  state.radiusSyncing = (async () => {
    const anterior = state.radius;
    state.radius = await collectIxcLoginStatuses(config.ixc);
    state.radiusCycleMs = Date.now() - inicio;
    state.radiusSyncedAt = new Date().toISOString();
    const eventos = radiusTransicoes(anterior, state.radius);
    await aplicarEstado("ixc");
    if (eventos.length) {
      try { await enviarRadiusLogs(eventos); limparErro("RADIUS log"); }
      catch (error) { registrarErro("RADIUS log", error?.message || String(error)); }
    }
    limparErro("IXC Radius");
  })().catch((error) => {
    registrarErro("IXC Radius", error?.message || String(error));
  }).finally(() => { state.radiusSyncing = null; });
  return state.radiusSyncing;
}

if (process.argv.includes("--once")) {
  await syncFull();
  console.log(JSON.stringify({ synced_at: state.syncedAt, clients: state.clients.length, errors: state.errors }, null, 2));
  closeZteSessions();
  process.exit(state.errors.length ? 1 : 0);
}

const saude = () => ({
  ok: true,
  syncing: Boolean(state.syncing || state.ontSyncing || state.radiusSyncing),
  full_syncing: Boolean(state.syncing),
  ont_syncing: Boolean(state.ontSyncing),
  radius_syncing: Boolean(state.radiusSyncing),
  synced_at: state.syncedAt,
  ont_synced_at: state.ontSyncedAt, ont_cycle_ms: state.ontCycleMs,
  radius_synced_at: state.radiusSyncedAt, radius_cycle_ms: state.radiusCycleMs,
  interval_ms: config.intervalMs, ont_fast: config.ontFast,
  clients: state.clients.length, boxes: state.boxes.length, errors: state.errors,
});

const server = http.createServer(async (request, response) => {
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("Cache-Control", "no-store");
  if (request.url === "/health") return response.end(JSON.stringify(saude()));
  if (request.url === "/api/gpon/sync" && request.method === "POST") {
    if (!authorized(request)) { response.statusCode = 401; return response.end(JSON.stringify({ error: "UNAUTHORIZED" })); }
    try {
      /* O coletor também empurra o snapshot para o Worker ao final de syncFull:
         além de responder com o estado fresco, a força também atualiza o D1. */
      await syncFull(true);
      response.end(JSON.stringify({ source: "Coletor ZTE + IXC Provedor", forced: true, synced_at: state.syncedAt,
        ixc: state.ixcStats, clients: state.clients, boxes: state.boxes, alerts: state.alerts }));
    } catch (error) {
      response.statusCode = 503; response.end(JSON.stringify({ error: "COLLECTOR_UNAVAILABLE" }));
    }
    return;
  }
  if (request.url !== "/api/gpon/clientes") { response.statusCode = 404; return response.end(JSON.stringify({ error: "NOT_FOUND" })); }
  if (!authorized(request)) { response.statusCode = 401; return response.end(JSON.stringify({ error: "UNAUTHORIZED" })); }
  try {
    if (!state.syncedAt) await syncFull();
    response.end(JSON.stringify({ source: "Coletor ZTE + IXC Provedor", synced_at: state.syncedAt, ixc: state.ixcStats, clients: state.clients, boxes: state.boxes, alerts: state.alerts }));
  } catch (error) {
    response.statusCode = 503; response.end(JSON.stringify({ error: "COLLECTOR_UNAVAILABLE" }));
  }
});

server.listen(config.port, config.host, () => {
  console.log(JSON.stringify({ message: "Coletor GPON iniciado", address: `${config.host}:${config.port}`,
    interval_ms: config.intervalMs, ont_fast: config.ontFast, full_interval_ms: config.ixcIntervalMs }));
  void syncFull().catch((error) => console.error(JSON.stringify({ message: "Falha na sincronização GPON", error: error?.message || String(error) })));
});

/* Os dois ciclos rápidos batem no mesmo intervalo mas não se esperam: cada um
   pula a vez enquanto a anterior não terminou, então uma OLT lenta se
   auto-regula sem atrasar o Radius. */
const ontTimer = setInterval(() => { void syncOnt(); }, config.intervalMs);
ontTimer.unref();
const radiusTimer = setInterval(() => { void syncRadius(); }, config.intervalMs);
radiusTimer.unref();
const fullTimer = setInterval(() => {
  void syncFull().catch((error) => console.error(JSON.stringify({ message: "Falha na sincronização completa GPON", error: error?.message || String(error) })));
}, config.ixcIntervalMs);
fullTimer.unref();

for (const sinal of ["SIGINT", "SIGTERM"]) process.once(sinal, () => {
  closeZteSessions();
  server.close(() => process.exit(0));
});

/* ---- provisionamento de usuários nos aparelhos ---- */
let provisioningRunning = false;
async function runProvisioning() {
  if (!config.provisioning.url || provisioningRunning) return;
  provisioningRunning = true;
  try {
    const result = await provisionPendingJobs(config.provisioning, (log) =>
      console.log(JSON.stringify({ message: `Provisionamento: ${log}`, at: new Date().toISOString() })));
    if (result.jobs) console.log(JSON.stringify({ message: "Provisionamento concluído", ...result, at: new Date().toISOString() }));
  } catch (error) {
    console.error(JSON.stringify({ message: "Falha no provisionamento", error: error?.message || String(error), at: new Date().toISOString() }));
  } finally {
    provisioningRunning = false;
  }
}
if (config.provisioning.url) {
  console.log(JSON.stringify({ message: "Provisionamento de usuários ativo", url: config.provisioning.url, interval_ms: config.provisioning.intervalMs }));
  setTimeout(runProvisioning, 8000);
  const provisioningTimer = setInterval(runProvisioning, config.provisioning.intervalMs);
  provisioningTimer.unref();
}
