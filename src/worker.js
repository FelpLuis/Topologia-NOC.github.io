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
  description TEXT DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role_id INTEGER NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  must_change_password INTEGER NOT NULL DEFAULT 0,
  last_login_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(role_id) REFERENCES roles(id)
);

CREATE TABLE IF NOT EXISTS sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  token_hash TEXT NOT NULL UNIQUE,
  user_id INTEGER NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER,
  action TEXT NOT NULL,
  resource TEXT NOT NULL,
  resource_id TEXT,
  details TEXT DEFAULT '',
  ip TEXT,
  user_agent TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS screens (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  description TEXT DEFAULT '',
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS role_screens (
  role_id INTEGER NOT NULL,
  screen_id INTEGER NOT NULL,
  PRIMARY KEY(role_id, screen_id),
  FOREIGN KEY(role_id) REFERENCES roles(id),
  FOREIGN KEY(screen_id) REFERENCES screens(id)
);
`;

const ROLES = [
  ["administrador", "Administrador da plataforma"],
  ["gerente", "Gerente"],
  ["analista", "Analista"],
  ["atendimento", "Atendimento"],
  ["tecnico", "Técnico"],
  ["logistica", "Logística"]
];

const SCREENS = [
  ["network", "Gerenciar Rede", "Equipamentos, portas, POPs e conexões"],
  ["dashboard", "Dashboard", "Dashboard operacional"],
  ["platform", "Gerenciar Plataforma", "Usuários, perfis, permissões e auditoria"]
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

async function audit(env, request, userId, action, resource, resourceId = null, details = "") {
  const db = getDB(env);
  if (!db) return;

  await db.prepare(`
    INSERT INTO audit_logs
      (user_id, action, resource, resource_id, details, ip, user_agent)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).bind(
    userId,
    action,
    resource,
    resourceId,
    details,
    getClientIP(request),
    request.headers.get("User-Agent") || ""
  ).run();
}

async function ensureDatabase(env) {
  const db = getDB(env);
  if (!db) throw new Error('Binding D1 não encontrado. Crie um binding D1 chamado "bd" ou "DB".');

  await db.exec(SCHEMA);

  for (const [name, description] of ROLES) {
    await db.prepare(`
      INSERT INTO roles(name, description)
      VALUES (?, ?)
      ON CONFLICT(name) DO UPDATE SET description=excluded.description
    `).bind(name, description).run();
  }

  for (const [code, name, description] of SCREENS) {
    await db.prepare(`
      INSERT INTO screens(code, name, description)
      VALUES (?, ?, ?)
      ON CONFLICT(code) DO UPDATE SET name=excluded.name, description=excluded.description
    `).bind(code, name, description).run();
  }

  // Admin inicial: admin / admin
  const adminRole = await db.prepare(
    `SELECT id FROM roles WHERE name='administrador'`
  ).first();

  const admin = await db.prepare(
    `SELECT id FROM users WHERE username='admin'`
  ).first();

  if (!admin) {
    const passwordHash = await hashPassword("admin");

    await db.prepare(`
      INSERT INTO users
        (username, display_name, password_hash, role_id, active, must_change_password)
      VALUES ('admin', 'Administrador', ?, ?, 1, 0)
    `).bind(passwordHash, adminRole.id).run();
  } else {
    // Garante que o usuário admin consiga entrar.
    // Não sobrescreve uma senha que já tenha sido alterada.
    await db.prepare(`
      UPDATE users
      SET role_id=?, active=1, updated_at=CURRENT_TIMESTAMP
      WHERE username='admin'
    `).bind(adminRole.id).run();
  }

  // O administrador visualiza todas as telas.
  const adminId = adminRole.id;
  const screenRows = await db.prepare(`SELECT id FROM screens`).all();

  for (const screen of screenRows.results || []) {
    await db.prepare(`
      INSERT OR IGNORE INTO role_screens(role_id, screen_id)
      VALUES (?, ?)
    `).bind(adminId, screen.id).run();
  }
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

  await audit(env, request, user.id, "LOGIN", "auth", String(user.id), "Login realizado com sucesso");

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
      await audit(env, request, user.id, "LOGIN_FAILED", "auth", String(user.id), "Credenciais inválidas");
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
    await audit(env, request, user.id, "LOGOUT", "auth", String(user.id), "Logout realizado");
  }

  return json({ ok: true }, 200, {
    "Set-Cookie": `${COOKIE_NAME}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`
  });
}

async function handleHealth(env) {
  const db = getDB(env);
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


export default {
  async fetch(request, env, ctx) {
    try {
      const url = new URL(request.url);

      // API sempre antes dos Static Assets.
      if (url.pathname === "/api/health" && request.method === "GET") {
        await ensureDatabase(env);
        return handleHealth(env);
      }

      // Integração Grafana continua no mesmo Worker.
      if (url.pathname.startsWith("/api/grafana/")) {
        return await handleGrafana(request, env, url);
      }

      if (url.pathname.startsWith("/api/")) {
        await ensureDatabase(env);

        if (url.pathname === "/api/auth/login" && request.method === "POST") {
          return await handleLogin(env, request);
        }

        if (url.pathname === "/api/auth/me" && request.method === "GET") {
          return await handleMe(env, request);
        }

        if (url.pathname === "/api/auth/logout" && request.method === "POST") {
          return await handleLogout(env, request);
        }

        return json({ ok: false, error: "Endpoint não encontrado." }, 404);
      }

      // Todo o restante continua sendo servido pelos Static Assets.
      if (env.ASSETS) {
        return env.ASSETS.fetch(request);
      }

      return new Response("Assets binding ASSETS não encontrado.", { status: 500 });
    } catch (error) {
      console.error(error);
      return json({
        ok: false,
        error: "Erro interno do Worker.",
        detail: String(error?.message || error)
      }, 500);
    }
  }
};
