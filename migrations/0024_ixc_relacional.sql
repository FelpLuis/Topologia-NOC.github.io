-- Espelho relacional do IXC no banco da plataforma.
--
-- O objetivo é reproduzir a mesma estrutura do ERP: cada entidade vira tabela
-- própria, chaveada pelo CÓDIGO que o IXC usa (id do cliente, id do contrato,
-- código da cidade, código da UF), e não por um id sintético. Assim o banco
-- mantém os vínculos originais e permite join a partir de cliente_cadastro, que
-- guarda esses mesmos códigos nas colunas ixc_cidade_cod / ixc_uf_cod /
-- ixc_contrato_id / ixc_login.
--
-- Alimentado por backend/scripts/ixc-clientes-sync.mjs (collectIxcRaw).

CREATE TABLE IF NOT EXISTS ixc_uf (
  id TEXT PRIMARY KEY,
  cod_uf TEXT NOT NULL DEFAULT '',
  nome TEXT NOT NULL DEFAULT '',
  sigla TEXT NOT NULL DEFAULT '',
  cod_ibge TEXT NOT NULL DEFAULT '',
  regiao TEXT NOT NULL DEFAULT '',
  id_pais TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS ixc_cidade (
  id TEXT PRIMARY KEY,
  nome TEXT NOT NULL DEFAULT '',
  uf TEXT NOT NULL DEFAULT '',       -- código da UF (igual ao usado em cliente.uf)
  cod_ibge TEXT NOT NULL DEFAULT '',
  regiao TEXT NOT NULL DEFAULT '',
  cod_siafi TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS ixc_cliente (
  id TEXT PRIMARY KEY,
  razao TEXT NOT NULL DEFAULT '',
  fantasia TEXT NOT NULL DEFAULT '',
  cnpj_cpf TEXT NOT NULL DEFAULT '',
  tipo_pessoa TEXT NOT NULL DEFAULT '',
  endereco TEXT NOT NULL DEFAULT '',
  numero TEXT NOT NULL DEFAULT '',
  bairro TEXT NOT NULL DEFAULT '',
  cidade TEXT NOT NULL DEFAULT '',     -- CÓDIGO da cidade (não o nome)
  uf TEXT NOT NULL DEFAULT '',         -- CÓDIGO da UF (não a sigla)
  cep TEXT NOT NULL DEFAULT '',
  latitude TEXT NOT NULL DEFAULT '',
  longitude TEXT NOT NULL DEFAULT '',
  telefone TEXT NOT NULL DEFAULT '',
  email TEXT NOT NULL DEFAULT '',
  ativo TEXT NOT NULL DEFAULT '',
  data_cadastro TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS ixc_cliente_contrato (
  id TEXT PRIMARY KEY,
  id_cliente TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT '',
  status_internet TEXT NOT NULL DEFAULT '',
  contrato TEXT NOT NULL DEFAULT '',   -- nome do plano (ex.: "PLANO FIBRA 80 MEGA")
  data_ativacao TEXT NOT NULL DEFAULT '',
  data_cancelamento TEXT NOT NULL DEFAULT '',
  id_produto TEXT NOT NULL DEFAULT '',
  valor TEXT NOT NULL DEFAULT '',
  endereco TEXT NOT NULL DEFAULT '',
  numero TEXT NOT NULL DEFAULT '',
  bairro TEXT NOT NULL DEFAULT '',
  cidade TEXT NOT NULL DEFAULT '',
  uf TEXT NOT NULL DEFAULT '',
  cep TEXT NOT NULL DEFAULT '',
  latitude TEXT NOT NULL DEFAULT '',
  longitude TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_ixc_contrato_cliente ON ixc_cliente_contrato(id_cliente);

CREATE TABLE IF NOT EXISTS ixc_radusuario (
  login TEXT PRIMARY KEY,
  id_cliente TEXT NOT NULL DEFAULT '',
  id_contrato TEXT NOT NULL DEFAULT '',
  online TEXT NOT NULL DEFAULT '',
  ip TEXT NOT NULL DEFAULT '',
  velocidade_download TEXT NOT NULL DEFAULT '',
  velocidade_upload TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_ixc_radusuario_cliente ON ixc_radusuario(id_cliente);

-- As colunas de vínculo em cliente_cadastro (ixc_cidade_cod, ixc_uf_cod,
-- ixc_contrato_id, ixc_login) são criadas pelo bootstrap do Worker
-- (src/worker.js: DDL da cliente_cadastro + ensureColumns) e pelo próprio
-- script de importação, que faz o ALTER de forma idempotente. Aqui só criamos
-- as tabelas relacionais, que são o espelho fiel do IXC.
