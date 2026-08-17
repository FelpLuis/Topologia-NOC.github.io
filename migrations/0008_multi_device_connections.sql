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

CREATE INDEX IF NOT EXISTS idx_device_targets_device ON device_connection_targets(device_id,sort,name);
CREATE INDEX IF NOT EXISTS idx_device_acl_role ON device_connection_acl(role_id,target_id);
CREATE INDEX IF NOT EXISTS idx_device_target_credentials_user ON device_target_credentials(user_id);

INSERT OR IGNORE INTO device_connection_targets
  (id,device_id,name,management_ip,protocol,port,updated_by,created_at,updated_at)
SELECT 'legacy:'||device_id,device_id,'Acesso principal',management_ip,protocol,port,updated_by,updated_at,updated_at
FROM device_connections;

INSERT OR IGNORE INTO device_target_credentials
  (target_id,user_id,login_username,password_ciphertext,updated_at)
SELECT 'legacy:'||device_id,user_id,login_username,password_ciphertext,updated_at
FROM device_credentials;

INSERT OR IGNORE INTO device_connection_acl(target_id,role_id,can_connect,can_manage)
SELECT t.id,rp.role_id,1,0
FROM device_connection_targets t
JOIN permissions p ON p.code='topology.connection.use'
JOIN role_permissions rp ON rp.permission_id=p.id;

INSERT INTO device_connection_acl(target_id,role_id,can_connect,can_manage)
SELECT t.id,rp.role_id,1,1
FROM device_connection_targets t
JOIN permissions p ON p.code='topology.connection.configure'
JOIN role_permissions rp ON rp.permission_id=p.id
ON CONFLICT(target_id,role_id) DO UPDATE SET can_connect=1,can_manage=1;
