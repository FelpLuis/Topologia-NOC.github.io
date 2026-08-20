-- Cadastro único de locais (POP / Data Center / ISP) e de produtos
-- (equipamentos). Substituem os arrays "pops" e "equipamentos" que viviam
-- soltos dentro do JSON de cada recorte de topologia.
CREATE TABLE IF NOT EXISTS locais (
  id TEXT PRIMARY KEY,
  nome TEXT NOT NULL DEFAULT '',
  tipo TEXT NOT NULL DEFAULT 'POP' CHECK (tipo IN ('POP','Data Center','ISP')),
  endereco TEXT NOT NULL DEFAULT '',
  lat REAL,
  lon REAL,
  observacao TEXT NOT NULL DEFAULT '',
  origem TEXT NOT NULL DEFAULT 'manual',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS produtos (
  id TEXT PRIMARY KEY,
  nome TEXT NOT NULL DEFAULT '',
  fabricante TEXT NOT NULL DEFAULT '',
  modelo TEXT NOT NULL DEFAULT '',
  categoria TEXT NOT NULL DEFAULT '',
  serial TEXT NOT NULL DEFAULT '',
  local_id TEXT REFERENCES locais(id) ON DELETE SET NULL,
  escopo TEXT NOT NULL DEFAULT 'noc' CHECK (escopo IN ('noc','isp')),
  observacao TEXT NOT NULL DEFAULT '',
  portas_json TEXT NOT NULL DEFAULT '[]',
  imagem TEXT NOT NULL DEFAULT '',
  imagem_alt TEXT NOT NULL DEFAULT '',
  hotspots_json TEXT NOT NULL DEFAULT '',
  layout_portas TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_produtos_local ON produtos(local_id);
CREATE INDEX IF NOT EXISTS idx_produtos_escopo ON produtos(escopo);

-- Posição no anel e rotas desenhadas são específicas de cada recorte de
-- topologia: o mesmo local físico pode aparecer em posições e traçados
-- diferentes no mapa NOC e no mapa ISP. Por isso ficam ligadas por
-- (scope,local_id), fora de "locais", que guarda só o dado cadastral.
CREATE TABLE IF NOT EXISTS topology_local_links (
  scope TEXT NOT NULL,
  local_id TEXT NOT NULL REFERENCES locais(id) ON DELETE CASCADE,
  ordem INTEGER NOT NULL DEFAULT 0,
  rotas_json TEXT NOT NULL DEFAULT '[]',
  legado_equipamentos_json TEXT NOT NULL DEFAULT '[]',
  PRIMARY KEY (scope, local_id)
);
