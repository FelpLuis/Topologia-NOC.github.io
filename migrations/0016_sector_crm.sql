-- CRM operacional compartilhado, separado pelos setores já existentes.
-- Cada oportunidade/solicitação pertence a um setor e carrega seu próprio
-- histórico de contatos, notas e mudanças de etapa.

CREATE TABLE IF NOT EXISTS crm_stages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sector_id INTEGER NOT NULL REFERENCES sectors(id) ON DELETE CASCADE,
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  color TEXT NOT NULL DEFAULT '#2563eb',
  sort INTEGER NOT NULL DEFAULT 0,
  is_closed INTEGER NOT NULL DEFAULT 0,
  is_won INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  UNIQUE(sector_id, code)
);

CREATE TABLE IF NOT EXISTS crm_cases (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sector_id INTEGER NOT NULL REFERENCES sectors(id),
  stage_id INTEGER NOT NULL REFERENCES crm_stages(id),
  assigned_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  creator_user_id INTEGER NOT NULL REFERENCES users(id),
  title TEXT NOT NULL,
  customer_name TEXT NOT NULL,
  customer_document TEXT NOT NULL DEFAULT '',
  phone TEXT NOT NULL DEFAULT '',
  email TEXT NOT NULL DEFAULT '',
  city TEXT NOT NULL DEFAULT '',
  address TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT '',
  priority TEXT NOT NULL DEFAULT 'normal' CHECK(priority IN ('low','normal','high','urgent')),
  estimated_value REAL NOT NULL DEFAULT 0,
  next_contact_at TEXT,
  details TEXT NOT NULL DEFAULT '',
  tags TEXT NOT NULL DEFAULT '',
  closed_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS crm_activities (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  case_id INTEGER NOT NULL REFERENCES crm_cases(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id),
  kind TEXT NOT NULL DEFAULT 'note' CHECK(kind IN ('note','call','whatsapp','email','meeting','status','system')),
  body TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_crm_cases_sector_stage ON crm_cases(sector_id,stage_id,updated_at);
CREATE INDEX IF NOT EXISTS idx_crm_cases_assignee ON crm_cases(assigned_user_id,updated_at);
CREATE INDEX IF NOT EXISTS idx_crm_cases_next_contact ON crm_cases(next_contact_at);
CREATE INDEX IF NOT EXISTS idx_crm_activities_case ON crm_activities(case_id,created_at);

INSERT INTO screens(code,name,description,route,active,icon,sort,nav,sector_id)
VALUES('crm','Central CRM','Leads, clientes, solicitações e histórico separados por setor','/crm.html',1,'users',25,1,
       (SELECT id FROM sectors WHERE code='comercial'))
ON CONFLICT(code) DO UPDATE SET name=excluded.name,description=excluded.description,
  route=excluded.route,icon=excluded.icon,sort=excluded.sort,nav=excluded.nav;

INSERT OR IGNORE INTO permissions(code,name,description,screen_code,module,sort) VALUES
('crm.view','Consultar CRM','Ver registros dos setores aos quais o usuário pertence','crm','CRM',10),
('crm.create','Cadastrar no CRM','Criar leads, oportunidades e solicitações nos setores permitidos','crm','CRM',20),
('crm.edit','Editar CRM','Alterar dados, responsáveis, etapas e próximos contatos','crm','CRM',30),
('crm.interact','Registrar interações','Adicionar ligações, mensagens, reuniões, e-mails e notas ao histórico','crm','CRM',40),
('crm.delete','Excluir do CRM','Excluir registros e todo o histórico relacionado','crm','CRM',50);
