-- Acesso gerencial aos equipamentos.
-- O endereco e o protocolo pertencem ao aparelho; as credenciais pertencem
-- ao usuario autenticado e a senha nunca e gravada em texto puro.

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

CREATE INDEX IF NOT EXISTS idx_device_credentials_user
  ON device_credentials(user_id);

INSERT INTO permissions(code,name,description,screen_code,module,sort) VALUES
('topology.connection.use','Usar conexao remota','Cadastrar as proprias credenciais e abrir SSH ou TELNET','network','Acesso remoto',10),
('topology.connection.configure','Configurar conexao remota','Definir IP, protocolo e porta de gerencia do equipamento','network','Acesso remoto',20)
ON CONFLICT(code) DO UPDATE SET
  name=excluded.name, description=excluded.description,
  screen_code=excluded.screen_code, module=excluded.module, sort=excluded.sort;

-- Mantem a equivalencia com os acessos que os perfis ja possuíam.
INSERT OR IGNORE INTO role_permissions(role_id,permission_id)
SELECT rp.role_id, novo.id
FROM role_permissions rp
JOIN permissions atual ON atual.id=rp.permission_id AND atual.code='topology.view'
JOIN permissions novo ON novo.code='topology.connection.use';

INSERT OR IGNORE INTO role_permissions(role_id,permission_id)
SELECT rp.role_id, novo.id
FROM role_permissions rp
JOIN permissions atual ON atual.id=rp.permission_id AND atual.code='topology.equipment.edit'
JOIN permissions novo ON novo.code='topology.connection.configure';
