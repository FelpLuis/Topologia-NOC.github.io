-- Catálogo de telas e ações (funcionalidades) do sistema.
-- Cada tela é declarada em `screens` e cada funcionalidade em `permissions`,
-- para que ambas apareçam em Plataforma → Perfis e possam ser marcadas por perfil.
--
-- O Worker aplica estas mesmas mudanças na inicialização (ensureDatabaseImpl),
-- inclusive os ALTER TABLE. Este arquivo existe para quem prefere aplicar as
-- migrations com `wrangler d1 migrations apply`.
--
-- Observação: SQLite não tem "ADD COLUMN IF NOT EXISTS". Em bancos que já
-- passaram pelo Worker, os ALTER TABLE abaixo falham por coluna duplicada —
-- nesse caso a migration pode ser marcada como aplicada sem executar.

ALTER TABLE permissions ADD COLUMN name TEXT NOT NULL DEFAULT '';
ALTER TABLE permissions ADD COLUMN module TEXT NOT NULL DEFAULT 'Geral';
ALTER TABLE permissions ADD COLUMN screen_code TEXT;
ALTER TABLE permissions ADD COLUMN sort INTEGER NOT NULL DEFAULT 0;

ALTER TABLE screens ADD COLUMN icon TEXT NOT NULL DEFAULT 'topology';
ALTER TABLE screens ADD COLUMN sort INTEGER NOT NULL DEFAULT 0;
ALTER TABLE screens ADD COLUMN nav INTEGER NOT NULL DEFAULT 1;

-- Registra o que já foi semeado uma vez. Sem isso, um deploy devolveria as
-- ações que o administrador tirou de um perfil.
CREATE TABLE IF NOT EXISTS platform_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Telas navegáveis do sistema.
INSERT INTO screens(code,name,description,route,active,icon,sort,nav) VALUES
('network','Topologia','Mapa por localidade, equipamentos, portas e enlaces','/',1,'topology',10,1),
('pops','POPs e anel óptico','Inventário por POP, rotas ópticas e sequência do anel','/pops.html',1,'pops',20,1),
('dashboard','Dashboard NOC','Painel operacional para TV/NOC','/dashboard.html',1,'dashboard',30,1),
('platform','Gerenciar plataforma','Perfis, ações, telas, usuários e auditoria','/platform.html',1,'platform',40,1),
('legado','Editor clássico','Editor legado da topologia em tela única','/legado.html',1,'edit',50,0)
ON CONFLICT(code) DO UPDATE SET
  name=excluded.name, description=excluded.description, route=excluded.route,
  icon=excluded.icon, sort=excluded.sort, nav=excluded.nav;

-- Ações do sistema. A tela diz onde o perfil entra; a ação diz o que ele faz lá.
INSERT INTO permissions(code,name,description,screen_code,module,sort) VALUES
('topology.view','Visualizar a topologia','Ler equipamentos, POPs, portas e enlaces','network','Topologia',10),
('topology.edit','Alterar a topologia','Permissão base para qualquer gravação na topologia','network','Topologia',20),
('topology.delete','Excluir na topologia','Permissão base para qualquer remoção na topologia','network','Topologia',30),
('topology.equipment.create','Cadastrar equipamento','Criar novos equipamentos na topologia','network','Topologia',40),
('topology.equipment.edit','Editar equipamento','Alterar nome, modelo, categoria e demais dados','network','Topologia',50),
('topology.equipment.delete','Excluir equipamento','Remover equipamentos da topologia','network','Topologia',60),
('topology.port.edit','Editar portas','Criar, alterar e remover portas de um equipamento','network','Topologia',70),
('topology.link.create','Criar enlace','Documentar enlaces entre portas','network','Topologia',80),
('topology.link.delete','Remover enlace','Desfazer enlaces já documentados','network','Topologia',90),
('topology.pop.link','Vincular equipamento ao POP','Definir ou desfazer o POP de um equipamento','network','Topologia',100),
('topology.layout','Salvar posições do mapa','Gravar o posicionamento manual dos POPs no mapa','network','Topologia',110),
('topology.config','Alterar configurações do mapa','Títulos e demais parâmetros de exibição da topologia','network','Topologia',120),
('zabbix.view','Consultar o Zabbix','Ver hosts, interfaces e status da sincronização','network','Monitoramento (Zabbix)',10),
('zabbix.sync','Sincronizar o Zabbix','Disparar a importação de hosts e interfaces','network','Monitoramento (Zabbix)',20),
('zabbix.link','Vincular host do Zabbix','Associar host monitorado a um equipamento','network','Monitoramento (Zabbix)',30),
('pops.create','Cadastrar POP','Criar novos POPs','pops','POPs e anel',10),
('pops.edit','Editar POP','Alterar nome e dados do POP','pops','POPs e anel',20),
('pops.delete','Excluir POP','Remover POPs do cadastro','pops','POPs e anel',30),
('pops.order','Editar a sequência dos POPs','Reordenar os POPs do anel','pops','POPs e anel',40),
('pops.routes','Editar rotas do anel','Criar e remover rotas aéreas e subterrâneas','pops','POPs e anel',50),
('pops.ring.layout','Salvar desenho do anel','Gravar o posicionamento manual do mapa do anel','pops','POPs e anel',60),
('roles.view','Consultar perfis','Ver perfis, ações e telas configuradas','platform','Plataforma',10),
('roles.manage','Gerenciar perfis','Criar, editar, duplicar e excluir perfis e seus acessos','platform','Plataforma',20),
('screens.manage','Gerenciar telas','Ativar e desativar telas do sistema','platform','Plataforma',30),
('users.view','Consultar usuários','Ver as contas de acesso','platform','Plataforma',40),
('users.manage','Gerenciar usuários','Criar, alterar e ativar/desativar contas','platform','Plataforma',50),
('users.password','Redefinir senha','Definir senha temporária para outras contas','platform','Plataforma',60),
('audit.view','Consultar auditoria','Ver o histórico de ações da plataforma','platform','Plataforma',70),
('audit.export','Exportar auditoria','Baixar o histórico em CSV','platform','Plataforma',80),
('settings.manage','Alterar configurações','Configurações administrativas da plataforma','platform','Plataforma',90)
ON CONFLICT(code) DO UPDATE SET
  name=excluded.name, description=excluded.description,
  screen_code=excluded.screen_code, module=excluded.module, sort=excluded.sort;

-- O administrador mantém acesso total: é a garantia de reabrir o sistema.
INSERT OR IGNORE INTO role_permissions(role_id,permission_id)
SELECT r.id, p.id FROM roles r, permissions p WHERE r.name='administrador';

INSERT OR IGNORE INTO role_screens(role_id,screen_id)
SELECT r.id, s.id FROM roles r, screens s WHERE r.name='administrador';
