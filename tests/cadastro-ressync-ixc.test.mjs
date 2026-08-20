import test from "node:test";
import assert from "node:assert/strict";

import { importarCadastroGpon } from "../src/worker.js";
import { buildIxcInventory } from "../collector/ixc-client.mjs";

/* Banco falso: guarda as linhas de cliente_cadastro e registra o SQL que a
   importação emitiu, para que o teste veja não só o resultado mas também o
   custo — um parque estável precisa gerar zero escrita. */
function fakeDb(linhas) {
  const escritas = [];
  const stmt = (sql, args = []) => ({
    sql, args,
    bind: (...valores) => stmt(sql, valores),
    all: async () => ({ results: linhas }),
    run: async () => ({ success: true }),
  });
  return {
    escritas,
    prepare: (sql) => {
      const s = stmt(sql);
      if (!/^\s*SELECT/i.test(sql)) escritas.push(s);
      return { ...s, bind: (...valores) => { s.args = valores; return s; } };
    },
    batch: async (statements) => { escritas.push(...statements); return statements.map(() => ({ success: true })); },
  };
}

const cliente = (extra = {}) => ({
  id: "olt:1/2/1:1", ixc_id: "700", name: "Maria Souza", serial: "ZTEG0001",
  address: "Rua Nova, 10 — Centro — Santos", lat: -23.95, lon: -46.33, ...extra,
});

const cadastro = (extra = {}) => ({
  client_id: "700", origem: "ixc", updated_by: null,
  nome: "Maria Souza", endereco: "Rua Nova, 10", bairro: "Centro", cidade: "Santos",
  lat: -23.95, lon: -46.33, ont_serial: "ZTEG0001", ont_modelo: "", ip_gerencia: "", login_pppoe: "",
  ...extra,
});

test("coordenada corrigida no IXC chega ao cadastro já importado", async () => {
  // O caso que motivou tudo: o cliente entrou sem lat/lon porque o ERP estava
  // incompleto; depois de preencher lá, a coleta seguinte precisa trazer.
  const db = fakeDb([cadastro({ lat: null, lon: null })]);
  const r = await importarCadastroGpon(db, [cliente()]);
  assert.equal(r.atualizados, 1);
  assert.equal(r.criados, 0);
  const update = db.escritas.find((e) => /^\s*UPDATE/i.test(e.sql));
  assert.ok(update, "deve emitir UPDATE");
  assert.match(update.sql, /lat=\?,lon=\?/);
  assert.deepEqual(update.args, [-23.95, -46.33, "700"]);
});

test("correção feita à mão na plataforma ganha da coleta", async () => {
  // updated_by preenchido é a prova de que um humano mexeu: a coleta não pode
  // desfazer a coordenada que o operador foi a campo conferir.
  const db = fakeDb([cadastro({ lat: -24.1, lon: -46.5, updated_by: 3 })]);
  const r = await importarCadastroGpon(db, [cliente()]);
  assert.equal(r.atualizados, 0);
  assert.equal(db.escritas.filter((e) => /^\s*UPDATE/i.test(e.sql)).length, 0);
});

test("cadastro digitado do zero nunca é tocado pela coleta", async () => {
  const db = fakeDb([cadastro({ origem: "manual", lat: -24.1, lon: -46.5 })]);
  const r = await importarCadastroGpon(db, [cliente()]);
  assert.equal(r.atualizados, 0);
});

test("campo vazio no IXC não apaga o que já estava preenchido", async () => {
  // Ausência de dado não é ordem de apagar: uma coleta em que o ERP devolveu
  // o campo em branco não pode zerar a coordenada boa.
  const db = fakeDb([cadastro()]);
  const r = await importarCadastroGpon(db, [cliente({ lat: null, lon: null, address: "", name: "" })]);
  assert.equal(r.atualizados, 0, "nada mudou de verdade");
});

test("parque estável não gera escrita nenhuma", async () => {
  // Sem a comparação em memória, cada ciclo completo reescreveria a base
  // inteira a cada dez minutos para não mudar nada.
  const db = fakeDb([cadastro()]);
  const r = await importarCadastroGpon(db, [cliente()]);
  assert.equal(r.atualizados, 0);
  assert.equal(r.criados, 0);
  assert.equal(db.escritas.length, 0);
});

test("só as colunas que mudaram entram no UPDATE", async () => {
  const db = fakeDb([cadastro({ nome: "Maria S." })]);
  await importarCadastroGpon(db, [cliente()]);
  const update = db.escritas.find((e) => /^\s*UPDATE/i.test(e.sql));
  assert.match(update.sql, /SET nome=\?,updated_at=CURRENT_TIMESTAMP/);
  assert.deepEqual(update.args, ["Maria Souza", "700"]);
});

test("cliente novo continua sendo criado como espelho do IXC", async () => {
  const db = fakeDb([]);
  const r = await importarCadastroGpon(db, [cliente()]);
  assert.equal(r.criados, 1);
  const insert = db.escritas.find((e) => /^\s*INSERT/i.test(e.sql));
  assert.match(insert.sql, /VALUES \(\?,\?,'ixc'/, "nasce marcado como vindo do IXC");
});

test("o UPDATE reconfirma a origem no WHERE", async () => {
  // A checagem em memória pode estar lendo um retrato de segundos atrás; se o
  // operador editou nesse intervalo, o WHERE é a última linha de defesa.
  const db = fakeDb([cadastro({ nome: "Maria S." })]);
  await importarCadastroGpon(db, [cliente()]);
  const update = db.escritas.find((e) => /^\s*UPDATE/i.test(e.sql));
  assert.match(update.sql, /WHERE client_id=\? AND origem='ixc' AND updated_by IS NULL/);
});

/* ---- a cascata de coordenadas no coletor ---- */

const inventario = (fiber, login, customer) => buildIxcInventory({
  customers: [{ id: "7", razao: "Maria Souza", ...customer }],
  contracts: [{ id: "8", id_cliente: "7", status: "A" }],
  logins: [{ id: "9", id_cliente: "7", id_contrato: "8", login: "maria", ...login }],
  fiberClients: [{ id: "10", id_login: "9", id_contrato: "8", mac: "ZTEG0001", ...fiber }],
  boxes: [], transmitters: [],
});

test("coordenada pela metade não vira ponto no Atlântico", () => {
  // number("") devolve 0, então latitude em branco com longitude real passava
  // como {lat: 0, lon: -46.33} — equador, meio do oceano.
  const match = inventario({ latitude: "", longitude: "-46.33" }, {}, {}).match({ serial: "ZTEG0001", name: "ONU" });
  assert.equal(match.lat, undefined);
  assert.equal(match.lon, undefined);
});

test("coordenada pela metade não interrompe a cascata", () => {
  // Este é o dano real: o registro da fibra "respondia" com lixo e o cadastro
  // do cliente, que tinha a coordenada certa, nunca era consultado.
  const match = inventario(
    { latitude: "", longitude: "-46.33" },
    {},
    { latitude: "-23.95", longitude: "-46.33" }
  ).match({ serial: "ZTEG0001", name: "ONU" });
  assert.equal(match.lat, -23.95);
  assert.equal(match.lon, -46.33);
});

test("coordenada completa na fibra continua tendo prioridade", () => {
  const match = inventario(
    { latitude: "-23.90", longitude: "-46.30" },
    {},
    { latitude: "-23.95", longitude: "-46.33" }
  ).match({ serial: "ZTEG0001", name: "ONU" });
  assert.equal(match.lat, -23.90);
});

test("o rótulo 'Cliente sem nome' nunca é gravado como nome", async () => {
  // É texto de tela, não dado. Gravá-lo faria uma coleta em que o IXC devolveu
  // o nome vazio apagar o nome verdadeiro e pôr o rótulo no lugar.
  const { candidatosCadastroGpon } = await import("../src/worker.js");
  const [candidato] = candidatosCadastroGpon([{ id: "olt:1", ixc_id: "700", serial: "ZTEG0001" }]);
  assert.equal(candidato.nome, "");

  const db = fakeDb([cadastro()]);
  const r = await importarCadastroGpon(db, [cliente({ name: "" })]);
  assert.equal(r.atualizados, 0, "coleta sem nome não pode mexer no cadastro");
});
