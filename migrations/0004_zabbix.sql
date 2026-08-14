-- Integração Zabbix: hosts monitorados, interfaces de rede e histórico de sincronizações.
-- Os dados aqui são um espelho do Zabbix (fonte da verdade permanece no Zabbix).
-- A topologia editável continua em topology_state; o vínculo é feito por equipamento_id.

CREATE TABLE IF NOT EXISTS zabbix_hosts (
  hostid TEXT PRIMARY KEY,
  host TEXT NOT NULL,
  name TEXT NOT NULL,
  status INTEGER NOT NULL DEFAULT 0,        -- 0 = monitorado, 1 = não monitorado
  available INTEGER NOT NULL DEFAULT 0,     -- disponibilidade da interface principal
  snmp_ip TEXT,
  snmp_port TEXT,
  agent_ip TEXT,
  -- Vínculo com o equipamento da topologia (public/data/equipamentos.json -> id).
  -- NULL enquanto não houver correspondência confirmada.
  equipamento_id TEXT,
  match_source TEXT,                        -- 'auto' | 'manual'
  synced_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS zabbix_interfaces (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  hostid TEXT NOT NULL REFERENCES zabbix_hosts(hostid) ON DELETE CASCADE,
  if_index INTEGER NOT NULL,                -- ifIndex SNMP
  if_name TEXT NOT NULL,                    -- ex.: 100GE1/0/1
  if_alias TEXT NOT NULL DEFAULT '',        -- descrição do enlace, ex.: NE8000_F1A-100GE0/1/48
  if_type INTEGER,                          -- ifType SNMP
  oper_status INTEGER,                      -- 1 = up, 2 = down
  -- Velocidade nominal em bits/s. O item ifHighSpeed deste Zabbix já entrega o
  -- valor convertido para bps (100GE = 100000000000), não em Mbps.
  speed_bps INTEGER,
  in_bps INTEGER,
  out_bps INTEGER,
  in_errors INTEGER,
  out_errors INTEGER,
  in_discards INTEGER,
  out_discards INTEGER,
  last_clock TEXT,                          -- última coleta (ISO 8601)
  synced_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (hostid, if_index)
);

CREATE TABLE IF NOT EXISTS zabbix_sync_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  finished_at TEXT,
  ok INTEGER NOT NULL DEFAULT 0,
  hosts_count INTEGER NOT NULL DEFAULT 0,
  interfaces_count INTEGER NOT NULL DEFAULT 0,
  triggered_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  source TEXT NOT NULL DEFAULT 'api',       -- 'api' | 'cli'
  error TEXT
);

CREATE INDEX IF NOT EXISTS idx_zbx_if_hostid ON zabbix_interfaces(hostid);
CREATE INDEX IF NOT EXISTS idx_zbx_if_alias ON zabbix_interfaces(if_alias);
CREATE INDEX IF NOT EXISTS idx_zbx_if_oper ON zabbix_interfaces(oper_status);
CREATE INDEX IF NOT EXISTS idx_zbx_hosts_equip ON zabbix_hosts(equipamento_id);
