// Integração com a API JSON-RPC do Zabbix (7.0+).
//
// Este módulo é isomórfico: roda no Worker (Cloudflare) e no Node (script de
// sincronização em backend/scripts/zabbix-sync.mjs). Por isso ele não usa nada
// específico de Worker no escopo do módulo — apenas `fetch`, que existe nos dois.
//
// Credenciais NUNCA ficam no código: vêm de env.ZABBIX_URL / env.ZABBIX_TOKEN
// (Secrets do Worker, ou .dev.vars no desenvolvimento local).

/**
 * Regras de correspondência entre o host do Zabbix e o equipamento da topologia.
 * A ordem importa: a primeira regra que casar vence. São propositalmente
 * explícitas — o parque é pequeno e um match errado poluiria a topologia.
 */
const HOST_MATCH_RULES = [
  [/SWITCH01\s+S6750\s+ASCENTY/i, "s6750a"],
  [/SWITCH02\s+S6730\s+ASCENTY/i, "s6730a"],
  [/S6750\s+PRAIA\s+GRANDE/i, "s6750b"],
  [/S6730\s+PRAIA\s+GRANDE/i, "s6730b"],
  [/S6730\s+SANTOS/i, "santos"],
  [/S6730\s+RIO\s+BRANCO\s+SV/i, "sv"],
  [/NE8000\s+F1A\s+BGP\s+ASCENTY/i, "f1a"],
  [/DWDM4920\s+ASCENTY/i, "datacom1"],
  [/DWDM4920\s+PRAIA\s+GRANDE/i, "datacom2"]
];

/**
 * Métricas SNMP coletadas por interface -> coluna em zabbix_interfaces.
 *
 * Atenção a `ifHighSpeed`: apesar do nome, os itens deste Zabbix já aplicam
 * preprocessamento e entregam o valor em bits/s (100GE chega como 1e11), não em
 * Mbps. Por isso a coluna é speed_bps.
 */
const METRIC_COLUMNS = {
  ifOperStatus: "oper_status",
  ifType: "if_type",
  ifHighSpeed: "speed_bps",
  ifHCInOctets: "in_bps",
  ifHCOutOctets: "out_bps",
  ifInErrors: "in_errors",
  ifOutErrors: "out_errors",
  ifInDiscards: "in_discards",
  ifOutDiscards: "out_discards"
};

// Alguns hosts antigos expõem apenas ifSpeed (contador de 32 bits). Só é usado
// quando ifHighSpeed não existe para aquela interface.
const SPEED_FALLBACK_METRIC = "ifSpeed";

export function zabbixConfig(env) {
  const url = String(env.ZABBIX_URL || "").trim();
  const token = String(env.ZABBIX_TOKEN || "").trim();
  if (!url) throw new Error("ZABBIX_URL não configurada.");
  if (!token) throw new Error("ZABBIX_TOKEN não configurado.");
  return { url, token };
}

/**
 * Chamada JSON-RPC ao Zabbix.
 * `auth: false` é obrigatório para apiinfo.version — o Zabbix 7 rejeita esse
 * método quando o header Authorization está presente.
 */
export async function zabbixCall(env, method, params = {}, { auth = true } = {}) {
  const { url, token } = zabbixConfig(env);

  const headers = { "Content-Type": "application/json-rpc" };
  if (auth) headers.Authorization = `Bearer ${token}`;

  const response = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", method, params, id: 1 })
  });

  const text = await response.text();
  let body;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    throw new Error(`Resposta não-JSON do Zabbix (HTTP ${response.status}).`);
  }

  if (body?.error) {
    const { message, data } = body.error;
    throw new Error(`Zabbix ${method}: ${message}${data ? ` — ${data}` : ""}`);
  }

  return body?.result;
}

export function matchEquipamento(hostName) {
  for (const [pattern, equipamentoId] of HOST_MATCH_RULES) {
    if (pattern.test(hostName)) return equipamentoId;
  }
  return null;
}

/**
 * O nome do item traz a interface e a descrição do enlace:
 *   "Interface 100GE1/0/1(NE8000_F1A-100GE0/1/48): Bits Enviados"
 * O alias entre parênteses é o que documenta a ponta remota da conexão.
 */
export function parseItemName(name) {
  const match = String(name).match(/^Interface\s+(.+?):\s/);
  if (!match) return null;

  const label = match[1];
  const withAlias = label.match(/^(.*?)\((.*)\)$/);

  return withAlias
    ? { ifName: withAlias[1].trim(), ifAlias: withAlias[2].trim() }
    : { ifName: label.trim(), ifAlias: "" };
}

/** "net.if.in[ifHCInOctets.42]" -> { metric: "ifHCInOctets", ifIndex: 42 } */
export function parseItemKey(key) {
  const match = String(key).match(/\[([A-Za-z]+)\.(\d+)\]$/);
  if (!match) return null;
  return { metric: match[1], ifIndex: Number(match[2]) };
}

function toNumber(value) {
  if (value === undefined || value === null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n) : null;
}

/**
 * Agrupa os itens net.if por (hostid, ifIndex), montando uma linha por
 * interface física com as métricas mais recentes.
 */
export function buildInterfaces(items) {
  const byKey = new Map();

  for (const item of items) {
    const parsedKey = parseItemKey(item.key_);
    if (!parsedKey) continue;

    const isSpeedFallback = parsedKey.metric === SPEED_FALLBACK_METRIC;
    const column = METRIC_COLUMNS[parsedKey.metric];
    if (!column && !isSpeedFallback) continue; // ignora Diff %, pacotes/s e afins

    const parsedName = parseItemName(item.name);
    if (!parsedName) continue;

    const mapKey = `${item.hostid}:${parsedKey.ifIndex}`;
    let row = byKey.get(mapKey);
    if (!row) {
      row = {
        hostid: String(item.hostid),
        if_index: parsedKey.ifIndex,
        if_name: parsedName.ifName,
        if_alias: parsedName.ifAlias,
        if_type: null,
        oper_status: null,
        speed_bps: null,
        speed_fallback: null,
        in_bps: null,
        out_bps: null,
        in_errors: null,
        out_errors: null,
        in_discards: null,
        out_discards: null,
        last_clock: null
      };
      byKey.set(mapKey, row);
    }

    // O alias pode estar preenchido em uns itens e vazio em outros; mantém o
    // primeiro valor não-vazio encontrado.
    if (!row.if_alias && parsedName.ifAlias) row.if_alias = parsedName.ifAlias;

    if (isSpeedFallback) row.speed_fallback = toNumber(item.lastvalue);
    else row[column] = toNumber(item.lastvalue);

    const clock = toNumber(item.lastclock);
    if (clock) {
      const iso = new Date(clock * 1000).toISOString();
      if (!row.last_clock || iso > row.last_clock) row.last_clock = iso;
    }
  }

  const rows = [...byKey.values()];
  for (const row of rows) {
    if (row.speed_bps === null) row.speed_bps = row.speed_fallback;
    delete row.speed_fallback;
  }

  return rows.sort(
    (a, b) => a.hostid.localeCompare(b.hostid) || a.if_index - b.if_index
  );
}

/**
 * Busca no Zabbix os hosts com interface SNMP (equipamentos de rede) e todas as
 * interfaces net.if deles. Retorna dados já normalizados, prontos para gravação.
 */
export async function fetchNetworkInventory(env) {
  const hosts = await zabbixCall(env, "host.get", {
    output: ["hostid", "host", "name", "status"],
    selectInterfaces: ["interfaceid", "ip", "port", "type", "main", "available"],
    limit: 5000
  });

  // type "2" = SNMP. Somente estes têm inventário de interfaces de rede.
  const snmpHosts = (hosts || []).filter(h =>
    (h.interfaces || []).some(i => i.type === "2")
  );

  const hostRows = snmpHosts.map(h => {
    const snmp = (h.interfaces || []).find(i => i.type === "2");
    const agent = (h.interfaces || []).find(i => i.type === "1");
    return {
      hostid: String(h.hostid),
      host: h.host,
      name: h.name,
      status: toNumber(h.status) ?? 0,
      available: toNumber(snmp?.available) ?? 0,
      snmp_ip: snmp?.ip || null,
      snmp_port: snmp?.port || null,
      agent_ip: agent?.ip || null,
      equipamento_id: matchEquipamento(h.name),
      match_source: matchEquipamento(h.name) ? "auto" : null
    };
  });

  if (!hostRows.length) return { hosts: [], interfaces: [] };

  const items = await zabbixCall(env, "item.get", {
    hostids: hostRows.map(h => h.hostid),
    output: ["itemid", "hostid", "name", "key_", "lastvalue", "lastclock"],
    search: { key_: "net.if" },
    limit: 100000
  });

  return { hosts: hostRows, interfaces: buildInterfaces(items || []) };
}

const HOST_COLUMNS = [
  "hostid", "host", "name", "status", "available",
  "snmp_ip", "snmp_port", "agent_ip", "equipamento_id", "match_source"
];

const INTERFACE_COLUMNS = [
  "hostid", "if_index", "if_name", "if_alias", "if_type", "oper_status",
  "speed_bps", "in_bps", "out_bps", "in_errors", "out_errors",
  "in_discards", "out_discards", "last_clock"
];

/**
 * Grava o inventário no D1.
 *
 * O upsert preserva `equipamento_id` quando ele foi ajustado manualmente
 * (match_source='manual'): a sincronização automática não desfaz o vínculo
 * que um operador confirmou na mão.
 */
export async function persistInventory(db, { hosts, interfaces }) {
  const statements = [];

  const hostPlaceholders = HOST_COLUMNS.map(() => "?").join(",");
  for (const host of hosts) {
    statements.push(
      db.prepare(`
        INSERT INTO zabbix_hosts (${HOST_COLUMNS.join(",")}, synced_at)
        VALUES (${hostPlaceholders}, CURRENT_TIMESTAMP)
        ON CONFLICT(hostid) DO UPDATE SET
          host=excluded.host,
          name=excluded.name,
          status=excluded.status,
          available=excluded.available,
          snmp_ip=excluded.snmp_ip,
          snmp_port=excluded.snmp_port,
          agent_ip=excluded.agent_ip,
          equipamento_id=CASE
            WHEN zabbix_hosts.match_source='manual' THEN zabbix_hosts.equipamento_id
            ELSE excluded.equipamento_id END,
          match_source=CASE
            WHEN zabbix_hosts.match_source='manual' THEN 'manual'
            ELSE excluded.match_source END,
          synced_at=CURRENT_TIMESTAMP
      `).bind(...HOST_COLUMNS.map(c => host[c] ?? null))
    );
  }

  const ifPlaceholders = INTERFACE_COLUMNS.map(() => "?").join(",");
  for (const iface of interfaces) {
    statements.push(
      db.prepare(`
        INSERT INTO zabbix_interfaces (${INTERFACE_COLUMNS.join(",")}, synced_at)
        VALUES (${ifPlaceholders}, CURRENT_TIMESTAMP)
        ON CONFLICT(hostid, if_index) DO UPDATE SET
          if_name=excluded.if_name,
          if_alias=excluded.if_alias,
          if_type=excluded.if_type,
          oper_status=excluded.oper_status,
          speed_bps=excluded.speed_bps,
          in_bps=excluded.in_bps,
          out_bps=excluded.out_bps,
          in_errors=excluded.in_errors,
          out_errors=excluded.out_errors,
          in_discards=excluded.in_discards,
          out_discards=excluded.out_discards,
          last_clock=excluded.last_clock,
          synced_at=CURRENT_TIMESTAMP
      `).bind(...INTERFACE_COLUMNS.map(c => iface[c] ?? null))
    );
  }

  // D1 limita o tamanho do batch; grava em blocos.
  const CHUNK = 50;
  for (let i = 0; i < statements.length; i += CHUNK) {
    await db.batch(statements.slice(i, i + CHUNK));
  }

  return { hosts: hosts.length, interfaces: interfaces.length };
}
