#!/usr/bin/env node
//
// Importa TODOS os clientes (e a estrutura relacional) do IXC para o banco.
//
// Além de alimentar a tabela operacional cliente_cadastro (consumida pela tela
// "Cadastro de Cliente"), este script espelha no banco a própria estrutura
// relacional do IXC: ixc_uf, ixc_cidade, ixc_cliente, ixc_cliente_contrato e
// ixc_radusuario, cada uma chaveada pelo CÓDIGO que o ERP usa. Assim o banco
// reproduz os vínculos originais e permite join a partir de cliente_cadastro,
// que guarda esses mesmos códigos (ixc_cidade_cod, ixc_uf_cod,
// ixc_contrato_id, ixc_login).
//
// Regras (idênticas às do Worker):
//   - cliente_cadastro: client_id = código do cliente no IXC; origem='ixc';
//     não sobrescreve cadastro editado à mão (updated_by IS NOT NULL); campo
//     vazio não apaga o que já estava gravado.
//   - tabelas ixc_*: upsert completo por código (espelho fiel do ERP).
//
// Uso:
//   node backend/scripts/ixc-clientes-sync.mjs            # simula e gera preview
//   node backend/scripts/ixc-clientes-sync.mjs --apply    # grava no Turso
//
// Credenciais (lidas de .env.production, .dev.vars, .collector.env ou ambiente):
//   IXC_BASE_URL=https://SEU-IXC/webservice/v1
//   IXC_API_TOKEN=usuario:senha_ou_token
//   TURSO_DATABASE_URL=libsql://SEU-BANCO.turso.io
//   TURSO_AUTH_TOKEN=SEU_TOKEN

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@libsql/client";

import { collectIxcRaw, buildIxcCustomerCadastros } from "../../collector/ixc-client.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

/* Campos do IXC que o cliente_cadastro escreve e pode reescrever. */
const IXC_FIELDS = [
  "nome", "documento", "telefone", "email", "endereco", "bairro", "cidade",
  "uf", "cep", "lat", "lon", "plano", "valor_mensal", "vencimento_dia",
  "status_faturamento", "login_pppoe", "ixc_cidade_cod", "ixc_uf_cod",
  "ixc_contrato_id", "ixc_login",
];

const RELACIONAL_DDL = `
CREATE TABLE IF NOT EXISTS ixc_uf (
  id TEXT PRIMARY KEY, cod_uf TEXT NOT NULL DEFAULT '', nome TEXT NOT NULL DEFAULT '',
  sigla TEXT NOT NULL DEFAULT '', cod_ibge TEXT NOT NULL DEFAULT '',
  regiao TEXT NOT NULL DEFAULT '', id_pais TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS ixc_cidade (
  id TEXT PRIMARY KEY, nome TEXT NOT NULL DEFAULT '', uf TEXT NOT NULL DEFAULT '',
  cod_ibge TEXT NOT NULL DEFAULT '', regiao TEXT NOT NULL DEFAULT '', cod_siafi TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS ixc_cliente (
  id TEXT PRIMARY KEY, razao TEXT NOT NULL DEFAULT '', fantasia TEXT NOT NULL DEFAULT '',
  cnpj_cpf TEXT NOT NULL DEFAULT '', tipo_pessoa TEXT NOT NULL DEFAULT '',
  endereco TEXT NOT NULL DEFAULT '', numero TEXT NOT NULL DEFAULT '', bairro TEXT NOT NULL DEFAULT '',
  cidade TEXT NOT NULL DEFAULT '', uf TEXT NOT NULL DEFAULT '', cep TEXT NOT NULL DEFAULT '',
  latitude TEXT NOT NULL DEFAULT '', longitude TEXT NOT NULL DEFAULT '',
  telefone TEXT NOT NULL DEFAULT '', email TEXT NOT NULL DEFAULT '',
  ativo TEXT NOT NULL DEFAULT '', data_cadastro TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS ixc_cliente_contrato (
  id TEXT PRIMARY KEY, id_cliente TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT '',
  status_internet TEXT NOT NULL DEFAULT '', contrato TEXT NOT NULL DEFAULT '',
  data_ativacao TEXT NOT NULL DEFAULT '', data_cancelamento TEXT NOT NULL DEFAULT '',
  id_produto TEXT NOT NULL DEFAULT '', valor TEXT NOT NULL DEFAULT '',
  endereco TEXT NOT NULL DEFAULT '', numero TEXT NOT NULL DEFAULT '', bairro TEXT NOT NULL DEFAULT '',
  cidade TEXT NOT NULL DEFAULT '', uf TEXT NOT NULL DEFAULT '', cep TEXT NOT NULL DEFAULT '',
  latitude TEXT NOT NULL DEFAULT '', longitude TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_ixc_contrato_cliente ON ixc_cliente_contrato(id_cliente);
CREATE TABLE IF NOT EXISTS ixc_radusuario (
  login TEXT PRIMARY KEY, id_cliente TEXT NOT NULL DEFAULT '', id_contrato TEXT NOT NULL DEFAULT '',
  online TEXT NOT NULL DEFAULT '', ip TEXT NOT NULL DEFAULT '',
  velocidade_download TEXT NOT NULL DEFAULT '', velocidade_upload TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_ixc_radusuario_cliente ON ixc_radusuario(id_cliente);
`;

function loadEnv() {
  const env = { ...process.env };
  for (const file of [".env.production", ".dev.vars", ".collector.env"]) {
    try {
      const text = readFileSync(resolve(ROOT, file), "utf8");
      for (const line of text.split(/\r?\n/)) {
        const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
        if (!match) continue;
        let value = match[2];
        if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
        if (!env[match[1]]) env[match[1]] = value;
      }
    } catch {
      // arquivo opcional
    }
  }
  return env;
}

/* Igual ao Worker: valor preenchido e diferente do atual. Vazio não conta. */
function mudouCampo(novo, atual) {
  if (novo === null || novo === undefined || novo === "") return false;
  if (typeof novo === "number") return Number(atual) !== novo;
  return String(atual ?? "") !== String(novo);
}

/* O driver libsql executa uma instrução por vez; dividimos blocos de DDL. */
async function execMany(db, sql) {
  for (const stmt of sql.split(";")) {
    const trimmed = stmt.trim();
    if (trimmed) await db.execute(trimmed);
  }
}

const env = loadEnv();
const apply = process.argv.includes("--apply");

const ixcBaseUrl = String(env.IXC_BASE_URL || "").trim().replace(/\/+$/, "");
const ixcToken = String(env.IXC_API_TOKEN || "").trim();
if (!ixcBaseUrl || !ixcToken) {
  console.error("Credenciais do IXC ausentes: defina IXC_BASE_URL e IXC_API_TOKEN.");
  process.exit(1);
}
const tursoUrl = String(env.TURSO_DATABASE_URL || "").trim();
const tursoToken = String(env.TURSO_AUTH_TOKEN || "").trim();
if (!tursoUrl || !tursoToken) {
  console.error("Credenciais do Turso ausentes: defina TURSO_DATABASE_URL e TURSO_AUTH_TOKEN.");
  process.exit(1);
}

console.log("Consultando o IXC (cliente + contrato + login + cidade + uf)...");
const raw = await collectIxcRaw({ baseUrl: ixcBaseUrl, token: ixcToken });
const cadastros = buildIxcCustomerCadastros({
  customers: raw.clientes,
  contracts: raw.contratos,
  logins: raw.logins,
  cidades: raw.cidades,
  ufs: raw.ufs,
});
console.log(`  clientes no IXC............. ${(raw.clientes || []).length}`);
console.log(`  contratos................... ${(raw.contratos || []).length}`);
console.log(`  logins (radusuarios)........ ${(raw.logins || []).length}`);
console.log(`  cidades..................... ${(raw.cidades || []).length}`);
console.log(`  ufs......................... ${(raw.ufs || []).length}`);

const db = createClient({ url: tursoUrl, authToken: tursoToken });
await execMany(db, RELACIONAL_DDL);

const tabela = await db.execute(
  `SELECT name FROM sqlite_master WHERE type='table' AND name='cliente_cadastro'`
);
if (!tabela.rows.length) {
  console.error("Tabela cliente_cadastro não encontrada no banco.");
  console.error("A tabela cliente_cadastro é criada pelo deploy do Worker (src/worker.js). Rode 'npm run deploy' antes da importação.");
  await db.close();
  process.exit(1);
}
/* Garante as colunas de vínculo com a estrutura relacional, caso o Worker ainda
   não tenha rodado o ensureColumns neste banco. */
/* Garante as colunas de vínculo com a estrutura relacional, caso o Worker ainda
   não tenha rodado o ensureColumns neste banco (idempotente). */
{
  const info = await db.execute(`PRAGMA table_info(cliente_cadastro)`);
  const existentes = new Set(info.rows.map((r) => r.name));
  const novas = [
    "ixc_cidade_cod", "ixc_uf_cod", "ixc_contrato_id", "ixc_login",
  ].filter((c) => !existentes.has(c));
  for (const col of novas) {
    await db.execute(`ALTER TABLE cliente_cadastro ADD COLUMN ${col} TEXT NOT NULL DEFAULT ''`);
  }
}

/* ---- importação das tabelas relacionais (espelho fiel do IXC) ---- */
async function upsertTabela(nome, chave, colunas, linhas) {
  if (!apply) return linhas.length;
  const stmts = linhas.map((linha) => ({
    sql:
      `INSERT INTO ${nome} (${[chave, ...colunas].join(",")}) VALUES (?, ${colunas.map(() => "?").join(",")}) ` +
      `ON CONFLICT(${chave}) DO UPDATE SET ${colunas.map((c) => `${c}=excluded.${c}`).join(",")}`,
    args: [linha[chave], ...colunas.map((c) => linha[c] ?? null)],
  }));
  let feitos = 0;
  for (let i = 0; i < stmts.length; i += 500) {
    await db.batch(stmts.slice(i, i + 500));
    feitos += Math.min(500, stmts.length - i);
    console.log(`  ${nome}: ${feitos}/${stmts.length}`);
  }
  return stmts.length;
}

const T = (v) => (v === undefined || v === null ? "" : String(v));

const relacional = {
  ixc_uf: await upsertTabela("ixc_uf", "id",
    ["cod_uf", "nome", "sigla", "cod_ibge", "regiao", "id_pais"],
    (raw.ufs || []).map((u) => ({ id: T(u.id), cod_uf: T(u.cod_uf), nome: T(u.nome), sigla: T(u.sigla), cod_ibge: T(u.cod_ibge), regiao: T(u.regiao), id_pais: T(u.id_pais) }))),
  ixc_cidade: await upsertTabela("ixc_cidade", "id",
    ["nome", "uf", "cod_ibge", "regiao", "cod_siafi"],
    (raw.cidades || []).map((c) => ({ id: T(c.id), nome: T(c.nome), uf: T(c.uf), cod_ibge: T(c.cod_ibge), regiao: T(c.regiao), cod_siafi: T(c.cod_siafi) }))),
  ixc_cliente: await upsertTabela("ixc_cliente", "id",
    ["razao", "fantasia", "cnpj_cpf", "tipo_pessoa", "endereco", "numero", "bairro", "cidade", "uf", "cep", "latitude", "longitude", "telefone", "email", "ativo", "data_cadastro"],
    (raw.clientes || []).map((c) => ({ id: T(c.id), razao: T(c.razao), fantasia: T(c.fantasia), cnpj_cpf: T(c.cnpj_cpf), tipo_pessoa: T(c.tipo_pessoa), endereco: T(c.endereco), numero: T(c.numero), bairro: T(c.bairro), cidade: T(c.cidade), uf: T(c.uf), cep: T(c.cep), latitude: T(c.latitude), longitude: T(c.longitude), telefone: T(c.telefone), email: T(c.email), ativo: T(c.ativo), data_cadastro: T(c.data_cadastro) }))),
  ixc_cliente_contrato: await upsertTabela("ixc_cliente_contrato", "id",
    ["id_cliente", "status", "status_internet", "contrato", "data_ativacao", "data_cancelamento", "id_produto", "valor", "endereco", "numero", "bairro", "cidade", "uf", "cep", "latitude", "longitude"],
    (raw.contratos || []).map((c) => ({ id: T(c.id), id_cliente: T(c.id_cliente), status: T(c.status), status_internet: T(c.status_internet), contrato: T(c.contrato), data_ativacao: T(c.data_ativacao), data_cancelamento: T(c.data_cancelamento), id_produto: T(c.id_produto), valor: T(c.valor), endereco: T(c.endereco), numero: T(c.numero), bairro: T(c.bairro), cidade: T(c.cidade), uf: T(c.uf), cep: T(c.cep), latitude: T(c.latitude), longitude: T(c.longitude) }))),
  ixc_radusuario: await upsertTabela("ixc_radusuario", "login",
    ["id_cliente", "id_contrato", "online", "ip", "velocidade_download", "velocidade_upload"],
    (raw.logins || []).map((l) => ({ login: T(l.login), id_cliente: T(l.id_cliente), id_contrato: T(l.id_contrato), online: T(l.online), ip: T(l.ip), velocidade_download: T(l.velocidade_download), velocidade_upload: T(l.velocidade_upload) }))),
};

/* ---- alimentação do cliente_cadastro (tela) ---- */
const existentesResult = await db.execute(
  `SELECT client_id, ixc_id, origem, updated_by, ${IXC_FIELDS.join(",")} FROM cliente_cadastro`
);
const rows = existentesResult.rows;
const porClientId = new Map();
const porIxc = new Map();
for (const row of rows) {
  porClientId.set(String(row.client_id), row);
  const ixc = String(row.ixc_id || "").trim();
  if (ixc && !porIxc.has(ixc)) porIxc.set(ixc, row);
}
console.log(`\ncliente_cadastro já existentes... ${rows.length}`);

const inserts = [];
const updates = [];
for (const c of cadastros) {
  const clientId = String(c.client_id);
  const atual = porClientId.get(clientId) || porIxc.get(String(c.ixc_id).trim());
  if (!atual) {
    inserts.push(c);
    continue;
  }
  /* Espelho do IXC: só reescreve quem nasceu da coleta e ninguém editou. */
  if (String(atual.origem) !== "ixc" || atual.updated_by !== null) continue;
  const campos = IXC_FIELDS.filter((campo) => mudouCampo(c[campo], atual[campo]));
  if (campos.length) updates.push({ client_id: clientId, campos, valores: campos.map((campo) => c[campo]) });
}

mkdirSync(resolve(ROOT, "backend/data"), { recursive: true });
const previewPath = resolve(ROOT, "backend/data/ixc-clientes-preview.json");
writeFileSync(previewPath, JSON.stringify({
  gerado_em: new Date().toISOString(),
  relacional,
  total_ixc: cadastros.length,
  insercoes: inserts.length,
  atualizacoes: updates.length,
  amostra: cadastros.slice(0, 5),
}, null, 2), "utf8");
console.log(`\nPreview: ${previewPath}`);
console.log(`  a inserir (cadastro)........ ${inserts.length}`);
console.log(`  a atualizar (cadastro)...... ${updates.length}`);

if (!apply) {
  console.log("\nPara gravar no banco:");
  console.log("  node backend/scripts/ixc-clientes-sync.mjs --apply");
  await db.close();
  process.exit(0);
}

console.log("\nGravando cliente_cadastro no Turso...");
let escritos = 0;
if (inserts.length) {
  const stmts = inserts.map((c) => ({
    sql:
      `INSERT INTO cliente_cadastro (client_id, ixc_id, origem, ${IXC_FIELDS.join(",")}, created_at, updated_at) ` +
      `VALUES (?, ?, 'ixc', ${IXC_FIELDS.map(() => "?").join(",")}, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP) ` +
      `ON CONFLICT(client_id) DO NOTHING`,
    args: [c.client_id, c.ixc_id, ...IXC_FIELDS.map((campo) => c[campo] ?? null)],
  }));
  for (let i = 0; i < stmts.length; i += 500) {
    const lote = stmts.slice(i, i + 500);
    await db.batch(lote);
    escritos += lote.length;
    console.log(`  inseridos ${escritos}/${inserts.length}`);
  }
}

let atualizados = 0;
if (updates.length) {
  const stmts = updates.map((u) => ({
    sql:
      `UPDATE cliente_cadastro SET ${u.campos.map((campo) => `${campo}=?`).join(",")}, updated_at=CURRENT_TIMESTAMP ` +
      `WHERE client_id=? AND origem='ixc' AND updated_by IS NULL`,
    args: [...u.valores, u.client_id],
  }));
  for (let i = 0; i < stmts.length; i += 500) {
    const lote = stmts.slice(i, i + 500);
    await db.batch(lote);
    atualizados += lote.length;
    console.log(`  atualizados ${atualizados}/${updates.length}`);
  }
}

console.log(`\nConcluído: ${escritos} inseridos, ${atualizados} atualizados no cliente_cadastro.`);
await db.close();
