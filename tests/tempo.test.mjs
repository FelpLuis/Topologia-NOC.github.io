/* O fuso do sistema é São Paulo, e é aqui que isso fica provado sem depender
   do relógio da máquina que roda o teste: os casos abaixo passariam por acaso
   num computador em Brasília, então todos usam carimbos em UTC e conferem a
   hora de parede que o operador vê. */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

/* noc-tempo.js é um módulo de navegador (window.TEMPO). Para testá-lo em Node,
   basta um contexto com um `window` de mentira. */
const contexto = vm.createContext({ window: {} });
vm.runInContext(fs.readFileSync(new URL("../public/js/noc-tempo.js", import.meta.url), "utf8"), contexto);
const TEMPO = contexto.window.TEMPO;

test("carimbo do SQLite é lido como UTC e mostrado em São Paulo", () => {
  // "2026-08-20 13:45:00" é o que CURRENT_TIMESTAMP grava: UTC, sem fuso.
  assert.equal(TEMPO.instante("2026-08-20 13:45:00").toISOString(), "2026-08-20T13:45:00.000Z");
  assert.equal(TEMPO.hora("2026-08-20 13:45:00"), "10:45");
  assert.equal(TEMPO.dataHora("2026-08-20 13:45:00"), "20/08/2026, 10:45");
  assert.equal(TEMPO.dataHoraSegundos("2026-08-20 13:45:07"), "20/08/2026, 10:45:07");
});

test("ISO com fuso declarado é respeitado", () => {
  assert.equal(TEMPO.hora("2026-08-20T13:45:00Z"), "10:45");
  assert.equal(TEMPO.hora("2026-08-20T13:45:00.000Z"), "10:45");
  assert.equal(TEMPO.hora("2026-08-20T13:45:00-03:00"), "13:45");
});

test("data de calendário começa à meia-noite de São Paulo", () => {
  assert.equal(TEMPO.instante("2026-08-20").toISOString(), "2026-08-20T03:00:00.000Z");
  assert.equal(TEMPO.data("2026-08-20"), "20/08/2026");
});

test("o que o operador digita é hora de Brasília e vira UTC", () => {
  assert.equal(TEMPO.deInput("2026-08-20T09:00").toISOString(), "2026-08-20T12:00:00.000Z");
  assert.equal(TEMPO.deInput("2026-08-20 09:00:30").toISOString(), "2026-08-20T12:00:30.000Z");
  assert.equal(TEMPO.deInput("nada disso"), null);
  // Ida e volta: o campo mostra de novo exatamente o que foi digitado.
  assert.equal(TEMPO.paraInput(TEMPO.deInput("2026-08-20T09:00")), "2026-08-20T09:00");
  assert.equal(TEMPO.paraInput("2026-08-20T12:00:00Z"), "2026-08-20T09:00");
});

test("o dia vira à meia-noite de São Paulo, não à de Londres", () => {
  // 02:30 UTC ainda é 23:30 do dia anterior no NOC.
  assert.equal(TEMPO.chaveDia("2026-08-21T02:30:00Z"), "2026-08-20");
  assert.equal(TEMPO.chaveDia("2026-08-21T03:30:00Z"), "2026-08-21");
  assert.ok(TEMPO.mesmoDia("2026-08-21T02:30:00Z", "2026-08-20T14:00:00Z"));
  assert.ok(!TEMPO.mesmoDia("2026-08-21T03:30:00Z", "2026-08-20T14:00:00Z"));
  assert.equal(TEMPO.inicioDoDia("2026-08-21T02:30:00Z").toISOString(), "2026-08-20T03:00:00.000Z");
});

test("horário de verão antigo continua batendo", () => {
  // Antes de 2019 o Brasil adiantava o relógio: em janeiro de 2018, UTC-2.
  assert.equal(TEMPO.hora("2018-01-15T13:45:00Z"), "11:45");
  assert.equal(TEMPO.deInput("2018-01-15T11:45").toISOString(), "2018-01-15T13:45:00.000Z");
});

test("sem data, sem hora inventada", () => {
  for (const vazio of [null, undefined, "", "  ", "sem hora nenhuma"]) {
    assert.equal(TEMPO.instante(vazio), null);
    assert.equal(TEMPO.hora(vazio), "—");
    assert.equal(TEMPO.chaveDia(vazio), "");
  }
  // Cada tela escolhe o próprio texto para o vazio.
  assert.equal(TEMPO.dataHora(null, "Não agendado"), "Não agendado");
});

test("nenhuma tela formata data por fora do TEMPO", () => {
  /* `toLocaleDateString`/`toLocaleTimeString` usam o fuso do sistema
     operacional. Uma chamada dessas escapando para uma tela é exatamente o
     bug que este módulo existe para não deixar voltar. */
  const dir = new URL("../public/js/", import.meta.url);
  const escapes = fs.readdirSync(dir)
    .filter(nome => nome.endsWith(".js") && nome !== "noc-tempo.js")
    .filter(nome => /toLocale(Date|Time)String/.test(fs.readFileSync(new URL(nome, dir), "utf8")));
  assert.deepEqual(escapes, []);
});

test("aceita Date e milissegundos, além de texto", () => {
  assert.equal(TEMPO.hora(new Date("2026-08-20T13:45:00Z")), "10:45");
  assert.equal(TEMPO.hora(Date.parse("2026-08-20T13:45:00Z")), "10:45");
  assert.equal(TEMPO.instante(new Date("data ruim")), null);
});
