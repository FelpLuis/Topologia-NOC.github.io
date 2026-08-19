-- Home: fila de alertas com leitura por usuário.
--
-- O Worker aplica estas mesmas mudanças na inicialização (ensureDatabaseImpl).
-- Este arquivo existe para quem prefere aplicar com
-- `wrangler d1 migrations apply`.
--
-- O painel de tráfego deriva os alertas do zero a cada leitura. Isso responde
-- "o que está acontecendo agora", mas não responde "o que esta pessoa ainda não
-- viu" — para isso o alerta precisa de identidade que atravesse os ciclos.
-- É o papel de `fingerprint`: a mesma condição na mesma interface produz sempre
-- a mesma impressão digital, então o ciclo seguinte atualiza a linha em vez de
-- criar outra.
--
-- Ciclo de vida: o que some da derivação é marcado como resolvido (não é
-- apagado, para não sumir da fila de quem ainda não abriu o sistema hoje); o
-- que reaparece é reaberto, e `reopened_at` invalida as leituras anteriores,
-- porque uma condição que voltou é um evento novo.

CREATE TABLE IF NOT EXISTS alerts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  fingerprint TEXT NOT NULL UNIQUE,
  origem TEXT NOT NULL DEFAULT 'rede',
  grau TEXT NOT NULL DEFAULT 'info',
  titulo TEXT NOT NULL,
  texto TEXT NOT NULL DEFAULT '',
  alvo_tipo TEXT NOT NULL DEFAULT '',
  alvo_chave TEXT NOT NULL DEFAULT '',
  first_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  reopened_at TEXT,
  resolved_at TEXT
);

-- Uma linha por (alerta, usuário): marcar como visto é decisão individual e
-- nunca tira o alerta da fila dos colegas.
CREATE TABLE IF NOT EXISTS alert_reads (
  alert_id INTEGER NOT NULL REFERENCES alerts(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- Sempre gravado em ISO pelo Worker, como first_seen_at e reopened_at. O
  -- padrão do SQLite ("2026-08-19 10:00:00") fica aqui só como rede de
  -- segurança: comparado com o ISO de reopened_at, o espaço perde para o "T"
  -- e uma leitura mais nova passaria por mais antiga.
  read_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (alert_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_alerts_abertos ON alerts(resolved_at,grau,last_seen_at);
CREATE INDEX IF NOT EXISTS idx_alerts_origem ON alerts(origem,resolved_at);
CREATE INDEX IF NOT EXISTS idx_alert_reads_user ON alert_reads(user_id,alert_id);

-- Tela nova do catálogo. O Worker semeia SCREENS e ROLE_SCREENS sozinho quando
-- a impressão digital do schema muda; os comandos abaixo só adiantam o registro
-- para quem aplica as migrations à mão. A topologia BACKBONE deixa de ocupar a
-- raiz, que passa a ser a home.
UPDATE screens SET route='/topologia.html' WHERE code='network';

INSERT INTO screens(code,name,description,route,active,icon,sort,nav,sector_id)
VALUES ('home','Home','Painel de abertura: clientes, tráfego da rede e alertas ainda não vistos',
        '/',1,'home',5,1,(SELECT id FROM sectors WHERE code='noc'))
ON CONFLICT(code) DO UPDATE SET
  name=excluded.name, description=excluded.description, route=excluded.route,
  icon=excluded.icon, sort=excluded.sort, nav=excluded.nav;

-- Todo perfil que já enxerga alguma tela passa a enxergar a home.
INSERT OR IGNORE INTO role_screens(role_id,screen_id)
SELECT DISTINCT rs.role_id, (SELECT id FROM screens WHERE code='home')
FROM role_screens rs;
