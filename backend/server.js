import "dotenv/config";
import express from "express";
import cookieParser from "cookie-parser";
import Database from "better-sqlite3";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const PORT = Number(process.env.PORT || 3000);
const SESSION_HOURS = Number(process.env.SESSION_HOURS || 12);
const app = express();
const root = process.cwd();
const publicDir = path.resolve(root, "public");
const db = new Database(path.resolve(root, "backend/data/topologia.db"));
db.pragma("foreign_keys = ON");
db.pragma("journal_mode = WAL");

db.exec(`
CREATE TABLE IF NOT EXISTS topology_state (
  id INTEGER PRIMARY KEY CHECK (id=1),
  data_json TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_topology_updated_at ON topology_state(updated_at);
`);

app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: false }));
app.use(cookieParser());
app.use(express.static(publicDir));

const COOKIE = "updown_session";

const permissionsByRole = db.prepare(`
  SELECT r.name role, p.code
  FROM roles r
  LEFT JOIN role_permissions rp ON rp.role_id=r.id
  LEFT JOIN permissions p ON p.id=rp.permission_id
`);
const rolePermCache = {};
for (const row of permissionsByRole.all()) {
  rolePermCache[row.role] ||= new Set();
  if (row.code) rolePermCache[row.role].add(row.code);
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const derived = crypto.pbkdf2Sync(password, salt, 210000, 32, "sha256").toString("hex");
  return `pbkdf2$sha256$210000$${salt}$${derived}`;
}
function verifyPassword(password, encoded) {
  const parts = String(encoded).split("$");
  if (parts.length !== 5) return false;
  const [, algo, iterations, salt, expected] = parts;
  const actual = crypto.pbkdf2Sync(password, salt, Number(iterations), 32, algo).toString("hex");
  return crypto.timingSafeEqual(Buffer.from(actual), Buffer.from(expected));
}
function safeUser(u) {
  return {
    id: u.id, username: u.username, display_name: u.display_name,
    role: u.role, active: !!u.active, must_change_password: !!u.must_change_password,
    created_at: u.created_at, updated_at: u.updated_at, last_login_at: u.last_login_at
  };
}
function ipOf(req) {
  return req.headers["cf-connecting-ip"] || req.headers["x-forwarded-for"]?.split(",")[0]?.trim() || req.socket.remoteAddress || "";
}
function audit(req, user, action, resourceType, resourceId, before=null, after=null, details=null) {
  db.prepare(`
    INSERT INTO audit_logs
      (user_id,username,action,resource_type,resource_id,method,path,ip,user_agent,before_json,after_json,details_json)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    user?.id ?? null, user?.username ?? null, action, resourceType, resourceId == null ? null : String(resourceId),
    req.method, req.originalUrl, ipOf(req), req.headers["user-agent"] || "",
    before == null ? null : JSON.stringify(before),
    after == null ? null : JSON.stringify(after),
    details == null ? null : JSON.stringify(details)
  );
}
function currentUser(req) {
  const sid = req.cookies[COOKIE];
  if (!sid) return null;
  const row = db.prepare(`
    SELECT u.*, r.name role
    FROM sessions s
    JOIN users u ON u.id=s.user_id
    JOIN roles r ON r.id=u.role_id
    WHERE s.id=? AND s.expires_at > datetime('now') AND u.active=1
  `).get(sid);
  return row || null;
}
function requireAuth(req,res,next) {
  const user = currentUser(req);
  if (!user) return res.status(401).json({error:"AUTH_REQUIRED"});
  req.user = user;
  next();
}
function requirePermission(code) {
  return (req,res,next) => {
    if (!req.user) return res.status(401).json({error:"AUTH_REQUIRED"});
    if (!rolePermCache[req.user.role]?.has(code)) return res.status(403).json({error:"FORBIDDEN", permission:code});
    next();
  };
}
function validatePassword(p) {
  return typeof p === "string" && p.length >= 8;
}

// Auth
app.get("/api/auth/me", (req,res) => {
  const user = currentUser(req);
  res.json({ authenticated: !!user, user: user ? safeUser(user) : null });
});

app.post("/api/auth/login", (req,res) => {
  const username = String(req.body.username || "").trim();
  const password = String(req.body.password || "");
  const user = db.prepare(`
    SELECT u.*, r.name role FROM users u JOIN roles r ON r.id=u.role_id
    WHERE u.username=?
  `).get(username);

  if (!user || !user.active || !verifyPassword(password, user.password_hash)) {
    audit(req, null, "LOGIN_FAILED", "auth", username, null, null, { reason:"invalid_credentials" });
    return res.status(401).json({error:"CREDENCIAIS_INVALIDAS"});
  }

  const sid = crypto.randomBytes(32).toString("hex");
  const expires = new Date(Date.now() + SESSION_HOURS*3600*1000).toISOString();
  db.prepare("INSERT INTO sessions(id,user_id,expires_at,ip,user_agent) VALUES(?,?,?,?,?)")
    .run(sid,user.id,expires,ipOf(req),req.headers["user-agent"]||"");
  db.prepare("UPDATE users SET last_login_at=CURRENT_TIMESTAMP WHERE id=?").run(user.id);

  res.cookie(COOKIE, sid, {
    httpOnly:true, sameSite:"lax", secure:process.env.NODE_ENV === "production",
    maxAge:SESSION_HOURS*3600*1000, path:"/"
  });
  audit(req, user, "LOGIN", "auth", user.id, null, {role:user.role});
  res.json({ok:true, user:safeUser({...user,last_login_at:new Date().toISOString()})});
});

app.post("/api/auth/logout", requireAuth, (req,res) => {
  const sid = req.cookies[COOKIE];
  db.prepare("DELETE FROM sessions WHERE id=?").run(sid);
  audit(req, req.user, "LOGOUT", "auth", req.user.id);
  res.clearCookie(COOKIE, {httpOnly:true,sameSite:"lax",secure:process.env.NODE_ENV==="production",path:"/"});
  res.json({ok:true});
});

app.post("/api/auth/change-password", requireAuth, (req,res) => {
  const oldPassword = String(req.body.oldPassword || "");
  const newPassword = String(req.body.newPassword || "");
  if (!verifyPassword(oldPassword, req.user.password_hash)) return res.status(400).json({error:"SENHA_ATUAL_INVALIDA"});
  if (!validatePassword(newPassword)) return res.status(400).json({error:"SENHA_FRACA"});
  db.prepare("UPDATE users SET password_hash=?, must_change_password=0, updated_at=CURRENT_TIMESTAMP WHERE id=?")
    .run(hashPassword(newPassword), req.user.id);
  audit(req, req.user, "PASSWORD_CHANGED", "user", req.user.id);
  res.json({ok:true});
});


function isAdministrator(user) {
  return user?.role === "administrador";
}
function requireAdministrator(req,res,next) {
  if (!req.user) return res.status(401).json({error:"AUTH_REQUIRED"});
  if (!isAdministrator(req.user)) return res.status(403).json({error:"ADMIN_ONLY"});
  next();
}
function canSeeScreen(user, code) {
  if (!user) return false;
  return !!db.prepare(`
    SELECT 1
    FROM role_screens rs
    JOIN roles r ON r.id=rs.role_id
    JOIN screens s ON s.id=rs.screen_id
    WHERE r.name=? AND s.code=? AND s.active=1
  `).get(user.role, code);
}

app.get("/api/access", requireAuth, (req,res) => {
  const permissions=[...(rolePermCache[req.user.role]||[])];
  const screens=db.prepare(`
    SELECT s.code,s.name,s.description,s.route
    FROM role_screens rs
    JOIN roles r ON r.id=rs.role_id
    JOIN screens s ON s.id=rs.screen_id
    WHERE r.name=? AND s.active=1
    ORDER BY s.id
  `).all(req.user.role);
  res.json({role:req.user.role, permissions, screens});
});

app.get("/api/platform/roles", requireAuth, requireAdministrator, (req,res) => {
  const roles=db.prepare("SELECT id,name,description FROM roles ORDER BY id").all();
  const perms=db.prepare("SELECT id,code,description FROM permissions ORDER BY code").all();
  const screens=db.prepare("SELECT id,code,name,description,route,active FROM screens ORDER BY id").all();
  const rolePermissions=db.prepare(`
    SELECT role_id,permission_id FROM role_permissions
  `).all();
  const roleScreens=db.prepare(`
    SELECT role_id,screen_id FROM role_screens
  `).all();
  res.json({roles,permissions:perms,screens,rolePermissions,roleScreens});
});

app.post("/api/platform/roles", requireAuth, requireAdministrator, (req,res) => {
  const name=String(req.body.name||"").trim().toLowerCase().replace(/\s+/g,"_");
  const description=String(req.body.description||"").trim();
  if(!/^[a-z][a-z0-9_-]{2,40}$/.test(name)) return res.status(400).json({error:"NOME_PERFIL_INVALIDO"});
  try {
    const r=db.prepare("INSERT INTO roles(name,description) VALUES(?,?)").run(name,description);
    audit(req,req.user,"ROLE_CREATE","role",r.lastInsertRowid,null,{name,description});
    res.status(201).json({id:r.lastInsertRowid,name,description});
  } catch(e){ res.status(409).json({error:"PERFIL_JA_EXISTE"}); }
});

app.patch("/api/platform/roles/:id", requireAuth, requireAdministrator, (req,res) => {
  const id=Number(req.params.id);
  const before=db.prepare("SELECT id,name,description FROM roles WHERE id=?").get(id);
  if(!before) return res.status(404).json({error:"PERFIL_NAO_ENCONTRADO"});
  const description=req.body.description===undefined?before.description:String(req.body.description).trim();
  db.prepare("UPDATE roles SET description=? WHERE id=?").run(description,id);
  const after=db.prepare("SELECT id,name,description FROM roles WHERE id=?").get(id);
  audit(req,req.user,"ROLE_UPDATE","role",id,before,after);
  res.json(after);
});

app.delete("/api/platform/roles/:id", requireAuth, requireAdministrator, (req,res) => {
  const id=Number(req.params.id);
  const before=db.prepare("SELECT id,name,description FROM roles WHERE id=?").get(id);
  if(!before) return res.status(404).json({error:"PERFIL_NAO_ENCONTRADO"});
  if(before.name==="administrador") return res.status(400).json({error:"NAO_EXCLUA_ADMINISTRADOR"});
  const users=db.prepare("SELECT COUNT(*) c FROM users WHERE role_id=?").get(id).c;
  if(users) return res.status(400).json({error:"PERFIL_EM_USO"});
  db.prepare("DELETE FROM roles WHERE id=?").run(id);
  audit(req,req.user,"ROLE_DELETE","role",id,before,null);
  res.json({ok:true});
});

app.put("/api/platform/roles/:id/access", requireAuth, requireAdministrator, (req,res) => {
  const id=Number(req.params.id);
  const role=db.prepare("SELECT id,name,description FROM roles WHERE id=?").get(id);
  if(!role) return res.status(404).json({error:"PERFIL_NAO_ENCONTRADO"});
  const permissionIds=Array.isArray(req.body.permissionIds)?req.body.permissionIds.map(Number).filter(Number.isInteger):[];
  const screenIds=Array.isArray(req.body.screenIds)?req.body.screenIds.map(Number).filter(Number.isInteger):[];
  const before={
    permissions:db.prepare("SELECT permission_id FROM role_permissions WHERE role_id=? ORDER BY permission_id").all(id),
    screens:db.prepare("SELECT screen_id FROM role_screens WHERE role_id=? ORDER BY screen_id").all(id)
  };
  const tx=db.transaction(()=>{
    db.prepare("DELETE FROM role_permissions WHERE role_id=?").run(id);
    db.prepare("DELETE FROM role_screens WHERE role_id=?").run(id);
    const p=db.prepare("INSERT OR IGNORE INTO role_permissions(role_id,permission_id) VALUES(?,?)");
    const s=db.prepare("INSERT OR IGNORE INTO role_screens(role_id,screen_id) VALUES(?,?)");
    for(const pid of permissionIds) p.run(id,pid);
    for(const sid of screenIds) s.run(id,sid);
  });
  tx();
  const after={permissions:permissionIds.map(permission_id=>({permission_id})),screens:screenIds.map(screen_id=>({screen_id}))};
  audit(req,req.user,"ROLE_ACCESS_UPDATE","role",id,before,after);
  res.json({ok:true,role,after});
});

app.get("/api/platform/screens", requireAuth, requireAdministrator, (req,res) => {
  res.json(db.prepare("SELECT id,code,name,description,route,active FROM screens ORDER BY id").all());
});

app.put("/api/platform/screens/:id", requireAuth, requireAdministrator, (req,res) => {
  const id=Number(req.params.id);
  const before=db.prepare("SELECT id,code,name,description,route,active FROM screens WHERE id=?").get(id);
  if(!before) return res.status(404).json({error:"TELA_NAO_ENCONTRADA"});
  const active=req.body.active===undefined?before.active:(req.body.active?1:0);
  const after={...before,active};
  db.prepare("UPDATE screens SET active=? WHERE id=?").run(active,id);
  audit(req,req.user,"SCREEN_UPDATE","screen",id,before,after);
  res.json(after);
});

// User management
app.get("/api/users", requireAuth, requirePermission("users.view"), (req,res) => {
  const users = db.prepare(`
    SELECT u.id,u.username,u.display_name,u.active,u.must_change_password,u.created_at,u.updated_at,u.last_login_at,r.name role
    FROM users u JOIN roles r ON r.id=u.role_id ORDER BY u.username
  `).all().map(safeUser);
  res.json(users);
});

app.get("/api/roles", requireAuth, requirePermission("users.view"), (req,res) => {
  res.json(db.prepare("SELECT id,name,description FROM roles ORDER BY id").all());
});

app.post("/api/users", requireAuth, requirePermission("users.manage"), (req,res) => {
  const username = String(req.body.username||"").trim().toLowerCase();
  const displayName = String(req.body.display_name||username).trim();
  const password = String(req.body.password||"");
  const role = String(req.body.role||"atendimento");
  if (!/^[a-z0-9._-]{3,50}$/.test(username)) return res.status(400).json({error:"USUARIO_INVALIDO"});
  if (!validatePassword(password)) return res.status(400).json({error:"SENHA_DEVE_TER_8_CARACTERES"});
  const roleRow = db.prepare("SELECT id,name FROM roles WHERE name=?").get(role);
  if (!roleRow) return res.status(400).json({error:"ROLE_INVALIDA"});
  try {
    const result = db.prepare(`
      INSERT INTO users(username,display_name,password_hash,role_id,active,must_change_password)
      VALUES(?,?,?,?,1,1)
    `).run(username,displayName,hashPassword(password),roleRow.id);
    const after = db.prepare(`
      SELECT u.id,u.username,u.display_name,u.active,u.must_change_password,r.name role
      FROM users u JOIN roles r ON r.id=u.role_id WHERE u.id=?
    `).get(result.lastInsertRowid);
    audit(req, req.user, "CREATE", "user", after.id, null, safeUser(after));
    res.status(201).json(safeUser(after));
  } catch(e) {
    res.status(409).json({error:"USUARIO_JA_EXISTE"});
  }
});

app.patch("/api/users/:id", requireAuth, requirePermission("users.manage"), (req,res) => {
  const id = Number(req.params.id);
  const before = db.prepare(`
    SELECT u.id,u.username,u.display_name,u.active,u.must_change_password,r.name role
    FROM users u JOIN roles r ON r.id=u.role_id WHERE u.id=?
  `).get(id);
  if (!before) return res.status(404).json({error:"USUARIO_NAO_ENCONTRADO"});
  if (id === req.user.id && req.body.active === false) return res.status(400).json({error:"NAO_DESATIVE_SEU_PROPRIO_USUARIO"});
  const fields=[]; const values=[];
  if (req.body.display_name !== undefined) { fields.push("display_name=?"); values.push(String(req.body.display_name).trim()); }
  if (req.body.active !== undefined) { fields.push("active=?"); values.push(req.body.active ? 1 : 0); }
  if (req.body.role !== undefined) {
    const r=db.prepare("SELECT id FROM roles WHERE name=?").get(String(req.body.role));
    if(!r) return res.status(400).json({error:"ROLE_INVALIDA"});
    fields.push("role_id=?"); values.push(r.id);
  }
  if (req.body.password !== undefined) {
    if(!validatePassword(String(req.body.password))) return res.status(400).json({error:"SENHA_DEVE_TER_8_CARACTERES"});
    fields.push("password_hash=?","must_change_password=1"); values.push(hashPassword(String(req.body.password)));
  }
  if (!fields.length) return res.json(safeUser(before));
  fields.push("updated_at=CURRENT_TIMESTAMP");
  db.prepare(`UPDATE users SET ${fields.join(",")} WHERE id=?`).run(...values,id);
  const after=db.prepare(`
    SELECT u.id,u.username,u.display_name,u.active,u.must_change_password,r.name role
    FROM users u JOIN roles r ON r.id=u.role_id WHERE u.id=?
  `).get(id);
  audit(req, req.user, "UPDATE", "user", id, safeUser(before), safeUser(after));
  res.json(safeUser(after));
});

app.delete("/api/users/:id", requireAuth, requirePermission("users.manage"), (req,res) => {
  const id=Number(req.params.id);
  if(id===req.user.id) return res.status(400).json({error:"NAO_EXCLUA_SEU_PROPRIO_USUARIO"});
  const before=db.prepare(`
    SELECT u.id,u.username,u.display_name,u.active,r.name role
    FROM users u JOIN roles r ON r.id=u.role_id WHERE u.id=?
  `).get(id);
  if(!before) return res.status(404).json({error:"USUARIO_NAO_ENCONTRADO"});
  db.prepare("DELETE FROM users WHERE id=?").run(id);
  audit(req, req.user, "DELETE", "user", id, safeUser(before), null);
  res.json({ok:true});
});

// Audit
app.get("/api/audit", requireAuth, requirePermission("audit.view"), (req,res) => {
  const limit=Math.min(Number(req.query.limit||200),1000);
  const rows=db.prepare(`
    SELECT id,occurred_at,user_id,username,action,resource_type,resource_id,method,path,ip,user_agent,before_json,after_json,details_json
    FROM audit_logs ORDER BY id DESC LIMIT ?
  `).all(limit);
  res.json(rows);
});


function defaultTopologyConfig() {
  return {
    subtitle: "Topologia de Rede • Ascenty / BGP / MPLS",
    coreTitle: "NÚCLEO / ASCENTY — FLUXO PRINCIPAL",
    ringTitle: "ANEL ÓPTICO DOS POPs",
    ringLabel: "ANEL — ROTAS AÉREAS E SUBTERRÂNEAS",
    popSectionTitle: "EQUIPAMENTOS POR POP"
  };
}
function readInitialTopology() {
  const dataDir = path.join(publicDir, "data");
  const readJson = name => {
    const p = path.join(dataDir, name);
    return JSON.parse(fs.readFileSync(p, "utf8"));
  };
  return {
    equipamentos: readJson("equipamentos.json"),
    conexoes: readJson("conexoes.json"),
    pops: readJson("pops.json"),
    config: defaultTopologyConfig()
  };
}
function getTopologyRow() {
  return db.prepare("SELECT * FROM topology_state WHERE id=1").get();
}
function ensureTopologyState() {
  if (!getTopologyRow()) {
    const initial = readInitialTopology();
    db.prepare(`
      INSERT INTO topology_state(id,data_json,version,updated_at,updated_by)
      VALUES(1,?,?,CURRENT_TIMESTAMP,NULL)
    `).run(JSON.stringify(initial), 1);
  }
}
ensureTopologyState();

function parseTopology(row) {
  return row ? JSON.parse(row.data_json) : readInitialTopology();
}
function topologySummary(t) {
  return {
    equipamentos: Array.isArray(t?.equipamentos) ? t.equipamentos.length : 0,
    conexoes: Array.isArray(t?.conexoes) ? t.conexoes.length : 0,
    pops: Array.isArray(t?.pops) ? t.pops.length : 0,
    portas: Array.isArray(t?.equipamentos)
      ? t.equipamentos.reduce((n,e)=>n+(Array.isArray(e.portas)?e.portas.length:0),0)
      : 0
  };
}
function topologyDiff(before, after) {
  const diff = {equipamentos:{added:[],removed:[],changed:[]}, pops:{added:[],removed:[],changed:[]}, conexoes:{added:0,removed:0,changed:0}};
  const byId=(arr)=>Object.fromEntries((Array.isArray(arr)?arr:[]).filter(x=>x?.id).map(x=>[x.id,x]));
  for (const type of ["equipamentos","pops"]) {
    const a=byId(before?.[type]), b=byId(after?.[type]);
    for(const id of Object.keys(b)) if(!a[id]) diff[type].added.push(id);
    for(const id of Object.keys(a)) if(!b[id]) diff[type].removed.push(id);
    for(const id of Object.keys(a)) if(b[id] && JSON.stringify(a[id])!==JSON.stringify(b[id])) diff[type].changed.push(id);
  }
  const key=c=>JSON.stringify(c);
  const aa=(before?.conexoes||[]).map(key), bb=(after?.conexoes||[]).map(key);
  diff.conexoes.added=bb.filter(x=>!aa.includes(x)).length;
  diff.conexoes.removed=aa.filter(x=>!bb.includes(x)).length;
  return diff;
}

// Topology API. The browser NEVER writes topology JSON/localStorage.
// Every mutation goes through this API, is authorized by RBAC, persisted server-side,
// and written to the audit log with before/after snapshots and a structured diff.
app.get("/api/topology", requireAuth, requirePermission("topology.view"), (req,res) => {
  const row=getTopologyRow();
  const topology=parseTopology(row);
  res.setHeader("Cache-Control","no-store");
  res.json({ ...topology, version: row.version, updated_at: row.updated_at, updated_by: row.updated_by });
});

app.put("/api/topology", requireAuth, requirePermission("topology.edit"), (req,res) => {
  const beforeRow=getTopologyRow();
  const before=parseTopology(beforeRow);
  const incoming=req.body?.topology ?? req.body;
  if(!incoming || !Array.isArray(incoming.equipamentos) || !Array.isArray(incoming.conexoes) || !Array.isArray(incoming.pops)) {
    return res.status(400).json({error:"TOPOLOGIA_INVALIDA"});
  }
  const after={
    equipamentos: incoming.equipamentos,
    conexoes: incoming.conexoes,
    pops: incoming.pops,
    config: {...defaultTopologyConfig(), ...(incoming.config||{})}
  };
  const diff=topologyDiff(before,after);
  const hasDeletion =
    diff.equipamentos.removed.length > 0 ||
    diff.pops.removed.length > 0 ||
    diff.conexoes.removed > 0 ||
    (before.equipamentos||[]).some(oldEq => {
      const newEq=(after.equipamentos||[]).find(e=>e.id===oldEq.id);
      return newEq && (newEq.portas?.length||0) < (oldEq.portas?.length||0);
    });
  if(hasDeletion && !rolePermCache[req.user.role]?.has("topology.delete")) {
    audit(req, req.user, "TOPOLOGY_UPDATE_DENIED", "topology", "1", before, after, {reason:"missing topology.delete",diff});
    return res.status(403).json({error:"FORBIDDEN", permission:"topology.delete"});
  }
  const nextVersion=Number(beforeRow.version||0)+1;
  const tx=db.transaction(()=>{
    db.prepare(`
      UPDATE topology_state
      SET data_json=?, version=?, updated_at=CURRENT_TIMESTAMP, updated_by=?
      WHERE id=1
    `).run(JSON.stringify(after),nextVersion,req.user.id);
    audit(
      req, req.user, "TOPOLOGY_UPDATE", "topology", "1",
      before, after,
      {version_before:beforeRow.version,version_after:nextVersion,diff,before_summary:topologySummary(before),after_summary:topologySummary(after)}
    );
  });
  tx();
  res.json({ok:true,version:nextVersion,updated_at:new Date().toISOString(),topology:after,diff});
});

app.post("/api/topology/restore", requireAuth, requirePermission("topology.edit"), (req,res) => {
  const beforeRow=getTopologyRow();
  const before=parseTopology(beforeRow);
  const initial=readInitialTopology();
  const nextVersion=Number(beforeRow.version||0)+1;
  const tx=db.transaction(()=>{
    db.prepare("UPDATE topology_state SET data_json=?,version=?,updated_at=CURRENT_TIMESTAMP,updated_by=? WHERE id=1")
      .run(JSON.stringify(initial),nextVersion,req.user.id);
    audit(req,req.user,"TOPOLOGY_RESTORE","topology","1",before,initial,{
      version_before:beforeRow.version,version_after:nextVersion,
      before_summary:topologySummary(before),after_summary:topologySummary(initial)
    });
  });
  tx();
  res.json({ok:true,version:nextVersion,topology:initial});
});

app.get("/api/topology/history", requireAuth, requirePermission("audit.view"), (req,res) => {
  const rows=db.prepare(`
    SELECT id,occurred_at,user_id,username,action,resource_type,resource_id,method,path,
           ip,before_json,after_json,details_json
    FROM audit_logs
    WHERE resource_type='topology'
    ORDER BY id DESC LIMIT ?
  `).all(Math.min(Number(req.query.limit||100),500));
  res.json(rows);
});

app.post("/api/audit/test", requireAuth, requirePermission("topology.edit"), (req,res) => {
  audit(req, req.user, "TEST_MUTATION", "topology", req.body?.id || "test", null, req.body || {});
  res.json({ok:true});
});

// SPA fallback
app.get("*", (req,res,next) => {
  if (req.path.startsWith("/api/")) return next();
  res.sendFile(path.join(publicDir,"index.html"));
});

app.use((err,req,res,next)=>{
  console.error(err);
  res.status(500).json({error:"ERRO_INTERNO"});
});

app.listen(PORT, "127.0.0.1", () => {
  console.log(`UPDOWN Topologia NOC rodando em http://127.0.0.1:${PORT}`);
});
