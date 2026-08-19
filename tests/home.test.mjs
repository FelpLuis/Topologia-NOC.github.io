/* A home responde três perguntas da operação, e cada uma tem um jeito errado
   de ser respondida que estes testes cobrem:
   - clientes: "offline" precisa ser o complemento de "online", nunca uma
     segunda contagem que não fecha com o total;
   - tráfego: o volume do período não pode ser inventado em cima de um buraco
     de coleta;
   - alertas: a impressão digital precisa ser estável entre ciclos, senão tudo
     volta como "não visto" a cada minuto. */
import assert from "node:assert/strict";
import test from "node:test";
import {
  resumirClientesGpon,
  resumirTrafego,
  compactarSerie,
  derivarAlertasDaRede,
  normalizeTrafegoSettings,
} from "../src/worker.js";

test("clientes: online, offline e total sempre fecham", () => {
  const resumo = resumirClientesGpon([
    { status: "online" }, { status: "ONLINE" }, { status: " working " },
    { status: "los" }, { status: "dyinggasp" }, { status: "" }, {},
  ]);

  assert.equal(resumo.total, 7);
  assert.equal(resumo.online, 3);
  assert.equal(resumo.offline, 4);
  assert.equal(resumo.online + resumo.offline, resumo.total);
});

test("tráfego: atual vem da leitura de agora, mínimo e total do período", () => {
  const amostras = [
    { taken_at: "2026-08-18 12:00:00", in_bps: 1_000_000, out_bps: 1_000_000 },
    { taken_at: "2026-08-18 12:05:00", in_bps: 3_000_000, out_bps: 1_000_000 },
  ];

  const t = resumirTrafego(amostras, { atualBps: 9_000_000 });

  assert.equal(t.atual, 9_000_000, "a leitura de agora prevalece sobre a última amostra");
  assert.equal(t.minimo, 2_000_000);
  assert.equal(t.maximo, 4_000_000);
  // Média de 3 Mbps por 300 s = 900 Mbit = 112,5 MB.
  assert.equal(t.total_bytes, 112_500_000);
});

test("tráfego: buraco de coleta não vira volume inventado", () => {
  const comBuraco = [
    { taken_at: "2026-08-18 12:00:00", in_bps: 1_000_000, out_bps: 1_000_000 },
    { taken_at: "2026-08-18 18:00:00", in_bps: 1_000_000, out_bps: 1_000_000 },
  ];

  assert.equal(resumirTrafego(comBuraco).total_bytes, 0);
});

test("tráfego: sem amostras, a última leitura ainda responde o atual", () => {
  const t = resumirTrafego([], { atualBps: 5_000 });
  assert.equal(t.atual, 5_000);
  assert.equal(t.minimo, 0);
  assert.equal(t.total_bytes, 0);
  assert.deepEqual(t.serie, []);
});

test("a série compactada preserva o pico de cada balde", () => {
  const serie = Array.from({ length: 500 }, (_, i) => ({ em: String(i), bps: i === 250 ? 999 : i }));
  const compacta = compactarSerie(serie, 50);

  assert.equal(compacta.length, 50);
  assert.ok(compacta.some((p) => p.bps === 999), "o pico não pode desaparecer na redução");
});

/* Inventário mínimo: dois lados de um enlace documentado, um deles fora do ar,
   e uma interface saturada. */
const inventario = () => ({
  hosts: [
    { hostid: "1", host: "sw-a", name: "SW-A", equipamento_id: "SW-A" },
    { hostid: "2", host: "sw-b", name: "SW-B", equipamento_id: "SW-B" },
  ],
  interfaces: [
    { hostid: "1", if_index: 1, if_name: "100GE1/0/1", if_alias: "SW-B-100GE1/0/1",
      oper_status: 2, speed_bps: 100e9, in_bps: 0, out_bps: 0 },
    { hostid: "2", if_index: 1, if_name: "100GE1/0/1", if_alias: "SW-A-100GE1/0/1",
      oper_status: 1, speed_bps: 100e9, in_bps: 0, out_bps: 0 },
    { hostid: "1", if_index: 9, if_name: "10GE1/0/9", if_alias: "TRANSITO",
      oper_status: 1, speed_bps: 10e9, in_bps: 9.5e9, out_bps: 1e9 },
  ],
});

test("alertas: enlace fora do ar é crítico e saturação entra pelo limite configurado", () => {
  const settings = normalizeTrafegoSettings({ limiteAtencao: 70, limiteCritico: 85 });
  const alertas = derivarAlertasDaRede(inventario(), settings);

  const enlace = alertas.find((a) => a.fingerprint.startsWith("rede:enlace-fora:"));
  assert.ok(enlace, "o enlace com uma ponta em down precisa aparecer");
  assert.equal(enlace.grau, "critico");

  const saturada = alertas.find((a) => a.fingerprint === "rede:utilizacao:critico:1:9");
  assert.ok(saturada, "95% de 10G está acima do limite crítico");
  assert.equal(saturada.grau, "critico");

  // A ordem é a da sala de operação: crítico primeiro.
  assert.equal(alertas[0].grau, "critico");
});

test("alertas: a mesma condição gera a mesma impressão digital em ciclos seguidos", () => {
  const settings = normalizeTrafegoSettings({});
  const primeiro = derivarAlertasDaRede(inventario(), settings).map((a) => a.fingerprint).sort();
  const segundo = derivarAlertasDaRede(inventario(), settings).map((a) => a.fingerprint).sort();

  assert.deepEqual(segundo, primeiro);
  assert.equal(new Set(primeiro).size, primeiro.length, "impressões digitais não podem se repetir no mesmo ciclo");
});

test("alertas: subir de atenção para saturação é um evento novo", () => {
  const settings = normalizeTrafegoSettings({ limiteAtencao: 70, limiteCritico: 85 });

  const emAtencao = structuredClone(inventario());
  emAtencao.interfaces[2].in_bps = 7.5e9; // 75% — acima da atenção, abaixo do crítico
  const antes = derivarAlertasDaRede(emAtencao, settings).find((a) => a.fingerprint.includes(":utilizacao:"));
  const depois = derivarAlertasDaRede(inventario(), settings).find((a) => a.fingerprint.includes(":utilizacao:"));

  assert.equal(antes.grau, "atencao");
  assert.equal(depois.grau, "critico");
  assert.notEqual(antes.fingerprint, depois.fingerprint);
});

test("alertas: interface marcada para ignorar fica fora da fila", () => {
  const settings = normalizeTrafegoSettings({ interfaces: { "1:9": { ignorar: true } } });
  const alertas = derivarAlertasDaRede(inventario(), settings);

  assert.equal(alertas.some((a) => a.fingerprint.endsWith(":1:9")), false);
});
