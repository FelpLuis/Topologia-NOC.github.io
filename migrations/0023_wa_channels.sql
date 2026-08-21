-- Canais externos no mesmo chat: além do número nativo da Meta, mensagens do
-- Opa!Suite (canal Meta e canal Webchat) passam a cair na mesma fila. 'channel'
-- separa a origem e 'external_id' guarda o identificador da conversa no
-- sistema externo, usado para responder por lá em vez da Graph API da Meta.
--
-- wa_webhook_log guarda o corpo bruto de cada chamada recebida em
-- /api/opasuite/webhook, para conferir o formato real do payload (ainda não
-- documentado publicamente pelo fornecedor) sem precisar reproduzir o envio.
--
-- O Worker aplica isto no start (SCHEMA + ensureColumns); este arquivo existe
-- para aplicar a mesma estrutura por migration no D1/Turso.

ALTER TABLE wa_conversations ADD COLUMN channel TEXT NOT NULL DEFAULT 'whatsapp';
ALTER TABLE wa_conversations ADD COLUMN external_id TEXT NOT NULL DEFAULT '';

CREATE TABLE IF NOT EXISTS wa_webhook_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  channel TEXT NOT NULL,
  payload TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_wa_conv_channel_phone ON wa_conversations(channel,phone);
CREATE INDEX IF NOT EXISTS idx_wa_webhook_log_channel ON wa_webhook_log(channel,created_at);
