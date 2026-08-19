-- Histórico auditável do estado GPON (ONT na OLT + IXC Provedor).
--
-- O Worker cria estas tabelas sozinho no start; este arquivo existe para
-- aplicar a mesma estrutura por migration no D1/Turso.
--
-- gpon_snapshot_state / gpon_status_snapshot respondem "como está agora" e são
-- sobrescritos a cada ciclo. As duas tabelas abaixo são append-only e
-- respondem "quando mudou, de quê para quê e quem observou".

CREATE TABLE IF NOT EXISTS gpon_status_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id TEXT NOT NULL,
  run_id TEXT,
  origin TEXT NOT NULL DEFAULT 'collector',   -- ont | ixc | ont+ixc | snapshot
  event TEXT NOT NULL DEFAULT 'status',       -- status | signal | baseline
  status_before TEXT,
  status_after TEXT NOT NULL,
  detail_before TEXT,
  detail_after TEXT NOT NULL DEFAULT '',
  rx_power_before REAL,
  rx_power REAL,
  tx_power REAL,
  olt_id TEXT NOT NULL DEFAULT '',
  onu_index TEXT NOT NULL DEFAULT '',
  serial TEXT NOT NULL DEFAULT '',
  client_name TEXT NOT NULL DEFAULT '',
  synced_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS gpon_sync_runs (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,                          -- snapshot | status
  origin TEXT NOT NULL DEFAULT 'collector',
  source TEXT NOT NULL DEFAULT '',
  synced_at TEXT,
  received_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  clients_count INTEGER NOT NULL DEFAULT 0,
  boxes_count INTEGER NOT NULL DEFAULT 0,
  alerts_count INTEGER NOT NULL DEFAULT 0,
  changes_count INTEGER NOT NULL DEFAULT 0,
  transitions_count INTEGER NOT NULL DEFAULT 0,
  online_count INTEGER NOT NULL DEFAULT 0,
  offline_count INTEGER NOT NULL DEFAULT 0,
  data_bytes INTEGER NOT NULL DEFAULT 0,
  lag_ms INTEGER,
  ip TEXT NOT NULL DEFAULT '',
  error TEXT NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_gpon_history_client ON gpon_status_history(client_id,id DESC);
CREATE INDEX IF NOT EXISTS idx_gpon_history_created ON gpon_status_history(created_at);
CREATE INDEX IF NOT EXISTS idx_gpon_history_run ON gpon_status_history(run_id);
CREATE INDEX IF NOT EXISTS idx_gpon_runs_received ON gpon_sync_runs(received_at DESC);
