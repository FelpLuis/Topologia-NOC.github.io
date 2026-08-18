-- Agenda pessoal e por setor. Setores funcionam como grupos de autorização:
-- somente usuários vinculados podem consultar ou alterar seus compromissos.

CREATE TABLE IF NOT EXISTS sectors (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL UNIQUE,
  description TEXT NOT NULL DEFAULT '',
  color TEXT NOT NULL DEFAULT '#2563eb',
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS user_sectors (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  sector_id INTEGER NOT NULL REFERENCES sectors(id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, sector_id)
);

CREATE TABLE IF NOT EXISTS agenda_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_type TEXT NOT NULL CHECK(owner_type IN ('user','sector')),
  owner_user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  sector_id INTEGER REFERENCES sectors(id) ON DELETE CASCADE,
  creator_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  location TEXT NOT NULL DEFAULT '',
  start_at TEXT NOT NULL,
  end_at TEXT NOT NULL,
  all_day INTEGER NOT NULL DEFAULT 0,
  alert_email INTEGER NOT NULL DEFAULT 1,
  alert_popup INTEGER NOT NULL DEFAULT 1,
  alert_minutes INTEGER NOT NULL DEFAULT 10 CHECK(alert_minutes BETWEEN 0 AND 1440),
  google_calendar_id TEXT,
  google_event_id TEXT,
  google_html_link TEXT,
  sync_error TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK((owner_type='user' AND owner_user_id IS NOT NULL AND sector_id IS NULL)
     OR (owner_type='sector' AND sector_id IS NOT NULL AND owner_user_id IS NULL))
);

CREATE INDEX IF NOT EXISTS idx_user_sectors_sector ON user_sectors(sector_id,user_id);
CREATE INDEX IF NOT EXISTS idx_agenda_events_range ON agenda_events(start_at,end_at);
CREATE INDEX IF NOT EXISTS idx_agenda_events_sector ON agenda_events(sector_id,start_at);

INSERT INTO screens(code,name,description,route,active,icon,sort,nav)
VALUES('agenda','Agenda','Compromissos pessoais e dos setores do usuário','/agenda.html',1,'calendar',38,1)
ON CONFLICT(code) DO UPDATE SET name=excluded.name,description=excluded.description,
  route=excluded.route,icon=excluded.icon,sort=excluded.sort,nav=excluded.nav;

INSERT OR IGNORE INTO permissions(code,name,description,screen_code,module,sort) VALUES
('agenda.view','Consultar agendas','Ver a própria agenda e as agendas dos setores vinculados','agenda','Agenda',10),
('agenda.create','Cadastrar compromissos','Criar compromissos pessoais e nos setores vinculados','agenda','Agenda',20),
('agenda.edit','Editar compromissos','Alterar compromissos próprios ou dos setores vinculados','agenda','Agenda',30),
('agenda.delete','Excluir compromissos','Excluir compromissos próprios ou dos setores vinculados','agenda','Agenda',40),
('sectors.manage','Gerenciar setores','Criar setores e vincular usuários a um ou mais setores','platform','Plataforma',65);

