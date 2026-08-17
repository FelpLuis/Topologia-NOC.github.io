/* Verifica que as otimizações de noc-api.js preservam o comportamento:
   - o índice de portas devolve exatamente o que o find linear devolvia;
   - o cache de repintura nunca sobrevive a uma mutação da topologia;
   - gravações em rajada viram menos requisições, e todas resolvem. */
import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import vm from "node:vm";
import path from "node:path";
import { fileURLToPath } from "node:url";

const raiz = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fonte = fs.readFileSync(path.join(raiz, "public/js/noc-api.js"), "utf8");

function carregar({ onPut } = {}) {
  const janela = {};
  const contexto = {
    window: janela,
    queueMicrotask,
    URLSearchParams,
    location: { href: "" },
    console,
    async fetch(url, opts = {}) {
      const corpo = opts.body ? JSON.parse(opts.body) : null;
      const resposta = onPut ? await onPut(url, opts.method || "GET", corpo) : {};
      return { ok: true, status: 200, json: async () => resposta };
    },
  };
  contexto.globalThis = contexto;
  vm.createContext(contexto);
  vm.runInContext(fonte, contexto);
  return janela.NOC;
}

/* Topologia de teste: portas repetidas de propósito, para conferir que a
   primeira ocorrência continua vencendo, como no find original. */
const topologia = () => ({
  equipamentos: [
    { id: "sw1", nome: "Switch Central", local: "POP Centro", popId: null, portas: [{ numero: 1 }, { numero: 2 }, { numero: 3 }] },
    { id: "sw2", nome: "Switch Norte", local: "POP Norte", popId: "pop-norte", portas: [{ numero: 1 }, { numero: 2 }] },
    { id: "sw3", nome: "Sem casa", local: "Depósito", popId: null, portas: [{ numero: 1 }] },
  ],
  conexoes: [
    { id: "c1", origem: "sw1", portaOrigem: 1, destino: "sw2", portaDestino: 1 },
    { id: "c2", origem: "sw1", portaOrigem: 2, destino: "sw2", portaDestino: 2 },
    { id: "c3", origem: "sw1", portaOrigem: 1, destino: "sw3", portaDestino: 1 }, // duplicada em sw1:1
  ],
  pops: [{ id: "pop-centro", nome: "POP Centro" }, { id: "pop-norte", nome: "POP Norte" }],
  config: {},
});

// Implementação original, para comparar resultado a resultado.
const findOriginal = (t, id, porta) =>
  t.conexoes.find((c) =>
    (c.origem === id && Number(c.portaOrigem) === Number(porta)) ||
    (c.destino === id && Number(c.portaDestino) === Number(porta)));

test("índice de portas devolve o mesmo que o find linear", async () => {
  const t = topologia();
  const NOC = carregar({ onPut: async () => t });
  await NOC.load();

  for (const e of t.equipamentos) {
    for (const p of [1, 2, 3, 99]) {
      assert.deepEqual(
        NOC.portConnection(e.id, p),
        findOriginal(t, e.id, p),
        `divergência em ${e.id}:${p}`
      );
    }
  }
  // A conexão duplicada em sw1:1 tem de resolver para a primeira do array.
  assert.equal(NOC.portConnection("sw1", 1).id, "c1");
});

test("ocupação e status continuam corretos", async () => {
  const t = topologia();
  const NOC = carregar({ onPut: async () => t });
  await NOC.load();
  const sw1 = t.equipamentos[0];
  assert.equal(NOC.usedPorts(sw1), 2, "sw1 usa as portas 1 e 2");
  assert.equal(NOC.occupancy(sw1), 67);
  // Espalhado num objeto desta realm: o original nasce dentro do contexto VM
  // e o deepStrictEqual compararia protótipos de realms diferentes.
  assert.deepEqual({ ...NOC.statsOf(t.equipamentos) }, { portas: 6, emUso: 5, livres: 1, ocup: 83 });
});

test("cache de repintura não sobrevive a uma mutação", async () => {
  const t = topologia();
  const NOC = carregar({ onPut: async () => t });
  await NOC.load();

  assert.equal(NOC.pops().length, 2);
  assert.equal(NOC.portConnection("sw1", 3), undefined);

  // Mutação em outra tarefa, como acontece na tela.
  await new Promise((r) => setTimeout(r, 0));
  t.pops.push({ id: "pop-sul", nome: "POP Sul" });
  t.conexoes.push({ id: "c4", origem: "sw1", portaOrigem: 3, destino: "sw3", portaDestino: 1 });

  assert.equal(NOC.pops().length, 3, "novo POP tem de aparecer");
  assert.equal(NOC.portConnection("sw1", 3)?.id, "c4", "novo enlace tem de aparecer");
});

test("sugestão de POP por nome continua valendo", async () => {
  const t = topologia();
  const NOC = carregar({ onPut: async () => t });
  await NOC.load();
  assert.equal(NOC.effectivePop(t.equipamentos[0]), "pop-centro", "sw1 sugerido pelo local");
  assert.equal(NOC.effectivePop(t.equipamentos[1]), "pop-norte", "sw2 tem vínculo explícito");
  assert.equal(NOC.effectivePop(t.equipamentos[2]), null, "sw3 fica sem POP");
  assert.equal(NOC.isSuggested(t.equipamentos[0]), true);
  assert.equal(NOC.isSuggested(t.equipamentos[1]), false);
});

test("projeção dos POPs preserva campos adicionais", async () => {
  const t = topologia();
  t.pops[0].endereco = "Rua do NOC, 100";
  const NOC = carregar({ onPut: async () => t });
  await NOC.load();
  assert.equal(NOC.popById("pop-centro").endereco, "Rua do NOC, 100");
});

test("endereço, rotas e vínculo do POP sobrevivem a uma nova carga", async () => {
  let persisted = topologia();
  const transport = async (url, metodo, corpo) => {
    if (url === "/api/access") return { permissions: [], screens: [] };
    if (metodo === "PUT") {
      persisted = JSON.parse(JSON.stringify(corpo.topology));
      return { version: 2, updated_at: "agora", topology: { config: persisted.config || {} } };
    }
    return JSON.parse(JSON.stringify(persisted));
  };

  const NOC = carregar({ onPut: transport });
  await NOC.load();
  const pop = NOC.data().pops.find((item) => item.id === "pop-centro");
  pop.endereco = "Avenida da Rede, 250";
  pop.rotas = ["Aérea → Norte", "Subterrânea → Sul"];
  NOC.data().equipamentos[0].popId = "pop-centro";
  await NOC.save("TOPOLOGY_UPDATE_POP");

  const recarregado = carregar({ onPut: transport });
  await recarregado.load();
  assert.equal(recarregado.popById("pop-centro").endereco, "Avenida da Rede, 250");
  assert.deepEqual([...recarregado.popById("pop-centro").rotas], ["Aérea → Norte", "Subterrânea → Sul"]);
  assert.equal(recarregado.data().equipamentos[0].popId, "pop-centro");
});

test("gravações em rajada viram menos requisições e todas resolvem", async () => {
  const t = topologia();
  let puts = 0;
  const NOC = carregar({
    onPut: async (url, metodo) => {
      if (metodo === "PUT") {
        puts++;
        await new Promise((r) => setTimeout(r, 10));
        return { ok: true, version: puts, updated_at: "agora", topology: { config: {} } };
      }
      return t;
    },
  });
  await NOC.load();

  const resultados = await Promise.all([
    NOC.save("a"), NOC.save("b"), NOC.save("c"), NOC.save("d"), NOC.save("e"),
  ]);
  assert.equal(resultados.length, 5, "toda chamada tem de resolver");
  assert.ok(resultados.every((r) => r === NOC.data()), "todas devolvem a topologia");
  assert.equal(puts, 2, `5 chamadas em rajada viraram ${puts} requisições`);
  console.log(`      (5 chamadas em rajada -> ${puts} requisições)`);
});

test("erro na gravação continua chegando a quem chamou", async () => {
  const t = topologia();
  const NOC = carregar({
    onPut: async (url, metodo) => {
      if (metodo === "PUT") throw new Error("rede caiu");
      return t;
    },
  });
  await NOC.load();
  await assert.rejects(() => NOC.save("x"), /rede caiu/);
  // E o estado volta a aceitar gravações depois da falha.
  await assert.rejects(() => NOC.save("y"), /rede caiu/);
});
