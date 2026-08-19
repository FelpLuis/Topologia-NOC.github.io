import http from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { createHash, timingSafeEqual } from "node:crypto";
import { loadCollectorEnv, collectorConfig } from "./env.mjs";
import { collectZte, collectZteStates, closeZteSessions } from "./zte-cli.mjs";
import { collectIxc, collectIxcLoginStatuses } from "./ixc-client.mjs";
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

const statusSignature = (client) => JSON.stringify([
  client.status || "unknown", client.state_detail || "", client.rx_power ?? null, client.tx_power ?? null
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
  const changes = state.clients
    .filter((client) => state.publishedStatus.get(client.id) !== statusSignature(client))
    .map((client) => ({
      id: client.id, status: client.status, state_detail: client.state_detail,
      rx_power: client.rx_power ?? null, tx_power: client.tx_power ?? null,
      olt_id: client.olt_id || "", onu_index: client.onu_index || "",
      serial: client.serial || "", name: client.name || "",
    }));
  /* Um ciclo sem mudança ainda precisa chegar ao Worker: é ele que registra o
     batimento na auditoria e distingue "a rede está estável" de "o coletor
     parou". O corpo vazio é barato. */
  await enviarStatus({ synced_at: state.syncedAt, origin: origem, changes });
  changes.forEach((change) => state.publishedStatus.set(change.id, statusSignature(change)));
  return changes.length;
}

const radiusStatus = (value) => {
  const normalized = String(value || "").trim().toLowerCase();
  if (/^(s|sim|1|true|online|yes)$/.test(normalized)) return "online";
  if (/^(n|nao|não|0|false|offline|no)$/.test(normalized)) return "offline";
  return null;
};

/* A ONU acesa e o cliente autenticado são duas perguntas diferentes, e o
   operador precisa das duas na mesma linha. A fibra manda: se a ONU não está
   working, não há autenticação que salve. Com a ONU de pé mas sem Radius, o
   cliente está fora do mesmo jeito — e o detalhe diz em qual camada, que é o
   que decide se o chamado é de campo ou de provisionamento. */
function combinarEstado(client) {
  const chave = String(client.ixc_login_id || "");
  const ont = state.ont.get(client.id);
  const radius = chave && state.radius.has(chave) ? radiusStatus(state.radius.get(chave)) : null;

  if (ont && ont.status !== "online")
    return { status: ont.status, state_detail: `ONU ${ont.detail || ont.status}` };
  if (radius === "offline")
    return { status: "offline", state_detail: ont ? "ONU ativa • Radius offline" : "Radius offline" };
  if (ont) return { status: "online", state_detail: radius === "online" ? "ONU working • Radius online" : "ONU working" };
  if (radius === "online") return { status: "online", state_detail: "Radius online" };
  return null;
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
    for (const client of state.clients)
      if (client.ixc_login_id && client.ixc_online !== undefined && !state.radius.has(String(client.ixc_login_id)))
        state.radius.set(String(client.ixc_login_id), client.ixc_online);
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
      state.publishedStatus = new Map(state.clients.map((client) => [client.id, statusSignature(client)]));
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
    state.radius = await collectIxcLoginStatuses(config.ixc);
    state.radiusCycleMs = Date.now() - inicio;
    state.radiusSyncedAt = new Date().toISOString();
    await aplicarEstado("ixc");
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
