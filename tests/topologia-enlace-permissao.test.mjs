/* Porta e enlace são a mesma tarefa na tela: quem ajusta a porta é quem sabe o
   que está ligado nela. Enquanto as ações eram independentes, o perfil de campo
   (que tem `topology.port.edit`) via os campos do enlace travados sem ter o que
   fazer a respeito — e o de logística não conseguia documentar enlace nenhum.
   Os testes abaixo fixam a implicação e, principalmente, o seu limite: ela não
   pode virar uma porta dos fundos para apagar equipamento ou POP. */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { comAcoesImplicadas, acoesQueSatisfazem } from "../src/worker.js";

const worker = await readFile(new URL("../src/worker.js", import.meta.url), "utf8");
const topology = await readFile(new URL("../public/js/noc-topology.js", import.meta.url), "utf8");

test("quem edita portas documenta e desfaz enlace", () => {
  const perfil = comAcoesImplicadas(["topology.view", "topology.edit", "topology.port.edit"]);
  assert.ok(perfil.has("topology.link.create"), "criar enlace acompanha a edição de portas");
  assert.ok(perfil.has("topology.link.delete"), "desfazer enlace acompanha a edição de portas");
});

test("a implicação não vaza para a remoção de cadastro", () => {
  const perfil = comAcoesImplicadas(["topology.edit", "topology.port.edit"]);
  for (const proibida of ["topology.delete", "topology.equipment.delete", "pops.delete"]) {
    assert.ok(!perfil.has(proibida), `${proibida} continua sendo concessão explícita do administrador`);
  }
});

test("sem editar portas, nada é concedido", () => {
  const perfil = comAcoesImplicadas(["topology.view", "topology.edit"]);
  assert.ok(!perfil.has("topology.link.create"));
  assert.ok(!perfil.has("topology.link.delete"));
});

test("a verificação de uma ação isolada aceita quem a implica", () => {
  // hasPermission consulta o banco por código; sem esta lista ele perguntaria
  // só pela ação derivada e negaria quem a tem por implicação.
  assert.deepEqual(acoesQueSatisfazem("topology.link.delete").sort(),
    ["topology.link.delete", "topology.port.edit"]);
  assert.deepEqual(acoesQueSatisfazem("topology.delete"), ["topology.delete"]);
});

test("desfazer enlace saiu do portão de remoção de cadastro", () => {
  // `topology.delete` continua barrando equipamento, POP, fibra e caixa; o
  // enlace é cobrado por requiredTopologyActions, com a ação dele.
  const gate = worker.match(/const hasDeletion=[^;]+;/s)[0];
  assert.doesNotMatch(gate, /conexoes/, "o enlace não pode voltar ao portão de topology.delete");
  for (const tipo of ["equipamentos", "pops", "fibras", "caixas"]) {
    assert.match(gate, new RegExp(`diff\\.${tipo}`), `${tipo} continua exigindo topology.delete`);
  }
});

test("a tela cobra a mesma dupla de ações que o Worker", () => {
  assert.match(topology, /const podeRemoverEnlace = \(\) => NOC\.canAll\(\["topology\.edit", "topology\.link\.delete"\]\);/);
  assert.doesNotMatch(topology, /canAll\(\["topology\.delete", "topology\.link\.delete"\]\)/);
  // Nem o motivo mostrado ao operador pode pedir a ação que não é mais exigida.
  assert.doesNotMatch(topology, /ações topology\.delete \+ topology\.link\.delete/);
  assert.doesNotMatch(topology, /<b>topology\.delete<\/b> e <b>topology\.link\.delete<\/b>/);
});
