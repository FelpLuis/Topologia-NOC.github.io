-- Cadastro de cliente chaveado pelo código do IXC.
--
-- O Worker aplica estas colunas sozinho no start (ensureColumns); este arquivo
-- existe para aplicar a mesma estrutura por migration no D1/Turso.
--
-- Todo cliente que a coleta GPON traz com código do IXC passa a virar cadastro
-- automaticamente, usando o mesmo número que o operador procura no ERP — e não
-- o id sintético da ONU. 'origem' separa quem entrou pela importação ('ixc') de
-- quem foi digitado na tela ('manual'); a importação só cria, nunca sobrescreve
-- o que o operador corrigiu depois.

ALTER TABLE cliente_cadastro ADD COLUMN ixc_id TEXT NOT NULL DEFAULT '';
ALTER TABLE cliente_cadastro ADD COLUMN origem TEXT NOT NULL DEFAULT 'manual';

CREATE INDEX IF NOT EXISTS idx_cliente_cadastro_ixc ON cliente_cadastro(ixc_id);

-- Cadastros que já existiam foram digitados à mão.
UPDATE cliente_cadastro SET origem='manual' WHERE origem IS NULL OR origem='';
