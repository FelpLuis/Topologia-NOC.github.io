/* Importação automática do cadastro de clientes a partir da coleta GPON.

   O que estes testes protegem: o cadastro é chaveado pelo código do cliente no
   IXC — o mesmo número do ERP —, um cliente com várias ONUs continua sendo um
   cadastro só, e a importação nunca sobrescreve o que o operador corrigiu. */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { candidatosCadastroGpon, enderecoCadastroGpon } from "../src/worker.js";

const worker = fs.readFileSync(new URL("../src/worker.js", import.meta.url), "utf8");
const gponMap = fs.readFileSync(new URL("../public/js/noc-gpon-map.js", import.meta.url), "utf8");
const clientes = fs.readFileSync(new URL("../public/js/noc-clientes.js", import.meta.url), "utf8");

/* Um banco de verdade: é o único jeito de provar que a quantidade de colunas,
   de placeholders e de binds do INSERT batem entre si. */
function bancoDeTeste() {
  const db = new DatabaseSync(":memory:");
  const schema = worker.match(/const SCHEMA = `([\s\S]*?)`;/)[1].replace(/\/\*[\s\S]*?\*\//g, "");
  for (const comando of schema.split(";").map((x) => x.trim()).filter(Boolean)) {
    try { db.exec(comando); } catch { /* tabelas com dependência fora deste recorte */ }
  }
  return db;
}

const INSERT_IMPORTACAO = worker
  .match(/INSERT INTO cliente_cadastro\(client_id,ixc_id,origem,nome,endereco[\s\S]*?DO NOTHING/)[0]
  .replace(/\r/g, "");

const inserir = (db, c) => db.prepare(INSERT_IMPORTACAO).run(
  c.client_id, c.ixc_id, c.nome, c.endereco, c.bairro, c.cidade, c.lat, c.lon,
  c.ont_serial, c.ont_modelo, c.ip_gerencia, c.login_pppoe);

test("o código do cadastro é o do IXC, não o id sintético da ONU", () => {
  const [cad] = candidatosCadastroGpon([{
    id: "olt-c350:1/2/1:5", ixc_id: "4821", name: "Maria Souza",
    serial: "ZTEGC1234567", model: "F670L", username: "maria.souza", ip: "10.20.0.9",
    address: "Rua das Flores, 120 — Centro — Santos", lat: -23.96, lon: -46.33,
  }]);
  assert.equal(cad.client_id, "4821");
  assert.equal(cad.ixc_id, "4821");
  assert.equal(cad.nome, "Maria Souza");
  assert.equal(cad.login_pppoe, "maria.souza");
  assert.equal(cad.ont_serial, "ZTEGC1234567");
});

test("um cliente com duas ONUs vira um cadastro só", () => {
  const lista = candidatosCadastroGpon([
    { id: "olt-c350:1/2/1:5", ixc_id: "4821", name: "Maria Souza" },
    { id: "olt-c300:1/4/2:9", ixc_id: "4821", name: "Maria Souza" },
  ]);
  assert.equal(lista.length, 1);
  assert.equal(lista[0].client_id, "4821");
});

test("ONU sem código do IXC fica fora do cadastro", () => {
  const lista = candidatosCadastroGpon([
    { id: "olt-c350:1/2/1:7", name: "ONU 1/2/1:7" },          // sem ixc_id
    { id: "olt-c350:1/2/1:8", ixc_id: "0", name: "ONU sem cliente" }, // IXC devolve "0"
    { id: "olt-c350:1/2/1:9", ixc_id: "  ", name: "ONU vazia" },
  ]);
  assert.deepEqual(lista, []);
});

test("endereço do IXC só é dividido quando as três partes estão lá", () => {
  assert.deepEqual(enderecoCadastroGpon("Rua das Flores, 120 — Centro — Santos"),
    { endereco: "Rua das Flores, 120", bairro: "Centro", cidade: "Santos" });
  // Sem bairro o IXC manda duas partes: dividir seria adivinhação.
  assert.deepEqual(enderecoCadastroGpon("Rua das Flores, 120 — Santos"),
    { endereco: "Rua das Flores, 120 — Santos", bairro: "", cidade: "" });
  assert.deepEqual(enderecoCadastroGpon(""), { endereco: "", bairro: "", cidade: "" });
});

test("coordenada inválida da coleta não entra no cadastro", () => {
  const [cad] = candidatosCadastroGpon([{ id: "a", ixc_id: "10", lat: 999, lon: "abc" }]);
  assert.equal(cad.lat, null);
  assert.equal(cad.lon, null);
});

test("o INSERT da importação grava com origem 'ixc' e casa colunas, placeholders e binds", () => {
  const db = bancoDeTeste();
  const [cad] = candidatosCadastroGpon([{
    id: "olt-c350:1/2/1:5", ixc_id: "4821", name: "Maria Souza",
    address: "Rua das Flores, 120 — Centro — Santos", lat: -23.96, lon: -46.33,
    serial: "ZTEGC1234567", model: "F670L", ip: "10.20.0.9", username: "maria.souza",
  }]);
  inserir(db, cad);
  const linha = db.prepare(`SELECT * FROM cliente_cadastro WHERE client_id='4821'`).get();
  assert.equal(linha.origem, "ixc");
  assert.equal(linha.ixc_id, "4821");
  assert.equal(linha.cidade, "Santos");
  assert.equal(linha.lat, -23.96);
  // Campos que a coleta não conhece nascem vazios, não nulos.
  assert.equal(linha.documento, "");
  assert.equal(linha.status_faturamento, "ativo");
});

test("a importação não sobrescreve o cadastro que o operador já corrigiu", () => {
  const db = bancoDeTeste();
  const [cad] = candidatosCadastroGpon([{ id: "onu-1", ixc_id: "4821", name: "MARIA S (IXC)", address: "Endereço do ERP" }]);
  inserir(db, cad);
  db.prepare(`UPDATE cliente_cadastro SET nome='Maria Souza', endereco='Rua certa, 15', telefone='13999990000' WHERE client_id='4821'`).run();
  // Segunda coleta traz de novo o mesmo cliente: o ON CONFLICT protege a correção.
  inserir(db, cad);
  const linha = db.prepare(`SELECT * FROM cliente_cadastro WHERE client_id='4821'`).get();
  assert.equal(linha.nome, "Maria Souza");
  assert.equal(linha.endereco, "Rua certa, 15");
  assert.equal(linha.telefone, "13999990000");
  assert.equal(db.prepare(`SELECT COUNT(*) n FROM cliente_cadastro`).get().n, 1);
});

test("a ingestão do snapshot chama a importação e o teto por ciclo existe", () => {
  assert.match(worker, /await importarCadastroGpon\(db, clients\)/);
  assert.match(worker, /CLIENTE_IMPORT_MAX_PER_RUN/);
  assert.match(worker, /cadastros_criados/);
  // Falha na importação não pode invalidar a fotografia já gravada.
  const trecho = worker.slice(worker.indexOf("let cadastros = "), worker.indexOf("await registrarCicloGpon(db, {\r\n    id: runId, kind: \"snapshot\""));
  assert.match(trecho, /try \{[\s\S]*catch/);
});

test("o feed GPON casa o cadastro pelo id da ONU ou pelo código do IXC", () => {
  assert.match(worker, /function indexarCadastros/);
  assert.match(worker, /porIxc\.get\(String\(cliente\?\.ixc_id/);
  // O "Novo cadastro" não pode oferecer quem já entrou por qualquer um dos dois códigos.
  assert.match(worker, /!registrados\.has\(String\(c\.id\)\) && !registrados\.has\(String\(c\.ixc_id \|\| ""\)\.trim\(\)\)/);
});

test("o código do IXC é preenchido, nunca apagado, na edição", () => {
  assert.match(worker, /const ixcId = String\(dados\.ixc_id \|\| antes\.ixc_id \|\| ""\)\.trim\(\);/);
  assert.match(worker, /UPDATE cliente_cadastro SET ixc_id=\?/);
});

test("a Lista do GPON edita o cadastro do cliente", () => {
  assert.match(gponMap, /data-client-edit=/);
  assert.match(gponMap, /function editarCadastro/);
  assert.match(gponMap, /\$\$\("\[data-client-edit\]", body\)/);
  // Cadastrar exige clientes.create; editar, clientes.edit.
  assert.match(gponMap, /c\.cadastro \? "clientes\.edit" : "clientes\.create"/);
  // Sem cadastro, o que a coleta já sabe entra preenchido no formulário.
  assert.match(gponMap, /ixc_id: String\(c\.ixc_id \|\| ""\)\.trim\(\)/);
  assert.match(gponMap, /ont_serial: c\.serial/);
});

test("as ações só são aplicadas depois que /api/access responde", () => {
  // Aplicar antes deixaria todo botão desabilitado por permissão vazia.
  assert.match(gponMap, /let acessoPronto = false/);
  assert.match(gponMap, /acessoPronto = true; NOC\.applyActions\(document\)/);
  assert.match(gponMap, /const aplicarAcoes = \(host\) => \{ if \(acessoPronto\) NOC\.applyActions\(host\); \}/);
});

test("fora de /clientes.html o módulo de cadastro não monta a casca da tela", () => {
  // Montar trocaria o provedor de busca global do mapa GPON por uma lista vazia.
  const mount = clientes.slice(clientes.indexOf("function mount()"), clientes.indexOf("if (document.readyState"));
  assert.match(mount, /if \(!ehTela\) return;[\s\S]*UI\.mountShell/);
});

test("o cadastro carrega o código do IXC de volta ao salvar", () => {
  assert.match(clientes, /ixc_id: state\.ixcId/);
  assert.match(clientes, /state\.ixcId = String\(corpoForm\.ixc_id \?\? ""\)\.trim\(\)/);
  // A sugestão do feed propõe o código do IXC.
  assert.match(clientes, /c\.codigo \|\| c\.id/);
  assert.match(worker, /codigo: String\(c\.ixc_id \|\| ""\)\.trim\(\) \|\| c\.id/);
});

/* ---- defeitos que este trabalho encontrou no caminho, travados aqui ---- */

test("campo vazio da coleta vira string vazia, não a palavra 'undefined'", () => {
  // primeiroGpon usava find(), que ignora "" — o último argumento nunca era
  // devolvido como padrão e String(undefined) virava "undefined" na tela.
  const [cad] = candidatosCadastroGpon([{ id: "onu-1", ixc_id: "4821" }]);
  assert.equal(cad.ont_serial, "");
  assert.equal(cad.login_pppoe, "");
  assert.equal(cad.ip_gerencia, "");
  assert.equal(cad.endereco, "");
});

test("cliente sem coordenada não cai no 0,0 (que o mapa lê como 'sem GPS')", () => {
  const [cad] = candidatosCadastroGpon([{ id: "onu-1", ixc_id: "4821", name: "Sem GPS" }]);
  assert.equal(cad.lat, null);
  assert.equal(cad.lon, null);
});

test("o formulário pega o host do onMount, não do retorno de UI.modal", () => {
  // UI.modal devolve { host, close }; usar o retorno como raiz de querySelector
  // derrubava o onMount antes de ligar o botão Salvar.
  const ui = fs.readFileSync(new URL("../public/js/noc-ui.js", import.meta.url), "utf8");
  assert.match(ui, /return \{ host, close \};/);
  assert.doesNotMatch(clientes, /formHost = UI\.modal\(/);
  assert.match(clientes, /onMount: \(host, close\) => \{[\s\S]{0,200}formHost = host;/);
});

test("a tela de cadastro só aplica ações depois de /api/access", () => {
  assert.match(clientes, /const aplicarAcoes = \(host\) => \{ if \(acessoPronto\) NOC\.applyActions\(host\); \}/);
  assert.match(clientes, /acessoPronto = true; NOC\.applyActions\(document\)/);
  // O mount não pode mais aplicar as ações com o acesso ainda vazio.
  const mount = clientes.slice(clientes.indexOf("function mount()"), clientes.indexOf("if (document.readyState"));
  assert.doesNotMatch(mount, /NOC\.applyActions\(document\)/);
});
