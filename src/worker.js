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
CREATE INDEX IF NOT EXISTS idx_alerts_abertos ON alerts(resolved_at,grau,last_seen_at);
CREATE INDEX IF NOT EXISTS idx_alerts_origem ON alerts(origem,resolved_at);
CREATE INDEX IF NOT EXISTS idx_alert_reads_user ON alert_reads(user_id,alert_id);
CREATE INDEX IF NOT EXISTS idx_crm_cases_sector_stage ON crm_cases(sector_id,stage_id,updated_at);
CREATE INDEX IF NOT EXISTS idx_crm_cases_assignee ON crm_cases(assigned_user_id,updated_at);
CREATE INDEX IF NOT EXISTS idx_crm_cases_next_contact ON crm_cases(next_contact_at);
CREATE INDEX IF NOT EXISTS idx_crm_activities_case ON crm_activities(case_id,created_at);
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
  ["gpon-mapa", "Mapas GPON", "Mapa operacional somente leitura de clientes, caixas, POPs, drops e caminho ponta a ponta", "/gpon-mapa.html", 1, "pops", 16, 1],
  ["isp", "ISP", "Mapa por cliente ISP, equipamentos, portas e enlaces", "/isp.html", 1, "topology", 16, 1],
  ["isp-mapa", "Mapa de fibra ISP", "Clientes ISP e caminhos de fibra sobre o mapa geográfico", "/isp-mapa.html", 1, "pops", 17, 1],
  ["isp-cadastro", "Cadastro de POPs ISP", "Cadastrar, editar e excluir clientes ISP e os equipamentos deles", "/isp-cadastro.html", 1, "users", 18, 1],
  ["pops", "Cadastro de POPs Backbone", "Inventário por POP, rotas ópticas e sequência do anel", "/pops.html", 0, "pops", 20, 0],
  ["dashboard", "Dashboard NOC", "Painel operacional para TV/NOC", "/dashboard.html", 1, "dashboard", 30, 1],
  ["trafego", "Tráfego", "Monitoramento de tráfego, utilização e erros por interface", "/trafego.html", 1, "trafego", 35, 1],
  ["agenda", "Agenda", "Compromissos pessoais e dos setores do usuário", "/agenda.html", 1, "calendar", 38, 1],
  ["crm", "Central CRM", "Leads, clientes, solicitações e histórico separados por setor", "/crm.html", 1, "users", 25, 1],
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
  ["settings.manage", "Alterar configurações", "Configurações administrativas da plataforma", "platform", "Plataforma", 90]
];

const ALL_ACTION_CODES = ACTIONS.map(x => x[0]);
const ALL_SCREEN_CODES = SCREENS.map(x => x[0]);

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
    "roles.view","users.view","users.manage","users.password","sectors.manage","audit.view","audit.export","settings.manage"
  ],
  analista: [
    "topology.view","topology.edit","topology.delete","topology.equipment.create","topology.equipment.edit",
    "topology.equipment.delete","topology.port.edit","topology.link.create","topology.link.delete",
    "topology.pop.link","topology.layout","zabbix.view","zabbix.sync","trafego.settings",
    "pops.create","pops.edit","pops.delete","pops.order","pops.routes","pops.ring.layout",
    "fibra.edit","fibra.delete","agenda.view","agenda.create","agenda.edit","agenda.delete","audit.view",
    "crm.view","crm.create","crm.edit","crm.interact"
  ],
  atendimento: ["topology.view","zabbix.view","agenda.view","agenda.create","agenda.edit","agenda.delete","crm.view","crm.create","crm.edit","crm.interact"],
  tecnico: [
    "topology.view","topology.edit","topology.equipment.create","topology.equipment.edit","topology.port.edit",
    "topology.link.create","topology.pop.link","topology.layout",
    "zabbix.view","zabbix.sync","zabbix.link","trafego.settings",
    "pops.edit","pops.order","pops.routes","pops.ring.layout","fibra.edit",
    "agenda.view","agenda.create","agenda.edit","agenda.delete","crm.view","crm.create","crm.edit","crm.interact"
  ],
  logistica: [
    "topology.view","topology.edit","topology.equipment.create","topology.equipment.edit","topology.port.edit",
    "topology.pop.link","zabbix.view","pops.create","pops.edit","pops.order",
    "agenda.view","agenda.create","agenda.edit","agenda.delete","crm.view","crm.create","crm.edit","crm.interact"
  ]
};

const ROLE_SCREENS = {
  administrador: ALL_SCREEN_CODES,
  gerente: ["home","network","gpon","gpon-mapa","isp","isp-mapa","isp-cadastro","pops","dashboard","trafego","agenda","crm","platform","legado"],
  analista: ["home","network","gpon","gpon-mapa","isp","isp-mapa","isp-cadastro","pops","dashboard","trafego","agenda","crm","legado"],
  atendimento: ["home","network","gpon","gpon-mapa","isp","isp-mapa","isp-cadastro","pops","dashboard","trafego","agenda","crm"],
  tecnico: ["home","network","gpon","gpon-mapa","isp","isp-mapa","isp-cadastro","pops","dashboard","trafego","agenda","crm","legado"],
  logistica: ["home","network","gpon","gpon-mapa","isp","isp-mapa","isp-cadastro","pops","dashboard","agenda","crm"]
};

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
  ["topology.equipment.edit", ["topology.connection.configure"]],
  ["topology.delete", ["topology.equipment.delete","topology.link.delete","pops.delete","fibra.delete"]],
  ["users.manage", ["users.password"]],
  ["audit.view", ["audit.export"]],
  ["settings.manage", ["roles.view"]]
];

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
      "permissions-policy": "camera=(), microphone=(), geolocation=()",
      ...extraHeaders
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

function csrfFailure(request) {
  if (["GET", "HEAD", "OPTIONS"].includes(request.method)) return null;
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
  const rows = (await getDB(env).prepare(`
    SELECT p.code FROM role_permissions rp
    JOIN permissions p ON p.id=rp.permission_id
    WHERE rp.role_id=?
  `).bind(user.role_id).all()).results || [];
  return new Set(rows.map(x => x.code));
}

async function hasPermission(env, user, code) {
  if (!user) return false;
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

  // O mapa operacional acompanha, uma única vez, os perfis que já enxergam a
  // GPON. Depois disso o acesso volta a ser administrado pela Plataforma.
  await seedOnce(db, "seed.gpon_map_screen.v1", async () => {
    const comGpon = ((await db.prepare(`
      SELECT rs.role_id FROM role_screens rs JOIN screens s ON s.id=rs.screen_id WHERE s.code='gpon'
    `).all()).results || []).map(x => x.role_id);
    await runGrants(comGpon.map(roleId => grantScreen(roleId, "gpon-mapa")));
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
      equipamentos:"isp-equipamentos.json", conexoes:"isp-conexoes.json", pops:"isp-pops.json",
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

async function loadInitialTopology(env, request, scope = DEFAULT_SCOPE) {
  const recorte = TOPOLOGY_SCOPES[scope] || TOPOLOGY_SCOPES[DEFAULT_SCOPE];
  const read = async (name) => {
    const url = new URL(request.url);
    url.pathname = `/data/${name}`;
    url.search = "";
    const r = await env.ASSETS.fetch(new Request(url.toString(), {method:"GET"}));
    if (!r.ok) throw new Error(`Não foi possível carregar /data/${name}`);
    return r.json();
  };
  const inicial = {config:{...DEFAULT_TOPOLOGY_CONFIG, ...recorte.config}};
  for (const [campo, arquivo] of Object.entries(recorte.seed)) inicial[campo] = await read(arquivo);
  return inicial;
}

async function ensureTopologyState(env, request, scope = DEFAULT_SCOPE) {
  const db = getDB(env);
  // A rede principal continua na tabela de sempre, com a linha única id=1.
  const ler = scope === DEFAULT_SCOPE
    ? () => db.prepare(`SELECT * FROM topology_state WHERE id=1`).first()
    : () => db.prepare(`SELECT * FROM topology_scopes WHERE scope=?`).bind(scope).first();
  const row = await ler();
  if (row) return row;
  const initial = await loadInitialTopology(env, request, scope);
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
  const cookies = parseCookies(request);
  const rawToken = cookies[COOKIE_NAME];
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

  return row || null;
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

  // Não revela se o usuário existe.
  if (!user || !user.active || !(await verifyPassword(password, user.password_hash))) {
    await recordFailedLogin(env, attempt.key);
    if (user) {
      await audit(env, request, user, "LOGIN_FAILED", "auth", String(user.id), null, null, {reason:"invalid_credentials"});
    }
    return json({ ok: false, error: "INVALID_CREDENTIALS" }, 401);
  }

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
    }
  }, 200, {
    "Set-Cookie": session.cookie
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

async function handleMe(env, request) {
  const user = await getCurrentUser(env, request);
  if (!user) return json({ authenticated: false }, 401);

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
  const cookies = parseCookies(request);
  const rawToken = cookies[COOKIE_NAME];

  if (rawToken) {
    const tokenHash = await sha256Base64Url(rawToken);
    await db.prepare(`DELETE FROM sessions WHERE token_hash=?`).bind(tokenHash).run();
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
  let realtime = null;
  if (realtimeRequested && env.ZABBIX_URL && env.ZABBIX_TOKEN) {
    try {
      /* O cache da borda reúne telas abertas no mesmo local durante uma janela
         curta. A coleta ao vivo não regrava centenas de interfaces no D1 a
         cada 15 s; o cron continua cuidando do espelho persistente/histórico. */
      const cacheKey = new Request(new URL("/__internal/zabbix-realtime", request.url), { method: "GET" });
      const edgeCache = caches.default;
      const cached = await edgeCache.match(cacheKey);
      if (cached) {
        realtime = await cached.json();
      } else {
        realtime = {
          collected_at: new Date().toISOString(),
          inventory: await fetchNetworkInventory(env)
        };
        await edgeCache.put(cacheKey, new Response(JSON.stringify(realtime), {
          headers: {
            "Content-Type": "application/json",
            "Cache-Control": `public, max-age=${Math.max(10, settings.intervaloSegundos - 2)}`
          }
        }));
      }
    } catch (error) {
      realtime = { error: error instanceof Error ? error.message : String(error) };
    }
  }

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

async function handleAccess(env, request) {
  const user = await getCurrentUser(env, request);
  if (!user) return json({error:"AUTH_REQUIRED"},401);
  const db=getDB(env);
  const permissions=(await db.prepare(`
    SELECT p.code FROM role_permissions rp JOIN permissions p ON p.id=rp.permission_id
    WHERE rp.role_id=? ORDER BY p.code
  `).bind(user.role_id).all()).results.map(x=>x.code);
  const screens=(await db.prepare(`
    SELECT s.code,s.name,s.description,s.route,s.icon,s.sort,s.nav,
      COALESCE(sec.code,'noc') sector
    FROM role_screens rs JOIN screens s ON s.id=rs.screen_id
    LEFT JOIN sectors sec ON sec.id=s.sector_id AND sec.active=1
    WHERE rs.role_id=? AND s.active=1 ORDER BY s.sort,s.id
  `).bind(user.role_id).all()).results;
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

const PERFIL_PROTEGIDO = "administrador";
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
  const before=JSON.parse(row.data_json);
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
  // A atualização e a limpeza das credenciais órfãs formam uma única operação
  // atômica no D1: ou tudo é gravado, ou nada é alterado.
  const topologyWrites = [
    scope===DEFAULT_SCOPE
      ? db.prepare(`
          UPDATE topology_state SET data_json=?,version=?,updated_at=CURRENT_TIMESTAMP,updated_by=? WHERE id=1
        `).bind(JSON.stringify(after),nextVersion,user.id)
      : db.prepare(`
          UPDATE topology_scopes SET data_json=?,version=?,updated_at=CURRENT_TIMESTAMP,updated_by=? WHERE scope=?
        `).bind(JSON.stringify(after),nextVersion,user.id,scope),
    ...diff.equipamentos.removed.flatMap(id => [
      db.prepare(`DELETE FROM device_target_credentials WHERE target_id IN (SELECT id FROM device_connection_targets WHERE device_id=?)`).bind(id),
      db.prepare(`DELETE FROM device_connection_acl WHERE target_id IN (SELECT id FROM device_connection_targets WHERE device_id=?)`).bind(id),
      db.prepare(`DELETE FROM device_connection_targets WHERE device_id=?`).bind(id),
      db.prepare(`DELETE FROM device_credentials WHERE device_id=?`).bind(id),
      db.prepare(`DELETE FROM device_connections WHERE device_id=?`).bind(id)
    ])
  ];
  await db.batch(topologyWrites);
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

function publicCredential(row) {
  return row ? {
    username:row.login_username,
    has_password:Boolean(row.password_ciphertext),
    updated_at:row.updated_at
  } : null;
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
  if (!name || name.length > 100) return {error:"NOME_DO_DESTINO_INVALIDO"};
  if (!ip) return {error:"IP_DE_GERENCIA_INVALIDO"};
  if (!['ssh','telnet'].includes(protocol)) return {error:"PROTOCOLO_INVALIDO"};
  if (!Number.isInteger(port) || port < 1 || port > 65535) return {error:"PORTA_INVALIDA"};
  if (rawBrowserUrl && !browserUrl) return {error:"URL_DO_TERMINAL_DEVE_USAR_HTTPS"};

  const validRoles = new Set(((await db.prepare(`SELECT id FROM roles`).all()).results || []).map(r => Number(r.id)));
  const requestedConnect = Array.isArray(body.connect_role_ids) ? body.connect_role_ids.map(Number) : [];
  const requestedManage = Array.isArray(body.manage_role_ids) ? body.manage_role_ids.map(Number) : [];
  if ([...requestedConnect,...requestedManage].some(id => !Number.isInteger(id) || !validRoles.has(id)))
    return {error:"PERFIL_DE_ACESSO_INVALIDO"};
  const manageRoleIds = [...new Set(requestedManage)];
  const connectRoleIds = [...new Set([...requestedConnect,...manageRoleIds])];
  return {name,ip,protocol,port,browser_url:browserUrl,connectRoleIds,manageRoleIds};
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
    await db.batch([
      db.prepare(`
        INSERT INTO device_connection_targets
          (id,device_id,name,management_ip,protocol,port,browser_url,updated_by,updated_at)
        VALUES (?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP)
      `).bind(id,deviceId,normalized.name,normalized.ip,normalized.protocol,normalized.port,normalized.browser_url,gate.user.id),
      ...targetAclStatements(db,id,normalized)
    ]);
    await audit(env,request,gate.user,"DEVICE_CONNECTION_TARGET_CREATE","device_connection_target",id,null,
      {...normalized,device_id:deviceId});
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
      browser_url:row.browser_url,updated_at:row.updated_at,can_manage:canManage,
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
      db.prepare(`DELETE FROM device_connection_acl WHERE target_id=?`).bind(targetId),
      db.prepare(`DELETE FROM device_connection_targets WHERE id=?`).bind(targetId)
    ]);
    await audit(env,request,gate.user,"DEVICE_CONNECTION_TARGET_DELETE","device_connection_target",targetId,target,null);
    return json({ok:true});
  }

  let body; try { body = await readJson(request,16384); } catch { return json({error:"JSON_INVALIDO"},400); }
  const normalized = await normalizedTargetBody(db,body);
  if (normalized.error) return json({error:normalized.error},400);
  await db.batch([
    db.prepare(`
      UPDATE device_connection_targets SET name=?,management_ip=?,protocol=?,port=?,browser_url=?,updated_by=?,updated_at=CURRENT_TIMESTAMP
      WHERE id=? AND device_id=?
    `).bind(normalized.name,normalized.ip,normalized.protocol,normalized.port,normalized.browser_url,gate.user.id,targetId,deviceId),
    ...targetAclStatements(db,targetId,normalized)
  ]);
  await audit(env,request,gate.user,"DEVICE_CONNECTION_TARGET_UPDATE","device_connection_target",targetId,target,normalized);
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
const primeiroGpon = (...valores) => valores.find(v => v !== undefined && v !== null && v !== "");
const numeroGpon = (v) => v !== undefined && v !== null && v !== "" && Number.isFinite(Number(v)) ? Number(v) : null;
const pontosGpon = (valor) => (Array.isArray(valor) ? valor : []).map(p => ({
  lat: numeroGpon(Array.isArray(p) ? p[0] : primeiroGpon(p?.lat, p?.latitude)),
  lon: numeroGpon(Array.isArray(p) ? p[1] : primeiroGpon(p?.lon, p?.lng, p?.longitude))
})).filter(p => p.lat !== null && p.lon !== null && Math.abs(p.lat) <= 90 && Math.abs(p.lon) <= 180);

function normalizarClienteGpon(c, i) {
  const loc = c?.location || c?.localizacao || {};
  const caminho = primeiroGpon(c?.path, c?.caminho, c?.end_to_end, []);
  return {
    id: String(primeiroGpon(c?.id, c?.client_id, c?.onu_id, c?.serial, c?.sn, `cliente-${i + 1}`)),
    name: String(primeiroGpon(c?.name, c?.nome, c?.customer_name, c?.cliente, c?.username, "Cliente sem nome")),
    username: String(primeiroGpon(c?.username, c?.login, c?.pppoe, "")),
    status: String(primeiroGpon(c?.status, c?.state, c?.estado, c?.online === false ? "offline" : "online")).toLowerCase(),
    serial: String(primeiroGpon(c?.serial, c?.sn, c?.onu_serial, "")),
    onu_index: String(primeiroGpon(c?.onu_index, c?.onu, c?.index, "")),
    model: String(primeiroGpon(c?.model, c?.modelo, c?.onu_model, "")),
    state_detail: String(primeiroGpon(c?.state_detail, c?.phase_state, c?.detalhe_estado, "")),
    olt_id: String(primeiroGpon(c?.olt_id, c?.olt, c?.equipment_id, c?.equipamento_id, "")),
    pon: String(primeiroGpon(c?.pon, c?.pon_port, c?.interface, c?.porta_pon, "")),
    vlan: String(primeiroGpon(c?.vlan, c?.service_vlan, "")),
    ip: String(primeiroGpon(c?.ip, c?.ip_address, c?.endereco_ip, "")),
    address: String(primeiroGpon(c?.address, c?.endereco, loc?.address, loc?.endereco, "")),
    lat: numeroGpon(primeiroGpon(c?.lat, c?.latitude, loc?.lat, loc?.latitude)),
    lon: numeroGpon(primeiroGpon(c?.lon, c?.lng, c?.longitude, loc?.lon, loc?.lng, loc?.longitude)),
    rx_power: numeroGpon(primeiroGpon(c?.rx_power, c?.rx, c?.signal, c?.sinal_rx)),
    tx_power: numeroGpon(primeiroGpon(c?.tx_power, c?.tx, c?.sinal_tx)),
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
  return json(await carregarFeedGpon(env));
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

  const serialized = JSON.stringify({
    source: String(data.source || "Coletor ZTE + IXC Provedor").slice(0, 120),
    synced_at: String(data.synced_at || new Date().toISOString()).slice(0, 40), clients, boxes, alerts
  });
  const version = bytesToBase64Url(randomBytes(18));
  const chunkSize = 128 * 1024;
  const chunks = [];
  for (let offset = 0; offset < serialized.length; offset += chunkSize) chunks.push(serialized.slice(offset, offset + chunkSize));
  const db = getDB(env);
  for (let index = 0; index < chunks.length; index += 8) {
    await db.batch(chunks.slice(index, index + 8).map((chunk, position) => db.prepare(`
      INSERT INTO gpon_snapshot_chunks(version,chunk_index,data_text) VALUES (?,?,?)
    `).bind(version, index + position, chunk)));
  }
  await db.prepare(`
    INSERT INTO gpon_snapshot_state(id,version,source,synced_at,chunk_count,data_bytes,clients_count,boxes_count,alerts_count,updated_at)
    VALUES (1,?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP)
    ON CONFLICT(id) DO UPDATE SET version=excluded.version,source=excluded.source,synced_at=excluded.synced_at,
      chunk_count=excluded.chunk_count,data_bytes=excluded.data_bytes,clients_count=excluded.clients_count,
      boxes_count=excluded.boxes_count,alerts_count=excluded.alerts_count,updated_at=CURRENT_TIMESTAMP
  `).bind(version, String(data.source || "Coletor ZTE + IXC Provedor").slice(0, 120),
    String(data.synced_at || new Date().toISOString()).slice(0, 40), chunks.length,
    new TextEncoder().encode(serialized).byteLength, clients.length, boxes.length, alerts.length).run();
  await db.prepare(`DELETE FROM gpon_snapshot_chunks WHERE version<>?`).bind(version).run();
  await db.prepare(`DELETE FROM gpon_client_status`).run();
  await db.prepare(`DELETE FROM gpon_status_snapshot`).run();
  return json({ ok: true, clients: clients.length, boxes: boxes.length, alerts: alerts.length });
}

async function handleGponStatusIngest(env, request) {
  const expected = String(env.GPON_SYNC_TOKEN || "");
  const authorization = String(request.headers.get("Authorization") || "");
  if (!expected || !(await timingSafeEqual(authorization, `Bearer ${expected}`))) return json({ error: "UNAUTHORIZED" }, 401);
  let data;
  try { data = await readJson(request, 4 * 1024 * 1024); }
  catch (error) { return json({ error: error?.message === "BODY_TOO_LARGE" ? "BODY_TOO_LARGE" : "INVALID_JSON" }, 400); }
  if (!Array.isArray(data?.changes) || data.changes.length > 30000) return json({ error: "INVALID_GPON_STATUS" }, 400);
  const rows = data.changes.map(change => ({
    id: String(change?.id || "").slice(0, 160), status: String(change?.status || "unknown").slice(0, 40),
    detail: String(change?.state_detail || "").slice(0, 160),
    rx: numeroGpon(change?.rx_power), tx: numeroGpon(change?.tx_power)
  })).filter(row => row.id);
  const db = getDB(env), syncedAt = String(data.synced_at || new Date().toISOString()).slice(0, 40);
  const current = await db.prepare(`SELECT data_json FROM gpon_status_snapshot WHERE id=1`).first();
  let existing = [];
  if (current?.data_json) { try { existing = JSON.parse(current.data_json); } catch {} }
  const byId = new Map((Array.isArray(existing) ? existing : []).map(row => [String(row.client_id), row]));
  rows.forEach(row => byId.set(row.id, { client_id: row.id, status: row.status, state_detail: row.detail, rx_power: row.rx, tx_power: row.tx }));
  if (rows.length) await db.batch([
    db.prepare(`
      INSERT INTO gpon_status_snapshot(id,data_json,synced_at,updated_at) VALUES (1,?,?,CURRENT_TIMESTAMP)
      ON CONFLICT(id) DO UPDATE SET data_json=excluded.data_json,synced_at=excluded.synced_at,updated_at=CURRENT_TIMESTAMP
    `).bind(JSON.stringify([...byId.values()]), syncedAt),
    db.prepare(`UPDATE gpon_snapshot_state SET synced_at=?,updated_at=CURRENT_TIMESTAMP WHERE id=1`).bind(syncedAt)
  ]);
  return json({ ok: true, changes: rows.length });
}

async function handleGponRevision(env, request) {
  const gate = await requirePermission(env, request, "topology.view");
  if (gate.response) return gate.response;
  const row = await getDB(env).prepare(`SELECT version,synced_at,updated_at FROM gpon_snapshot_state WHERE id=1`).first();
  return json(row || { version: null, synced_at: null, updated_at: null });
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
        await ensureDatabase(env);
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

        // Depois de ensureDatabase: as rotas do Zabbix gravam no D1.
        if (url.pathname.startsWith("/api/zabbix/"))
          return await handleZabbix(request, env, url);

        if (url.pathname === "/api/auth/login" && request.method === "POST")
          return await handleLogin(env, request);

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
          const currentHash = await sha256Base64Url(parseCookies(request)[COOKIE_NAME] || "");
          await getDB(env).prepare(`DELETE FROM sessions WHERE user_id=? AND token_hash<>?`).bind(user.id,currentHash).run();
          await audit(env,request,user,"PASSWORD_CHANGED","user",user.id);
          return json({ok:true});
        }

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

        if (url.pathname === "/api/gpon/revision" && request.method === "GET")
          return await handleGponRevision(env,request);

        if (url.pathname === "/api/gpon/collector-status" && request.method === "GET")
          return await handleGponCollectorStatus(env,request);

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
      return json({ok:false,error:"Erro interno do Worker."},500);
    }
  },

  /* Sincronização automática. Um painel de NOC em telão precisa estar certo
     sozinho: sem isto, o número na parede só mudava quando alguém clicava em
     "Sincronizar agora". A execução fica registrada em zabbix_sync_runs com
     source='cron', e sem ZABBIX_URL/ZABBIX_TOKEN configurados ela não roda —
     nada de encher o log de erro em instalação que ainda não integrou. */
  async scheduled(event, env, ctx) {
    if (!env.ZABBIX_URL || !env.ZABBIX_TOKEN) return;
    ctx.waitUntil((async () => {
      try {
        await ensureDatabase(env);
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
