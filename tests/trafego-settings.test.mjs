import assert from "node:assert/strict";
import test from "node:test";
import { normalizeTrafegoSettings } from "../src/worker.js";

test("ajustes do tráfego aceitam interface e descrição editáveis", () => {
  const settings = normalizeTrafegoSettings({
    interfaces: {
      "10101:7": {
        interface: "  Uplink Core A  ",
        descricao: "  Circuito principal  ",
        nota: "  Validado pelo NOC  ",
        critica: true,
      },
    },
  });

  assert.deepEqual(settings.interfaces["10101:7"], {
    interface: "Uplink Core A",
    descricao: "Circuito principal",
    nota: "Validado pelo NOC",
    critica: true,
    ignorar: false,
  });
});

test("ajuste antigo de apelido é migrado para o nome da interface", () => {
  const settings = normalizeTrafegoSettings({
    interfaces: { "9:2": { apelido: "Porta legada", nota: "mantida" } },
  });

  assert.equal(settings.interfaces["9:2"].interface, "Porta legada");
  assert.equal(settings.interfaces["9:2"].nota, "mantida");
  assert.equal(Object.hasOwn(settings.interfaces["9:2"], "descricao"), false);
});

test("descrição vazia é preservada para permitir limpar a exibição", () => {
  const settings = normalizeTrafegoSettings({
    interfaces: { "9:3": { interface: "GE0/0/3", descricao: "" } },
  });

  assert.equal(settings.interfaces["9:3"].descricao, "");
});

test("intervalo automático e painéis do telão permanecem configuráveis", () => {
  const settings = normalizeTrafegoSettings({
    intervaloSegundos: 45,
    tvPaineis: ["kpis", "enlaces", "equipamentos"],
  });

  assert.equal(settings.intervaloSegundos, 45);
  assert.deepEqual(settings.tvPaineis, ["kpis", "enlaces", "equipamentos"]);
});
