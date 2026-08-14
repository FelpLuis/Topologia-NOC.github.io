import Database from "better-sqlite3";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const dbPath = path.resolve("backend/data/topologia.db");
fs.mkdirSync(path.dirname(dbPath), { recursive: true });
const db = new Database(dbPath);
db.pragma("foreign_keys = ON");
db.exec(fs.readFileSync(path.resolve("backend/schema.sql"), "utf8"));

const roles = [
  ["administrador", "Acesso total ao sistema"],
  ["gerente", "Acesso gerencial à operação, topologia, usuários e auditoria"],
  ["analista", "Pode visualizar, alterar e excluir a topologia e consultar auditoria"],
  ["atendimento", "Visualização da topologia e informações dos equipamentos"],
  ["tecnico", "Pode visualizar e alterar equipamentos, portas e conexões"],
  ["logistica", "Pode visualizar e alterar informações operacionais da topologia"]
];

const permissions = [
  ["topology.view", "Visualizar topologia, equipamentos, POPs e portas"],
  ["topology.edit", "Criar e alterar equipamentos, POPs, portas e conexões"],
  ["topology.delete", "Excluir equipamentos, POPs e conexões"],
  ["users.view", "Visualizar usuários"],
  ["users.manage", "Criar, alterar, ativar/desativar e excluir usuários"],
  ["audit.view", "Visualizar auditoria"],
  ["settings.manage", "Alterar configurações administrativas"]
];

const roleStmt = db.prepare("INSERT OR IGNORE INTO roles(name, description) VALUES (?, ?)");
for (const r of roles) roleStmt.run(...r);

const permStmt = db.prepare("INSERT OR IGNORE INTO permissions(code, description) VALUES (?, ?)");
for (const p of permissions) permStmt.run(...p);

const allPerms = db.prepare("SELECT id, code FROM permissions").all();
const roleIds = Object.fromEntries(db.prepare("SELECT id,name FROM roles").all().map(r => [r.name, r.id]));

const administradorCodes = new Set(allPerms.map(p => p.code));
const gerenteCodes = new Set([
  "topology.view","topology.edit","topology.delete",
  "users.view","users.manage","audit.view","settings.manage"
]);
const analistaCodes = new Set([
  "topology.view","topology.edit","topology.delete","audit.view"
]);
const atendimentoCodes = new Set(["topology.view"]);
const tecnicoCodes = new Set(["topology.view","topology.edit"]);
const logisticaCodes = new Set(["topology.view","topology.edit"]);

const link = db.prepare("INSERT OR IGNORE INTO role_permissions(role_id, permission_id) VALUES (?, ?)");
for (const [role, codes] of [
  ["administrador", administradorCodes],
  ["gerente", gerenteCodes],
  ["analista", analistaCodes],
  ["atendimento", atendimentoCodes],
  ["tecnico", tecnicoCodes],
  ["logistica", logisticaCodes]
]) {
  for (const p of allPerms) if (codes.has(p.code)) link.run(roleIds[role], p.id);
}

// Migração dos nomes dos perfis da versão anterior.
const oldToNew = [
  ["admin", "administrador"],
  ["editor", "analista"],
  ["viewer", "atendimento"]
];
for (const [oldName, newName] of oldToNew) {
  const oldRole = db.prepare("SELECT id FROM roles WHERE name=?").get(oldName);
  const newRole = db.prepare("SELECT id FROM roles WHERE name=?").get(newName);
  if (oldRole && newRole) {
    db.prepare("UPDATE users SET role_id=? WHERE role_id=?").run(newRole.id, oldRole.id);
    db.prepare("DELETE FROM role_permissions WHERE role_id=?").run(oldRole.id);
    db.prepare("DELETE FROM roles WHERE id=?").run(oldRole.id);
  }
}


const screens = [
  ["network", "Gerenciar Rede", "Topologia, equipamentos, portas, POPs e conexões", "/", 1],
  ["dashboard", "Dashboard", "Dashboard operacional para TV/NOC", "/dashboard.html", 1],
  ["platform", "Gerenciar Plataforma", "Perfis, permissões e usuários", "/platform.html", 1]
];
const screenStmt = db.prepare(`
  INSERT OR IGNORE INTO screens(code,name,description,route,active)
  VALUES (?,?,?,?,?)
`);
for (const screen of screens) screenStmt.run(...screen);

const screenRows = db.prepare("SELECT id,code FROM screens").all();
const screenIds = Object.fromEntries(screenRows.map(s => [s.code, s.id]));
const roleScreen = db.prepare("INSERT OR IGNORE INTO role_screens(role_id,screen_id) VALUES (?,?)");
const roleScreenMap = {
  administrador: ["network","dashboard","platform"],
  gerente: ["network","dashboard"],
  analista: ["network","dashboard"],
  atendimento: ["network","dashboard"],
  tecnico: ["network","dashboard"],
  logistica: ["network","dashboard"]
};
for (const [role, codes] of Object.entries(roleScreenMap)) {
  if (!roleIds[role]) continue;
  for (const code of codes) if (screenIds[code]) roleScreen.run(roleIds[role], screenIds[code]);
}

// PBKDF2 password hash; admin/admin is intentionally a bootstrap credential.
// The first login is forced to change the password.
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const derived = crypto.pbkdf2Sync(password, salt, 210000, 32, "sha256").toString("hex");
  return `pbkdf2$sha256$210000$${salt}$${derived}`;
}

const admin = db.prepare("SELECT id FROM users WHERE username=?").get("admin");
if (!admin) {
  db.prepare(`
    INSERT INTO users(username,display_name,password_hash,role_id,active,must_change_password)
    VALUES(?,?,?,?,1,1)
  `).run("admin", "Administrador", hashPassword("admin"), roleIds.administradoristrador);
  console.log("Usuário inicial criado: admin / admin (troca de senha obrigatória no primeiro login).");
} else {
  console.log("Usuário admin já existe; senha não foi alterada.");
}
db.close();
