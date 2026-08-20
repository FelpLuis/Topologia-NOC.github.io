const PAGE_SIZE = 1000;

const text = (value) => String(value ?? "").trim();
const validId = (value) => text(value) && text(value) !== "0" ? text(value) : "";
const number = (value) => {
  const parsed = Number(String(value ?? "").replace(",", "."));
  return Number.isFinite(parsed) ? parsed : null;
};
/* A cascata só aceita o registro que tem as **duas** coordenadas preenchidas.

   `number("")` devolve 0, então um cadastro com latitude em branco e longitude
   real passava como {lat: 0, lon: -46.33} — um ponto no Atlântico, na linha do
   equador. Pior que o ponto errado era a cascata parar ali: o cliente que tinha
   a coordenada certa no cadastro do contrato nunca chegava a ser consultado,
   porque o registro da fibra já havia "respondido" com lixo. */
const coordinate = (value) => {
  if (String(value ?? "").trim() === "") return null;
  return number(value);
};
const coordinates = (...records) => {
  for (const record of records) {
    const lat = coordinate(record?.latitude), lon = coordinate(record?.longitude);
    if (lat !== null && lon !== null && lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180 && (lat !== 0 || lon !== 0)) return { lat, lon };
  }
  return {};
};
const address = (...records) => {
  for (const record of records) {
    if (!record) continue;
    const street = text(record.endereco), house = text(record.numero), district = text(record.bairro), city = text(record.cidade);
    const result = [street && [street, house].filter(Boolean).join(", "), district, city].filter(Boolean).join(" — ");
    if (result) return result;
  }
  return "";
};

export const normalizeSerial = (value) => text(value).toUpperCase().replace(/[^A-Z0-9]/g, "");

/* ---- conexão e velocidade do RADIUS ----

   O IXC não tem um nome só para cada uma destas colunas: a versão da base e o
   módulo que provisionou o login mudam entre `velocidade_download`,
   `velocidade_down` e `download`. Escolher o primeiro campo preenchido é mais
   barato que descobrir a versão do ERP e mais honesto que fixar um nome e
   entregar a tela vazia quando ele não existir. */
const first = (...values) => {
  for (const value of values) { const t = text(value); if (t) return t; }
  return "";
};

/* Velocidades chegam em kbps na maioria das instalações, mas há bases que
   gravam "30M"/"30 Mbps" e outras que gravam bits por segundo. Normalizamos
   tudo para kbps — é a unidade em que o IXC provisiona o plano. */
function speedKbps(value) {
  const raw = text(value);
  if (!raw) return null;
  const match = raw.replace(",", ".").match(/^([\d.]+)\s*([kmg]?)/i);
  if (!match) return null;
  const amount = Number(match[1]);
  if (!Number.isFinite(amount) || amount <= 0) return null;
  const unit = match[2].toLowerCase();
  if (unit === "g") return Math.round(amount * 1000 * 1000);
  if (unit === "m") return Math.round(amount * 1000);
  if (unit === "k") return Math.round(amount);
  /* Sem sufixo: acima de 10 milhões só faz sentido como bits por segundo — um
     plano de 10 Gbps kbps não existe no varejo, e 300000000 bps sim. */
  return amount > 10_000_000 ? Math.round(amount / 1000) : Math.round(amount);
}

/* `tempo_conectado` aparece como segundos puros ou como "3d 04:12:33". As duas
   formas viram segundos, que é o que a tela sabe formatar. */
function uptimeSeconds(value) {
  const raw = text(value);
  if (!raw) return null;
  if (/^\d+$/.test(raw)) { const n = Number(raw); return Number.isFinite(n) && n >= 0 ? n : null; }
  const days = Number(raw.match(/(\d+)\s*d/i)?.[1] || 0);
  const clock = raw.match(/(\d{1,3}):(\d{2})(?::(\d{2}))?/);
  if (!clock && !days) return null;
  const total = days * 86400 + Number(clock?.[1] || 0) * 3600 + Number(clock?.[2] || 0) * 60 + Number(clock?.[3] || 0);
  return Number.isFinite(total) && total >= 0 ? total : null;
}

/* Campos de conexão que o ciclo rápido lê a cada 10 s. Ficam numa lista só
   porque o ciclo completo e o rápido precisam extrair exatamente os mesmos
   campos: divergir aqui faria o estado oscilar entre os dois ritmos. */
export const RADIUS_FIELDS = [
  "login", "ip", "online", "id_caixa_ftth", "ftth_porta", "tempo_conectado",
  "velocidade_download", "velocidade_upload", "velocidade_down", "velocidade_up",
  "download", "upload", "consumo_download", "consumo_upload",
  "ultima_conexao_inicial", "ultima_conexao_final", "id_concentrador", "mac",
];

/* A leitura de conexão de um login: o que a tela mostra como "tráfego e
   conexão" do cliente. Vazio vira null e não string vazia — a tela distingue
   "o IXC não informa" de "está zerado". */
export function radiusConnection(login) {
  if (!login) return null;
  const downKbps = speedKbps(first(login.velocidade_download, login.velocidade_down, login.download));
  const upKbps = speedKbps(first(login.velocidade_upload, login.velocidade_up, login.upload));
  return {
    online: text(login.online).toLowerCase(),
    ip: text(login.ip),
    username: text(login.login),
    uptime_s: uptimeSeconds(login.tempo_conectado),
    down_kbps: downKbps,
    up_kbps: upKbps,
    /* Consumo acumulado. Nem toda base preenche; quando preenche, é o número
       que responde "o cliente está passando tráfego?" sem abrir o gráfico do
       Zabbix. `number` devolve 0 para campo vazio — aqui a diferença entre
       "não informa" e "zerado" importa, então o vazio é filtrado antes. */
    down_bytes: text(login.consumo_download) ? number(login.consumo_download) : null,
    up_bytes: text(login.consumo_upload) ? number(login.consumo_upload) : null,
    since: text(login.ultima_conexao_inicial),
    nas_id: validId(login.id_concentrador),
  };
}

/* A conexão como ela vive dentro do cliente GPON. Os dois ritmos escrevem os
   mesmos nomes por aqui, então o delta de 10 s sobrescreve exatamente o que o
   ciclo completo escreveu — e não um segundo conjunto de campos paralelo. */
export function conexaoNoCliente(conexao) {
  if (!conexao) return {};
  return {
    ip: conexao.ip, uptime_s: conexao.uptime_s,
    down_kbps: conexao.down_kbps, up_kbps: conexao.up_kbps,
    down_bytes: conexao.down_bytes, up_bytes: conexao.up_bytes,
    conn_since: conexao.since, nas_id: conexao.nas_id,
  };
}

async function requestPage(config, resource, page) {
  const response = await fetch(`${config.baseUrl}/${resource}`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(config.token).toString("base64")}`,
      "Content-Type": "application/json",
      ixcsoft: "listar",
    },
    body: JSON.stringify({
      qtype: `${resource}.id`, query: "0", oper: ">=", page: String(page), rp: String(PAGE_SIZE),
      sortname: `${resource}.id`, sortorder: "asc",
    }),
    signal: AbortSignal.timeout(30000),
  });
  if (!response.ok) throw new Error(`IXC ${resource}: HTTP ${response.status}`);
  const data = await response.json();
  if (!Array.isArray(data?.registros)) throw new Error(`IXC ${resource}: ${data?.message || "resposta inválida"}`);
  return data;
}

async function fetchAll(config, resource) {
  const records = [];
  for (let page = 1; ; page += 1) {
    const data = await requestPage(config, resource, page);
    records.push(...data.registros);
    if (!data.registros.length || records.length >= Number(data.total || 0)) return records;
  }
}

const select = (record, fields) => Object.fromEntries(fields.map((field) => [field, record?.[field]]));
const indexSelected = (records, fields) => new Map(records.map((record) => [text(record.id), select(record, ["id", ...fields])]));

export function buildIxcInventory({ customers, contracts, logins, fiberClients, boxes, transmitters }) {
  // A API também devolve documentos e senhas. Retemos somente o mínimo necessário ao mapa.
  const locationFields = ["endereco", "numero", "bairro", "cidade", "latitude", "longitude"];
  const customerById = indexSelected(customers, ["razao", "fantasia", ...locationFields]);
  const contractById = indexSelected(contracts, ["id_cliente", "status", ...locationFields]);
  const loginById = indexSelected(logins, ["id_cliente", "id_contrato", ...RADIUS_FIELDS, ...locationFields]);
  const transmitterById = indexSelected(transmitters, ["id_pop"]);
  const fiberBySerial = new Map();
  for (const fiber of fiberClients) {
    for (const candidate of [fiber.mac, fiber.onu_numero, fiber.login_onu_cliente]) {
      const serial = normalizeSerial(candidate);
      if (serial && !fiberBySerial.has(serial)) fiberBySerial.set(serial, select(fiber, [
        "id", "id_login", "id_contrato", "id_caixa_ftth", "porta_ftth", "id_transmissor", "nome",
        "sinal_rx", "sinal_tx", ...locationFields,
      ]));
    }
  }

  const normalizedBoxes = boxes.map((box) => {
    const transmitter = transmitterById.get(text(box.id_transmissor));
    return {
      id: text(box.id), name: text(box.descricao) || `CTO ${box.id}`, type: text(box.tipo) || "CTO",
      status: text(box.status).toLowerCase() || "unknown", capacity: number(box.capacidade),
      address: address(box), pop_id: validId(transmitter?.id_pop), ...coordinates(box),
    };
  });

  return {
    boxes: normalizedBoxes,
    match(client) {
      const fiber = fiberBySerial.get(normalizeSerial(client.serial));
      if (!fiber) return null;
      const login = loginById.get(text(fiber.id_login));
      const contract = contractById.get(text(fiber.id_contrato || login?.id_contrato));
      const customer = customerById.get(text(login?.id_cliente || contract?.id_cliente));
      const transmitter = transmitterById.get(text(fiber.id_transmissor));
      return {
        ixc_id: text(customer?.id), fiber_id: text(fiber.id), contract_id: text(contract?.id),
        ixc_login_id: text(login?.id),
        contract_status: text(contract?.status),
        name: text(customer?.razao) || text(customer?.fantasia) || text(fiber.nome) || client.name,
        username: text(login?.login), ip: text(login?.ip),
        address: address(fiber, login, contract, customer),
        box_id: validId(fiber.id_caixa_ftth || login?.id_caixa_ftth),
        box_port: text(fiber.porta_ftth || login?.ftth_porta),
        pop_id: validId(transmitter?.id_pop),
        ixc_online: text(login?.online).toLowerCase(),
        rx_power: number(fiber.sinal_rx), tx_power: number(fiber.sinal_tx),
        /* O ciclo completo já entrega a conexão junto do cadastro: sem isso a
           tela ficaria sem velocidade e sem IP até o primeiro ciclo rápido
           passar, e um parque recém-carregado mostraria a ficha pela metade. */
        ...conexaoNoCliente(radiusConnection(login)),
        ...coordinates(fiber, login, contract, customer),
      };
    },
    stats: { customers: customers.length, contracts: contracts.length, logins: logins.length, fiberClients: fiberClients.length, boxes: boxes.length },
  };
}

export async function collectIxc(config) {
  const [customers, contracts, logins, fiberClients, boxes, transmitters] = await Promise.all([
    fetchAll(config, "cliente"), fetchAll(config, "cliente_contrato"), fetchAll(config, "radusuarios"),
    fetchAll(config, "radpop_radio_cliente_fibra"), fetchAll(config, "rad_caixa_ftth"), fetchAll(config, "radpop_radio"),
  ]);
  return buildIxcInventory({ customers, contracts, logins, fiberClients, boxes, transmitters });
}

/* O ciclo rápido do Radius já paginava `radusuarios` inteiro e jogava fora tudo
   menos o "online". Ler IP, velocidade, uptime e consumo da mesma resposta não
   custa uma requisição a mais — é o que faz tráfego e conexão acompanharem os
   10 s junto do estado, em vez de esperar o ciclo completo de 10 minutos. */
export async function collectIxcLoginStatuses(config) {
  const logins = await fetchAll(config, "radusuarios");
  return new Map(logins.map((login) => [text(login.id), radiusConnection(login)]));
}
