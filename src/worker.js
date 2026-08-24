import {
  zabbixCall,
  fetchNetworkInventory,
  persistInventory
} from "./zabbix.js";
import { deriveLinks, capacityLabel, linkKind } from "./zabbix-links.js";
import { applyZabbixToTopology } from "./zabbix-topology.js";
import {
  buildAuthorizationRequest,
  constantTimeEqual,
  exchangeAuthorizationCode,
  oauthConfig,
  oauthEnabled,
  randomBase64Url,
  safeReturnPath,
  sha256Base64Url as oauthSha256Base64Url
} from "./oauth.js";
import { parseIcsCalendar } from "./ics.js";
import { getTursoD1 } from "./turso-d1.js";

const COOKIE_NAME = "__Host-topologia_noc_session";
const OAUTH_STATE_COOKIE = "__Host-topologia_noc_oauth";
const REMEMBERED_SESSION_SECONDS = 24 * 60 * 60;
const SHORT_SESSION_SECONDS = 60 * 60;
const PBKDF2_ITERATIONS = 100000;
const OAUTH_STATE_MINUTES = 10;
const MAX_JSON_BODY_BYTES = 1024 * 1024;

// Banco remoto Turso via TURSO_DATABASE_URL e TURSO_AUTH_TOKEN.
// Assets continuam servidos pelo binding ASSETS da Cloudflare.

const SCHEMA = `
CREATE TABLE IF NOT EXISTS roles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  description TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS permissions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,
  description TEXT NOT NULL DEFAULT '',
  name TEXT NOT NULL DEFAULT '',
  module TEXT NOT NULL DEFAULT 'Geral',
  screen_code TEXT,
  sort INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS role_permissions (
  role_id INTEGER NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  permission_id INTEGER NOT NULL REFERENCES permissions(id) ON DELETE CASCADE,
  PRIMARY KEY (role_id, permission_id)
);

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  email TEXT,
  oauth_issuer TEXT,
  oauth_subject TEXT,
  password_hash TEXT NOT NULL,
  role_id INTEGER NOT NULL REFERENCES roles(id),
  active INTEGER NOT NULL DEFAULT 1,
  must_change_password INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_login_at TEXT
);

CREATE TABLE IF NOT EXISTS sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  token_hash TEXT NOT NULL UNIQUE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ip TEXT,
  user_agent TEXT
);

CREATE TABLE IF NOT EXISTS oauth_states (
  state_hash TEXT PRIMARY KEY,
  code_verifier TEXT NOT NULL,
  nonce TEXT NOT NULL,
  return_to TEXT NOT NULL DEFAULT '/',
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS sectors (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL UNIQUE,
  description TEXT NOT NULL DEFAULT '',
  color TEXT NOT NULL DEFAULT '#2563eb',
  icon TEXT NOT NULL DEFAULT 'circle',
  sort INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS user_sectors (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  sector_id INTEGER NOT NULL REFERENCES sectors(id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, sector_id)
);

CREATE TABLE IF NOT EXISTS agenda_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_type TEXT NOT NULL CHECK(owner_type IN ('user','sector')),
  owner_user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  sector_id INTEGER REFERENCES sectors(id) ON DELETE CASCADE,
  creator_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  location TEXT NOT NULL DEFAULT '',
  start_at TEXT NOT NULL,
  end_at TEXT NOT NULL,
  all_day INTEGER NOT NULL DEFAULT 0,
  alert_email INTEGER NOT NULL DEFAULT 1,
  alert_popup INTEGER NOT NULL DEFAULT 1,
  alert_minutes INTEGER NOT NULL DEFAULT 10 CHECK(alert_minutes BETWEEN 0 AND 1440),
  source TEXT NOT NULL DEFAULT 'updown',
  external_uid TEXT,
  imported_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK((owner_type='user' AND owner_user_id IS NOT NULL AND sector_id IS NULL)
     OR (owner_type='sector' AND sector_id IS NOT NULL AND owner_user_id IS NULL))
);

CREATE TABLE IF NOT EXISTS login_attempts (
  attempt_key TEXT NOT NULL,
  attempted_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  username TEXT,
  action TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  resource_id TEXT,
  method TEXT,
  path TEXT,
  ip TEXT,
  user_agent TEXT,
  before_json TEXT,
  after_json TEXT,
  details_json TEXT
);

CREATE TABLE IF NOT EXISTS screens (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  route TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  icon TEXT NOT NULL DEFAULT 'topology',
  sort INTEGER NOT NULL DEFAULT 0,
  nav INTEGER NOT NULL DEFAULT 1,
  sector_id INTEGER REFERENCES sectors(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS platform_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS role_screens (
  role_id INTEGER NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  screen_id INTEGER NOT NULL REFERENCES screens(id) ON DELETE CASCADE,
  PRIMARY KEY(role_id, screen_id)
);

CREATE TABLE IF NOT EXISTS topology_state (
  id INTEGER PRIMARY KEY CHECK(id=1),
  data_json TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL
);

/* Topologias além da principal (hoje, a PARTE ISP). A tabela topology_state
   nasceu com CHECK(id=1) e continua sendo a da rede NOC; recriá-la para caber
   um segundo recorte custaria uma reconstrução de tabela com os dados de
   produção dentro. Cada recorte é uma linha aqui, com o mesmo formato de
   documento e o mesmo controle de versão. */
CREATE TABLE IF NOT EXISTS topology_scopes (
  scope TEXT PRIMARY KEY,
  data_json TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL
);

/* O coletor fica dentro da rede da operadora e envia uma cópia somente leitura
   para o Worker. Os pedaços evitam uma única instrução SQL enorme e a versão só
   é ativada depois que todos eles foram gravados. */
CREATE TABLE IF NOT EXISTS gpon_snapshot_state (
  id INTEGER PRIMARY KEY CHECK(id=1),
  version TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'Coletor GPON',
  synced_at TEXT,
  chunk_count INTEGER NOT NULL DEFAULT 0,
  data_bytes INTEGER NOT NULL DEFAULT 0,
  clients_count INTEGER NOT NULL DEFAULT 0,
  boxes_count INTEGER NOT NULL DEFAULT 0,
  alerts_count INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS gpon_snapshot_chunks (
  version TEXT NOT NULL,
  chunk_index INTEGER NOT NULL,
  data_text TEXT NOT NULL,
  PRIMARY KEY(version, chunk_index)
);

CREATE TABLE IF NOT EXISTS gpon_client_status (
  client_id TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  state_detail TEXT NOT NULL DEFAULT '',
  rx_power REAL,
  tx_power REAL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS gpon_status_snapshot (
  id INTEGER PRIMARY KEY CHECK(id=1),
  data_json TEXT NOT NULL,
  synced_at TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

/* Histórico auditável do estado GPON.

   O snapshot e a leitura compacta respondem "como está agora" e são
   sobrescritos a cada ciclo — não servem para responder "quando caiu",
   "quantas vezes oscilou" nem "quem foi a fonte da informação". Estas duas
   tabelas são append-only: gpon_status_history guarda cada transição de estado
   de uma ONU (com o valor anterior, o novo e a origem que a observou) e
   gpon_sync_runs guarda cada ciclo de coleta recebido, mesmo quando ele não
   mudou nada. Juntas elas reconstroem a linha do tempo de qualquer cliente e
   provam a procedência de cada mudança. */
CREATE TABLE IF NOT EXISTS gpon_status_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id TEXT NOT NULL,
  run_id TEXT,
  origin TEXT NOT NULL DEFAULT 'collector',
  event TEXT NOT NULL DEFAULT 'status',
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
  kind TEXT NOT NULL,
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

/* Log dedicado a eventos RADIUS — autenticação PPPoE que o coletor lê do IXC.
   O estado combinado (ONU + Radius) continua em gpon_status_history; esta
   tabela isola as transições de autenticação para que o NOC monitore a saúde
   do servidor RADIUS e o HelpDesk consulte por que um cliente está sem
   serviço sem precisar cruzar a linha do tempo GPON inteira. */
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

CREATE TABLE IF NOT EXISTS zabbix_hosts (
  hostid TEXT PRIMARY KEY,
  host TEXT NOT NULL,
  name TEXT NOT NULL,
  status INTEGER NOT NULL DEFAULT 0,
  available INTEGER NOT NULL DEFAULT 0,
  snmp_ip TEXT,
  snmp_port TEXT,
  agent_ip TEXT,
  equipamento_id TEXT,
  match_source TEXT,
  synced_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS zabbix_interfaces (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  hostid TEXT NOT NULL REFERENCES zabbix_hosts(hostid) ON DELETE CASCADE,
  if_index INTEGER NOT NULL,
  if_name TEXT NOT NULL,
  if_alias TEXT NOT NULL DEFAULT '',
  if_type INTEGER,
  oper_status INTEGER,
  speed_bps INTEGER,
  in_bps INTEGER,
  out_bps INTEGER,
  in_errors INTEGER,
  out_errors INTEGER,
  in_discards INTEGER,
  out_discards INTEGER,
  last_clock TEXT,
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
  source TEXT NOT NULL DEFAULT 'api',
  error TEXT
);

/* Histórico agregado do tráfego: uma linha por sincronização, não uma por
   interface. É o que o painel precisa para desenhar a curva das últimas horas,
   e mantém a escrita em 1 registro por ciclo em vez de milhares. A série por
   interface continua sendo do Zabbix — aqui só vive o total da rede. */
CREATE TABLE IF NOT EXISTS zabbix_traffic_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  taken_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  in_bps INTEGER NOT NULL DEFAULT 0,
  out_bps INTEGER NOT NULL DEFAULT 0,
  interfaces_total INTEGER NOT NULL DEFAULT 0,
  interfaces_up INTEGER NOT NULL DEFAULT 0,
  interfaces_saturadas INTEGER NOT NULL DEFAULT 0,
  erros INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS device_connections (
  device_id TEXT PRIMARY KEY,
  management_ip TEXT NOT NULL,
  protocol TEXT NOT NULL CHECK(protocol IN ('ssh','telnet')),
  port INTEGER NOT NULL,
  updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS device_credentials (
  device_id TEXT NOT NULL,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  login_username TEXT NOT NULL,
  password_ciphertext TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (device_id, user_id)
);

CREATE TABLE IF NOT EXISTS device_connection_targets (
  id TEXT PRIMARY KEY,
  device_id TEXT NOT NULL,
  name TEXT NOT NULL,
  management_ip TEXT NOT NULL,
  protocol TEXT NOT NULL CHECK(protocol IN ('ssh','telnet')),
  port INTEGER NOT NULL,
  browser_url TEXT,
  vendor TEXT NOT NULL DEFAULT 'outro',
  provision_username TEXT,
  provision_ciphertext TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  sort INTEGER NOT NULL DEFAULT 0,
  updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS device_connection_acl (
  target_id TEXT NOT NULL REFERENCES device_connection_targets(id) ON DELETE CASCADE,
  role_id INTEGER NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  can_connect INTEGER NOT NULL DEFAULT 0,
  can_manage INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (target_id, role_id)
);

CREATE TABLE IF NOT EXISTS device_target_credentials (
  target_id TEXT NOT NULL REFERENCES device_connection_targets(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  login_username TEXT NOT NULL,
  password_ciphertext TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (target_id, user_id)
);

/* Fila de provisionamento: quando um administrador define a credencial de um
   usuário em um aparelho, um job nasce aqui e o coletor Node (que consegue
   abrir SSH) cria/atualiza a conta no equipamento e reporta o resultado. */
CREATE TABLE IF NOT EXISTS device_target_provisioning (
  target_id TEXT NOT NULL REFERENCES device_connection_targets(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  login_username TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','provisioning','success','error')),
  error TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  requested_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  requested_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_attempt_at TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (target_id, user_id)
);

CREATE TABLE IF NOT EXISTS alerts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  fingerprint TEXT NOT NULL UNIQUE,
  origem TEXT NOT NULL DEFAULT 'rede',
  grau TEXT NOT NULL DEFAULT 'info',
  titulo TEXT NOT NULL,
  texto TEXT NOT NULL DEFAULT '',
  alvo_tipo TEXT NOT NULL DEFAULT '',
  alvo_chave TEXT NOT NULL DEFAULT '',
  first_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  reopened_at TEXT,
  resolved_at TEXT
);

CREATE TABLE IF NOT EXISTS alert_reads (
  alert_id INTEGER NOT NULL REFERENCES alerts(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- Sempre gravado em ISO pelo Worker, como first_seen_at e reopened_at. O
  -- padrão do SQLite ("2026-08-19 10:00:00") fica aqui só como rede de
  -- segurança: comparado com o ISO de reopened_at, o espaço perde para o "T"
  -- e uma leitura mais nova passaria por mais antiga.
  read_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  -- Comentário de fechamento, opcional: o que a pessoa apurou ao dar baixa.
  -- Ele pertence à leitura, e não ao alerta — fala de "por que eu marquei
  -- visto", enquanto o alerta continua pendente para os colegas.
  comentario TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (alert_id, user_id)
);

CREATE TABLE IF NOT EXISTS crm_stages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sector_id INTEGER NOT NULL REFERENCES sectors(id) ON DELETE CASCADE,
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  color TEXT NOT NULL DEFAULT '#2563eb',
  sort INTEGER NOT NULL DEFAULT 0,
  is_closed INTEGER NOT NULL DEFAULT 0,
  is_won INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  UNIQUE(sector_id, code)
);

CREATE TABLE IF NOT EXISTS crm_cases (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sector_id INTEGER NOT NULL REFERENCES sectors(id),
  stage_id INTEGER NOT NULL REFERENCES crm_stages(id),
  assigned_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  creator_user_id INTEGER NOT NULL REFERENCES users(id),
  title TEXT NOT NULL,
  customer_name TEXT NOT NULL,
  customer_document TEXT NOT NULL DEFAULT '',
  phone TEXT NOT NULL DEFAULT '',
  email TEXT NOT NULL DEFAULT '',
  city TEXT NOT NULL DEFAULT '',
  address TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT '',
  priority TEXT NOT NULL DEFAULT 'normal' CHECK(priority IN ('low','normal','high','urgent')),
  estimated_value REAL NOT NULL DEFAULT 0,
  next_contact_at TEXT,
  details TEXT NOT NULL DEFAULT '',
  tags TEXT NOT NULL DEFAULT '',
  closed_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS crm_activities (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  case_id INTEGER NOT NULL REFERENCES crm_cases(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id),
  kind TEXT NOT NULL DEFAULT 'note' CHECK(kind IN ('note','call','whatsapp','email','meeting','status','system')),
  body TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_audit_created_at ON audit_logs(created_at);
CREATE INDEX IF NOT EXISTS idx_audit_user_id ON audit_logs(user_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_sessions_token_hash ON sessions(token_hash);
CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_oauth_states_expires ON oauth_states(expires_at);
CREATE INDEX IF NOT EXISTS idx_user_sectors_sector ON user_sectors(sector_id,user_id);
CREATE INDEX IF NOT EXISTS idx_agenda_events_range ON agenda_events(start_at,end_at);
CREATE INDEX IF NOT EXISTS idx_agenda_events_sector ON agenda_events(sector_id,start_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_agenda_ics_external
  ON agenda_events(owner_user_id,external_uid) WHERE source='ics' AND external_uid IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_login_attempts_key_time ON login_attempts(attempt_key,attempted_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_oauth_identity
  ON users(oauth_issuer,oauth_subject)
  WHERE oauth_issuer IS NOT NULL AND oauth_subject IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_role_screens_role ON role_screens(role_id);
CREATE INDEX IF NOT EXISTS idx_zbx_if_hostid ON zabbix_interfaces(hostid);
CREATE INDEX IF NOT EXISTS idx_zbx_if_alias ON zabbix_interfaces(if_alias);
CREATE INDEX IF NOT EXISTS idx_zbx_if_oper ON zabbix_interfaces(oper_status);
CREATE INDEX IF NOT EXISTS idx_zbx_hosts_equip ON zabbix_hosts(equipamento_id);
CREATE INDEX IF NOT EXISTS idx_zbx_snapshots_taken ON zabbix_traffic_snapshots(taken_at);
CREATE INDEX IF NOT EXISTS idx_device_credentials_user ON device_credentials(user_id);
CREATE INDEX IF NOT EXISTS idx_device_targets_device ON device_connection_targets(device_id,sort,name);
CREATE INDEX IF NOT EXISTS idx_device_acl_role ON device_connection_acl(role_id,target_id);
CREATE INDEX IF NOT EXISTS idx_device_target_credentials_user ON device_target_credentials(user_id);
CREATE INDEX IF NOT EXISTS idx_device_target_provisioning_status ON device_target_provisioning(status,requested_at);
CREATE INDEX IF NOT EXISTS idx_alerts_abertos ON alerts(resolved_at,grau,last_seen_at);
CREATE INDEX IF NOT EXISTS idx_alerts_origem ON alerts(origem,resolved_at);
CREATE INDEX IF NOT EXISTS idx_alert_reads_user ON alert_reads(user_id,alert_id);
CREATE INDEX IF NOT EXISTS idx_crm_cases_sector_stage ON crm_cases(sector_id,stage_id,updated_at);
CREATE INDEX IF NOT EXISTS idx_crm_cases_assignee ON crm_cases(assigned_user_id,updated_at);
CREATE INDEX IF NOT EXISTS idx_crm_cases_next_contact ON crm_cases(next_contact_at);
CREATE INDEX IF NOT EXISTS idx_crm_activities_case ON crm_activities(case_id,created_at);

/* Atendimento WhatsApp (WhatsApp Cloud API da Meta) e, além do número nativo,
   canais externos que também caem na mesma fila (Opa!Suite/Meta e o Webchat
   do Opa!Suite): 'channel' separa a origem e 'external_id' guarda o
   identificador da conversa no sistema externo, usado para responder por lá.
   Uma conversa por número/identificador dentro de cada canal, com o bot
   direcionando para o setor escolhido pelo cliente. O atendente que
   "pega" a conversa fica em atendimento (status derivado) e o master, com a
   ação whatsapp.supervise, enxerga com quem cada colega está conversando. */
CREATE TABLE IF NOT EXISTS wa_conversations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  phone TEXT NOT NULL,
  customer_name TEXT NOT NULL DEFAULT '',
  channel TEXT NOT NULL DEFAULT 'whatsapp',
  external_id TEXT NOT NULL DEFAULT '',
  sector_id INTEGER REFERENCES sectors(id) ON DELETE SET NULL,
  assigned_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'routing' CHECK(status IN ('routing','open','closed')),
  routing_attempts INTEGER NOT NULL DEFAULT 0,
  last_message TEXT NOT NULL DEFAULT '',
  last_message_at TEXT,
  unread INTEGER NOT NULL DEFAULT 0,
  closed_at TEXT,
  closed_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS wa_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id INTEGER NOT NULL REFERENCES wa_conversations(id) ON DELETE CASCADE,
  direction TEXT NOT NULL CHECK(direction IN ('in','out','bot')),
  type TEXT NOT NULL DEFAULT 'text',
  body TEXT NOT NULL DEFAULT '',
  wa_message_id TEXT,
  status TEXT NOT NULL DEFAULT 'sent' CHECK(status IN ('sent','delivered','read','failed')),
  sender_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  sender_name TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS wa_agent_presence (
  user_id INTEGER NOT NULL PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  available INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS wa_contacts (
  phone TEXT PRIMARY KEY,
  name TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

/* Corpo bruto de cada chamada recebida em /api/opasuite/webhook, para
   conferir o formato real do payload (ainda não documentado publicamente)
   e ajustar oaExtractMessage() sem precisar reproduzir o envio. */
CREATE TABLE IF NOT EXISTS wa_webhook_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  channel TEXT NOT NULL,
  payload TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_wa_conv_phone_status ON wa_conversations(phone,status);
CREATE INDEX IF NOT EXISTS idx_wa_conv_channel_phone ON wa_conversations(channel,phone);
CREATE INDEX IF NOT EXISTS idx_wa_conv_sector ON wa_conversations(sector_id,status,updated_at);
CREATE INDEX IF NOT EXISTS idx_wa_conv_assignee ON wa_conversations(assigned_user_id,status,updated_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_wa_msg_wamid ON wa_messages(wa_message_id) WHERE wa_message_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_wa_msg_conv ON wa_messages(conversation_id,created_at);
CREATE INDEX IF NOT EXISTS idx_wa_webhook_log_channel ON wa_webhook_log(channel,created_at);

/* Cadastro de clientes mantido pela própria plataforma, além do que a OLT e o
   IXC informam. É o que a tela "Cadastro de Cliente" edita e o mapa GPON
   sobrepõe ao feed (nome, endereço e coordenadas corrigidas). As senhas de
   PPPoE/roteador/WiFi vão cifradas em AES-GCM, mesma proteção das credenciais
   de acesso remoto: a lista nunca as devolve; só a leitura individual, para
   quem tem a ação de edição, abre as senhas. */
CREATE TABLE IF NOT EXISTS   cliente_cadastro (
  client_id TEXT PRIMARY KEY,
  ixc_id TEXT NOT NULL DEFAULT '',
  origem TEXT NOT NULL DEFAULT 'manual',
  ixc_cidade_cod TEXT NOT NULL DEFAULT '',
  ixc_uf_cod TEXT NOT NULL DEFAULT '',
  ixc_contrato_id TEXT NOT NULL DEFAULT '',
  ixc_login TEXT NOT NULL DEFAULT '',
  nome TEXT NOT NULL DEFAULT '',
  cpf_cnpj TEXT NOT NULL DEFAULT '',
  telefone TEXT NOT NULL DEFAULT '',
  email TEXT NOT NULL DEFAULT '',
  endereco TEXT NOT NULL DEFAULT '',
  bairro TEXT NOT NULL DEFAULT '',
  cidade TEXT NOT NULL DEFAULT '',
  uf TEXT NOT NULL DEFAULT '',
  cep TEXT NOT NULL DEFAULT '',
  lat REAL,
  lon REAL,
  plano TEXT NOT NULL DEFAULT '',
  valor_mensal REAL,
  vencimento_dia INTEGER,
  status_faturamento TEXT NOT NULL DEFAULT 'ativo',
  aparelhos_json TEXT NOT NULL DEFAULT '[]',
  ont_serial TEXT NOT NULL DEFAULT '',
  ont_modelo TEXT NOT NULL DEFAULT '',
  ip_gerencia TEXT NOT NULL DEFAULT '',
  login_pppoe TEXT NOT NULL DEFAULT '',
  senha_pppoe_cipher TEXT NOT NULL DEFAULT '',
  login_roteador TEXT NOT NULL DEFAULT '',
  senha_roteador_cipher TEXT NOT NULL DEFAULT '',
  ssid TEXT NOT NULL DEFAULT '',
  senha_wifi_cipher TEXT NOT NULL DEFAULT '',
  senha_portal_cipher TEXT NOT NULL DEFAULT '',
  portal_must_change_password INTEGER NOT NULL DEFAULT 1,
  observacao TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_cliente_cadastro_ixc ON cliente_cadastro(ixc_id);

CREATE TABLE IF NOT EXISTS client_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  token_hash TEXT NOT NULL UNIQUE,
  client_id TEXT NOT NULL REFERENCES cliente_cadastro(client_id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ip TEXT,
  user_agent TEXT
);

CREATE INDEX IF NOT EXISTS idx_client_sessions_client ON client_sessions(client_id);

/* Sessão "convidada" do app noc_cliente: telefone+CPF digitados pelo próprio
   cliente na tela de identificação, sem FK para cliente_cadastro e sem
   nenhuma validação contra o cadastro — ver handleClientLoginPhone. Serve só
   pra abrir o chat já identificado; os dados viram a primeira mensagem, que
   o atendente humano confere manualmente. */
CREATE TABLE IF NOT EXISTS guest_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  token_hash TEXT NOT NULL UNIQUE,
  guest_id TEXT NOT NULL,
  telefone TEXT NOT NULL DEFAULT '',
  cpf_cnpj TEXT NOT NULL DEFAULT '',
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ip TEXT,
  user_agent TEXT
);
CREATE INDEX IF NOT EXISTS idx_guest_sessions_guest ON guest_sessions(guest_id);

/* Espelho relacional do IXC: cada entidade vira tabela própria, chaveada pelo
   código que o ERP usa, para reproduzir a mesma estrutura e permitir join a
   partir de cliente_cadastro. Alimentado por backend/scripts/ixc-clientes-sync.mjs. */
CREATE TABLE IF NOT EXISTS ixc_uf (
  id TEXT PRIMARY KEY, cod_uf TEXT NOT NULL DEFAULT '', nome TEXT NOT NULL DEFAULT '',
  sigla TEXT NOT NULL DEFAULT '', cod_ibge TEXT NOT NULL DEFAULT '',
  regiao TEXT NOT NULL DEFAULT '', id_pais TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS ixc_cidade (
  id TEXT PRIMARY KEY, nome TEXT NOT NULL DEFAULT '', uf TEXT NOT NULL DEFAULT '',
  cod_ibge TEXT NOT NULL DEFAULT '', regiao TEXT NOT NULL DEFAULT '', cod_siafi TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS ixc_cliente (
  id TEXT PRIMARY KEY, razao TEXT NOT NULL DEFAULT '', fantasia TEXT NOT NULL DEFAULT '',
  cnpj_cpf TEXT NOT NULL DEFAULT '', tipo_pessoa TEXT NOT NULL DEFAULT '',
  endereco TEXT NOT NULL DEFAULT '', numero TEXT NOT NULL DEFAULT '', bairro TEXT NOT NULL DEFAULT '',
  cidade TEXT NOT NULL DEFAULT '', uf TEXT NOT NULL DEFAULT '', cep TEXT NOT NULL DEFAULT '',
  latitude TEXT NOT NULL DEFAULT '', longitude TEXT NOT NULL DEFAULT '',
  telefone TEXT NOT NULL DEFAULT '', email TEXT NOT NULL DEFAULT '',
  ativo TEXT NOT NULL DEFAULT '', data_cadastro TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS ixc_cliente_contrato (
  id TEXT PRIMARY KEY, id_cliente TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT '',
  status_internet TEXT NOT NULL DEFAULT '', contrato TEXT NOT NULL DEFAULT '',
  data_ativacao TEXT NOT NULL DEFAULT '', data_cancelamento TEXT NOT NULL DEFAULT '',
  id_produto TEXT NOT NULL DEFAULT '', valor TEXT NOT NULL DEFAULT '',
  endereco TEXT NOT NULL DEFAULT '', numero TEXT NOT NULL DEFAULT '', bairro TEXT NOT NULL DEFAULT '',
  cidade TEXT NOT NULL DEFAULT '', uf TEXT NOT NULL DEFAULT '', cep TEXT NOT NULL DEFAULT '',
  latitude TEXT NOT NULL DEFAULT '', longitude TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_ixc_contrato_cliente ON ixc_cliente_contrato(id_cliente);
CREATE TABLE IF NOT EXISTS ixc_radusuario (
  login TEXT PRIMARY KEY, id_cliente TEXT NOT NULL DEFAULT '', id_contrato TEXT NOT NULL DEFAULT '',
  online TEXT NOT NULL DEFAULT '', ip TEXT NOT NULL DEFAULT '',
  velocidade_download TEXT NOT NULL DEFAULT '', velocidade_upload TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_ixc_radusuario_cliente ON ixc_radusuario(id_cliente);

/* Cadastro único de locais (POP, Data Center, ISP) e de produtos
   (equipamentos). Substituem os arrays "pops" e "equipamentos" que viviam
   soltos dentro do JSON de cada recorte de topologia — agora essas tabelas
   são a fonte de dados que o mapa lê e grava; o blob por recorte guarda só
   conexões, config, fibras e caixas. */
CREATE TABLE IF NOT EXISTS locais (
  id TEXT PRIMARY KEY,
  nome TEXT NOT NULL DEFAULT '',
  tipo TEXT NOT NULL DEFAULT 'POP' CHECK (tipo IN ('POP','Data Center','ISP')),
  endereco TEXT NOT NULL DEFAULT '',
  lat REAL,
  lon REAL,
  observacao TEXT NOT NULL DEFAULT '',
  origem TEXT NOT NULL DEFAULT 'manual',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS produtos (
  id TEXT PRIMARY KEY,
  nome TEXT NOT NULL DEFAULT '',
  fabricante TEXT NOT NULL DEFAULT '',
  modelo TEXT NOT NULL DEFAULT '',
  categoria TEXT NOT NULL DEFAULT '',
  serial TEXT NOT NULL DEFAULT '',
  local_id TEXT REFERENCES locais(id) ON DELETE SET NULL,
  escopo TEXT NOT NULL DEFAULT 'noc' CHECK (escopo IN ('noc','isp')),
  observacao TEXT NOT NULL DEFAULT '',
  portas_json TEXT NOT NULL DEFAULT '[]',
  imagem TEXT NOT NULL DEFAULT '',
  imagem_alt TEXT NOT NULL DEFAULT '',
  hotspots_json TEXT NOT NULL DEFAULT '',
  layout_portas TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_produtos_local ON produtos(local_id);
CREATE INDEX IF NOT EXISTS idx_produtos_escopo ON produtos(escopo);

/* Posição no anel e rotas desenhadas são específicas de cada recorte de
   topologia: o mesmo local físico pode aparecer em posições e traçados
   diferentes no mapa NOC e no mapa ISP. Por isso ficam ligadas por
   (scope,local_id), fora de "locais", que guarda só o dado cadastral. */
CREATE TABLE IF NOT EXISTS topology_local_links (
  scope TEXT NOT NULL,
  local_id TEXT NOT NULL REFERENCES locais(id) ON DELETE CASCADE,
  ordem INTEGER NOT NULL DEFAULT 0,
  rotas_json TEXT NOT NULL DEFAULT '[]',
  legado_equipamentos_json TEXT NOT NULL DEFAULT '[]',
  PRIMARY KEY (scope, local_id)
);
`;


const ROLES = [
  ["administrador", "Acesso total ao sistema"],
  ["gerente", "Acesso gerencial à operação, topologia, usuários e auditoria"],
  ["analista", "Pode visualizar, alterar e excluir a topologia e consultar auditoria"],
  ["atendimento", "Visualização da topologia e informações dos equipamentos"],
  ["tecnico", "Pode visualizar e alterar equipamentos, portas e conexões"],
  ["logistica", "Pode visualizar e alterar informações operacionais da topologia"]
];

// Setores exibidos no menu lateral. O cadastro inicial só é usado na primeira
// implantação; depois, nome, ícone, cor, ordem e estado pertencem ao banco.
// [code, name, description, color, icon, sort]
const NAV_SECTORS = [
  ["atendimento", "HELPDESK", "Atendimento e suporte ao cliente", "#06b6d4", "user", 10],
  ["logistica", "LOGÍSTICA", "Operação logística", "#f59e0b", "pops", 20],
  ["comercial", "COMERCIAL", "Operação comercial", "#8b5cf6", "dashboard", 30],
  ["sac", "SAC", "Serviço de atendimento ao consumidor", "#ec4899", "bell", 40],
  ["financeiro", "FINANCEIRO", "Operação financeira", "#22c55e", "finance", 50],
  ["noc", "NOC", "Operação, monitoramento e topologias de rede", "#2563eb", "topology", 60]
];

// Catálogo de telas do sistema. Toda tela navegável é declarada aqui e passa
// a aparecer em Plataforma → Perfis, onde o acesso é dado por perfil.
// [code, name, description, route, active, icon, sort, nav]
const SCREENS = [
  ["home", "Home", "Painel de abertura: clientes, tráfego da rede e alertas ainda não vistos", "/", 1, "home", 5, 1],
  ["network", "BACKBONE", "Mapa por localidade, equipamentos, portas e enlaces", "/topologia.html", 1, "topology", 10, 1],
  ["gpon", "GPON", "Mapa da topologia da rede GPON", "/gpon.html", 1, "topology", 15, 1],
  ["isp", "ISP", "Mapa por cliente ISP, equipamentos, portas e enlaces", "/isp.html", 1, "topology", 16, 1],
  ["isp-mapa", "Mapa de fibra ISP", "Clientes ISP e caminhos de fibra sobre o mapa geográfico", "/isp-mapa.html", 1, "pops", 17, 1],
  ["isp-cadastro", "Cadastro de POPs ISP", "Cadastrar, editar e excluir clientes ISP e os equipamentos deles", "/isp-cadastro.html", 0, "users", 18, 0],
  ["clientes", "Cadastro de Cliente", "Dados, endereço, faturamento, aparelhos, ONT/ONU e acessos dos clientes", "/clientes.html", 1, "users", 19, 1],
  ["locais", "Cadastro de Locais", "POPs, Data Centers e locais ISP — cadastro único usado pelos mapas", "/locais.html", 1, "pops", 19, 1],
  ["produtos", "Cadastro de Produtos", "Equipamentos cadastrados e o local onde cada um está instalado", "/produtos.html", 1, "topology", 19, 1],
  ["pops", "Cadastro de POPs Backbone", "Inventário por POP, rotas ópticas e sequência do anel", "/pops.html", 0, "pops", 20, 0],
  ["dashboard", "Dashboard NOC", "Painel operacional para TV/NOC", "/dashboard.html", 1, "dashboard", 30, 1],
  ["trafego", "Tráfego", "Monitoramento de tráfego, utilização e erros por interface", "/trafego.html", 1, "trafego", 35, 1],
  ["agenda", "Agenda", "Compromissos pessoais e dos setores do usuário", "/agenda.html", 1, "calendar", 38, 1],
  ["crm", "Central CRM", "Leads, clientes, solicitações e histórico separados por setor", "/crm.html", 1, "users", 25, 1],
  ["whatsapp", "Chat WhatsApp", "Atendimento por WhatsApp com roteamento por setor", "/whatsapp.html", 1, "users", 27, 1],
  ["platform", "Gerenciar plataforma", "Perfis, ações, telas, usuários e auditoria", "/platform.html", 1, "platform", 40, 1],
  //["legado", "Editor clássico", "Editor legado da topologia em tela única", "/legado.html", 1, "edit", 50, 0]
];

// Catálogo de ações (funcionalidades) do sistema.
// A tela responde por "posso abrir"; a ação responde por "o que posso fazer lá".
// [code, name, description, screen_code, module, sort]
const ACTIONS = [
  ["topology.view", "Visualizar a topologia", "Ler equipamentos, POPs, portas e enlaces", "network", "Topologia", 10],
  ["topology.edit", "Alterar a topologia", "Permissão base para qualquer gravação na topologia", "network", "Topologia", 20],
  ["topology.delete", "Excluir na topologia", "Permissão base para qualquer remoção na topologia", "network", "Topologia", 30],
  ["topology.equipment.create", "Cadastrar equipamento", "Criar novos equipamentos na topologia", "network", "Topologia", 40],
  ["topology.equipment.edit", "Editar equipamento", "Alterar nome, modelo, categoria e demais dados", "network", "Topologia", 50],
  ["topology.equipment.delete", "Excluir equipamento", "Remover equipamentos da topologia", "network", "Topologia", 60],
  ["topology.port.edit", "Editar portas", "Criar, alterar e remover portas de um equipamento", "network", "Topologia", 70],
  ["topology.link.create", "Criar enlace", "Documentar enlaces entre portas", "network", "Topologia", 80],
  ["topology.link.delete", "Remover enlace", "Desfazer enlaces já documentados", "network", "Topologia", 90],
  ["topology.pop.link", "Vincular equipamento ao POP", "Definir ou desfazer o POP de um equipamento", "network", "Topologia", 100],
  ["topology.layout", "Salvar posições do mapa", "Gravar o posicionamento manual dos POPs no mapa", "network", "Topologia", 110],
  ["topology.config", "Alterar configurações do mapa", "Títulos e demais parâmetros de exibição da topologia", "network", "Topologia", 120],

  ["topology.connection.use", "Usar conexão remota", "Cadastrar as próprias credenciais e abrir SSH ou TELNET", "network", "Acesso remoto", 10],
  ["topology.connection.configure", "Configurar conexão remota", "Definir IP, protocolo e porta de gerência do equipamento", "network", "Acesso remoto", 20],
  ["topology.connection.provision", "Provisionar usuários nos aparelhos", "Definir a credencial de um usuário em um aparelho e enviá-la ao equipamento via SSH", "network", "Acesso remoto", 30],

  ["zabbix.view", "Consultar o Zabbix", "Ver hosts, interfaces e status da sincronização", "network", "Monitoramento (Zabbix)", 10],
  ["zabbix.sync", "Sincronizar o Zabbix", "Disparar a importação de hosts e interfaces", "network", "Monitoramento (Zabbix)", 20],
  ["zabbix.link", "Vincular host do Zabbix", "Associar host monitorado a um equipamento", "network", "Monitoramento (Zabbix)", 30],

  ["trafego.settings", "Configurar o painel de tráfego", "Limites, nomes e descrições de interface, atualização e painéis do modo TV", "trafego", "Tráfego", 10],

  ["agenda.view", "Consultar agendas", "Ver a própria agenda e as agendas dos setores vinculados", "agenda", "Agenda", 10],
  ["agenda.create", "Cadastrar compromissos", "Criar compromissos pessoais e nos setores vinculados", "agenda", "Agenda", 20],
  ["agenda.edit", "Editar compromissos", "Alterar compromissos próprios ou dos setores vinculados", "agenda", "Agenda", 30],
  ["agenda.delete", "Excluir compromissos", "Excluir compromissos próprios ou dos setores vinculados", "agenda", "Agenda", 40],

  ["crm.view", "Consultar CRM", "Ver registros dos setores aos quais o usuário pertence", "crm", "CRM", 10],
  ["crm.create", "Cadastrar no CRM", "Criar leads, oportunidades e solicitações nos setores permitidos", "crm", "CRM", 20],
  ["crm.edit", "Editar CRM", "Alterar dados, responsáveis, etapas e próximos contatos", "crm", "CRM", 30],
  ["crm.interact", "Registrar interações", "Adicionar ligações, mensagens, reuniões, e-mails e notas ao histórico", "crm", "CRM", 40],
  ["crm.delete", "Excluir do CRM", "Excluir registros e todo o histórico relacionado", "crm", "CRM", 50],

  ["whatsapp.view", "Consultar o chat", "Ver conversas, fila de roteamento e status dos colegas do setor", "whatsapp", "WhatsApp", 10],
  ["whatsapp.chat", "Atender conversas", "Pegar conversas da fila, responder e encerrar atendimentos", "whatsapp", "WhatsApp", 20],
  ["whatsapp.supervise", "Supervisionar conversas", "Ver com quem cada colega está conversando e atribuir conversas", "whatsapp", "WhatsApp", 30],
  ["whatsapp.manage", "Configurar o chat", "Editar saudação, menu de setores e mensagens automáticas do bot", "whatsapp", "WhatsApp", 40],

  ["fibra.edit", "Editar caminhos de fibra", "Criar e alterar cabos, traçados e caixas ópticas no mapa da PARTE ISP", "isp-mapa", "Caminhos de fibra", 10],
  ["fibra.delete", "Excluir caminhos de fibra", "Remover cabos, traçados e caixas ópticas do mapa da PARTE ISP", "isp-mapa", "Caminhos de fibra", 20],


  ["pops.create", "Cadastrar POP", "Criar novos POPs", "pops", "POPs e anel", 10],
  ["pops.edit", "Editar POP", "Alterar nome e dados do POP", "pops", "POPs e anel", 20],
  ["pops.delete", "Excluir POP", "Remover POPs do cadastro", "pops", "POPs e anel", 30],
  ["pops.order", "Editar a sequência dos POPs", "Reordenar os POPs do anel", "pops", "POPs e anel", 40],
  ["pops.routes", "Editar rotas do anel", "Criar e remover rotas aéreas e subterrâneas", "pops", "POPs e anel", 50],
  ["pops.ring.layout", "Salvar desenho do anel", "Gravar o posicionamento manual do mapa do anel", "pops", "POPs e anel", 60],

  ["roles.view", "Consultar perfis", "Ver perfis, ações e telas configuradas", "platform", "Plataforma", 10],
  ["roles.manage", "Gerenciar perfis", "Criar, editar, duplicar e excluir perfis e seus acessos", "platform", "Plataforma", 20],
  ["screens.manage", "Gerenciar telas", "Ativar e desativar telas do sistema", "platform", "Plataforma", 30],
  ["users.view", "Consultar usuários", "Ver as contas de acesso", "platform", "Plataforma", 40],
  ["users.manage", "Gerenciar usuários", "Criar, alterar e ativar/desativar contas", "platform", "Plataforma", 50],
  ["users.password", "Redefinir senha", "Definir senha temporária para outras contas", "platform", "Plataforma", 60],
  ["sectors.manage", "Gerenciar setores", "Criar setores e vincular usuários a um ou mais setores", "platform", "Plataforma", 65],
  ["audit.view", "Consultar auditoria", "Ver o histórico de ações da plataforma", "platform", "Plataforma", 70],
  ["audit.export", "Exportar auditoria", "Baixar o histórico em CSV", "platform", "Plataforma", 80],
  ["settings.manage", "Alterar configurações", "Configurações administrativas da plataforma", "platform", "Plataforma", 90],

  ["clientes.view", "Consultar cadastro de clientes", "Ver dados, endereço, faturamento, aparelhos e acessos dos clientes", "clientes", "Cadastro de cliente", 10],
  ["clientes.create", "Cadastrar cliente", "Criar o cadastro de um cliente", "clientes", "Cadastro de cliente", 20],
  ["clientes.edit", "Editar cadastro de cliente", "Alterar dados, endereço, faturamento e acessos do cliente", "clientes", "Cadastro de cliente", 30],
  ["clientes.delete", "Excluir cadastro de cliente", "Remover o cadastro de um cliente", "clientes", "Cadastro de cliente", 40],

  ["locais.view", "Consultar cadastro de locais", "Ver POPs, Data Centers e locais ISP cadastrados", "locais", "Cadastro de local", 10],
  ["locais.create", "Cadastrar local", "Criar um POP, Data Center ou local ISP", "locais", "Cadastro de local", 20],
  ["locais.edit", "Editar cadastro de local", "Alterar dados de um local cadastrado", "locais", "Cadastro de local", 30],
  ["locais.delete", "Excluir cadastro de local", "Remover um local cadastrado", "locais", "Cadastro de local", 40],

  ["produtos.view", "Consultar cadastro de produtos", "Ver os equipamentos cadastrados e o local de cada um", "produtos", "Cadastro de produto", 10],
  ["produtos.create", "Cadastrar produto", "Criar o cadastro de um equipamento", "produtos", "Cadastro de produto", 20],
  ["produtos.edit", "Editar cadastro de produto", "Alterar dados e o local vinculado de um equipamento", "produtos", "Cadastro de produto", 30],
  ["produtos.delete", "Excluir cadastro de produto", "Remover o cadastro de um equipamento", "produtos", "Cadastro de produto", 40],

  ["radius.view", "Consultar log RADIUS", "Ver eventos de autenticação PPPoE (login offline/online) dos clientes GPON", "gpon", "Rede", 40]
];

const ALL_ACTION_CODES = ACTIONS.map(x => x[0]);
const ALL_SCREEN_CODES = SCREENS.map(x => x[0]);

/* O administrador é o perfil mestre do sistema: acesso total, por definição.
   Ele não depende do que está gravado em role_permissions/role_screens — se
   uma marcação se perder no banco, quem reabre o sistema ficaria trancado do
   lado de fora, sem ninguém para devolver o acesso. */
const PERFIL_PROTEGIDO = "administrador";
const ehMestre = (user) => String(user?.role || "") === PERFIL_PROTEGIDO;

/* Impressão digital do schema + catálogos. Enquanto ela não muda, o banco já
   está no formato que este código espera e a migração inteira pode ser pulada
   com uma única consulta — em vez das 65 idas ao D1 que o `ensureDatabaseImpl`
   fazia em toda partida a frio do isolate. Qualquer alteração em SCHEMA, ROLES,
   SCREENS ou ACTIONS muda a impressão e a migração roda de novo no primeiro
   acesso. */
function fingerprintOf(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `${text.length.toString(36)}.${h.toString(36)}`;
}

const SCHEMA_FINGERPRINT = fingerprintOf(SCHEMA + JSON.stringify([ROLES, NAV_SECTORS, SCREENS, ACTIONS]));
const SCHEMA_FINGERPRINT_KEY = "schema.fingerprint";

const TOPOLOGY_ACTIONS = ALL_ACTION_CODES.filter(c => c.startsWith("topology.") || c.startsWith("pops.") || c.startsWith("zabbix.") || c.startsWith("fibra."));

const ROLE_PERMISSIONS = {
  administrador: ALL_ACTION_CODES,
  gerente: [
    ...TOPOLOGY_ACTIONS, "trafego.settings",
    "agenda.view","agenda.create","agenda.edit","agenda.delete",
    "crm.view","crm.create","crm.edit","crm.interact","crm.delete",
    "whatsapp.view","whatsapp.chat","whatsapp.supervise","whatsapp.manage",
    "clientes.view","clientes.create","clientes.edit","clientes.delete",
    "locais.view","locais.create","locais.edit","locais.delete",
    "produtos.view","produtos.create","produtos.edit","produtos.delete",
    "roles.view","users.view","users.manage","users.password","sectors.manage","audit.view","audit.export","settings.manage"
  ],
  analista: [
    "topology.view","topology.edit","topology.delete","topology.equipment.create","topology.equipment.edit",
    "topology.equipment.delete","topology.port.edit","topology.link.create","topology.link.delete",
    "topology.pop.link","topology.layout","zabbix.view","zabbix.sync","trafego.settings",
    "pops.create","pops.edit","pops.delete","pops.order","pops.routes","pops.ring.layout",
    "fibra.edit","fibra.delete","agenda.view","agenda.create","agenda.edit","agenda.delete","audit.view",
    "crm.view","crm.create","crm.edit","crm.interact","whatsapp.view",
    "clientes.view","clientes.create","clientes.edit","radius.view",
    "locais.view","locais.create","locais.edit","locais.delete",
    "produtos.view","produtos.create","produtos.edit","produtos.delete"
  ],
  atendimento: ["topology.view","zabbix.view","agenda.view","agenda.create","agenda.edit","agenda.delete","crm.view","crm.create","crm.edit","crm.interact","whatsapp.view","whatsapp.chat","clientes.view","clientes.edit","radius.view","locais.view","produtos.view"],
  tecnico: [
    "topology.view","topology.edit","topology.equipment.create","topology.equipment.edit","topology.port.edit",
    "topology.link.create","topology.pop.link","topology.layout",
    "zabbix.view","zabbix.sync","zabbix.link","trafego.settings",
    "pops.edit","pops.order","pops.routes","pops.ring.layout","fibra.edit",
    "agenda.view","agenda.create","agenda.edit","agenda.delete","crm.view","crm.create","crm.edit","crm.interact","whatsapp.view","whatsapp.chat",
    "clientes.view","clientes.create","clientes.edit","radius.view",
    "locais.view","locais.create","locais.edit",
    "produtos.view","produtos.create","produtos.edit"
  ],
  logistica: [
    "topology.view","topology.edit","topology.equipment.create","topology.equipment.edit","topology.port.edit",
    "topology.pop.link","zabbix.view","pops.create","pops.edit","pops.order",
    "agenda.view","agenda.create","agenda.edit","agenda.delete","crm.view","crm.create","crm.edit","crm.interact","whatsapp.view",
    "clientes.view","clientes.edit","radius.view",
    "locais.view","locais.create","locais.edit",
    "produtos.view","produtos.create","produtos.edit"
  ]
};

const ROLE_SCREENS = {
  administrador: ALL_SCREEN_CODES,
  gerente: ["home","network","gpon","isp","isp-mapa","isp-cadastro","pops","dashboard","trafego","agenda","crm","whatsapp","platform","legado","clientes","locais","produtos"],
  analista: ["home","network","gpon","isp","isp-mapa","isp-cadastro","pops","dashboard","trafego","agenda","crm","whatsapp","legado","clientes","locais","produtos"],
  atendimento: ["home","network","gpon","isp","isp-mapa","isp-cadastro","pops","dashboard","trafego","agenda","crm","whatsapp","clientes","locais","produtos"],
  tecnico: ["home","network","gpon","isp","isp-mapa","isp-cadastro","pops","dashboard","trafego","agenda","crm","whatsapp","legado","clientes","locais","produtos"],
  logistica: ["home","network","gpon","isp","isp-mapa","isp-cadastro","pops","dashboard","agenda","crm","whatsapp","clientes","locais","produtos"]
};

/* Telas que aparecem no menu de todos os setores, e não só no setor ao qual
   foram associadas no catálogo. O cadastro de cliente atende o HELPDESK, a
   logística, o comercial, o SAC, o financeiro e o NOC ao mesmo tempo. */
const SCREENS_GLOBAIS = new Set(["clientes"]);

/* Perfis criados fora do catálogo (ou instalações antigas) recebem as ações
   novas a partir do que já tinham. Roda uma única vez, controlado por
   platform_meta: depois disso, quem manda é o que o administrador marcou. */
const ACTION_EQUIVALENCE = [
  ["topology.view", ["zabbix.view","topology.connection.use"]],
  ["topology.edit", [
    "topology.equipment.create","topology.equipment.edit","topology.port.edit","topology.link.create",
    "topology.pop.link","topology.layout","topology.config","zabbix.sync","zabbix.link",
    "pops.create","pops.edit","pops.order","pops.routes","pops.ring.layout","trafego.settings","fibra.edit"
  ]],
  ["topology.equipment.edit", ["topology.connection.configure", "topology.connection.provision"]],
  ["topology.delete", ["topology.equipment.delete","topology.link.delete","pops.delete","fibra.delete"]],
  ["users.manage", ["users.password"]],
  ["audit.view", ["audit.export"]],
  ["settings.manage", ["roles.view"]]
];

// "*" é seguro aqui porque a API não depende mais de cookie pra requisição
// cross-origin: o app (mobile/webchat) autentica por Authorization: Bearer,
// que só vai se o próprio cliente colocar — sem risco de CSRF por origem
// não confiável poder "andar de carona" numa credencial ambient.
function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
      "permissions-policy": "camera=(), microphone=(), geolocation=()",
      "access-control-allow-origin": "*",
      ...extraHeaders
    }
  });
}

function corsPreflight() {
  return new Response(null, {
    status: 204,
    headers: {
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
      "access-control-allow-headers": "Content-Type, Authorization",
      "access-control-max-age": "86400"
    }
  });
}

// `no-referrer` impede que a URL da página vaze em requisições seguintes;
// o resto fecha sniffing de tipo e enquadramento em iframe de terceiros.
function securityHeaders(base) {
  const h = new Headers(base);
  h.set("Referrer-Policy", "no-referrer");
  h.set("X-Content-Type-Options", "nosniff");
  h.set("X-Frame-Options", "DENY");
  h.set("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  // img-src libera os tiles do OpenStreetMap usados como fundo do mapa da
  // topologia. Só imagem: nenhum script de terceiro entra na página.
  h.set("Content-Security-Policy", "default-src 'self'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'; object-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https://tile.openstreetmap.org https://*.tile.openstreetmap.org; connect-src 'self'");
  return h;
}

function getDB(env) {
  return getTursoD1(env);
}

function randomBytes(length = 32) {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return bytes;
}

function bytesToBase64Url(bytes) {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlToBytes(value) {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((value.length + 3) % 4);
  const raw = atob(padded);
  return Uint8Array.from(raw, c => c.charCodeAt(0));
}

function timingSafeEqual(a, b) {
  return constantTimeEqual(a, b);
}

async function sha256Base64Url(text) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return bytesToBase64Url(new Uint8Array(digest));
}

async function hashPassword(password, saltBytes = randomBytes(16), iterations = PBKDF2_ITERATIONS) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"]
  );

  const bits = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      salt: saltBytes,
      iterations,
      hash: "SHA-256"
    },
    key,
    256
  );

  return `pbkdf2$${iterations}$${bytesToBase64Url(saltBytes)}$${bytesToBase64Url(new Uint8Array(bits))}`;
}

async function verifyPassword(password, encoded) {
  try {
    const [scheme, iterText, saltText, hashText] = encoded.split("$");
    if (scheme !== "pbkdf2") return false;

    const iterations = Number(iterText);
    const salt = base64UrlToBytes(saltText);
    const expected = hashText;

    const actualEncoded = await hashPassword(password, salt, iterations);
    const actual = actualEncoded.split("$")[3];

    return await timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

function parseCookies(request) {
  const header = request.headers.get("Cookie") || "";
  const cookies = {};
  for (const part of header.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k) cookies[k] = v.join("=");
  }
  return cookies;
}

function getClientIP(request) {
  return (request.headers.get("CF-Connecting-IP") || "unknown").slice(0, 64);
}

function safeSqlIdentifier(value) {
  const identifier = String(value || "");
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(identifier)) throw new Error("Identificador SQL inválido.");
  return identifier;
}

function bearerToken(request) {
  const auth = request.headers.get("Authorization") || "";
  return auth.startsWith("Bearer ") ? auth.slice(7).trim() : null;
}

// Token da sessão: cookie __Host- pro navegador do NOC, ou Authorization:
// Bearer pro app (mobile/webchat), que não tem como enviar Origin/
// Sec-Fetch-Site — ver csrfFailure.
function extractSessionToken(request) {
  return bearerToken(request) || parseCookies(request)[COOKIE_NAME] || null;
}

function csrfFailure(request) {
  if (["GET", "HEAD", "OPTIONS"].includes(request.method)) return null;
  // Bearer é credencial explícita, não ambient: diferente do cookie, o
  // navegador nunca a anexa sozinho numa origem diferente, então uma página
  // maliciosa não consegue forjar essa requisição. Sem risco de CSRF aqui —
  // é assim que o app (mobile/webchat) autentica, já que ele não manda
  // Origin nem Sec-Fetch-Site.
  if (bearerToken(request)) return null;
  const site = request.headers.get("Sec-Fetch-Site");
  if (site === "cross-site") return json({ error: "CROSS_SITE_REQUEST_BLOCKED" }, 403);
  const origin = request.headers.get("Origin");
  if (origin && origin !== new URL(request.url).origin) return json({ error: "ORIGIN_INVALID" }, 403);
  if (!origin && !site && parseCookies(request)[COOKIE_NAME]) return json({ error: "ORIGIN_REQUIRED" }, 403);
  return null;
}

function boundedInteger(value, fallback, minimum, maximum) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? Math.min(Math.max(parsed, minimum), maximum) : fallback;
}

async function readJson(request, maxBytes = MAX_JSON_BODY_BYTES) {
  const declared = Number(request.headers.get("Content-Length") || 0);
  if (declared > maxBytes) throw new Error("BODY_TOO_LARGE");
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > maxBytes) throw new Error("BODY_TOO_LARGE");
  return JSON.parse(text);
}

/* As colunas de audit_logs só mudam quando a migração roda. Consultá-las a cada
   gravação custava uma ida ao D1 por evento auditado. */
let auditColumnNames = null;

async function auditColumns(db) {
  if (!auditColumnNames) {
    const columns = (await db.prepare(`PRAGMA table_info(audit_logs)`).all()).results || [];
    auditColumnNames = new Set(columns.map(c => c.name));
  }
  return auditColumnNames;
}

/* Estado anterior e posterior da topologia inteira passam de 50 KB cada. Gravar
   os dois em toda alteração multiplicava por três o que ia para o D1 a cada
   "salvar" e fazia a tabela de auditoria crescer sem limite. Acima do teto, o
   registro guarda o tamanho e a forma do objeto — o que mudou de fato continua
   em details_json, que carrega o diff e os totais. */
const AUDIT_JSON_MAX_BYTES = 16 * 1024;

function auditJson(value, max = AUDIT_JSON_MAX_BYTES) {
  if (value == null) return null;
  const texto = JSON.stringify(value);
  if (texto.length <= max) return texto;
  const resumo = { __truncado: true, bytes: texto.length };
  if (value && typeof value === "object" && !Array.isArray(value)) {
    resumo.campos = Object.fromEntries(Object.entries(value).map(([k, v]) => [k, Array.isArray(v) ? v.length : typeof v]));
  }
  return JSON.stringify(resumo);
}

async function audit(env, request, user, action, resourceType, resourceId = null, before = null, after = null, details = null) {
  const db = getDB(env);
  if (!db) return;

  // Compatibilidade com schemas antigos do D1:
  // versões anteriores deste projeto usavam `resource` enquanto
  // a versão atual usa `resource_type`. O banco existente não é apagado.
  const names = await auditColumns(db);

  const fields = [];
  const values = [];

  const add = (name, value) => {
    if (names.has(name)) {
      fields.push(name);
      values.push(value);
    }
  };

  add("user_id", user?.id ?? null);
  add("username", user?.username ?? null);
  add("action", action);

  // `resource` é NOT NULL em alguns bancos antigos.
  // Sempre o preenche quando a coluna existir.
  if (names.has("resource")) {
    add("resource", resourceType || "system");
  }
  if (names.has("resource_type")) {
    add("resource_type", resourceType || "system");
  }

  add("resource_id", resourceId == null ? null : String(resourceId));
  add("method", request.method);
  add("path", new URL(request.url).pathname);
  add("ip", getClientIP(request));
  add("user_agent", request.headers.get("User-Agent") || "");
  add("before_json", auditJson(before));
  add("after_json", auditJson(after));
  add("details_json", auditJson(details));

  // Compatibilidade com bancos que ainda usam occurred_at.
  if (names.has("occurred_at") && !names.has("created_at")) {
    add("occurred_at", new Date().toISOString());
  }

  const safeFields = fields.map(safeSqlIdentifier);
  const placeholders = safeFields.map(() => "?").join(", ");
  await db.prepare(`
    INSERT INTO audit_logs (${safeFields.join(", ")})
    VALUES (${placeholders})
  `).bind(...values).run();
}

async function requireUser(env, request) {
  return getCurrentUser(env, request);
}

// Conjunto de ações do perfil do usuário. Uma consulta só por requisição:
// as verificações granulares da topologia comparam dezenas de códigos.
async function permissionsOf(env, user) {
  if (!user) return new Set();
  if (ehMestre(user)) return new Set(ALL_ACTION_CODES);
  const rows = (await getDB(env).prepare(`
    SELECT p.code FROM role_permissions rp
    JOIN permissions p ON p.id=rp.permission_id
    WHERE rp.role_id=?
  `).bind(user.role_id).all()).results || [];
  return new Set(rows.map(x => x.code));
}

async function hasPermission(env, user, code) {
  if (!user) return false;
  if (ehMestre(user)) return true;
  const db = getDB(env);
  const row = await db.prepare(`
    SELECT 1
    FROM role_permissions rp
    JOIN permissions p ON p.id=rp.permission_id
    JOIN roles r ON r.id=rp.role_id
    WHERE r.id=? AND p.code=?
    LIMIT 1
  `).bind(user.role_id, code).first();
  return !!row;
}

async function ensureColumns(db, table, columns) {
  const safeTable = safeSqlIdentifier(table);
  const info = (await db.prepare(`PRAGMA table_info(${safeTable})`).all()).results || [];
  const existentes = new Set(info.map(c => c.name));
  for (const [name, ddl] of columns) {
    if (existentes.has(name)) continue;
    const safeName = safeSqlIdentifier(name);
    if (!/^(?:TEXT|INTEGER)(?:\s+NOT NULL)?(?:\s+DEFAULT\s+(?:'[^']*'|\d+))?$/.test(ddl)) {
      throw new Error("Definição de coluna não permitida.");
    }
    await db.prepare(`ALTER TABLE ${safeTable} ADD COLUMN ${safeName} ${ddl}`).run();
  }
}

// Renomeia uma coluna em bancos já existentes (o CREATE TABLE IF NOT EXISTS
// não altera tabelas criadas por versões anteriores).
async function renameColumnIfExists(db, table, from, to) {
  const safeTable = safeSqlIdentifier(table);
  const info = (await db.prepare(`PRAGMA table_info(${safeTable})`).all()).results || [];
  const nomes = new Set(info.map(c => c.name));
  if (nomes.has(from) && !nomes.has(to)) {
    await db.prepare(`ALTER TABLE ${safeTable} RENAME COLUMN ${safeSqlIdentifier(from)} TO ${safeSqlIdentifier(to)}`).run();
  }
}

/* Semeadura idempotente: roda uma vez e registra em platform_meta.
   Sem isso, um deploy devolveria as ações que o administrador tirou. */
async function seedOnce(db, key, run) {
  const feito = await db.prepare(`SELECT key FROM platform_meta WHERE key=?`).bind(key).first();
  if (feito) return false;
  await run();
  await db.prepare(`
    INSERT OR REPLACE INTO platform_meta(key,value,updated_at) VALUES (?,?,CURRENT_TIMESTAMP)
  `).bind(key, new Date().toISOString()).run();
  return true;
}

async function requirePermission(env, request, code) {
  const user = await requireUser(env, request);
  if (!user) return { user: null, response: json({error:"AUTH_REQUIRED"},401) };
  if (!(await hasPermission(env, user, code))) {
    return { user, response: json({error:"FORBIDDEN", permission:code},403) };
  }
  return { user, response: null };
}

// Gate das rotas /api/client/* (papel "cliente" — cliente final da ISP no
// app). Nunca usa requirePermission/hasPermission: uma sessão de cliente não
// tem role_id/role_permissions, então essas funções sempre negariam. Toda
// consulta dentro de um handler que usa este gate deve ser escopada por
// gate.user.id (== cliente_cadastro.client_id do próprio cliente autenticado),
// nunca por um id vindo do corpo/query da requisição.
async function requireClient(env, request) {
  const user = await requireUser(env, request);
  if (!user) return { user: null, response: json({error:"AUTH_REQUIRED"},401) };
  if (user.role !== "cliente") return { user, response: json({error:"FORBIDDEN"},403) };
  return { user, response: null };
}

let databaseSchemaReady = false;

async function ensureDatabase(env) {
  if (databaseSchemaReady) return;
  // Somente o sinal persistente de conclusão é mantido. A Promise e o binding
  // D1 nunca atravessam requisições, evitando I/O ligado ao contexto anterior.
  const db = getDB(env);
  if (!db) throw new Error("Conexão Turso não disponível.");

  // Caminho rápido: o isolate é reciclado com frequência e, sem isto, toda
  // partida a frio repetia a migração inteira antes de responder a primeira
  // requisição. Uma consulta responde se há algo a fazer.
  try {
    const marca = await db.prepare(`SELECT value FROM platform_meta WHERE key=?`).bind(SCHEMA_FINGERPRINT_KEY).first();
    if (marca?.value === SCHEMA_FINGERPRINT) {
      databaseSchemaReady = true;
      return;
    }
  } catch {
    // Banco ainda sem platform_meta: segue para a migração completa.
  }

  await ensureDatabaseImpl(env);
  await db.prepare(`
    INSERT OR REPLACE INTO platform_meta(key,value,updated_at) VALUES (?,?,CURRENT_TIMESTAMP)
  `).bind(SCHEMA_FINGERPRINT_KEY, SCHEMA_FINGERPRINT).run();
  databaseSchemaReady = true;
}

async function ensureDatabaseImpl(env) {
  const db = getDB(env);
  if (!db) throw new Error("Conexão Turso não disponível.");

  // A migração pode acrescentar colunas em audit_logs: o cache é refeito depois.
  auditColumnNames = null;

  // A importação .ics substituiu integralmente o vínculo OAuth do Google.
  // Apaga também os tokens antigos, que não devem permanecer armazenados.
  await db.batch([
    db.prepare(`DROP TABLE IF EXISTS google_calendar_states`),
    db.prepare(`DROP TABLE IF EXISTS google_calendar_connections`)
  ]);

  // Cada item do SCHEMA é um CREATE independente. A divisão simples também
  // funciona quando há comentários entre dois comandos, algo que o D1
  // tolerava dentro de prepare(), mas o protocolo HTTP do Turso rejeita.
  const schemaStatements = SCHEMA.replace(/\/\*[\s\S]*?\*\//g, "").split(";")
    .map(x => x.trim()).filter(Boolean);

  // Índices que usam colunas adicionadas por migração só podem ser criados
  // depois dos ALTER TABLE. Isso mantém compatibilidade com bancos antigos.
  const tableStatements = schemaStatements
    .filter(x => !/\bCREATE (?:UNIQUE )?INDEX\b/i.test(x))
    .map(x => db.prepare(x));
  await db.batch(tableStatements);

  // Bancos criados por versões anteriores não recebem colunas novas pelo
  // CREATE TABLE IF NOT EXISTS: os ALTER TABLE abaixo completam o schema.
  await ensureColumns(db, "sessions", [
    ["token_hash", "TEXT"],
    ["ip", "TEXT"],
    ["user_agent", "TEXT"]
  ]);
  await ensureColumns(db, "users", [
    ["email", "TEXT"],
    ["oauth_issuer", "TEXT"],
    ["oauth_subject", "TEXT"]
  ]);
  await ensureColumns(db, "audit_logs", [
    ["created_at", "TEXT"]
  ]);
  await ensureColumns(db, "screens", [
    ["route", "TEXT NOT NULL DEFAULT '/'"],
    ["icon", "TEXT NOT NULL DEFAULT 'topology'"],
    ["sort", "INTEGER NOT NULL DEFAULT 0"],
    ["nav", "INTEGER NOT NULL DEFAULT 1"],
    ["sector_id", "INTEGER"]
  ]);
  await ensureColumns(db, "sectors", [
    ["icon", "TEXT NOT NULL DEFAULT 'circle'"],
    ["sort", "INTEGER NOT NULL DEFAULT 0"]
  ]);
  await ensureColumns(db, "permissions", [
    ["name", "TEXT NOT NULL DEFAULT ''"],
    ["module", "TEXT NOT NULL DEFAULT 'Geral'"],
    ["screen_code", "TEXT"],
    ["sort", "INTEGER NOT NULL DEFAULT 0"]
  ]);
  await ensureColumns(db, "agenda_events", [
    ["source", "TEXT NOT NULL DEFAULT 'updown'"],
    ["external_uid", "TEXT"],
    ["imported_at", "TEXT"]
  ]);
  await ensureColumns(db, "alert_reads", [
    ["comentario", "TEXT NOT NULL DEFAULT ''"]
  ]);
  await ensureColumns(db, "device_connection_targets", [
    ["vendor", "TEXT NOT NULL DEFAULT 'outro'"],
    ["provision_username", "TEXT"],
    ["provision_ciphertext", "TEXT"]
  ]);
  /* O cadastro passou a nascer sozinho da coleta GPON: 'ixc_id' guarda o
     código do cliente no IXC — o mesmo que o operador procura no ERP — e
     'origem' separa quem entrou pela importação de quem foi digitado. */
   await ensureColumns(db, "cliente_cadastro", [
    ["ixc_id", "TEXT NOT NULL DEFAULT ''"],
    ["origem", "TEXT NOT NULL DEFAULT 'manual'"],
    ["ixc_cidade_cod", "TEXT NOT NULL DEFAULT ''"],
    ["ixc_uf_cod", "TEXT NOT NULL DEFAULT ''"],
    ["ixc_contrato_id", "TEXT NOT NULL DEFAULT ''"],
    ["ixc_login", "TEXT NOT NULL DEFAULT ''"],
    /* Senha do app do cliente (papel "cliente"), distinta de senha_pppoe_cipher
       (senha PPPoE editável por staff): misturar as duas faria uma alteração
       de staff derrubar a sessão do cliente no app e vice-versa. */
    ["senha_portal_cipher", "TEXT NOT NULL DEFAULT ''"],
    ["portal_must_change_password", "INTEGER NOT NULL DEFAULT 1"]
  ]);
  /* O campo de identificação do cliente passou de `documento` para `cpf_cnpj`.
     Bancos antigos ganham o rename; bancos novos já nascem com `cpf_cnpj`. */
  await renameColumnIfExists(db, "cliente_cadastro", "documento", "cpf_cnpj");
  /* Todo cliente cadastrado antes de senha_portal_cipher existir nasceu com
     essa coluna vazia, e handleLogin recusa senha vazia — ou seja, ninguém
     que já existia conseguia mais entrar no app. Como ponte, herdam a
     própria senha PPPoE (mesmo formato pbkdf2$…, hash compatível com
     verifyPassword) e são obrigados a trocá-la no próximo login — o acesso
     volta sem abrir mão da separação entre as duas senhas daqui pra frente.
     O WHERE torna isto seguro em todo boot: só preenche o que ainda está
     vazio, nunca sobrescreve uma senha de portal já definida pela equipe. */
  await db.prepare(`
    UPDATE cliente_cadastro
    SET senha_portal_cipher = senha_pppoe_cipher, portal_must_change_password = 1
    WHERE senha_portal_cipher = '' AND senha_pppoe_cipher <> ''
  `).run();
  /* Bancos criados antes dos canais externos (Opa!Suite Meta e Webchat)
     ganham as colunas com o mesmo default 'whatsapp' das conversas nativas
     já existentes, então nada muda para quem só usa o número da Meta. */
  await ensureColumns(db, "wa_conversations", [
    ["channel", "TEXT NOT NULL DEFAULT 'whatsapp'"],
    ["external_id", "TEXT NOT NULL DEFAULT ''"]
  ]);

  const auditInfo = (await db.prepare(`PRAGMA table_info(audit_logs)`).all()).results || [];
  const auditColumns = new Set(auditInfo.map(column => column.name));
  if (auditColumns.has("occurred_at") && auditColumns.has("created_at")) {
    await db.prepare(`
      UPDATE audit_logs
      SET created_at=COALESCE(created_at, occurred_at, CURRENT_TIMESTAMP)
      WHERE created_at IS NULL OR created_at=''
    `).run();
  }

  const indexStatements = schemaStatements
    .filter(x => /\bCREATE (?:UNIQUE )?INDEX\b/i.test(x))
    .map(x => db.prepare(x));
  await db.batch(indexStatements);

  // Os três catálogos vão em um único batch: são dezenas de INSERTs e, um a um,
  // cada um custava uma ida ao D1.
  //
  // O catálogo (rótulo, descrição, módulo, rota, ícone) é do código.
  // O que o administrador decide — quem acessa o quê e qual tela está ativa —
  // fica no banco e nunca é sobrescrito por um deploy.
  await db.batch([
    ...ROLES.map(([name, description]) => db.prepare(`
      INSERT INTO roles(name,description) VALUES (?,?)
      ON CONFLICT(name) DO NOTHING
    `).bind(name,description)),
    ...NAV_SECTORS.map(([code,name,description,color,icon,sort]) => db.prepare(`
      INSERT OR IGNORE INTO sectors(code,name,description,color,icon,sort) VALUES (?,?,?,?,?,?)
    `).bind(code,name,description,color,icon,sort)),
    ...ACTIONS.map(([code,name,description,screenCode,module,sort]) => db.prepare(`
      INSERT INTO permissions(code,name,description,screen_code,module,sort) VALUES (?,?,?,?,?,?)
      ON CONFLICT(code) DO UPDATE SET
        name=excluded.name, description=excluded.description,
        screen_code=excluded.screen_code, module=excluded.module, sort=excluded.sort
    `).bind(code,name,description,screenCode,module,sort)),
    ...SCREENS.map(([code,name,description,route,active,icon,sort,nav]) => db.prepare(`
      INSERT INTO screens(code,name,description,route,active,icon,sort,nav,sector_id)
      VALUES (?,?,?,?,?,?,?,?,(SELECT id FROM sectors WHERE code='noc'))
      ON CONFLICT(code) DO UPDATE SET
        name=excluded.name, description=excluded.description, route=excluded.route,
        icon=excluded.icon, sort=excluded.sort, nav=excluded.nav
    `).bind(code,name,description,route,active,icon,sort,nav))
  ]);

  const idsOf = async (table, key) => {
    const safeTable = safeSqlIdentifier(table);
    const safeKey = safeSqlIdentifier(key);
    return Object.fromEntries(
      ((await db.prepare(`SELECT id,${safeKey} FROM ${safeTable}`).all()).results || []).map(x => [x[safeKey], x.id])
    );
  };
  const roleMap = await idsOf("roles","name");
  const permMap = await idsOf("permissions","code");
  const screenMap = await idsOf("screens","code");

  // Telas já existentes antes da setorização passam uma única vez para NOC.
  // As escolhas posteriores do administrador nunca são sobrescritas.
  await seedOnce(db, "seed.navigation_sectors.v1", async () => {
    await db.prepare(`
      UPDATE screens SET sector_id=(SELECT id FROM sectors WHERE code='noc')
      WHERE sector_id IS NULL
    `).run();
  });

  // A Central CRM aparece no bloco Comercial, mas seus registros e funis são
  // separados pelo setor escolhido. A associação explícita também corrige
  // instalações nas quais a tela entrou primeiro no bloco padrão (NOC).
  await db.prepare(`
    UPDATE screens SET sector_id=(SELECT id FROM sectors WHERE code='comercial')
    WHERE code='crm'
  `).run();

  // O Chat WhatsApp é o atendimento ao cliente: fica no bloco HELPDESK.
  await db.prepare(`
    UPDATE screens SET sector_id=(SELECT id FROM sectors WHERE code='atendimento')
    WHERE code='whatsapp'
  `).run();

  // As concessões são montadas como statements e enviadas em batch: sozinhas,
  // cada uma custava uma ida ao D1 e são dezenas por partida a frio.
  const grantPermission = (roleId, code) => permMap[code]
    ? db.prepare(`INSERT OR IGNORE INTO role_permissions(role_id,permission_id) VALUES (?,?)`).bind(roleId,permMap[code])
    : null;
  const grantScreen = (roleId, code) => screenMap[code]
    ? db.prepare(`INSERT OR IGNORE INTO role_screens(role_id,screen_id) VALUES (?,?)`).bind(roleId,screenMap[code])
    : null;
  const runGrants = async (statements) => {
    const validos = statements.filter(Boolean);
    if (validos.length) await db.batch(validos);
  };

  // Acessos padrão dos perfis do catálogo: aplicados uma única vez.
  await seedOnce(db, "seed.role_access.v2", async () => {
    const grants = [];
    for (const [role,codes] of Object.entries(ROLE_PERMISSIONS)) {
      if (!roleMap[role]) continue;
      for (const code of codes) grants.push(grantPermission(roleMap[role], code));
    }
    for (const [role,codes] of Object.entries(ROLE_SCREENS)) {
      if (!roleMap[role]) continue;
      for (const code of codes) grants.push(grantScreen(roleMap[role], code));
    }

    // Perfis fora do catálogo (criados pelo administrador) recebem as ações
    // novas equivalentes ao que já podiam fazer, para nada parar de funcionar.
    // Object.hasOwn: nomes de perfil vêm do usuário e "constructor" não pode
    // ser confundido com um perfil do catálogo.
    const custom = ((await db.prepare(`SELECT id,name FROM roles`).all()).results || [])
      .filter(r => !Object.hasOwn(ROLE_PERMISSIONS, r.name));
    for (const role of custom) {
      const atuais = new Set(((await db.prepare(`
        SELECT p.code FROM role_permissions rp JOIN permissions p ON p.id=rp.permission_id WHERE rp.role_id=?
      `).bind(role.id).all()).results || []).map(x => x.code));
      for (const [origem, derivadas] of ACTION_EQUIVALENCE) {
        if (!atuais.has(origem)) continue;
        for (const code of derivadas) grants.push(grantPermission(role.id, code));
      }
    }
    await runGrants(grants);
  });

  // As telas novas (POPs e editor clássico) entram para quem já tinha a
  // topologia — o menu do perfil continua com as mesmas telas de antes.
  await seedOnce(db, "seed.new_screens.v2", async () => {
    const comRede = ((await db.prepare(`
      SELECT rs.role_id FROM role_screens rs JOIN screens s ON s.id=rs.screen_id WHERE s.code='network'
    `).all()).results || []).map(x => x.role_id);
    await runGrants(comRede.flatMap(roleId => [
      grantScreen(roleId, "pops"),
      grantScreen(roleId, "legado")
    ]));
  });

  // A nova área GPON acompanha, na primeira implantação, os perfis que já
  // podiam abrir a topologia principal. Depois disso, o administrador pode
  // alterar esse acesso normalmente em Plataforma → Perfis e ações.
  await seedOnce(db, "seed.gpon_screen.v1", async () => {
    const comRede = ((await db.prepare(`
      SELECT rs.role_id FROM role_screens rs JOIN screens s ON s.id=rs.screen_id WHERE s.code='network'
    `).all()).results || []).map(x => x.role_id);
    await runGrants(comRede.map(roleId => grantScreen(roleId, "gpon")));
  });

  // A tela "Mapas GPON" saiu: o mapa operacional já vive dentro da própria
  // GPON, e manter duas rotas para o mesmo conteúdo só dividia o menu. O
  // upsert do catálogo não apaga linhas, então a remoção é feita aqui uma vez.
  await seedOnce(db, "seed.gpon_map_screen_removido.v1", async () => {
    await db.prepare(`
      DELETE FROM role_screens WHERE screen_id IN (SELECT id FROM screens WHERE code='gpon-mapa')
    `).run();
    await db.prepare(`DELETE FROM screens WHERE code='gpon-mapa'`).run();
  });

  // A home é a tela de abertura de todo mundo: qualquer perfil que já tenha
  // alguma tela liberada passa a enxergá-la. Como toda semeadura, roda uma vez
  // só — tirar a home de um perfil continua sendo decisão do administrador.
  await seedOnce(db, "seed.home_screen.v1", async () => {
    const perfis = ((await db.prepare(`SELECT DISTINCT role_id FROM role_screens`).all()).results || [])
      .map(x => x.role_id);
    await runGrants(perfis.map(roleId => grantScreen(roleId, "home")));
  });

  // Agenda acompanha os perfis que já possuem alguma tela operacional. O
  // setor continua sendo a segunda camada de autorização para cada calendário.
  await seedOnce(db, "seed.agenda.v1", async () => {
    const perfis = ((await db.prepare(`SELECT DISTINCT role_id FROM role_screens`).all()).results || [])
      .map(x => x.role_id);
    await runGrants(perfis.flatMap(roleId => [
      grantScreen(roleId, "agenda"),
      grantPermission(roleId, "agenda.view"),
      grantPermission(roleId, "agenda.create"),
      grantPermission(roleId, "agenda.edit"),
      grantPermission(roleId, "agenda.delete")
    ]));
    if (roleMap.administrador) await runGrants([grantPermission(roleMap.administrador, "sectors.manage")]);
  });

  // O CRM acompanha os perfis operacionais existentes. Depois da primeira
  // concessão, a Plataforma continua sendo a fonte de verdade das permissões.
  await seedOnce(db, "seed.crm.v1", async () => {
    const perfis = ((await db.prepare(`SELECT DISTINCT role_id FROM role_screens`).all()).results || [])
      .map(x => x.role_id);
    await runGrants(perfis.flatMap(roleId => [
      grantScreen(roleId, "crm"),
      grantPermission(roleId, "crm.view"),
      grantPermission(roleId, "crm.create"),
      grantPermission(roleId, "crm.edit"),
      grantPermission(roleId, "crm.interact")
    ]));
    if (roleMap.administrador) await runGrants([grantPermission(roleMap.administrador, "crm.delete")]);
  });

  // O Chat WhatsApp acompanha os perfis operacionais existentes na primeira
  // implantação. Atendimento responde; supervisão e configuração ficam com
  // gerente e administrador. Depois, vale o que for marcado na Plataforma.
  await seedOnce(db, "seed.whatsapp.v1", async () => {
    const perfis = ((await db.prepare(`SELECT DISTINCT role_id FROM role_screens`).all()).results || [])
      .map(x => x.role_id);
    await runGrants(perfis.flatMap(roleId => [
      grantScreen(roleId, "whatsapp"),
      grantPermission(roleId, "whatsapp.view"),
      grantPermission(roleId, "whatsapp.chat")
    ]));
    for (const role of ["administrador", "gerente"]) {
      if (!roleMap[role]) continue;
      await runGrants([
        grantPermission(roleMap[role], "whatsapp.supervise"),
        grantPermission(roleMap[role], "whatsapp.manage")
      ]);
    }
  });

  // O cadastro de cliente é para todo setor que já atende alguém. Na primeira
  // implantação, quem já tinha tela operacional ganha a tela e o direito de
  // consultar, cadastrar e editar; a exclusão fica com o administrador.
  await seedOnce(db, "seed.clientes.v1", async () => {
    const perfis = ((await db.prepare(`SELECT DISTINCT role_id FROM role_screens`).all()).results || [])
      .map(x => x.role_id);
    await runGrants(perfis.flatMap(roleId => [
      grantScreen(roleId, "clientes"),
      grantPermission(roleId, "clientes.view"),
      grantPermission(roleId, "clientes.create"),
      grantPermission(roleId, "clientes.edit")
    ]));
    if (roleMap.administrador) await runGrants([grantPermission(roleMap.administrador, "clientes.delete")]);
  });

  // A PARTE ISP (topologia + mapa de fibra) segue a mesma regra da GPON: quem
  // já abria a topologia principal passa a enxergá-la, e quem já podia mexer
  // nas rotas do anel também pode mexer nos caminhos de fibra.
  await seedOnce(db, "seed.isp_screens.v2", async () => {
    const comRede = ((await db.prepare(`
      SELECT rs.role_id FROM role_screens rs JOIN screens s ON s.id=rs.screen_id WHERE s.code='network'
    `).all()).results || []).map(x => x.role_id);
    const grants = comRede.flatMap(roleId =>
      ["isp", "isp-mapa", "isp-cadastro"].map(code => grantScreen(roleId, code)));
    for (const [origem, destino] of [["pops.routes", "fibra.edit"], ["pops.delete", "fibra.delete"]]) {
      const donos = ((await db.prepare(`
        SELECT rp.role_id FROM role_permissions rp JOIN permissions p ON p.id=rp.permission_id WHERE p.code=?
      `).bind(origem).all()).results || []).map(x => x.role_id);
      grants.push(...donos.map(roleId => grantPermission(roleId, destino)));
    }
    await runGrants(grants);
  });

  // A tela de Cadastro de POPs Backbone foi retirada da navegação e do acesso
  // de todos os perfis, mas o código continua no repositório. O upsert do
  // catálogo não grava `active`, então a desativação é feita aqui uma vez.
  await seedOnce(db, "seed.pops_screen_hidden.v1", async () => {
    await db.prepare(`UPDATE screens SET active=0, nav=0 WHERE code='pops'`).run();
  });

  // O Cadastro de ISP standalone virou duplicata da aba "Lista" da Topologia
  // ISP (mesmo noc-isp-cadastro.js, embutido em isp.html). O upsert do
  // catálogo não grava `active`, então a desativação é feita aqui uma vez.
  await seedOnce(db, "seed.isp_cadastro_screen_hidden.v1", async () => {
    await db.prepare(`UPDATE screens SET active=0, nav=0 WHERE code='isp-cadastro'`).run();
  });

  // Acesso remoto foi adicionado depois do catálogo inicial. Replica uma vez
  // as capacidades já concedidas, sem voltar a alterar escolhas futuras do
  // administrador na tela de perfis.
  await seedOnce(db, "seed.device_connections.v1", async () => {
    const equivalencias = [
      ["topology.view", "topology.connection.use"],
      ["topology.equipment.edit", "topology.connection.configure"]
    ];
    const grants = [];
    for (const [origem, destino] of equivalencias) {
      if (!permMap[origem] || !permMap[destino]) continue;
      const perfis = ((await db.prepare(`
        SELECT role_id FROM role_permissions WHERE permission_id=?
      `).bind(permMap[origem]).all()).results || []).map(x => x.role_id);
      for (const roleId of perfis) grants.push(grantPermission(roleId, destino));
    }
    await runGrants(grants);
  });

  // Converte o acesso único da primeira versão em um destino nomeado. O texto
  // cifrado é copiado sem ser aberto; o AAD continua usando usuário+aparelho.
  await seedOnce(db, "seed.device_connection_targets.v1", async () => {
    await db.batch([
      db.prepare(`
        INSERT OR IGNORE INTO device_connection_targets
          (id,device_id,name,management_ip,protocol,port,updated_by,created_at,updated_at)
        SELECT 'legacy:'||device_id,device_id,'Acesso principal',management_ip,protocol,port,updated_by,updated_at,updated_at
        FROM device_connections
      `),
      db.prepare(`
        INSERT OR IGNORE INTO device_target_credentials
          (target_id,user_id,login_username,password_ciphertext,updated_at)
        SELECT 'legacy:'||device_id,user_id,login_username,password_ciphertext,updated_at
        FROM device_credentials
      `),
      db.prepare(`
        INSERT OR IGNORE INTO device_connection_acl(target_id,role_id,can_connect,can_manage)
        SELECT t.id,rp.role_id,1,0
        FROM device_connection_targets t
        JOIN permissions p ON p.code='topology.connection.use'
        JOIN role_permissions rp ON rp.permission_id=p.id
      `),
      db.prepare(`
        INSERT INTO device_connection_acl(target_id,role_id,can_connect,can_manage)
        SELECT t.id,rp.role_id,1,1
        FROM device_connection_targets t
        JOIN permissions p ON p.code='topology.connection.configure'
        JOIN role_permissions rp ON rp.permission_id=p.id
        ON CONFLICT(target_id,role_id) DO UPDATE SET can_connect=1,can_manage=1
      `)
    ]);
  });

  /* O painel de tráfego ganhou ajustes próprios (limites, período, apelidos de
     interface e rotação do telão) depois de `seed.role_access.v2` já ter
     rodado, então os perfis existentes nunca receberiam a ação nova por ali.
     Quem já podia alterar a topologia passa a poder configurar o painel — é o
     mesmo grau de responsabilidade. Roda uma vez: depois disso vale o que o
     administrador marcar na tela de Perfis. */
  await seedOnce(db, "seed.trafego_settings.v1", async () => {
    if (!permMap["topology.edit"] || !permMap["trafego.settings"]) return;
    const perfis = ((await db.prepare(`
      SELECT role_id FROM role_permissions WHERE permission_id=?
    `).bind(permMap["topology.edit"]).all()).results || []).map(x => x.role_id);
    await runGrants(perfis.map(roleId => grantPermission(roleId, "trafego.settings")));
  });

  // O cadastro de locais e de produtos substitui os arrays soltos dentro da
  // topologia. Quem já podia editar a topologia (equipamentos/POPs) ganha as
  // duas telas e o CRUD completo; os demais perfis operacionais ganham só
  // consulta e edição, seguindo a mesma régua do cadastro de cliente.
  await seedOnce(db, "seed.locais_produtos.v1", async () => {
    const grants = [];
    const comEdicaoTopologia = ((await db.prepare(`
      SELECT role_id FROM role_permissions WHERE permission_id=?
    `).bind(permMap["topology.edit"]).all()).results || []).map(x => x.role_id);
    for (const roleId of comEdicaoTopologia) {
      grants.push(
        grantScreen(roleId, "locais"), grantScreen(roleId, "produtos"),
        grantPermission(roleId, "locais.view"), grantPermission(roleId, "locais.create"),
        grantPermission(roleId, "locais.edit"), grantPermission(roleId, "locais.delete"),
        grantPermission(roleId, "produtos.view"), grantPermission(roleId, "produtos.create"),
        grantPermission(roleId, "produtos.edit"), grantPermission(roleId, "produtos.delete")
      );
    }
    const comVisaoTopologia = ((await db.prepare(`
      SELECT role_id FROM role_permissions WHERE permission_id=?
    `).bind(permMap["topology.view"]).all()).results || []).map(x => x.role_id);
    for (const roleId of comVisaoTopologia) {
      grants.push(
        grantScreen(roleId, "locais"), grantScreen(roleId, "produtos"),
        grantPermission(roleId, "locais.view"), grantPermission(roleId, "produtos.view")
      );
    }
    await runGrants(grants);
  });

  // O administrador nunca fica sem acesso: é a garantia de reabrir o sistema.
  if (roleMap.administrador) {
    await runGrants([
      ...ALL_ACTION_CODES.map(code => grantPermission(roleMap.administrador, code)),
      ...ALL_SCREEN_CODES.map(code => grantScreen(roleMap.administrador, code))
    ]);
  }

  const bootstrapPassword = String(env.BOOTSTRAP_ADMIN_PASSWORD || "");
  const bootstrapUsername = String(env.BOOTSTRAP_ADMIN_USERNAME || "admin").trim();
  const adminRole = await db.prepare(`SELECT id FROM roles WHERE name='administrador'`).first();
  const admin = await db.prepare(`SELECT id FROM users WHERE lower(username)=lower(?)`).bind(bootstrapUsername).first();
  if (!admin && bootstrapPassword) {
    if (bootstrapPassword.length < 12) throw new Error("BOOTSTRAP_ADMIN_PASSWORD deve ter ao menos 12 caracteres.");
    await db.prepare(`
      INSERT INTO users(username,display_name,password_hash,role_id,active,must_change_password)
      VALUES (?,?,?,?,1,1)
    `).bind(bootstrapUsername,"Administrador",await hashPassword(bootstrapPassword),adminRole.id).run();
  }
}

const DEFAULT_TOPOLOGY_CONFIG = {
  subtitle:"Topologia de Rede • Ascenty / BGP / MPLS",
  coreTitle:"BACKBONE • ANEL ÓPTICO",
  ringTitle:"ANEL ÓPTICO DOS POPs",
  ringLabel:"ANEL — ROTAS AÉREAS E SUBTERRÂNEAS",
  popSectionTitle:"EQUIPAMENTOS POR POP"
};

/* Recortes de topologia. "noc" é a rede principal e continua na tabela
   topology_state; os demais vivem em topology_scopes, com o mesmo formato de
   documento. Cada recorte declara de quais arquivos de /data ele nasce e qual
   título abre a tela. */
const TOPOLOGY_SCOPES = {
  noc: {
    seed: {equipamentos:"equipamentos.json", conexoes:"conexoes.json", pops:"pops.json"},
    config: {}
  },
  isp: {
    seed: {
      equipamentos:"isp-equipamentos.json", conexoes:"isp-conexoes.json", pops:"pops.json",
      fibras:"isp-fibras.json", caixas:"isp-caixas.json"
    },
    config: {
      title:"PARTE ISP",
      subtitle:"Clientes ISP • Caminhos de fibra",
      coreTitle:"CLIENTES ISP ATENDIDOS",
      popSectionTitle:"EQUIPAMENTOS POR CLIENTE ISP"
    }
  }
};
const DEFAULT_SCOPE = "noc";
const scopeOf = (url) => {
  const pedido = String(url.searchParams.get("scope") || DEFAULT_SCOPE).toLowerCase();
  return Object.hasOwn(TOPOLOGY_SCOPES, pedido) ? pedido : null;
};

/* As listas de fibras e caixas só existem nos recortes que as declaram: a rede
   NOC continua com um documento de topologia sem esses campos. */
const scopeTemFibra = (scope) => Boolean(TOPOLOGY_SCOPES[scope]?.seed.fibras);

const LOCAL_TIPOS = new Set(["POP", "Data Center", "ISP"]);

/* Semeadura única de locais/produtos a partir dos JSONs estáticos, na
   primeira vez que o sistema é aberto num banco novo. Depois disso, quem
   manda é o D1: os arquivos de /data continuam servindo só de carga inicial,
   igual ao que loadInitialTopology fazia com o blob antes desta tabela
   existir. */
async function ensureLocaisProdutosSeed(env, request) {
  const db = getDB(env);
  const jaTemLocal = await db.prepare(`SELECT id FROM locais LIMIT 1`).first();
  if (jaTemLocal) return;

  const read = async (name) => {
    const url = new URL(request.url);
    url.pathname = `/data/${name}`;
    url.search = "";
    const r = await env.ASSETS.fetch(new Request(url.toString(), { method: "GET" }));
    return r.ok ? r.json() : [];
  };
  const pops = await read("pops.json");
  const equipamentosPorEscopo = [["noc", await read("equipamentos.json")], ["isp", await read("isp-equipamentos.json")]];

  const statements = [];
  pops.forEach((pop, indice) => {
    if (!pop?.id) return;
    statements.push(db.prepare(`
      INSERT OR IGNORE INTO locais(id,nome,tipo,endereco,lat,lon,observacao,origem)
      VALUES (?,?,?,?,?,?,?,'seed')
    `).bind(String(pop.id), String(pop.nome || ""), LOCAL_TIPOS.has(pop.tipo) ? pop.tipo : "POP",
      String(pop.endereco || ""), Number.isFinite(pop.lat) ? pop.lat : null,
      Number.isFinite(pop.lon) ? pop.lon : null, String(pop.observacao || "")));
    // Ambos os recortes nascem do mesmo pops.json (ver TOPOLOGY_SCOPES): a
    // ordem e as rotas iniciais valem para os dois até serem editadas.
    for (const scope of Object.keys(TOPOLOGY_SCOPES)) {
      statements.push(db.prepare(`
        INSERT OR IGNORE INTO topology_local_links(scope,local_id,ordem,rotas_json,legado_equipamentos_json)
        VALUES (?,?,?,?,?)
      `).bind(scope, String(pop.id), indice, JSON.stringify(pop.rotas || []), JSON.stringify(pop.equipamentos || [])));
    }
  });
  for (const [escopo, lista] of equipamentosPorEscopo) {
    for (const eq of lista) {
      if (!eq?.id) continue;
      statements.push(db.prepare(`
        INSERT OR IGNORE INTO produtos(id,nome,fabricante,modelo,categoria,serial,local_id,escopo,observacao,
          portas_json,imagem,imagem_alt,hotspots_json,layout_portas)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      `).bind(String(eq.id), String(eq.nome || ""), String(eq.fabricante || ""), String(eq.modelo || ""),
        String(eq.categoria || ""), String(eq.serial || ""), eq.popId ? String(eq.popId) : null, escopo,
        String(eq.observacao || ""), JSON.stringify(eq.portas || []), String(eq.imagem || ""),
        String(eq.imagemAlt || ""), eq.hotspots ? JSON.stringify(eq.hotspots) : "", String(eq.layoutPortas || "")));
    }
  }
  if (statements.length) await db.batch(statements);
}

function popRowParaLocal(row) {
  return {
    id: row.id, nome: row.nome, tipo: row.tipo, endereco: row.endereco,
    lat: row.lat, lon: row.lon, observacao: row.observacao,
    rotas: JSON.parse(row.rotas_json || "[]"),
    equipamentos: JSON.parse(row.legado_equipamentos_json || "[]")
  };
}

function produtoRowParaEquipamento(row, nomeLocalPorId) {
  const eq = {
    id: row.id, nome: row.nome, fabricante: row.fabricante, modelo: row.modelo,
    categoria: row.categoria, serial: row.serial,
    local: row.local_id ? (nomeLocalPorId.get(row.local_id) || "") : "",
    popId: row.local_id || null, observacao: row.observacao,
    portas: JSON.parse(row.portas_json || "[]")
  };
  if (row.imagem) eq.imagem = row.imagem;
  if (row.imagem_alt) eq.imagemAlt = row.imagem_alt;
  if (row.hotspots_json) eq.hotspots = JSON.parse(row.hotspots_json);
  if (row.layout_portas) eq.layoutPortas = row.layout_portas;
  return eq;
}

/* Locais são uma tabela só, compartilhada pelos dois recortes: a ordem no
   anel e as rotas desenhadas é que são específicas de cada mapa. */
async function montarPops(db, scope) {
  const rows = (await db.prepare(`
    SELECT l.*, t.ordem, t.rotas_json, t.legado_equipamentos_json
    FROM topology_local_links t JOIN locais l ON l.id = t.local_id
    WHERE t.scope=? ORDER BY t.ordem
  `).bind(scope).all()).results || [];
  return rows.map(popRowParaLocal);
}

/* O recorte ISP mostra, além dos próprios equipamentos, os equipamentos de
   backbone (dono "noc") vinculados a um POP compartilhado — contexto visual,
   calculado na hora em vez de duplicado numa segunda linha, já que agora só
   existe uma linha por id na tabela produtos. */
async function montarEquipamentos(db, scope) {
  const proprios = (await db.prepare(`SELECT * FROM produtos WHERE escopo=?`).bind(scope).all()).results || [];
  let linhas = proprios;
  if (scope === "isp") {
    const emprestados = (await db.prepare(`
      SELECT * FROM produtos WHERE escopo='noc' AND (
        categoria='POP' OR local_id IN (SELECT local_id FROM topology_local_links WHERE scope='isp')
      )
    `).all()).results || [];
    linhas = [...emprestados, ...proprios];
  }
  const locaisRows = (await db.prepare(`SELECT id,nome FROM locais`).all()).results || [];
  const nomePorId = new Map(locaisRows.map(l => [l.id, l.nome]));
  return linhas.map(row => produtoRowParaEquipamento(row, nomePorId));
}

/* Carrega só o que ainda vive no blob por recorte: conexões, config, fibras
   e caixas. POPs e equipamentos vêm de locais/produtos (ver montarPops e
   montarEquipamentos), já semeadas por ensureLocaisProdutosSeed. */
async function loadInitialTopologyBlob(env, request, scope = DEFAULT_SCOPE) {
  const recorte = TOPOLOGY_SCOPES[scope] || TOPOLOGY_SCOPES[DEFAULT_SCOPE];
  const read = async (name) => {
    const url = new URL(request.url);
    url.pathname = `/data/${name}`;
    url.search = "";
    const r = await env.ASSETS.fetch(new Request(url.toString(), { method: "GET" }));
    if (!r.ok) throw new Error(`Não foi possível carregar /data/${name}`);
    return r.json();
  };
  const inicial = { config: { ...DEFAULT_TOPOLOGY_CONFIG, ...recorte.config } };
  inicial.conexoes = await read(recorte.seed.conexoes);
  if (recorte.seed.fibras) inicial.fibras = await read(recorte.seed.fibras);
  if (recorte.seed.caixas) inicial.caixas = await read(recorte.seed.caixas);

  /* O recorte ISP também mostra os enlaces entre os equipamentos de backbone
     vinculados aos POPs compartilhados — mesma ideia de montarEquipamentos,
     mas aqui é só a carga inicial: depois de criado, o documento do ISP vive
     por conta própria, como sempre foi. */
  if (scope === "isp") {
    const db = getDB(env);
    const nocPopEquipIds = new Set(((await db.prepare(`
      SELECT id FROM produtos WHERE escopo='noc' AND (
        categoria='POP' OR local_id IN (SELECT local_id FROM topology_local_links WHERE scope='isp')
      )
    `).all()).results || []).map(r => r.id));
    const nocConexoes = await read("conexoes.json");
    const nocPopConexoes = nocConexoes.filter(c => nocPopEquipIds.has(c.origem) || nocPopEquipIds.has(c.destino));
    inicial.conexoes = [...nocPopConexoes, ...inicial.conexoes];
  }
  return inicial;
}

async function ensureTopologyState(env, request, scope = DEFAULT_SCOPE) {
  const db = getDB(env);
  await ensureLocaisProdutosSeed(env, request);
  // A rede principal continua na tabela de sempre, com a linha única id=1.
  const ler = scope === DEFAULT_SCOPE
    ? () => db.prepare(`SELECT * FROM topology_state WHERE id=1`).first()
    : () => db.prepare(`SELECT * FROM topology_scopes WHERE scope=?`).bind(scope).first();
  const row = await ler();
  if (row) return row;
  const initial = await loadInitialTopologyBlob(env, request, scope);
  await (scope === DEFAULT_SCOPE
    ? db.prepare(`
        INSERT INTO topology_state(id,data_json,version,updated_at,updated_by)
        VALUES (1,?,1,CURRENT_TIMESTAMP,NULL)
      `).bind(JSON.stringify(initial))
    : db.prepare(`
        INSERT INTO topology_scopes(scope,data_json,version,updated_at,updated_by)
        VALUES (?,?,1,CURRENT_TIMESTAMP,NULL)
      `).bind(scope, JSON.stringify(initial))
  ).run();
  return await ler();
}

export function sessionDurationSeconds(remember) {
  return remember === true ? REMEMBERED_SESSION_SECONDS : SHORT_SESSION_SECONDS;
}

async function createSession(env, request, user, authenticationMethod = "password", remember = true) {
  const db = getDB(env);
  const rawToken = bytesToBase64Url(randomBytes(48));
  const tokenHash = await sha256Base64Url(rawToken);
  const durationSeconds = sessionDurationSeconds(remember);
  const expires = new Date(Date.now() + durationSeconds * 1000).toISOString();

  await db.prepare(`
    INSERT INTO sessions(token_hash, user_id, expires_at, ip, user_agent)
    VALUES (?, ?, ?, ?, ?)
  `).bind(tokenHash, user.id, expires, getClientIP(request), (request.headers.get("User-Agent") || "").slice(0, 512)).run();

  await audit(env, request, user, "LOGIN", "auth", String(user.id), null, {role:user.role}, {method:authenticationMethod});

  return {
    cookie: `${COOKIE_NAME}=${rawToken}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${durationSeconds}`,
    token: rawToken,
    tokenHash
  };
}

// Sessão de cliente (aplicativo): autenticação pela tabela cliente_cadastro,
// usando o CPF/CNPJ (sincronizado do IXC) como usuário e uma senha própria do
// app (hash PBKDF2 em senha_portal_cipher, atribuída por staff) para
// verificação — não há validação ao vivo contra o IXC, que não expõe essa
// checagem por webservice.
async function createClientSession(env, request, cliente) {
  const db = getDB(env);
  const rawToken = bytesToBase64Url(randomBytes(48));
  const tokenHash = await sha256Base64Url(rawToken);
  const durationSeconds = sessionDurationSeconds(true);
  const expires = new Date(Date.now() + durationSeconds * 1000).toISOString();

  await db.prepare(`
    INSERT INTO client_sessions(token_hash, client_id, expires_at, ip, user_agent)
    VALUES (?, ?, ?, ?, ?)
  `).bind(tokenHash, cliente.client_id, expires, getClientIP(request), (request.headers.get("User-Agent") || "").slice(0, 512)).run();

  await audit(env, request, { username: cliente.cpf_cnpj }, "LOGIN", "auth", cliente.client_id, null, { role: "cliente" }, { method: "password" });

  return {
    cookie: `${COOKIE_NAME}=${rawToken}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${durationSeconds}`,
    token: rawToken,
    tokenHash
  };
}

async function loginAttemptKey(request, username) {
  return oauthSha256Base64Url(`${getClientIP(request)}\n${String(username).trim().toLowerCase()}`);
}

async function isLoginRateLimited(env, request, username) {
  const key = await loginAttemptKey(request, username);
  const row = await getDB(env).prepare(`
    SELECT COUNT(*) AS total FROM login_attempts
    WHERE attempt_key=? AND attempted_at > datetime('now','-15 minutes')
  `).bind(key).first();
  return { key, blocked: Number(row?.total || 0) >= 5 };
}

async function recordFailedLogin(env, key) {
  const db = getDB(env);
  await db.batch([
    db.prepare(`INSERT INTO login_attempts(attempt_key) VALUES (?)`).bind(key),
    db.prepare(`DELETE FROM login_attempts WHERE attempted_at <= datetime('now','-1 day')`)
  ]);
}

async function getCurrentUser(env, request) {
  const db = getDB(env);
  const rawToken = extractSessionToken(request);
  if (!rawToken) return null;

  const tokenHash = await sha256Base64Url(rawToken);

  const row = await db.prepare(`
    SELECT
      u.id,
      u.username,
      u.display_name,
      u.active,
      u.must_change_password,
      u.last_login_at,
      r.id AS role_id,
      r.name AS role
    FROM sessions s
    JOIN users u ON u.id=s.user_id
    JOIN roles r ON r.id=u.role_id
    WHERE s.token_hash=?
      AND u.active=1
      AND s.expires_at > datetime('now')
  `).bind(tokenHash).first();

  if (row) return row;

  // Sessão de cliente (aplicativo): autenticado pela tabela cliente_cadastro.
  const cliente = await db.prepare(`
    SELECT
      c.client_id AS id,
      c.cpf_cnpj AS username,
      c.nome AS display_name,
      1 AS active,
      c.portal_must_change_password AS must_change_password,
      'cliente' AS role
    FROM client_sessions s
    JOIN cliente_cadastro c ON c.client_id=s.client_id
    WHERE s.token_hash=?
      AND s.expires_at > datetime('now')
    LIMIT 1
  `).bind(tokenHash).first();

  if (cliente) return cliente;

  // Sessão "convidada" (app noc_cliente): telefone/CPF digitados pelo cliente,
  // nunca validados contra cliente_cadastro — ver handleClientLoginPhone.
  const guest = await db.prepare(`
    SELECT
      guest_id AS id,
      cpf_cnpj AS username,
      telefone AS display_name,
      telefone,
      1 AS is_guest,
      1 AS active,
      0 AS must_change_password,
      'cliente' AS role
    FROM guest_sessions
    WHERE token_hash=?
      AND expires_at > datetime('now')
    LIMIT 1
  `).bind(tokenHash).first();

  return guest || null;
}

async function handleLogin(env, request) {
  let body;
  try {
    body = await readJson(request, 16384);
  } catch {
    return json({ ok: false, error: "INVALID_REQUEST" }, 400);
  }

  const username = String(body.username || "").trim();
  const password = String(body.password || "");

  if (!username || !password) {
    return json({ ok: false, error: "MISSING_FIELDS" }, 400);
  }

  const db = getDB(env);
  if (env.PASSWORD_LOGIN_ENABLED === "false") return json({ error: "PASSWORD_LOGIN_DISABLED" }, 403);
  const attempt = await isLoginRateLimited(env, request, username);
  if (attempt.blocked) return json({ error: "TOO_MANY_ATTEMPTS" }, 429, { "Retry-After": "900" });

  const user = await db.prepare(`
    SELECT
      u.id, u.username, u.display_name, u.password_hash,
      u.active, u.must_change_password,
      r.id AS role_id, r.name AS role
    FROM users u
    JOIN roles r ON r.id=u.role_id
    WHERE lower(u.username)=lower(?)
    LIMIT 1
  `).bind(username).first();

  if (user && user.active && (await verifyPassword(password, user.password_hash))) {
    await db.prepare(`DELETE FROM login_attempts WHERE attempt_key=?`).bind(attempt.key).run();
    await db.prepare(`
      UPDATE users
      SET last_login_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP
      WHERE id=?
    `).bind(user.id).run();

    const session = await createSession(env, request, user, "password", body.remember === true);
    return json({
      ok: true,
      user: {
        id: user.id,
        username: user.username,
        display_name: user.display_name,
        role: user.role,
        must_change_password: Boolean(user.must_change_password)
      },
      // Usado pelo app (mobile/webchat) como Authorization: Bearer — ele não
      // consegue mandar Origin/Sec-Fetch-Site, então autenticar só por cookie
      // cai no bloqueio de CSRF em toda requisição que muda estado.
      token: session.token
    }, 200, {
      "Set-Cookie": session.cookie
    });
  }

  // Autenticação de cliente (aplicativo): tabela cliente_cadastro, com
  // CPF/CNPJ (sincronizado do IXC) como usuário e uma senha própria do app
  // (hash PBKDF2 em senha_portal_cipher, atribuída por staff — não há
  // validação ao vivo contra o IXC). Toleramos pontuação no CPF/CNPJ.
  const cpfBusca = username.replace(/[^\d]/g, "");
  const cliente = await db.prepare(`
    SELECT client_id, cpf_cnpj, nome, senha_portal_cipher, portal_must_change_password
    FROM cliente_cadastro
    WHERE lower(cpf_cnpj)=lower(?)
       OR replace(replace(replace(cpf_cnpj, '.', ''), '-', ''), '/', '')=?
    LIMIT 1
  `).bind(username, cpfBusca).first();

  if (!cliente || !cliente.senha_portal_cipher || !(await verifyPassword(password, cliente.senha_portal_cipher))) {
    await recordFailedLogin(env, attempt.key);
    if (user) {
      await audit(env, request, user, "LOGIN_FAILED", "auth", String(user.id), null, null, {reason:"invalid_credentials"});
    }
    return json({ ok: false, error: "INVALID_CREDENTIALS" }, 401);
  }

  await db.prepare(`DELETE FROM login_attempts WHERE attempt_key=?`).bind(attempt.key).run();

  const clientSession = await createClientSession(env, request, cliente);
  return json({
    ok: true,
    user: {
      id: cliente.client_id,
      username: cliente.cpf_cnpj,
      display_name: cliente.nome,
      role: "cliente",
      must_change_password: Boolean(cliente.portal_must_change_password)
    },
    token: clientSession.token
  }, 200, {
    "Set-Cookie": clientSession.cookie
  });
}

// POST /api/auth/client-login — identificação do app do cliente (noc_cliente):
// telefone + CPF/CNPJ digitados pelo próprio cliente, SEM validação/consulta
// contra cliente_cadastro. Não é um login de verdade — é uma sessão
// "convidada" (guest_sessions) cujo único propósito é abrir o chat de
// suporte já identificado; os dados batem no atendente como texto da
// primeira mensagem (ver AuthProvider no Flutter), pra ele confirmar quem é
// o cliente manualmente. Mantém o rate limit por IP+CPF+telefone só pra não
// virar vetor de flood de conversas falsas — nunca é limpo em caso de
// "sucesso" porque aqui não existe falha a distinguir.
async function handleClientLoginPhone(env, request) {
  let body;
  try {
    body = await readJson(request, 4096);
  } catch {
    return json({ ok: false, error: "INVALID_REQUEST" }, 400);
  }

  const telefone = telefoneNormalizado(body.telefone);
  const cpfBusca = String(body.cpf || "").replace(/\D/g, "");
  if (!telefone || (cpfBusca.length !== 11 && cpfBusca.length !== 14)) {
    return json({ ok: false, error: "MISSING_FIELDS" }, 400);
  }

  const attempt = await isLoginRateLimited(env, request, `${cpfBusca}:${telefone}`);
  if (attempt.blocked) return json({ error: "TOO_MANY_ATTEMPTS" }, 429, { "Retry-After": "900" });
  await recordFailedLogin(env, attempt.key);

  const db = getDB(env);
  const rawToken = bytesToBase64Url(randomBytes(48));
  const tokenHash = await sha256Base64Url(rawToken);
  const durationSeconds = sessionDurationSeconds(true);
  const expires = new Date(Date.now() + durationSeconds * 1000).toISOString();

  await db.prepare(`
    INSERT INTO guest_sessions(token_hash, guest_id, telefone, cpf_cnpj, expires_at, ip, user_agent)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).bind(tokenHash, telefone, telefone, cpfBusca, expires, getClientIP(request), (request.headers.get("User-Agent") || "").slice(0, 512)).run();

  await audit(env, request, { username: cpfBusca }, "LOGIN", "auth", telefone, null, { role: "cliente_convidado" }, { method: "guest" });

  return json({
    ok: true,
    user: {
      id: telefone,
      displayName: telefone,
      telefone,
      role: "cliente"
    },
    token: rawToken
  }, 200, {
    "Set-Cookie": `${COOKIE_NAME}=${rawToken}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${durationSeconds}`
  });
}

function oauthRedirectUri(env, request) {
  const uri = new URL(String(env.OAUTH_REDIRECT_URI || "/api/auth/oauth/callback"), new URL(request.url).origin);
  if (uri.protocol !== "https:" && uri.hostname !== "localhost" && uri.hostname !== "127.0.0.1") {
    throw new Error("OAUTH_REDIRECT_URI deve usar HTTPS.");
  }
  if (uri.pathname !== "/api/auth/oauth/callback" || uri.search || uri.hash) {
    throw new Error("OAUTH_REDIRECT_URI deve apontar exatamente para /api/auth/oauth/callback.");
  }
  return uri.toString();
}

async function handleOAuthStart(env, request) {
  if (!oauthEnabled(env)) return json({ error: "OAUTH_NOT_CONFIGURED" }, 404);
  const url = new URL(request.url);
  const state = randomBase64Url(32);
  const verifier = randomBase64Url(64);
  const nonce = randomBase64Url(32);
  const stateHash = await oauthSha256Base64Url(state);
  const returnTo = safeReturnPath(url.searchParams.get("return_to"));
  await getDB(env).batch([
    getDB(env).prepare(`DELETE FROM oauth_states WHERE expires_at <= CURRENT_TIMESTAMP`),
    getDB(env).prepare(`
      INSERT INTO oauth_states(state_hash,code_verifier,nonce,return_to,expires_at)
      VALUES (?,?,?,?,datetime('now',?))
    `).bind(stateHash, verifier, nonce, returnTo, `+${OAUTH_STATE_MINUTES} minutes`)
  ]);
  const location = await buildAuthorizationRequest(env, oauthRedirectUri(env, request), state, nonce, verifier);
  return new Response(null, {
    status: 302,
    headers: securityHeaders({
      Location: location,
      "Cache-Control": "no-store",
      "Set-Cookie": `${OAUTH_STATE_COOKIE}=${state}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${OAUTH_STATE_MINUTES * 60}`
    })
  });
}

function oauthFailure(request, code) {
  const location = new URL("/login.html", request.url);
  location.searchParams.set("oauth_error", code);
  return new Response(null, {
    status: 303,
    headers: securityHeaders({
      Location: location.toString(),
      "Cache-Control": "no-store",
      "Set-Cookie": `${OAUTH_STATE_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`
    })
  });
}

function normalizedEmail(claims) {
  const email = String(claims.email || "").trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : "";
}

async function resolveOAuthUser(env, claims) {
  const db = getDB(env);
  const issuer = String(claims.iss);
  const subject = String(claims.sub);
  let user = await db.prepare(`
    SELECT u.id,u.username,u.display_name,u.active,u.must_change_password,r.id role_id,r.name role
    FROM users u JOIN roles r ON r.id=u.role_id
    WHERE u.oauth_issuer=? AND u.oauth_subject=? LIMIT 1
  `).bind(issuer, subject).first();
  if (user) return user;

  const email = normalizedEmail(claims);
  const emailVerified = claims.email_verified === true || claims.email_verified === "true";
  const domains = String(env.OAUTH_ALLOWED_DOMAINS || "").split(",").map(value => value.trim().toLowerCase()).filter(Boolean);
  if (domains.length) {
    const domain = email.split("@")[1] || "";
    if (!emailVerified || !domains.includes(domain)) throw new Error("OAUTH_DOMAIN_NOT_ALLOWED");
  }

  if (email && emailVerified) {
    const matches = (await db.prepare(`
      SELECT u.id,u.username,u.display_name,u.active,u.must_change_password,u.oauth_issuer,u.oauth_subject,
             r.id role_id,r.name role
      FROM users u JOIN roles r ON r.id=u.role_id WHERE lower(u.email)=? LIMIT 2
    `).bind(email).all()).results || [];
    if (matches.length > 1) throw new Error("OAUTH_EMAIL_CONFLICT");
    user = matches[0] || null;
  }

  if (!user && env.OAUTH_ALLOW_USERNAME_LINK === "true") {
    const candidate = String(claims.preferred_username || (email ? email.split("@")[0] : "")).trim();
    if (candidate) {
      user = await db.prepare(`
        SELECT u.id,u.username,u.display_name,u.active,u.must_change_password,u.oauth_issuer,u.oauth_subject,
               r.id role_id,r.name role
        FROM users u JOIN roles r ON r.id=u.role_id WHERE lower(u.username)=lower(?) LIMIT 1
      `).bind(candidate).first();
    }
  }

  if (!user && env.OAUTH_AUTO_PROVISION === "true") {
    if (!email || !emailVerified) throw new Error("OAUTH_VERIFIED_EMAIL_REQUIRED");
    const roleName = String(env.OAUTH_DEFAULT_ROLE || "atendimento");
    const role = await db.prepare(`SELECT id,name FROM roles WHERE name=?`).bind(roleName).first();
    if (!role) throw new Error("OAUTH_DEFAULT_ROLE_INVALID");
    const base = String(claims.preferred_username || email.split("@")[0]).toLowerCase().replace(/[^a-z0-9._-]/g, "").slice(0, 40) || "oauth";
    const username = `${base}-${randomBase64Url(4).toLowerCase()}`;
    const displayName = String(claims.name || email).trim().slice(0, 120);
    const result = await db.prepare(`
      INSERT INTO users(username,display_name,email,oauth_issuer,oauth_subject,password_hash,role_id,active,must_change_password)
      VALUES (?,?,?,?,?,?,?,1,0)
    `).bind(username, displayName, email, issuer, subject, await hashPassword(randomBase64Url(48)), role.id).run();
    user = { id: result.meta.last_row_id, username, display_name: displayName, active: 1, must_change_password: 0, role_id: role.id, role: role.name };
  }

  if (!user) throw new Error("OAUTH_ACCESS_NOT_PROVISIONED");
  if (user.oauth_subject && (user.oauth_subject !== subject || user.oauth_issuer !== issuer)) {
    throw new Error("OAUTH_IDENTITY_CONFLICT");
  }
  await db.prepare(`
    UPDATE users SET email=COALESCE(email,?),oauth_issuer=?,oauth_subject=?,updated_at=CURRENT_TIMESTAMP WHERE id=?
  `).bind(email || null, issuer, subject, user.id).run();
  return user;
}

async function handleOAuthCallback(env, request) {
  if (!oauthEnabled(env)) return oauthFailure(request, "not_configured");
  const url = new URL(request.url);
  const state = url.searchParams.get("state") || "";
  const cookieState = parseCookies(request)[OAUTH_STATE_COOKIE] || "";
  if (!state || !cookieState || !(await constantTimeEqual(state, cookieState))) return oauthFailure(request, "invalid_state");
  const stateHash = await oauthSha256Base64Url(state);
  const saved = await getDB(env).prepare(`
    DELETE FROM oauth_states WHERE state_hash=? AND expires_at>CURRENT_TIMESTAMP
    RETURNING code_verifier,nonce,return_to
  `).bind(stateHash).first();
  if (!saved) return oauthFailure(request, "expired_state");
  if (url.searchParams.get("error")) return oauthFailure(request, "provider_denied");
  const code = url.searchParams.get("code");
  if (!code || code.length > 4096) return oauthFailure(request, "invalid_code");

  try {
    const claims = await exchangeAuthorizationCode(env, code, oauthRedirectUri(env, request), saved.code_verifier, saved.nonce);
    const user = await resolveOAuthUser(env, claims);
    if (!user.active) return oauthFailure(request, "inactive_user");
    await getDB(env).prepare(`UPDATE users SET last_login_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP WHERE id=?`).bind(user.id).run();
    const session = await createSession(env, request, user, "oidc");
    const headers = securityHeaders(new Headers({
      Location: new URL(safeReturnPath(saved.return_to), request.url).toString(),
      "Cache-Control": "no-store"
    }));
    headers.append("Set-Cookie", session.cookie);
    headers.append("Set-Cookie", `${OAUTH_STATE_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`);
    return new Response(null, {
      status: 303,
      headers
    });
  } catch (error) {
    console.error(JSON.stringify({ message: "OAuth callback failed", error: error instanceof Error ? error.message : String(error) }));
    return oauthFailure(request, "login_failed");
  }
}

const SECTOR_CODE = /^[a-z0-9][a-z0-9_-]{1,39}$/;
const COLOR_HEX = /^#[0-9a-f]{6}$/i;
const SECTOR_ICONS = new Set(["user","users","pops","dashboard","bell","finance","topology","calendar","platform","circle"]);

function normalizedSector(body, before = null) {
  const name = String(body.name ?? before?.name ?? "").trim().slice(0,100);
  const rawCode = String(before?.code || body.code || name).trim().toLowerCase();
  const code = rawCode.normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9_-]+/g,"-").replace(/^-+|-+$/g,"").slice(0,40);
  const description = String(body.description ?? before?.description ?? "").trim().slice(0,500);
  const color = COLOR_HEX.test(body.color) ? String(body.color) : (before?.color || "#2563eb");
  const requestedIcon = String(body.icon ?? before?.icon ?? "circle");
  const icon = SECTOR_ICONS.has(requestedIcon) ? requestedIcon : (before?.icon || "circle");
  const requestedSort = Number(body.sort ?? before?.sort ?? 0);
  const sort = Number.isInteger(requestedSort) ? Math.max(0,Math.min(9999,requestedSort)) : Number(before?.sort || 0);
  const active = body.active === undefined ? Number(before?.active ?? 1) : (body.active ? 1 : 0);
  if (!name || !SECTOR_CODE.test(code) || (before?.code === "noc" && !active)) return null;
  return { code,name,description,color,icon,sort,active };
}

async function validSectorScreenIds(db, screenIds) {
  if (!Array.isArray(screenIds)) return true;
  const ids = [...new Set(screenIds.map(Number).filter(Number.isInteger))];
  const existing = new Set(((await db.prepare(`SELECT id FROM screens`).all()).results || []).map(row => Number(row.id)));
  return !ids.some(id => !existing.has(id));
}

async function replaceSectorScreens(db, sectorId, screenIds) {
  if (!Array.isArray(screenIds)) return;
  const ids = [...new Set(screenIds.map(Number).filter(Number.isInteger))];
  await db.batch([
    db.prepare(`UPDATE screens SET sector_id=NULL WHERE sector_id=?`).bind(sectorId),
    ...ids.map(id => db.prepare(`UPDATE screens SET sector_id=? WHERE id=?`).bind(sectorId,id))
  ]);
}

function safeAgendaEvent(row) {
  return {
    id: Number(row.id), owner_type: row.owner_type,
    owner_user_id: row.owner_user_id ? Number(row.owner_user_id) : null,
    sector_id: row.sector_id ? Number(row.sector_id) : null,
    sector_name: row.sector_name || null, sector_color: row.sector_color || null,
    creator_user_id: Number(row.creator_user_id), creator_name: row.creator_name || "",
    title: row.title, description: row.description || "", location: row.location || "",
    start: row.start_at, end: row.end_at, all_day: Boolean(row.all_day),
    alert_email: Boolean(row.alert_email), alert_popup: Boolean(row.alert_popup),
    alert_minutes: Number(row.alert_minutes),
    source: row.source || "updown",
    can_edit: Boolean(row.can_edit)
  };
}

async function agendaSectors(db, userId, all = false) {
  const sql = all ? `
    SELECT s.id,s.code,s.name,s.description,s.color,s.icon,s.sort,s.active,
      (SELECT COUNT(*) FROM user_sectors us WHERE us.sector_id=s.id) AS users
    FROM sectors s ORDER BY s.sort,s.name
  ` : `
    SELECT s.id,s.code,s.name,s.description,s.color,s.icon,s.sort,s.active
    FROM sectors s JOIN user_sectors us ON us.sector_id=s.id
    WHERE us.user_id=? AND s.active=1 ORDER BY s.sort,s.name
  `;
  const result = all ? await db.prepare(sql).all() : await db.prepare(sql).bind(userId).all();
  return result.results || [];
}

function agendaRange(url) {
  const now = new Date();
  const fallbackStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const fallbackEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  const start = new Date(url.searchParams.get("start") || fallbackStart.toISOString());
  const end = new Date(url.searchParams.get("end") || fallbackEnd.toISOString());
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || end <= start
    || end.getTime() - start.getTime() > 400 * 86400000) return null;
  return { start: start.toISOString(), end: end.toISOString() };
}

async function handleAgendaBootstrap(env, request) {
  const gate = await requirePermission(env, request, "agenda.view");
  if (gate.response) return gate.response;
  const range = agendaRange(new URL(request.url));
  if (!range) return json({ error: "PERIODO_INVALIDO" }, 400);
  const db = getDB(env);
  const sectors = await agendaSectors(db, gate.user.id);
  const rows = (await db.prepare(`
    SELECT e.*,s.name sector_name,s.color sector_color,u.display_name creator_name,
      CASE WHEN e.source<>'ics' AND e.owner_type='user' AND e.owner_user_id=? THEN 1
           WHEN e.source<>'ics' AND e.owner_type='sector' AND EXISTS(
             SELECT 1 FROM user_sectors us WHERE us.user_id=? AND us.sector_id=e.sector_id
           ) THEN 1 ELSE 0 END can_edit
    FROM agenda_events e
    LEFT JOIN sectors s ON s.id=e.sector_id
    JOIN users u ON u.id=e.creator_user_id
    WHERE e.start_at < ? AND e.end_at > ?
      AND (e.owner_user_id=? OR EXISTS(
        SELECT 1 FROM user_sectors us WHERE us.user_id=? AND us.sector_id=e.sector_id
      ))
    ORDER BY e.start_at,e.id
  `).bind(gate.user.id, gate.user.id, range.end, range.start, gate.user.id, gate.user.id).all()).results || [];

  const [permissions, importStatus] = await Promise.all([
    permissionsOf(env, gate.user),
    db.prepare(`SELECT COUNT(*) total,MAX(imported_at) last_import_at FROM agenda_events WHERE owner_user_id=? AND source='ics'`)
      .bind(gate.user.id).first()
  ]);
  const events = rows.map(row => ({ ...safeAgendaEvent(row),
    can_edit: Boolean(row.can_edit) && permissions.has("agenda.edit"),
    can_delete: Boolean(row.can_edit) && permissions.has("agenda.delete")
  }));
  return json({
    user: { id: gate.user.id, name: gate.user.display_name, email: gate.user.email || null },
    sectors,
    events,
    import: { total: Number(importStatus?.total || 0), last_import_at: importStatus?.last_import_at || null },
    can: { create: permissions.has("agenda.create"), edit: permissions.has("agenda.edit"), delete: permissions.has("agenda.delete") }
  });
}

async function readCalendarFile(request, maxBytes = 5 * 1024 * 1024) {
  const declared = Number(request.headers.get("Content-Length") || 0);
  if (declared > maxBytes) throw new Error("ARQUIVO_ICS_MUITO_GRANDE");
  const bytes = await request.arrayBuffer();
  if (bytes.byteLength > maxBytes) throw new Error("ARQUIVO_ICS_MUITO_GRANDE");
  return new TextDecoder().decode(bytes);
}

async function handleAgendaIcsImport(env, request) {
  const gate = await requirePermission(env, request, "agenda.view");
  if (gate.response) return gate.response;
  let events;
  try { events = parseIcsCalendar(await readCalendarFile(request)); }
  catch (error) {
    const code = error instanceof Error ? error.message : "ARQUIVO_ICS_INVALIDO";
    return json({ error: code }, code === "ARQUIVO_ICS_MUITO_GRANDE" ? 413 : 400);
  }
  if (!events.length) return json({ error: "ARQUIVO_ICS_SEM_COMPROMISSOS" }, 400);

  const db = getDB(env);
  const importedAt = new Date().toISOString();
  for (let offset = 0; offset < events.length; offset += 100) {
    await db.batch(events.slice(offset, offset + 100).map(event => db.prepare(`
      INSERT INTO agenda_events(owner_type,owner_user_id,sector_id,creator_user_id,title,description,location,
        start_at,end_at,all_day,alert_email,alert_popup,alert_minutes,source,external_uid,imported_at)
      VALUES('user',?,NULL,?,?,?,?,?,?,?,0,1,10,'ics',?,?)
      ON CONFLICT(owner_user_id,external_uid) WHERE source='ics' AND external_uid IS NOT NULL DO UPDATE SET
        title=excluded.title,description=excluded.description,location=excluded.location,
        start_at=excluded.start_at,end_at=excluded.end_at,all_day=excluded.all_day,
        alert_popup=1,alert_minutes=10,imported_at=excluded.imported_at,updated_at=CURRENT_TIMESTAMP
    `).bind(gate.user.id,gate.user.id,event.title.slice(0,300),event.description.slice(0,8000),event.location.slice(0,500),
      event.start_at,event.end_at,event.all_day?1:0,event.external_uid,importedAt)));
  }
  await db.prepare(`DELETE FROM agenda_events WHERE owner_user_id=? AND source='ics' AND imported_at<>?`)
    .bind(gate.user.id, importedAt).run();
  await audit(env,request,gate.user,"AGENDA_ICS_IMPORT","agenda",String(gate.user.id),null,null,{events:events.length});
  return json({ ok: true, imported: events.length, imported_at: importedAt });
}

function normalizedAgendaInput(body, previous = null) {
  const title = String(body.title ?? previous?.title ?? "").trim().slice(0, 300);
  const description = String(body.description ?? previous?.description ?? "").trim().slice(0, 8000);
  const location = String(body.location ?? previous?.location ?? "").trim().slice(0, 500);
  const allDay = Boolean(body.all_day ?? previous?.all_day);
  const start = new Date(body.start ?? previous?.start_at);
  const end = new Date(body.end ?? previous?.end_at);
  const alertMinutes = Number(body.alert_minutes ?? previous?.alert_minutes ?? 10);
  if (!title || !Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || end <= start) return null;
  if (!Number.isInteger(alertMinutes) || alertMinutes < 0 || alertMinutes > 1440) return null;
  return {
    title, description, location, all_day: allDay,
    start_at: start.toISOString(), end_at: end.toISOString(),
    alert_email: false,
    alert_popup: body.alert_popup === undefined ? Boolean(previous?.alert_popup ?? true) : Boolean(body.alert_popup),
    alert_minutes: alertMinutes
  };
}

async function agendaEventForUser(db, userId, id) {
  return db.prepare(`
    SELECT e.* FROM agenda_events e WHERE e.id=? AND (
      e.owner_user_id=? OR EXISTS(
        SELECT 1 FROM user_sectors us WHERE us.user_id=? AND us.sector_id=e.sector_id
      )
    )
  `).bind(id, userId, userId).first();
}

async function handleAgendaEventCreate(env, request) {
  const gate = await requirePermission(env, request, "agenda.create");
  if (gate.response) return gate.response;
  let body; try { body = await readJson(request, 32768); } catch { return json({ error: "INVALID_JSON" }, 400); }
  const event = normalizedAgendaInput(body);
  if (!event) return json({ error: "COMPROMISSO_INVALIDO" }, 400);
  const ownerType = body.owner_type === "sector" ? "sector" : "user";
  const sectorId = ownerType === "sector" ? Number(body.sector_id) : null;
  const db = getDB(env);
  if (ownerType === "sector" && (!Number.isInteger(sectorId) || !(await db.prepare(`
    SELECT 1 FROM user_sectors us JOIN sectors s ON s.id=us.sector_id
    WHERE us.user_id=? AND us.sector_id=? AND s.active=1
  `).bind(gate.user.id, sectorId).first()))) return json({ error: "SETOR_NAO_PERMITIDO" }, 403);

  const result = await db.prepare(`
    INSERT INTO agenda_events(owner_type,owner_user_id,sector_id,creator_user_id,title,description,location,
      start_at,end_at,all_day,alert_email,alert_popup,alert_minutes)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).bind(ownerType, ownerType === "user" ? gate.user.id : null, sectorId, gate.user.id,
    event.title,event.description,event.location,event.start_at,event.end_at,event.all_day?1:0,
    event.alert_email?1:0,event.alert_popup?1:0,event.alert_minutes).run();
  const id = Number(result.meta.last_row_id);
  const after = await agendaEventForUser(db, gate.user.id, id);
  await audit(env,request,gate.user,"AGENDA_EVENT_CREATE","agenda_event",id,null,{...event,owner_type:ownerType,sector_id:sectorId});
  return json(safeAgendaEvent({ ...after, can_edit: 1, creator_name: gate.user.display_name }),201);
}

async function handleAgendaEventUpdate(env, request, id) {
  const gate = await requirePermission(env, request, "agenda.edit");
  if (gate.response) return gate.response;
  const db = getDB(env);
  const before = await agendaEventForUser(db, gate.user.id, id);
  if (!before) return json({ error: "COMPROMISSO_NAO_ENCONTRADO" }, 404);
  if (before.source === "ics") return json({ error: "COMPROMISSO_IMPORTADO_SOMENTE_LEITURA" }, 403);
  let body; try { body = await readJson(request, 32768); } catch { return json({ error: "INVALID_JSON" }, 400); }
  const event = normalizedAgendaInput(body, before);
  if (!event) return json({ error: "COMPROMISSO_INVALIDO" }, 400);
  await db.prepare(`
    UPDATE agenda_events SET title=?,description=?,location=?,start_at=?,end_at=?,all_day=?,alert_email=?,alert_popup=?,
      alert_minutes=?,updated_at=CURRENT_TIMESTAMP WHERE id=?
  `).bind(event.title,event.description,event.location,event.start_at,event.end_at,event.all_day?1:0,event.alert_email?1:0,
    event.alert_popup?1:0,event.alert_minutes,id).run();
  const after = await agendaEventForUser(db, gate.user.id, id);
  await audit(env,request,gate.user,"AGENDA_EVENT_UPDATE","agenda_event",id,safeAgendaEvent({...before,can_edit:1}),safeAgendaEvent({...after,can_edit:1}));
  return json(safeAgendaEvent({ ...after, can_edit: 1, creator_name: gate.user.display_name }));
}

async function handleAgendaEventDelete(env, request, id) {
  const gate = await requirePermission(env, request, "agenda.delete");
  if (gate.response) return gate.response;
  const db = getDB(env);
  const before = await agendaEventForUser(db, gate.user.id, id);
  if (!before) return json({ error: "COMPROMISSO_NAO_ENCONTRADO" }, 404);
  if (before.source === "ics") return json({ error: "COMPROMISSO_IMPORTADO_SOMENTE_LEITURA" }, 403);
  await db.prepare(`DELETE FROM agenda_events WHERE id=?`).bind(id).run();
  await audit(env,request,gate.user,"AGENDA_EVENT_DELETE","agenda_event",id,safeAgendaEvent({...before,can_edit:1}),null);
  return json({ ok: true });
}

async function handleSectors(env, request) {
  const gate = await requirePermission(env, request, "sectors.manage");
  if (gate.response) return gate.response;
  const db = getDB(env);
  if (request.method === "GET") return json(await agendaSectors(db, gate.user.id, true));
  let body; try { body = await readJson(request, 16384); } catch { return json({ error: "INVALID_JSON" }, 400); }
  const sectorInput = normalizedSector(body);
  if (!sectorInput) return json({ error: "SETOR_INVALIDO" }, 400);
  if (!(await validSectorScreenIds(db,body.screen_ids))) return json({ error: "TELA_INVALIDA" },400);
  try {
    const result = await db.prepare(`
      INSERT INTO sectors(code,name,description,color,icon,sort,active) VALUES(?,?,?,?,?,?,?)
    `).bind(sectorInput.code,sectorInput.name,sectorInput.description,sectorInput.color,
      sectorInput.icon,sectorInput.sort,sectorInput.active).run();
    await replaceSectorScreens(db,Number(result.meta.last_row_id),body.screen_ids);
    const sector = await db.prepare(`SELECT id,code,name,description,color,icon,sort,active FROM sectors WHERE id=?`)
      .bind(result.meta.last_row_id).first();
    sector.screen_ids = Array.isArray(body.screen_ids) ? body.screen_ids.map(Number) : [];
    await audit(env,request,gate.user,"SECTOR_CREATE","sector",sector.id,null,sector);
    return json(sector,201);
  } catch { return json({ error: "SETOR_JA_EXISTE" }, 409); }
}

async function handleSectorUpdate(env, request, id) {
  const gate = await requirePermission(env, request, "sectors.manage");
  if (gate.response) return gate.response;
  const db = getDB(env);
  const before = await db.prepare(`
    SELECT id,code,name,description,color,icon,sort,active FROM sectors WHERE id=?
  `).bind(id).first();
  if (!before) return json({ error: "SETOR_NAO_ENCONTRADO" },404);
  before.screen_ids = ((await db.prepare(`SELECT id FROM screens WHERE sector_id=? ORDER BY sort,id`).bind(id).all()).results || [])
    .map(row => Number(row.id));
  let body; try { body = await readJson(request,16384); } catch { return json({ error: "INVALID_JSON" },400); }
  const sectorInput = normalizedSector(body,before);
  if (!sectorInput) return json({ error: "SETOR_INVALIDO" },400);
  if (!(await validSectorScreenIds(db,body.screen_ids))) return json({ error: "TELA_INVALIDA" },400);
  try {
    const statements = [db.prepare(`
        UPDATE sectors SET name=?,description=?,color=?,icon=?,sort=?,active=?,updated_at=CURRENT_TIMESTAMP WHERE id=?
      `).bind(sectorInput.name,sectorInput.description,sectorInput.color,sectorInput.icon,
        sectorInput.sort,sectorInput.active,id)];
    if (Array.isArray(body.screen_ids)) {
      const ids = [...new Set(body.screen_ids.map(Number).filter(Number.isInteger))];
      statements.push(
        db.prepare(`UPDATE screens SET sector_id=NULL WHERE sector_id=?`).bind(id),
        ...ids.map(screenId => db.prepare(`UPDATE screens SET sector_id=? WHERE id=?`).bind(id,screenId))
      );
    }
    await db.batch(statements);
    const after = await db.prepare(`
      SELECT id,code,name,description,color,icon,sort,active FROM sectors WHERE id=?
    `).bind(id).first();
    after.screen_ids = ((await db.prepare(`SELECT id FROM screens WHERE sector_id=? ORDER BY sort,id`).bind(id).all()).results || [])
      .map(row => Number(row.id));
    await audit(env,request,gate.user,"SECTOR_UPDATE","sector",id,before,after);
    return json(after);
  } catch { return json({ error: "SETOR_JA_EXISTE" },409); }
}

/* ---------------- CRM dividido por setor ---------------- */
const CRM_STAGE_TEMPLATES = {
  comercial: [["lead","Lead","#8b5cf6",10,0,0],["qualificacao","Qualificação","#06b6d4",20,0,0],["proposta","Proposta","#f59e0b",30,0,0],["negociacao","Negociação","#2563eb",40,0,0],["ganho","Ganho","#22c55e",50,1,1],["perdido","Perdido","#ef4444",60,1,0]],
  atendimento: [["novo","Novo","#06b6d4",10,0,0],["atendimento","Em atendimento","#2563eb",20,0,0],["aguardando","Aguardando cliente","#f59e0b",30,0,0],["resolvido","Resolvido","#22c55e",40,1,1]],
  logistica: [["pendente","Pendente","#f59e0b",10,0,0],["separacao","Em separação","#8b5cf6",20,0,0],["rota","Em rota","#2563eb",30,0,0],["entregue","Entregue","#22c55e",40,1,1]],
  sac: [["novo","Novo","#ec4899",10,0,0],["analise","Em análise","#8b5cf6",20,0,0],["retorno","Aguardando retorno","#f59e0b",30,0,0],["resolvido","Resolvido","#22c55e",40,1,1]],
  financeiro: [["pendente","Pendente","#ef4444",10,0,0],["negociacao","Em negociação","#f59e0b",20,0,0],["pagamento","Aguardando pagamento","#2563eb",30,0,0],["quitado","Quitado","#22c55e",40,1,1]],
  noc: [["aberto","Aberto","#ef4444",10,0,0],["diagnostico","Diagnóstico","#f59e0b",20,0,0],["execucao","Em execução","#2563eb",30,0,0],["monitoramento","Monitoramento","#8b5cf6",40,0,0],["resolvido","Resolvido","#22c55e",50,1,1]],
  default: [["novo","Novo","#06b6d4",10,0,0],["andamento","Em andamento","#2563eb",20,0,0],["aguardando","Aguardando","#f59e0b",30,0,0],["concluido","Concluído","#22c55e",40,1,1]]
};

async function crmAccessibleSectors(db, user) {
  if (user.role === "administrador") return (await db.prepare(`
    SELECT id,code,name,color,icon,sort FROM sectors WHERE active=1 ORDER BY sort,name
  `).all()).results || [];
  return (await db.prepare(`
    SELECT s.id,s.code,s.name,s.color,s.icon,s.sort FROM sectors s
    JOIN user_sectors us ON us.sector_id=s.id
    WHERE us.user_id=? AND s.active=1 ORDER BY s.sort,s.name
  `).bind(user.id).all()).results || [];
}

async function ensureCrmStages(db, sectors) {
  const statements = [];
  for (const sector of sectors) {
    const template = CRM_STAGE_TEMPLATES[sector.code] || CRM_STAGE_TEMPLATES.default;
    for (const [code,name,color,sort,isClosed,isWon] of template) statements.push(db.prepare(`
      INSERT OR IGNORE INTO crm_stages(sector_id,code,name,color,sort,is_closed,is_won,active)
      VALUES(?,?,?,?,?,?,?,1)
    `).bind(sector.id,code,name,color,sort,isClosed,isWon));
  }
  if (statements.length) await db.batch(statements);
}

function crmSectorIds(sectors) {
  return sectors.map(s => Number(s.id)).filter(Number.isInteger);
}

function normalizedCrmInput(body, previous = null) {
  const text = (key, max) => String(body[key] ?? previous?.[key] ?? "").trim().slice(0,max);
  const title = text("title",300), customerName = text("customer_name",300);
  const priority = String(body.priority ?? previous?.priority ?? "normal");
  const sectorId = Number(body.sector_id ?? previous?.sector_id);
  const stageId = Number(body.stage_id ?? previous?.stage_id);
  const rawAssignee = body.assigned_user_id === undefined ? previous?.assigned_user_id : body.assigned_user_id;
  const assignedUserId = rawAssignee == null || rawAssignee === "" ? null : Number(rawAssignee);
  const value = Number(body.estimated_value ?? previous?.estimated_value ?? 0);
  const rawNext = body.next_contact_at === undefined ? previous?.next_contact_at : body.next_contact_at;
  let nextContactAt = null;
  if (rawNext) {
    const date = new Date(rawNext);
    if (!Number.isFinite(date.getTime())) return null;
    nextContactAt = date.toISOString();
  }
  if (!title || !customerName || !Number.isInteger(sectorId) || !Number.isInteger(stageId) ||
      (assignedUserId != null && !Number.isInteger(assignedUserId)) ||
      !["low","normal","high","urgent"].includes(priority) || !Number.isFinite(value) || value < 0) return null;
  const tagsSource = body.tags === undefined ? previous?.tags : body.tags;
  const tags = (Array.isArray(tagsSource) ? tagsSource.join(",") : String(tagsSource || ""))
    .split(",").map(x => x.trim()).filter(Boolean).slice(0,20).join(", ").slice(0,500);
  return {
    sector_id:sectorId, stage_id:stageId, assigned_user_id:assignedUserId,
    title, customer_name:customerName, customer_document:text("customer_document",40),
    phone:text("phone",60), email:text("email",320), city:text("city",160), address:text("address",500),
    source:text("source",160), priority, estimated_value:value, next_contact_at:nextContactAt,
    details:text("details",12000), tags
  };
}

async function validateCrmRelations(db, input, allowedSectorIds) {
  if (!allowedSectorIds.includes(input.sector_id)) return "SETOR_NAO_PERMITIDO";
  const stage = await db.prepare(`SELECT id,is_closed,is_won,name FROM crm_stages WHERE id=? AND sector_id=? AND active=1`)
    .bind(input.stage_id,input.sector_id).first();
  if (!stage) return "ETAPA_INVALIDA";
  if (input.assigned_user_id != null && !(await db.prepare(`
    SELECT 1 FROM users u JOIN user_sectors us ON us.user_id=u.id
    WHERE u.id=? AND us.sector_id=? AND u.active=1
  `).bind(input.assigned_user_id,input.sector_id).first())) return "RESPONSAVEL_INVALIDO";
  return stage;
}

async function crmCaseForUser(db, user, id) {
  const visibility = user.role === "administrador" ? "1=1" : `EXISTS(
    SELECT 1 FROM user_sectors visible WHERE visible.user_id=? AND visible.sector_id=c.sector_id
  )`;
  const statement = db.prepare(`
    SELECT c.*,s.name sector_name,s.color sector_color,st.name stage_name,st.color stage_color,
      st.is_closed,st.is_won,u.display_name assigned_name,creator.display_name creator_name
    FROM crm_cases c JOIN sectors s ON s.id=c.sector_id JOIN crm_stages st ON st.id=c.stage_id
    LEFT JOIN users u ON u.id=c.assigned_user_id JOIN users creator ON creator.id=c.creator_user_id
    WHERE c.id=? AND ${visibility}
  `);
  return user.role === "administrador" ? statement.bind(id).first() : statement.bind(id,user.id).first();
}

async function handleCrm(env, request) {
  const gate = await requirePermission(env,request,"crm.view");
  if (gate.response) return gate.response;
  const db = getDB(env), sectors = await crmAccessibleSectors(db,gate.user);
  await ensureCrmStages(db,sectors);
  const ids = crmSectorIds(sectors);
  if (!ids.length) return json({ sectors:[],stages:[],users:[],cases:[],can:{
    create:false,edit:false,interact:false,delete:false
  }});
  const placeholders = ids.map(() => "?").join(",");
  const [stagesResult,usersResult,casesResult,permissions] = await Promise.all([
    db.prepare(`SELECT id,sector_id,code,name,color,sort,is_closed,is_won FROM crm_stages WHERE active=1 AND sector_id IN (${placeholders}) ORDER BY sector_id,sort,id`).bind(...ids).all(),
    db.prepare(`SELECT DISTINCT u.id,u.display_name,us.sector_id FROM users u JOIN user_sectors us ON us.user_id=u.id WHERE u.active=1 AND us.sector_id IN (${placeholders}) ORDER BY u.display_name`).bind(...ids).all(),
    db.prepare(`
      SELECT c.*,s.name sector_name,s.color sector_color,st.name stage_name,st.color stage_color,
        st.is_closed,st.is_won,u.display_name assigned_name,
        (SELECT MAX(a.created_at) FROM crm_activities a WHERE a.case_id=c.id) last_activity_at
      FROM crm_cases c JOIN sectors s ON s.id=c.sector_id JOIN crm_stages st ON st.id=c.stage_id
      LEFT JOIN users u ON u.id=c.assigned_user_id
      WHERE c.sector_id IN (${placeholders}) ORDER BY st.is_closed,c.updated_at DESC LIMIT 1000
    `).bind(...ids).all(),
    permissionsOf(env,gate.user)
  ]);
  return json({ sectors,stages:stagesResult.results||[],users:usersResult.results||[],cases:casesResult.results||[],
    can:{create:permissions.has("crm.create"),edit:permissions.has("crm.edit"),interact:permissions.has("crm.interact"),delete:permissions.has("crm.delete")} });
}

async function handleCrmCaseGet(env, request, id) {
  const gate = await requirePermission(env,request,"crm.view");
  if (gate.response) return gate.response;
  const db=getDB(env), item=await crmCaseForUser(db,gate.user,id);
  if (!item) return json({error:"REGISTRO_CRM_NAO_ENCONTRADO"},404);
  const activities=(await db.prepare(`
    SELECT a.id,a.kind,a.body,a.created_at,u.display_name user_name FROM crm_activities a
    JOIN users u ON u.id=a.user_id WHERE a.case_id=? ORDER BY a.created_at DESC,a.id DESC LIMIT 300
  `).bind(id).all()).results||[];
  return json({case:item,activities});
}

async function handleCrmCaseCreate(env, request) {
  const gate=await requirePermission(env,request,"crm.create");
  if(gate.response)return gate.response;
  let body;try{body=await readJson(request,65536)}catch{return json({error:"INVALID_JSON"},400)}
  const input=normalizedCrmInput(body); if(!input)return json({error:"REGISTRO_CRM_INVALIDO"},400);
  const db=getDB(env),sectors=await crmAccessibleSectors(db,gate.user); await ensureCrmStages(db,sectors);
  const relation=await validateCrmRelations(db,input,crmSectorIds(sectors));
  if(typeof relation==="string")return json({error:relation},relation==="SETOR_NAO_PERMITIDO"?403:400);
  const result=await db.prepare(`
    INSERT INTO crm_cases(sector_id,stage_id,assigned_user_id,creator_user_id,title,customer_name,customer_document,
      phone,email,city,address,source,priority,estimated_value,next_contact_at,details,tags,closed_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).bind(input.sector_id,input.stage_id,input.assigned_user_id,gate.user.id,input.title,input.customer_name,
    input.customer_document,input.phone,input.email,input.city,input.address,input.source,input.priority,
    input.estimated_value,input.next_contact_at,input.details,input.tags,relation.is_closed?new Date().toISOString():null).run();
  const id=Number(result.meta.last_row_id);
  await db.prepare(`INSERT INTO crm_activities(case_id,user_id,kind,body) VALUES(?,?,?,?)`)
    .bind(id,gate.user.id,"system",`Registro criado na etapa ${relation.name}.`).run();
  const after=await crmCaseForUser(db,gate.user,id);
  await audit(env,request,gate.user,"CRM_CASE_CREATE","crm_case",id,null,after);
  return json(after,201);
}

async function handleCrmCaseUpdate(env, request, id) {
  const gate=await requirePermission(env,request,"crm.edit"); if(gate.response)return gate.response;
  const db=getDB(env),before=await crmCaseForUser(db,gate.user,id);
  if(!before)return json({error:"REGISTRO_CRM_NAO_ENCONTRADO"},404);
  let body;try{body=await readJson(request,65536)}catch{return json({error:"INVALID_JSON"},400)}
  const input=normalizedCrmInput(body,before); if(!input)return json({error:"REGISTRO_CRM_INVALIDO"},400);
  const sectors=await crmAccessibleSectors(db,gate.user); await ensureCrmStages(db,sectors);
  const relation=await validateCrmRelations(db,input,crmSectorIds(sectors));
  if(typeof relation==="string")return json({error:relation},relation==="SETOR_NAO_PERMITIDO"?403:400);
  await db.prepare(`
    UPDATE crm_cases SET sector_id=?,stage_id=?,assigned_user_id=?,title=?,customer_name=?,customer_document=?,phone=?,
      email=?,city=?,address=?,source=?,priority=?,estimated_value=?,next_contact_at=?,details=?,tags=?,closed_at=?,updated_at=CURRENT_TIMESTAMP WHERE id=?
  `).bind(input.sector_id,input.stage_id,input.assigned_user_id,input.title,input.customer_name,input.customer_document,
    input.phone,input.email,input.city,input.address,input.source,input.priority,input.estimated_value,input.next_contact_at,
    input.details,input.tags,relation.is_closed?(before.closed_at||new Date().toISOString()):null,id).run();
  if(Number(before.stage_id)!==input.stage_id)await db.prepare(`INSERT INTO crm_activities(case_id,user_id,kind,body) VALUES(?,?,?,?)`)
    .bind(id,gate.user.id,"status",`Etapa alterada de ${before.stage_name} para ${relation.name}.`).run();
  const after=await crmCaseForUser(db,gate.user,id);
  await audit(env,request,gate.user,"CRM_CASE_UPDATE","crm_case",id,before,after);
  return json(after);
}

async function handleCrmActivityCreate(env, request, id) {
  const gate=await requirePermission(env,request,"crm.interact"); if(gate.response)return gate.response;
  const db=getDB(env),item=await crmCaseForUser(db,gate.user,id);
  if(!item)return json({error:"REGISTRO_CRM_NAO_ENCONTRADO"},404);
  let body;try{body=await readJson(request,32768)}catch{return json({error:"INVALID_JSON"},400)}
  const kind=String(body.kind||"note"),content=String(body.body||"").trim().slice(0,8000);
  if(!["note","call","whatsapp","email","meeting"].includes(kind)||!content)return json({error:"INTERACAO_INVALIDA"},400);
  const result=await db.prepare(`INSERT INTO crm_activities(case_id,user_id,kind,body) VALUES(?,?,?,?)`)
    .bind(id,gate.user.id,kind,content).run();
  await db.prepare(`UPDATE crm_cases SET updated_at=CURRENT_TIMESTAMP WHERE id=?`).bind(id).run();
  const activity=await db.prepare(`SELECT a.id,a.kind,a.body,a.created_at,u.display_name user_name FROM crm_activities a JOIN users u ON u.id=a.user_id WHERE a.id=?`)
    .bind(result.meta.last_row_id).first();
  await audit(env,request,gate.user,"CRM_ACTIVITY_CREATE","crm_activity",result.meta.last_row_id,null,activity,{case_id:id});
  return json(activity,201);
}

async function handleCrmCaseDelete(env, request, id) {
  const gate=await requirePermission(env,request,"crm.delete"); if(gate.response)return gate.response;
  const db=getDB(env),before=await crmCaseForUser(db,gate.user,id);
  if(!before)return json({error:"REGISTRO_CRM_NAO_ENCONTRADO"},404);
  await db.prepare(`DELETE FROM crm_cases WHERE id=?`).bind(id).run();
  await audit(env,request,gate.user,"CRM_CASE_DELETE","crm_case",id,before,null);
  return json({ok:true});
}

/* ============ WhatsApp Cloud API (Meta) ============
   Atendimento ao cliente por WhatsApp. O número é único e o bot pergunta ao
   cliente em qual setor ele precisa de atendimento; a conversa é então
   roteada para a fila do setor escolhido. O atendente "pega" a conversa e
   fica em atendimento até encerrá-la; quem tem whatsapp.supervise enxerga
   com quem cada colega está conversando, os demais veem apenas o status. */

const WHATSAPP_GRAPH_VERSION = "v21.0";
const WHATSAPP_SETTINGS_KEY = "whatsapp.settings";
const WHATSAPP_ROUTING_MAX_ATTEMPTS = 3;

async function waSectors(db, user) {
  if (user.role === "administrador") return (await db.prepare(`
    SELECT id,code,name,color,icon,sort FROM sectors WHERE active=1 ORDER BY sort,name
  `).all()).results || [];
  return (await db.prepare(`
    SELECT s.id,s.code,s.name,s.color,s.icon,s.sort FROM sectors s
    JOIN user_sectors us ON us.sector_id=s.id
    WHERE us.user_id=? AND s.active=1 ORDER BY s.sort,s.name
  `).bind(user.id).all()).results || [];
}

async function defaultWhatsappSettings(db) {
  const sectors = (await db.prepare(`SELECT code FROM sectors WHERE active=1 ORDER BY sort,name`).all()).results || [];
  return {
    greeting: "Olá! Aqui é a UPDOWN Telecom. Para agilizar seu atendimento, escolha uma das opções:",
    routingError: "Não consegui entender sua opção. Envie apenas o número correspondente ao setor desejado.",
    routingDone: "Seu atendimento foi direcionado para {setor}. Em instantes um atendente responde por aqui.",
    closedMessage: "Esta conversa foi encerrada. Se precisar de algo novo, é só chamar.",
    routedSectors: sectors.filter(s => s.code !== "noc").map(s => s.code)
  };
}

async function loadWhatsappSettings(db) {
  const row = await db.prepare(`SELECT value FROM platform_meta WHERE key=?`).bind(WHATSAPP_SETTINGS_KEY).first();
  if (row?.value) {
    try { return { ...(await defaultWhatsappSettings(db)), ...JSON.parse(row.value) }; } catch {}
  }
  return defaultWhatsappSettings(db);
}

async function normalizeWhatsappSettings(db, body, previous = {}) {
  const defaults = await defaultWhatsappSettings(db);
  const text = (key, max) => {
    const value = body[key] === undefined ? previous[key] : body[key];
    return String(value ?? "").trim().slice(0, max);
  };
  const greeting = text("greeting", 600) || defaults.greeting;
  const routingError = text("routingError", 300) || defaults.routingError;
  const routingDone = text("routingDone", 300) || defaults.routingDone;
  const closedMessage = text("closedMessage", 300) || defaults.closedMessage;
  let routedSectors = body.routedSectors === undefined ? (previous.routedSectors || defaults.routedSectors) : body.routedSectors;
  if (!Array.isArray(routedSectors)) routedSectors = defaults.routedSectors;
  const valid = new Set((await db.prepare(`SELECT code FROM sectors WHERE active=1`).all()).results.map(r => r.code));
  routedSectors = routedSectors.filter(c => valid.has(c) && c !== "noc").slice(0, 30);
  if (!routedSectors.length) routedSectors = defaults.routedSectors;
  return { greeting, routingError, routingDone, closedMessage, routedSectors };
}

async function waRoutedSectorOptions(db, settings) {
  const codes = new Set(settings.routedSectors || []);
  const rows = (await db.prepare(`SELECT id,code,name FROM sectors WHERE active=1 ORDER BY sort,name`).all()).results || [];
  return rows.filter(s => codes.has(s.code)).map((s, i) => ({ ...s, number: i + 1 }));
}

function waMatchSector(settings, options, raw) {
  const text = String(raw || "").trim().toLowerCase();
  if (!text) return null;
  if (/^\d+$/.test(text)) {
    const n = Number(text);
    return options.find(o => o.number === n) || null;
  }
  const norm = v => String(v).toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]/g, "");
  const needle = norm(text);
  if (!needle) return null;
  return options.find(o => norm(o.name).includes(needle) || norm(o.code) === needle || needle.includes(norm(o.code))) || null;
}

function waMessageText(msg) {
  if (msg.type === "text") return String(msg.text?.body || "").trim();
  if (msg.type === "interactive") {
    const it = msg.interactive || {};
    if (it.type === "button_reply") return String(it.button_reply?.title || "").trim();
    if (it.type === "list_reply") return String(it.list_reply?.title || "").trim();
    return "";
  }
  const labels = { image: "imagem", audio: "áudio", video: "vídeo", document: "documento", sticker: "figurinha", location: "localização", contact: "contato", reaction: "reação", button: "botão", template: "modelo" };
  return `[${labels[msg.type] || msg.type}]`;
}

async function hmacSha256Hex(secret, data) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
  return [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, "0")).join("");
}

// Envio pela Graph API da Meta. Sem WHATSAPP_ACCESS_TOKEN / PHONE_NUMBER_ID
// configurados o envio falha de forma explícita, sem derrubar o webhook.
async function waSendText(env, to, body) {
  const token = env.WHATSAPP_ACCESS_TOKEN, phoneId = env.WHATSAPP_PHONE_NUMBER_ID;
  if (!token || !phoneId) return { ok: false, error: "WHATSAPP_NAO_CONFIGURADO" };
  const res = await fetch(`https://graph.facebook.com/${WHATSAPP_GRAPH_VERSION}/${phoneId}/messages`, {
    method: "POST",
    headers: { "Authorization": `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ messaging_product: "whatsapp", recipient_type: "individual", to, type: "text", text: { body } })
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    return { ok: false, error: "WHATSAPP_ENVIO_FALHOU", status: res.status, detail: detail.slice(0, 400) };
  }
  const data = await res.json().catch(() => ({}));
  return { ok: true, wa_message_id: data?.messages?.[0]?.id || null };
}

async function waStoreBotMessage(db, conversationId, body, waMessageId, ok) {
  await db.prepare(`INSERT INTO wa_messages(conversation_id,direction,type,body,wa_message_id,status,sender_name) VALUES(?,?,?,?,?,?,?)`)
    .bind(conversationId, "bot", "text", body, waMessageId || null, ok ? "sent" : "failed", "Sistema").run();
}

// Envio pela API do Opa!Suite, usado pelas conversas dos canais externos
// (Meta via Opa!Suite e Webchat do Opa!Suite). A rota /recebemensagem foi
// confirmada pelo suporte do Opa!Suite ("Manuel"), mas nomes de campo do
// corpo e formato exato de retorno não foram — o suporte só disse "token de
// autenticação", sem especificar header vs. campo do corpo. Mandamos como
// Authorization: Bearer (padrão já usado nas outras integrações deste
// arquivo) por ser a opção mais comum; se o primeiro envio real voltar 401/403,
// o `detail` abaixo captura a resposta crua do Opa!Suite para ajustar aqui.
const OPASUITE_API_BASE_DEFAULT = "https://api.opasuite.com.br";

async function oaSendText(env, externalId, body) {
  const token = env.OPASUITE_API_TOKEN;
  if (!token || !externalId) return { ok: false, error: "OPASUITE_NAO_CONFIGURADO" };
  const base = env.OPASUITE_API_BASE || OPASUITE_API_BASE_DEFAULT;
  try {
    const res = await fetch(`${base}/recebemensagem`, {
      method: "POST",
      headers: { "Authorization": `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ conversation_id: externalId, type: "text", text: body })
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      return { ok: false, error: "OPASUITE_ENVIO_FALHOU", status: res.status, detail: detail.slice(0, 400) };
    }
    const data = await res.json().catch(() => ({}));
    return { ok: true, wa_message_id: data?.id || data?.message_id || null };
  } catch (e) {
    return { ok: false, error: "OPASUITE_ENVIO_FALHOU", detail: String(e?.message || e).slice(0, 400) };
  }
}

// Ponto único de envio: despacha para a Graph API da Meta (canal nativo) ou
// para o Opa!Suite (Meta via Opa!Suite / Webchat), conforme a conversa.
async function omniSendText(env, target, body) {
  if (!target || target.channel === "whatsapp" || !target.channel) return await waSendText(env, target?.phone, body);
  return await oaSendText(env, target.external_id || target.phone, body);
}

async function waSendRoutingMenu(env, db, settings, conversationId, target, attempts) {
  const options = await waRoutedSectorOptions(db, settings);
  if (!options.length) return;
  const menu = `${settings.greeting}\n\n${options.map(o => `${o.number} - ${o.name}`).join("\n")}`;
  const send = await omniSendText(env, target, menu);
  await waStoreBotMessage(db, conversationId, menu, send.wa_message_id, send.ok);
  await db.prepare(`UPDATE wa_conversations SET routing_attempts=?,updated_at=CURRENT_TIMESTAMP WHERE id=?`).bind(attempts, conversationId).run();
}

async function waVerifySignature(env, request, raw) {
  const secret = env.WHATSAPP_APP_SECRET;
  if (!secret) return true;
  const signature = request.headers.get("X-Hub-Signature-256") || "";
  const expected = "sha256=" + (await hmacSha256Hex(secret, raw));
  return timingSafeEqual(signature, expected);
}

// params: { channel, phone, externalId, contactName, type, body, externalMessageId }
// Um único funil de roteamento para qualquer canal — nativo (Meta direto) ou
// externo (Opa!Suite Meta / Opa!Suite Webchat) — todos caem na mesma fila de
// setor e no mesmo painel. 'phone' é a chave de identidade dentro do canal
// (no Webchat, sem telefone, cai para o externalId da conversa/visitante).
async function waHandleInboundGeneric(env, db, settings, params) {
  const channel = String(params.channel || "whatsapp");
  const phone = String(params.phone || params.externalId || "");
  if (!phone) return;
  const externalId = String(params.externalId || phone);
  const waId = String(params.externalMessageId || "");
  if (waId && await db.prepare(`SELECT 1 FROM wa_messages WHERE wa_message_id=?`).bind(waId).first()) return;
  const type = String(params.type || "text");
  const body = String(params.body || "");
  const contactName = String(params.contactName || "").trim().slice(0, 200);
  if (contactName) await db.prepare(`INSERT OR IGNORE INTO wa_contacts(phone,name) VALUES(?,?)`).bind(phone, contactName).run();

  const conv = await db.prepare(`SELECT * FROM wa_conversations WHERE phone=? AND channel=? ORDER BY id DESC LIMIT 1`).bind(phone, channel).first();
  if (!conv) {
    const res = await db.prepare(`
      INSERT INTO wa_conversations(phone,customer_name,channel,external_id,status,last_message,last_message_at,updated_at)
      VALUES(?,?,?,?,?,?,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)
    `).bind(phone, contactName || phone, channel, externalId, "routing", body).run();
    const conversationId = Number(res.meta.last_row_id);
    await db.prepare(`INSERT INTO wa_messages(conversation_id,direction,type,body,wa_message_id) VALUES(?,?,?,?,?)`)
      .bind(conversationId, "in", type, body, waId || null).run();
    await waSendRoutingMenu(env, db, settings, conversationId, { channel, phone, external_id: externalId }, 1);
    return;
  }

  await db.prepare(`INSERT INTO wa_messages(conversation_id,direction,type,body,wa_message_id) VALUES(?,?,?,?,?)`)
    .bind(conv.id, "in", type, body, waId || null).run();

  if (conv.status === "closed") {
    await db.prepare(`
      UPDATE wa_conversations SET status='routing',routing_attempts=0,closed_at=NULL,closed_by=NULL,
        last_message=?,last_message_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP WHERE id=?
    `).bind(body, conv.id).run();
    await waSendRoutingMenu(env, db, settings, conv.id, conv, 1);
    return;
  }

  if (conv.status === "routing") {
    const options = await waRoutedSectorOptions(db, settings);
    const target = waMatchSector(settings, options, body);
    if (target) {
      await db.prepare(`
        UPDATE wa_conversations SET sector_id=?,status='open',routing_attempts=0,unread=0,
          last_message=?,last_message_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP WHERE id=?
      `).bind(target.id, body, conv.id).run();
      const confirm = (settings.routingDone || "").replace("{setor}", target.name);
      const send = await omniSendText(env, conv, confirm);
      await waStoreBotMessage(db, conv.id, confirm, send.wa_message_id, send.ok);
    } else if (Number(conv.routing_attempts) < WHATSAPP_ROUTING_MAX_ATTEMPTS) {
      const send = await omniSendText(env, conv, settings.routingError);
      await waStoreBotMessage(db, conv.id, settings.routingError, send.wa_message_id, send.ok);
      await waSendRoutingMenu(env, db, settings, conv.id, conv, Number(conv.routing_attempts) + 1);
      await db.prepare(`UPDATE wa_conversations SET last_message=?,last_message_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP WHERE id=?`).bind(body, conv.id).run();
    } else {
      await db.prepare(`UPDATE wa_conversations SET last_message=?,last_message_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP WHERE id=?`).bind(body, conv.id).run();
    }
    return;
  }

  await db.prepare(`
    UPDATE wa_conversations SET last_message=?,last_message_at=CURRENT_TIMESTAMP,unread=unread+1,updated_at=CURRENT_TIMESTAMP WHERE id=?
  `).bind(body, conv.id).run();
}

function waMetaToGeneric(msg, value) {
  return {
    channel: "whatsapp",
    phone: String(msg.from || ""),
    externalId: String(msg.from || ""),
    contactName: String((value.contacts || [])[0]?.profile?.name || "").trim().slice(0, 200),
    type: String(msg.type || "text"),
    body: waMessageText(msg),
    externalMessageId: String(msg.id || "")
  };
}

// Formato do webhook do Opa!Suite ainda não confirmado (a documentação
// pública exige login) — tenta os nomes de campo mais comuns entre CRMs de
// atendimento. O payload bruto sempre fica em wa_webhook_log; se o primeiro
// evento real não cair certo aqui, ajuste este parser olhando o log em
// GET /api/whatsapp/webhook-log em vez de adivinhar de novo.
function oaExtractMessage(payload) {
  const p = payload || {};
  const data = p.data || p.message || p.payload || p;
  const channelRaw = String(p.channel || p.canal || p.origin || data.channel || data.canal || "").toLowerCase();
  const channel = channelRaw.includes("webchat") || channelRaw.includes("chat") ? "opasuite_webchat" : "opasuite_meta";
  const contact = data.contact || data.customer || {};
  const externalId = String(data.conversation_id || data.chat_id || data.conversationId || p.conversation_id || data.contact_id || contact.id || "").trim();
  const phone = String(data.phone || data.from || contact.phone || contact.number || "").replace(/\D/g, "").slice(0, 15);
  const contactName = String(data.contact_name || contact.name || data.name || "").trim().slice(0, 200);
  const typeRaw = String(data.type || "text").toLowerCase();
  // Mensagem de imagem: nome do campo com a URL da mídia também não está
  // confirmado com a doc oficial — mesma ressalva do resto deste parser.
  // messageToCamel/Message.isImage (app) só olham `type`, então qualquer URL
  // aqui já renderiza como imagem; se vier campo diferente, ajustar só isto.
  const isImage = typeRaw.includes("image") || typeRaw.includes("imagem") || typeRaw === "photo";
  const body = isImage
    ? String(data.url || data.media_url || data.image_url || data.file_url || data.text || data.body || "").trim()
    : String(data.text || data.body || data.message || data.content || "").trim();
  const externalMessageId = String(data.id || data.message_id || data.messageId || "").trim();
  const type = isImage ? "image" : "text";
  return { channel, phone, externalId, contactName, body, externalMessageId, type };
}

async function oaVerifyToken(env, request, url) {
  const secret = env.OPASUITE_WEBHOOK_SECRET;
  if (!secret) return true; // ainda sem segredo configurado — aceita para permitir o primeiro teste
  const token = request.headers.get("X-Opasuite-Token") || request.headers.get("X-Webhook-Token") || url.searchParams.get("token") || "";
  return timingSafeEqual(token, secret);
}

async function handleOpasuiteWebhook(env, request) {
  const url = new URL(request.url);
  const raw = await request.text();
  if (new TextEncoder().encode(raw).byteLength > 1024 * 1024) return json({ error: "BODY_TOO_LARGE" }, 413);
  if (!(await oaVerifyToken(env, request, url))) return json({ error: "TOKEN_INVALIDO" }, 403);
  let payload;
  try { payload = JSON.parse(raw); } catch { return json({ error: "INVALID_JSON" }, 400); }
  const db = getDB(env);
  await db.prepare(`INSERT INTO wa_webhook_log(channel,payload) VALUES(?,?)`).bind("opasuite", raw.slice(0, 32000)).run();
  const parsed = oaExtractMessage(payload);
  if (!parsed.phone && !parsed.externalId) return json({ ok: true, ignored: true });
  const settings = await loadWhatsappSettings(db);
  await waHandleInboundGeneric(env, db, settings, parsed);
  return json({ ok: true });
}

async function waHandleStatus(db, st) {
  const waId = String(st.id || "");
  const status = ["sent", "delivered", "read", "failed"].includes(st.status) ? st.status : null;
  if (!waId || !status) return;
  await db.prepare(`UPDATE wa_messages SET status=? WHERE wa_message_id=?`).bind(status, waId).run();
}

async function handleWhatsappWebhookVerify(env, url) {
  const mode = url.searchParams.get("hub.mode");
  const token = url.searchParams.get("hub.verify_token");
  const challenge = url.searchParams.get("hub.challenge") || "";
  if (mode === "subscribe" && token && token === env.WHATSAPP_VERIFY_TOKEN) {
    return new Response(challenge, { status: 200, headers: { "content-type": "text/plain" } });
  }
  return json({ error: "VERIFICACAO_INVALIDA" }, 403);
}

async function handleWhatsappWebhook(env, request) {
  const raw = await request.text();
  if (new TextEncoder().encode(raw).byteLength > 1024 * 1024) return json({ error: "BODY_TOO_LARGE" }, 413);
  if (!(await waVerifySignature(env, request, raw))) return json({ error: "ASSINATURA_INVALIDA" }, 403);
  let payload;
  try { payload = JSON.parse(raw); } catch { return json({ error: "INVALID_JSON" }, 400); }
  const db = getDB(env);
  const settings = await loadWhatsappSettings(db);
  for (const entry of payload?.entry || []) {
    for (const change of entry.changes || []) {
      const value = change.value || {};
      const phoneNumberId = value.metadata?.phone_number_id;
      if (phoneNumberId && env.WHATSAPP_PHONE_NUMBER_ID && phoneNumberId !== env.WHATSAPP_PHONE_NUMBER_ID) continue;
      for (const msg of value.messages || []) await waHandleInboundGeneric(env, db, settings, waMetaToGeneric(msg, value));
      for (const st of value.statuses || []) await waHandleStatus(db, st);
    }
  }
  return json({ ok: true });
}

// Conversa visível ao usuário: a própria (atribuída), as do setor dele e a
// fila de roteamento, que ainda não tem setor. Administrador enxerga tudo.
async function waConversationFor(db, user, id) {
  const row = await db.prepare(`
    SELECT c.*,s.name sector_name,s.color sector_color,u.display_name assigned_name
    FROM wa_conversations c
    LEFT JOIN sectors s ON s.id=c.sector_id
    LEFT JOIN users u ON u.id=c.assigned_user_id
    WHERE c.id=?
  `).bind(id).first();
  if (!row || user.role === "administrador") return row;
  const ids = (await waSectors(db, user)).map(s => Number(s.id));
  const visible = row.status === "routing" || ids.includes(Number(row.sector_id)) || Number(row.assigned_user_id) === Number(user.id);
  return visible ? row : null;
}

async function waPresence(db, sectorIds, viewer, supervise) {
  if (!sectorIds.length) return [];
  const placeholders = sectorIds.map(() => "?").join(",");
  const members = (await db.prepare(`
    SELECT DISTINCT u.id user_id,u.display_name,us.sector_id FROM users u
    JOIN user_sectors us ON us.user_id=u.id
    JOIN role_permissions rp ON rp.role_id=u.role_id
    JOIN permissions p ON p.id=rp.permission_id AND p.code='whatsapp.view'
    WHERE u.active=1 AND us.sector_id IN (${placeholders})
    ORDER BY u.display_name
  `).bind(...sectorIds).all()).results || [];
  if (!members.length) return [];
  const userIds = [...new Set(members.map(m => Number(m.user_id)))];
  const busyRows = (await db.prepare(`
    SELECT c.assigned_user_id user_id,c.id conversation_id,c.phone,c.customer_name,c.sector_id
    FROM wa_conversations c WHERE c.status='open' AND c.assigned_user_id IN (${userIds.map(() => "?").join(",")})
  `).bind(...userIds).all()).results || [];
  const busyMap = new Map();
  for (const b of busyRows) if (!busyMap.has(Number(b.user_id))) busyMap.set(Number(b.user_id), b);
  const presenceRows = (await db.prepare(`SELECT user_id,available FROM wa_agent_presence`).all()).results || [];
  const availMap = new Map(presenceRows.map(r => [Number(r.user_id), Number(r.available)]));
  const byUser = new Map();
  for (const m of members) {
    const id = Number(m.user_id);
    if (!byUser.has(id)) byUser.set(id, { user_id: id, display_name: m.display_name, sectors: [] });
    byUser.get(id).sectors.push(Number(m.sector_id));
  }
  return [...byUser.values()].map(u => {
    const busy = busyMap.get(u.user_id);
    const paused = availMap.get(u.user_id) === 0;
    const item = {
      user_id: u.user_id,
      display_name: u.display_name,
      sectors: u.sectors,
      available: !paused,
      busy: !!busy,
      status: busy ? "chat" : (paused ? "paused" : "available")
    };
    if (busy && supervise) {
      item.current = {
        conversation_id: busy.conversation_id,
        phone: busy.phone,
        customer_name: busy.customer_name,
        sector_id: busy.sector_id
      };
    }
    return item;
  });
}

async function handleWhatsapp(env, request) {
  const gate = await requirePermission(env, request, "whatsapp.view");
  if (gate.response) return gate.response;
  const db = getDB(env);
  const sectors = await waSectors(db, gate.user);
  const sectorIds = sectors.map(s => Number(s.id));
  const permissions = await permissionsOf(env, gate.user);
  const can = {
    chat: permissions.has("whatsapp.chat"),
    supervise: permissions.has("whatsapp.supervise"),
    manage: permissions.has("whatsapp.manage")
  };
  const settings = await loadWhatsappSettings(db);
  let rows;
  if (gate.user.role === "administrador") {
    rows = (await db.prepare(`
      SELECT c.*,s.name sector_name,s.color sector_color,u.display_name assigned_name
      FROM wa_conversations c LEFT JOIN sectors s ON s.id=c.sector_id LEFT JOIN users u ON u.id=c.assigned_user_id
      WHERE c.status!='closed' ORDER BY COALESCE(c.last_message_at,c.created_at) DESC LIMIT 500
    `).all()).results || [];
  } else if (!sectorIds.length) {
    rows = (await db.prepare(`
      SELECT c.*,s.name sector_name,s.color sector_color,u.display_name assigned_name
      FROM wa_conversations c LEFT JOIN sectors s ON s.id=c.sector_id LEFT JOIN users u ON u.id=c.assigned_user_id
      WHERE c.status!='closed' AND c.status='routing' ORDER BY COALESCE(c.last_message_at,c.created_at) DESC LIMIT 500
    `).all()).results || [];
  } else {
    const placeholders = sectorIds.map(() => "?").join(",");
    rows = (await db.prepare(`
      SELECT c.*,s.name sector_name,s.color sector_color,u.display_name assigned_name
      FROM wa_conversations c LEFT JOIN sectors s ON s.id=c.sector_id LEFT JOIN users u ON u.id=c.assigned_user_id
      WHERE c.status!='closed' AND (c.status='routing' OR c.sector_id IN (${placeholders}) OR c.assigned_user_id=?)
      ORDER BY COALESCE(c.last_message_at,c.created_at) DESC LIMIT 500
    `).bind(...sectorIds, gate.user.id).all()).results || [];
  }
  const presence = await waPresence(db, sectorIds, gate.user, can.supervise);
  const conversations = rows.map(c => ({
    ...c,
    is_mine: Number(c.assigned_user_id) === Number(gate.user.id),
    can_take: can.chat && c.status !== "closed" &&
      (c.status === "routing" || (c.sector_id != null && sectorIds.includes(Number(c.sector_id))))
  }));
  const routedSectorOptions = (await waRoutedSectorOptions(db, settings)).map(o => ({ id: o.id, code: o.code, name: o.name, number: o.number }));
  return json({ sectors, conversations, presence, can, settings, routedSectorOptions });
}

async function handleWhatsappConversation(env, request, id) {
  const gate = await requirePermission(env, request, "whatsapp.view");
  if (gate.response) return gate.response;
  const db = getDB(env);
  const conv = await waConversationFor(db, gate.user, id);
  if (!conv) return json({ error: "CONVERSA_NAO_ENCONTRADA" }, 404);
  const messages = (await db.prepare(`
    SELECT id,direction,type,body,status,sender_user_id,sender_name,created_at
    FROM wa_messages WHERE conversation_id=? ORDER BY created_at ASC,id ASC LIMIT 500
  `).bind(id).all()).results || [];
  const permissions = await permissionsOf(env, gate.user);
  const can = { chat: permissions.has("whatsapp.chat"), supervise: permissions.has("whatsapp.supervise") };
  if (Number(conv.assigned_user_id) === Number(gate.user.id)) {
    if (conv.unread > 0) {
      await db.prepare(`UPDATE wa_conversations SET unread=0,updated_at=CURRENT_TIMESTAMP WHERE id=?`).bind(id).run();
      conv.unread = 0;
    }
    await db.prepare(`UPDATE wa_messages SET status='read' WHERE conversation_id=? AND direction='in' AND status!='read'`).bind(id).run();
  }
  return json({ conversation: conv, messages, can });
}

async function handleWhatsappCreate(env, request) {
  const gate = await requirePermission(env, request, "whatsapp.chat");
  if (gate.response) return gate.response;
  const db = getDB(env);
  let body; try { body = await readJson(request, 16384); } catch { return json({ error: "INVALID_JSON" }, 400); }
  const phone = String(body.phone || "").replace(/\D/g, "").slice(0, 15);
  if (!/^\d{8,15}$/.test(phone)) return json({ error: "TELEFONE_INVALIDO" }, 400);
  const text = String(body.body || "").trim().slice(0, 4096);
  if (!text) return json({ error: "MENSAGEM_VAZIA" }, 400);
  const sectors = await waSectors(db, gate.user);
  const sectorId = Number(body.sector_id);
  if (!sectors.some(s => Number(s.id) === sectorId)) return json({ error: "SETOR_NAO_PERMITIDO" }, 403);
  const customerName = String(body.customer_name || "").trim().slice(0, 200) || phone;
  const result = await db.prepare(`
    INSERT INTO wa_conversations(phone,customer_name,sector_id,assigned_user_id,status,last_message,last_message_at,updated_at)
    VALUES(?,?,?,?,?,?,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)
  `).bind(phone, customerName, sectorId, gate.user.id, "open", text).run();
  const id = Number(result.meta.last_row_id);
  const send = await waSendText(env, phone, text);
  await db.prepare(`INSERT INTO wa_messages(conversation_id,direction,type,body,wa_message_id,status,sender_user_id,sender_name) VALUES(?,?,?,?,?,?,?,?)`)
    .bind(id, "out", "text", text, send.wa_message_id, send.ok ? "sent" : "failed", gate.user.id, gate.user.display_name).run();
  await audit(env, request, gate.user, "WHATSAPP_CONVERSATION_CREATE", "wa_conversation", id, null, { phone, sector_id: sectorId });
  return json({ id, ok: true }, send.ok ? 201 : 502);
}

async function handleWhatsappSend(env, request, id) {
  const gate = await requirePermission(env, request, "whatsapp.chat");
  if (gate.response) return gate.response;
  const db = getDB(env);
  const conv = await waConversationFor(db, gate.user, id);
  if (!conv) return json({ error: "CONVERSA_NAO_ENCONTRADA" }, 404);
  if (conv.status === "closed") return json({ error: "CONVERSA_ENCERRADA" }, 409);
  if (conv.status === "routing") return json({ error: "CONVERSA_SEM_SETOR" }, 409);
  const permissions = await permissionsOf(env, gate.user);
  if (Number(conv.assigned_user_id) !== Number(gate.user.id) && !permissions.has("whatsapp.supervise"))
    return json({ error: "CONVERSA_NAO_E_SUA" }, 403);
  let body; try { body = await readJson(request, 16384); } catch { return json({ error: "INVALID_JSON" }, 400); }
  const isImage = body.type === "image";
  const text = String(body.body || "").trim().slice(0, isImage ? 300 : 4096);
  if (!text) return json({ error: "MENSAGEM_VAZIA" }, 400);
  if (isImage && !text.startsWith(`/api/media/staff/${gate.user.id}/`)) {
    return json({ error: "IMAGEM_INVALIDA" }, 400);
  }
  // Conversa nascida no app não tem canal externo pra espelhar (ver
  // handleClientMessageSend). Imagem nunca é retransmitida pro canal externo
  // (path só funciona autenticado neste backend — ver handleClientMessageSend).
  const isAppOnly = !conv.channel || conv.channel === "app";
  const send = isAppOnly || isImage ? { ok: true, wa_message_id: null } : await omniSendText(env, conv, text);
  const result = await db.prepare(`INSERT INTO wa_messages(conversation_id,direction,type,body,wa_message_id,status,sender_user_id,sender_name) VALUES(?,?,?,?,?,?,?,?)`)
    .bind(id, "out", isImage ? "image" : "text", text, send.wa_message_id, send.ok ? "sent" : "failed", gate.user.id, gate.user.display_name).run();
  await db.prepare(`UPDATE wa_conversations SET last_message=?,last_message_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP WHERE id=?`).bind(isImage ? "📷 Imagem" : text, id).run();
  await audit(env, request, gate.user, "WHATSAPP_MESSAGE_SEND", "wa_conversation", id, null, { body: isImage ? "[imagem]" : text, ok: send.ok, error: send.error || null });
  if (!send.ok) {
    return json({ error: send.error || "WHATSAPP_ENVIO_FALHOU", status: send.status || null, detail: send.detail || null, message_id: result.meta.last_row_id }, 502);
  }
  return json({ message_id: result.meta.last_row_id, wa_message_id: send.wa_message_id });
}

async function handleWhatsappTake(env, request, id) {
  const gate = await requirePermission(env, request, "whatsapp.chat");
  if (gate.response) return gate.response;
  const db = getDB(env);
  const conv = await waConversationFor(db, gate.user, id);
  if (!conv) return json({ error: "CONVERSA_NAO_ENCONTRADA" }, 404);
  if (conv.status === "closed") return json({ error: "CONVERSA_ENCERRADA" }, 409);
  let body = {}; try { body = await readJson(request, 8192); } catch {}
  const sectors = await waSectors(db, gate.user);
  const sectorIds = sectors.map(s => Number(s.id));
  const supervise = await hasPermission(env, gate.user, "whatsapp.supervise");
  let sectorId;
  if (conv.status === "open" && conv.sector_id != null) {
    sectorId = Number(conv.sector_id);
    if (!sectorIds.includes(sectorId) && !supervise) return json({ error: "SETOR_NAO_PERMITIDO" }, 403);
  } else {
    sectorId = Number(body.sector_id);
    if (!sectorIds.includes(sectorId)) return json({ error: "SETOR_NAO_PERMITIDO" }, 403);
  }
  if (Number(conv.assigned_user_id) !== Number(gate.user.id)) {
    const busy = await db.prepare(`SELECT 1 FROM wa_conversations WHERE status='open' AND assigned_user_id=? AND id<>?`).bind(gate.user.id, id).first();
    if (busy) return json({ error: "ATENDENTE_OCUPADO" }, 409);
  }
  await db.prepare(`
    UPDATE wa_conversations SET sector_id=?,assigned_user_id=?,status='open',unread=0,updated_at=CURRENT_TIMESTAMP WHERE id=?
  `).bind(sectorId, gate.user.id, id).run();
  await audit(env, request, gate.user, "WHATSAPP_CONVERSATION_TAKE", "wa_conversation", id, null, { sector_id: sectorId });
  return json({ ok: true, assigned_user_id: gate.user.id, sector_id: sectorId });
}

async function handleWhatsappAssign(env, request, id) {
  const gate = await requirePermission(env, request, "whatsapp.supervise");
  if (gate.response) return gate.response;
  const db = getDB(env);
  const conv = await waConversationFor(db, gate.user, id);
  if (!conv) return json({ error: "CONVERSA_NAO_ENCONTRADA" }, 404);
  let body; try { body = await readJson(request, 8192); } catch { return json({ error: "INVALID_JSON" }, 400); }
  const sectorId = Number(body.sector_id);
  const sector = await db.prepare(`SELECT id FROM sectors WHERE id=? AND active=1`).bind(sectorId).first();
  if (!sector) return json({ error: "SETOR_INVALIDO" }, 400);
  let userId = null;
  if (body.user_id != null && body.user_id !== "") {
    userId = Number(body.user_id);
    if (!Number.isInteger(userId)) return json({ error: "RESPONSAVEL_INVALIDO" }, 400);
    const member = await db.prepare(`SELECT 1 FROM users u JOIN user_sectors us ON us.user_id=u.id WHERE u.id=? AND us.sector_id=? AND u.active=1`).bind(userId, sectorId).first();
    if (!member) return json({ error: "RESPONSAVEL_INVALIDO" }, 400);
  }
  const status = body.status === "closed" ? "closed" : "open";
  await db.prepare(`
    UPDATE wa_conversations SET sector_id=?,assigned_user_id=?,status=?,closed_at=?,closed_by=?,updated_at=CURRENT_TIMESTAMP WHERE id=?
  `).bind(sectorId, userId, status, status === "closed" ? new Date().toISOString() : null, status === "closed" ? gate.user.id : null, id).run();
  await audit(env, request, gate.user, "WHATSAPP_CONVERSATION_ASSIGN", "wa_conversation", id, null, { sector_id: sectorId, user_id: userId, status });
  return json({ ok: true, sector_id: sectorId, assigned_user_id: userId, status });
}

async function handleWhatsappClose(env, request, id) {
  const gate = await requirePermission(env, request, "whatsapp.chat");
  if (gate.response) return gate.response;
  const db = getDB(env);
  const conv = await waConversationFor(db, gate.user, id);
  if (!conv) return json({ error: "CONVERSA_NAO_ENCONTRADA" }, 404);
  if (conv.status === "closed") return json({ error: "CONVERSA_ENCERRADA" }, 409);
  const permissions = await permissionsOf(env, gate.user);
  if (Number(conv.assigned_user_id) !== Number(gate.user.id) && !permissions.has("whatsapp.supervise") && conv.status !== "routing")
    return json({ error: "CONVERSA_NAO_E_SUA" }, 403);
  await db.prepare(`UPDATE wa_conversations SET status='closed',closed_at=?,closed_by=?,updated_at=CURRENT_TIMESTAMP WHERE id=?`)
    .bind(new Date().toISOString(), gate.user.id, id).run();
  await audit(env, request, gate.user, "WHATSAPP_CONVERSATION_CLOSE", "wa_conversation", id, null, null);
  return json({ ok: true });
}

async function handleWhatsappPresence(env, request) {
  const gate = await requirePermission(env, request, "whatsapp.view");
  if (gate.response) return gate.response;
  const db = getDB(env);
  let body; try { body = await readJson(request, 8192); } catch { return json({ error: "INVALID_JSON" }, 400); }
  const available = body.available ? 1 : 0;
  await db.prepare(`
    INSERT INTO wa_agent_presence(user_id,available,updated_at) VALUES(?,?,CURRENT_TIMESTAMP)
    ON CONFLICT(user_id) DO UPDATE SET available=excluded.available,updated_at=CURRENT_TIMESTAMP
  `).bind(gate.user.id, available).run();
  return json({ ok: true, available: Boolean(available) });
}

async function handleWhatsappSettings(env, request) {
  if (request.method === "GET") {
    const gate = await requirePermission(env, request, "whatsapp.view");
    if (gate.response) return gate.response;
    const db = getDB(env);
    const settings = await loadWhatsappSettings(db);
    const permissions = await permissionsOf(env, gate.user);
    return json({ settings, podeEditar: permissions.has("whatsapp.manage") });
  }
  const gate = await requirePermission(env, request, "whatsapp.manage");
  if (gate.response) return gate.response;
  const db = getDB(env);
  let body; try { body = await readJson(request, 65536); } catch { return json({ error: "INVALID_JSON" }, 400); }
  const antes = await loadWhatsappSettings(db);
  const depois = await normalizeWhatsappSettings(db, body?.settings ?? body, antes);
  await db.prepare(`INSERT OR REPLACE INTO platform_meta(key,value,updated_at) VALUES(?,?,CURRENT_TIMESTAMP)`)
    .bind(WHATSAPP_SETTINGS_KEY, JSON.stringify(depois)).run();
  await audit(env, request, gate.user, "WHATSAPP_SETTINGS_UPDATE", "whatsapp", "settings", antes, depois);
  return json({ ok: true, settings: depois, podeEditar: true });
}

// Ajuda a fechar o mapeamento do payload do Opa!Suite: mostra os últimos
// corpos brutos recebidos em /api/opasuite/webhook para quem pode configurar
// o chat, sem precisar reproduzir o envio do lado de fora.
async function handleWaWebhookLog(env, request) {
  const gate = await requirePermission(env, request, "whatsapp.manage");
  if (gate.response) return gate.response;
  const db = getDB(env);
  const rows = (await db.prepare(`SELECT id,channel,payload,created_at FROM wa_webhook_log ORDER BY id DESC LIMIT 20`).all()).results || [];
  return json({ rows });
}

async function handleMe(env, request) {
  const user = await getCurrentUser(env, request);
  if (!user) return json({ authenticated: false }, 401);

  if (user.role === "cliente") {
    return json({
      authenticated: true,
      user: {
        id: user.id,
        username: user.username,
        display_name: user.display_name,
        role: "cliente",
        must_change_password: Boolean(user.must_change_password)
      },
      screens: []
    });
  }

  const db = getDB(env);
  const screens = await db.prepare(`
    SELECT s.code, s.name
    FROM screens s
    JOIN role_screens rs ON rs.screen_id=s.id
    WHERE rs.role_id=? AND s.active=1
    ORDER BY s.id
  `).bind(user.role_id).all();

  return json({
    authenticated: true,
    user: {
      id: user.id,
      username: user.username,
      display_name: user.display_name,
      role: user.role,
      must_change_password: Boolean(user.must_change_password)
    },
    screens: screens.results || []
  });
}

async function handleLogout(env, request) {
  const db = getDB(env);
  const user = await getCurrentUser(env, request);
  const rawToken = extractSessionToken(request);

  if (rawToken) {
    const tokenHash = await sha256Base64Url(rawToken);
    await db.prepare(`DELETE FROM sessions WHERE token_hash=?`).bind(tokenHash).run();
    await db.prepare(`DELETE FROM client_sessions WHERE token_hash=?`).bind(tokenHash).run();
    await db.prepare(`DELETE FROM guest_sessions WHERE token_hash=?`).bind(tokenHash).run();
  }

  if (user) {
    // Auditing must never prevent session invalidation. Older D1 schemas may
    // still have stricter audit columns, so isolate this write from logout.
    try {
      await audit(env, request, user, "LOGOUT", "auth", String(user.id));
    } catch (auditError) {
      console.error("Falha ao auditar LOGOUT:", auditError);
    }
  }

  return json({ ok: true }, 200, {
    "Set-Cookie": `${COOKIE_NAME}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`
  });
}

// ---------------------------------------------------------------------------
// Área do cliente (app, papel "cliente") — só identificação e roteador, sem
// setor, sem "hospedagem"/infra e sem informação de staff. Ver requireClient.
// ---------------------------------------------------------------------------

// GET /api/client/me — perfil mínimo do próprio cliente autenticado.
async function handleClientMe(env, request) {
  const gate = await requireClient(env, request);
  if (gate.response) return gate.response;
  // Sessão convidada: os dados já estão no próprio gate.user (guest_sessions),
  // nunca em cliente_cadastro — ver getCurrentUser.
  if (gate.user.is_guest) {
    return json({
      id: gate.user.id,
      displayName: gate.user.display_name,
      telefone: gate.user.telefone,
      email: null
    });
  }
  const row = await getDB(env).prepare(`
    SELECT client_id, nome, telefone, email FROM cliente_cadastro WHERE client_id=?
  `).bind(gate.user.id).first();
  if (!row) return json({ error: "CLIENTE_NAO_ENCONTRADO" }, 404);
  return json({
    id: row.client_id,
    displayName: row.nome,
    telefone: row.telefone,
    email: row.email
  });
}

// POST /api/client/change-password — troca a senha do app (senha_portal_cipher),
// nunca a senha PPPoE/roteador/WiFi editadas por staff.
async function handleClientChangePassword(env, request) {
  const gate = await requireClient(env, request);
  if (gate.response) return gate.response;
  // Sessão convidada não tem senha_portal_cipher — não existe senha pra trocar.
  if (gate.user.is_guest) return json({ error: "FORBIDDEN" }, 403);
  const db = getDB(env);
  let body = {}; try { body = await readJson(request, 16384); } catch {}
  const cred = await db.prepare(`SELECT senha_portal_cipher FROM cliente_cadastro WHERE client_id=?`).bind(gate.user.id).first();
  if (!cred || !cred.senha_portal_cipher || !(await verifyPassword(String(body.oldPassword || ""), cred.senha_portal_cipher)))
    return json({ error: "SENHA_ATUAL_INVALIDA" }, 400);
  if (String(body.newPassword || "").length < 8) return json({ error: "SENHA_FRACA" }, 400);
  await db.prepare(`
    UPDATE cliente_cadastro SET senha_portal_cipher=?, portal_must_change_password=0, updated_at=CURRENT_TIMESTAMP
    WHERE client_id=?
  `).bind(await hashSenhaCliente(String(body.newPassword)), gate.user.id).run();
  const currentHash = await sha256Base64Url(extractSessionToken(request) || "");
  await db.prepare(`DELETE FROM client_sessions WHERE client_id=? AND token_hash<>?`).bind(gate.user.id, currentHash).run();
  await audit(env, request, { username: gate.user.username }, "CLIENT_PASSWORD_CHANGED", "cliente_cadastro", gate.user.id);
  return json({ ok: true });
}

// GET /api/client/router-status — status do próprio roteador/ONU (GPON) e da
// última autenticação RADIUS conhecida. Nunca aceita client_id da requisição;
// sempre escopado a gate.user.id. Não usa Zabbix (sem mapeamento por cliente).
async function handleClientRouterStatus(env, request) {
  const gate = await requireClient(env, request);
  if (gate.response) return gate.response;
  const db = getDB(env);

  const compacto = await db.prepare(`SELECT data_json, synced_at FROM gpon_status_snapshot WHERE id=1`).first();
  const linhas = lerStatusCompactoGpon(compacto);
  const linha = linhas.find(l => String(l.client_id) === String(gate.user.id)) || null;

  const radiusUltimo = await db.prepare(`
    SELECT status_after, detail, olt_id, onu_index, serial, synced_at, created_at
    FROM radius_logs WHERE client_id=? ORDER BY id DESC LIMIT 1
  `).bind(gate.user.id).first();

  const cadastro = await db.prepare(`
    SELECT ont_serial, ont_modelo, ip_gerencia, login_pppoe FROM cliente_cadastro WHERE client_id=?
  `).bind(gate.user.id).first();

  return json({
    clientId: gate.user.id,
    ontSerial: cadastro?.ont_serial || null,
    ontModelo: cadastro?.ont_modelo || null,
    loginPppoe: cadastro?.login_pppoe || null,
    gpon: linha ? {
      status: linha.status,
      stateDetail: linha.state_detail || null,
      rxPower: linha.rx_power ?? null,
      txPower: linha.tx_power ?? null,
      ip: linha.ip || cadastro?.ip_gerencia || null,
      downKbps: linha.down_kbps ?? null,
      upKbps: linha.up_kbps ?? null,
      downBytes: linha.down_bytes ?? null,
      upBytes: linha.up_bytes ?? null,
      uptimeS: linha.uptime_s ?? null,
      connSince: linha.conn_since || null
    } : null,
    radius: radiusUltimo ? {
      status: radiusUltimo.status_after,
      detail: radiusUltimo.detail || null,
      updatedAt: radiusUltimo.created_at
    } : null,
    updatedAt: compacto?.synced_at || null
  });
}

// ---------------------------------------------------------------------------
// Conversas do cliente (app) — histórico e chat com a central, escopados por
// telefone do próprio cadastro (nunca aceito da requisição).
// ---------------------------------------------------------------------------

function telefoneNormalizado(valor) {
  return String(valor || "").replace(/\D/g, "");
}

// ---------------------------------------------------------------------------
// Mídia do chat (imagens) — bucket R2 "MEDIA" (ver wrangler.jsonc). Sem
// binding público: toda leitura passa por GET /api/media/:key, autenticada,
// pra não expor foto de documento/roteador de cliente por URL adivinhável.
// ---------------------------------------------------------------------------

const MEDIA_MAX_BYTES = 8 * 1024 * 1024;
const MEDIA_ALLOWED_TYPES = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif" };

async function storeMediaUpload(env, request, keyPrefix) {
  if (!env.MEDIA) return { ok: false, error: "MEDIA_NAO_CONFIGURADO" };
  const contentType = (request.headers.get("Content-Type") || "").split(";")[0].trim().toLowerCase();
  const ext = MEDIA_ALLOWED_TYPES[contentType];
  if (!ext) return { ok: false, error: "TIPO_INVALIDO" };
  const declared = Number(request.headers.get("Content-Length") || 0);
  if (declared > MEDIA_MAX_BYTES) return { ok: false, error: "ARQUIVO_MUITO_GRANDE" };
  const bytes = await request.arrayBuffer();
  if (bytes.byteLength === 0) return { ok: false, error: "ARQUIVO_VAZIO" };
  if (bytes.byteLength > MEDIA_MAX_BYTES) return { ok: false, error: "ARQUIVO_MUITO_GRANDE" };
  const key = `${keyPrefix}/${crypto.randomUUID()}.${ext}`;
  await env.MEDIA.put(key, bytes, { httpMetadata: { contentType } });
  return { ok: true, key };
}

// POST /api/client/uploads — corpo bruto (bytes da imagem), Content-Type
// define a extensão. Devolve o path pra usar como `body` de uma mensagem
// type=image em POST /api/client/conversations/:id/messages.
async function handleClientUpload(env, request) {
  const gate = await requireClient(env, request);
  if (gate.response) return gate.response;
  const result = await storeMediaUpload(env, request, `client/${gate.user.id}`);
  if (!result.ok) return json({ error: result.error }, result.error === "ARQUIVO_MUITO_GRANDE" ? 413 : 400);
  return json({ path: `/api/media/${result.key}` }, 201);
}

// POST /api/whatsapp/uploads — mesma coisa, pro lado do atendente (staff
// também precisa mandar imagem de volta, ex.: print de configuração).
async function handleStaffUpload(env, request) {
  const gate = await requirePermission(env, request, "whatsapp.chat");
  if (gate.response) return gate.response;
  const result = await storeMediaUpload(env, request, `staff/${gate.user.id}`);
  if (!result.ok) return json({ error: result.error }, result.error === "ARQUIVO_MUITO_GRANDE" ? 413 : 400);
  return json({ path: `/api/media/${result.key}` }, 201);
}

// GET /api/media/:key — cliente só lê o próprio prefixo (client/<id>/...);
// qualquer staff autenticado lê tudo, igual ao resto do painel.
async function handleMediaGet(env, request, key) {
  const user = await getCurrentUser(env, request);
  if (!user) return json({ error: "AUTH_REQUIRED" }, 401);
  if (user.role === "cliente" && !key.startsWith(`client/${user.id}/`)) {
    return json({ error: "FORBIDDEN" }, 403);
  }
  if (!env.MEDIA) return json({ error: "MEDIA_NAO_CONFIGURADO" }, 500);
  const object = await env.MEDIA.get(key);
  if (!object) return json({ error: "NAO_ENCONTRADO" }, 404);
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("cache-control", "private, max-age=86400");
  headers.set("access-control-allow-origin", "*");
  return new Response(object.body, { headers });
}

// Sessão convidada já traz o telefone digitado (nunca consultado em
// cliente_cadastro); só cai pra query quando é um cliente "de verdade"
// (login por senha do portal), que não carrega telefone no gate.user.
async function clientePhoneOf(db, user) {
  if (user?.telefone) return telefoneNormalizado(user.telefone);
  const row = await db.prepare(`SELECT telefone FROM cliente_cadastro WHERE client_id=?`).bind(user.id).first();
  return telefoneNormalizado(row?.telefone);
}

// O app Flutter espera JSON em camelCase (Conversation/Message usam
// json_serializable sem fieldRename); as colunas do banco são snake_case.
function conversationToCamel(row) {
  return {
    id: row.id,
    phone: row.phone,
    customerName: row.customer_name,
    channel: row.channel || null,
    status: row.status,
    unread: row.unread ?? 0,
    lastMessage: row.last_message || "",
    lastMessageAt: row.last_message_at || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function messageToCamel(row) {
  return {
    id: row.id,
    direction: row.direction,
    type: row.type,
    body: row.body,
    status: row.status || null,
    senderUserId: row.sender_user_id ?? null,
    senderName: row.sender_name || null,
    createdAt: row.created_at,
    waMessageId: row.wa_message_id || null
  };
}

// GET /api/client/conversations
async function handleClientConversations(env, request) {
  const gate = await requireClient(env, request);
  if (gate.response) return gate.response;
  const db = getDB(env);
  const phone = await clientePhoneOf(db, gate.user);
  if (!phone) return json({ conversations: [] });
  const rows = (await db.prepare(`
    SELECT id, phone, customer_name, channel, status, last_message, last_message_at, unread, created_at, updated_at
    FROM wa_conversations WHERE phone=? ORDER BY COALESCE(last_message_at,created_at) DESC LIMIT 100
  `).bind(phone).all()).results || [];
  return json({ conversations: rows.map(conversationToCamel) });
}

// GET /api/client/conversations/:id
async function handleClientConversationDetail(env, request, id) {
  const gate = await requireClient(env, request);
  if (gate.response) return gate.response;
  const db = getDB(env);
  const phone = await clientePhoneOf(db, gate.user);
  const conv = await db.prepare(`
    SELECT id,phone,customer_name,channel,status,last_message,last_message_at,unread,created_at,updated_at
    FROM wa_conversations WHERE id=?
  `).bind(id).first();
  // 404 (não 403) em vez de confirmar que o id pertence a outro cliente.
  if (!conv || !phone || conv.phone !== phone) return json({ error: "CONVERSA_NAO_ENCONTRADA" }, 404);
  const messages = (await db.prepare(`
    SELECT id,direction,type,body,status,sender_user_id,sender_name,wa_message_id,created_at
    FROM wa_messages WHERE conversation_id=? ORDER BY created_at ASC,id ASC LIMIT 500
  `).bind(id).all()).results || [];
  if (conv.unread > 0) {
    await db.prepare(`UPDATE wa_conversations SET unread=0,updated_at=CURRENT_TIMESTAMP WHERE id=?`).bind(id).run();
    conv.unread = 0;
  }
  return json({ conversation: conversationToCamel(conv), messages: messages.map(messageToCamel) });
}

// POST /api/client/conversations — sem setor: entra na fila de roteamento,
// igual ao fluxo do bot de WhatsApp hoje. Telefone/nome vêm sempre da sessão
// (gate.user — cadastro real ou convidada), nunca do corpo da requisição.
//
// Canal "app": a conversa nasce e vive só aqui dentro, sem depender de
// WhatsApp/Opa!Suite configurados. E a mensagem é do cliente PARA o NOC —
// direction 'in', igual a qualquer mensagem recebida por outro canal (nunca
// 'out', que é reservado pra quando o atendente/bot fala).
//
// Um único atendimento por cliente: telefone+CPF nunca abrem uma segunda
// conversa em paralelo. Se já existir uma (aberta, na fila, ou encerrada),
// reaproveita a mesma linha em vez de inserir outra — encerrada volta pra
// fila de roteamento — assim o histórico inteiro fica numa thread só, nunca
// fragmentado.
async function handleClientConversationCreate(env, request) {
  const gate = await requireClient(env, request);
  if (gate.response) return gate.response;
  const db = getDB(env);
  const phone = await clientePhoneOf(db, gate.user);
  if (!phone) return json({ error: "TELEFONE_NAO_CADASTRADO" }, 409);
  let body; try { body = await readJson(request, 16384); } catch { return json({ error: "INVALID_JSON" }, 400); }
  const text = String(body.body || "").trim().slice(0, 4096);
  if (!text) return json({ error: "MENSAGEM_VAZIA" }, 400);
  const customerName = String(gate.user.display_name || "").trim() || phone;

  const existing = await db.prepare(`
    SELECT id, status FROM wa_conversations WHERE phone=? AND channel='app' ORDER BY id DESC LIMIT 1
  `).bind(phone).first();

  if (existing) {
    if (existing.status === "closed") {
      await db.prepare(`
        UPDATE wa_conversations SET status='routing',routing_attempts=0,closed_at=NULL,closed_by=NULL,
          last_message=?,last_message_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP WHERE id=?
      `).bind(text, existing.id).run();
    } else {
      await db.prepare(`UPDATE wa_conversations SET last_message=?,last_message_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP WHERE id=?`)
        .bind(text, existing.id).run();
    }
    await db.prepare(`INSERT INTO wa_messages(conversation_id,direction,type,body,sender_name) VALUES(?,?,?,?,?)`)
      .bind(existing.id, "in", "text", text, customerName).run();
    await audit(env, request, { username: gate.user.username }, "CLIENT_CONVERSATION_CREATE", "wa_conversation", existing.id, null, { phone, reopened: existing.status === "closed" });
    return json({ id: existing.id, ok: true });
  }

  const result = await db.prepare(`
    INSERT INTO wa_conversations(phone,customer_name,channel,sector_id,assigned_user_id,status,last_message,last_message_at,updated_at)
    VALUES(?,?,'app',NULL,NULL,'routing',?,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)
  `).bind(phone, customerName, text).run();
  const id = Number(result.meta.last_row_id);
  await db.prepare(`INSERT INTO wa_messages(conversation_id,direction,type,body,sender_name) VALUES(?,?,?,?,?)`)
    .bind(id, "in", "text", text, customerName).run();
  await audit(env, request, { username: gate.user.username }, "CLIENT_CONVERSATION_CREATE", "wa_conversation", id, null, { phone });
  return json({ id, ok: true }, 201);
}

// POST /api/client/conversations/:id/messages
async function handleClientMessageSend(env, request, id) {
  const gate = await requireClient(env, request);
  if (gate.response) return gate.response;
  const db = getDB(env);
  const phone = await clientePhoneOf(db, gate.user);
  const conv = await db.prepare(`SELECT id,status,phone,customer_name,channel FROM wa_conversations WHERE id=?`).bind(id).first();
  if (!conv || !phone || conv.phone !== phone) return json({ error: "CONVERSA_NAO_ENCONTRADA" }, 404);
  // Cliente só tem UMA conversa (ver handleClientConversationCreate): mandar
  // mensagem numa encerrada reabre pra fila em vez de rejeitar, senão o
  // cliente ficaria travado sem conseguir voltar a falar com o suporte.
  if (conv.status === "closed") {
    await db.prepare(`
      UPDATE wa_conversations SET status='routing',routing_attempts=0,closed_at=NULL,closed_by=NULL,updated_at=CURRENT_TIMESTAMP WHERE id=?
    `).bind(id).run();
    conv.status = "routing";
  }
  let body; try { body = await readJson(request, 16384); } catch { return json({ error: "INVALID_JSON" }, 400); }
  const isImage = body.type === "image";
  const text = String(body.body || "").trim().slice(0, isImage ? 300 : 4096);
  if (!text) return json({ error: "MENSAGEM_VAZIA" }, 400);
  // Só aceita path de imagem que o próprio cliente subiu (ver handleClientUpload) —
  // sem isso, ele poderia referenciar a foto de outro cliente ou de um
  // atendente só sabendo o path.
  if (isImage && !text.startsWith(`/api/media/client/${gate.user.id}/`)) {
    return json({ error: "IMAGEM_INVALIDA" }, 400);
  }

  // Conversa nascida no app não tem canal externo pra espelhar. As que vieram
  // de fora (WhatsApp, Opa!Suite) continuam sendo retransmitidas, senão o
  // histórico do lado de lá fica incompleto. Imagem nunca é retransmitida:
  // o path só funciona autenticado neste backend, sem valor pra um canal
  // externo (WhatsApp/Opa!Suite exigiriam upload de mídia próprio, não feito).
  const isAppOnly = !conv.channel || conv.channel === "app";
  const send = isAppOnly || isImage ? { ok: true, wa_message_id: null } : await omniSendText(env, conv, text);

  const result = await db.prepare(`INSERT INTO wa_messages(conversation_id,direction,type,body,wa_message_id,status,sender_name) VALUES(?,?,?,?,?,?,?)`)
    .bind(id, "in", isImage ? "image" : "text", text, send.wa_message_id, send.ok ? "sent" : "failed", conv.customer_name).run();
  await db.prepare(`UPDATE wa_conversations SET last_message=?,last_message_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP WHERE id=?`).bind(isImage ? "📷 Imagem" : text, id).run();
  await audit(env, request, { username: gate.user.username }, "CLIENT_MESSAGE_SEND", "wa_conversation", id, null, { ok: send.ok, type: isImage ? "image" : "text" });
  if (!send.ok) {
    return json({ error: send.error || "WHATSAPP_ENVIO_FALHOU", messageId: result.meta.last_row_id }, 502);
  }
  return json({ messageId: result.meta.last_row_id, waMessageId: send.wa_message_id });
}

async function handleHealth(env) {
  const db = getDB(env);
  if (!db) {
    return json({
      ok: false,
      service: "topologia-noc",
      error: "Conexão Turso não disponível."
    }, 500);
  }

  const row = await db.prepare(`SELECT 1 AS ok`).first();

  return json({
    ok: row?.ok === 1,
    service: "topologia-noc",
    dependencies: { database: row?.ok === 1 ? "ok" : "unavailable" }
  });
}



// ---------------------------------------------------------------------------
// Zabbix
// ---------------------------------------------------------------------------

// GET /api/zabbix/health — conectividade e versão da API.
async function handleZabbixHealth(env, request) {
  const gate = await requirePermission(env, request, "zabbix.view");
  if (gate.response) return gate.response;

  try {
    const version = await zabbixCall(env, "apiinfo.version", {}, { auth: false });
    // Uma chamada autenticada barata confirma que o token continua válido.
    const hosts = await zabbixCall(env, "host.get", { countOutput: true, limit: 1 });
    return json({ ok: true, version, hosts: Number(hosts) || 0 });
  } catch (error) {
    return json({
      ok: false,
      error: error.message,
      hint: "Configure ZABBIX_URL e ZABBIX_TOKEN nos Secrets do Worker."
    }, 502);
  }
}

/* Uma linha por ciclo com o total da rede. O snapshot é calculado no próprio
   D1 logo depois da gravação do inventário: a leitura já está lá, e assim o
   histórico do painel não depende de nenhum cliente estar aberto.

   `valida` repete no SQL a mesma regra da tela: tráfego acima da capacidade
   nominal é falha de coleta, não saturação, e fica fora dos totais. */
const HISTORICO_DIAS = 7;

async function recordTrafficSnapshot(db, { atencao = 70, tolerancia = 1.05 } = {}) {
  await db.batch([
    db.prepare(`
      INSERT INTO zabbix_traffic_snapshots
        (in_bps, out_bps, interfaces_total, interfaces_up, interfaces_saturadas, erros)
      SELECT
        SUM(CASE WHEN valida=1 THEN ib ELSE 0 END),
        SUM(CASE WHEN valida=1 THEN ob ELSE 0 END),
        COUNT(*),
        SUM(CASE WHEN oper_status=1 THEN 1 ELSE 0 END),
        SUM(CASE WHEN valida=1 AND cap>0 AND (MAX(ib,ob)*100.0)/cap > ? THEN 1 ELSE 0 END),
        SUM(err)
      FROM (
        SELECT
          COALESCE(in_bps,0) AS ib,
          COALESCE(out_bps,0) AS ob,
          COALESCE(speed_bps,0) AS cap,
          COALESCE(in_errors,0)+COALESCE(out_errors,0) AS err,
          oper_status,
          CASE WHEN COALESCE(speed_bps,0) > 0
                 AND MAX(COALESCE(in_bps,0),COALESCE(out_bps,0)) > COALESCE(speed_bps,0)*?
               THEN 0 ELSE 1 END AS valida
        FROM zabbix_interfaces
      )
    `).bind(atencao, tolerancia),
    db.prepare(`
      DELETE FROM zabbix_traffic_snapshots
      WHERE taken_at < datetime('now', ?)
    `).bind(`-${HISTORICO_DIAS} days`)
  ]);
}

/* Corpo da sincronização, sem HTTP: é o mesmo caminho para o botão da tela e
   para o gatilho automático (cron), e os dois deixam registro em
   zabbix_sync_runs com a origem correta. */
async function runZabbixSync(env, { userId = null, source = "api" } = {}) {
  const db = getDB(env);
  const run = await db.prepare(`
    INSERT INTO zabbix_sync_runs (triggered_by, source) VALUES (?, ?)
  `).bind(userId, source).run();
  const runId = run.meta.last_row_id;

  try {
    const inventory = await fetchNetworkInventory(env);
    const counts = await persistInventory(db, inventory);

    await db.prepare(`
      UPDATE zabbix_sync_runs
      SET finished_at=CURRENT_TIMESTAMP, ok=1, hosts_count=?, interfaces_count=?
      WHERE id=?
    `).bind(counts.hosts, counts.interfaces, runId).run();

    const settings = await loadTrafegoSettings(db);
    await recordTrafficSnapshot(db, {
      atencao: settings.limiteAtencao,
      tolerancia: settings.toleranciaLeitura
    });

    /* Os alertas da home nascem do mesmo inventário que acabou de ser gravado.
       Falhar aqui não pode invalidar uma sincronização que deu certo. */
    try {
      await gerarAlertasDaRede(db, { inventario: await loadInventoryFromDb(db), settings, forcar: true });
    } catch (error) {
      console.error(JSON.stringify({ message: "Falha ao derivar alertas após a sincronização", error: error?.message || String(error) }));
    }

    return { ok: true, run_id: runId, ...counts };
  } catch (error) {
    await db.prepare(`
      UPDATE zabbix_sync_runs SET finished_at=CURRENT_TIMESTAMP, ok=0, error=? WHERE id=?
    `).bind(String(error.message), runId).run();

    return { ok: false, run_id: runId, error: error.message };
  }
}

// POST /api/zabbix/sync — importa hosts e interfaces do Zabbix para o D1.
async function handleZabbixSync(env, request) {
  const gate = await requirePermission(env, request, "zabbix.sync");
  if (gate.response) return gate.response;

  const resultado = await runZabbixSync(env, { userId: gate.user.id, source: "api" });
  if (!resultado.ok) return json(resultado, 502);

  await audit(env, request, gate.user, "ZABBIX_SYNC", "zabbix", String(resultado.run_id), null, {
    hosts: resultado.hosts, interfaces: resultado.interfaces
  });
  return json(resultado);
}

// GET /api/zabbix/hosts — hosts sincronizados, com contagem de interfaces.
async function handleZabbixHosts(env, request) {
  const gate = await requirePermission(env, request, "zabbix.view");
  if (gate.response) return gate.response;

  const rows = (await getDB(env).prepare(`
    SELECT
      h.*,
      (SELECT COUNT(*) FROM zabbix_interfaces i WHERE i.hostid=h.hostid) AS interfaces,
      (SELECT COUNT(*) FROM zabbix_interfaces i WHERE i.hostid=h.hostid AND i.oper_status=1) AS interfaces_up
    FROM zabbix_hosts h
    ORDER BY h.name
  `).all()).results;

  return json(rows);
}

// PATCH /api/zabbix/hosts/:hostid — vincula o host a um equipamento da topologia.
async function handleZabbixHostLink(env, request, hostid) {
  const gate = await requirePermission(env, request, "zabbix.link");
  if (gate.response) return gate.response;

  const db = getDB(env);
  const before = await db.prepare(`SELECT * FROM zabbix_hosts WHERE hostid=?`).bind(hostid).first();
  if (!before) return json({ error: "HOST_NAO_ENCONTRADO" }, 404);

  let body = {};
  try { body = await readJson(request, 16384); } catch {}

  // null/"" desfaz o vínculo e devolve o host ao match automático.
  const equipamentoId = body.equipamento_id ? String(body.equipamento_id).trim() : null;

  await db.prepare(`
    UPDATE zabbix_hosts SET equipamento_id=?, match_source=?, synced_at=CURRENT_TIMESTAMP
    WHERE hostid=?
  `).bind(equipamentoId, equipamentoId ? "manual" : null, hostid).run();

  const after = await db.prepare(`SELECT * FROM zabbix_hosts WHERE hostid=?`).bind(hostid).first();
  await audit(env, request, gate.user, "ZABBIX_HOST_LINK", "zabbix_host", hostid, before, after);

  return json(after);
}

// GET /api/zabbix/interfaces — inventário de interfaces, com filtros opcionais.
async function handleZabbixInterfaces(env, request, url) {
  const gate = await requirePermission(env, request, "zabbix.view");
  if (gate.response) return gate.response;

  const filters = [];
  const values = [];

  const equipamento = url.searchParams.get("equipamento");
  if (equipamento) { filters.push("h.equipamento_id=?"); values.push(equipamento); }

  const hostid = url.searchParams.get("hostid");
  if (hostid) { filters.push("i.hostid=?"); values.push(hostid); }

  const status = url.searchParams.get("status");
  if (status === "up") filters.push("i.oper_status=1");
  if (status === "down") filters.push("i.oper_status=2");

  // `conectadas` mostra apenas interfaces com enlace documentado no alias.
  if (url.searchParams.get("conectadas") === "1") filters.push("i.if_alias<>''");

  const search = url.searchParams.get("q");
  if (search) {
    filters.push("(i.if_name LIKE ? OR i.if_alias LIKE ?)");
    values.push(`%${search}%`, `%${search}%`);
  }

  const where = filters.length ? `WHERE ${filters.join(" AND ")}` : "";
  const limit = boundedInteger(url.searchParams.get("limit"), 1000, 1, 5000);

  const rows = (await getDB(env).prepare(`
    SELECT
      i.*,
      h.name AS host_name,
      h.equipamento_id
    FROM zabbix_interfaces i
    JOIN zabbix_hosts h ON h.hostid=i.hostid
    ${where}
    ORDER BY h.name, i.if_index
    LIMIT ?
  `).bind(...values, limit).all()).results;

  return json(rows);
}

// GET /api/zabbix/status — resumo da última sincronização.
async function handleZabbixStatus(env, request) {
  const gate = await requirePermission(env, request, "zabbix.view");
  if (gate.response) return gate.response;

  const db = getDB(env);
  const lastRun = await db.prepare(`
    SELECT * FROM zabbix_sync_runs ORDER BY id DESC LIMIT 1
  `).first();

  const totals = await db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM zabbix_hosts) AS hosts,
      (SELECT COUNT(*) FROM zabbix_hosts WHERE equipamento_id IS NOT NULL) AS hosts_vinculados,
      (SELECT COUNT(*) FROM zabbix_interfaces) AS interfaces,
      (SELECT COUNT(*) FROM zabbix_interfaces WHERE oper_status=1) AS interfaces_up,
      (SELECT COUNT(*) FROM zabbix_interfaces WHERE if_alias<>'') AS interfaces_documentadas
  `).first();

  return json({ last_run: lastRun || null, totals });
}

/**
 * Inventário no formato que deriveLinks() espera, lido do D1 (espelho da última
 * sincronização) em vez do Zabbix: é uma consulta local e barata.
 */
async function loadInventoryFromDb(db) {
  const hosts = (await db.prepare(`
    SELECT hostid, host, name, status, available, snmp_ip, equipamento_id, match_source
    FROM zabbix_hosts
  `).all()).results || [];

  const interfaces = (await db.prepare(`
    SELECT hostid, if_index, if_name, if_alias, if_type, oper_status,
           speed_bps, in_bps, out_bps, in_errors, out_errors, last_clock
    FROM zabbix_interfaces
  `).all()).results || [];

  return { hosts, interfaces };
}

/* Enlaces em formato de resposta, a partir de um inventário já carregado. A
   visão geral do painel monta enlaces e interfaces na mesma leitura do D1, em
   vez de varrer zabbix_interfaces duas vezes por atualização de tela. */
function buildLinksPayload(inventory) {
  const equipOf = new Map(inventory.hosts.map(h => [String(h.hostid), h.equipamento_id]));
  const nameOf = new Map(inventory.hosts.map(h => [String(h.hostid), h.name]));

  const links = deriveLinks(inventory).map(l => ({
    confianca: l.confidence,
    capacidade: capacityLabel(l.a.speed_bps),
    tipo: linkKind(l.a.if_alias, l.b.if_alias),
    familia: l.family,
    a: {
      hostid: String(l.a.hostid), host: nameOf.get(String(l.a.hostid)),
      equipamento_id: equipOf.get(String(l.a.hostid)) || null,
      interface: l.a.if_name, descricao: l.a.if_alias,
      oper_status: l.a.oper_status, speed_bps: l.a.speed_bps,
      in_bps: l.a.in_bps, out_bps: l.a.out_bps
    },
    b: {
      hostid: String(l.b.hostid), host: nameOf.get(String(l.b.hostid)),
      equipamento_id: equipOf.get(String(l.b.hostid)) || null,
      interface: l.b.if_name, descricao: l.b.if_alias,
      oper_status: l.b.oper_status, speed_bps: l.b.speed_bps,
      in_bps: l.b.in_bps, out_bps: l.b.out_bps
    }
  }));

  return {
    total: links.length,
    alta: links.filter(l => l.confianca === "alta").length,
    media: links.filter(l => l.confianca === "media").length,
    links
  };
}

// GET /api/zabbix/links — enlaces físicos derivados das descrições de interface.
async function handleZabbixLinks(env, request) {
  const gate = await requirePermission(env, request, "zabbix.view");
  if (gate.response) return gate.response;

  return json(buildLinksPayload(await loadInventoryFromDb(getDB(env))));
}

/**
 * GET /api/zabbix/utilizacao — carga por interface, no recorte mínimo que os
 * mapas precisam para pintar os enlaces.
 *
 * Os mapas releem isto de minuto em minuto enquanto estão abertos, então a
 * resposta traz só as cinco colunas que viram cor e dica — nada de alias,
 * nome de host ou erros, que os painéis já buscam em outro lugar. A chave é o
 * par (hostid, if_index): é o mesmo par que a projeção do inventário grava em
 * cada porta da topologia, e é por ele que a linha do mapa acha sua medida.
 *
 * A leitura é do espelho no D1, não do Zabbix: o cron reescreve o espelho a
 * cada 5 minutos, e uma tela aberta não deve virar carga na API do Zabbix.
 */
async function handleZabbixUtilizacao(env, request, url) {
  const gate = await requirePermission(env, request, "zabbix.view");
  if (gate.response) return gate.response;

  const db = getDB(env);
  const settings = await loadTrafegoSettings(db);
  const tempoReal = url.searchParams.get("realtime") === "1";

  let linhas = null;
  let coletadoEm = null;
  let fonte = "espelho";

  /* Com `realtime=1` a resposta sai da leitura ao vivo do Zabbix (mesma
     fotografia do painel de Tráfego, pelo cache da borda). Se a coleta ao vivo
     falhar ou não estiver configurada, cai no espelho persistido: a tela nunca
     fica sem número porque a API do Zabbix travou. */
  if (tempoReal) {
    const realtime = await lerInventarioTempoReal(env, request, settings);
    if (realtime?.inventory) {
      linhas = realtime.inventory.interfaces;
      coletadoEm = realtime.collected_at;
      fonte = "realtime";
    }
  }

  if (linhas === null) {
    const [lidas, ultima] = await Promise.all([
      db.prepare(`
        SELECT hostid, if_index, oper_status, speed_bps, in_bps, out_bps
        FROM zabbix_interfaces
      `).all(),
      db.prepare(`
        SELECT finished_at FROM zabbix_sync_runs WHERE ok=1 ORDER BY id DESC LIMIT 1
      `).first()
    ]);
    linhas = lidas.results || [];
    coletadoEm = ultima?.finished_at || null;
  }

  return json({
    coletado_em: coletadoEm,
    fonte,
    interfaces: linhas.map(i => ({
      hostid: String(i.hostid),
      if_index: Number(i.if_index),
      oper_status: i.oper_status === null || i.oper_status === undefined ? null : Number(i.oper_status),
      speed_bps: Number(i.speed_bps) || 0,
      in_bps: Number(i.in_bps) || 0,
      out_bps: Number(i.out_bps) || 0
    }))
  });
}

// ---------------------------------------------------------------------------
// Painel de tráfego
// ---------------------------------------------------------------------------

/* Ajustes do painel. Ficam em platform_meta porque são configuração de tela —
   não fazem parte da topologia e não têm por que arrastar os ~50 KB dela a
   cada gravação. Quem lê precisa de zabbix.view; quem grava, de
   trafego.settings. */
const TRAFEGO_SETTINGS_KEY = "trafego.settings";

const DEFAULT_TRAFEGO_SETTINGS = {
  titulo: "Tráfego da rede",
  limiteAtencao: 70,
  limiteCritico: 85,
  intervaloSegundos: 15,
  toleranciaLeitura: 1.05,
  topN: 10,
  historicoHoras: 6,
  tvPaineis: ["kpis", "fluxo", "top", "alertas"],
  tvRotacaoSegundos: 20,
  // Percentual aplicado à tipografia do modo TV. 100 é calibrado para 55" a
  // ~4 m; telas maiores, mais distantes ou em 4K pedem ajuste sem tocar no CSS.
  tvZoom: 100,
  interfaces: {}
};

const TV_PAINEIS_VALIDOS = ["kpis", "fluxo", "top", "alertas", "enlaces", "equipamentos"];

const limitaNumero = (valor, minimo, maximo, padrao) => {
  const n = Number(valor);
  return Number.isFinite(n) ? Math.min(Math.max(n, minimo), maximo) : padrao;
};

const textoCurto = (valor, maximo) => String(valor ?? "").trim().slice(0, maximo);

/* O servidor nunca confia no que o cliente manda: cada campo volta normalizado
   dentro de um intervalo que faz sentido operacional. Limite crítico abaixo do
   de atenção inverteria as cores do painel, então ele é empurrado para cima. */
export function normalizeTrafegoSettings(entrada = {}) {
  const base = { ...DEFAULT_TRAFEGO_SETTINGS };
  const atencao = limitaNumero(entrada.limiteAtencao, 1, 99, base.limiteAtencao);
  const critico = Math.max(atencao + 1, limitaNumero(entrada.limiteCritico, 2, 100, base.limiteCritico));

  const paineis = Array.isArray(entrada.tvPaineis)
    ? [...new Set(entrada.tvPaineis.filter(p => TV_PAINEIS_VALIDOS.includes(p)))]
    : base.tvPaineis;

  const interfaces = {};
  const entradas = Object.entries(entrada.interfaces || {}).slice(0, 2000);
  for (const [chave, valor] of entradas) {
    if (!/^\d+:\d+$/.test(chave) || !valor || typeof valor !== "object") continue;
    // `apelido` existia antes de a tela permitir editar o campo Interface.
    // Aceitá-lo aqui migra os registros antigos sem perder personalizações.
    const nomeInterface = textoCurto(valor.interface ?? valor.apelido, 80);
    const temDescricao = Object.prototype.hasOwnProperty.call(valor, "descricao");
    // String vazia é válida: permite limpar a descrição exibida sem alterar o
    // ifAlias bruto que será atualizado novamente na próxima sincronização.
    const descricao = temDescricao ? textoCurto(valor.descricao, 200) : undefined;
    const nota = textoCurto(valor.nota, 200);
    const critica = valor.critica === true;
    const ignorar = valor.ignorar === true;
    // Entrada sem nenhum dado útil não ocupa espaço no registro.
    if (!nomeInterface && !temDescricao && !nota && !critica && !ignorar) continue;
    interfaces[chave] = {
      interface: nomeInterface,
      ...(temDescricao ? { descricao } : {}),
      nota,
      critica,
      ignorar
    };
  }

  return {
    titulo: textoCurto(entrada.titulo, 60) || base.titulo,
    limiteAtencao: atencao,
    limiteCritico: critico,
    intervaloSegundos: limitaNumero(entrada.intervaloSegundos, 15, 900, base.intervaloSegundos),
    toleranciaLeitura: limitaNumero(entrada.toleranciaLeitura, 1, 5, base.toleranciaLeitura),
    topN: limitaNumero(entrada.topN, 3, 50, base.topN),
    historicoHoras: limitaNumero(entrada.historicoHoras, 1, 168, base.historicoHoras),
    tvPaineis: paineis.length ? paineis : base.tvPaineis,
    tvRotacaoSegundos: limitaNumero(entrada.tvRotacaoSegundos, 0, 300, base.tvRotacaoSegundos),
    tvZoom: limitaNumero(entrada.tvZoom, 60, 220, base.tvZoom),
    interfaces
  };
}

async function loadTrafegoSettings(db) {
  try {
    const row = await db.prepare(`SELECT value FROM platform_meta WHERE key=?`)
      .bind(TRAFEGO_SETTINGS_KEY).first();
    if (!row?.value) return { ...DEFAULT_TRAFEGO_SETTINGS };
    return normalizeTrafegoSettings(JSON.parse(row.value));
  } catch {
    // Registro ausente ou corrompido não pode derrubar o painel.
    return { ...DEFAULT_TRAFEGO_SETTINGS };
  }
}

async function handleTrafegoSettings(env, request) {
  if (request.method === "GET") {
    const gate = await requirePermission(env, request, "zabbix.view");
    if (gate.response) return gate.response;
    const settings = await loadTrafegoSettings(getDB(env));
    const permissoes = await permissionsOf(env, gate.user);
    return json({ settings, podeEditar: permissoes.has("trafego.settings"), padrao: DEFAULT_TRAFEGO_SETTINGS });
  }

  const gate = await requirePermission(env, request, "trafego.settings");
  if (gate.response) return gate.response;

  let body;
  try { body = await readJson(request, 262144); } catch { return json({ error: "JSON_INVALIDO" }, 400); }

  const db = getDB(env);
  const antes = await loadTrafegoSettings(db);
  const depois = normalizeTrafegoSettings(body?.settings ?? body);

  await db.prepare(`
    INSERT OR REPLACE INTO platform_meta(key,value,updated_at) VALUES (?,?,CURRENT_TIMESTAMP)
  `).bind(TRAFEGO_SETTINGS_KEY, JSON.stringify(depois)).run();

  await audit(env, request, gate.user, "TRAFEGO_SETTINGS_UPDATE", "trafego", "settings", antes, depois);
  return json({ ok: true, settings: depois, podeEditar: true });
}

// GET /api/zabbix/history — série agregada do tráfego (uma amostra por ciclo).
async function handleZabbixHistory(env, request, url) {
  const gate = await requirePermission(env, request, "zabbix.view");
  if (gate.response) return gate.response;

  const horas = boundedInteger(url.searchParams.get("horas"), 6, 1, 168);
  const amostras = (await getDB(env).prepare(`
    SELECT taken_at, in_bps, out_bps, interfaces_total, interfaces_up, interfaces_saturadas, erros
    FROM zabbix_traffic_snapshots
    WHERE taken_at >= datetime('now', ?)
    ORDER BY taken_at
    LIMIT 2000
  `).bind(`-${horas} hours`).all()).results || [];

  return json({ horas, amostras });
}

/* Leitura ao vivo do Zabbix, com cache curto na borda. O painel de Tráfego
   (overview) e a topologia (utilizacao) pedem o mesmo inventário a cada
   poucos segundos; o cache reúne as telas abertas no mesmo local durante uma
   janela curta, para a API do Zabbix responder uma vez e todos lerem a mesma
   fotografia. A coleta ao vivo não regrava centenas de interfaces no D1 a cada
   15 s: o cron continua cuidando do espelho persistente e do histórico. */
async function lerInventarioTempoReal(env, request, settings) {
  if (!env.ZABBIX_URL || !env.ZABBIX_TOKEN) return null;
  try {
    const cacheKey = new Request(new URL("/__internal/zabbix-realtime", request.url), { method: "GET" });
    const edgeCache = caches.default;
    const cached = await edgeCache.match(cacheKey);
    if (cached) return await cached.json();

    const realtime = {
      collected_at: new Date().toISOString(),
      inventory: await fetchNetworkInventory(env)
    };
    await edgeCache.put(cacheKey, new Response(JSON.stringify(realtime), {
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": `public, max-age=${Math.max(10, settings.intervaloSegundos - 2)}`
      }
    }));
    return realtime;
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * GET /api/zabbix/overview — tudo o que o painel de tráfego precisa para o
 * primeiro desenho, em uma requisição só.
 *
 * Antes a tela abria com três chamadas (interfaces, links, status) e cada uma
 * relia zabbix_interfaces inteira; a de enlaces relia mais uma vez do lado do
 * servidor. Aqui a leitura acontece uma vez e alimenta os dois recortes, o que
 * tira dois RTTs e duas varreduras do caminho crítico da abertura da tela.
 */
async function handleZabbixOverview(env, request, url) {
  const gate = await requirePermission(env, request, "zabbix.view");
  if (gate.response) return gate.response;

  const db = getDB(env);
  const settings = await loadTrafegoSettings(db);
  const horas = boundedInteger(url.searchParams.get("horas"), settings.historicoHoras, 1, 168);

  const realtimeRequested = url.searchParams.get("realtime") === "1";
  const realtime = realtimeRequested
    ? await lerInventarioTempoReal(env, request, settings)
    : null;

  const [persistedInventory, lastRun, historico, permissoes] = await Promise.all([
    loadInventoryFromDb(db),
    db.prepare(`SELECT * FROM zabbix_sync_runs ORDER BY id DESC LIMIT 1`).first(),
    db.prepare(`
      SELECT taken_at, in_bps, out_bps, interfaces_total, interfaces_up, interfaces_saturadas, erros
      FROM zabbix_traffic_snapshots
      WHERE taken_at >= datetime('now', ?)
      ORDER BY taken_at
      LIMIT 2000
    `).bind(`-${horas} hours`).all(),
    permissionsOf(env, gate.user)
  ]);

  let inventory = persistedInventory;
  if (realtime?.inventory) {
    /* Vínculos manuais pertencem à aplicação e não ao Zabbix. Eles precisam
       prevalecer também sobre a leitura ao vivo, exatamente como no espelho. */
    const persistedHosts = new Map(persistedInventory.hosts.map(h => [String(h.hostid), h]));
    inventory = {
      hosts: realtime.inventory.hosts.map(host => {
        const persisted = persistedHosts.get(String(host.hostid));
        return persisted?.match_source === "manual"
          ? { ...host, equipamento_id: persisted.equipamento_id, match_source: "manual" }
          : host;
      }),
      interfaces: realtime.inventory.interfaces
    };
  }

  const hostById = new Map(inventory.hosts.map(h => [String(h.hostid), h]));
  const interfaces = inventory.interfaces.map(i => {
    const host = hostById.get(String(i.hostid));
    return { ...i, hostid: String(i.hostid), host_name: host?.name || null, equipamento_id: host?.equipamento_id || null };
  });

  return json({
    settings,
    podeEditarSettings: permissoes.has("trafego.settings"),
    status: {
      last_run: realtime?.inventory ? {
        started_at: realtime.collected_at.replace("T", " ").replace(/\.\d{3}Z$/, ""),
        finished_at: realtime.collected_at.replace("T", " ").replace(/\.\d{3}Z$/, ""),
        ok: 1,
        hosts_count: inventory.hosts.length,
        interfaces_count: inventory.interfaces.length,
        source: "realtime"
      } : lastRun || null,
      totals: {
        hosts: inventory.hosts.length,
        hosts_vinculados: inventory.hosts.filter(h => h.equipamento_id).length,
        interfaces: interfaces.length,
        interfaces_up: interfaces.filter(i => i.oper_status === 1).length,
        interfaces_documentadas: interfaces.filter(i => i.if_alias).length
      }
    },
    hosts: inventory.hosts.map(h => ({
      hostid: String(h.hostid), host: h.host, name: h.name,
      equipamento_id: h.equipamento_id, match_source: h.match_source,
      status: h.status, available: h.available
    })),
    interfaces,
    enlaces: buildLinksPayload(inventory),
    historico: { horas, amostras: historico.results || [] },
    realtime: {
      requested: realtimeRequested,
      ok: Boolean(realtime?.inventory),
      collected_at: realtime?.collected_at || null,
      error: realtime?.error || null
    }
  });
}

/**
 * POST /api/zabbix/topology/apply — projeta o inventário do Zabbix na topologia.
 *
 * Por padrão é um ensaio (dry run): devolve o relatório sem gravar nada. Só
 * grava com { "aplicar": true } no corpo, e nesse caso exige as mesmas ações
 * que uma edição manual equivalente exigiria.
 */
async function handleZabbixApplyTopology(env, request) {
  const gate = await requirePermission(env, request, "topology.link.create");
  if (gate.response) return gate.response;
  if (!(await hasPermission(env, gate.user, "topology.port.edit"))) {
    return json({ error: "FORBIDDEN", permission: "topology.port.edit" }, 403);
  }

  let body = {};
  try { body = await readJson(request, 262144); } catch {}
  const aplicar = body.aplicar === true;

  const db = getDB(env);
  const inventory = await loadInventoryFromDb(db);
  if (!inventory.interfaces.length) {
    return json({ error: "SEM_INVENTARIO", hint: "Rode a sincronização do Zabbix antes." }, 400);
  }

  const row = await ensureTopologyState(env, request);
  const before = JSON.parse(row.data_json);
  const links = deriveLinks(inventory);
  const { topology: after, relatorio } = applyZabbixToTopology(before, inventory, links);

  const removidas = relatorio.conexoes.descartadas.length;
  if (removidas && !(await hasPermission(env, gate.user, "topology.link.delete"))) {
    return json({
      error: "FORBIDDEN",
      permission: "topology.link.delete",
      motivo: `A projeção substitui ${removidas} enlace(s) já documentado(s).`
    }, 403);
  }

  const resumo = {
    equipamentos_reconstruidos: relatorio.portas.length,
    conexoes_antes: (before.conexoes || []).length,
    conexoes_depois: after.conexoes.length,
    derivadas: relatorio.conexoes.derivadas.length,
    externas: relatorio.conexoes.externas.length,
    preservadas: relatorio.conexoes.preservadas.length,
    descartadas: removidas
  };

  if (!aplicar) {
    return json({ ok: true, aplicado: false, resumo, relatorio });
  }

  const nextVersion = Number(row.version || 0) + 1;
  await db.prepare(`
    UPDATE topology_state
    SET data_json=?, version=?, updated_at=CURRENT_TIMESTAMP, updated_by=?
    WHERE id=1
  `).bind(JSON.stringify(after), nextVersion, gate.user.id).run();

  await audit(env, request, gate.user, "ZABBIX_TOPOLOGY_APPLY", "topology", "1", before, after, {
    version_before: row.version, version_after: nextVersion, resumo, relatorio
  });

  return json({ ok: true, aplicado: true, version: nextVersion, resumo, relatorio });
}

async function handleZabbix(request, env, url) {
  if (url.pathname === "/api/zabbix/health" && request.method === "GET")
    return handleZabbixHealth(env, request);

  if (url.pathname === "/api/zabbix/sync" && request.method === "POST")
    return handleZabbixSync(env, request);

  if (url.pathname === "/api/zabbix/status" && request.method === "GET")
    return handleZabbixStatus(env, request);

  if (url.pathname === "/api/zabbix/hosts" && request.method === "GET")
    return handleZabbixHosts(env, request);

  const hostMatch = url.pathname.match(/^\/api\/zabbix\/hosts\/(\d+)$/);
  if (hostMatch && request.method === "PATCH")
    return handleZabbixHostLink(env, request, hostMatch[1]);

  if (url.pathname === "/api/zabbix/interfaces" && request.method === "GET")
    return handleZabbixInterfaces(env, request, url);

  if (url.pathname === "/api/zabbix/links" && request.method === "GET")
    return handleZabbixLinks(env, request);

  if (url.pathname === "/api/zabbix/utilizacao" && request.method === "GET")
    return handleZabbixUtilizacao(env, request, url);

  if (url.pathname === "/api/zabbix/topology/apply" && request.method === "POST")
    return handleZabbixApplyTopology(env, request);

  if (url.pathname === "/api/zabbix/overview" && request.method === "GET")
    return handleZabbixOverview(env, request, url);

  if (url.pathname === "/api/zabbix/history" && request.method === "GET")
    return handleZabbixHistory(env, request, url);

  return json({ error: "Endpoint Zabbix não encontrado." }, 404);
}



// ---------------------------------------------------------------------------
// Home — a tela de abertura da plataforma
// ---------------------------------------------------------------------------

/* A home não inventa número nenhum: os clientes vêm do mesmo snapshot da OLT
   que a tela GPON lê, o tráfego vem do espelho do Zabbix que o painel de
   Tráfego usa e os alertas nascem das mesmas regras daquele painel.

   A diferença é que aqui os alertas ficam gravados. "Ainda não visto por este
   usuário" é informação por pessoa: precisa sobreviver ao recarregamento da
   página, à troca de navegador e ao fato de o painel de tráfego derivar a lista
   inteira do zero a cada leitura. Por isso cada alerta tem uma impressão
   digital estável, o que some do ciclo é marcado como resolvido, e a leitura é
   uma linha por (alerta, usuário). */

const ALERTAS_RETENCAO_DIAS = 7;
const ALERTAS_INTERVALO_MS = 60000;   // no máximo uma derivação por minuto
const ALERTAS_LIMITE_CICLO = 200;     // teto do lote gravado por ciclo
const ALERTAS_GERACAO_KEY = "alerts.generated_at";
/* Comentário de fechamento: cabe um parágrafo do plantão, não um relatório. */
const ALERTAS_COMENTARIO_MAX = 600;
const ALERTAS_COMENTARIOS_POR_ALERTA = 5;
const ORIGEM_REDE = "rede";
const PESO_GRAU = { critico: 0, atencao: 1, info: 2 };

/* Um cliente é contado como online quando a OLT diz que ele está. O coletor
   normaliza a fase da ONU para "online"; qualquer outra coisa (los, dyinggasp,
   offline, powerfail) é ausência de serviço e entra em offline — assim os três
   números continuam somando o total, que é como o NOC lê o painel. */
const CLIENTE_ONLINE = /^(online|up|ativo|ativa|working|ok|conectado)$/;

export function resumirClientesGpon(clientes = []) {
  const total = clientes.length;
  const online = clientes.filter((c) =>
    CLIENTE_ONLINE.test(String(c?.status ?? "").trim().toLowerCase())).length;
  return { total, online, offline: total - online };
}

/* O SQLite grava "YYYY-MM-DD HH:MM:SS" em UTC; quando quem grava é o Worker,
   vem ISO com Z. As duas formas precisam virar o mesmo instante. */
function instanteDe(valor) {
  const texto = String(valor ?? "").trim();
  if (!texto) return null;
  const iso = texto.includes("T") ? texto : `${texto.replace(" ", "T")}Z`;
  const t = Date.parse(/Z$|[+-]\d{2}:?\d{2}$/.test(iso) ? iso : `${iso}Z`);
  return Number.isFinite(t) ? t : null;
}

/**
 * Tráfego do período: o de agora, o menor e o volume total transportado.
 *
 * `atualBps` chega pronto de quem acabou de ler as interfaces — essa leitura é
 * mais nova que a última amostra agregada. Sem ele, a última amostra responde.
 *
 * `total_bytes` é a integral da série: bits/s ao longo do tempo viram bytes.
 * Um intervalo maior que `limiteIntervaloSegundos` é coleta interrompida e não
 * é integrado — preencher esse buraco seria inventar tráfego que ninguém mediu.
 */
export function resumirTrafego(amostras = [], { atualBps = null, limiteIntervaloSegundos = 900 } = {}) {
  const serie = amostras
    .map((a) => ({
      em: a.taken_at,
      ms: instanteDe(a.taken_at),
      entrada: Number(a.in_bps) || 0,
      saida: Number(a.out_bps) || 0,
      bps: (Number(a.in_bps) || 0) + (Number(a.out_bps) || 0)
    }))
    .filter((a) => a.ms !== null);

  const ultima = serie.length ? serie[serie.length - 1] : null;
  const atual = atualBps !== null && Number.isFinite(Number(atualBps))
    ? Number(atualBps)
    : (ultima?.bps ?? 0);

  let minimo = null;
  let maximo = null;
  let bytes = 0;
  for (let i = 0; i < serie.length; i++) {
    const bps = serie[i].bps;
    if (minimo === null || bps < minimo) minimo = bps;
    if (maximo === null || bps > maximo) maximo = bps;
    if (i === 0) continue;
    const segundos = (serie[i].ms - serie[i - 1].ms) / 1000;
    if (segundos <= 0 || segundos > limiteIntervaloSegundos) continue;
    bytes += (((serie[i].bps + serie[i - 1].bps) / 2) * segundos) / 8;
  }

  return {
    atual,
    minimo: minimo ?? 0,
    maximo: maximo ?? 0,
    total_bytes: Math.round(bytes),
    entrada: ultima?.entrada ?? 0,
    saida: ultima?.saida ?? 0,
    amostras: serie.length,
    coletado_em: ultima?.em || null,
    serie: compactarSerie(serie, 120)
  };
}

/* A miniatura da home tem pouco mais de cem pixels de largura útil: mandar
   2 000 pontos por ela só engorda a resposta. A redução mantém o pico de cada
   balde, que é o que dá forma à curva de tráfego. */
export function compactarSerie(serie = [], maximoPontos = 120) {
  if (serie.length <= maximoPontos) return serie.map((p) => ({ em: p.em, bps: p.bps }));
  const passo = serie.length / maximoPontos;
  const saida = [];
  for (let i = 0; i < maximoPontos; i++) {
    const inicio = Math.floor(i * passo);
    const fim = Math.min(serie.length, Math.max(inicio + 1, Math.floor((i + 1) * passo)));
    let melhor = serie[inicio];
    for (let j = inicio; j < fim; j++) if (serie[j].bps > melhor.bps) melhor = serie[j];
    saida.push({ em: melhor.em, bps: melhor.bps });
  }
  return saida;
}

/* Mesmo formato do painel de tráfego, para que o mesmo número não apareça com
   duas caras diferentes em telas vizinhas. */
function formatarBps(valor) {
  const n = Number(valor);
  if (!Number.isFinite(n) || n <= 0) return "—";
  const unidades = ["bps", "Kbps", "Mbps", "Gbps", "Tbps"];
  const i = Math.min(Math.floor(Math.log10(n) / 3), unidades.length - 1);
  const escala = n / 1000 ** i;
  return `${escala >= 100 ? Math.round(escala) : escala.toFixed(escala >= 10 ? 1 : 2)} ${unidades[i]}`;
}

/**
 * Alertas da rede, derivados do inventário do Zabbix com as mesmas regras do
 * painel de tráfego — enlace fora do ar primeiro, depois o que está prestes a
 * sair, depois o que atrapalha a leitura.
 *
 * A impressão digital identifica o alerta ao longo do tempo. O grau entra nela
 * de propósito: quando uma interface passa de "utilização alta" para
 * "saturação", o evento é outro e volta a aparecer como não visto, mesmo para
 * quem já tinha lido o aviso anterior.
 */
export function derivarAlertasDaRede(inventario = {}, settings = DEFAULT_TRAFEGO_SETTINGS) {
  const hosts = inventario.hosts || [];
  const interfaces = inventario.interfaces || [];
  const ajustes = settings.interfaces || {};

  const chaveDe = (i) => `${i.hostid}:${i.if_index}`;
  const ajusteDe = (i) => ajustes[chaveDe(i)] || null;
  const ignorada = (i) => Boolean(ajusteDe(i)?.ignorar);
  const rotuloInterface = (i) => ajusteDe(i)?.interface || i.if_name || "—";
  const descricaoInterface = (i) => {
    const ajuste = ajusteDe(i);
    return ajuste && Object.hasOwn(ajuste, "descricao") ? ajuste.descricao : (i.if_alias || "");
  };

  const nomeDoHost = new Map(hosts.map((h) => [String(h.hostid), h.equipamento_id || h.name || h.host || "?"]));
  const equipamentoDe = (i) => nomeDoHost.get(String(i.hostid)) || "?";
  const carga = (i) => Math.max(Number(i.in_bps) || 0, Number(i.out_bps) || 0);
  const capacidade = (i) => Number(i.speed_bps) || 0;
  const leituraValida = (i) => !(capacidade(i) > 0 && carga(i) > capacidade(i) * settings.toleranciaLeitura);
  const utilizacao = (i) => (capacidade(i) > 0 && leituraValida(i) ? (carga(i) * 100) / capacidade(i) : null);

  const lista = [];
  const enlaces = deriveLinks({ hosts, interfaces });
  const emEnlace = new Set();

  for (const l of enlaces) {
    emEnlace.add(chaveDe(l.a));
    emEnlace.add(chaveDe(l.b));
    if (l.a.oper_status === 1 && l.b.oper_status === 1) continue;
    const lado = l.a.oper_status !== 1 ? l.a : l.b;
    lista.push({
      fingerprint: `rede:enlace-fora:${[chaveDe(l.a), chaveDe(l.b)].sort().join("::")}`,
      grau: "critico",
      titulo: `Enlace fora do ar — ${equipamentoDe(lado)} ${rotuloInterface(lado)}`,
      texto: `${equipamentoDe(l.a)} ${rotuloInterface(l.a)} ↔ ${equipamentoDe(l.b)} ${rotuloInterface(l.b)} • ${capacityLabel(l.a.speed_bps)}`,
      alvo_tipo: "trafego",
      alvo_chave: "enlaces"
    });
  }

  for (const i of interfaces) {
    if (ignorada(i)) continue;
    const u = utilizacao(i);
    if (u === null || u <= settings.limiteAtencao) continue;
    const grave = u > settings.limiteCritico;
    lista.push({
      fingerprint: `rede:utilizacao:${grave ? "critico" : "atencao"}:${chaveDe(i)}`,
      grau: grave ? "critico" : "atencao",
      titulo: `${grave ? "Saturação" : "Utilização alta"} — ${equipamentoDe(i)} ${rotuloInterface(i)}`,
      texto: `${descricaoInterface(i) || "sem descrição"} • ${formatarBps(carga(i))} de ${formatarBps(capacidade(i))} (${u.toFixed(1)}%)`,
      alvo_tipo: "trafego",
      alvo_chave: "interfaces"
    });
  }

  for (const i of interfaces) {
    // Interface descrita é interface que deveria estar servindo alguma coisa.
    if (ignorada(i) || i.oper_status !== 2 || !descricaoInterface(i)) continue;
    if (emEnlace.has(chaveDe(i))) continue;
    lista.push({
      fingerprint: `rede:descrita-fora:${chaveDe(i)}`,
      grau: "atencao",
      titulo: `Interface descrita e fora do ar — ${equipamentoDe(i)} ${rotuloInterface(i)}`,
      texto: `Descrição: ${descricaoInterface(i)}`,
      alvo_tipo: "trafego",
      alvo_chave: "interfaces"
    });
  }

  for (const i of interfaces) {
    if (ignorada(i) || leituraValida(i)) continue;
    lista.push({
      fingerprint: `rede:leitura-inconsistente:${chaveDe(i)}`,
      grau: "info",
      titulo: `Leitura inconsistente — ${equipamentoDe(i)} ${rotuloInterface(i)}`,
      texto: `O Zabbix informou ${formatarBps(carga(i))} numa porta de ${formatarBps(capacidade(i))}. Fora dos totais até a coleta se corrigir.`,
      alvo_tipo: "trafego",
      alvo_chave: "interfaces"
    });
  }

  const semVinculo = hosts.filter((h) => !h.equipamento_id).length;
  if (semVinculo) {
    lista.push({
      fingerprint: "rede:hosts-sem-equipamento",
      grau: "info",
      titulo: `${semVinculo} host monitorado sem equipamento vinculado`,
      texto: "O tráfego é contado, mas não aparece agrupado por equipamento. Vincule na guia Equipamentos do painel de tráfego.",
      alvo_tipo: "trafego",
      alvo_chave: "equipamentos"
    });
  }

  return lista.sort((a, b) => PESO_GRAU[a.grau] - PESO_GRAU[b.grau]).slice(0, ALERTAS_LIMITE_CICLO);
}

/**
 * Grava o ciclo de alertas de uma origem.
 *
 * O que voltou a aparecer é reaberto; o que sumiu do ciclo é resolvido — e não
 * apagado, para que quem ainda não abriu o sistema hoje não perca o registro.
 * Reabrir devolve o alerta à condição de não visto: as leituras anteriores
 * àquele momento são descartadas, porque o evento é outro.
 */
async function sincronizarAlertas(db, origem, lista) {
  const agora = new Date().toISOString();

  const statements = lista.map((a) => db.prepare(`
    INSERT INTO alerts(fingerprint,origem,grau,titulo,texto,alvo_tipo,alvo_chave,first_seen_at,last_seen_at)
    VALUES (?,?,?,?,?,?,?,?,?)
    ON CONFLICT(fingerprint) DO UPDATE SET
      grau=excluded.grau, titulo=excluded.titulo, texto=excluded.texto,
      alvo_tipo=excluded.alvo_tipo, alvo_chave=excluded.alvo_chave,
      last_seen_at=excluded.last_seen_at,
      reopened_at=CASE WHEN alerts.resolved_at IS NOT NULL
                       THEN excluded.last_seen_at ELSE alerts.reopened_at END,
      resolved_at=NULL
  `).bind(a.fingerprint, origem, a.grau, a.titulo, a.texto, a.alvo_tipo, a.alvo_chave, agora, agora));

  statements.push(db.prepare(`
    UPDATE alerts SET resolved_at=? WHERE origem=? AND resolved_at IS NULL AND last_seen_at<>?
  `).bind(agora, origem, agora));

  statements.push(db.prepare(`
    DELETE FROM alert_reads
    WHERE read_at < COALESCE((SELECT a.reopened_at FROM alerts a WHERE a.id=alert_reads.alert_id), '')
  `));

  const limite = new Date(Date.now() - ALERTAS_RETENCAO_DIAS * 86400000).toISOString();
  statements.push(db.prepare(`
    DELETE FROM alerts WHERE resolved_at IS NOT NULL AND resolved_at < ?
  `).bind(limite));

  await db.batch(statements);
  return lista.length;
}

/* Derivação sob demanda, limitada a uma vez por minuto. O cron de cinco minutos
   continua sendo o caminho normal; isto é o que faz a home funcionar em
   desenvolvimento e logo depois de um deploy, sem esperar o próximo ciclo. */
async function gerarAlertasDaRede(db, { inventario = null, settings = null, forcar = false } = {}) {
  if (!forcar) {
    const ultimo = await db.prepare(`SELECT value FROM platform_meta WHERE key=?`)
      .bind(ALERTAS_GERACAO_KEY).first();
    const quando = instanteDe(ultimo?.value);
    if (quando !== null && Date.now() - quando < ALERTAS_INTERVALO_MS) return false;
  }

  const ajustes = settings || await loadTrafegoSettings(db);
  const dados = inventario || await loadInventoryFromDb(db);
  await sincronizarAlertas(db, ORIGEM_REDE, derivarAlertasDaRede(dados, ajustes));
  await db.prepare(`
    INSERT OR REPLACE INTO platform_meta(key,value,updated_at) VALUES (?,?,CURRENT_TIMESTAMP)
  `).bind(ALERTAS_GERACAO_KEY, new Date().toISOString()).run();
  return true;
}

/* Alertas abertos que este usuário ainda não abriu. A leitura é individual: o
   que um operador marcou como visto continua pendente para os colegas. */
async function alertasNaoVistos(db, userId, limite = 50) {
  const [naoVistos, abertos] = await Promise.all([
    db.prepare(`
      SELECT a.id, a.origem, a.grau, a.titulo, a.texto, a.alvo_tipo, a.alvo_chave,
             a.first_seen_at, a.last_seen_at
      FROM alerts a
      LEFT JOIN alert_reads r ON r.alert_id=a.id AND r.user_id=?
      WHERE a.resolved_at IS NULL AND r.alert_id IS NULL
      ORDER BY CASE a.grau WHEN 'critico' THEN 0 WHEN 'atencao' THEN 1 ELSE 2 END,
               a.last_seen_at DESC
      LIMIT ?
    `).bind(userId, limite).all(),
    db.prepare(`
      SELECT a.grau,
             COUNT(*) AS total,
             SUM(CASE WHEN r.alert_id IS NULL THEN 1 ELSE 0 END) AS nao_vistos
      FROM alerts a
      LEFT JOIN alert_reads r ON r.alert_id=a.id AND r.user_id=?
      WHERE a.resolved_at IS NULL
      GROUP BY a.grau
    `).bind(userId).all()
  ]);

  const porGrau = { critico: 0, atencao: 0, info: 0 };
  const abertosPorGrau = { critico: 0, atencao: 0, info: 0 };
  for (const linha of abertos.results || []) {
    const grau = Object.hasOwn(porGrau, linha.grau) ? linha.grau : "info";
    porGrau[grau] += Number(linha.nao_vistos) || 0;
    abertosPorGrau[grau] += Number(linha.total) || 0;
  }

  const lista = naoVistos.results || [];
  const comentarios = await comentariosDosAlertas(db, lista.map((a) => a.id));
  for (const alerta of lista) alerta.comentarios = comentarios.get(alerta.id) || [];

  return {
    total: porGrau.critico + porGrau.atencao + porGrau.info,
    abertos: abertosPorGrau.critico + abertosPorGrau.atencao + abertosPorGrau.info,
    por_grau: porGrau,
    abertos_por_grau: abertosPorGrau,
    lista
  };
}

/* Quem já deu baixa nestes alertas e deixou um comentário. É o que evita que
   dois plantonistas apurem a mesma coisa: o alerta continua pendente para quem
   não viu, mas chega com o que o colega já descobriu. */
async function comentariosDosAlertas(db, ids) {
  const mapa = new Map();
  if (!ids.length) return mapa;

  const marcadores = ids.map(() => "?").join(",");
  const { results } = await db.prepare(`
    SELECT r.alert_id, r.comentario, r.read_at, u.display_name AS autor
    FROM alert_reads r
    JOIN users u ON u.id=r.user_id
    WHERE r.comentario<>'' AND r.alert_id IN (${marcadores})
    ORDER BY r.read_at DESC
  `).bind(...ids).all();

  for (const linha of results || []) {
    const anteriores = mapa.get(linha.alert_id) || [];
    if (anteriores.length >= ALERTAS_COMENTARIOS_POR_ALERTA) continue;
    anteriores.push({ autor: linha.autor, comentario: linha.comentario, read_at: linha.read_at });
    mapa.set(linha.alert_id, anteriores);
  }
  return mapa;
}

/**
 * Clientes autenticados por status, sem abrir o snapshot inteiro da OLT.
 *
 * O caminho barato é a leitura compacta de status, que o coletor atualiza a
 * cada ciclo. Enquanto ela ainda não cobre todos os clientes — o intervalo
 * entre uma sincronização completa e o primeiro delta — o snapshot completo
 * responde, porque um total certo vale o custo dessa leitura ocasional.
 */
async function resumoClientesGpon(env) {
  const db = getDB(env);
  const estado = await db.prepare(`
    SELECT source, synced_at, clients_count FROM gpon_snapshot_state WHERE id=1
  `).first();

  if (estado) {
    const total = Number(estado.clients_count) || 0;
    const compacto = await db.prepare(`SELECT data_json, synced_at FROM gpon_status_snapshot WHERE id=1`).first();
    let linhas = [];
    if (compacto?.data_json) {
      try {
        const lido = JSON.parse(compacto.data_json);
        if (Array.isArray(lido)) linhas = lido;
      } catch { /* leitura corrompida cai no snapshot completo */ }
    }

    const base = {
      configurado: true,
      fonte: estado.source || "Coletor GPON",
      sincronizado_em: compacto?.synced_at || estado.synced_at || null
    };

    if (linhas.length >= total && total > 0) return { ...base, ...resumirClientesGpon(linhas) };

    try {
      const snapshot = await loadGponSnapshot(env);
      if (snapshot) return { ...base, ...resumirClientesGpon(snapshot.clients || []) };
    } catch (error) {
      console.error(JSON.stringify({ message: "Snapshot GPON indisponível para a home", error: error?.message || String(error) }));
    }
    return { ...base, parcial: true, ...resumirClientesGpon(linhas) };
  }

  // Sem snapshot no banco, resta a fonte direta — quando ela existe.
  if (!String(env.GPON_CLIENTS_URL || "").trim()) {
    return { configurado: false, fonte: null, sincronizado_em: null, total: 0, online: 0, offline: 0,
      mensagem: "O coletor ainda não enviou a primeira atualização GPON." };
  }
  const feed = await carregarFeedGpon(env);
  return {
    configurado: Boolean(feed?.configured),
    indisponivel: Boolean(feed?.unavailable),
    fonte: feed?.source || null,
    sincronizado_em: feed?.synced_at || null,
    mensagem: feed?.message || null,
    ...resumirClientesGpon(feed?.clients || [])
  };
}

/**
 * GET /api/home/overview — os três blocos da tela de abertura.
 *
 * Cada bloco respeita a permissão da tela de onde o dado vem: quem não pode
 * abrir o painel de tráfego também não vê os números dele aqui. O bloco volta
 * com `permitido:false` em vez de sumir, para a home explicar a ausência em vez
 * de deixar um buraco na tela.
 */
async function handleHomeOverview(env, request, url) {
  const user = await requireUser(env, request);
  if (!user) return json({ error: "AUTH_REQUIRED" }, 401);

  const db = getDB(env);
  const permissoes = await permissionsOf(env, user);
  const podeVerRede = permissoes.has("zabbix.view");
  const podeVerClientes = permissoes.has("topology.view");

  const settings = await loadTrafegoSettings(db);
  const horas = boundedInteger(url.searchParams.get("horas"), settings.historicoHoras, 1, 168);

  const [inventario, amostras, clientes] = await Promise.all([
    loadInventoryFromDb(db),
    db.prepare(`
      SELECT taken_at, in_bps, out_bps FROM zabbix_traffic_snapshots
      WHERE taken_at >= datetime('now', ?) ORDER BY taken_at LIMIT 2000
    `).bind(`-${horas} hours`).all(),
    podeVerClientes
      ? resumoClientesGpon(env).catch((error) => {
          console.error(JSON.stringify({ message: "Falha ao resumir clientes GPON", error: error?.message || String(error) }));
          return { configurado: true, indisponivel: true, total: 0, online: 0, offline: 0,
            mensagem: "A base de clientes não respondeu nesta atualização." };
        })
      : Promise.resolve(null)
  ]);

  /* A leitura de agora sai das interfaces espelhadas, mais novas que a última
     amostra agregada. A regra de validade é a mesma do painel de tráfego:
     porta lendo acima da própria capacidade fica fora dos totais. */
  let atualBps = 0;
  for (const i of inventario.interfaces) {
    const entrada = Number(i.in_bps) || 0;
    const saida = Number(i.out_bps) || 0;
    const capacidade = Number(i.speed_bps) || 0;
    if (capacidade > 0 && Math.max(entrada, saida) > capacidade * settings.toleranciaLeitura) continue;
    atualBps += entrada + saida;
  }

  await gerarAlertasDaRede(db, { inventario, settings }).catch((error) => {
    console.error(JSON.stringify({ message: "Falha ao derivar alertas da rede", error: error?.message || String(error) }));
  });

  const alertas = await alertasNaoVistos(db, user.id);

  return json({
    usuario: { id: user.id, nome: user.display_name || user.username, papel: user.role },
    clientes: podeVerClientes
      ? { permitido: true, ...clientes }
      : { permitido: false, total: 0, online: 0, offline: 0 },
    trafego: podeVerRede
      ? {
          permitido: true,
          horas,
          interfaces: inventario.interfaces.length,
          interfaces_up: inventario.interfaces.filter((i) => i.oper_status === 1).length,
          ...resumirTrafego(amostras.results || [], { atualBps })
        }
      : { permitido: false, horas, atual: 0, minimo: 0, maximo: 0, total_bytes: 0, serie: [] },
    alertas: { permitido: true, ...alertas }
  });
}

/**
 * POST /api/home/alerts/read — marca alertas como vistos por este usuário.
 *
 * Sem corpo marca tudo o que está aberto; com { "ids": [1,2] }, só os
 * informados. Marcar é sempre por usuário: nada some da fila dos colegas.
 *
 * `comentario` é opcional e registra o que a pessoa apurou ao dar baixa. Vai
 * junto de cada leitura gravada nesta chamada — inclusive quando a fila inteira
 * é marcada de uma vez, caso em que o mesmo texto vale para todos os alertas.
 */
async function handleAlertsRead(env, request) {
  const user = await requireUser(env, request);
  if (!user) return json({ error: "AUTH_REQUIRED" }, 401);

  let body = {};
  try { body = await readJson(request, 65536); } catch { body = {}; }

  const ids = Array.isArray(body.ids)
    ? body.ids.map((v) => Number(v)).filter((v) => Number.isInteger(v) && v > 0).slice(0, 500)
    : [];

  const comentario = String(body.comentario ?? "").trim().slice(0, ALERTAS_COMENTARIO_MAX);

  const db = getDB(env);
  const agora = new Date().toISOString();
  if (ids.length) {
    const marcadores = ids.map(() => "?").join(",");
    await db.prepare(`
      INSERT OR IGNORE INTO alert_reads(alert_id,user_id,read_at,comentario)
      SELECT id, ?, ?, ? FROM alerts WHERE resolved_at IS NULL AND id IN (${marcadores})
    `).bind(user.id, agora, comentario, ...ids).run();
  } else {
    await db.prepare(`
      INSERT OR IGNORE INTO alert_reads(alert_id,user_id,read_at,comentario)
      SELECT id, ?, ?, ? FROM alerts WHERE resolved_at IS NULL
    `).bind(user.id, agora, comentario).run();
  }

  return json({ ok: true, ...(await alertasNaoVistos(db, user.id)) });
}

function safeUserRow(u) {
  if (!u) return null;
  return {
    id:u.id, username:u.username, display_name:u.display_name, email:u.email || null,
    oauth_linked:Boolean(u.oauth_subject),
    role:u.role, active:!!u.active, must_change_password:!!u.must_change_password,
    sectors:Array.isArray(u.sectors)?u.sectors:[],
    created_at:u.created_at, updated_at:u.updated_at, last_login_at:u.last_login_at
  };
}

/* Consulta das telas que o usuário pode abrir.

   Os "?" do SQLite são posicionais: os de SCREENS_GLOBAIS aparecem no SELECT e
   vêm antes do perfil, no JOIN. Montar SQL e binds no mesmo lugar é o que
   impede a troca silenciosa entre eles — invertidos, a consulta comparava
   rs.role_id com 'clientes' e devolvia zero telas para todo mundo.

   O mestre não passa por role_screens: ele enxerga todo o catálogo ativo. */
export function consultaTelasDoAcesso({ mestre = false, roleId = null, globais = [...SCREENS_GLOBAIS] } = {}) {
  return {
    sql: `
    SELECT s.code,s.name,s.description,s.route,s.icon,s.sort,s.nav,
      COALESCE(sec.code,'noc') sector,
      CASE WHEN s.code IN (${globais.map(() => "?").join(",")}) THEN 1 ELSE 0 END global
    FROM screens s
    ${mestre ? "" : "JOIN role_screens rs ON rs.screen_id=s.id AND rs.role_id=?"}
    LEFT JOIN sectors sec ON sec.id=s.sector_id AND sec.active=1
    WHERE s.active=1 ORDER BY s.sort,s.id`,
    binds: [...globais, ...(mestre ? [] : [roleId])]
  };
}

async function handleAccess(env, request) {
  const user = await getCurrentUser(env, request);
  if (!user) return json({error:"AUTH_REQUIRED"},401);
  const db=getDB(env);
  const mestre=ehMestre(user);
  const permissions=mestre
    ? [...ALL_ACTION_CODES].sort()
    : (await db.prepare(`
        SELECT p.code FROM role_permissions rp JOIN permissions p ON p.id=rp.permission_id
        WHERE rp.role_id=? ORDER BY p.code
      `).bind(user.role_id).all()).results.map(x=>x.code);
  const telas=consultaTelasDoAcesso({mestre, roleId:user.role_id});
  const screens=(await db.prepare(telas.sql).bind(...telas.binds).all()).results;
  const sectors=(await db.prepare(`
    SELECT code,name,color,icon,sort FROM sectors WHERE active=1 ORDER BY sort,name
  `).all()).results || [];
  // Catálogo completo: o guardião de rotas precisa saber quais endereços são
  // telas do sistema para diferenciar "não existe" de "não é para você".
  const allScreens=(await db.prepare(`
    SELECT code,name,route,active FROM screens ORDER BY sort,id
  `).all()).results;
  return json({role:user.role,permissions,screens,sectors,allScreens});
}

const NOME_PERFIL = /^[a-z][a-z0-9_-]{2,40}$/;
const normalizaNomePerfil = (valor) => String(valor||"").trim().toLowerCase().replace(/\s+/g,"_");

async function handlePlatformRoles(env, request) {
  const gate=await requirePermission(env,request,"roles.view"); if(gate.response)return gate.response;
  const db=getDB(env);
  const roles=(await db.prepare(`
    SELECT r.id,r.name,r.description,(SELECT COUNT(*) FROM users u WHERE u.role_id=r.id) usuarios
    FROM roles r ORDER BY r.name
  `).all()).results;
  const permissions=(await db.prepare(`
    SELECT id,code,name,description,module,screen_code,sort FROM permissions ORDER BY module,sort,code
  `).all()).results;
  const screens=(await db.prepare(`
    SELECT id,code,name,description,route,active,icon,sort,nav,sector_id FROM screens ORDER BY sort,id
  `).all()).results;
  const rolePermissions=(await db.prepare(`SELECT role_id,permission_id FROM role_permissions`).all()).results;
  const roleScreens=(await db.prepare(`SELECT role_id,screen_id FROM role_screens`).all()).results;
  const sectors=await agendaSectors(db,gate.user.id,true);
  const permissoes=await permissionsOf(env,gate.user);
  return json({
    roles,permissions,screens,rolePermissions,roleScreens,sectors,
    protectedRole:PERFIL_PROTEGIDO,
    can:{
      manageRoles:permissoes.has("roles.manage"),
      manageScreens:permissoes.has("screens.manage"),
      viewUsers:permissoes.has("users.view"),
      manageUsers:permissoes.has("users.manage"),
      manageSectors:permissoes.has("sectors.manage"),
      resetPassword:permissoes.has("users.password"),
      viewAudit:permissoes.has("audit.view"),
      exportAudit:permissoes.has("audit.export")
    }
  });
}

async function handlePlatformRoleCreate(env,request) {
  const gate=await requirePermission(env,request,"roles.manage"); if(gate.response)return gate.response;
  const db=getDB(env); let body={}; try{body=await readJson(request,16384)}catch{}
  const name=normalizaNomePerfil(body.name);
  const description=String(body.description||"").trim();
  if(!NOME_PERFIL.test(name))return json({error:"NOME_PERFIL_INVALIDO"},400);
  try{
    const r=await db.prepare(`INSERT INTO roles(name,description) VALUES (?,?)`).bind(name,description).run();
    const after={id:r.meta.last_row_id,name,description,usuarios:0};
    await audit(env,request,gate.user,"ROLE_CREATE","role",after.id,null,after);
    return json(after,201);
  }catch{return json({error:"PERFIL_JA_EXISTE"},409)}
}

async function handlePlatformRoleUpdate(env,request,id) {
  const gate=await requirePermission(env,request,"roles.manage"); if(gate.response)return gate.response;
  const db=getDB(env);
  const before=await db.prepare(`SELECT id,name,description FROM roles WHERE id=?`).bind(id).first();
  if(!before)return json({error:"PERFIL_NAO_ENCONTRADO"},404);
  let body={};try{body=await readJson(request,16384)}catch{}

  const description=body.description===undefined?before.description:String(body.description).trim();
  let name=before.name;
  if(body.name!==undefined){
    const novo=normalizaNomePerfil(body.name);
    if(novo!==before.name){
      // O administrador é referência do sistema: renomeá-lo deixaria a
      // plataforma sem o perfil que garante a reabertura do acesso.
      if(before.name===PERFIL_PROTEGIDO)return json({error:"NAO_RENOMEIE_ADMINISTRADOR"},400);
      if(!NOME_PERFIL.test(novo))return json({error:"NOME_PERFIL_INVALIDO"},400);
      const existe=await db.prepare(`SELECT id FROM roles WHERE name=? AND id<>?`).bind(novo,id).first();
      if(existe)return json({error:"PERFIL_JA_EXISTE"},409);
      name=novo;
    }
  }

  await db.prepare(`UPDATE roles SET name=?,description=? WHERE id=?`).bind(name,description,id).run();
  const after=await db.prepare(`SELECT id,name,description FROM roles WHERE id=?`).bind(id).first();
  await audit(env,request,gate.user,"ROLE_UPDATE","role",id,before,after);
  return json(after);
}

async function handlePlatformRoleDelete(env,request,id) {
  const gate=await requirePermission(env,request,"roles.manage"); if(gate.response)return gate.response;
  const db=getDB(env);
  const before=await db.prepare(`SELECT id,name,description FROM roles WHERE id=?`).bind(id).first();
  if(!before)return json({error:"PERFIL_NAO_ENCONTRADO"},404);
  if(before.name===PERFIL_PROTEGIDO)return json({error:"NAO_EXCLUA_ADMINISTRADOR"},400);
  const c=await db.prepare(`SELECT COUNT(*) c FROM users WHERE role_id=?`).bind(id).first();
  if(Number(c?.c)>0)return json({error:"PERFIL_EM_USO"},400);
  await db.prepare(`DELETE FROM roles WHERE id=?`).bind(id).run();
  await audit(env,request,gate.user,"ROLE_DELETE","role",id,before,null);
  return json({ok:true});
}

async function handlePlatformRoleAccess(env,request,id) {
  const gate=await requirePermission(env,request,"roles.manage"); if(gate.response)return gate.response;
  const db=getDB(env); const role=await db.prepare(`SELECT id,name,description FROM roles WHERE id=?`).bind(id).first();
  if(!role)return json({error:"PERFIL_NAO_ENCONTRADO"},404);
  let body={};try{body=await readJson(request,65536)}catch{}
  let permissionIds=Array.isArray(body.permissionIds)?body.permissionIds.map(Number).filter(Number.isInteger):[];
  let screenIds=Array.isArray(body.screenIds)?body.screenIds.map(Number).filter(Number.isInteger):[];

  // O administrador mantém acesso total por definição do sistema.
  if(role.name===PERFIL_PROTEGIDO){
    permissionIds=((await db.prepare(`SELECT id FROM permissions`).all()).results||[]).map(x=>x.id);
    screenIds=((await db.prepare(`SELECT id FROM screens`).all()).results||[]).map(x=>x.id);
  }

  const before={
    permissions:(await db.prepare(`SELECT permission_id FROM role_permissions WHERE role_id=? ORDER BY permission_id`).bind(id).all()).results,
    screens:(await db.prepare(`SELECT screen_id FROM role_screens WHERE role_id=? ORDER BY screen_id`).bind(id).all()).results
  };
  const stmts=[
    db.prepare(`DELETE FROM role_permissions WHERE role_id=?`).bind(id),
    db.prepare(`DELETE FROM role_screens WHERE role_id=?`).bind(id),
    ...permissionIds.map(pid=>db.prepare(`INSERT OR IGNORE INTO role_permissions(role_id,permission_id) VALUES (?,?)`).bind(id,pid)),
    ...screenIds.map(sid=>db.prepare(`INSERT OR IGNORE INTO role_screens(role_id,screen_id) VALUES (?,?)`).bind(id,sid))
  ];
  await db.batch(stmts);
  const after={permissions:permissionIds.map(permission_id=>({permission_id})),screens:screenIds.map(screen_id=>({screen_id}))};
  await audit(env,request,gate.user,"ROLE_ACCESS_UPDATE","role",id,before,after);
  return json({ok:true,role,after});
}

async function handlePlatformScreen(env,request,id) {
  const gate=await requirePermission(env,request,"screens.manage"); if(gate.response)return gate.response;
  const db=getDB(env);
  const before=await db.prepare(`SELECT id,code,name,description,route,active,icon,sort,nav FROM screens WHERE id=?`).bind(id).first();
  if(!before)return json({error:"TELA_NAO_ENCONTRADA"},404);
  let body={};try{body=await readJson(request,16384)}catch{}
  const active=body.active===undefined?before.active:(body.active?1:0);
  // Desligar a tela de plataforma trancaria a porta com a chave dentro.
  if(before.code==="platform" && !active)return json({error:"NAO_DESATIVE_A_PLATAFORMA"},400);
  const after={...before,active};
  await db.prepare(`UPDATE screens SET active=? WHERE id=?`).bind(active,id).run();
  await audit(env,request,gate.user,"SCREEN_UPDATE","screen",id,before,after);
  return json(after);
}

async function handleUsers(env,request) {
  const gate=await requirePermission(env,request,"users.view"); if(gate.response)return gate.response;
  const db=getDB(env);
  const rows=(await db.prepare(`
    SELECT u.id,u.username,u.display_name,u.email,u.oauth_subject,u.active,u.must_change_password,u.created_at,u.updated_at,u.last_login_at,r.name role
    FROM users u JOIN roles r ON r.id=u.role_id ORDER BY u.username
  `).all()).results;
  const memberships=(await db.prepare(`
    SELECT us.user_id,s.id,s.code,s.name,s.color FROM user_sectors us JOIN sectors s ON s.id=us.sector_id
    ORDER BY s.name
  `).all()).results || [];
  for(const row of rows) row.sectors=memberships.filter(x=>x.user_id===row.id)
    .map(({id,code,name,color})=>({id,code,name,color}));
  return json(rows.map(safeUserRow));
}

async function handleUserCreate(env,request) {
  const gate=await requirePermission(env,request,"users.manage"); if(gate.response)return gate.response;
  const db=getDB(env); let b={};try{b=await readJson(request,16384)}catch{}
  const username=String(b.username||"").trim().toLowerCase();
  const displayName=String(b.display_name||username).trim();
  const email=String(b.email||"").trim().toLowerCase();
  const password=String(b.password||"");
  const role=String(b.role||"atendimento");
  const sectorIds=Array.isArray(b.sector_ids)?[...new Set(b.sector_ids.map(Number).filter(Number.isInteger))]:[];
  if(!/^[a-z0-9._-]{3,50}$/.test(username))return json({error:"USUARIO_INVALIDO"},400);
  if(email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))return json({error:"EMAIL_INVALIDO"},400);
  if(email && await db.prepare(`SELECT 1 FROM users WHERE lower(email)=? LIMIT 1`).bind(email).first())
    return json({error:"EMAIL_JA_CADASTRADO"},409);
  if(password.length<8)return json({error:"SENHA_DEVE_TER_8_CARACTERES"},400);
  const rr=await db.prepare(`SELECT id,name FROM roles WHERE name=?`).bind(role).first();
  if(!rr)return json({error:"ROLE_INVALIDA"},400);
  if(sectorIds.length){
    const valid=(await db.prepare(`SELECT id FROM sectors WHERE active=1`).all()).results||[];
    const allowed=new Set(valid.map(x=>x.id));
    if(sectorIds.some(id=>!allowed.has(id)))return json({error:"SETOR_INVALIDO"},400);
  }
  try{
    const result=await db.prepare(`
      INSERT INTO users(username,display_name,email,password_hash,role_id,active,must_change_password)
      VALUES(?,?,?,?,?,1,1)
    `).bind(username,displayName,email||null,await hashPassword(password),rr.id).run();
    if(sectorIds.length)await db.batch(sectorIds.map(sectorId=>db.prepare(`
      INSERT OR IGNORE INTO user_sectors(user_id,sector_id) VALUES(?,?)
    `).bind(result.meta.last_row_id,sectorId)));
    const after=await db.prepare(`
      SELECT u.id,u.username,u.display_name,u.email,u.oauth_subject,u.active,u.must_change_password,r.name role
      FROM users u JOIN roles r ON r.id=u.role_id WHERE u.id=?
    `).bind(result.meta.last_row_id).first();
    after.sectors=sectorIds.length?(await db.prepare(`SELECT s.id,s.code,s.name,s.color FROM user_sectors us JOIN sectors s ON s.id=us.sector_id WHERE us.user_id=? ORDER BY s.name`).bind(after.id).all()).results:[];
    await audit(env,request,gate.user,"CREATE","user",after.id,null,safeUserRow(after));
    return json(safeUserRow(after),201);
  }catch{return json({error:"USUARIO_JA_EXISTE"},409)}
}

async function handleUserUpdate(env,request,id) {
  const gate=await requirePermission(env,request,"users.manage"); if(gate.response)return gate.response;
  const db=getDB(env);
  const before=await db.prepare(`
    SELECT u.id,u.username,u.display_name,u.email,u.oauth_subject,u.active,u.must_change_password,r.name role
    FROM users u JOIN roles r ON r.id=u.role_id WHERE u.id=?
  `).bind(id).first();
  if(!before)return json({error:"USUARIO_NAO_ENCONTRADO"},404);
  let b={};try{b=await readJson(request,16384)}catch{}
  if(id===gate.user.id && b.active===false)return json({error:"NAO_DESATIVE_SEU_PROPRIO_USUARIO"},400);
  const hasDisplay=b.display_name!==undefined;
  const displayName=hasDisplay?String(b.display_name).trim():null;
  const hasEmail=b.email!==undefined;
  const email=hasEmail?String(b.email||"").trim().toLowerCase():null;
  if(hasEmail){
    if(email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))return json({error:"EMAIL_INVALIDO"},400);
    if(email && await db.prepare(`SELECT 1 FROM users WHERE lower(email)=? AND id<>? LIMIT 1`).bind(email,id).first())
      return json({error:"EMAIL_JA_CADASTRADO"},409);
  }
  const hasActive=b.active!==undefined;
  const active=hasActive?(b.active?1:0):null;
  const hasRole=b.role!==undefined;
  let roleId=null;
  if(hasRole){
    const rr=await db.prepare(`SELECT id FROM roles WHERE name=?`).bind(String(b.role)).first();
    if(!rr)return json({error:"ROLE_INVALIDA"},400);
    roleId=rr.id;
  }
  const hasPassword=b.password!==undefined;
  const hasSectors=Array.isArray(b.sector_ids);
  const sectorIds=hasSectors?[...new Set(b.sector_ids.map(Number).filter(Number.isInteger))]:[];
  if(hasSectors){
    const allowed=new Set(((await db.prepare(`SELECT id FROM sectors WHERE active=1`).all()).results||[]).map(x=>x.id));
    if(sectorIds.some(sectorId=>!allowed.has(sectorId)))return json({error:"SETOR_INVALIDO"},400);
  }
  let passwordHash=null;
  if(hasPassword){
    if(!(await hasPermission(env,gate.user,"users.password")))
      return json({error:"FORBIDDEN",permission:"users.password"},403);
    if(String(b.password).length<8)return json({error:"SENHA_DEVE_TER_8_CARACTERES"},400);
    passwordHash=await hashPassword(String(b.password));
  }
  if(!hasDisplay&&!hasEmail&&!hasActive&&!hasRole&&!hasPassword&&!hasSectors)return json(safeUserRow(before));
  await db.prepare(`
    UPDATE users SET
      display_name=CASE WHEN ?=1 THEN ? ELSE display_name END,
      email=CASE WHEN ?=1 THEN ? ELSE email END,
      active=CASE WHEN ?=1 THEN ? ELSE active END,
      role_id=CASE WHEN ?=1 THEN ? ELSE role_id END,
      password_hash=CASE WHEN ?=1 THEN ? ELSE password_hash END,
      must_change_password=CASE WHEN ?=1 THEN 1 ELSE must_change_password END,
      updated_at=CURRENT_TIMESTAMP
    WHERE id=?
  `).bind(
    hasDisplay?1:0,displayName,
    hasEmail?1:0,email||null,
    hasActive?1:0,active,
    hasRole?1:0,roleId,
    hasPassword?1:0,passwordHash,
    hasPassword?1:0,id
  ).run();
  if(hasSectors)await db.batch([
    db.prepare(`DELETE FROM user_sectors WHERE user_id=?`).bind(id),
    ...sectorIds.map(sectorId=>db.prepare(`INSERT INTO user_sectors(user_id,sector_id) VALUES(?,?)`).bind(id,sectorId))
  ]);
  if(hasPassword) await db.prepare(`DELETE FROM sessions WHERE user_id=?`).bind(id).run();
  const after=await db.prepare(`
    SELECT u.id,u.username,u.display_name,u.email,u.oauth_subject,u.active,u.must_change_password,r.name role
    FROM users u JOIN roles r ON r.id=u.role_id WHERE u.id=?
  `).bind(id).first();
  after.sectors=(await db.prepare(`SELECT s.id,s.code,s.name,s.color FROM user_sectors us JOIN sectors s ON s.id=us.sector_id WHERE us.user_id=? ORDER BY s.name`).bind(id).all()).results||[];
  await audit(env,request,gate.user,"UPDATE","user",id,safeUserRow(before),safeUserRow(after));
  return json(safeUserRow(after));
}

/* Acessos SSH de um usuário, configurados pelo administrador que o cadastrou.
   GET devolve os destinos com provisionamento habilitado + a credencial atual
   + o estado da fila de provisionamento. PUT grava usuário/senha do aparelho e
   reabre um job para o coletor criar a conta no equipamento via SSH. */
async function handleUserDeviceCredentials(env, request, userId) {
  const gate=await requirePermission(env,request,"users.manage"); if(gate.response)return gate.response;
  if(!(await hasPermission(env,gate.user,"topology.connection.provision")))
    return json({error:"FORBIDDEN",permission:"topology.connection.provision"},403);
  const db=getDB(env);
  const user=await db.prepare(`SELECT id,username,display_name,active FROM users WHERE id=?`).bind(userId).first();
  if(!user)return json({error:"USUARIO_NAO_ENCONTRADO"},404);
  if(request.method==="GET"){
    const targets=(await db.prepare(`
      SELECT t.id,t.device_id,t.name,t.management_ip,t.protocol,t.port,t.vendor,t.provision_username,
        c.login_username,c.password_ciphertext,
        p.status,p.error,p.attempts,p.requested_at,p.last_attempt_at,p.updated_at provision_updated_at
      FROM device_connection_targets t
      LEFT JOIN device_target_credentials c ON c.target_id=t.id AND c.user_id=?
      LEFT JOIN device_target_provisioning p ON p.target_id=t.id AND p.user_id=?
      WHERE t.active=1 AND t.provision_username IS NOT NULL AND t.provision_ciphertext IS NOT NULL
      ORDER BY t.name
    `).bind(userId,userId).all()).results||[];
    return json(targets.map(row=>({
      target_id:row.id,device_id:row.device_id,name:row.name,ip:row.management_ip,
      protocol:row.protocol,port:Number(row.port),vendor:row.vendor,vendor_label:vendorLabel(row.vendor),
      credentials:publicCredential(row.login_username?{
        login_username:row.login_username,password_ciphertext:row.password_ciphertext
      }:null),
      status:row.status||(row.login_username?"pending":null),
      error:row.error||null,attempts:Number(row.attempts||0),
      requested_at:row.requested_at,last_attempt_at:row.last_attempt_at,updated_at:row.provision_updated_at
    })));
  }
  /* PUT: body { targets: [{ target_id, username, password }] } — password
     sempre obrigatória aqui para que a conta no aparelho tenha senha nova. */
  let body; try{body=await readJson(request,65536)}catch{return json({error:"JSON_INVALIDO"},400)}
  const list=Array.isArray(body.targets)?body.targets:[];
  if(!list.length)return json({error:"DESTINOS_DE_ACESSO_OBRIGATORIOS"},400);
  const requested=new Map(list.map(x=>[String(x?.target_id||""),x]));
  if([...requested.keys()].some(id=>!id))return json({error:"DESTINO_DE_ACESSO_INVALIDO"},400);
  const rows=(await db.prepare(`
    SELECT id,device_id,name,management_ip,protocol,port,vendor FROM device_connection_targets
    WHERE active=1 AND provision_username IS NOT NULL AND provision_ciphertext IS NOT NULL
  `).all()).results||[];
  const targetsById=new Map(rows.map(r=>[r.id,r]));
  const now=new Date().toISOString();
  const writes=[];
  const saved=[];
  for(const entry of list){
    const target=targetsById.get(String(entry.target_id));
    if(!target)return json({error:"DESTINO_DE_ACESSO_INVALIDO"},400);
    const username=String(entry.username||"").trim();
    const password=String(entry.password||"");
    if(!username||username.length>128)return json({error:"USUARIO_DE_ACESSO_INVALIDO"},400);
    if(!password||password.length>512)return json({error:"SENHA_DE_ACESSO_OBRIGATORIA"},400);
    let ciphertext;
    try{ciphertext=await encryptDevicePassword(env,password,userId,target.id);}
    catch(error){
      if(error?.message==="DEVICE_CREDENTIALS_KEY_NOT_CONFIGURED")
        return json({error:"CRIPTOGRAFIA_DE_CREDENCIAIS_NAO_CONFIGURADA"},503);
      throw error;
    }
    writes.push(db.prepare(`
      INSERT INTO device_target_credentials(target_id,user_id,login_username,password_ciphertext,updated_at)
      VALUES (?,?,?,?,CURRENT_TIMESTAMP)
      ON CONFLICT(target_id,user_id) DO UPDATE SET
        login_username=excluded.login_username,password_ciphertext=excluded.password_ciphertext,updated_at=CURRENT_TIMESTAMP
    `).bind(target.id,userId,username,ciphertext));
    writes.push(db.prepare(`
      INSERT INTO device_target_provisioning(target_id,user_id,login_username,status,attempts,requested_by,requested_at,last_attempt_at,updated_at)
      VALUES (?,?,?,'pending',0,?,?,NULL,CURRENT_TIMESTAMP)
      ON CONFLICT(target_id,user_id) DO UPDATE SET
        login_username=excluded.login_username,status='pending',error=NULL,attempts=0,
        requested_by=excluded.requested_by,requested_at=excluded.requested_at,last_attempt_at=NULL,updated_at=CURRENT_TIMESTAMP
    `).bind(target.id,userId,username,gate.user.id,now));
    saved.push({target_id:target.id,name:target.name,vendor:target.vendor,username});
  }
  await db.batch(writes);
  await audit(env,request,gate.user,"DEVICE_PROVISIONING_QUEUED","user",userId,null,
    saved.map(s=>({target_id:s.target_id,name:s.name,vendor:s.vendor,username:s.username})));
  return json({ok:true,queue:saved.map(s=>({target_id:s.target_id,status:"pending"}))});
}

async function provisioningCollectorAuth(env,request){
  const expected=String(env.PROVISIONING_TOKEN||env.GPON_SYNC_TOKEN||"");
  const authorization=String(request.headers.get("Authorization")||"");
  if(!expected||!(await timingSafeEqual(authorization,`Bearer ${expected}`)))
    return json({error:"UNAUTHORIZED"},401);
  return null;
}

/* O coletor (Node) busca os jobs pendentes. O Worker decifra a credencial de
   provisionamento e a senha do usuário antes de entregar: o texto cifrado com
   AES-GCM ligado ao contexto nunca sai do Worker. */
async function handleProvisioningPending(env,request){
  const denied=await provisioningCollectorAuth(env,request); if(denied)return denied;
  const db=getDB(env);
  /* Jobs presos em 'provisioning' (coletor caiu no meio) voltam para a fila
     depois de 10 minutos, para não ficarem órfãos para sempre. */
  await db.prepare(`
    UPDATE device_target_provisioning
    SET status='pending',error='Tentativa anterior interrompida',updated_at=CURRENT_TIMESTAMP
    WHERE status='provisioning' AND datetime(last_attempt_at) < datetime('now','-10 minutes')
  `).run();
  const jobs=(await db.prepare(`
    SELECT p.target_id,p.user_id,p.login_username,
      t.device_id,t.name target_name,t.management_ip,t.protocol,t.port,t.vendor,t.provision_username,t.provision_ciphertext,
      c.password_ciphertext,
      u.username platform_username,u.active
    FROM device_target_provisioning p
    JOIN device_connection_targets t ON t.id=p.target_id
    LEFT JOIN device_target_credentials c ON c.target_id=p.target_id AND c.user_id=p.user_id
    JOIN users u ON u.id=p.user_id
    WHERE p.status='pending' AND t.active=1 AND u.active=1
    ORDER BY p.requested_at LIMIT 50
  `).all()).results||[];
  const ready=[];
  for(const job of jobs){
    let provisionPassword,userPassword;
    try{
      provisionPassword=await decryptProvisionPassword(env,job.provision_ciphertext,job.target_id);
      userPassword=await decryptDevicePassword(env,job.password_ciphertext,job.user_id,job.target_id);
    }catch{continue;} /* credencial ilegível: o job fica para diagnóstico humano */
    ready.push({
      target_id:job.target_id,user_id:job.user_id,login_username:job.login_username,
      device_id:job.device_id,target_name:job.target_name,ip:job.management_ip,
      protocol:job.protocol,port:Number(job.port),vendor:job.vendor,
      provision_username:job.provision_username,provision_password:provisionPassword,
      password:userPassword,platform_username:job.platform_username
    });
  }
  if(ready.length){
    await db.batch(ready.map(job=>db.prepare(`
      UPDATE device_target_provisioning
      SET status='provisioning',attempts=attempts+1,last_attempt_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP
      WHERE target_id=? AND user_id=?
    `).bind(job.target_id,job.user_id)));
  }
  return json({jobs:ready});
}

async function handleProvisioningReport(env,request,targetId,userId){
  const denied=await provisioningCollectorAuth(env,request); if(denied)return denied;
  const db=getDB(env);
  let body;try{body=await readJson(request,16384)}catch{return json({error:"JSON_INVALIDO"},400)}
  const ok=body.ok!==false;
  const error=ok?null:String(body.error||"").slice(0,500);
  await db.prepare(`
    UPDATE device_target_provisioning
    SET status=?,error=?,updated_at=CURRENT_TIMESTAMP
    WHERE target_id=? AND user_id=?
  `).bind(ok?"success":"error",error,targetId,userId).run();
  await audit(env,request,null,"DEVICE_PROVISIONING_REPORT","device_target_provisioning",`${targetId}:${userId}`,
    null,{ok,error,login_username:body.username||null});
  return json({ok:true});
}

async function handleAudit(env,request) {
  const gate=await requirePermission(env,request,"audit.view"); if(gate.response)return gate.response;
  const db=getDB(env);
  const url=new URL(request.url);
  const limit=boundedInteger(url.searchParams.get("limit"),200,1,1000);
  const rows=(await db.prepare(`
    SELECT id,created_at,user_id,username,action,resource_type,resource_id,method,path,ip,user_agent,before_json,after_json,details_json
    FROM audit_logs ORDER BY id DESC LIMIT ?
  `).bind(limit).all()).results;
  return json(rows);
}

function topologySummary(t){
  return {
    equipamentos:Array.isArray(t?.equipamentos)?t.equipamentos.length:0,
    conexoes:Array.isArray(t?.conexoes)?t.conexoes.length:0,
    pops:Array.isArray(t?.pops)?t.pops.length:0,
    portas:Array.isArray(t?.equipamentos)?t.equipamentos.reduce((n,e)=>n+(Array.isArray(e.portas)?e.portas.length:0),0):0,
    ...(Array.isArray(t?.fibras)?{fibras:t.fibras.length}:{}),
    ...(Array.isArray(t?.caixas)?{caixas:t.caixas.length}:{})
  };
}
function topologyDiff(before,after){
  const diff={equipamentos:{added:[],removed:[],changed:[]},pops:{added:[],removed:[],changed:[]},conexoes:{added:0,removed:0,changed:0}};
  const byId=a=>Object.fromEntries((Array.isArray(a)?a:[]).filter(x=>x?.id).map(x=>[x.id,x]));
  // fibras e caixas só existem nos recortes que as usam; sem elas o laço
  // apenas não encontra nada e o diff sai vazio, como antes.
  if(Array.isArray(before?.fibras)||Array.isArray(after?.fibras))diff.fibras={added:[],removed:[],changed:[]};
  if(Array.isArray(before?.caixas)||Array.isArray(after?.caixas))diff.caixas={added:[],removed:[],changed:[]};
  for(const type of Object.keys(diff).filter(k=>k!=="conexoes")){
    const a=byId(before?.[type]),b=byId(after?.[type]);
    for(const id of Object.keys(b))if(!a[id])diff[type].added.push(id);
    for(const id of Object.keys(a))if(!b[id])diff[type].removed.push(id);
    for(const id of Object.keys(a))if(b[id]&&JSON.stringify(a[id])!==JSON.stringify(b[id]))diff[type].changed.push(id);
  }
  // Conjuntos, e não includes em array: a comparação era quadrática no número
  // de enlaces e roda em toda gravação da topologia.
  const aa=new Set((before?.conexoes||[]).map(c=>JSON.stringify(c)));
  const bb=new Set((after?.conexoes||[]).map(c=>JSON.stringify(c)));
  for(const c of bb)if(!aa.has(c))diff.conexoes.added++;
  for(const c of aa)if(!bb.has(c))diff.conexoes.removed++;
  return diff;
}

/* Traduz o que mudou na topologia para as ações exigidas do perfil.
   A topologia é gravada inteira em uma única rota, então é o diff — e não a
   tela nem o motivo informado — que diz qual funcionalidade foi usada. */
function requiredTopologyActions(before, after) {
  const need = new Set();
  const byId = (a) => new Map((Array.isArray(a)?a:[]).filter(x=>x&&x.id!=null).map(x=>[String(x.id),x]));
  const sem = (obj, ...chaves) => {
    const copia = {...(obj||{})};
    for (const k of chaves) delete copia[k];
    return JSON.stringify(copia);
  };
  const igual = (a,b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

  const eqA = byId(before?.equipamentos), eqB = byId(after?.equipamentos);
  for (const id of eqB.keys()) if (!eqA.has(id)) need.add("topology.equipment.create");
  for (const id of eqA.keys()) if (!eqB.has(id)) need.add("topology.equipment.delete");
  for (const [id,a] of eqA) {
    const b = eqB.get(id);
    if (!b || JSON.stringify(a) === JSON.stringify(b)) continue;
    if (!igual(a.portas,b.portas)) need.add("topology.port.edit");
    if ((a.popId ?? null) !== (b.popId ?? null)) need.add("topology.pop.link");
    if (sem(a,"portas","popId") !== sem(b,"portas","popId")) need.add("topology.equipment.edit");
  }

  const popA = byId(before?.pops), popB = byId(after?.pops);
  for (const id of popB.keys()) if (!popA.has(id)) need.add("pops.create");
  for (const id of popA.keys()) if (!popB.has(id)) need.add("pops.delete");
  for (const [id,a] of popA) {
    const b = popB.get(id);
    if (!b || JSON.stringify(a) === JSON.stringify(b)) continue;
    if (!igual(a.rotas,b.rotas)) need.add("pops.routes");
    if (sem(a,"rotas") !== sem(b,"rotas")) need.add("pops.edit");
  }

  // Mesmos POPs em ordem diferente = reordenação do anel.
  const ordemA = (before?.pops||[]).map(p=>String(p?.id));
  const ordemB = (after?.pops||[]).map(p=>String(p?.id));
  const mesmoConjunto = ordemA.length===ordemB.length
    && [...ordemA].sort().join("|") === [...ordemB].sort().join("|");
  if (mesmoConjunto && ordemA.join("|") !== ordemB.join("|")) need.add("pops.order");

  const conA = new Set((before?.conexoes||[]).map(c=>JSON.stringify(c)));
  const conB = new Set((after?.conexoes||[]).map(c=>JSON.stringify(c)));
  for (const c of conB) if (!conA.has(c)) need.add("topology.link.create");
  for (const c of conA) if (!conB.has(c)) need.add("topology.link.delete");

  /* Caminhos de fibra e caixas ópticas são cadastro do mapa da PARTE ISP e têm
     ação própria — não se confundem com as rotas do anel dos POPs. */
  for (const lista of ["fibras","caixas"]) {
    const a = byId(before?.[lista]), b = byId(after?.[lista]);
    for (const id of b.keys()) if (!a.has(id)) need.add("fibra.edit");
    for (const id of a.keys()) if (!b.has(id)) need.add("fibra.delete");
    for (const [id,x] of a) {
      const y = b.get(id);
      if (y && JSON.stringify(x) !== JSON.stringify(y)) need.add("fibra.edit");
    }
  }

  // O config é normalizado com os mesmos padrões dos dois lados, senão uma
  // gravação comum pediria topology.config só por completar campos ausentes.
  const cfgA = {...DEFAULT_TOPOLOGY_CONFIG, ...(before?.config||{})};
  const cfgB = {...DEFAULT_TOPOLOGY_CONFIG, ...(after?.config||{})};
  if (!igual(cfgA.layout,cfgB.layout)) need.add("topology.layout");
  if (!igual(cfgA.ringLayout,cfgB.ringLayout)) need.add("pops.ring.layout");
  if (sem(cfgA,"layout","ringLayout") !== sem(cfgB,"layout","ringLayout")) need.add("topology.config");

  return need;
}

/* Grava em locais/topology_local_links a diferença de pops entre before/after.
   O local só some da tabela quando nenhum recorte mais o referencia no anel
   e nenhum produto está instalado nele — remover de um mapa não pode apagar
   o cadastro que o outro mapa ainda usa. */
async function persistPops(db, scope, before, after, userId) {
  const antesPorId = new Map((before.pops || []).map(p => [String(p.id), p]));
  const depoisPorId = new Map((after.pops || []).map(p => [String(p.id), p]));
  const statements = [];
  after.pops.forEach((pop, indice) => {
    if (!pop?.id) return;
    const id = String(pop.id);
    const tipo = LOCAL_TIPOS.has(pop.tipo) ? pop.tipo : "POP";
    statements.push(db.prepare(`
      INSERT INTO locais(id,nome,tipo,endereco,lat,lon,observacao,origem,updated_by)
      VALUES (?,?,?,?,?,?,?,'topologia',?)
      ON CONFLICT(id) DO UPDATE SET
        nome=excluded.nome, tipo=excluded.tipo, endereco=excluded.endereco,
        lat=excluded.lat, lon=excluded.lon, observacao=excluded.observacao,
        updated_by=excluded.updated_by, updated_at=CURRENT_TIMESTAMP
    `).bind(id, String(pop.nome || ""), tipo, String(pop.endereco || ""),
      Number.isFinite(pop.lat) ? pop.lat : null, Number.isFinite(pop.lon) ? pop.lon : null,
      String(pop.observacao || ""), userId));
    statements.push(db.prepare(`
      INSERT INTO topology_local_links(scope,local_id,ordem,rotas_json,legado_equipamentos_json)
      VALUES (?,?,?,?,?)
      ON CONFLICT(scope,local_id) DO UPDATE SET
        ordem=excluded.ordem, rotas_json=excluded.rotas_json, legado_equipamentos_json=excluded.legado_equipamentos_json
    `).bind(scope, id, indice, JSON.stringify(pop.rotas || []), JSON.stringify(pop.equipamentos || [])));
  });
  const removidos = [...antesPorId.keys()].filter(id => !depoisPorId.has(id));
  for (const id of removidos) statements.push(db.prepare(`DELETE FROM topology_local_links WHERE scope=? AND local_id=?`).bind(scope, id));
  if (statements.length) await db.batch(statements);
  for (const id of removidos) {
    const aindaLigado = await db.prepare(`SELECT 1 FROM topology_local_links WHERE local_id=? LIMIT 1`).bind(id).first();
    const aindaInstalado = !aindaLigado && await db.prepare(`SELECT 1 FROM produtos WHERE local_id=? LIMIT 1`).bind(id).first();
    if (!aindaLigado && !aindaInstalado) await db.prepare(`DELETE FROM locais WHERE id=?`).bind(id).run();
  }
}

/* Grava em produtos a diferença de equipamentos entre before/after. Um
   equipamento cujo dono (escopo) é o outro recorte é "emprestado" — mostrado
   como contexto (ver montarEquipamentos) mas só a tela dona pode alterá-lo
   ou apagá-lo; uma gravação vinda do outro recorte ignora essas linhas em
   silêncio, para uma tela não corromper o cadastro real da outra. */
async function persistEquipamentos(db, scope, before, after, userId) {
  const antesPorId = new Map((before.equipamentos || []).map(e => [String(e.id), e]));
  const depoisPorId = new Map((after.equipamentos || []).map(e => [String(e.id), e]));
  const idsExistentes = [...new Set([...antesPorId.keys(), ...depoisPorId.keys()])];
  const donoPorId = new Map();
  if (idsExistentes.length) {
    const placeholders = idsExistentes.map(() => "?").join(",");
    const rows = (await db.prepare(`SELECT id,escopo FROM produtos WHERE id IN (${placeholders})`).bind(...idsExistentes).all()).results || [];
    for (const r of rows) donoPorId.set(r.id, r.escopo);
  }
  const statements = [];
  for (const [id, eq] of depoisPorId) {
    const dono = donoPorId.get(id);
    if (dono && dono !== scope) continue;
    const antes = antesPorId.get(id);
    if (antes && JSON.stringify(antes) === JSON.stringify(eq)) continue;
    statements.push(db.prepare(`
      INSERT INTO produtos(id,nome,fabricante,modelo,categoria,serial,local_id,escopo,observacao,
        portas_json,imagem,imagem_alt,hotspots_json,layout_portas,updated_by)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET
        nome=excluded.nome, fabricante=excluded.fabricante, modelo=excluded.modelo, categoria=excluded.categoria,
        serial=excluded.serial, local_id=excluded.local_id, observacao=excluded.observacao,
        portas_json=excluded.portas_json, imagem=excluded.imagem, imagem_alt=excluded.imagem_alt,
        hotspots_json=excluded.hotspots_json, layout_portas=excluded.layout_portas,
        updated_by=excluded.updated_by, updated_at=CURRENT_TIMESTAMP
    `).bind(id, String(eq.nome || ""), String(eq.fabricante || ""), String(eq.modelo || ""), String(eq.categoria || ""),
      String(eq.serial || ""), eq.popId ? String(eq.popId) : null, scope, String(eq.observacao || ""),
      JSON.stringify(Array.isArray(eq.portas) ? eq.portas : []), String(eq.imagem || ""), String(eq.imagemAlt || ""),
      eq.hotspots ? JSON.stringify(eq.hotspots) : "", String(eq.layoutPortas || ""), userId));
  }
  const removidos = [];
  for (const id of antesPorId.keys()) {
    if (depoisPorId.has(id)) continue;
    const dono = donoPorId.get(id);
    if (dono && dono !== scope) continue;
    removidos.push(id);
  }
  for (const id of removidos) {
    statements.push(
      db.prepare(`DELETE FROM device_target_credentials WHERE target_id IN (SELECT id FROM device_connection_targets WHERE device_id=?)`).bind(id),
      db.prepare(`DELETE FROM device_target_provisioning WHERE target_id IN (SELECT id FROM device_connection_targets WHERE device_id=?)`).bind(id),
      db.prepare(`DELETE FROM device_connection_acl WHERE target_id IN (SELECT id FROM device_connection_targets WHERE device_id=?)`).bind(id),
      db.prepare(`DELETE FROM device_connection_targets WHERE device_id=?`).bind(id),
      db.prepare(`DELETE FROM device_credentials WHERE device_id=?`).bind(id),
      db.prepare(`DELETE FROM device_connections WHERE device_id=?`).bind(id),
      db.prepare(`DELETE FROM produtos WHERE id=?`).bind(id)
    );
  }
  if (statements.length) await db.batch(statements);
}

async function handleTopology(env,request) {
  const method=request.method;
  const scope=scopeOf(new URL(request.url));
  if(!scope)return json({error:"RECORTE_INVALIDO"},400);
  // O conjunto de ações do perfil é carregado uma única vez: a gravação precisa
  // dele inteiro logo adiante, e buscar a ação base em separado era uma
  // consulta a mais em toda leitura e toda gravação da topologia.
  const user=await requireUser(env,request);
  if(!user)return json({error:"AUTH_REQUIRED"},401);
  const permissoes=await permissionsOf(env,user);
  const acaoBase=method==="GET"?"topology.view":"topology.edit";
  if(!permissoes.has(acaoBase))return json({error:"FORBIDDEN",permission:acaoBase},403);
  const db=getDB(env);
  const row=await ensureTopologyState(env,request,scope);
  // pops/equipamentos vêm de locais/produtos; o blob guarda só o resto.
  const before={
    ...JSON.parse(row.data_json),
    pops: await montarPops(db, scope),
    equipamentos: await montarEquipamentos(db, scope)
  };
  if(method==="GET"){
    return json({...before,scope,version:row.version,updated_at:row.updated_at,updated_by:row.updated_by});
  }
  let body;try{body=await readJson(request)}catch{return json({error:"JSON_INVALIDO"},400)}
  const incoming=body?.topology??body;
  if(!incoming||!Array.isArray(incoming.equipamentos)||!Array.isArray(incoming.conexoes)||!Array.isArray(incoming.pops))
    return json({error:"TOPOLOGIA_INVALIDA"},400);
  const after={
    equipamentos:incoming.equipamentos,
    conexoes:incoming.conexoes,
    pops:incoming.pops,
    config:{...DEFAULT_TOPOLOGY_CONFIG,...(incoming.config||{})}
  };
  /* Fibras e caixas só são aceitas no recorte que as declara: enviá-las para a
     rede NOC criaria um documento que nenhuma tela dela sabe ler. Omitir a
     lista em um recorte que a usa preserva a que já estava gravada — assim uma
     tela que não conhece o campo não apaga o cadastro da outra. */
  if(scopeTemFibra(scope)){
    for(const lista of ["fibras","caixas"]){
      if(incoming[lista]!==undefined&&!Array.isArray(incoming[lista]))return json({error:"TOPOLOGIA_INVALIDA"},400);
      after[lista]=Array.isArray(incoming[lista])?incoming[lista]:(before[lista]||[]);
    }
  }
  const diff=topologyDiff(before,after);

  const hasDeletion=diff.equipamentos.removed.length||diff.pops.removed.length||diff.conexoes.removed
    ||diff.fibras?.removed.length||diff.caixas?.removed.length;
  if(hasDeletion && !permissoes.has("topology.delete")){
    await audit(env,request,user,"TOPOLOGY_UPDATE_DENIED","topology",scope,before,after,{reason:"missing topology.delete",diff});
    return json({error:"FORBIDDEN",permission:"topology.delete"},403);
  }

  /* Cada funcionalidade tem a sua ação. O que vale é o que mudou de fato
     entre o estado anterior e o enviado — nunca um rótulo vindo do cliente. */
  const exigidas=requiredTopologyActions(before,after);
  const faltando=[...exigidas].filter(code=>!permissoes.has(code));
  if(faltando.length){
    await audit(env,request,user,"TOPOLOGY_UPDATE_DENIED","topology",scope,before,after,{reason:"missing actions",missing:faltando,diff});
    return json({error:"FORBIDDEN",permission:faltando[0],permissions:faltando},403);
  }
  const nextVersion=Number(row.version||0)+1;
  // O blob guarda só conexões/config/fibras/caixas; pops e equipamentos vão
  // para locais/produtos por baixo, respeitando quem é dono de cada um.
  const blobAfter={
    conexoes:after.conexoes,
    config:after.config,
    ...(after.fibras!==undefined?{fibras:after.fibras}:{}),
    ...(after.caixas!==undefined?{caixas:after.caixas}:{})
  };
  await persistEquipamentos(db, scope, before, after, user.id);
  await persistPops(db, scope, before, after, user.id);
  await (scope===DEFAULT_SCOPE
    ? db.prepare(`UPDATE topology_state SET data_json=?,version=?,updated_at=CURRENT_TIMESTAMP,updated_by=? WHERE id=1`)
        .bind(JSON.stringify(blobAfter),nextVersion,user.id)
    : db.prepare(`UPDATE topology_scopes SET data_json=?,version=?,updated_at=CURRENT_TIMESTAMP,updated_by=? WHERE scope=?`)
        .bind(JSON.stringify(blobAfter),nextVersion,user.id,scope)
  ).run();
  await audit(env,request,user,"TOPOLOGY_UPDATE","topology",scope,before,after,{
    scope,version_before:row.version,version_after:nextVersion,diff,
    before_summary:topologySummary(before),after_summary:topologySummary(after)
  });
  /* Devolver a topologia inteira era repetir de volta os ~50 KB que o cliente
     acabou de enviar. Quem só precisa do config e da versão pede `echo:false`;
     o editor clássico, que repovoa o estado com a resposta, continua recebendo
     tudo por omissão. */
  const echo = incoming === body ? true : body?.echo !== false;
  return json({
    ok:true,
    scope,
    version:nextVersion,
    updated_at:new Date().toISOString(),
    topology: echo ? after : {config:after.config},
    diff
  });
}

function normalizeManagementIp(value) {
  const ip = String(value || "").trim().replace(/^\[|\]$/g, "");
  if (!ip || ip.length > 45) return null;
  const parts = ip.split(".");
  if (parts.length === 4 && parts.every(part => /^\d{1,3}$/.test(part) && Number(part) <= 255)) return ip;
  if (ip.includes(":") && /^[0-9a-f:.]+$/i.test(ip)) {
    try {
      const parsed = new URL(`http://[${ip}]/`);
      return parsed.hostname.slice(1, -1);
    } catch {}
  }
  return null;
}

/* O acesso remoto é do equipamento, não do recorte em que ele foi cadastrado:
   um equipamento da PARTE ISP também precisa poder ter conexão configurada. */
async function topologyHasDevice(env, request, deviceId) {
  for (const scope of Object.keys(TOPOLOGY_SCOPES)) {
    const row = await ensureTopologyState(env, request, scope);
    try {
      const topology = JSON.parse(row.data_json);
      if ((topology.equipamentos || []).some(e => String(e?.id) === deviceId)) return true;
    } catch { /* documento ilegível: os outros recortes ainda respondem */ }
  }
  return false;
}

async function credentialEncryptionKey(env) {
  const secret = String(env.DEVICE_CREDENTIALS_KEY || "");
  if (secret.length < 32) throw new Error("DEVICE_CREDENTIALS_KEY_NOT_CONFIGURED");
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret));
  return crypto.subtle.importKey("raw", digest, {name:"AES-GCM"}, false, ["encrypt","decrypt"]);
}

function credentialAdditionalData(userId, deviceId) {
  return new TextEncoder().encode(`topologia-noc\n${userId}\n${deviceId}`);
}

async function encryptDevicePassword(env, password, userId, deviceId) {
  const iv = randomBytes(12);
  const ciphertext = await crypto.subtle.encrypt({
    name:"AES-GCM", iv, additionalData:credentialAdditionalData(userId,deviceId)
  }, await credentialEncryptionKey(env), new TextEncoder().encode(password));
  return `v1.${bytesToBase64Url(iv)}.${bytesToBase64Url(new Uint8Array(ciphertext))}`;
}

async function decryptDevicePassword(env, encoded, userId, deviceId) {
  const [version, ivText, cipherText] = String(encoded || "").split(".");
  if (version !== "v1" || !ivText || !cipherText) throw new Error("CREDENTIAL_FORMAT_INVALID");
  const plaintext = await crypto.subtle.decrypt({
    name:"AES-GCM",
    iv:base64UrlToBytes(ivText),
    additionalData:credentialAdditionalData(userId,deviceId)
  }, await credentialEncryptionKey(env), base64UrlToBytes(cipherText));
  return new TextDecoder().decode(plaintext);
}

/* Senhas do cadastro de cliente (PPPoE, roteador, WiFi). Mesma cifra AES-GCM,
   com o contexto amarrado ao id do cliente — uma senha lida em outro registro
   falha ao decifrar, como a AAD de credenciais de acesso remoto já fazia. */
function clienteAdditionalData(clientId) {
  return new TextEncoder().encode(`topologia-noc\ncliente\n${clientId}`);
}

async function encryptClienteSenha(env, senha, clientId) {
  if (senha === undefined || senha === null || senha === "") return "";
  const iv = randomBytes(12);
  const ciphertext = await crypto.subtle.encrypt({
    name: "AES-GCM", iv, additionalData: clienteAdditionalData(clientId)
  }, await credentialEncryptionKey(env), new TextEncoder().encode(String(senha)));
  return `v1.${bytesToBase64Url(iv)}.${bytesToBase64Url(new Uint8Array(ciphertext))}`;
}

async function decryptClienteSenha(env, encoded, clientId) {
  if (!encoded) return "";
  const [version, ivText, cipherText] = String(encoded).split(".");
  if (version !== "v1" || !ivText || !cipherText) throw new Error("CREDENCIAL_DE_CLIENTE_INVALIDA");
  const plaintext = await crypto.subtle.decrypt({
    name: "AES-GCM", iv: base64UrlToBytes(ivText), additionalData: clienteAdditionalData(clientId)
  }, await credentialEncryptionKey(env), base64UrlToBytes(cipherText));
  return new TextDecoder().decode(plaintext);
}

async function hashSenhaCliente(senha) {
  if (senha === undefined || senha === null || senha === "") return "";
  const enc = new TextEncoder();
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const material = await crypto.subtle.importKey("raw", enc.encode(String(senha)), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", salt, iterations: 50000, hash: "SHA-256" }, material, 256);
  return `pbkdf2$50000$${bytesToBase64Url(salt)}$${bytesToBase64Url(new Uint8Array(bits))}`;
}

function publicCredential(row) {
  return row ? {
    username:row.login_username,
    has_password:Boolean(row.password_ciphertext),
    updated_at:row.updated_at
  } : null;
}

/* Fabricantes que o coletor sabe criar usuário. 'outro' guarda a credencial,
   mas o provisionamento fica pendente de adaptador até alguém mapear o CLI. */
const VENDORS = {
  zte: "ZTE (OLT ZXAN/ROS)",
  huawei: "Huawei (VRP)",
  cisco: "Cisco (IOS/IOS-XE)",
  mikrotik: "MikroTik (RouterOS)",
  datacom: "Datacom (DMOS)",
  nokia: "Nokia (SR OS/TiMOS)",
  linux: "Linux (servidor)",
  outro: "Outro / manual"
};

function vendorLabel(code) {
  return VENDORS[code] || VENDORS.outro;
}

/* A credencial de provisionamento é do destino (aparelho), não de um usuário:
   o AAD liga o texto cifrado ao target_id, como as credenciais pessoais se
   ligam ao par usuário+aparelho. */
function provisionAdditionalData(targetId) {
  return new TextEncoder().encode(`topologia-noc\nprovision\n${targetId}`);
}

async function encryptProvisionPassword(env, password, targetId) {
  const iv = randomBytes(12);
  const ciphertext = await crypto.subtle.encrypt({
    name:"AES-GCM", iv, additionalData:provisionAdditionalData(targetId)
  }, await credentialEncryptionKey(env), new TextEncoder().encode(password));
  return `v1.${bytesToBase64Url(iv)}.${bytesToBase64Url(new Uint8Array(ciphertext))}`;
}

async function decryptProvisionPassword(env, encoded, targetId) {
  const [version, ivText, cipherText] = String(encoded || "").split(".");
  if (version !== "v1" || !ivText || !cipherText) throw new Error("CREDENTIAL_FORMAT_INVALID");
  const plaintext = await crypto.subtle.decrypt({
    name:"AES-GCM",
    iv:base64UrlToBytes(ivText),
    additionalData:provisionAdditionalData(targetId)
  }, await credentialEncryptionKey(env), base64UrlToBytes(cipherText));
  return new TextDecoder().decode(plaintext);
}

function normalizeBrowserUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) return null;
  try {
    const url = new URL(raw);
    return url.protocol === "https:" && url.username === "" && url.password === "" && raw.length <= 512
      ? url.toString() : null;
  } catch { return null; }
}

async function targetAccess(env, user, target) {
  const globalManage = await hasPermission(env,user,"topology.connection.configure");
  if (globalManage) return {can_connect:true,can_manage:true,global_manage:true};
  const row = await getDB(env).prepare(`
    SELECT can_connect,can_manage FROM device_connection_acl WHERE target_id=? AND role_id=?
  `).bind(target.id,user.role_id).first();
  return {
    can_connect:Boolean(row?.can_connect || row?.can_manage),
    can_manage:Boolean(row?.can_manage),
    global_manage:false
  };
}

async function normalizedTargetBody(db, body) {
  const name = String(body.name || "").trim();
  const ip = normalizeManagementIp(body.ip);
  const protocol = String(body.protocol || "").toLowerCase();
  const port = Number(body.port);
  const rawBrowserUrl = String(body.browser_url || "").trim();
  const browserUrl = normalizeBrowserUrl(rawBrowserUrl);
  const vendor = String(body.vendor || "outro").toLowerCase();
  if (!name || name.length > 100) return {error:"NOME_DO_DESTINO_INVALIDO"};
  if (!ip) return {error:"IP_DE_GERENCIA_INVALIDO"};
  if (!['ssh','telnet'].includes(protocol)) return {error:"PROTOCOLO_INVALIDO"};
  if (!Number.isInteger(port) || port < 1 || port > 65535) return {error:"PORTA_INVALIDA"};
  if (rawBrowserUrl && !browserUrl) return {error:"URL_DO_TERMINAL_DEVE_USAR_HTTPS"};
  if (!VENDORS[vendor]) return {error:"FABRICANTE_INVALIDO"};

  /* Credencial de provisionamento: usuário e senha de administração do
     aparelho, usada pelo coletor para criar as contas dos demais usuários.
     No UPDATE a senha é opcional — vazia mantém a atual. */
  const provisionUsername = String(body.provision_username || "").trim();
  const provisionPasswordProvided = Object.hasOwn(body,"provision_password")
    && String(body.provision_password).length > 0;
  const provisionPassword = provisionPasswordProvided ? String(body.provision_password) : null;
  if (provisionUsername.length > 128) return {error:"USUARIO_DE_PROVISIONAMENTO_INVALIDO"};
  if (provisionPassword !== null && provisionPassword.length > 512)
    return {error:"SENHA_DE_PROVISIONAMENTO_MUITO_LONGA"};

  const validRoles = new Set(((await db.prepare(`SELECT id FROM roles`).all()).results || []).map(r => Number(r.id)));
  const requestedConnect = Array.isArray(body.connect_role_ids) ? body.connect_role_ids.map(Number) : [];
  const requestedManage = Array.isArray(body.manage_role_ids) ? body.manage_role_ids.map(Number) : [];
  if ([...requestedConnect,...requestedManage].some(id => !Number.isInteger(id) || !validRoles.has(id)))
    return {error:"PERFIL_DE_ACESSO_INVALIDO"};
  const manageRoleIds = [...new Set(requestedManage)];
  const connectRoleIds = [...new Set([...requestedConnect,...manageRoleIds])];
  return {name,ip,protocol,port,browser_url:browserUrl,vendor,provision_username:provisionUsername,
    provision_password:provisionPassword,connectRoleIds,manageRoleIds};
}

function targetAclStatements(db, targetId, normalized) {
  const manage = new Set(normalized.manageRoleIds);
  return [
    db.prepare(`DELETE FROM device_connection_acl WHERE target_id=?`).bind(targetId),
    ...normalized.connectRoleIds.map(roleId => db.prepare(`
      INSERT INTO device_connection_acl(target_id,role_id,can_connect,can_manage) VALUES (?,?,1,?)
    `).bind(targetId,roleId,manage.has(roleId)?1:0))
  ];
}

async function handleDeviceConnections(env, request, deviceId) {
  const required = request.method === "POST" ? "topology.connection.configure" : "topology.connection.use";
  const gate = await requirePermission(env,request,required);
  if (gate.response) return gate.response;
  if (!(await topologyHasDevice(env,request,deviceId))) return json({error:"EQUIPAMENTO_NAO_ENCONTRADO"},404);
  const db = getDB(env);

  if (request.method === "POST") {
    let body; try { body = await readJson(request,16384); } catch { return json({error:"JSON_INVALIDO"},400); }
    const normalized = await normalizedTargetBody(db,body);
    if (normalized.error) return json({error:normalized.error},400);
    const id = crypto.randomUUID();
    let provisionCiphertext = null;
    if (normalized.provision_username) {
      if (normalized.provision_password === null)
        return json({error:"SENHA_DE_PROVISIONAMENTO_OBRIGATORIA"},400);
      try {
        provisionCiphertext = await encryptProvisionPassword(env,normalized.provision_password,id);
      } catch (error) {
        if (error?.message === "DEVICE_CREDENTIALS_KEY_NOT_CONFIGURED")
          return json({error:"CRIPTOGRAFIA_DE_CREDENCIAIS_NAO_CONFIGURADA"},503);
        throw error;
      }
    }
    await db.batch([
      db.prepare(`
        INSERT INTO device_connection_targets
          (id,device_id,name,management_ip,protocol,port,browser_url,vendor,provision_username,provision_ciphertext,updated_by,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP)
      `).bind(id,deviceId,normalized.name,normalized.ip,normalized.protocol,normalized.port,
        normalized.browser_url,normalized.vendor,normalized.provision_username||null,provisionCiphertext,gate.user.id),
      ...targetAclStatements(db,id,normalized)
    ]);
    const auditRecord = {...normalized,provision_password:Boolean(normalized.provision_password),device_id:deviceId};
    await audit(env,request,gate.user,"DEVICE_CONNECTION_TARGET_CREATE","device_connection_target",id,null,
      auditRecord);
    return json({ok:true,id},201);
  }

  const [targetsResult, aclResult, rolesResult] = await Promise.all([
    db.prepare(`
      SELECT t.*,c.login_username,c.password_ciphertext,c.updated_at credential_updated_at
      FROM device_connection_targets t
      LEFT JOIN device_target_credentials c ON c.target_id=t.id AND c.user_id=?
      WHERE t.device_id=? AND t.active=1 ORDER BY t.sort,t.name
    `).bind(gate.user.id,deviceId).all(),
    db.prepare(`
      SELECT a.target_id,a.role_id,a.can_connect,a.can_manage,r.name role_name
      FROM device_connection_acl a JOIN roles r ON r.id=a.role_id
      JOIN device_connection_targets t ON t.id=a.target_id
      WHERE t.device_id=? ORDER BY r.name
    `).bind(deviceId).all(),
    db.prepare(`SELECT id,name,description FROM roles ORDER BY name`).all()
  ]);
  const aclByTarget = new Map();
  for (const row of aclResult.results || []) {
    if (!aclByTarget.has(row.target_id)) aclByTarget.set(row.target_id,[]);
    aclByTarget.get(row.target_id).push(row);
  }
  const globalManage = await hasPermission(env,gate.user,"topology.connection.configure");
  const targets = (targetsResult.results || []).map(row => {
    const acl = aclByTarget.get(row.id) || [];
    const own = acl.find(a => Number(a.role_id) === Number(gate.user.role_id));
    const canManage = globalManage || Boolean(own?.can_manage);
    const canConnect = canManage || Boolean(own?.can_connect);
    if (!canConnect) return null;
    return {
      id:row.id,name:row.name,ip:row.management_ip,protocol:row.protocol,port:Number(row.port),
      browser_url:row.browser_url,vendor:row.vendor,vendor_label:vendorLabel(row.vendor),
      provisioning:Boolean(row.provision_username && row.provision_ciphertext),
      provisioning_username:canManage?row.provision_username:undefined,
      updated_at:row.updated_at,can_manage:canManage,
      credentials:publicCredential(row.login_username ? {
        login_username:row.login_username,password_ciphertext:row.password_ciphertext,updated_at:row.credential_updated_at
      } : null),
      connect_role_ids:canManage?acl.filter(a=>a.can_connect||a.can_manage).map(a=>Number(a.role_id)):undefined,
      manage_role_ids:canManage?acl.filter(a=>a.can_manage).map(a=>Number(a.role_id)):undefined,
      access_profiles:acl.filter(a=>a.can_connect||a.can_manage).map(a=>({name:a.role_name,manage:Boolean(a.can_manage)}))
    };
  }).filter(Boolean);
  return json({targets,roles:rolesResult.results || [],can_create:globalManage});
}

async function handleDeviceConnectionTarget(env, request, deviceId, targetId) {
  const gate = await requirePermission(env,request,"topology.connection.use");
  if (gate.response) return gate.response;
  const db = getDB(env);
  const target = await db.prepare(`SELECT * FROM device_connection_targets WHERE id=? AND device_id=?`).bind(targetId,deviceId).first();
  if (!target) return json({error:"DESTINO_NAO_ENCONTRADO"},404);
  const access = await targetAccess(env,gate.user,target);
  if (!access.can_manage) return json({error:"FORBIDDEN",permission:"device_connection.manage"},403);

  if (request.method === "DELETE") {
    await db.batch([
      db.prepare(`DELETE FROM device_target_credentials WHERE target_id=?`).bind(targetId),
      db.prepare(`DELETE FROM device_target_provisioning WHERE target_id=?`).bind(targetId),
      db.prepare(`DELETE FROM device_connection_acl WHERE target_id=?`).bind(targetId),
      db.prepare(`DELETE FROM device_connection_targets WHERE id=?`).bind(targetId)
    ]);
    await audit(env,request,gate.user,"DEVICE_CONNECTION_TARGET_DELETE","device_connection_target",targetId,target,null);
    return json({ok:true});
  }

  let body; try { body = await readJson(request,16384); } catch { return json({error:"JSON_INVALIDO"},400); }
  const normalized = await normalizedTargetBody(db,body);
  if (normalized.error) return json({error:normalized.error},400);
  /* Senha de provisionamento: se não veio nova, mantém a cifrada atual. */
  let provisionCiphertext = target.provision_ciphertext;
  if (normalized.provision_username && normalized.provision_password !== null) {
    try {
      provisionCiphertext = await encryptProvisionPassword(env,normalized.provision_password,targetId);
    } catch (error) {
      if (error?.message === "DEVICE_CREDENTIALS_KEY_NOT_CONFIGURED")
        return json({error:"CRIPTOGRAFIA_DE_CREDENCIAIS_NAO_CONFIGURADA"},503);
      throw error;
    }
  }
  if (normalized.provision_username && !provisionCiphertext)
    return json({error:"SENHA_DE_PROVISIONAMENTO_OBRIGATORIA"},400);
  /* Remover a credencial de provisionamento = deixar o usuário vazio. */
  if (!normalized.provision_username) provisionCiphertext = null;
  await db.batch([
    db.prepare(`
      UPDATE device_connection_targets
      SET name=?,management_ip=?,protocol=?,port=?,browser_url=?,vendor=?,
        provision_username=?,provision_ciphertext=?,updated_by=?,updated_at=CURRENT_TIMESTAMP
      WHERE id=? AND device_id=?
    `).bind(normalized.name,normalized.ip,normalized.protocol,normalized.port,normalized.browser_url,
      normalized.vendor,normalized.provision_username||null,provisionCiphertext,gate.user.id,targetId,deviceId),
    ...targetAclStatements(db,targetId,normalized)
  ]);
  const auditBefore = {...target,provision_ciphertext:Boolean(target.provision_ciphertext)};
  const auditAfter = {...normalized,provision_password:normalized.provision_password===null
    ? "mantida" : Boolean(normalized.provision_password)};
  await audit(env,request,gate.user,"DEVICE_CONNECTION_TARGET_UPDATE","device_connection_target",targetId,auditBefore,auditAfter);
  return json({ok:true});
}

async function handleTargetCredentials(env, request, deviceId, targetId, reveal = false) {
  const gate = await requirePermission(env,request,"topology.connection.use");
  if (gate.response) return gate.response;
  const db = getDB(env);
  const target = await db.prepare(`SELECT id,device_id FROM device_connection_targets WHERE id=? AND device_id=? AND active=1`)
    .bind(targetId,deviceId).first();
  if (!target) return json({error:"DESTINO_NAO_ENCONTRADO"},404);
  const access = await targetAccess(env,gate.user,target);
  if (!access.can_connect) return json({error:"FORBIDDEN",permission:"device_connection.connect"},403);
  const before = await db.prepare(`
    SELECT login_username,password_ciphertext,updated_at FROM device_target_credentials WHERE target_id=? AND user_id=?
  `).bind(targetId,gate.user.id).first();

  if (reveal) {
    if (!before?.password_ciphertext) return json({error:"CREDENCIAL_SEM_SENHA"},404);
    let password;
    try { password = await decryptDevicePassword(env,before.password_ciphertext,gate.user.id,deviceId); }
    catch (error) {
      if (error?.message === "DEVICE_CREDENTIALS_KEY_NOT_CONFIGURED")
        return json({error:"CRIPTOGRAFIA_DE_CREDENCIAIS_NAO_CONFIGURADA"},503);
      return json({error:"NAO_FOI_POSSIVEL_DECIFRAR_A_CREDENCIAL"},500);
    }
    await audit(env,request,gate.user,"DEVICE_CREDENTIAL_REVEAL","device_target_credential",targetId,null,null,{username:before.login_username});
    return json({password});
  }
  if (request.method === "DELETE") {
    await db.prepare(`DELETE FROM device_target_credentials WHERE target_id=? AND user_id=?`).bind(targetId,gate.user.id).run();
    await audit(env,request,gate.user,"DEVICE_CREDENTIAL_DELETE","device_target_credential",targetId,
      before?{username:before.login_username,has_password:Boolean(before.password_ciphertext)}:null,null);
    return json({ok:true});
  }

  let body; try { body = await readJson(request,8192); } catch { return json({error:"JSON_INVALIDO"},400); }
  const username = String(body.username || "").trim();
  const passwordProvided = Object.hasOwn(body,"password") && String(body.password).length > 0;
  if (!username || username.length > 128) return json({error:"USUARIO_DE_ACESSO_INVALIDO"},400);
  if (!before && !passwordProvided) return json({error:"SENHA_DE_ACESSO_OBRIGATORIA"},400);
  if (passwordProvided && String(body.password).length > 512) return json({error:"SENHA_DE_ACESSO_MUITO_LONGA"},400);
  let ciphertext = before?.password_ciphertext || null;
  if (passwordProvided) {
    try { ciphertext = await encryptDevicePassword(env,String(body.password),gate.user.id,deviceId); }
    catch (error) {
      if (error?.message === "DEVICE_CREDENTIALS_KEY_NOT_CONFIGURED")
        return json({error:"CRIPTOGRAFIA_DE_CREDENCIAIS_NAO_CONFIGURADA"},503);
      throw error;
    }
  }
  await db.prepare(`
    INSERT INTO device_target_credentials(target_id,user_id,login_username,password_ciphertext,updated_at)
    VALUES (?,?,?,?,CURRENT_TIMESTAMP)
    ON CONFLICT(target_id,user_id) DO UPDATE SET
      login_username=excluded.login_username,password_ciphertext=excluded.password_ciphertext,updated_at=CURRENT_TIMESTAMP
  `).bind(targetId,gate.user.id,username,ciphertext).run();
  const after={username,has_password:Boolean(ciphertext)};
  await audit(env,request,gate.user,"DEVICE_CREDENTIAL_UPDATE","device_target_credential",targetId,
    before?{username:before.login_username,has_password:Boolean(before.password_ciphertext)}:null,after);
  return json({ok:true,credentials:after});
}

/* Clientes/ONUs autenticados vêm de um adaptador HTTP configurado no ambiente.
   Normalizar a resposta aqui mantém a tela independente do fabricante da OLT. */
const primeiroGpon = (...valores) => {
  const achado = valores.find(v => v !== undefined && v !== null && v !== "");
  return achado === undefined ? valores[valores.length - 1] : achado;
};
const numeroGpon = (v) => v !== undefined && v !== null && v !== "" && Number.isFinite(Number(v)) ? Number(v) : null;
const pontosGpon = (valor) => (Array.isArray(valor) ? valor : []).map(p => ({
  lat: numeroGpon(Array.isArray(p) ? p[0] : primeiroGpon(p?.lat, p?.latitude)),
  lon: numeroGpon(Array.isArray(p) ? p[1] : primeiroGpon(p?.lon, p?.lng, p?.longitude))
})).filter(p => p.lat !== null && p.lon !== null && Math.abs(p.lat) <= 90 && Math.abs(p.lon) <= 180);

/* Tráfego e conexão do Radius, normalizados num lugar só.

   O snapshot completo, o delta de 10 s e a leitura de estado precisam produzir
   exatamente os mesmos campos: divergir aqui faria a ficha do cliente mudar de
   forma conforme o ciclo que chegou por último. Os nomes toleram as variações
   do IXC pelo mesmo motivo que o resto do normalizador — a coluna muda de nome
   entre versões da base. */
/* Rótulo que a normalização usa quando nenhuma fonte informou o nome. É texto
   de tela, não dado: gravá-lo no cadastro faria uma coleta sem nome apagar o
   nome verdadeiro do cliente e substituí-lo por este rótulo. */
const GPON_SEM_NOME = "Cliente sem nome";

const CONEXAO_GPON = ["ip", "down_kbps", "up_kbps", "down_bytes", "up_bytes", "uptime_s", "conn_since", "nas_id"];
const conexaoGpon = (c) => ({
  ip: String(primeiroGpon(c?.ip, c?.ip_address, c?.endereco_ip, "")),
  down_kbps: numeroGpon(primeiroGpon(c?.down_kbps, c?.velocidade_download, c?.velocidade_down)),
  up_kbps: numeroGpon(primeiroGpon(c?.up_kbps, c?.velocidade_upload, c?.velocidade_up)),
  down_bytes: numeroGpon(primeiroGpon(c?.down_bytes, c?.consumo_download)),
  up_bytes: numeroGpon(primeiroGpon(c?.up_bytes, c?.consumo_upload)),
  uptime_s: numeroGpon(primeiroGpon(c?.uptime_s, c?.tempo_conectado)),
  conn_since: textoGpon(primeiroGpon(c?.conn_since, c?.ultima_conexao_inicial, ""), 40),
  nas_id: textoGpon(primeiroGpon(c?.nas_id, c?.id_concentrador, ""), 40)
});

function normalizarClienteGpon(c, i) {
  const loc = c?.location || c?.localizacao || {};
  const caminho = primeiroGpon(c?.path, c?.caminho, c?.end_to_end, []);
  return {
    id: String(primeiroGpon(c?.id, c?.client_id, c?.onu_id, c?.serial, c?.sn, `cliente-${i + 1}`)),
    name: String(primeiroGpon(c?.name, c?.nome, c?.customer_name, c?.cliente, c?.username, GPON_SEM_NOME)),
    username: String(primeiroGpon(c?.username, c?.login, c?.pppoe, "")),
    status: String(primeiroGpon(c?.status, c?.state, c?.estado, c?.online === false ? "offline" : "online")).toLowerCase(),
    serial: String(primeiroGpon(c?.serial, c?.sn, c?.onu_serial, "")),
    onu_index: String(primeiroGpon(c?.onu_index, c?.onu, c?.index, "")),
    model: String(primeiroGpon(c?.model, c?.modelo, c?.onu_model, "")),
    state_detail: String(primeiroGpon(c?.state_detail, c?.phase_state, c?.detalhe_estado, "")),
    olt_id: String(primeiroGpon(c?.olt_id, c?.olt, c?.equipment_id, c?.equipamento_id, "")),
    pon: String(primeiroGpon(c?.pon, c?.pon_port, c?.interface, c?.porta_pon, "")),
    vlan: String(primeiroGpon(c?.vlan, c?.service_vlan, "")),
    address: String(primeiroGpon(c?.address, c?.endereco, loc?.address, loc?.endereco, "")),
    lat: numeroGpon(primeiroGpon(c?.lat, c?.latitude, loc?.lat, loc?.latitude)),
    lon: numeroGpon(primeiroGpon(c?.lon, c?.lng, c?.longitude, loc?.lon, loc?.lng, loc?.longitude)),
    rx_power: numeroGpon(primeiroGpon(c?.rx_power, c?.rx, c?.signal, c?.sinal_rx)),
    tx_power: numeroGpon(primeiroGpon(c?.tx_power, c?.tx, c?.sinal_tx)),
    /* Tráfego e conexão do Radius do IXC. Velocidade em kbps (é como o IXC
       provisiona o plano), consumo em bytes e o instante em que a sessão
       começou — a tela deriva o uptime vivo a partir dele, sem que o número
       precise trafegar a cada segundo. */
    ...conexaoGpon(c),
    box_id: String(primeiroGpon(c?.box_id, c?.caixa_id, c?.cto_id, c?.cto, "")),
    /* Porta do splitter dentro da CTO. O coletor já resolve isto a partir de
       porta_ftth/ftth_porta do IXC; sem repassar o campo aqui, a tela da caixa
       não tinha como dizer em que porta cada cliente está pendurado. */
    box_port: String(primeiroGpon(c?.box_port, c?.porta_ftth, c?.ftth_porta, c?.porta_caixa, c?.cto_port, c?.porta_cto, "")),
    /* Código do cliente no ERP: é o número que o operador procura no IXC, e não
       o id sintético da ONU. */
    ixc_id: String(primeiroGpon(c?.ixc_id, c?.customer_id, c?.cliente_id, "")),
    drop_path: pontosGpon(primeiroGpon(c?.drop_path, c?.caminho_drop, c?.route, c?.rota, [])),
    path: Array.isArray(caminho) ? caminho : []
  };
}

function normalizarCaixaGpon(c, i) {
  const loc = c?.location || c?.localizacao || {};
  return {
    id: String(primeiroGpon(c?.id, c?.box_id, c?.cto_id, `caixa-${i + 1}`)),
    name: String(primeiroGpon(c?.name, c?.nome, c?.label, c?.identificacao, `Caixa ${i + 1}`)),
    type: String(primeiroGpon(c?.type, c?.tipo, "CTO")),
    status: String(primeiroGpon(c?.status, c?.estado, "online")).toLowerCase(),
    /* Portas do splitter: com a capacidade a tela da caixa mostra ocupação, e
       não só a contagem de clientes. */
    capacity: numeroGpon(primeiroGpon(c?.capacity, c?.capacidade, c?.portas)),
    pop_id: String(primeiroGpon(c?.pop_id, c?.pop, "")),
    address: String(primeiroGpon(c?.address, c?.endereco, loc?.address, loc?.endereco, "")),
    lat: numeroGpon(primeiroGpon(c?.lat, c?.latitude, loc?.lat, loc?.latitude)),
    lon: numeroGpon(primeiroGpon(c?.lon, c?.lng, c?.longitude, loc?.lon, loc?.lng, loc?.longitude))
  };
}

async function handleGponClients(env, request) {
  const gate = await requirePermission(env, request, "topology.view");
  if (gate.response) return gate.response;
  return json(await aplicarCadastroClientes(env, await carregarFeedGpon(env)));
}

/* O botão "Atualizar" da tela GPON. Diferente da leitura comum (que devolve o
   que o Worker já tem), aqui o Worker pede ao coletor uma sincronização forçada:
   a OLT inteira é lida de novo e o IXC ignora a janela de recirculação. No
   Worker em nuvem sem acesso direto ao coletor, resta o último snapshot. */
async function handleGponRefresh(env, request) {
  const gate = await requirePermission(env, request, "topology.view");
  if (gate.response) return gate.response;
  const endpoint = String(env.GPON_CLIENTS_URL || "").trim();
  if (endpoint) {
    try {
      const sourceUrl = new URL(endpoint);
      const localDev = sourceUrl.protocol === "http:" && ["localhost", "127.0.0.1", "::1"].includes(sourceUrl.hostname);
      if (sourceUrl.protocol !== "https:" && !localDev) throw new Error("GPON_CLIENTS_URL deve usar HTTPS");
      sourceUrl.pathname = "/api/gpon/sync";
      sourceUrl.search = "";
      const headers = { Accept: "application/json", "Content-Type": "application/json" };
      if (env.GPON_CLIENTS_TOKEN) headers.Authorization = `Bearer ${env.GPON_CLIENTS_TOKEN}`;
      const upstream = await fetch(sourceUrl, { method: "POST", headers, signal: AbortSignal.timeout(90000) });
      if (!upstream.ok) throw new Error(`HTTP ${upstream.status}`);
      const tamanho = Number(upstream.headers.get("content-length") || 0);
      if (tamanho > 8 * 1024 * 1024) throw new Error("Resposta GPON maior que 8 MiB");
      const raw = await upstream.json();
      const feed = payloadGpon(raw?.data || raw, "Sincronização forçada: a OLT e o IXC foram consultados agora.");
      return json(await aplicarCadastroClientes(env, feed));
    } catch (error) {
      console.error(JSON.stringify({ message: "Falha na sincronização forçada GPON", error: error?.message || String(error) }));
    }
  }
  return json(await aplicarCadastroClientes(env, await carregarFeedGpon(env)));
}

/* Leitura da OLT no formato de dados. handleGponClients apenas a embrulha em
   uma resposta; a home usa os mesmos números sem uma segunda ida à fonte. */
async function carregarFeedGpon(env) {
  const endpoint = String(env.GPON_CLIENTS_URL || "").trim();
  if (!endpoint) {
    const snapshot = await loadGponSnapshot(env);
    if (snapshot) return payloadGpon(snapshot);
    return { configured: false, source: "Aguardando primeira sincronização", synced_at: null,
      clients: [], boxes: [], alerts: [], message: "O coletor ainda não enviou a primeira atualização GPON." };
  }
  try {
    const sourceUrl = new URL(endpoint);
    const localDev = sourceUrl.protocol === "http:" && ["localhost", "127.0.0.1", "::1"].includes(sourceUrl.hostname);
    if (sourceUrl.protocol !== "https:" && !localDev) throw new Error("GPON_CLIENTS_URL deve usar HTTPS");
    const headers = { Accept: "application/json" };
    if (env.GPON_CLIENTS_TOKEN) headers.Authorization = `Bearer ${env.GPON_CLIENTS_TOKEN}`;
    const upstream = await fetch(sourceUrl, { headers, signal: AbortSignal.timeout(12000) });
    if (!upstream.ok) throw new Error(`HTTP ${upstream.status}`);
    const tamanho = Number(upstream.headers.get("content-length") || 0);
    if (tamanho > 8 * 1024 * 1024) throw new Error("Resposta GPON maior que 8 MiB");
    const raw = await upstream.json();
    return payloadGpon(raw?.data || raw);
  } catch (error) {
    console.error(JSON.stringify({ message: "Falha na integração GPON", error: error?.message || String(error) }));
    const snapshot = await loadGponSnapshot(env);
    if (snapshot) return payloadGpon(snapshot, "A fonte direta está indisponível; exibindo a última sincronização recebida.");
    return { configured: true, unavailable: true, source: "Integração OLT", synced_at: null,
      clients: [], boxes: [], alerts: [], message: "A fonte da OLT não respondeu nesta atualização." };
  }
}

function payloadGpon(data, message = "") {
  const clients = primeiroGpon(data?.clients, data?.clientes, data?.onus, data?.subscribers, Array.isArray(data) ? data : []);
  const boxes = primeiroGpon(data?.boxes, data?.caixas, data?.ctos, []);
  const alerts = primeiroGpon(data?.alerts, data?.alertas, []);
  return {
    configured: true,
    source: String(primeiroGpon(data?.source, data?.fonte, "Coletor ZTE + IXC Provedor")),
    synced_at: primeiroGpon(data?.synced_at, data?.updated_at, data?.atualizado_em, new Date().toISOString()),
    clients: (Array.isArray(clients) ? clients : []).map(normalizarClienteGpon),
    boxes: (Array.isArray(boxes) ? boxes : []).map(normalizarCaixaGpon),
    alerts: Array.isArray(alerts) ? alerts.filter(alert => !alert?.client_id) : [],
    ...(message ? { message } : {})
  };
}

/* ---- cadastro de clientes mantido na plataforma ---- */

const CLIENTE_CAMPOS = [
  "ixc_id", "nome", "cpf_cnpj", "telefone", "email", "endereco", "bairro", "cidade", "uf", "cep",
  "plano", "ont_serial", "ont_modelo", "ip_gerencia", "login_pppoe", "login_roteador", "ssid", "observacao"
];
const CLIENTE_NUMERICOS = ["lat", "lon", "valor_mensal", "vencimento_dia"];
const STATUS_FATURAMENTO = new Set(["ativo", "inativo", "cancelado", "bloqueado", "suspenso"]);

const parseJsonLista = (texto, padrao = []) => {
  try { const v = JSON.parse(texto || "[]"); return Array.isArray(v) ? v : padrao; } catch { return padrao; }
};

/* O cadastro sai para a tela sem as senhas: elas só abrem na leitura individual
   (e para quem tem a ação de edição). */
function publicCadastro(cad) {
  return {
    client_id: String(cad.client_id),
    ixc_id: String(cad.ixc_id || ""), origem: String(cad.origem || "manual"),
    nome: cad.nome, cpf_cnpj: cad.cpf_cnpj, telefone: cad.telefone, email: cad.email,
    endereco: cad.endereco, bairro: cad.bairro, cidade: cad.cidade, uf: cad.uf, cep: cad.cep,
    lat: cad.lat ?? null, lon: cad.lon ?? null,
    plano: cad.plano, valor_mensal: cad.valor_mensal ?? null, vencimento_dia: cad.vencimento_dia ?? null,
    status_faturamento: cad.status_faturamento,
    aparelhos: parseJsonLista(cad.aparelhos_json),
    ont_serial: cad.ont_serial, ont_modelo: cad.ont_modelo, ip_gerencia: cad.ip_gerencia,
    login_pppoe: cad.login_pppoe, has_senha_pppoe: Boolean(cad.senha_pppoe_cipher),
    login_roteador: cad.login_roteador, has_senha_roteador: Boolean(cad.senha_roteador_cipher),
    ssid: cad.ssid, has_senha_wifi: Boolean(cad.senha_wifi_cipher),
    has_senha_portal: Boolean(cad.senha_portal_cipher),
    observacao: cad.observacao, updated_at: cad.updated_at
  };
}

/* O cadastro sobrepõe o feed onde o operador corrigiu a informação: nome e
   endereço mais atualizados que o ERP, coordenadas ajustadas no mapa. Campos
   vazios do cadastro deixam o dado da OLT/IXC passar. */
function sobrescreverClienteCadastro(cad) {
  const overrides = {};
  if (String(cad.nome || "").trim()) overrides.name = cad.nome;
  if (String(cad.endereco || "").trim()) overrides.address = cad.endereco;
  const lat = Number(cad.lat), lon = Number(cad.lon);
  if (cad.lat !== null && cad.lat !== undefined && Number.isFinite(lat) && Math.abs(lat) <= 90) overrides.lat = lat;
  if (cad.lon !== null && cad.lon !== undefined && Number.isFinite(lon) && Math.abs(lon) <= 180) overrides.lon = lon;
  if (String(cad.ip_gerencia || "").trim()) overrides.ip = cad.ip_gerencia;
  return overrides;
}

/* O cadastro é chaveado pelo código do cliente no IXC — o mesmo número do ERP,
   e não o id sintético da ONU —, então um cliente com duas ONUs tem um cadastro
   só. O casamento tenta o id do feed primeiro (cadastros antigos, digitados
   antes da importação) e cai no código IXC depois. */
function indexarCadastros(rows) {
  const porClientId = new Map(), porIxc = new Map();
  for (const row of rows) {
    porClientId.set(String(row.client_id), row);
    const ixc = String(row.ixc_id || "").trim();
    if (ixc && !porIxc.has(ixc)) porIxc.set(ixc, row);
  }
  return (cliente) => porClientId.get(String(cliente?.id ?? ""))
    || porIxc.get(String(cliente?.ixc_id ?? "").trim())
    || null;
}

async function aplicarCadastroClientes(env, feed) {
  if (!feed || !Array.isArray(feed.clients)) return feed;
  const rows = (await getDB(env).prepare(`SELECT * FROM cliente_cadastro`).all()).results || [];
  if (!rows.length) return feed;
  const achar = indexarCadastros(rows);
  feed.clients = feed.clients.map((cliente) => {
    const cad = achar(cliente);
    if (!cad) return cliente;
    return { ...cliente, cadastro: publicCadastro(cad), ...sobrescreverClienteCadastro(cad) };
  });
  return feed;
}

/* ---- importação automática do que a coleta GPON traz ----

   Todo cliente que chega no snapshot com código do IXC vira cadastro na
   plataforma, para que a tela de Cadastro de Cliente e a Lista do GPON falem
   da mesma base. A importação só *cria*: o que o operador corrigiu depois
   (nome, endereço, coordenadas, faturamento) nunca é sobrescrito por uma
   coleta seguinte — é justamente o cadastro que sobrepõe o feed no mapa.

   ONU sem código IXC fica de fora: é equipamento que o ERP ainda não
   reconhece como cliente, e cadastrá-la só encheria a tabela de id sintético.

   Teto por ciclo porque a primeira coleta de um parque inteiro tentaria
   escrever dezenas de milhares de linhas dentro de uma única requisição; o que
   sobrar entra no ciclo seguinte, que roda a cada leitura completa. */
const CLIENTE_IMPORT_MAX_PER_RUN = 2000;
const CLIENTE_IMPORT_BATCH = 25;

/* O endereço vem do IXC montado como "rua, número — bairro — cidade". Só
   separamos quando as três partes estão lá; com menos, a divisão seria adivinhação
   e o texto inteiro fica no campo de endereço. */
export function enderecoCadastroGpon(address) {
  const partes = String(address || "").split(" — ").map((p) => p.trim()).filter(Boolean);
  if (partes.length === 3) return { endereco: partes[0], bairro: partes[1], cidade: partes[2] };
  return { endereco: String(address || "").trim(), bairro: "", cidade: "" };
}

export function candidatosCadastroGpon(clients) {
  const porCodigo = new Map();
  (Array.isArray(clients) ? clients : []).forEach((bruto, i) => {
    const cliente = normalizarClienteGpon(bruto, i);
    const codigo = String(cliente.ixc_id || "").trim();
    if (!codigo || codigo === "0" || porCodigo.has(codigo)) return;
    const local = enderecoCadastroGpon(cliente.address);
    porCodigo.set(codigo, {
      client_id: codigo.slice(0, 120),
      ixc_id: codigo.slice(0, 120),
      nome: textoGpon(cliente.name === GPON_SEM_NOME ? "" : cliente.name, 200),
      endereco: textoGpon(local.endereco, 200),
      bairro: textoGpon(local.bairro, 200),
      cidade: textoGpon(local.cidade, 200),
      lat: Number.isFinite(cliente.lat) && Math.abs(cliente.lat) <= 90 ? cliente.lat : null,
      lon: Number.isFinite(cliente.lon) && Math.abs(cliente.lon) <= 180 ? cliente.lon : null,
      ont_serial: textoGpon(cliente.serial, 200),
      ont_modelo: textoGpon(cliente.model, 200),
      ip_gerencia: textoGpon(cliente.ip, 200),
      login_pppoe: textoGpon(cliente.username, 200)
    });
  });
  return [...porCodigo.values()];
}

/* Campos que pertencem ao IXC: são os que a coleta escreve e os que ela pode
   reescrever quando o ERP muda. Todo o resto do cadastro — telefone, plano,
   senhas, aparelhos, observação — nasce e vive só na plataforma, e nenhuma
   coleta encosta neles. */
const CLIENTE_CAMPOS_IXC = ["nome", "endereco", "bairro", "cidade", "lat", "lon",
  "ont_serial", "ont_modelo", "ip_gerencia", "login_pppoe"];

/* O cadastro é "espelho do IXC" enquanto nenhum humano o tiver corrigido.

   `origem='ixc'` diz que a linha nasceu da coleta; `updated_by IS NULL` diz que
   ninguém a editou desde então — a importação não preenche esse campo e a
   edição manual sempre preenche. Só a combinação dos dois libera a
   ressincronização: assim, corrigir a coordenada no ERP chega à tela sozinho,
   e a correção que o operador digitou à mão continua ganhando da coleta. */
const ESPELHA_IXC = `origem='ixc' AND updated_by IS NULL`;

/* Uma coleta em que o IXC devolveu o campo vazio não pode apagar o que já
   estava lá: ausência de dado não é ordem de apagar. Só valor preenchido
   sobrescreve. */
const mudouCampo = (novo, atual) => {
  if (novo === null || novo === undefined || novo === "") return false;
  if (typeof novo === "number") return Number(atual) !== novo;
  return String(atual ?? "") !== String(novo);
};

export async function importarCadastroGpon(db, clients) {
  const candidatos = candidatosCadastroGpon(clients);
  if (!candidatos.length) return { criados: 0, pendentes: 0, atualizados: 0 };
  const existentes = new Map(((await db.prepare(
    `SELECT client_id,origem,updated_by,${CLIENTE_CAMPOS_IXC.join(",")} FROM cliente_cadastro`
  ).all()).results || []).map((row) => [String(row.client_id), row]));

  const novos = candidatos.filter((c) => !existentes.has(c.client_id));
  const lote = novos.slice(0, CLIENTE_IMPORT_MAX_PER_RUN);
  for (let i = 0; i < lote.length; i += CLIENTE_IMPORT_BATCH) {
    await db.batch(lote.slice(i, i + CLIENTE_IMPORT_BATCH).map((c) => db.prepare(`
      INSERT INTO cliente_cadastro(client_id,ixc_id,origem,nome,endereco,bairro,cidade,lat,lon,
        ont_serial,ont_modelo,ip_gerencia,login_pppoe)
      VALUES (?,?,'ixc',?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(client_id) DO NOTHING
    `).bind(c.client_id, c.ixc_id, c.nome, c.endereco, c.bairro, c.cidade, c.lat, c.lon,
      c.ont_serial, c.ont_modelo, c.ip_gerencia, c.login_pppoe)));
  }

  /* A comparação acontece em memória para que um parque estável custe zero
     escrita: sem ela, cada ciclo completo reescreveria a base inteira a cada
     dez minutos para não mudar nada. Só os campos que de fato mudaram entram
     no SET — e como o `mudouCampo` já descartou o valor vazio, nada aqui apaga
     dado bom. Os nomes de coluna vêm da lista fixa acima, nunca do dado. */
  const alterados = [];
  for (const c of candidatos) {
    const atual = existentes.get(c.client_id);
    if (!atual || atual.origem !== "ixc" || atual.updated_by !== null) continue;
    const campos = CLIENTE_CAMPOS_IXC.filter((campo) => mudouCampo(c[campo], atual[campo]));
    if (campos.length) alterados.push({ client_id: c.client_id, campos, valores: campos.map((campo) => c[campo]) });
    if (alterados.length >= CLIENTE_IMPORT_MAX_PER_RUN) break;
  }

  for (let i = 0; i < alterados.length; i += CLIENTE_IMPORT_BATCH) {
    await db.batch(alterados.slice(i, i + CLIENTE_IMPORT_BATCH).map((a) => db.prepare(`
      UPDATE cliente_cadastro SET ${a.campos.map((campo) => `${campo}=?`).join(",")},updated_at=CURRENT_TIMESTAMP
      WHERE client_id=? AND ${ESPELHA_IXC}
    `).bind(...a.valores, a.client_id)));
  }

  return { criados: lote.length, pendentes: novos.length - lote.length, atualizados: alterados.length };
}

function normalizarCadastroBody(body) {
  const dados = {};
  for (const campo of CLIENTE_CAMPOS)
    dados[campo] = String(body?.[campo] ?? "").trim().slice(0, campo === "observacao" ? 2000 : 200);
  for (const campo of CLIENTE_NUMERICOS) {
    const valor = body?.[campo];
    if (valor === undefined || valor === null || valor === "") { dados[campo] = null; continue; }
    const numero = Number(valor);
    dados[campo] = Number.isFinite(numero) ? numero : null;
  }
  dados.status_faturamento = STATUS_FATURAMENTO.has(body?.status_faturamento) ? body.status_faturamento : "ativo";
  // O CPF/CNPJ é sempre armazenado sem máscara (somente dígitos).
  if (dados.cpf_cnpj) dados.cpf_cnpj = dados.cpf_cnpj.replace(/\D/g, "");
  // Compatibilidade: o frontend antigo ainda manda `documento`; normaliza para `cpf_cnpj`.
  if (!dados.cpf_cnpj && body?.documento) dados.cpf_cnpj = String(body.documento).replace(/\D/g, "").slice(0, 20);
  dados.aparelhos = (Array.isArray(body?.aparelhos) ? body.aparelhos : []).slice(0, 40).map((a, i) => ({
    nome: String(a?.nome ?? a?.name ?? `Aparelho ${i + 1}`).trim().slice(0, 120),
    tipo: String(a?.tipo ?? "").trim().slice(0, 60),
    serial: String(a?.serial ?? "").trim().slice(0, 80)
  })).filter(a => a.nome);
  return dados;
}

async function handleClientesList(env, request, url) {
  const gate = await requirePermission(env, request, "clientes.view");
  if (gate.response) return gate.response;
  const db = getDB(env);
  const q = textoGpon(url.searchParams.get("q") || "", 80).toLowerCase();
  let rows;
  if (q) {
    const termo = `%${q}%`;
    rows = (await db.prepare(`
      SELECT * FROM cliente_cadastro
      WHERE lower(nome) LIKE ? OR lower(client_id) LIKE ? OR lower(telefone) LIKE ?
        OR lower(cpf_cnpj) LIKE ?
        OR replace(replace(replace(cpf_cnpj, '.', ''), '-', ''), '/', '') LIKE ?
      ORDER BY nome,client_id
    `).bind(termo, termo, termo, termo, termo).all()).results || [];
  } else {
    rows = (await db.prepare(`SELECT * FROM cliente_cadastro ORDER BY nome,client_id`).all()).results || [];
  }
  const snapshot = await loadGponSnapshot(env).catch(() => null);
  const porId = new Map(), porIxc = new Map();
  for (const c of snapshot?.clients || []) {
    porId.set(String(c?.id), c);
    const ixc = String(c?.ixc_id ?? "").trim();
    if (ixc && !porIxc.has(ixc)) porIxc.set(ixc, c);
  }
  const registros = rows.map((row) => {
    const feedCliente = porId.get(String(row.client_id))
      || porIxc.get(String(row.ixc_id || row.client_id).trim());
    return {
      ...publicCadastro(row),
      feed: feedCliente ? {
        name: String(feedCliente.name || ""), username: String(feedCliente.username || ""),
        serial: String(feedCliente.serial || ""), onu_index: String(feedCliente.onu_index || ""),
        olt_id: String(feedCliente.olt_id || ""), pon: String(feedCliente.pon || ""),
        status: String(feedCliente.status || ""), address: String(feedCliente.address || ""),
        ixc_id: String(feedCliente.ixc_id || "")
      } : null
    };
  });
  return json({ registros, total: rows.length });
}

/* Clientes do feed que ainda não têm cadastro — o seletor do "Novo cadastro".
   Sem expor a fonte completa: limitado à busca e a um teto pequeno. */
async function handleClientesFeed(env, request, url) {
  const gate = await requirePermission(env, request, "clientes.view");
  if (gate.response) return gate.response;
  const snapshot = await loadGponSnapshot(env).catch(() => null);
  const brutos = Array.isArray(snapshot?.clients) ? snapshot.clients : [];
  const registrados = new Set();
  for (const r of (await getDB(env).prepare(`SELECT client_id,ixc_id FROM cliente_cadastro`).all()).results || []) {
    registrados.add(String(r.client_id));
    if (String(r.ixc_id || "").trim()) registrados.add(String(r.ixc_id).trim());
  }
  const q = textoGpon(url.searchParams.get("q") || "", 80).toLowerCase();
  const limite = Math.min(Math.max(Number(url.searchParams.get("limit")) || 50, 1), 200);
  const clientes = brutos
    .map(normalizarClienteGpon)
    .filter((c) => !registrados.has(String(c.id)) && !registrados.has(String(c.ixc_id || "").trim()))
    /* 'codigo' é o que vai virar a chave do cadastro: o número do IXC quando o
       ERP reconhece o cliente, e o id da ONU só quando não reconhece. */
    .map((c) => ({ id: c.id, codigo: String(c.ixc_id || "").trim() || c.id,
      name: c.name, username: c.username, serial: c.serial,
      onu_index: c.onu_index, olt_id: c.olt_id, pon: c.pon, address: c.address, ixc_id: c.ixc_id }))
    .filter((c) => !q || [c.id, c.codigo, c.name, c.username, c.serial, c.address, c.ixc_id]
      .some((v) => String(v || "").toLowerCase().includes(q)))
    .slice(0, limite);
  return json({ clientes });
}

async function handleClientesCreate(env, request) {
  const gate = await requirePermission(env, request, "clientes.create");
  if (gate.response) return gate.response;
  const db = getDB(env);
  let body = {};
  try { body = await readJson(request, 16384); } catch { return json({ error: "INVALID_JSON" }, 400); }
  const clientId = String(body.client_id || "").trim();
  if (!clientId || clientId.length > 120) return json({ error: "CLIENTE_ID_OBRIGATORIO" }, 400);
  const existe = await db.prepare(`SELECT client_id FROM cliente_cadastro WHERE client_id=?`).bind(clientId).first();
  if (existe) return json({ error: "CLIENTE_JA_CADASTRADO" }, 409);
  const dados = normalizarCadastroBody(body);
  const senhaPppoe = await hashSenhaCliente(body.senha_pppoe);
  const senhaRoteador = await hashSenhaCliente(body.senha_roteador);
  const senhaWifi = await hashSenhaCliente(body.senha_wifi);
  // Senha inicial do app do cliente (papel "cliente"): sempre nasce exigindo
  // troca no primeiro acesso.
  const senhaPortal = await hashSenhaCliente(body.senha_portal);
  await db.prepare(`
    INSERT INTO cliente_cadastro(client_id,ixc_id,origem,nome,cpf_cnpj,telefone,email,endereco,bairro,cidade,uf,cep,
      lat,lon,plano,valor_mensal,vencimento_dia,status_faturamento,aparelhos_json,
      ont_serial,ont_modelo,ip_gerencia,login_pppoe,senha_pppoe_cipher,
      login_roteador,senha_roteador_cipher,ssid,senha_wifi_cipher,senha_portal_cipher,portal_must_change_password,observacao,updated_by)
    VALUES (?,?,'manual',?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1,?,?)
  `).bind(clientId, dados.ixc_id, dados.nome, dados.cpf_cnpj, dados.telefone, dados.email, dados.endereco,
    dados.bairro, dados.cidade, dados.uf, dados.cep, dados.lat, dados.lon, dados.plano,
    dados.valor_mensal, dados.vencimento_dia, dados.status_faturamento, JSON.stringify(dados.aparelhos),
    dados.ont_serial, dados.ont_modelo, dados.ip_gerencia, dados.login_pppoe, senhaPppoe,
    dados.login_roteador, senhaRoteador, dados.ssid, senhaWifi, senhaPortal, dados.observacao, gate.user.id).run();
  const depois = await db.prepare(`SELECT * FROM cliente_cadastro WHERE client_id=?`).bind(clientId).first();
  await audit(env, request, gate.user, "CLIENTE_CREATE", "cliente_cadastro", clientId, null, depois);
  return json({ ok: true, cliente: publicCadastro(depois) }, 201);
}

async function handleClientesGet(env, request, clientId) {
  const gate = await requirePermission(env, request, "clientes.view");
  if (gate.response) return gate.response;
  const db = getDB(env);
  const row = await db.prepare(`SELECT * FROM cliente_cadastro WHERE client_id=?`).bind(clientId).first();
  if (!row) return json({ error: "CLIENTE_NAO_ENCONTRADO" }, 404);
  const dados = publicCadastro(row);
  return json(dados);
}

async function handleClientesUpdate(env, request, clientId) {
  const gate = await requirePermission(env, request, "clientes.edit");
  if (gate.response) return gate.response;
  const db = getDB(env);
  const antes = await db.prepare(`SELECT * FROM cliente_cadastro WHERE client_id=?`).bind(clientId).first();
  if (!antes) return json({ error: "CLIENTE_NAO_ENCONTRADO" }, 404);
  let body = {};
  try { body = await readJson(request, 16384); } catch { return json({ error: "INVALID_JSON" }, 400); }
  const dados = normalizarCadastroBody(body);
  let senhaPppoe = antes.senha_pppoe_cipher, senhaRoteador = antes.senha_roteador_cipher, senhaWifi = antes.senha_wifi_cipher;
  if (body.senha_pppoe && String(body.senha_pppoe) !== "") senhaPppoe = await hashSenhaCliente(body.senha_pppoe);
  if (body.senha_roteador && String(body.senha_roteador) !== "") senhaRoteador = await hashSenhaCliente(body.senha_roteador);
  if (body.senha_wifi && String(body.senha_wifi) !== "") senhaWifi = await hashSenhaCliente(body.senha_wifi);
  // Senha do app do cliente: só muda quando staff informa uma nova; ao mudar,
  // volta a exigir troca no próximo login (mesmo padrão do primeiro acesso).
  let senhaPortal = antes.senha_portal_cipher, portalMustChange = antes.portal_must_change_password;
  if (body.senha_portal && String(body.senha_portal) !== "") {
    senhaPortal = await hashSenhaCliente(body.senha_portal);
    portalMustChange = 1;
  }
  /* O código do IXC só é preenchido, nunca apagado: a tela de edição do mapa
     manda o cadastro inteiro de volta e um campo vazio ali não é motivo para
     perder o vínculo com o ERP. */
  const ixcId = String(dados.ixc_id || antes.ixc_id || "").trim();
  await db.prepare(`
    UPDATE cliente_cadastro SET ixc_id=?,nome=?,cpf_cnpj=?,telefone=?,email=?,endereco=?,bairro=?,cidade=?,uf=?,cep=?,
      lat=?,lon=?,plano=?,valor_mensal=?,vencimento_dia=?,status_faturamento=?,aparelhos_json=?,
      ont_serial=?,ont_modelo=?,ip_gerencia=?,login_pppoe=?,senha_pppoe_cipher=?,
      login_roteador=?,senha_roteador_cipher=?,ssid=?,senha_wifi_cipher=?,
      senha_portal_cipher=?,portal_must_change_password=?,observacao=?,
      updated_by=?,updated_at=CURRENT_TIMESTAMP
    WHERE client_id=?
  `).bind(ixcId, dados.nome, dados.cpf_cnpj, dados.telefone, dados.email, dados.endereco, dados.bairro,
    dados.cidade, dados.uf, dados.cep, dados.lat, dados.lon, dados.plano, dados.valor_mensal,
    dados.vencimento_dia, dados.status_faturamento, JSON.stringify(dados.aparelhos),
    dados.ont_serial, dados.ont_modelo, dados.ip_gerencia, dados.login_pppoe, senhaPppoe,
    dados.login_roteador, senhaRoteador, dados.ssid, senhaWifi,
    senhaPortal, portalMustChange, dados.observacao, gate.user.id, clientId).run();
  const depois = await db.prepare(`SELECT * FROM cliente_cadastro WHERE client_id=?`).bind(clientId).first();
  await audit(env, request, gate.user, "CLIENTE_UPDATE", "cliente_cadastro", clientId, antes, depois);
  return json({ ok: true, cliente: publicCadastro(depois) });
}

async function handleClientesDelete(env, request, clientId) {
  const gate = await requirePermission(env, request, "clientes.delete");
  if (gate.response) return gate.response;
  const db = getDB(env);
  const antes = await db.prepare(`SELECT * FROM cliente_cadastro WHERE client_id=?`).bind(clientId).first();
  if (!antes) return json({ error: "CLIENTE_NAO_ENCONTRADO" }, 404);
  await db.prepare(`DELETE FROM cliente_cadastro WHERE client_id=?`).bind(clientId).run();
  await audit(env, request, gate.user, "CLIENTE_DELETE", "cliente_cadastro", clientId, antes, null);
  return json({ ok: true });
}

/* ---- Cadastro de locais (POP / Data Center / ISP) ----
   Fonte única de dados de local: o mapa de topologia lê e grava aqui por
   baixo do mesmo contrato de /api/topology (ver handleTopology). Esta rota
   é o CRUD direto, para quem administra o cadastro sem passar pelo mapa.
   LOCAL_TIPOS está definida mais acima, junto da semeadura da topologia. */

function normalizarLocalBody(body) {
  const numOuNulo = (v) => {
    if (v === undefined || v === null || v === "") return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };
  return {
    nome: String(body?.nome ?? "").trim().slice(0, 200),
    tipo: LOCAL_TIPOS.has(body?.tipo) ? body.tipo : "POP",
    endereco: String(body?.endereco ?? "").trim().slice(0, 200),
    lat: numOuNulo(body?.lat),
    lon: numOuNulo(body?.lon),
    observacao: String(body?.observacao ?? "").trim().slice(0, 2000)
  };
}

async function handleLocaisList(env, request, url) {
  const gate = await requirePermission(env, request, "locais.view");
  if (gate.response) return gate.response;
  const db = getDB(env);
  const q = String(url.searchParams.get("q") || "").trim().slice(0, 80).toLowerCase();
  const tipo = LOCAL_TIPOS.has(url.searchParams.get("tipo")) ? url.searchParams.get("tipo") : null;
  const condicoes = [], valores = [];
  if (q) { condicoes.push(`(lower(nome) LIKE ? OR lower(endereco) LIKE ?)`); valores.push(`%${q}%`, `%${q}%`); }
  if (tipo) { condicoes.push(`tipo=?`); valores.push(tipo); }
  const where = condicoes.length ? `WHERE ${condicoes.join(" AND ")}` : "";
  const rows = (await db.prepare(`SELECT * FROM locais ${where} ORDER BY nome`).bind(...valores).all()).results || [];
  return json({ registros: rows, total: rows.length });
}

async function handleLocaisCreate(env, request) {
  const gate = await requirePermission(env, request, "locais.create");
  if (gate.response) return gate.response;
  const db = getDB(env);
  let body = {};
  try { body = await readJson(request, 16384); } catch { return json({ error: "INVALID_JSON" }, 400); }
  const dados = normalizarLocalBody(body);
  if (!dados.nome) return json({ error: "NOME_OBRIGATORIO" }, 400);
  const id = String(body.id || "").trim().slice(0, 120) || `local-${Date.now()}`;
  const existe = await db.prepare(`SELECT id FROM locais WHERE id=?`).bind(id).first();
  if (existe) return json({ error: "LOCAL_JA_CADASTRADO" }, 409);
  await db.prepare(`
    INSERT INTO locais(id,nome,tipo,endereco,lat,lon,observacao,origem,updated_by)
    VALUES (?,?,?,?,?,?,?,'manual',?)
  `).bind(id, dados.nome, dados.tipo, dados.endereco, dados.lat, dados.lon, dados.observacao, gate.user.id).run();
  const depois = await db.prepare(`SELECT * FROM locais WHERE id=?`).bind(id).first();
  await audit(env, request, gate.user, "LOCAL_CREATE", "locais", id, null, depois);
  return json({ ok: true, local: depois }, 201);
}

async function handleLocaisGet(env, request, id) {
  const gate = await requirePermission(env, request, "locais.view");
  if (gate.response) return gate.response;
  const row = await getDB(env).prepare(`SELECT * FROM locais WHERE id=?`).bind(id).first();
  if (!row) return json({ error: "LOCAL_NAO_ENCONTRADO" }, 404);
  return json(row);
}

async function handleLocaisUpdate(env, request, id) {
  const gate = await requirePermission(env, request, "locais.edit");
  if (gate.response) return gate.response;
  const db = getDB(env);
  const antes = await db.prepare(`SELECT * FROM locais WHERE id=?`).bind(id).first();
  if (!antes) return json({ error: "LOCAL_NAO_ENCONTRADO" }, 404);
  let body = {};
  try { body = await readJson(request, 16384); } catch { return json({ error: "INVALID_JSON" }, 400); }
  const dados = normalizarLocalBody(body);
  if (!dados.nome) return json({ error: "NOME_OBRIGATORIO" }, 400);
  await db.prepare(`
    UPDATE locais SET nome=?,tipo=?,endereco=?,lat=?,lon=?,observacao=?,updated_by=?,updated_at=CURRENT_TIMESTAMP
    WHERE id=?
  `).bind(dados.nome, dados.tipo, dados.endereco, dados.lat, dados.lon, dados.observacao, gate.user.id, id).run();
  const depois = await db.prepare(`SELECT * FROM locais WHERE id=?`).bind(id).first();
  await audit(env, request, gate.user, "LOCAL_UPDATE", "locais", id, antes, depois);
  return json({ ok: true, local: depois });
}

async function handleLocaisDelete(env, request, id) {
  const gate = await requirePermission(env, request, "locais.delete");
  if (gate.response) return gate.response;
  const db = getDB(env);
  const antes = await db.prepare(`SELECT * FROM locais WHERE id=?`).bind(id).first();
  if (!antes) return json({ error: "LOCAL_NAO_ENCONTRADO" }, 404);
  await db.prepare(`DELETE FROM locais WHERE id=?`).bind(id).run();
  await audit(env, request, gate.user, "LOCAL_DELETE", "locais", id, antes, null);
  return json({ ok: true });
}

/* ---- Cadastro de produtos (equipamentos) ----
   Item físico único, vinculável a um local. Mesma ideia do cadastro de
   locais: é a fonte de dados que o mapa de topologia usa por baixo do
   contrato de /api/topology, e também um CRUD direto para administração. */
const PRODUTO_ESCOPOS = new Set(["noc", "isp"]);

function normalizarProdutoBody(body) {
  const portas = (Array.isArray(body?.portas) ? body.portas : []).slice(0, 200).map((p, i) => ({
    numero: Number.isFinite(Number(p?.numero)) ? Number(p.numero) : i + 1,
    capacidade: String(p?.capacidade ?? "").trim().slice(0, 60),
    tipo: String(p?.tipo ?? "").trim().slice(0, 60),
    status: String(p?.status ?? "livre").trim().slice(0, 30),
    ...(p?.nome !== undefined ? { nome: String(p.nome).trim().slice(0, 80) } : {}),
    ...(p?.descricao !== undefined ? { descricao: String(p.descricao).trim().slice(0, 200) } : {}),
    ...(p?.observacao !== undefined ? { observacao: String(p.observacao).trim().slice(0, 200) } : {}),
    ...(p?.slot !== undefined ? { slot: Number(p.slot) } : {}),
    ...(p?.subslot !== undefined ? { subslot: Number(p.subslot) } : {}),
    ...(p?.tipoPlaca !== undefined ? { tipoPlaca: String(p.tipoPlaca).trim().slice(0, 40) } : {}),
    ...(p?.tecnologia !== undefined ? { tecnologia: String(p.tecnologia).trim().slice(0, 40) } : {})
  }));
  return {
    nome: String(body?.nome ?? "").trim().slice(0, 200),
    fabricante: String(body?.fabricante ?? "").trim().slice(0, 120),
    modelo: String(body?.modelo ?? "").trim().slice(0, 200),
    categoria: String(body?.categoria ?? "").trim().slice(0, 120),
    serial: String(body?.serial ?? "").trim().slice(0, 120),
    local_id: body?.local_id ? String(body.local_id).trim().slice(0, 120) : null,
    escopo: PRODUTO_ESCOPOS.has(body?.escopo) ? body.escopo : "noc",
    observacao: String(body?.observacao ?? "").trim().slice(0, 2000),
    portas_json: JSON.stringify(portas),
    imagem: String(body?.imagem ?? "").trim().slice(0, 300),
    imagem_alt: String(body?.imagemAlt ?? "").trim().slice(0, 300),
    hotspots_json: body?.hotspots ? JSON.stringify(body.hotspots).slice(0, 2000) : "",
    layout_portas: String(body?.layoutPortas ?? "").trim().slice(0, 60)
  };
}

async function validarLocalId(db, localId) {
  if (!localId) return true;
  return !!(await db.prepare(`SELECT id FROM locais WHERE id=?`).bind(localId).first());
}

async function handleProdutosList(env, request, url) {
  const gate = await requirePermission(env, request, "produtos.view");
  if (gate.response) return gate.response;
  const db = getDB(env);
  const q = String(url.searchParams.get("q") || "").trim().slice(0, 80).toLowerCase();
  const localId = url.searchParams.get("local_id");
  const condicoes = [], valores = [];
  if (q) {
    condicoes.push(`(lower(nome) LIKE ? OR lower(modelo) LIKE ? OR lower(serial) LIKE ?)`);
    valores.push(`%${q}%`, `%${q}%`, `%${q}%`);
  }
  if (localId) { condicoes.push(`local_id=?`); valores.push(localId); }
  const where = condicoes.length ? `WHERE ${condicoes.join(" AND ")}` : "";
  const rows = (await db.prepare(`SELECT * FROM produtos ${where} ORDER BY nome`).bind(...valores).all()).results || [];
  return json({ registros: rows, total: rows.length });
}

async function handleProdutosCreate(env, request) {
  const gate = await requirePermission(env, request, "produtos.create");
  if (gate.response) return gate.response;
  const db = getDB(env);
  let body = {};
  try { body = await readJson(request, 32768); } catch { return json({ error: "INVALID_JSON" }, 400); }
  const dados = normalizarProdutoBody(body);
  if (!dados.nome) return json({ error: "NOME_OBRIGATORIO" }, 400);
  if (!(await validarLocalId(db, dados.local_id))) return json({ error: "LOCAL_NAO_ENCONTRADO" }, 400);
  const id = String(body.id || "").trim().slice(0, 120) || `produto-${Date.now()}`;
  const existe = await db.prepare(`SELECT id FROM produtos WHERE id=?`).bind(id).first();
  if (existe) return json({ error: "PRODUTO_JA_CADASTRADO" }, 409);
  await db.prepare(`
    INSERT INTO produtos(id,nome,fabricante,modelo,categoria,serial,local_id,escopo,observacao,
      portas_json,imagem,imagem_alt,hotspots_json,layout_portas,updated_by)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).bind(id, dados.nome, dados.fabricante, dados.modelo, dados.categoria, dados.serial, dados.local_id,
    dados.escopo, dados.observacao, dados.portas_json, dados.imagem, dados.imagem_alt,
    dados.hotspots_json, dados.layout_portas, gate.user.id).run();
  const depois = await db.prepare(`SELECT * FROM produtos WHERE id=?`).bind(id).first();
  await audit(env, request, gate.user, "PRODUTO_CREATE", "produtos", id, null, depois);
  return json({ ok: true, produto: depois }, 201);
}

async function handleProdutosGet(env, request, id) {
  const gate = await requirePermission(env, request, "produtos.view");
  if (gate.response) return gate.response;
  const row = await getDB(env).prepare(`SELECT * FROM produtos WHERE id=?`).bind(id).first();
  if (!row) return json({ error: "PRODUTO_NAO_ENCONTRADO" }, 404);
  return json(row);
}

async function handleProdutosUpdate(env, request, id) {
  const gate = await requirePermission(env, request, "produtos.edit");
  if (gate.response) return gate.response;
  const db = getDB(env);
  const antes = await db.prepare(`SELECT * FROM produtos WHERE id=?`).bind(id).first();
  if (!antes) return json({ error: "PRODUTO_NAO_ENCONTRADO" }, 404);
  let body = {};
  try { body = await readJson(request, 32768); } catch { return json({ error: "INVALID_JSON" }, 400); }
  const dados = normalizarProdutoBody(body);
  if (!dados.nome) return json({ error: "NOME_OBRIGATORIO" }, 400);
  if (!(await validarLocalId(db, dados.local_id))) return json({ error: "LOCAL_NAO_ENCONTRADO" }, 400);
  await db.prepare(`
    UPDATE produtos SET nome=?,fabricante=?,modelo=?,categoria=?,serial=?,local_id=?,observacao=?,
      portas_json=?,imagem=?,imagem_alt=?,hotspots_json=?,layout_portas=?,updated_by=?,updated_at=CURRENT_TIMESTAMP
    WHERE id=?
  `).bind(dados.nome, dados.fabricante, dados.modelo, dados.categoria, dados.serial, dados.local_id,
    dados.observacao, dados.portas_json, dados.imagem, dados.imagem_alt, dados.hotspots_json,
    dados.layout_portas, gate.user.id, id).run();
  const depois = await db.prepare(`SELECT * FROM produtos WHERE id=?`).bind(id).first();
  await audit(env, request, gate.user, "PRODUTO_UPDATE", "produtos", id, antes, depois);
  return json({ ok: true, produto: depois });
}

async function handleProdutosDelete(env, request, id) {
  const gate = await requirePermission(env, request, "produtos.delete");
  if (gate.response) return gate.response;
  const db = getDB(env);
  const antes = await db.prepare(`SELECT * FROM produtos WHERE id=?`).bind(id).first();
  if (!antes) return json({ error: "PRODUTO_NAO_ENCONTRADO" }, 404);
  await db.batch([
    db.prepare(`DELETE FROM device_target_credentials WHERE target_id IN (SELECT id FROM device_connection_targets WHERE device_id=?)`).bind(id),
    db.prepare(`DELETE FROM device_target_provisioning WHERE target_id IN (SELECT id FROM device_connection_targets WHERE device_id=?)`).bind(id),
    db.prepare(`DELETE FROM device_connection_acl WHERE target_id IN (SELECT id FROM device_connection_targets WHERE device_id=?)`).bind(id),
    db.prepare(`DELETE FROM device_connection_targets WHERE device_id=?`).bind(id),
    db.prepare(`DELETE FROM device_credentials WHERE device_id=?`).bind(id),
    db.prepare(`DELETE FROM device_connections WHERE device_id=?`).bind(id),
    db.prepare(`DELETE FROM produtos WHERE id=?`).bind(id)
  ]);
  await audit(env, request, gate.user, "PRODUTO_DELETE", "produtos", id, antes, null);
  return json({ ok: true });
}

async function loadGponSnapshot(env) {
  const db = getDB(env);
  const meta = await db.prepare(`SELECT version,chunk_count FROM gpon_snapshot_state WHERE id=1`).first();
  if (!meta) return null;
  const rows = (await db.prepare(`
    SELECT data_text FROM gpon_snapshot_chunks WHERE version=? ORDER BY chunk_index
  `).bind(meta.version).all()).results || [];
  if (rows.length !== Number(meta.chunk_count)) throw new Error("GPON_SNAPSHOT_INCOMPLETE");
  const data = JSON.parse(rows.map(row => row.data_text).join(""));
  const compactStatus = await db.prepare(`SELECT data_json FROM gpon_status_snapshot WHERE id=1`).first();
  let statusRows = [];
  if (compactStatus?.data_json) {
    try { statusRows = JSON.parse(compactStatus.data_json); } catch {}
  } else statusRows = (await db.prepare(`
      SELECT client_id,status,state_detail,rx_power,tx_power FROM gpon_client_status
    `).all()).results || [];
  if (statusRows.length && Array.isArray(data.clients)) {
    const byId = new Map(statusRows.map(row => [String(row.client_id), row]));
    data.clients = data.clients.map(client => {
      const status = byId.get(String(client.id));
      return status ? { ...client, status: status.status, state_detail: status.state_detail,
        rx_power: status.rx_power, tx_power: status.tx_power } : client;
    });
    data.alerts = data.clients.filter(client => String(client.status).toLowerCase() !== "online").map(client => ({
      level: "warning", client_id: client.id, title: `${client.name} — ${client.state_detail || client.status}`,
      detail: `${client.olt_id || "OLT"} • ${client.onu_index || "ONU"}`
    }));
  }
  return data;
}

/* ---------------- histórico auditável do estado GPON ----------------

   Um ciclo de coleta chega a cada 10 s. Gravar o estado inteiro a cada ciclo
   encheria o banco com milhões de linhas idênticas por dia, então só as
   *transições* viram histórico: o cliente que mudou de estado, com o valor
   anterior ao lado do novo e a origem que observou a mudança. Cada ciclo — com
   transição ou sem — vira uma linha em gpon_sync_runs, que é o que prova que a
   coleta estava viva às 03h14 mesmo sem nada ter acontecido. */

/* Teto de transições gravadas por ciclo. Uma PON inteira caindo produz
   milhares de mudanças de uma vez; sem teto, um ciclo de 10 s tentaria escrever
   dezenas de milhares de linhas e estouraria o tempo da ingestão. O total
   observado fica no run, então o corte aparece na auditoria em vez de sumir. */
const GPON_HISTORY_MAX_PER_RUN = 4000;
const GPON_HISTORY_BATCH = 25;

/* O RX oscila décimos de dBm o tempo todo. Registrar cada respiro afogaria as
   quedas reais em ruído; 2 dB é a menor variação que muda a leitura operacional
   de um enlace. */
const GPON_RX_DELTA_DB = 2;

const GPON_HISTORY_RETENTION_DAYS = 90;
const GPON_RUNS_RETENTION_DAYS = 30;

const textoGpon = (valor, max = 160) => String(valor ?? "").slice(0, max);

/* CURRENT_TIMESTAMP do SQLite grava "AAAA-MM-DD HH:MM:SS" em UTC. Comparar
   isso com um ISO ("...T...Z") ordena errado — o espaço vem antes do "T" —, e
   filtro e poda erravam por até um dia. */
const carimboSqlGpon = (data) => data.toISOString().replace("T", " ").slice(0, 19);
const normalStatusGpon = (valor) => textoGpon(valor || "unknown", 40).toLowerCase();
const onlineGpon = (valor) => normalStatusGpon(valor) === "online";

/* Compara o estado conhecido com o que acabou de chegar. Devolve null quando
   nada digno de registro mudou — o caso comum, e o que mantém o histórico
   legível. */
export function transicaoGpon(anterior, atual) {
  const statusAntes = anterior ? normalStatusGpon(anterior.status) : null;
  const statusDepois = normalStatusGpon(atual.status);
  const detalheAntes = anterior ? textoGpon(anterior.state_detail) : null;
  const detalheDepois = textoGpon(atual.state_detail);
  const rxAntes = anterior ? numeroGpon(anterior.rx_power) : null;
  const rxDepois = numeroGpon(atual.rx_power);

  if (!anterior) return { event: "baseline", statusAntes: null, detalheAntes: null, rxAntes: null, statusDepois, detalheDepois };
  if (statusAntes !== statusDepois) return { event: "status", statusAntes, detalheAntes, rxAntes, statusDepois, detalheDepois };
  if (detalheAntes !== detalheDepois) return { event: "status", statusAntes, detalheAntes, rxAntes, statusDepois, detalheDepois };
  if (rxAntes !== null && rxDepois !== null && Math.abs(rxDepois - rxAntes) >= GPON_RX_DELTA_DB)
    return { event: "signal", statusAntes, detalheAntes, rxAntes, statusDepois, detalheDepois };
  return null;
}

/* Grava as transições em lotes pequenos: o D1 aceita um batch grande, mas um
   lote enorme dentro de uma requisição de 10 s é o que estoura primeiro. */
async function gravarHistoricoGpon(db, runId, origem, syncedAt, transicoes) {
  const recortadas = transicoes.slice(0, GPON_HISTORY_MAX_PER_RUN);
  for (let i = 0; i < recortadas.length; i += GPON_HISTORY_BATCH) {
    await db.batch(recortadas.slice(i, i + GPON_HISTORY_BATCH).map(t => db.prepare(`
      INSERT INTO gpon_status_history
        (client_id,run_id,origin,event,status_before,status_after,detail_before,detail_after,
         rx_power_before,rx_power,tx_power,olt_id,onu_index,serial,client_name,synced_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).bind(t.client_id, runId, origem, t.event, t.status_before, t.status_after,
      t.detail_before, t.detail_after, t.rx_power_before, t.rx_power, t.tx_power,
      t.olt_id, t.onu_index, t.serial, t.client_name, syncedAt)));
  }
  return recortadas.length;
}

async function registrarCicloGpon(db, dados) {
  await db.prepare(`
    INSERT INTO gpon_sync_runs
      (id,kind,origin,source,synced_at,clients_count,boxes_count,alerts_count,changes_count,
       transitions_count,online_count,offline_count,data_bytes,lag_ms,ip,error)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).bind(dados.id, dados.kind, dados.origin, dados.source, dados.synced_at,
    dados.clients_count | 0, dados.boxes_count | 0, dados.alerts_count | 0, dados.changes_count | 0,
    dados.transitions_count | 0, dados.online_count | 0, dados.offline_count | 0,
    dados.data_bytes | 0, dados.lag_ms, textoGpon(dados.ip, 60), textoGpon(dados.error, 300)).run();
}

/* A defasagem entre o instante da coleta e o da gravação é o número que diz se
   a promessa de 10 s está sendo cumprida de ponta a ponta. */
function atrasoGpon(syncedAt) {
  const instante = Date.parse(String(syncedAt || ""));
  if (!Number.isFinite(instante)) return null;
  const atraso = Date.now() - instante;
  return atraso >= 0 && atraso < 24 * 60 * 60 * 1000 ? atraso : null;
}

function lerStatusCompactoGpon(linha) {
  if (!linha?.data_json) return [];
  try {
    const lido = JSON.parse(linha.data_json);
    return Array.isArray(lido) ? lido : [];
  } catch { return []; }
}

async function handleGponIngest(env, request) {
  const expected = String(env.GPON_SYNC_TOKEN || "");
  const authorization = String(request.headers.get("Authorization") || "");
  if (!expected || !(await timingSafeEqual(authorization, `Bearer ${expected}`))) return json({ error: "UNAUTHORIZED" }, 401);

  let data;
  try { data = await readJson(request, 16 * 1024 * 1024); }
  catch (error) { return json({ error: error?.message === "BODY_TOO_LARGE" ? "BODY_TOO_LARGE" : "INVALID_JSON" }, 400); }
  const clients = Array.isArray(data?.clients) ? data.clients : null;
  const boxes = Array.isArray(data?.boxes) ? data.boxes : null;
  const alerts = Array.isArray(data?.alerts) ? data.alerts : null;
  if (!clients || !boxes || !alerts || clients.length > 30000 || boxes.length > 10000 || alerts.length > 30000)
    return json({ error: "INVALID_GPON_SNAPSHOT" }, 400);

  const source = String(data.source || "Coletor ZTE + IXC Provedor").slice(0, 120);
  const syncedAt = String(data.synced_at || new Date().toISOString()).slice(0, 40);
  const origem = textoGpon(data.origin || "ont+ixc", 30);
  const serialized = JSON.stringify({ source, synced_at: syncedAt, clients, boxes, alerts });
  const bytes = new TextEncoder().encode(serialized).byteLength;
  const version = bytesToBase64Url(randomBytes(18));
  const runId = bytesToBase64Url(randomBytes(12));
  const chunkSize = 128 * 1024;
  const chunks = [];
  for (let offset = 0; offset < serialized.length; offset += chunkSize) chunks.push(serialized.slice(offset, offset + chunkSize));
  const db = getDB(env);
  for (let index = 0; index < chunks.length; index += 8) {
    await db.batch(chunks.slice(index, index + 8).map((chunk, position) => db.prepare(`
      INSERT INTO gpon_snapshot_chunks(version,chunk_index,data_text) VALUES (?,?,?)
    `).bind(version, index + position, chunk)));
  }

  /* A leitura compacta anterior é o último estado conhecido de cada cliente.
     Ela precisa ser lida antes de ser substituída: é contra ela que a
     fotografia nova vira histórico. */
  const anteriores = new Map(lerStatusCompactoGpon(
    await db.prepare(`SELECT data_json FROM gpon_status_snapshot WHERE id=1`).first()
  ).map(linha => [String(linha.client_id), linha]));
  const primeiraCarga = anteriores.size === 0;

  const compacto = [], transicoes = [];
  let online = 0;
  for (const cliente of clients) {
    const id = textoGpon(cliente?.id);
    if (!id) continue;
    const linha = {
      client_id: id, status: normalStatusGpon(cliente?.status), state_detail: textoGpon(cliente?.state_detail),
      rx_power: numeroGpon(cliente?.rx_power), tx_power: numeroGpon(cliente?.tx_power),
      ...conexaoGpon(cliente)
    };
    compacto.push(linha);
    if (onlineGpon(linha.status)) online += 1;
    const mudanca = transicaoGpon(anteriores.get(id), linha);
    /* Na primeira fotografia o parque inteiro seria "novo". Registrar 30 mil
       linhas de nascimento não conta nenhuma história — a linha do tempo
       começa na primeira mudança de verdade. */
    if (!mudanca || (primeiraCarga && mudanca.event === "baseline")) continue;
    transicoes.push({
      client_id: id, event: mudanca.event, status_before: mudanca.statusAntes, status_after: mudanca.statusDepois,
      detail_before: mudanca.detalheAntes, detail_after: mudanca.detalheDepois,
      rx_power_before: mudanca.rxAntes, rx_power: linha.rx_power, tx_power: linha.tx_power,
      olt_id: textoGpon(cliente?.olt_id, 60), onu_index: textoGpon(cliente?.onu_index, 60),
      serial: textoGpon(cliente?.serial, 60), client_name: textoGpon(cliente?.name, 120)
    });
  }

  await db.prepare(`
    INSERT INTO gpon_snapshot_state(id,version,source,synced_at,chunk_count,data_bytes,clients_count,boxes_count,alerts_count,updated_at)
    VALUES (1,?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP)
    ON CONFLICT(id) DO UPDATE SET version=excluded.version,source=excluded.source,synced_at=excluded.synced_at,
      chunk_count=excluded.chunk_count,data_bytes=excluded.data_bytes,clients_count=excluded.clients_count,
      boxes_count=excluded.boxes_count,alerts_count=excluded.alerts_count,updated_at=CURRENT_TIMESTAMP
  `).bind(version, source, syncedAt, chunks.length, bytes, clients.length, boxes.length, alerts.length).run();
  await db.prepare(`DELETE FROM gpon_snapshot_chunks WHERE version<>?`).bind(version).run();
  await db.prepare(`DELETE FROM gpon_client_status`).run();

  /* A leitura compacta passa a cobrir o parque inteiro, e não só quem mudou
     desde a última fotografia. É o que permite servir o estado atual — e
     comparar o próximo delta — sem reabrir os pedaços do snapshot. */
  await db.prepare(`
    INSERT INTO gpon_status_snapshot(id,data_json,synced_at,updated_at) VALUES (1,?,?,CURRENT_TIMESTAMP)
    ON CONFLICT(id) DO UPDATE SET data_json=excluded.data_json,synced_at=excluded.synced_at,updated_at=CURRENT_TIMESTAMP
  `).bind(JSON.stringify(compacto), syncedAt).run();

  const gravadas = await gravarHistoricoGpon(db, runId, origem, syncedAt, transicoes);
  /* A coleta completa é o momento em que a base de clientes do IXC chega
     inteira; é dela que o cadastro da plataforma nasce. Uma falha aqui não
     invalida a fotografia já gravada — o snapshot é o que a operação precisa
     agora, e a importação tenta de novo no ciclo seguinte. */
  let cadastros = { criados: 0, pendentes: 0, atualizados: 0 };
  try { cadastros = await importarCadastroGpon(db, clients); }
  catch (error) {
    console.error(JSON.stringify({ message: "Falha ao importar cadastro de clientes GPON", error: error?.message || String(error) }));
  }
  await registrarCicloGpon(db, {
    id: runId, kind: "snapshot", origin: origem, source, synced_at: syncedAt,
    clients_count: clients.length, boxes_count: boxes.length, alerts_count: alerts.length,
    changes_count: clients.length, transitions_count: transicoes.length,
    online_count: online, offline_count: compacto.length - online, data_bytes: bytes,
    lag_ms: atrasoGpon(syncedAt), ip: getClientIP(request),
    error: transicoes.length > gravadas ? `histórico truncado: ${gravadas} de ${transicoes.length}` : ""
  });

  return json({ ok: true, run_id: runId, clients: clients.length, boxes: boxes.length,
    alerts: alerts.length, transitions: transicoes.length, transitions_stored: gravadas,
    cadastros_criados: cadastros.criados, cadastros_pendentes: cadastros.pendentes,
    cadastros_atualizados: cadastros.atualizados });
}

async function handleGponStatusIngest(env, request) {
  const expected = String(env.GPON_SYNC_TOKEN || "");
  const authorization = String(request.headers.get("Authorization") || "");
  if (!expected || !(await timingSafeEqual(authorization, `Bearer ${expected}`))) return json({ error: "UNAUTHORIZED" }, 401);
  let data;
  /* Cada linha do delta cresceu com IP, velocidade, consumo e início da sessão.
     Num ciclo em que meio parque reconecta, 4 MiB apertava; 8 MiB mantém a
     folga sem chegar perto do teto da fotografia completa. */
  try { data = await readJson(request, 8 * 1024 * 1024); }
  catch (error) { return json({ error: error?.message === "BODY_TOO_LARGE" ? "BODY_TOO_LARGE" : "INVALID_JSON" }, 400); }
  if (!Array.isArray(data?.changes) || data.changes.length > 30000) return json({ error: "INVALID_GPON_STATUS" }, 400);
  const rows = data.changes.map(change => ({
    id: textoGpon(change?.id), status: normalStatusGpon(change?.status),
    detail: textoGpon(change?.state_detail),
    rx: numeroGpon(change?.rx_power), tx: numeroGpon(change?.tx_power),
    olt_id: textoGpon(change?.olt_id, 60), onu_index: textoGpon(change?.onu_index, 60),
    serial: textoGpon(change?.serial, 60), name: textoGpon(change?.name, 120),
    conexao: conexaoGpon(change)
  })).filter(row => row.id);
  const db = getDB(env), syncedAt = String(data.synced_at || new Date().toISOString()).slice(0, 40);
  const origem = textoGpon(data.origin || "ont+ixc", 30);
  const runId = bytesToBase64Url(randomBytes(12));
  const current = await db.prepare(`SELECT data_json FROM gpon_status_snapshot WHERE id=1`).first();
  const byId = new Map(lerStatusCompactoGpon(current).map(row => [String(row.client_id), row]));

  /* O delta é comparado com o estado guardado antes de sobrescrevê-lo: é essa
     comparação — e não o fato de o coletor ter enviado a linha — que define o
     que virou transição. O coletor pode reenviar o mesmo valor sem que nada
     tenha acontecido de fato na rede. */
  const transicoes = [];
  /* Tráfego e conexão mudam sem que o estado mude — o cliente reconecta com
     outro IP, o plano é reajustado, o consumo avança. Isso não é transição
     (o histórico ficaria ilegível), mas é dado novo para servir: sem contar
     estas mudanças à parte, o `synced_at` não andaria e a tela nunca voltaria
     para buscá-las. */
  let conexoesMudadas = 0;
  for (const row of rows) {
    const anterior = byId.get(row.id);
    const atual = { client_id: row.id, status: row.status, state_detail: row.detail, rx_power: row.rx, tx_power: row.tx, ...row.conexao };
    if (!anterior || CONEXAO_GPON.some(campo => anterior[campo] !== atual[campo])) conexoesMudadas += 1;
    const mudanca = transicaoGpon(anterior, atual);
    byId.set(row.id, atual);
    if (!mudanca) continue;
    transicoes.push({
      client_id: row.id, event: mudanca.event, status_before: mudanca.statusAntes, status_after: mudanca.statusDepois,
      detail_before: mudanca.detalheAntes, detail_after: mudanca.detalheDepois,
      rx_power_before: mudanca.rxAntes, rx_power: row.rx, tx_power: row.tx,
      olt_id: row.olt_id, onu_index: row.onu_index, serial: row.serial, client_name: row.name
    });
  }

  const compacto = [...byId.values()];
  const online = compacto.filter(linha => onlineGpon(linha.status)).length;

  /* Sem transição nem conexão nova, o estado servido não mudou: mexer em
     synced_at faria cada tela reabrir a leitura a cada 10 s sem um único dado
     novo. updated_at avança sempre — é o batimento que prova que a coleta está
     viva mesmo numa madrugada em que nada oscilou. */
  if (transicoes.length || conexoesMudadas) await db.batch([
    db.prepare(`
      INSERT INTO gpon_status_snapshot(id,data_json,synced_at,updated_at) VALUES (1,?,?,CURRENT_TIMESTAMP)
      ON CONFLICT(id) DO UPDATE SET data_json=excluded.data_json,synced_at=excluded.synced_at,updated_at=CURRENT_TIMESTAMP
    `).bind(JSON.stringify(compacto), syncedAt),
    db.prepare(`UPDATE gpon_snapshot_state SET synced_at=?,updated_at=CURRENT_TIMESTAMP WHERE id=1`).bind(syncedAt)
  ]);
  else await db.prepare(`UPDATE gpon_snapshot_state SET updated_at=CURRENT_TIMESTAMP WHERE id=1`).run();

  const gravadas = await gravarHistoricoGpon(db, runId, origem, syncedAt, transicoes);
  await registrarCicloGpon(db, {
    id: runId, kind: "status", origin: origem, source: textoGpon(data.source || "", 120), synced_at: syncedAt,
    clients_count: compacto.length, changes_count: rows.length, transitions_count: transicoes.length,
    online_count: online, offline_count: compacto.length - online, lag_ms: atrasoGpon(syncedAt),
    ip: getClientIP(request),
    error: transicoes.length > gravadas ? `histórico truncado: ${gravadas} de ${transicoes.length}` : ""
  });

  return json({ ok: true, run_id: runId, changes: rows.length,
    transitions: transicoes.length, transitions_stored: gravadas });
}

async function handleGponRevision(env, request) {
  const gate = await requirePermission(env, request, "topology.view");
  if (gate.response) return gate.response;
  const row = await getDB(env).prepare(`SELECT version,synced_at,updated_at FROM gpon_snapshot_state WHERE id=1`).first();
  return json(row || { version: null, synced_at: null, updated_at: null });
}

/* Estado atual sem o cadastro junto. A tela recarrega o snapshot completo —
   nomes, endereços, coordenadas, caixas — só quando a versão muda; a cada 10 s
   ela quer apenas saber quem mudou de estado, e isso é uma ordem de grandeza
   menos dado no fio. */
async function handleGponStatusRead(env, request) {
  const gate = await requirePermission(env, request, "topology.view");
  if (gate.response) return gate.response;
  const db = getDB(env);
  const estado = await db.prepare(`SELECT version,synced_at,updated_at FROM gpon_snapshot_state WHERE id=1`).first();
  if (!estado) return json({ version: null, synced_at: null, updated_at: null, clients: [] });
  const compacto = await db.prepare(`SELECT data_json,synced_at FROM gpon_status_snapshot WHERE id=1`).first();
  const linhas = lerStatusCompactoGpon(compacto);
  return json({
    version: estado.version, synced_at: compacto?.synced_at || estado.synced_at,
    updated_at: estado.updated_at,
    clients: linhas.map(linha => ({
      id: linha.client_id, status: linha.status, state_detail: linha.state_detail,
      rx_power: linha.rx_power ?? null, tx_power: linha.tx_power ?? null,
      ...conexaoGpon(linha)
    }))
  });
}

/* Linha do tempo de uma ONU — ou as últimas transições do parque inteiro
   quando nenhum cliente é informado. É a resposta para "quando caiu", "quantas
   vezes oscilou hoje" e "que fonte observou a mudança". */
async function handleGponHistory(env, request, url) {
  const gate = await requirePermission(env, request, "topology.view");
  if (gate.response) return gate.response;
  const clientId = textoGpon(url.searchParams.get("client_id") || "");
  const limite = Math.min(Math.max(Number(url.searchParams.get("limit")) || 50, 1), 500);
  const desdeBruto = textoGpon(url.searchParams.get("since") || "", 40);
  const desdeData = desdeBruto ? new Date(desdeBruto) : null;
  const desde = desdeData && !Number.isNaN(desdeData.getTime()) ? carimboSqlGpon(desdeData) : "";
  const evento = textoGpon(url.searchParams.get("event") || "", 20);

  const condicoes = [], valores = [];
  if (clientId) { condicoes.push("client_id=?"); valores.push(clientId); }
  if (desde) { condicoes.push("created_at>=?"); valores.push(desde); }
  if (evento) { condicoes.push("event=?"); valores.push(evento); }
  const onde = condicoes.length ? `WHERE ${condicoes.join(" AND ")}` : "";

  const { results } = await getDB(env).prepare(`
    SELECT id,client_id,run_id,origin,event,status_before,status_after,detail_before,detail_after,
           rx_power_before,rx_power,tx_power,olt_id,onu_index,serial,client_name,synced_at,created_at
    FROM gpon_status_history ${onde}
    ORDER BY id DESC LIMIT ?
  `).bind(...valores, limite).all();

  return json({ client_id: clientId || null, limit: limite, events: results || [] });
}

/* ---- log de autenticação RADIUS ----

   O estado combinado (ONU + Radius) continua em gpon_status_history; esta
   tabela isola as transições de autenticação PPPoE para que o NOC monitore a
   saúde do servidor RADIUS e o HelpDesk consulte por que um cliente está sem
   serviço. O coletor envia eventos via POST /api/radius/ingest; a tela
   consulta via GET /api/radius/logs com os mesmos filtros do histórico GPON. */
async function handleRadiusIngest(env, request) {
  const expected = String(env.GPON_SYNC_TOKEN || "");
  const authorization = String(request.headers.get("Authorization") || "");
  if (!expected || !(await timingSafeEqual(authorization, `Bearer ${expected}`))) return json({ error: "UNAUTHORIZED" }, 401);

  let data;
  try { data = await readJson(request, 4 * 1024 * 1024); }
  catch (error) { return json({ error: error?.message === "BODY_TOO_LARGE" ? "BODY_TOO_LARGE" : "INVALID_JSON" }, 400); }
  if (!Array.isArray(data?.events) || data.events.length > 10000) return json({ error: "INVALID_RADIUS_LOG" }, 400);

  const syncedAt = String(data.synced_at || new Date().toISOString()).slice(0, 40);
  const origin = textoGpon(data.origin || "collector", 30);
  const db = getDB(env);
  const runId = bytesToBase64Url(randomBytes(12));
  const rows = data.events.map((event) => ({
    client_id: textoGpon(event?.client_id, 120),
    ixc_login_id: textoGpon(event?.ixc_login_id || "", 60),
    username: textoGpon(event?.username, 200),
    status_before: textoGpon(event?.status_before, 40),
    status_after: textoGpon(event?.status_after || "offline", 40),
    detail: textoGpon(event?.detail || "", 400),
    olt_id: textoGpon(event?.olt_id || "", 60),
    onu_index: textoGpon(event?.onu_index || "", 60),
    serial: textoGpon(event?.serial || "", 60),
    client_name: textoGpon(event?.client_name || "", 200),
    synced_at: syncedAt,
    origin
  })).filter((row) => row.client_id && row.status_after);

  const batchSize = 100;
  for (let i = 0; i < rows.length; i += batchSize) {
    const lote = rows.slice(i, i + batchSize);
    await db.batch(lote.map((row) => db.prepare(`
      INSERT INTO radius_logs
        (client_id,ixc_login_id,username,status_before,status_after,detail,
         olt_id,onu_index,serial,client_name,synced_at,origin)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
    `).bind(row.client_id, row.ixc_login_id || null, row.username,
      row.status_before || null, row.status_after, row.detail,
      row.olt_id, row.onu_index, row.serial, row.client_name, row.synced_at, row.origin)));
  }

  await audit(env, request, null, "RADIUS_LOG_INGEST", "radius", runId, null,
    { origin, event_count: rows.length, synced_at: syncedAt }, { source: "collector" });

  return json({ ok: true, run_id: runId, events: rows.length });
}

/* Linha do tempo de autenticação RADIUS: transições de online/offline do
   PPPoE, filtráveis por cliente, usuário ou período. Acessível por quem tem
   radius.view — NOC e HelpDesk. */
async function handleRadiusLogs(env, request, url) {
  const gate = await requirePermission(env, request, "radius.view");
  if (gate.response) return gate.response;

  const db = getDB(env);
  const clientId = textoGpon(url.searchParams.get("client_id") || "", 120);
  const username = textoGpon(url.searchParams.get("username") || "", 200);
  const limite = Math.min(Math.max(Number(url.searchParams.get("limit")) || 100, 1), 500);
  const desdeBruto = textoGpon(url.searchParams.get("since") || "", 40);
  const desdeData = desdeBruto ? new Date(desdeBruto) : null;
  const desde = desdeData && !Number.isNaN(desdeData.getTime()) ? carimboSqlGpon(desdeData) : "";
  const status = textoGpon(url.searchParams.get("status") || "", 20);
  /* Cursor de paginação: a tela pede o log inteiro (sem prazo de retenção,
     ao contrário do histórico GPON) em lotes de até 500, cada um pedindo o
     que vem antes do menor id já recebido. Sem isso, "completo" parava no
     teto de uma página só. */
  const beforeId = Number(url.searchParams.get("before_id"));

  const condicoes = [], valores = [];
  if (clientId) { condicoes.push("client_id=?"); valores.push(clientId); }
  if (username) { condicoes.push("username=?"); valores.push(username); }
  if (desde) { condicoes.push("created_at>=?"); valores.push(desde); }
  if (status) { condicoes.push("status_after=?"); valores.push(status.toLowerCase()); }
  if (Number.isFinite(beforeId) && beforeId > 0) { condicoes.push("id<?"); valores.push(beforeId); }
  const onde = condicoes.length ? `WHERE ${condicoes.join(" AND ")}` : "";

  const { results } = await db.prepare(`
    SELECT id,client_id,ixc_login_id,username,status_before,status_after,detail,
           olt_id,onu_index,serial,client_name,synced_at,origin,created_at
    FROM radius_logs ${onde}
    ORDER BY id DESC LIMIT ?
  `).bind(...valores, limite).all();

  return json({ client_id: clientId || null, username: username || null, limit: limite, events: results || [] });
}

/* Auditoria da coleta: cada ciclo recebido, com origem, contagem e defasagem.
   Um buraco nesta lista é a prova de que a coleta parou — o histórico de
   transições, sozinho, não distingue "nada mudou" de "ninguém olhou". */
async function handleGponSyncRuns(env, request, url) {
  const gate = await requirePermission(env, request, "audit.view");
  if (gate.response) return gate.response;
  const limite = Math.min(Math.max(Number(url.searchParams.get("limit")) || 60, 1), 300);
  const tipo = textoGpon(url.searchParams.get("kind") || "", 20);
  const onde = tipo ? "WHERE kind=?" : "";
  const valores = tipo ? [tipo] : [];
  const { results } = await getDB(env).prepare(`
    SELECT id,kind,origin,source,synced_at,received_at,clients_count,boxes_count,alerts_count,
           changes_count,transitions_count,online_count,offline_count,data_bytes,lag_ms,ip,error
    FROM gpon_sync_runs ${onde}
    ORDER BY received_at DESC, rowid DESC LIMIT ?
  `).bind(...valores, limite).all();
  return json({ limit: limite, runs: results || [] });
}

/* O histórico é append-only e nasce de um ciclo de 10 s: sem poda ele cresce
   para sempre. A retenção é longa o bastante para uma apuração de SLA e curta
   o bastante para o banco não virar um problema. */
async function podarHistoricoGpon(env) {
  const db = getDB(env);
  const corte = (dias) => carimboSqlGpon(new Date(Date.now() - dias * 24 * 60 * 60 * 1000));
  const historico = await db.prepare(`DELETE FROM gpon_status_history WHERE created_at<?`)
    .bind(corte(Number(env.GPON_HISTORY_RETENTION_DAYS) || GPON_HISTORY_RETENTION_DAYS)).run();
  const ciclos = await db.prepare(`DELETE FROM gpon_sync_runs WHERE received_at<?`)
    .bind(corte(Number(env.GPON_RUNS_RETENTION_DAYS) || GPON_RUNS_RETENTION_DAYS)).run();
  return { historico: historico?.meta?.changes ?? null, ciclos: ciclos?.meta?.changes ?? null };
}

async function handleGponCollectorStatus(env, request) {
  const expected = String(env.GPON_SYNC_TOKEN || "");
  const authorization = String(request.headers.get("Authorization") || "");
  if (!expected || !(await timingSafeEqual(authorization, `Bearer ${expected}`))) return json({ error: "UNAUTHORIZED" }, 401);
  const row = await getDB(env).prepare(`
    SELECT source,synced_at,data_bytes,clients_count,boxes_count,alerts_count,updated_at
    FROM gpon_snapshot_state WHERE id=1
  `).first();
  return json(row || { source: null, synced_at: null, clients_count: 0, boxes_count: 0, alerts_count: 0 });
}

async function handleTopologyPermissions(env,request){
  const user=await getCurrentUser(env,request);
  if(!user)return json({error:"AUTH_REQUIRED"},401);
  const permissions=(await getDB(env).prepare(`
    SELECT p.code FROM role_permissions rp JOIN permissions p ON p.id=rp.permission_id WHERE rp.role_id=?
  `).bind(user.role_id).all()).results.map(x=>x.code);
  return json({permissions});
}

const PUBLIC_ASSET_PATHS = new Set([
  "/login",
  "/login.html",
  "/js/noc-ui.js",
  "/favicon.ico",
  "/assets/brand/updown-internet.png",
  "/assets/brand/updown-internet-alpha.png",
  "/assets/brand/updown-internet-alpha-dark.png",
  "/assets/brand/updown-logo.png",
  "/assets/brand/updown-symbol.png",
  "/assets/brand/updown-logo-dark.png",
  "/assets/brand/updown-symbol-dark.png"
]);

function isPublicAsset(pathname) {
  return PUBLIC_ASSET_PATHS.has(pathname) || pathname.startsWith("/css/noc/");
}

/* Código e imagem são iguais para todo usuário: o que restringe o acesso é a
   sessão exigida antes de servi-los, não o conteúdo. Com `no-store` o navegador
   rebaixava todo o JS e CSS — centenas de KB — a cada navegação entre telas.
   `private` mantém o arquivo apenas no navegador do usuário, nunca em cache
   compartilhado, e a janela curta somada ao ETag do binding ASSETS faz a
   revalidação seguinte custar um 304.
   HTML e JSON continuam fora do cache: carregam dados e estado da sessão. */
const CACHEABLE_ASSET = /\.(?:js|mjs|css|map|png|jpe?g|gif|svg|webp|avif|ico|woff2?|ttf|otf)$/i;

function assetCacheControl(pathname) {
  return CACHEABLE_ASSET.test(pathname) ? "private, max-age=300, must-revalidate" : "private, no-store";
}

/* Rotas equivalentes de uma mesma tela. O servidor de assets também entrega
   /isp-mapa.html como /isp-mapa, e o catálogo guarda só uma das formas: sem
   considerar as duas, a liberação por perfil deixaria de ser aplicada na URL
   sem extensão. */
function routeCandidates(pathname) {
  if (pathname === "/" || pathname === "/index.html") return ["/", "/index.html"];
  if (pathname.endsWith(".html")) return [pathname, pathname.slice(0, -5)];
  return [pathname, `${pathname}.html`];
}

async function serveAsset(request, env) {
  if (!env.ASSETS) return new Response("Assets binding ASSETS não encontrado.", {status:500});
  const url = new URL(request.url);
  const publicAsset = isPublicAsset(url.pathname);
  let user = null;

  if (!publicAsset) {
    await ensureDatabase(env);
    user = await getCurrentUser(env, request);
    if (!user) {
      const acceptsHtml = request.headers.get("Accept")?.includes("text/html")
        || url.pathname === "/" || url.pathname.endsWith(".html");
      if (acceptsHtml && (request.method === "GET" || request.method === "HEAD")) {
        const login = new URL("/login.html", url.origin);
        login.searchParams.set("return_to", safeReturnPath(`${url.pathname}${url.search}`));
        return new Response(null, {status:303, headers:securityHeaders({Location:login.toString(),"Cache-Control":"no-store"})});
      }
      return json({error:"AUTH_REQUIRED"},401);
    }

    /* É pedido de página quando não há extensão de arquivo: "/", "/x.html" e a
       forma sem extensão que o servidor de assets também entrega. Um .css ou
       .png não é tela e não custa uma consulta. */
    const ehPagina = url.pathname === "/" || url.pathname.endsWith(".html")
      || !/\.[a-z0-9]+$/i.test(url.pathname);
    if (ehPagina) {
      const [rota, alternativa] = routeCandidates(url.pathname);
      // Tela e liberação do perfil na mesma consulta: eram duas idas ao D1 em
      // toda abertura de página.
      const screen = await getDB(env).prepare(`
        SELECT s.active,
               EXISTS(SELECT 1 FROM role_screens rs WHERE rs.role_id=? AND rs.screen_id=s.id) AS allowed
        FROM screens s WHERE s.route IN (?,?) LIMIT 1
      `).bind(user.role_id, rota, alternativa).first();
      if (screen && (!screen.active || !screen.allowed)) {
        return new Response("Acesso negado.", {status:403,headers:securityHeaders({"Cache-Control":"no-store"})});
      }
    }
  }

  const asset = await env.ASSETS.fetch(request);
  const headers = securityHeaders(asset.headers);
  if (!publicAsset) {
    headers.set("Cache-Control", assetCacheControl(url.pathname));
    headers.append("Vary", "Cookie");
  }
  return new Response(asset.body, {status:asset.status,headers});
}

export default {
  async fetch(request, env, ctx) {
    try {
      const url = new URL(request.url);

      if (url.pathname === "/api/health" && request.method === "GET") {
        await ensureDatabase(env);
        return handleHealth(env);
      }

      if (url.pathname.startsWith("/api/")) {
        // Preflight do navegador pra POST/PUT/PATCH/DELETE com Authorization
        // ou Content-Type custom (o app/webchat pode rodar numa origem
        // diferente da API). Responde antes de tocar no banco.
        if (request.method === "OPTIONS") return corsPreflight();

        await ensureDatabase(env);

        // Webhook da Meta chega cross-site e sem sessão: precisa entrar antes
        // do controle de CSRF, que bloqueia requisições cross-site com cookie.
        if (url.pathname === "/api/whatsapp/webhook" && request.method === "GET")
          return await handleWhatsappWebhookVerify(env, url);
        if (url.pathname === "/api/whatsapp/webhook" && request.method === "POST")
          return await handleWhatsappWebhook(env, request);

        // Mesmo motivo acima: o webhook do Opa!Suite (canais Meta e Webchat)
        // também chega cross-site, sem cookie de sessão.
        if (url.pathname === "/api/opasuite/webhook" && request.method === "POST")
          return await handleOpasuiteWebhook(env, request);

        const csrf = csrfFailure(request);
        if (csrf) return csrf;

        if (url.pathname === "/api/auth/config" && request.method === "GET") {
          return json({
            oauthEnabled: oauthEnabled(env),
            oauthButtonLabel: oauthEnabled(env) ? oauthConfig(env).buttonLabel : null,
            passwordLoginEnabled: env.PASSWORD_LOGIN_ENABLED !== "false"
          });
        }

        if (url.pathname === "/api/auth/oauth/start" && request.method === "GET")
          return await handleOAuthStart(env, request);

        if (url.pathname === "/api/auth/oauth/callback" && request.method === "GET")
          return await handleOAuthCallback(env, request);

        if (url.pathname === "/api/agenda" && request.method === "GET")
          return await handleAgendaBootstrap(env, request);

        if (url.pathname === "/api/agenda/import-ics" && request.method === "POST")
          return await handleAgendaIcsImport(env, request);

        if (url.pathname === "/api/agenda/events" && request.method === "POST")
          return await handleAgendaEventCreate(env, request);

        const agendaEventMatch=url.pathname.match(/^\/api\/agenda\/events\/(\d+)$/);
        if(agendaEventMatch){
          const id=Number(agendaEventMatch[1]);
          if(request.method==="PATCH")return await handleAgendaEventUpdate(env,request,id);
          if(request.method==="DELETE")return await handleAgendaEventDelete(env,request,id);
        }

        if (url.pathname === "/api/crm" && request.method === "GET")
          return await handleCrm(env,request);

        if (url.pathname === "/api/crm/cases" && request.method === "POST")
          return await handleCrmCaseCreate(env,request);

        const crmActivityMatch=url.pathname.match(/^\/api\/crm\/cases\/(\d+)\/activities$/);
        if(crmActivityMatch && request.method==="POST")
          return await handleCrmActivityCreate(env,request,Number(crmActivityMatch[1]));

        const crmCaseMatch=url.pathname.match(/^\/api\/crm\/cases\/(\d+)$/);
        if(crmCaseMatch){
          const id=Number(crmCaseMatch[1]);
          if(request.method==="GET")return await handleCrmCaseGet(env,request,id);
          if(request.method==="PATCH")return await handleCrmCaseUpdate(env,request,id);
          if(request.method==="DELETE")return await handleCrmCaseDelete(env,request,id);
        }

        if (url.pathname === "/api/whatsapp" && request.method === "GET")
          return await handleWhatsapp(env,request);
        if (url.pathname === "/api/whatsapp/conversations" && request.method === "POST")
          return await handleWhatsappCreate(env,request);
        if (url.pathname === "/api/whatsapp/presence" && request.method === "POST")
          return await handleWhatsappPresence(env,request);
        if (url.pathname === "/api/whatsapp/settings" && (request.method === "GET" || request.method === "PUT"))
          return await handleWhatsappSettings(env,request);
        if (url.pathname === "/api/whatsapp/webhook-log" && request.method === "GET")
          return await handleWaWebhookLog(env,request);
        const waMessageMatch=url.pathname.match(/^\/api\/whatsapp\/conversations\/(\d+)\/messages$/);
        if(waMessageMatch && request.method==="POST")
          return await handleWhatsappSend(env,request,Number(waMessageMatch[1]));
        const waConvActionMatch=url.pathname.match(/^\/api\/whatsapp\/conversations\/(\d+)\/(take|assign|close)$/);
        if(waConvActionMatch){
          const id=Number(waConvActionMatch[1]);
          if(waConvActionMatch[2]==="take")return await handleWhatsappTake(env,request,id);
          if(waConvActionMatch[2]==="assign")return await handleWhatsappAssign(env,request,id);
          if(waConvActionMatch[2]==="close")return await handleWhatsappClose(env,request,id);
        }
        const waConvMatch=url.pathname.match(/^\/api\/whatsapp\/conversations\/(\d+)$/);
        if(waConvMatch && request.method==="GET")
          return await handleWhatsappConversation(env,request,Number(waConvMatch[1]));

        // Depois de ensureDatabase: as rotas do Zabbix gravam no D1.
        if (url.pathname.startsWith("/api/zabbix/"))
          return await handleZabbix(request, env, url);

        if (url.pathname === "/api/auth/login" && request.method === "POST")
          return await handleLogin(env, request);

        if (url.pathname === "/api/auth/client-login" && request.method === "POST")
          return await handleClientLoginPhone(env, request);

        if (url.pathname === "/api/auth/me" && request.method === "GET")
          return await handleMe(env, request);

        if (url.pathname === "/api/auth/logout" && request.method === "POST")
          return await handleLogout(env, request);

        if (url.pathname === "/api/auth/change-password" && request.method === "POST") {
          const user=await getCurrentUser(env,request);
          if(!user)return json({error:"AUTH_REQUIRED"},401);
          let b={};try{b=await readJson(request,16384)}catch{}
          // getCurrentUser não traz o hash; busca aqui para não expô-lo nas demais rotas.
          const cred=await getDB(env).prepare(`SELECT password_hash FROM users WHERE id=?`).bind(user.id).first();
          if(!cred||!(await verifyPassword(String(b.oldPassword||""),cred.password_hash)))
            return json({error:"SENHA_ATUAL_INVALIDA"},400);
          if(String(b.newPassword||"").length<8)return json({error:"SENHA_FRACA"},400);
          await getDB(env).prepare(`UPDATE users SET password_hash=?,must_change_password=0,updated_at=CURRENT_TIMESTAMP WHERE id=?`)
            .bind(await hashPassword(String(b.newPassword)),user.id).run();
          const currentHash = await sha256Base64Url(extractSessionToken(request) || "");
          await getDB(env).prepare(`DELETE FROM sessions WHERE user_id=? AND token_hash<>?`).bind(user.id,currentHash).run();
          await audit(env,request,user,"PASSWORD_CHANGED","user",user.id);
          return json({ok:true});
        }

        if (url.pathname === "/api/client/uploads" && request.method === "POST")
          return await handleClientUpload(env, request);

        if (url.pathname === "/api/whatsapp/uploads" && request.method === "POST")
          return await handleStaffUpload(env, request);

        if (url.pathname.startsWith("/api/media/") && request.method === "GET")
          return await handleMediaGet(env, request, url.pathname.slice("/api/media/".length));

        if (url.pathname === "/api/client/me" && request.method === "GET")
          return await handleClientMe(env, request);

        if (url.pathname === "/api/client/change-password" && request.method === "POST")
          return await handleClientChangePassword(env, request);

        if (url.pathname === "/api/client/router-status" && request.method === "GET")
          return await handleClientRouterStatus(env, request);

        if (url.pathname === "/api/client/conversations" && request.method === "GET")
          return await handleClientConversations(env, request);

        if (url.pathname === "/api/client/conversations" && request.method === "POST")
          return await handleClientConversationCreate(env, request);

        const clientMsgMatch = url.pathname.match(/^\/api\/client\/conversations\/(\d+)\/messages$/);
        if (clientMsgMatch && request.method === "POST")
          return await handleClientMessageSend(env, request, Number(clientMsgMatch[1]));

        const clientConvMatch = url.pathname.match(/^\/api\/client\/conversations\/(\d+)$/);
        if (clientConvMatch && request.method === "GET")
          return await handleClientConversationDetail(env, request, Number(clientConvMatch[1]));

        if (url.pathname === "/api/access" && request.method === "GET")
          return await handleAccess(env,request);

        if (url.pathname === "/api/topology/permissions" && request.method === "GET")
          return await handleTopologyPermissions(env,request);

        if (url.pathname === "/api/home/overview" && request.method === "GET")
          return await handleHomeOverview(env, request, url);

        if (url.pathname === "/api/home/alerts/read" && request.method === "POST")
          return await handleAlertsRead(env, request);

        if (url.pathname === "/api/gpon/clients" && request.method === "GET")
          return await handleGponClients(env,request);

        if (url.pathname === "/api/gpon/ingest" && request.method === "POST")
          return await handleGponIngest(env,request);

        if (url.pathname === "/api/gpon/status" && request.method === "POST")
          return await handleGponStatusIngest(env,request);

        if (url.pathname === "/api/gpon/status" && request.method === "GET")
          return await handleGponStatusRead(env,request);

        if (url.pathname === "/api/gpon/history" && request.method === "GET")
          return await handleGponHistory(env,request,url);

        if (url.pathname === "/api/gpon/sync-runs" && request.method === "GET")
          return await handleGponSyncRuns(env,request,url);

        if (url.pathname === "/api/gpon/revision" && request.method === "GET")
          return await handleGponRevision(env,request);

        if (url.pathname === "/api/gpon/collector-status" && request.method === "GET")
          return await handleGponCollectorStatus(env,request);

        if (url.pathname === "/api/gpon/refresh" && request.method === "POST")
          return await handleGponRefresh(env, request);

        if (url.pathname === "/api/radius/ingest" && request.method === "POST")
          return await handleRadiusIngest(env, request);

        if (url.pathname === "/api/radius/logs" && request.method === "GET")
          return await handleRadiusLogs(env, request, url);

        if (url.pathname === "/api/clientes" && request.method === "GET")
          return await handleClientesList(env, request, url);
        if (url.pathname === "/api/clientes" && request.method === "POST")
          return await handleClientesCreate(env, request);
        if (url.pathname === "/api/clientes/feed" && request.method === "GET")
          return await handleClientesFeed(env, request, url);

        const clienteMatch = url.pathname.match(/^\/api\/clientes\/([^/]+)$/);
        if (clienteMatch) {
          const clientId = decodeURIComponent(clienteMatch[1]);
          if (request.method === "GET") return await handleClientesGet(env, request, clientId);
          if (request.method === "PUT") return await handleClientesUpdate(env, request, clientId);
          if (request.method === "DELETE") return await handleClientesDelete(env, request, clientId);
        }

        if (url.pathname === "/api/locais" && request.method === "GET")
          return await handleLocaisList(env, request, url);
        if (url.pathname === "/api/locais" && request.method === "POST")
          return await handleLocaisCreate(env, request);

        const localMatch = url.pathname.match(/^\/api\/locais\/([^/]+)$/);
        if (localMatch) {
          const localId = decodeURIComponent(localMatch[1]);
          if (request.method === "GET") return await handleLocaisGet(env, request, localId);
          if (request.method === "PUT") return await handleLocaisUpdate(env, request, localId);
          if (request.method === "DELETE") return await handleLocaisDelete(env, request, localId);
        }

        if (url.pathname === "/api/produtos" && request.method === "GET")
          return await handleProdutosList(env, request, url);
        if (url.pathname === "/api/produtos" && request.method === "POST")
          return await handleProdutosCreate(env, request);

        const produtoMatch = url.pathname.match(/^\/api\/produtos\/([^/]+)$/);
        if (produtoMatch) {
          const produtoId = decodeURIComponent(produtoMatch[1]);
          if (request.method === "GET") return await handleProdutosGet(env, request, produtoId);
          if (request.method === "PUT") return await handleProdutosUpdate(env, request, produtoId);
          if (request.method === "DELETE") return await handleProdutosDelete(env, request, produtoId);
        }

        if (url.pathname === "/api/trafego/settings" && (request.method === "GET" || request.method === "PUT"))
          return await handleTrafegoSettings(env,request);

        if (url.pathname === "/api/topology" && (request.method === "GET" || request.method === "PUT"))
          return await handleTopology(env,request);

        const connectionMatch = url.pathname.match(/^\/api\/equipment-connections\/([^/]+)$/);
        if (connectionMatch && ["GET","POST"].includes(request.method))
          return await handleDeviceConnections(env,request,decodeURIComponent(connectionMatch[1]));

        const targetMatch = url.pathname.match(/^\/api\/equipment-connections\/([^/]+)\/([^/]+)$/);
        if (targetMatch && ["PUT","DELETE"].includes(request.method))
          return await handleDeviceConnectionTarget(env,request,
            decodeURIComponent(targetMatch[1]),decodeURIComponent(targetMatch[2]));

        const credentialMatch = url.pathname.match(/^\/api\/equipment-connections\/([^/]+)\/([^/]+)\/credentials$/);
        if (credentialMatch && ["PUT","DELETE"].includes(request.method))
          return await handleTargetCredentials(env,request,
            decodeURIComponent(credentialMatch[1]),decodeURIComponent(credentialMatch[2]));

        const revealMatch = url.pathname.match(/^\/api\/equipment-connections\/([^/]+)\/([^/]+)\/credentials\/reveal$/);
        if (revealMatch && request.method === "POST")
          return await handleTargetCredentials(env,request,
            decodeURIComponent(revealMatch[1]),decodeURIComponent(revealMatch[2]),true);

        if (url.pathname === "/api/users" && request.method === "GET")
          return await handleUsers(env,request);

        if (url.pathname === "/api/users" && request.method === "POST")
          return await handleUserCreate(env,request);

        const userMatch=url.pathname.match(/^\/api\/users\/(\d+)$/);
        if(userMatch && request.method==="PATCH")
          return await handleUserUpdate(env,request,Number(userMatch[1]));

        const userDeviceCredentialsMatch=url.pathname.match(/^\/api\/users\/(\d+)\/device-credentials$/);
        if(userDeviceCredentialsMatch && ["GET","PUT"].includes(request.method))
          return await handleUserDeviceCredentials(env,request,Number(userDeviceCredentialsMatch[1]));

        if(url.pathname === "/api/provisioning/pending" && request.method === "GET")
          return await handleProvisioningPending(env,request);

        const provisioningReportMatch=url.pathname.match(/^\/api\/provisioning\/([^/]+)\/(\d+)\/report$/);
        if(provisioningReportMatch && request.method === "POST")
          return await handleProvisioningReport(env,request,
            decodeURIComponent(provisioningReportMatch[1]),Number(provisioningReportMatch[2]));

        if (url.pathname === "/api/audit" && request.method === "GET")
          return await handleAudit(env,request);

        if (url.pathname === "/api/platform/roles" && request.method === "GET")
          return await handlePlatformRoles(env,request);

        if (url.pathname === "/api/platform/sectors" && ["GET","POST"].includes(request.method))
          return await handleSectors(env,request);

        const sectorMatch=url.pathname.match(/^\/api\/platform\/sectors\/(\d+)$/);
        if(sectorMatch && request.method==="PATCH")
          return await handleSectorUpdate(env,request,Number(sectorMatch[1]));

        if (url.pathname === "/api/platform/roles" && request.method === "POST")
          return await handlePlatformRoleCreate(env,request);

        const roleMatch=url.pathname.match(/^\/api\/platform\/roles\/(\d+)$/);
        if(roleMatch){
          const id=Number(roleMatch[1]);
          if(request.method==="PATCH")return await handlePlatformRoleUpdate(env,request,id);
          if(request.method==="DELETE")return await handlePlatformRoleDelete(env,request,id);
        }

        const accessMatch=url.pathname.match(/^\/api\/platform\/roles\/(\d+)\/access$/);
        if(accessMatch && request.method==="PUT")
          return await handlePlatformRoleAccess(env,request,Number(accessMatch[1]));

        const screenMatch=url.pathname.match(/^\/api\/platform\/screens\/(\d+)$/);
        if(screenMatch && request.method==="PUT")
          return await handlePlatformScreen(env,request,Number(screenMatch[1]));

        if(url.pathname === "/api/platform/screens" && request.method==="GET"){
          const gate=await requirePermission(env,request,"roles.view");if(gate.response)return gate.response;
          const rows=(await getDB(env).prepare(`
            SELECT id,code,name,description,route,active,icon,sort,nav,sector_id FROM screens ORDER BY sort,id
          `).all()).results;
          return json(rows);
        }

        return json({ok:false,error:"Endpoint não encontrado.",path:url.pathname},404);
      }

      // Página nunca é servida com credencial na query string: redireciona para
      // a URL limpa antes que ela vire histórico, bookmark ou Referer.
      if (request.method === "GET" && (url.searchParams.has("password") || url.searchParams.has("username"))) {
        const limpa = new URL(url);
        limpa.search = "";
        return new Response(null, {status:303, headers:{Location:limpa.toString(), "Referrer-Policy":"no-referrer"}});
      }

      return await serveAsset(request, env);
    } catch(error) {
      // O detalhe do erro fica no log do Worker; a resposta não expõe
      // mensagem de banco, esquema ou stack para o cliente.
      console.error(JSON.stringify({message:"Unhandled Worker error",error:error instanceof Error?error.message:String(error),path:new URL(request.url).pathname}));
      return json({ok:false,error:"Erro interno do Worker.", detail: error instanceof Error ? error.message : String(error)},500);
    }
  },

  /* Sincronização automática. Um painel de NOC em telão precisa estar certo
     sozinho: sem isto, o número na parede só mudava quando alguém clicava em
     "Sincronizar agora". A execução fica registrada em zabbix_sync_runs com
     source='cron', e sem ZABBIX_URL/ZABBIX_TOKEN configurados ela não roda —
     nada de encher o log de erro em instalação que ainda não integrou. */
  async scheduled(event, env, ctx) {
    ctx.waitUntil((async () => {
      try {
        await ensureDatabase(env);
      } catch (error) {
        console.error(JSON.stringify({message:"Cron não conseguiu preparar o banco",error:error instanceof Error?error.message:String(error)}));
        return;
      }

      /* A poda roda mesmo sem Zabbix: o histórico GPON nasce do coletor, que é
         independente dele, e era o único trecho do cron que dependia de uma
         integração não relacionada para sequer começar. */
      try {
        const podado = await podarHistoricoGpon(env);
        if (podado.historico || podado.ciclos) console.log(JSON.stringify({message:"Retenção GPON aplicada",...podado}));
      } catch (error) {
        console.error(JSON.stringify({message:"Retenção GPON falhou",error:error instanceof Error?error.message:String(error)}));
      }

      if (!env.ZABBIX_URL || !env.ZABBIX_TOKEN) return;
      try {
        const resultado = await runZabbixSync(env, { source: "cron" });
        if (!resultado.ok) {
          console.error(JSON.stringify({message:"Zabbix cron sync falhou",error:resultado.error,cron:event.cron}));
        }
      } catch (error) {
        console.error(JSON.stringify({message:"Zabbix cron sync falhou",error:error instanceof Error?error.message:String(error)}));
      }
    })());
  }
};
