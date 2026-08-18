-- Setores passam a controlar também os blocos do menu lateral.
ALTER TABLE sectors ADD COLUMN icon TEXT NOT NULL DEFAULT 'circle';
ALTER TABLE sectors ADD COLUMN sort INTEGER NOT NULL DEFAULT 0;
ALTER TABLE screens ADD COLUMN sector_id INTEGER REFERENCES sectors(id) ON DELETE SET NULL;

INSERT OR IGNORE INTO sectors(code,name,description,color,icon,sort,active) VALUES
  ('atendimento','HELPDESK','Atendimento e suporte ao cliente','#06b6d4','user',10,1),
  ('logistica','LOGÍSTICA','Operação logística','#f59e0b','pops',20,1),
  ('comercial','COMERCIAL','Operação comercial','#8b5cf6','dashboard',30,1),
  ('sac','SAC','Serviço de atendimento ao consumidor','#ec4899','bell',40,1),
  ('financeiro','FINANCEIRO','Operação financeira','#22c55e','finance',50,1),
  ('noc','NOC','Operação, monitoramento e topologias de rede','#2563eb','topology',60,1);

UPDATE screens
SET sector_id=(SELECT id FROM sectors WHERE code='noc')
WHERE sector_id IS NULL;
