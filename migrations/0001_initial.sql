-- Topologia NOC - Cloudflare D1
-- O Worker também cria estas tabelas automaticamente, mas este arquivo
-- pode ser usado como migration no D1.

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

INSERT OR IGNORE INTO roles(name,description) VALUES
('administrador','Administrador da plataforma'),
('gerente','Gerente'),
('analista','Analista'),
('atendimento','Atendimento'),
('tecnico','Técnico'),
('logistica','Logística');

INSERT OR IGNORE INTO screens(code,name,description) VALUES
('network','Gerenciar Rede','Equipamentos, portas, POPs e conexões'),
('dashboard','Dashboard','Dashboard operacional'),
('platform','Gerenciar Plataforma','Usuários, perfis, permissões e auditoria');
