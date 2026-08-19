-- Log dedicado a eventos RADIUS — autenticação PPPoE que o coletor lê do IXC.
--
-- O estado combinado (ONU + Radius) continua em gpon_status_history; esta
-- tabela isola as transições de autenticação para que o NOC monitore a saúde
-- do servidor RADIUS e o HelpDesk consulte por que um cliente está sem
-- serviço sem precisar cruzar a linha do tempo GPON inteira.
--
-- O Worker cria esta tabela no start (SCHEMA); este arquivo existe para
-- aplicar a mesma estrutura por migration no D1/Turso.

CREATE TABLE IF NOT EXISTS radius_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id TEXT NOT NULL,
  ixc_login_id TEXT,
  username TEXT NOT NULL DEFAULT '',
  status_before TEXT,
  status_after TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '',
  olt_id TEXT NOT NULL DEFAULT '',
  onu_index TEXT NOT NULL DEFAULT '',
  serial TEXT NOT NULL DEFAULT '',
  client_name TEXT NOT NULL DEFAULT '',
  synced_at TEXT,
  origin TEXT NOT NULL DEFAULT 'collector',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_radius_logs_client ON radius_logs(client_id,id DESC);
CREATE INDEX IF NOT EXISTS idx_radius_logs_created ON radius_logs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_radius_logs_username ON radius_logs(username);
CREATE INDEX IF NOT EXISTS idx_radius_logs_run ON radius_logs(synced_at);
