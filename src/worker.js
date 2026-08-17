import {
  zabbixCall,
  fetchNetworkInventory,
  persistInventory
} from "./zabbix.js";
import { deriveLinks, capacityLabel, linkKind } from "./zabbix-links.js";
import { applyZabbixToTopology } from "./zabbix-topology.js";

const COOKIE_NAME = "topologia_noc_session";
const SESSION_DAYS = 7;
const PBKDF2_ITERATIONS = 100000;

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

CREATE INDEX IF NOT EXISTS idx_audit_created_at ON audit_logs(created_at);
CREATE INDEX IF NOT EXISTS idx_audit_user_id ON audit_logs(user_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_sessions_token_hash ON sessions(token_hash);
CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_role_screens_role ON role_screens(role_id);
CREATE INDEX IF NOT EXISTS idx_zbx_if_hostid ON zabbix_interfaces(hostid);
CREATE INDEX IF NOT EXISTS idx_zbx_if_alias ON zabbix_interfaces(if_alias);
CREATE INDEX IF NOT EXISTS idx_zbx_if_oper ON zabbix_interfaces(oper_status);
CREATE INDEX IF NOT EXISTS idx_zbx_hosts_equip ON zabbix_hosts(equipamento_id);
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
  ["pops", "POPs e anel óptico", "Inventário por POP, rotas ópticas e sequência do anel", "/pops.html", 1, "pops", 20, 1],
  ["dashboard", "Dashboard NOC", "Painel operacional para TV/NOC", "/dashboard.html", 1, "dashboard", 30, 1],
  ["trafego", "Tráfego", "Monitoramento de tráfego, utilização e erros por interface", "/trafego.html", 1, "trafego", 35, 1],
  ["platform", "Gerenciar plataforma", "Perfis, ações, telas, usuários e auditoria", "/platform.html", 1, "platform", 40, 1],
  ["legado", "Editor clássico", "Editor legado da topologia em tela única", "/legado.html", 1, "edit", 50, 1]
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

  ["zabbix.view", "Consultar o Zabbix", "Ver hosts, interfaces e status da sincronização", "network", "Monitoramento (Zabbix)", 10],
  ["zabbix.sync", "Sincronizar o Zabbix", "Disparar a importação de hosts e interfaces", "network", "Monitoramento (Zabbix)", 20],
  ["zabbix.link", "Vincular host do Zabbix", "Associar host monitorado a um equipamento", "network", "Monitoramento (Zabbix)", 30],

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

const TOPOLOGY_ACTIONS = ALL_ACTION_CODES.filter(c => c.startsWith("topology.") || c.startsWith("pops.") || c.startsWith("zabbix."));

const ROLE_PERMISSIONS = {
  administrador: ALL_ACTION_CODES,
  gerente: [
    ...TOPOLOGY_ACTIONS,
    "roles.view","users.view","users.manage","users.password","audit.view","audit.export","settings.manage"
  ],
  analista: [
    "topology.view","topology.edit","topology.delete","topology.equipment.create","topology.equipment.edit",
    "topology.equipment.delete","topology.port.edit","topology.link.create","topology.link.delete",
    "topology.pop.link","topology.layout","zabbix.view","zabbix.sync",
    "pops.create","pops.edit","pops.delete","pops.order","pops.routes","pops.ring.layout",
    "audit.view"
  ],
  atendimento: ["topology.view","zabbix.view"],
  tecnico: [
    "topology.view","topology.edit","topology.equipment.create","topology.equipment.edit","topology.port.edit",
    "topology.link.create","topology.pop.link","topology.layout",
    "zabbix.view","zabbix.sync","zabbix.link",
    "pops.edit","pops.order","pops.routes","pops.ring.layout"
  ],
  logistica: [
    "topology.view","topology.edit","topology.equipment.create","topology.equipment.edit","topology.port.edit",
    "topology.pop.link","zabbix.view","pops.create","pops.edit","pops.order"
  ]
};

const ROLE_SCREENS = {
  administrador: ALL_SCREEN_CODES,
  gerente: ["network","pops","dashboard","trafego","platform","legado"],
  analista: ["network","pops","dashboard","trafego","legado"],
  atendimento: ["network","pops","dashboard","trafego"],
  tecnico: ["network","pops","dashboard","trafego","legado"],
  logistica: ["network","pops","dashboard"]
};

/* Perfis criados fora do catálogo (ou instalações antigas) recebem as ações
   novas a partir do que já tinham. Roda uma única vez, controlado por
   platform_meta: depois disso, quem manda é o que o administrador marcou. */
const ACTION_EQUIVALENCE = [
  ["topology.view", ["zabbix.view"]],
  ["topology.edit", [
    "topology.equipment.create","topology.equipment.edit","topology.port.edit","topology.link.create",
    "topology.pop.link","topology.layout","topology.config","zabbix.sync","zabbix.link",
    "pops.create","pops.edit","pops.order","pops.routes","pops.ring.layout"
  ]],
  ["topology.delete", ["topology.equipment.delete","topology.link.delete","pops.delete"]],
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
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return result === 0;
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

    return timingSafeEqual(actual, expected);
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
  return request.headers.get("CF-Connecting-IP")
    || request.headers.get("X-Forwarded-For")
    || "unknown";
}

async function audit(env, request, user, action, resourceType, resourceId = null, before = null, after = null, details = null) {
  const db = getDB(env);
  if (!db) return;

  // Compatibilidade com schemas antigos do D1:
  // versões anteriores deste projeto usavam `resource` enquanto
  // a versão atual usa `resource_type`. O banco existente não é apagado.
  const columns = (await db.prepare(`PRAGMA table_info(audit_logs)`).all()).results || [];
  const names = new Set(columns.map(c => c.name));

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
  add("before_json", before == null ? null : JSON.stringify(before));
  add("after_json", after == null ? null : JSON.stringify(after));
  add("details_json", details == null ? null : JSON.stringify(details));

  // Compatibilidade com bancos que ainda usam occurred_at.
  if (names.has("occurred_at") && !names.has("created_at")) {
    add("occurred_at", new Date().toISOString());
  }

  const placeholders = fields.map(() => "?").join(", ");
  await db.prepare(`
    INSERT INTO audit_logs (${fields.join(", ")})
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
  const info = (await db.prepare(`PRAGMA table_info(${table})`).all()).results || [];
  const existentes = new Set(info.map(c => c.name));
  for (const [name, ddl] of columns) {
    if (existentes.has(name)) continue;
    await db.prepare(`ALTER TABLE ${table} ADD COLUMN ${name} ${ddl}`).run();
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

let databaseReadyPromise = null;

async function ensureDatabase(env) {
  if (databaseReadyPromise) return databaseReadyPromise;

  databaseReadyPromise = ensureDatabaseImpl(env).catch((error) => {
    // Permite uma nova tentativa se uma migração/inicialização falhar.
    databaseReadyPromise = null;
    throw error;
  });

  return databaseReadyPromise;
}

async function ensureDatabaseImpl(env) {
  const db = getDB(env);
  if (!db) throw new Error('Binding D1 "bd" não encontrado.');

  const schemaStatements = SCHEMA.split(/;\s*(?=CREATE TABLE|CREATE INDEX)/)
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

  for (const [name, description] of ROLES) {
    await db.prepare(`
      INSERT INTO roles(name,description) VALUES (?,?)
      ON CONFLICT(name) DO NOTHING
    `).bind(name,description).run();
  }

  // O catálogo (rótulo, descrição, módulo, rota, ícone) é do código.
  // O que o administrador decide — quem acessa o quê e qual tela está ativa —
  // fica no banco e nunca é sobrescrito por um deploy.
  for (const [code,name,description,screenCode,module,sort] of ACTIONS) {
    await db.prepare(`
      INSERT INTO permissions(code,name,description,screen_code,module,sort) VALUES (?,?,?,?,?,?)
      ON CONFLICT(code) DO UPDATE SET
        name=excluded.name, description=excluded.description,
        screen_code=excluded.screen_code, module=excluded.module, sort=excluded.sort
    `).bind(code,name,description,screenCode,module,sort).run();
  }

  for (const [code,name,description,route,active,icon,sort,nav] of SCREENS) {
    await db.prepare(`
      INSERT INTO screens(code,name,description,route,active,icon,sort,nav) VALUES (?,?,?,?,?,?,?,?)
      ON CONFLICT(code) DO UPDATE SET
        name=excluded.name, description=excluded.description, route=excluded.route,
        icon=excluded.icon, sort=excluded.sort, nav=excluded.nav
    `).bind(code,name,description,route,active,icon,sort,nav).run();
  }

  const idsOf = async (table, key) => Object.fromEntries(
    ((await db.prepare(`SELECT id,${key} FROM ${table}`).all()).results || []).map(x => [x[key], x.id])
  );
  const roleMap = await idsOf("roles","name");
  const permMap = await idsOf("permissions","code");
  const screenMap = await idsOf("screens","code");

  const grantPermission = (roleId, code) => permMap[code]
    ? db.prepare(`INSERT OR IGNORE INTO role_permissions(role_id,permission_id) VALUES (?,?)`).bind(roleId,permMap[code]).run()
    : null;
  const grantScreen = (roleId, code) => screenMap[code]
    ? db.prepare(`INSERT OR IGNORE INTO role_screens(role_id,screen_id) VALUES (?,?)`).bind(roleId,screenMap[code]).run()
    : null;

  // Acessos padrão dos perfis do catálogo: aplicados uma única vez.
  await seedOnce(db, "seed.role_access.v2", async () => {
    for (const [role,codes] of Object.entries(ROLE_PERMISSIONS)) {
      if (!roleMap[role]) continue;
      for (const code of codes) await grantPermission(roleMap[role], code);
    }
    for (const [role,codes] of Object.entries(ROLE_SCREENS)) {
      if (!roleMap[role]) continue;
      for (const code of codes) await grantScreen(roleMap[role], code);
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
        for (const code of derivadas) await grantPermission(role.id, code);
      }
    }
  });

  // As telas novas (POPs e editor clássico) entram para quem já tinha a
  // topologia — o menu do perfil continua com as mesmas telas de antes.
  await seedOnce(db, "seed.new_screens.v2", async () => {
    const comRede = ((await db.prepare(`
      SELECT rs.role_id FROM role_screens rs JOIN screens s ON s.id=rs.screen_id WHERE s.code='network'
    `).all()).results || []).map(x => x.role_id);
    for (const roleId of comRede) {
      await grantScreen(roleId, "pops");
      await grantScreen(roleId, "legado");
    }
  });

  // O administrador nunca fica sem acesso: é a garantia de reabrir o sistema.
  if (roleMap.administrador) {
    for (const code of ALL_ACTION_CODES) await grantPermission(roleMap.administrador, code);
    for (const code of ALL_SCREEN_CODES) await grantScreen(roleMap.administrador, code);
  }

  const adminRole = await db.prepare(`SELECT id FROM roles WHERE name='administrador'`).first();
  const admin = await db.prepare(`SELECT id FROM users WHERE username='admin'`).first();
  if (!admin) {
    await db.prepare(`
      INSERT INTO users(username,display_name,password_hash,role_id,active,must_change_password)
      VALUES (?,?,?,?,1,1)
    `).bind("admin","Administrador",await hashPassword("admin"),adminRole.id).run();
  } else {
    await db.prepare(`
      UPDATE users SET role_id=?,active=1,updated_at=CURRENT_TIMESTAMP WHERE username='admin'
    `).bind(adminRole.id).run();
  }
}

const DEFAULT_TOPOLOGY_CONFIG = {
  subtitle:"Topologia de Rede • Ascenty / BGP / MPLS",
  coreTitle:"NÚCLEO / ASCENTY — FLUXO PRINCIPAL",
  ringTitle:"ANEL ÓPTICO DOS POPs",
  ringLabel:"ANEL — ROTAS AÉREAS E SUBTERRÂNEAS",
  popSectionTitle:"EQUIPAMENTOS POR POP"
};

async function loadInitialTopology(env, request) {
  const read = async (name) => {
    const url = new URL(request.url);
    url.pathname = `/data/${name}`;
    const r = await env.ASSETS.fetch(new Request(url.toString(), {method:"GET"}));
    if (!r.ok) throw new Error(`Não foi possível carregar /data/${name}`);
    return r.json();
  };
  return {
    equipamentos: await read("equipamentos.json"),
    conexoes: await read("conexoes.json"),
    pops: await read("pops.json"),
    config: {...DEFAULT_TOPOLOGY_CONFIG}
  };
}

async function ensureTopologyState(env, request) {
  const db = getDB(env);
  const row = await db.prepare(`SELECT * FROM topology_state WHERE id=1`).first();
  if (row) return row;
  const initial = await loadInitialTopology(env, request);
  await db.prepare(`
    INSERT INTO topology_state(id,data_json,version,updated_at,updated_by)
    VALUES (1,?,1,CURRENT_TIMESTAMP,NULL)
  `).bind(JSON.stringify(initial)).run();
  return await db.prepare(`SELECT * FROM topology_state WHERE id=1`).first();
}

async function createSession(env, request, user) {
  const db = getDB(env);
  const rawToken = bytesToBase64Url(randomBytes(48));
  const tokenHash = await sha256Base64Url(rawToken);
  const expires = new Date(Date.now() + SESSION_DAYS * 86400000).toISOString();

  await db.prepare(`
    INSERT INTO sessions(token_hash, user_id, expires_at)
    VALUES (?, ?, ?)
  `).bind(tokenHash, user.id, expires).run();

  await audit(env, request, user, "LOGIN", "auth", String(user.id), null, {role:user.role}, null);

  return {
    cookie: `${COOKIE_NAME}=${rawToken}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}`,
    tokenHash
  };
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
    body = await request.json();
  } catch {
    return json({ ok: false, error: "JSON inválido." }, 400);
  }

  const username = String(body.username || "").trim();
  const password = String(body.password || "");

  if (!username || !password) {
    return json({ ok: false, error: "Informe usuário e senha." }, 400);
  }

  const db = getDB(env);

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
    if (user) {
      await audit(env, request, user, "LOGIN_FAILED", "auth", String(user.id), null, null, {reason:"invalid_credentials"});
    }
    return json({ ok: false, error: "Usuário ou senha inválidos." }, 401);
  }

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
    database: "D1",
    binding: env.bd ? "bd" : "DB"
  });
}


function grafanaHeaders(env) {
  const headers = {
    "Accept": "application/json",
    "Content-Type": "application/json"
  };

  if (env.GRAFANA_TOKEN) {
    headers.Authorization = `Bearer ${env.GRAFANA_TOKEN}`;
  }

  return headers;
}

function grafanaBase(env) {
  return String(env.GRAFANA_URL || "").replace(/\/+$/, "");
}

async function grafanaRequest(env, path, init = {}) {
  const base = grafanaBase(env);
  if (!base) throw new Error("GRAFANA_URL não configurada.");
  const url = `${base}${path}`;

  const response = await fetch(url, {
    ...init,
    headers: {
      ...grafanaHeaders(env),
      ...(init.headers || {})
    }
  });

  const text = await response.text();
  let body;
  try { body = text ? JSON.parse(text) : null; }
  catch { body = { raw: text }; }

  return { response, body };
}

async function handleGrafana(request, env, url) {
  // GET /api/grafana/health
  if (request.method === "GET" && url.pathname === "/api/grafana/health") {
    try {
      const result = await grafanaRequest(env, "/api/health");
      return json({
        ok: result.response.ok,
        grafanaStatus: result.response.status,
        data: result.body
      }, result.response.ok ? 200 : 502);
    } catch (error) {
      return json({
        ok: false,
        error: error.message,
        hint: "Configure GRAFANA_URL e GRAFANA_TOKEN nos Secrets/Variables do Worker."
      }, 500);
    }
  }

  // POST /api/grafana/query
  // Proxy genérico para a API moderna de consulta do Grafana.
  // O frontend envia somente a consulta; a credencial fica no Worker.
  if (request.method === "POST" && url.pathname === "/api/grafana/query") {
    try {
      const payload = await request.json();
      const result = await grafanaRequest(env, "/api/ds/query", {
        method: "POST",
        body: JSON.stringify(payload)
      });

      return json(result.body, result.response.status);
    } catch (error) {
      return json({ ok: false, error: error.message }, 400);
    }
  }

  // GET /api/grafana/dashboard/:uid
  if (request.method === "GET" && url.pathname.startsWith("/api/grafana/dashboard/")) {
    const uid = url.pathname.split("/").filter(Boolean).pop();
    if (!uid) return json({ error: "UID do dashboard não informado." }, 400);

    try {
      const result = await grafanaRequest(
        env,
        `/api/dashboards/uid/${encodeURIComponent(uid)}`
      );
      return json(result.body, result.response.status);
    } catch (error) {
      return json({ ok: false, error: error.message }, 500);
    }
  }

  return json({ error: "Endpoint Grafana não encontrado." }, 404);
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

// POST /api/zabbix/sync — importa hosts e interfaces do Zabbix para o D1.
async function handleZabbixSync(env, request) {
  const gate = await requirePermission(env, request, "zabbix.sync");
  if (gate.response) return gate.response;

  const db = getDB(env);
  const run = await db.prepare(`
    INSERT INTO zabbix_sync_runs (triggered_by, source) VALUES (?, 'api')
  `).bind(gate.user.id).run();
  const runId = run.meta.last_row_id;

  try {
    const inventory = await fetchNetworkInventory(env);
    const counts = await persistInventory(db, inventory);

    await db.prepare(`
      UPDATE zabbix_sync_runs
      SET finished_at=CURRENT_TIMESTAMP, ok=1, hosts_count=?, interfaces_count=?
      WHERE id=?
    `).bind(counts.hosts, counts.interfaces, runId).run();

    await audit(env, request, gate.user, "ZABBIX_SYNC", "zabbix", String(runId), null, counts);

    return json({ ok: true, run_id: runId, ...counts });
  } catch (error) {
    await db.prepare(`
      UPDATE zabbix_sync_runs SET finished_at=CURRENT_TIMESTAMP, ok=0, error=? WHERE id=?
    `).bind(String(error.message), runId).run();

    return json({ ok: false, run_id: runId, error: error.message }, 502);
  }
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
  try { body = await request.json(); } catch {}

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
  const limit = Math.min(Number(url.searchParams.get("limit") || 1000), 5000);

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

// GET /api/zabbix/links — enlaces físicos derivados das descrições de interface.
async function handleZabbixLinks(env, request) {
  const gate = await requirePermission(env, request, "zabbix.view");
  if (gate.response) return gate.response;

  const inventory = await loadInventoryFromDb(getDB(env));
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
      oper_status: l.a.oper_status, in_bps: l.a.in_bps, out_bps: l.a.out_bps
    },
    b: {
      hostid: String(l.b.hostid), host: nameOf.get(String(l.b.hostid)),
      equipamento_id: equipOf.get(String(l.b.hostid)) || null,
      interface: l.b.if_name, descricao: l.b.if_alias,
      oper_status: l.b.oper_status, in_bps: l.b.in_bps, out_bps: l.b.out_bps
    }
  }));

  return json({
    total: links.length,
    alta: links.filter(l => l.confianca === "alta").length,
    media: links.filter(l => l.confianca === "media").length,
    links
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
  try { body = await request.json(); } catch {}
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

  return json({ error: "Endpoint Zabbix não encontrado." }, 404);
}



function safeUserRow(u) {
  if (!u) return null;
  return {
    id:u.id, username:u.username, display_name:u.display_name,
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
  const db=getDB(env); let body={}; try{body=await request.json()}catch{}
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
  let body={};try{body=await request.json()}catch{}

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
  let body={};try{body=await request.json()}catch{}
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
  let body={};try{body=await request.json()}catch{}
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
    SELECT u.id,u.username,u.display_name,u.active,u.must_change_password,u.created_at,u.updated_at,u.last_login_at,r.name role
    FROM users u JOIN roles r ON r.id=u.role_id ORDER BY u.username
  `).all()).results;
  return json(rows.map(safeUserRow));
}

async function handleUserCreate(env,request) {
  const gate=await requirePermission(env,request,"users.manage"); if(gate.response)return gate.response;
  const db=getDB(env); let b={};try{b=await request.json()}catch{}
  const username=String(b.username||"").trim().toLowerCase();
  const displayName=String(b.display_name||username).trim();
  const password=String(b.password||"");
  const role=String(b.role||"atendimento");
  if(!/^[a-z0-9._-]{3,50}$/.test(username))return json({error:"USUARIO_INVALIDO"},400);
  if(password.length<8)return json({error:"SENHA_DEVE_TER_8_CARACTERES"},400);
  const rr=await db.prepare(`SELECT id,name FROM roles WHERE name=?`).bind(role).first();
  if(!rr)return json({error:"ROLE_INVALIDA"},400);
  try{
    const result=await db.prepare(`
      INSERT INTO users(username,display_name,password_hash,role_id,active,must_change_password)
      VALUES(?,?,?,?,1,1)
    `).bind(username,displayName,await hashPassword(password),rr.id).run();
    const after=await db.prepare(`
      SELECT u.id,u.username,u.display_name,u.active,u.must_change_password,r.name role
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
    SELECT u.id,u.username,u.display_name,u.active,u.must_change_password,r.name role
    FROM users u JOIN roles r ON r.id=u.role_id WHERE u.id=?
  `).bind(id).first();
  if(!before)return json({error:"USUARIO_NAO_ENCONTRADO"},404);
  let b={};try{b=await request.json()}catch{}
  if(id===gate.user.id && b.active===false)return json({error:"NAO_DESATIVE_SEU_PROPRIO_USUARIO"},400);
  const fields=[],values=[];
  if(b.display_name!==undefined){fields.push("display_name=?");values.push(String(b.display_name).trim())}
  if(b.active!==undefined){fields.push("active=?");values.push(b.active?1:0)}
  if(b.role!==undefined){
    const rr=await db.prepare(`SELECT id FROM roles WHERE name=?`).bind(String(b.role)).first();
    if(!rr)return json({error:"ROLE_INVALIDA"},400);
    fields.push("role_id=?");values.push(rr.id);
  }
  if(b.password!==undefined){
    if(!(await hasPermission(env,gate.user,"users.password")))
      return json({error:"FORBIDDEN",permission:"users.password"},403);
    if(String(b.password).length<8)return json({error:"SENHA_DEVE_TER_8_CARACTERES"},400);
    fields.push("password_hash=?","must_change_password=1");values.push(await hashPassword(String(b.password)));
  }
  if(!fields.length)return json(safeUserRow(before));
  fields.push("updated_at=CURRENT_TIMESTAMP");
  await db.prepare(`UPDATE users SET ${fields.join(",")} WHERE id=?`).bind(...values,id).run();
  const after=await db.prepare(`
    SELECT u.id,u.username,u.display_name,u.active,u.must_change_password,r.name role
    FROM users u JOIN roles r ON r.id=u.role_id WHERE u.id=?
  `).bind(id).first();
  await audit(env,request,gate.user,"UPDATE","user",id,safeUserRow(before),safeUserRow(after));
  return json(safeUserRow(after));
}

async function handleAudit(env,request) {
  const gate=await requirePermission(env,request,"audit.view"); if(gate.response)return gate.response;
  const db=getDB(env);
  const url=new URL(request.url);
  const limit=Math.min(Number(url.searchParams.get("limit")||200),1000);
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
    portas:Array.isArray(t?.equipamentos)?t.equipamentos.reduce((n,e)=>n+(Array.isArray(e.portas)?e.portas.length:0),0):0
  };
}
function topologyDiff(before,after){
  const diff={equipamentos:{added:[],removed:[],changed:[]},pops:{added:[],removed:[],changed:[]},conexoes:{added:0,removed:0,changed:0}};
  const byId=a=>Object.fromEntries((Array.isArray(a)?a:[]).filter(x=>x?.id).map(x=>[x.id,x]));
  for(const type of ["equipamentos","pops"]){
    const a=byId(before?.[type]),b=byId(after?.[type]);
    for(const id of Object.keys(b))if(!a[id])diff[type].added.push(id);
    for(const id of Object.keys(a))if(!b[id])diff[type].removed.push(id);
    for(const id of Object.keys(a))if(b[id]&&JSON.stringify(a[id])!==JSON.stringify(b[id]))diff[type].changed.push(id);
  }
  const aa=(before?.conexoes||[]).map(JSON.stringify),bb=(after?.conexoes||[]).map(JSON.stringify);
  diff.conexoes.added=bb.filter(x=>!aa.includes(x)).length;
  diff.conexoes.removed=aa.filter(x=>!bb.includes(x)).length;
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
  const gate=await requirePermission(env,request,method==="GET"?"topology.view":"topology.edit");
  if(gate.response)return gate.response;
  const db=getDB(env);
  const row=await ensureTopologyState(env,request);
  const before=JSON.parse(row.data_json);
  if(method==="GET"){
    return json({...before,version:row.version,updated_at:row.updated_at,updated_by:row.updated_by});
  }
  let body;try{body=await request.json()}catch{return json({error:"JSON_INVALIDO"},400)}
  const incoming=body?.topology??body;
  if(!incoming||!Array.isArray(incoming.equipamentos)||!Array.isArray(incoming.conexoes)||!Array.isArray(incoming.pops))
    return json({error:"TOPOLOGIA_INVALIDA"},400);
  const after={
    equipamentos:incoming.equipamentos,
    conexoes:incoming.conexoes,
    pops:incoming.pops,
    config:{...DEFAULT_TOPOLOGY_CONFIG,...(incoming.config||{})}
  };
  const diff=topologyDiff(before,after);
  const permissoes=await permissionsOf(env,gate.user);

  const hasDeletion=diff.equipamentos.removed.length||diff.pops.removed.length||diff.conexoes.removed;
  if(hasDeletion && !permissoes.has("topology.delete")){
    await audit(env,request,gate.user,"TOPOLOGY_UPDATE_DENIED","topology","1",before,after,{reason:"missing topology.delete",diff});
    return json({error:"FORBIDDEN",permission:"topology.delete"},403);
  }

  /* Cada funcionalidade tem a sua ação. O que vale é o que mudou de fato
     entre o estado anterior e o enviado — nunca um rótulo vindo do cliente. */
  const exigidas=requiredTopologyActions(before,after);
  const faltando=[...exigidas].filter(code=>!permissoes.has(code));
  if(faltando.length){
    await audit(env,request,gate.user,"TOPOLOGY_UPDATE_DENIED","topology","1",before,after,{reason:"missing actions",missing:faltando,diff});
    return json({error:"FORBIDDEN",permission:faltando[0],permissions:faltando},403);
  }
  const nextVersion=Number(row.version||0)+1;
  await db.prepare(`
    UPDATE topology_state SET data_json=?,version=?,updated_at=CURRENT_TIMESTAMP,updated_by=? WHERE id=1
  `).bind(JSON.stringify(after),nextVersion,gate.user.id).run();
  await audit(env,request,gate.user,"TOPOLOGY_UPDATE","topology","1",before,after,{
    version_before:row.version,version_after:nextVersion,diff,
    before_summary:topologySummary(before),after_summary:topologySummary(after)
  });
  return json({ok:true,version:nextVersion,updated_at:new Date().toISOString(),topology:after,diff});
}

async function handleTopologyPermissions(env,request){
  const user=await getCurrentUser(env,request);
  if(!user)return json({error:"AUTH_REQUIRED"},401);
  const permissions=(await getDB(env).prepare(`
    SELECT p.code FROM role_permissions rp JOIN permissions p ON p.id=rp.permission_id WHERE rp.role_id=?
  `).bind(user.role_id).all()).results.map(x=>x.code);
  return json({permissions});
}

export default {
  async fetch(request, env, ctx) {
    try {
      const url = new URL(request.url);

      if (url.pathname === "/api/health" && request.method === "GET") {
        await ensureDatabase(env);
        return handleHealth(env);
      }

      if (url.pathname.startsWith("/api/grafana/")) {
        return await handleGrafana(request, env, url);
      }

      if (url.pathname.startsWith("/api/")) {
        await ensureDatabase(env);

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
          let b={};try{b=await request.json()}catch{}
          // getCurrentUser não traz o hash; busca aqui para não expô-lo nas demais rotas.
          const cred=await getDB(env).prepare(`SELECT password_hash FROM users WHERE id=?`).bind(user.id).first();
          if(!cred||!(await verifyPassword(String(b.oldPassword||""),cred.password_hash)))
            return json({error:"SENHA_ATUAL_INVALIDA"},400);
          if(String(b.newPassword||"").length<8)return json({error:"SENHA_FRACA"},400);
          await env.bd.prepare(`UPDATE users SET password_hash=?,must_change_password=0,updated_at=CURRENT_TIMESTAMP WHERE id=?`)
            .bind(await hashPassword(String(b.newPassword)),user.id).run();
          await audit(env,request,user,"PASSWORD_CHANGED","user",user.id);
          return json({ok:true});
        }

        if (url.pathname === "/api/access" && request.method === "GET")
          return await handleAccess(env,request);

        if (url.pathname === "/api/topology/permissions" && request.method === "GET")
          return await handleTopologyPermissions(env,request);

        if (url.pathname === "/api/topology" && (request.method === "GET" || request.method === "PUT"))
          return await handleTopology(env,request);

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

      if (env.ASSETS) {
        const asset = await env.ASSETS.fetch(request);
        return new Response(asset.body, {status:asset.status, headers:securityHeaders(asset.headers)});
      }
      return new Response("Assets binding ASSETS não encontrado.",{status:500});
    } catch(error) {
      // O detalhe do erro fica no log do Worker; a resposta não expõe
      // mensagem de banco, esquema ou stack para o cliente.
      console.error(error);
      return json({ok:false,error:"Erro interno do Worker."},500);
    }
  }
};
