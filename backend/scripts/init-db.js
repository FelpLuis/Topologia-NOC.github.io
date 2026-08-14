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
  ["admin", "Acesso total ao sistema"],
  ["editor", "Pode visualizar e alterar a topologia"],
  ["viewer", "Somente visualização"]
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
const adminCodes = new Set(allPerms.map(p => p.code));
const editorCodes = new Set(["topology.view","topology.edit"]);
const viewerCodes = new Set(["topology.view"]);

const link = db.prepare("INSERT OR IGNORE INTO role_permissions(role_id, permission_id) VALUES (?, ?)");
for (const [role, codes] of [["admin", adminCodes],["editor",editorCodes],["viewer",viewerCodes]]) {
  for (const p of allPerms) if (codes.has(p.code)) link.run(roleIds[role], p.id);
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
  `).run("admin", "Administrador", hashPassword("admin"), roleIds.admin);
  console.log("Usuário inicial criado: admin / admin (troca de senha obrigatória no primeiro login).");
} else {
  console.log("Usuário admin já existe; senha não foi alterada.");
}
db.close();
