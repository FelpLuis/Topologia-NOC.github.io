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
import {
  buildGoogleCalendarAuthorizationUrl,
  decryptGoogleRefreshToken,
  encryptGoogleRefreshToken,
  exchangeGoogleCalendarCode,
  fetchGoogleCalendars,
  fetchGoogleEvents,
  fetchGoogleProfile,
  googleCalendarEnabled,
  googleCalendarRedirectUri,
  refreshGoogleAccessToken,
  sha256Base64Url as googleSha256Base64Url
} from "./google-calendar.js";

const COOKIE_NAME = "__Host-topologia_noc_session";
const OAUTH_STATE_COOKIE = "__Host-topologia_noc_oauth";
const GOOGLE_CALENDAR_STATE_COOKIE = "__Host-topologia_noc_google_calendar";
const SESSION_DAYS = 7;
const PBKDF2_ITERATIONS = 100000;
const OAUTH_STATE_MINUTES = 10;
const GOOGLE_CALENDAR_STATE_MINUTES = 10;
const MAX_JSON_BODY_BYTES = 1024 * 1024;

// Compatível com o binding mostrado no Cloudflare:
// D1 binding: "bd"
// Assets binding: "ASSETS"
// O código também aceita DB caso você prefira renomear o binding para DB.

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

CREATE TABLE IF NOT EXISTS google_calendar_states (
  state_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_verifier TEXT NOT NULL,
  return_to TEXT NOT NULL DEFAULT '/',
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS google_calendar_connections (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  google_account_id TEXT,
  google_email TEXT NOT NULL DEFAULT '',
  refresh_token_ciphertext TEXT NOT NULL,
  calendars_json TEXT NOT NULL DEFAULT '[]',
  alert_minutes INTEGER NOT NULL DEFAULT 10 CHECK(alert_minutes BETWEEN 0 AND 1440),
  active INTEGER NOT NULL DEFAULT 1,
  connected_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_sync_at TEXT,
  last_error TEXT
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
  nav INTEGER NOT NULL DEFAULT 1
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

CREATE INDEX IF NOT EXISTS idx_audit_created_at ON audit_logs(created_at);
CREATE INDEX IF NOT EXISTS idx_audit_user_id ON audit_logs(user_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_sessions_token_hash ON sessions(token_hash);
CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_oauth_states_expires ON oauth_states(expires_at);
CREATE INDEX IF NOT EXISTS idx_google_calendar_states_expires ON google_calendar_states(expires_at);
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
`;


const ROLES = [
  ["administrador", "Acesso total ao sistema"],
  ["gerente", "Acesso gerencial à operação, topologia, usuários e auditoria"],
  ["analista", "Pode visualizar, alterar e excluir a topologia e consultar auditoria"],
  ["atendimento", "Visualização da topologia e informações dos equipamentos"],
  ["tecnico", "Pode visualizar e alterar equipamentos, portas e conexões"],
  ["logistica", "Pode visualizar e alterar informações operacionais da topologia"]
];

// Catálogo de telas do sistema. Toda tela navegável é declarada aqui e passa
// a aparecer em Plataforma → Perfis, onde o acesso é dado por perfil.
// [code, name, description, route, active, icon, sort, nav]
const SCREENS = [
  ["network", "Topologia", "Mapa por localidade, equipamentos, portas e enlaces", "/", 1, "topology", 10, 1],
  ["gpon", "Topologia GPON", "Mapa da topologia da rede GPON", "/gpon.html", 1, "topology", 15, 1],
  ["isp", "Topologia ISP", "Mapa por cliente ISP, equipamentos, portas e enlaces", "/isp.html", 1, "topology", 16, 1],
  ["isp-mapa", "Mapa de fibra ISP", "Clientes ISP e caminhos de fibra sobre o mapa geográfico", "/isp-mapa.html", 1, "pops", 17, 1],
  ["isp-cadastro", "Cadastro de ISP", "Cadastrar, editar e excluir clientes ISP e os equipamentos deles", "/isp-cadastro.html", 1, "users", 18, 1],
  ["pops", "POPs e anel óptico", "Inventário por POP, rotas ópticas e sequência do anel", "/pops.html", 1, "pops", 20, 1],
  ["dashboard", "Dashboard NOC", "Painel operacional para TV/NOC", "/dashboard.html", 1, "dashboard", 30, 1],
  ["trafego", "Tráfego", "Monitoramento de tráfego, utilização e erros por interface", "/trafego.html", 1, "trafego", 35, 1],
  ["platform", "Gerenciar plataforma", "Perfis, ações, telas, usuários e auditoria", "/platform.html", 1, "platform", 40, 1],
  ["legado", "Editor clássico", "Editor legado da topologia em tela única", "/legado.html", 1, "edit", 50, 0]
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

const SCHEMA_FINGERPRINT = fingerprintOf(SCHEMA + JSON.stringify([ROLES, SCREENS, ACTIONS]));
const SCHEMA_FINGERPRINT_KEY = "schema.fingerprint";

const TOPOLOGY_ACTIONS = ALL_ACTION_CODES.filter(c => c.startsWith("topology.") || c.startsWith("pops.") || c.startsWith("zabbix.") || c.startsWith("fibra."));

const ROLE_PERMISSIONS = {
  administrador: ALL_ACTION_CODES,
  gerente: [
    ...TOPOLOGY_ACTIONS, "trafego.settings",
    "roles.view","users.view","users.manage","users.password","audit.view","audit.export","settings.manage"
  ],
  analista: [
    "topology.view","topology.edit","topology.delete","topology.equipment.create","topology.equipment.edit",
    "topology.equipment.delete","topology.port.edit","topology.link.create","topology.link.delete",
    "topology.pop.link","topology.layout","zabbix.view","zabbix.sync","trafego.settings",
    "pops.create","pops.edit","pops.delete","pops.order","pops.routes","pops.ring.layout",
    "fibra.edit","fibra.delete","audit.view"
  ],
  atendimento: ["topology.view","zabbix.view"],
  tecnico: [
    "topology.view","topology.edit","topology.equipment.create","topology.equipment.edit","topology.port.edit",
    "topology.link.create","topology.pop.link","topology.layout",
    "zabbix.view","zabbix.sync","zabbix.link","trafego.settings",
    "pops.edit","pops.order","pops.routes","pops.ring.layout","fibra.edit"
  ],
  logistica: [
    "topology.view","topology.edit","topology.equipment.create","topology.equipment.edit","topology.port.edit",
    "topology.pop.link","zabbix.view","pops.create","pops.edit","pops.order"
  ]
};

const ROLE_SCREENS = {
  administrador: ALL_SCREEN_CODES,
  gerente: ["network","gpon","isp","isp-mapa","isp-cadastro","pops","dashboard","trafego","platform","legado"],
  analista: ["network","gpon","isp","isp-mapa","isp-cadastro","pops","dashboard","trafego","legado"],
  atendimento: ["network","gpon","isp","isp-mapa","isp-cadastro","pops","dashboard","trafego"],
  tecnico: ["network","gpon","isp","isp-mapa","isp-cadastro","pops","dashboard","trafego","legado"],
  logistica: ["network","gpon","isp","isp-mapa","isp-cadastro","pops","dashboard"]
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
  // Seu print mostra o binding D1 com nome "bd".
  return env.bd || env.DB;
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
  if (!db) throw new Error('Binding D1 "bd" não encontrado.');

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
  if (!db) throw new Error('Binding D1 "bd" não encontrado.');

  // A migração pode acrescentar colunas em audit_logs: o cache é refeito depois.
  auditColumnNames = null;

  const schemaStatements = SCHEMA.split(/;\s*(?=CREATE TABLE|CREATE (?:UNIQUE )?INDEX)/)
    .map(x => x.trim()).filter(Boolean);

  // Índices que usam colunas adicionadas por migração só podem ser criados
  // depois dos ALTER TABLE. Isso mantém compatibilidade com bancos antigos.
  const tableStatements = schemaStatements
    .filter(x => !/^CREATE (?:UNIQUE )?INDEX\b/i.test(x))
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
    ["nav", "INTEGER NOT NULL DEFAULT 1"]
  ]);
  await ensureColumns(db, "permissions", [
    ["name", "TEXT NOT NULL DEFAULT ''"],
    ["module", "TEXT NOT NULL DEFAULT 'Geral'"],
    ["screen_code", "TEXT"],
    ["sort", "INTEGER NOT NULL DEFAULT 0"]
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
    .filter(x => /^CREATE (?:UNIQUE )?INDEX\b/i.test(x))
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
    ...ACTIONS.map(([code,name,description,screenCode,module,sort]) => db.prepare(`
      INSERT INTO permissions(code,name,description,screen_code,module,sort) VALUES (?,?,?,?,?,?)
      ON CONFLICT(code) DO UPDATE SET
        name=excluded.name, description=excluded.description,
        screen_code=excluded.screen_code, module=excluded.module, sort=excluded.sort
    `).bind(code,name,description,screenCode,module,sort)),
    ...SCREENS.map(([code,name,description,route,active,icon,sort,nav]) => db.prepare(`
      INSERT INTO screens(code,name,description,route,active,icon,sort,nav) VALUES (?,?,?,?,?,?,?,?)
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
  coreTitle:"NÚCLEO / ASCENTY — FLUXO PRINCIPAL",
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

async function createSession(env, request, user, authenticationMethod = "password") {
  const db = getDB(env);
  const rawToken = bytesToBase64Url(randomBytes(48));
  const tokenHash = await sha256Base64Url(rawToken);
  const expires = new Date(Date.now() + SESSION_DAYS * 86400000).toISOString();

  await db.prepare(`
    INSERT INTO sessions(token_hash, user_id, expires_at, ip, user_agent)
    VALUES (?, ?, ?, ?, ?)
  `).bind(tokenHash, user.id, expires, getClientIP(request), (request.headers.get("User-Agent") || "").slice(0, 512)).run();

  await audit(env, request, user, "LOGIN", "auth", String(user.id), null, {role:user.role}, {method:authenticationMethod});

  return {
    cookie: `${COOKIE_NAME}=${rawToken}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}`,
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

  const session = await createSession(env, request, user);

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

function googleCalendarResultLocation(request, returnTo, key, value) {
  const location = new URL(safeReturnPath(returnTo), request.url);
  location.searchParams.set(key, value);
  return location.toString();
}

function clearGoogleCalendarStateCookie() {
  return `${GOOGLE_CALENDAR_STATE_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

async function handleGoogleCalendarStart(env, request) {
  if (!googleCalendarEnabled(env)) return json({ error: "GOOGLE_CALENDAR_NOT_CONFIGURED" }, 503);
  const user = await getCurrentUser(env, request);
  if (!user) return json({ error: "AUTH_REQUIRED" }, 401);

  const url = new URL(request.url);
  const state = randomBase64Url(32);
  const verifier = randomBase64Url(64);
  const stateHash = await googleSha256Base64Url(state);
  const returnTo = safeReturnPath(url.searchParams.get("return_to"));
  const db = getDB(env);
  await db.batch([
    db.prepare(`DELETE FROM google_calendar_states WHERE expires_at <= CURRENT_TIMESTAMP`),
    db.prepare(`
      INSERT INTO google_calendar_states(state_hash,user_id,code_verifier,return_to,expires_at)
      VALUES (?,?,?,?,datetime('now',?))
    `).bind(stateHash, user.id, verifier, returnTo, `+${GOOGLE_CALENDAR_STATE_MINUTES} minutes`)
  ]);
  const location = await buildGoogleCalendarAuthorizationUrl(
    env,
    googleCalendarRedirectUri(env, request),
    state,
    verifier
  );
  return new Response(null, {
    status: 302,
    headers: securityHeaders({
      Location: location,
      "Cache-Control": "no-store",
      "Set-Cookie": `${GOOGLE_CALENDAR_STATE_COOKIE}=${state}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${GOOGLE_CALENDAR_STATE_MINUTES * 60}`
    })
  });
}

async function handleGoogleCalendarCallback(env, request) {
  const user = await getCurrentUser(env, request);
  if (!user) return new Response(null, {
    status: 303,
    headers: securityHeaders({ Location: "/login.html", "Set-Cookie": clearGoogleCalendarStateCookie() })
  });

  const url = new URL(request.url);
  const state = url.searchParams.get("state") || "";
  const cookieState = parseCookies(request)[GOOGLE_CALENDAR_STATE_COOKIE] || "";
  if (!state || !cookieState || !(await constantTimeEqual(state, cookieState))) {
    return new Response(null, {
      status: 303,
      headers: securityHeaders({
        Location: googleCalendarResultLocation(request, "/", "calendar_error", "invalid_state"),
        "Set-Cookie": clearGoogleCalendarStateCookie()
      })
    });
  }

  const db = getDB(env);
  const stateHash = await googleSha256Base64Url(state);
  const saved = await db.prepare(`
    DELETE FROM google_calendar_states
    WHERE state_hash=? AND user_id=? AND expires_at>CURRENT_TIMESTAMP
    RETURNING code_verifier,return_to
  `).bind(stateHash, user.id).first();
  if (!saved || url.searchParams.get("error")) {
    const code = saved ? "provider_denied" : "expired_state";
    return new Response(null, {
      status: 303,
      headers: securityHeaders({
        Location: googleCalendarResultLocation(request, saved?.return_to || "/", "calendar_error", code),
        "Set-Cookie": clearGoogleCalendarStateCookie()
      })
    });
  }

  const code = url.searchParams.get("code") || "";
  if (!code || code.length > 4096) {
    return new Response(null, {
      status: 303,
      headers: securityHeaders({
        Location: googleCalendarResultLocation(request, saved.return_to, "calendar_error", "invalid_code"),
        "Set-Cookie": clearGoogleCalendarStateCookie()
      })
    });
  }

  try {
    const tokens = await exchangeGoogleCalendarCode(
      env,
      code,
      googleCalendarRedirectUri(env, request),
      saved.code_verifier
    );
    if (!tokens.refresh_token) throw new Error("GOOGLE_REFRESH_TOKEN_MISSING");
    const [profile, calendars] = await Promise.all([
      fetchGoogleProfile(tokens.access_token),
      fetchGoogleCalendars(tokens.access_token)
    ]);
    const selected = calendars.filter(calendar => calendar.primary || calendar.selected).map(calendar => calendar.id);
    const encrypted = await encryptGoogleRefreshToken(env, user.id, tokens.refresh_token);
    await db.prepare(`
      INSERT INTO google_calendar_connections
        (user_id,google_account_id,google_email,refresh_token_ciphertext,calendars_json,active,connected_at,updated_at,last_sync_at,last_error)
      VALUES (?,?,?,?,?,1,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,NULL)
      ON CONFLICT(user_id) DO UPDATE SET
        google_account_id=excluded.google_account_id,
        google_email=excluded.google_email,
        refresh_token_ciphertext=excluded.refresh_token_ciphertext,
        calendars_json=excluded.calendars_json,
        active=1,
        updated_at=CURRENT_TIMESTAMP,
        last_sync_at=CURRENT_TIMESTAMP,
        last_error=NULL
    `).bind(user.id, profile.id || null, profile.email, encrypted, JSON.stringify(selected)).run();
    await audit(env, request, user, "GOOGLE_CALENDAR_CONNECTED", "google_calendar", String(user.id), null, null, {
      email: profile.email,
      calendars: selected.length
    });
    return new Response(null, {
      status: 303,
      headers: securityHeaders({
        Location: googleCalendarResultLocation(request, saved.return_to, "calendar", "connected"),
        "Cache-Control": "no-store",
        "Set-Cookie": clearGoogleCalendarStateCookie()
      })
    });
  } catch (error) {
    console.error(JSON.stringify({
      message: "Google Calendar callback failed",
      userId: user.id,
      error: error instanceof Error ? error.message : String(error)
    }));
    return new Response(null, {
      status: 303,
      headers: securityHeaders({
        Location: googleCalendarResultLocation(request, saved.return_to, "calendar_error", "connection_failed"),
        "Cache-Control": "no-store",
        "Set-Cookie": clearGoogleCalendarStateCookie()
      })
    });
  }
}

function selectedCalendarIds(row) {
  try {
    const parsed = JSON.parse(row?.calendars_json || "[]");
    return Array.isArray(parsed) ? [...new Set(parsed.map(String).filter(Boolean))].slice(0, 50) : [];
  } catch { return []; }
}

async function googleCalendarAccess(env, row) {
  const refreshToken = await decryptGoogleRefreshToken(env, row.user_id, row.refresh_token_ciphertext);
  return refreshGoogleAccessToken(env, refreshToken);
}

async function calendarConnection(env, userId) {
  return getDB(env).prepare(`
    SELECT user_id,google_account_id,google_email,refresh_token_ciphertext,calendars_json,
           alert_minutes,active,connected_at,updated_at,last_sync_at,last_error
    FROM google_calendar_connections WHERE user_id=? AND active=1
  `).bind(userId).first();
}

async function handleGoogleCalendarStatus(env, request) {
  const user = await getCurrentUser(env, request);
  if (!user) return json({ error: "AUTH_REQUIRED" }, 401);
  const configured = googleCalendarEnabled(env) && String(env.GOOGLE_CALENDAR_TOKEN_KEY || "").trim().length >= 32;
  if (!configured) return json({ configured: false, connected: false });
  const row = await calendarConnection(env, user.id);
  if (!row) return json({ configured: true, connected: false });

  try {
    const tokens = await googleCalendarAccess(env, row);
    const calendars = await fetchGoogleCalendars(tokens.access_token);
    const selected = new Set(selectedCalendarIds(row));
    return json({
      configured: true,
      connected: true,
      email: row.google_email,
      alert_minutes: Number(row.alert_minutes),
      calendars: calendars.map(calendar => ({ ...calendar, enabled: selected.has(calendar.id) })),
      last_sync_at: row.last_sync_at,
      needs_reconnect: false
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await getDB(env).prepare(`UPDATE google_calendar_connections SET last_error=?,updated_at=CURRENT_TIMESTAMP WHERE user_id=?`)
      .bind(message.slice(0, 500), user.id).run();
    return json({
      configured: true,
      connected: true,
      email: row.google_email,
      alert_minutes: Number(row.alert_minutes),
      calendars: [],
      needs_reconnect: true
    });
  }
}

async function handleGoogleCalendarSettings(env, request) {
  const user = await getCurrentUser(env, request);
  if (!user) return json({ error: "AUTH_REQUIRED" }, 401);
  const row = await calendarConnection(env, user.id);
  if (!row) return json({ error: "GOOGLE_CALENDAR_NOT_CONNECTED" }, 409);
  let body;
  try { body = await readJson(request, 32768); }
  catch { return json({ error: "INVALID_JSON" }, 400); }
  const alertMinutes = Number(body.alert_minutes);
  const requested = Array.isArray(body.calendars) ? [...new Set(body.calendars.map(String).filter(Boolean))] : null;
  if (!Number.isInteger(alertMinutes) || alertMinutes < 0 || alertMinutes > 1440) {
    return json({ error: "GOOGLE_CALENDAR_ALERT_MINUTES_INVALID" }, 400);
  }
  if (!requested || !requested.length || requested.length > 50) {
    return json({ error: "GOOGLE_CALENDAR_SELECTION_INVALID" }, 400);
  }

  try {
    const tokens = await googleCalendarAccess(env, row);
    const available = new Set((await fetchGoogleCalendars(tokens.access_token)).map(calendar => calendar.id));
    if (requested.some(id => !available.has(id))) return json({ error: "GOOGLE_CALENDAR_SELECTION_INVALID" }, 400);
    const before = { calendars: selectedCalendarIds(row), alert_minutes: Number(row.alert_minutes) };
    const after = { calendars: requested, alert_minutes: alertMinutes };
    await getDB(env).prepare(`
      UPDATE google_calendar_connections
      SET calendars_json=?,alert_minutes=?,updated_at=CURRENT_TIMESTAMP,last_error=NULL WHERE user_id=?
    `).bind(JSON.stringify(requested), alertMinutes, user.id).run();
    await audit(env, request, user, "GOOGLE_CALENDAR_SETTINGS_UPDATED", "google_calendar", String(user.id), before, after);
    return json({ ok: true, ...after });
  } catch (error) {
    console.error(JSON.stringify({ message: "Google Calendar settings failed", userId: user.id, error: error instanceof Error ? error.message : String(error) }));
    return json({ error: "GOOGLE_CALENDAR_RECONNECT_REQUIRED" }, 502);
  }
}

async function handleGoogleCalendarDisconnect(env, request) {
  const user = await getCurrentUser(env, request);
  if (!user) return json({ error: "AUTH_REQUIRED" }, 401);
  const row = await calendarConnection(env, user.id);
  if (row) {
    await getDB(env).prepare(`DELETE FROM google_calendar_connections WHERE user_id=?`).bind(user.id).run();
    await audit(env, request, user, "GOOGLE_CALENDAR_DISCONNECTED", "google_calendar", String(user.id), {
      email: row.google_email
    }, null);
  }
  return json({ ok: true });
}

async function handleGoogleCalendarEvents(env, request) {
  const user = await getCurrentUser(env, request);
  if (!user) return json({ error: "AUTH_REQUIRED" }, 401);
  const row = await calendarConnection(env, user.id);
  if (!row) return json({ connected: false, events: [] });
  const calendarIds = selectedCalendarIds(row);
  if (!calendarIds.length) return json({ connected: true, alert_minutes: Number(row.alert_minutes), events: [] });

  const now = Date.now();
  const timeMin = new Date(now - 5 * 60_000).toISOString();
  const timeMax = new Date(now + 24 * 60 * 60_000).toISOString();
  try {
    const tokens = await googleCalendarAccess(env, row);
    const events = await fetchGoogleEvents(tokens.access_token, calendarIds, { timeMin, timeMax });
    await getDB(env).prepare(`
      UPDATE google_calendar_connections SET last_sync_at=CURRENT_TIMESTAMP,last_error=NULL WHERE user_id=?
    `).bind(user.id).run();
    return json({ connected: true, alert_minutes: Number(row.alert_minutes), events });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await getDB(env).prepare(`UPDATE google_calendar_connections SET last_error=? WHERE user_id=?`)
      .bind(message.slice(0, 500), user.id).run();
    console.error(JSON.stringify({ message: "Google Calendar events failed", userId: user.id, error: message }));
    return json({ error: "GOOGLE_CALENDAR_RECONNECT_REQUIRED" }, 502);
  }
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
      error: 'Binding D1 "bd" não encontrado.'
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



function safeUserRow(u) {
  if (!u) return null;
  return {
    id:u.id, username:u.username, display_name:u.display_name, email:u.email || null,
    oauth_linked:Boolean(u.oauth_subject),
    role:u.role, active:!!u.active, must_change_password:!!u.must_change_password,
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
    SELECT s.code,s.name,s.description,s.route,s.icon,s.sort,s.nav
    FROM role_screens rs JOIN screens s ON s.id=rs.screen_id
    WHERE rs.role_id=? AND s.active=1 ORDER BY s.sort,s.id
  `).bind(user.role_id).all()).results;
  // Catálogo completo: o guardião de rotas precisa saber quais endereços são
  // telas do sistema para diferenciar "não existe" de "não é para você".
  const allScreens=(await db.prepare(`
    SELECT code,name,route,active FROM screens ORDER BY sort,id
  `).all()).results;
  return json({role:user.role,permissions,screens,allScreens});
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
    SELECT id,code,name,description,route,active,icon,sort,nav FROM screens ORDER BY sort,id
  `).all()).results;
  const rolePermissions=(await db.prepare(`SELECT role_id,permission_id FROM role_permissions`).all()).results;
  const roleScreens=(await db.prepare(`SELECT role_id,screen_id FROM role_screens`).all()).results;
  const permissoes=await permissionsOf(env,gate.user);
  return json({
    roles,permissions,screens,rolePermissions,roleScreens,
    protectedRole:PERFIL_PROTEGIDO,
    can:{
      manageRoles:permissoes.has("roles.manage"),
      manageScreens:permissoes.has("screens.manage"),
      viewUsers:permissoes.has("users.view"),
      manageUsers:permissoes.has("users.manage"),
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
  if(!/^[a-z0-9._-]{3,50}$/.test(username))return json({error:"USUARIO_INVALIDO"},400);
  if(email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))return json({error:"EMAIL_INVALIDO"},400);
  if(email && await db.prepare(`SELECT 1 FROM users WHERE lower(email)=? LIMIT 1`).bind(email).first())
    return json({error:"EMAIL_JA_CADASTRADO"},409);
  if(password.length<8)return json({error:"SENHA_DEVE_TER_8_CARACTERES"},400);
  const rr=await db.prepare(`SELECT id,name FROM roles WHERE name=?`).bind(role).first();
  if(!rr)return json({error:"ROLE_INVALIDA"},400);
  try{
    const result=await db.prepare(`
      INSERT INTO users(username,display_name,email,password_hash,role_id,active,must_change_password)
      VALUES(?,?,?,?,?,1,1)
    `).bind(username,displayName,email||null,await hashPassword(password),rr.id).run();
    const after=await db.prepare(`
      SELECT u.id,u.username,u.display_name,u.email,u.oauth_subject,u.active,u.must_change_password,r.name role
      FROM users u JOIN roles r ON r.id=u.role_id WHERE u.id=?
    `).bind(result.meta.last_row_id).first();
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
  let passwordHash=null;
  if(hasPassword){
    if(!(await hasPermission(env,gate.user,"users.password")))
      return json({error:"FORBIDDEN",permission:"users.password"},403);
    if(String(b.password).length<8)return json({error:"SENHA_DEVE_TER_8_CARACTERES"},400);
    passwordHash=await hashPassword(String(b.password));
  }
  if(!hasDisplay&&!hasEmail&&!hasActive&&!hasRole&&!hasPassword)return json(safeUserRow(before));
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
  if(hasPassword) await db.prepare(`DELETE FROM sessions WHERE user_id=?`).bind(id).run();
  const after=await db.prepare(`
    SELECT u.id,u.username,u.display_name,u.email,u.oauth_subject,u.active,u.must_change_password,r.name role
    FROM users u JOIN roles r ON r.id=u.role_id WHERE u.id=?
  `).bind(id).first();
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

        if (url.pathname === "/api/calendar/google/start" && request.method === "GET")
          return await handleGoogleCalendarStart(env, request);

        if (url.pathname === "/api/calendar/google/callback" && request.method === "GET")
          return await handleGoogleCalendarCallback(env, request);

        if (url.pathname === "/api/calendar/status" && request.method === "GET")
          return await handleGoogleCalendarStatus(env, request);

        if (url.pathname === "/api/calendar/settings" && request.method === "PUT")
          return await handleGoogleCalendarSettings(env, request);

        if (url.pathname === "/api/calendar/google" && request.method === "DELETE")
          return await handleGoogleCalendarDisconnect(env, request);

        if (url.pathname === "/api/calendar/events" && request.method === "GET")
          return await handleGoogleCalendarEvents(env, request);

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
            SELECT id,code,name,description,route,active,icon,sort,nav FROM screens ORDER BY sort,id
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
