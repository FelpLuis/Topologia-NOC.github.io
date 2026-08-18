-- Importação gratuita e permanente de agendas por arquivo iCalendar (.ics).
-- Eventos importados pertencem à agenda pessoal e permanecem somente leitura.

-- A integração anterior foi removida; apagar estas tabelas também elimina os
-- tokens OAuth antigos que não têm mais utilidade.
DROP TABLE IF EXISTS google_calendar_states;
DROP TABLE IF EXISTS google_calendar_connections;

ALTER TABLE agenda_events ADD COLUMN source TEXT NOT NULL DEFAULT 'updown';
ALTER TABLE agenda_events ADD COLUMN external_uid TEXT;
ALTER TABLE agenda_events ADD COLUMN imported_at TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_agenda_ics_external
  ON agenda_events(owner_user_id,external_uid)
  WHERE source='ics' AND external_uid IS NOT NULL;
