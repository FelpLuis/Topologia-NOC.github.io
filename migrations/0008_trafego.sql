-- Painel de tráfego: histórico agregado e ajustes da tela.
--
-- O Worker aplica estas mesmas mudanças na inicialização (ensureDatabaseImpl).
-- Este arquivo existe para quem prefere aplicar com
-- `wrangler d1 migrations apply`.
--
-- Histórico: uma linha por sincronização, com o total da rede. A série por
-- interface continua no Zabbix — aqui só vive o agregado que o painel desenha,
-- o que mantém a escrita em 1 registro por ciclo em vez de milhares.

CREATE TABLE IF NOT EXISTS zabbix_traffic_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  taken_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  in_bps INTEGER NOT NULL DEFAULT 0,
  out_bps INTEGER NOT NULL DEFAULT 0,
  interfaces_total INTEGER NOT NULL DEFAULT 0,
  interfaces_up INTEGER NOT NULL DEFAULT 0,
  interfaces_saturadas INTEGER NOT NULL DEFAULT 0,
  erros INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_zbx_snapshots_taken ON zabbix_traffic_snapshots(taken_at);

-- Ação nova do catálogo. O Worker semeia ACTIONS e ROLE_PERMISSIONS sozinho
-- quando a impressão digital do schema muda; o INSERT abaixo só adianta o
-- registro para quem aplica as migrations à mão.
INSERT OR IGNORE INTO permissions(code,name,description,module,screen_code,sort) VALUES
('trafego.settings','Configurar o painel de tráfego',
 'Limites de utilização, atualização, apelidos de interface e painéis do modo TV',
 'Tráfego','trafego',10);

-- Os ajustes do painel ficam em platform_meta, chave 'trafego.settings'.
-- Nenhuma tabela nova é necessária para eles.
