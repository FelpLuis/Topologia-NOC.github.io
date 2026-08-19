-- Home: comentário de fechamento ao marcar um alerta como visto.
--
-- O Worker aplica esta mesma mudança na inicialização (ensureDatabaseImpl).
-- Este arquivo existe para quem prefere aplicar com
-- `wrangler d1 migrations apply`.
--
-- A coluna fica em alert_reads, e não em alerts, porque o texto fala da
-- leitura ("o que eu apurei antes de dar baixa") e não da condição: o mesmo
-- alerta continua pendente para os colegas, cada um com o próprio comentário.
-- É opcional por decisão de produto — exigir texto faria a fila parar de ser
-- zerada, e uma fila que ninguém zera deixa de dizer o que ainda não foi visto.

ALTER TABLE alert_reads ADD COLUMN comentario TEXT NOT NULL DEFAULT '';
