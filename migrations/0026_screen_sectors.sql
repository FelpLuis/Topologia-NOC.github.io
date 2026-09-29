-- Uma tela pode aparecer em mais de um setor do menu.
-- screens.sector_id vira só a origem desta cópia e deixa de ser lida; tela sem
-- vínculo nenhum continua caindo no bloco NOC.
CREATE TABLE IF NOT EXISTS screen_sectors (
  screen_id INTEGER NOT NULL REFERENCES screens(id) ON DELETE CASCADE,
  sector_id INTEGER NOT NULL REFERENCES sectors(id) ON DELETE CASCADE,
  PRIMARY KEY (screen_id, sector_id)
);
CREATE INDEX IF NOT EXISTS idx_screen_sectors_sector ON screen_sectors(sector_id,screen_id);

INSERT OR IGNORE INTO screen_sectors(screen_id,sector_id)
SELECT id,sector_id FROM screens WHERE sector_id IS NOT NULL;
