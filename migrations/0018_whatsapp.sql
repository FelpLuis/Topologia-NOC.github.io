-- Atendimento por WhatsApp (WhatsApp Cloud API da Meta).
-- O número é único e o bot direciona o cliente para o setor escolhido; o
-- atendente "pega" a conversa e fica em atendimento até encerrá-la. O
-- supervisor (whatsapp.supervise) enxerga com quem cada colega conversa.

CREATE TABLE IF NOT EXISTS wa_conversations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  phone TEXT NOT NULL,
  customer_name TEXT NOT NULL DEFAULT '',
  sector_id INTEGER REFERENCES sectors(id) ON DELETE SET NULL,
  assigned_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'routing' CHECK(status IN ('routing','open','closed')),
  routing_attempts INTEGER NOT NULL DEFAULT 0,
  last_message TEXT NOT NULL DEFAULT '',
  last_message_at TEXT,
  unread INTEGER NOT NULL DEFAULT 0,
  closed_at TEXT,
  closed_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS wa_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id INTEGER NOT NULL REFERENCES wa_conversations(id) ON DELETE CASCADE,
  direction TEXT NOT NULL CHECK(direction IN ('in','out','bot')),
  type TEXT NOT NULL DEFAULT 'text',
  body TEXT NOT NULL DEFAULT '',
  wa_message_id TEXT,
  status TEXT NOT NULL DEFAULT 'sent' CHECK(status IN ('sent','delivered','read','failed')),
  sender_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  sender_name TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS wa_agent_presence (
  user_id INTEGER NOT NULL PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  available INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS wa_contacts (
  phone TEXT PRIMARY KEY,
  name TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_wa_conv_phone_status ON wa_conversations(phone,status);
CREATE INDEX IF NOT EXISTS idx_wa_conv_sector ON wa_conversations(sector_id,status,updated_at);
CREATE INDEX IF NOT EXISTS idx_wa_conv_assignee ON wa_conversations(assigned_user_id,status,updated_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_wa_msg_wamid ON wa_messages(wa_message_id) WHERE wa_message_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_wa_msg_conv ON wa_messages(conversation_id,created_at);