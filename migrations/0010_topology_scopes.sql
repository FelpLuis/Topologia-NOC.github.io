-- PARTE ISP: topologias além da rede principal.
-- topology_state nasceu com CHECK(id=1) e continua sendo a da rede NOC.
-- Cada recorte adicional (hoje só "isp") é uma linha aqui, com o mesmo
-- formato de documento e o mesmo controle de versão.
CREATE TABLE IF NOT EXISTS topology_scopes (
  scope TEXT PRIMARY KEY,
  data_json TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL
);
