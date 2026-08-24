-- Senha própria do cliente para o app (papel "cliente" / Central do
-- Assinante interna), separada de senha_pppoe_cipher.
--
-- senha_pppoe_cipher é editada por staff na tela "Cadastro de Cliente" para
-- outro fim (a senha PPPoE do roteador). Reaproveitá-la para o login do app
-- faria uma alteração de staff derrubar a sessão do cliente e vice-versa.
--
-- portal_must_change_password começa em 1: quando staff atribui a senha
-- inicial do app, o cliente é obrigado a trocá-la no primeiro acesso (mesmo
-- padrão já usado em users.must_change_password para o staff).
--
-- O Worker cria estas colunas no start (SCHEMA/ensureColumns); este arquivo
-- existe para aplicar a mesma estrutura por migration no D1/Turso.

ALTER TABLE cliente_cadastro ADD COLUMN senha_portal_cipher TEXT NOT NULL DEFAULT '';
ALTER TABLE cliente_cadastro ADD COLUMN portal_must_change_password INTEGER NOT NULL DEFAULT 1;
