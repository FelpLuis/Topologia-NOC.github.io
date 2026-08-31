import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const worker = await readFile(new URL("../src/worker.js", import.meta.url), "utf8");
const page = await readFile(new URL("../public/tickets.html", import.meta.url), "utf8");
const client = await readFile(new URL("../public/js/noc-tickets.js", import.meta.url), "utf8");

test("tickets persistem chamado e andamento com os dois vínculos possíveis", () => {
  assert.match(worker, /CREATE TABLE IF NOT EXISTS tickets/);
  assert.match(worker, /CREATE TABLE IF NOT EXISTS ticket_eventos/);
  // Externo aponta para o cadastro de cliente; interno, para o cadastro de locais.
  assert.match(worker, /client_id TEXT REFERENCES cliente_cadastro\(client_id\)/);
  assert.match(worker, /local_id TEXT REFERENCES locais\(id\)/);
  // Visibilidade por setor, igual à do CRM.
  assert.match(worker, /user_sectors visivel/);
});

test("o vínculo obrigatório de cada natureza é exigido no Worker", () => {
  const validacao = worker.slice(worker.indexOf("async function validarTicketRelacoes"));
  assert.match(validacao, /entrada\.tipo === "externo"[\s\S]*?CLIENTE_OBRIGATORIO/);
  assert.match(validacao, /ESTRUTURA_OBRIGATORIA/);
  assert.match(validacao, /CLIENTE_NAO_ENCONTRADO/);
  assert.match(validacao, /ESTRUTURA_NAO_ENCONTRADA/);
  // Trocar a natureza não pode deixar o vínculo antigo pendurado.
  const normalizacao = worker.slice(worker.indexOf("function normalizarTicketBody"));
  assert.match(normalizacao, /tipo === "externo" \?[\s\S]*?client_id/);
  assert.match(normalizacao, /tipo === "interno" \?[\s\S]*?local_id/);
});

test("rotas de tickets exigem permissões granulares", () => {
  for (const acao of ["tickets.view", "tickets.create", "tickets.edit", "tickets.interact", "tickets.delete"])
    assert.match(worker, new RegExp(`requirePermission\\(env,request,"${acao.replace(".", "\\.")}"\\)`));
  assert.match(worker, /"\/api\/tickets"/);
  assert.match(worker, /\/api\\\/tickets\\\/\(\\d\+\)\\\/eventos/);
});

test("tela e ações do painel estão no catálogo do Worker", () => {
  assert.match(worker, /\["tickets", "Painel de Tickets".*"\/tickets\.html"/);
  assert.match(worker, /\["tickets\.view", "Consultar tickets"/);
  assert.match(worker, /seed\.tickets\.v1/);
});

test("tela separa as duas naturezas e exige o vínculo antes de salvar", () => {
  assert.match(page, /id="tkTipoTabs"/);
  assert.match(page, /id="tkConteudo"/);
  assert.match(client, /data-natureza/);
  assert.match(client, /Atendimento externo: escolha o cliente/);
  assert.match(client, /Atendimento interno: escolha a estrutura/);
  assert.match(client, /\/api\/tickets\/clientes\?q=/);
});
