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
  description TEXT NOT NULL DEFAULT ''
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
  id TEXT PRIMARY KEY,
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
  active INTEGER NOT NULL DEFAULT 1
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

CREATE INDEX IF NOT EXISTS idx_audit_created_at ON audit_logs(created_at);
CREATE INDEX IF NOT EXISTS idx_audit_user_id ON audit_logs(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_role_screens_role ON role_screens(role_id);
`;


const ROLES = [
  ["administrador", "Acesso total ao sistema"],
  ["gerente", "Acesso gerencial à operação, topologia, usuários e auditoria"],
  ["analista", "Pode visualizar, alterar e excluir a topologia e consultar auditoria"],
  ["atendimento", "Visualização da topologia e informações dos equipamentos"],
  ["tecnico", "Pode visualizar e alterar equipamentos, portas e conexões"],
  ["logistica", "Pode visualizar e alterar informações operacionais da topologia"]
];

const PERMISSIONS = [
  ["topology.view", "Visualizar topologia, equipamentos, POPs e portas"],
  ["topology.edit", "Criar e alterar equipamentos, POPs, portas e conexões"],
  ["topology.delete", "Excluir equipamentos, POPs e conexões"],
  ["users.view", "Visualizar usuários"],
  ["users.manage", "Criar, alterar, ativar/desativar e excluir usuários"],
  ["audit.view", "Visualizar auditoria"],
  ["settings.manage", "Alterar configurações administrativas"]
];

const ROLE_PERMISSIONS = {
  administrador: PERMISSIONS.map(x => x[0]),
  gerente: ["topology.view","topology.edit","topology.delete","users.view","users.manage","audit.view","settings.manage"],
  analista: ["topology.view","topology.edit","topology.delete","audit.view"],
  atendimento: ["topology.view"],
  tecnico: ["topology.view","topology.edit"],
  logistica: ["topology.view","topology.edit"]
};

const SCREENS = [
  ["network", "Gerenciar Rede", "Topologia, equipamentos, portas, POPs e conexões", "/", 1],
  ["dashboard", "Dashboard", "Dashboard operacional para TV/NOC", "/dashboard.html", 1],
  ["platform", "Gerenciar Plataforma", "Perfis, permissões e usuários", "/platform.html", 1]
];




function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...extraHeaders
    }
  });
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
  await db.prepare(`
    INSERT INTO audit_logs
      (user_id, username, action, resource_type, resource_id, method, path, ip, user_agent, before_json, after_json, details_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    user?.id ?? null,
    user?.username ?? null,
    action,
    resourceType,
    resourceId == null ? null : String(resourceId),
    request.method,
    new URL(request.url).pathname,
    getClientIP(request),
    request.headers.get("User-Agent") || "",
    before == null ? null : JSON.stringify(before),
    after == null ? null : JSON.stringify(after),
    details == null ? null : JSON.stringify(details)
  ).run();
}

async function requireUser(env, request) {
  return getCurrentUser(env, request);
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

async function requirePermission(env, request, code) {
  const user = await requireUser(env, request);
  if (!user) return { user: null, response: json({error:"AUTH_REQUIRED"},401) };
  if (!(await hasPermission(env, user, code))) {
    return { user, response: json({error:"FORBIDDEN", permission:code},403) };
  }
  return { user, response: null };
}

async function requireAdmin(env, request) {
  const user = await requireUser(env, request);
  if (!user) return { user:null, response:json({error:"AUTH_REQUIRED"},401) };
  if (user.role !== "administrador") return { user, response:json({error:"ADMIN_ONLY"},403) };
  return { user, response:null };
}

let databaseReady = false;

async function ensureDatabase(env) {
  const db = getDB(env);
  if (!db) throw new Error('Binding D1 "bd" não encontrado.');

  if (!databaseReady) {
    const statements = SCHEMA.split(/;\s*(?=CREATE TABLE|CREATE INDEX)/)
      .map(x => x.trim()).filter(Boolean)
      .map(x => db.prepare(x));
    await db.batch(statements);
    databaseReady = true;
  }

  for (const [name, description] of ROLES) {
    await db.prepare(`
      INSERT INTO roles(name,description) VALUES (?,?)
      ON CONFLICT(name) DO UPDATE SET description=excluded.description
    `).bind(name,description).run();
  }

  for (const [code, description] of PERMISSIONS) {
    await db.prepare(`
      INSERT INTO permissions(code,description) VALUES (?,?)
      ON CONFLICT(code) DO UPDATE SET description=excluded.description
    `).bind(code,description).run();
  }

  for (const [code,name,description,route,active] of SCREENS) {
    await db.prepare(`
      INSERT INTO screens(code,name,description,route,active) VALUES (?,?,?,?,?)
      ON CONFLICT(code) DO UPDATE SET
        name=excluded.name, description=excluded.description,
        route=excluded.route, active=excluded.active
    `).bind(code,name,description,route,active).run();
  }

  const roles = await db.prepare(`SELECT id,name FROM roles`).all();
  const perms = await db.prepare(`SELECT id,code FROM permissions`).all();
  const screens = await db.prepare(`SELECT id,code FROM screens`).all();
  const roleMap = Object.fromEntries((roles.results||[]).map(x=>[x.name,x.id]));
  const permMap = Object.fromEntries((perms.results||[]).map(x=>[x.code,x.id]));
  const screenMap = Object.fromEntries((screens.results||[]).map(x=>[x.code,x.id]));

  for (const [role,codes] of Object.entries(ROLE_PERMISSIONS)) {
    for (const code of codes) {
      if (roleMap[role] && permMap[code]) {
        await db.prepare(`
          INSERT OR IGNORE INTO role_permissions(role_id,permission_id) VALUES (?,?)
        `).bind(roleMap[role],permMap[code]).run();
      }
    }
  }

  const roleScreens = {
    administrador:["network","dashboard","platform"],
    gerente:["network","dashboard"],
    analista:["network","dashboard"],
    atendimento:["network","dashboard"],
    tecnico:["network","dashboard"],
    logistica:["network","dashboard"]
  };
  for (const [role,codes] of Object.entries(roleScreens)) {
    for (const code of codes) {
      if (roleMap[role] && screenMap[code]) {
        await db.prepare(`
          INSERT OR IGNORE INTO role_screens(role_id,screen_id) VALUES (?,?)
        `).bind(roleMap[role],screenMap[code]).run();
      }
    }
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
    config: {
      subtitle:"Topologia de Rede • Ascenty / BGP / MPLS",
      coreTitle:"NÚCLEO / ASCENTY — FLUXO PRINCIPAL",
      ringTitle:"ANEL ÓPTICO DOS POPs",
      ringLabel:"ANEL — ROTAS AÉREAS E SUBTERRÂNEAS",
      popSectionTitle:"EQUIPAMENTOS POR POP"
    }
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
    await audit(env, request, user, "LOGOUT", "auth", String(user.id));
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
    SELECT s.code,s.name,s.description,s.route
    FROM role_screens rs JOIN screens s ON s.id=rs.screen_id
    WHERE rs.role_id=? AND s.active=1 ORDER BY s.id
  `).bind(user.role_id).all()).results;
  return json({role:user.role,permissions,screens});
}

async function handlePlatformRoles(env, request) {
  const gate=await requireAdmin(env,request); if(gate.response)return gate.response;
  const db=getDB(env);
  const roles=(await db.prepare(`SELECT id,name,description FROM roles ORDER BY id`).all()).results;
  const permissions=(await db.prepare(`SELECT id,code,description FROM permissions ORDER BY code`).all()).results;
  const screens=(await db.prepare(`SELECT id,code,name,description,route,active FROM screens ORDER BY id`).all()).results;
  const rolePermissions=(await db.prepare(`SELECT role_id,permission_id FROM role_permissions`).all()).results;
  const roleScreens=(await db.prepare(`SELECT role_id,screen_id FROM role_screens`).all()).results;
  return json({roles,permissions,screens,rolePermissions,roleScreens});
}

async function handlePlatformRoleCreate(env,request) {
  const gate=await requireAdmin(env,request); if(gate.response)return gate.response;
  const db=getDB(env); let body={}; try{body=await request.json()}catch{}
  const name=String(body.name||"").trim().toLowerCase().replace(/\s+/g,"_");
  const description=String(body.description||"").trim();
  if(!/^[a-z][a-z0-9_-]{2,40}$/.test(name))return json({error:"NOME_PERFIL_INVALIDO"},400);
  try{
    const r=await db.prepare(`INSERT INTO roles(name,description) VALUES (?,?)`).bind(name,description).run();
    const after={id:r.meta.last_row_id,name,description};
    await audit(env,request,gate.user,"ROLE_CREATE","role",after.id,null,after);
    return json(after,201);
  }catch{return json({error:"PERFIL_JA_EXISTE"},409)}
}

async function handlePlatformRoleUpdate(env,request,id) {
  const gate=await requireAdmin(env,request); if(gate.response)return gate.response;
  const db=getDB(env);
  const before=await db.prepare(`SELECT id,name,description FROM roles WHERE id=?`).bind(id).first();
  if(!before)return json({error:"PERFIL_NAO_ENCONTRADO"},404);
  let body={};try{body=await request.json()}catch{}
  const description=body.description===undefined?before.description:String(body.description).trim();
  await db.prepare(`UPDATE roles SET description=? WHERE id=?`).bind(description,id).run();
  const after=await db.prepare(`SELECT id,name,description FROM roles WHERE id=?`).bind(id).first();
  await audit(env,request,gate.user,"ROLE_UPDATE","role",id,before,after);
  return json(after);
}

async function handlePlatformRoleDelete(env,request,id) {
  const gate=await requireAdmin(env,request); if(gate.response)return gate.response;
  const db=getDB(env);
  const before=await db.prepare(`SELECT id,name,description FROM roles WHERE id=?`).bind(id).first();
  if(!before)return json({error:"PERFIL_NAO_ENCONTRADO"},404);
  if(before.name==="administrador")return json({error:"NAO_EXCLUA_ADMINISTRADOR"},400);
  const c=await db.prepare(`SELECT COUNT(*) c FROM users WHERE role_id=?`).bind(id).first();
  if(Number(c?.c)>0)return json({error:"PERFIL_EM_USO"},400);
  await db.prepare(`DELETE FROM roles WHERE id=?`).bind(id).run();
  await audit(env,request,gate.user,"ROLE_DELETE","role",id,before,null);
  return json({ok:true});
}

async function handlePlatformRoleAccess(env,request,id) {
  const gate=await requireAdmin(env,request); if(gate.response)return gate.response;
  const db=getDB(env); const role=await db.prepare(`SELECT id,name,description FROM roles WHERE id=?`).bind(id).first();
  if(!role)return json({error:"PERFIL_NAO_ENCONTRADO"},404);
  let body={};try{body=await request.json()}catch{}
  const permissionIds=Array.isArray(body.permissionIds)?body.permissionIds.map(Number).filter(Number.isInteger):[];
  const screenIds=Array.isArray(body.screenIds)?body.screenIds.map(Number).filter(Number.isInteger):[];
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
  const gate=await requireAdmin(env,request); if(gate.response)return gate.response;
  const db=getDB(env);
  const before=await db.prepare(`SELECT id,code,name,description,route,active FROM screens WHERE id=?`).bind(id).first();
  if(!before)return json({error:"TELA_NAO_ENCONTRADA"},404);
  let body={};try{body=await request.json()}catch{}
  const active=body.active===undefined?before.active:(body.active?1:0);
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
  `).bind(limit)).results;
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
    config:{
      subtitle:"Topologia de Rede • Ascenty / BGP / MPLS",
      coreTitle:"NÚCLEO / ASCENTY — FLUXO PRINCIPAL",
      ringTitle:"ANEL ÓPTICO DOS POPs",
      ringLabel:"ANEL — ROTAS AÉREAS E SUBTERRÂNEAS",
      popSectionTitle:"EQUIPAMENTOS POR POP",
      ...(incoming.config||{})
    }
  };
  const diff=topologyDiff(before,after);
  const hasDeletion=diff.equipamentos.removed.length||diff.pops.removed.length||diff.conexoes.removed;
  if(hasDeletion && !(await hasPermission(env,gate.user,"topology.delete"))){
    await audit(env,request,gate.user,"TOPOLOGY_UPDATE_DENIED","topology","1",before,after,{reason:"missing topology.delete",diff});
    return json({error:"FORBIDDEN",permission:"topology.delete"},403);
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
          if(!(await verifyPassword(String(b.oldPassword||""),user.password_hash)))
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
          const gate=await requireAdmin(env,request);if(gate.response)return gate.response;
          const rows=(await env.bd.prepare(`SELECT id,code,name,description,route,active FROM screens ORDER BY id`).all()).results;
          return json(rows);
        }

        return json({ok:false,error:"Endpoint não encontrado.",path:url.pathname},404);
      }

      if (env.ASSETS) return env.ASSETS.fetch(request);
      return new Response("Assets binding ASSETS não encontrado.",{status:500});
    } catch(error) {
      console.error(error);
      return json({
        ok:false,
        error:"Erro interno do Worker.",
        detail:String(error?.message||error)
      },500);
    }
  }
};
