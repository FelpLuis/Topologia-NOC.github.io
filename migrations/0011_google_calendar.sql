-- Agenda Google por usuário. O acesso é somente leitura e o refresh token
-- é cifrado no Worker antes de ser persistido no D1.

CREATE TABLE IF NOT EXISTS google_calendar_states (
  state_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_verifier TEXT NOT NULL,
  return_to TEXT NOT NULL DEFAULT '/',
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS google_calendar_connections (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  google_account_id TEXT,
  google_email TEXT NOT NULL DEFAULT '',
  refresh_token_ciphertext TEXT NOT NULL,
  access_token_ciphertext TEXT,
  access_token_expires_at INTEGER,
  calendars_json TEXT NOT NULL DEFAULT '[]',
  alert_minutes INTEGER NOT NULL DEFAULT 10 CHECK(alert_minutes BETWEEN 0 AND 1440),
  active INTEGER NOT NULL DEFAULT 1,
  connected_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_sync_at TEXT,
  last_error TEXT
);

CREATE INDEX IF NOT EXISTS idx_google_calendar_states_expires
  ON google_calendar_states(expires_at);
