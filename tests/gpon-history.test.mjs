import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import { transicaoGpon } from "../src/worker.js";

const worker = fs.readFileSync(new URL("../src/worker.js", import.meta.url), "utf8");
const migration = fs.readFileSync(new URL("../migrations/0019_gpon_history.sql", import.meta.url), "utf8");
const collector = fs.readFileSync(new URL("../collector/server.mjs", import.meta.url), "utf8");
const cli = fs.readFileSync(new URL("../collector/zte-cli.mjs", import.meta.url), "utf8");
const runtime = fs.readFileSync(new URL("../public/js/noc-gpon-map.js", import.meta.url), "utf8");

test("só mudanças reais viram histórico", () => {
  const base = { status: "online", state_detail: "ONU working", rx_power: -21.4, tx_power: 2.1 };

  // O ciclo de 10 s reenvia o mesmo estado o tempo todo; repetição não é evento.
  assert.equal(transicaoGpon(base, { ...base }), null);

  const queda = transicaoGpon(base, { ...base, status: "los", state_detail: "ONU LOS" });
  assert.equal(queda.event, "status");
  assert.equal(queda.statusAntes, "online");
  assert.equal(queda.statusDepois, "los");
  assert.equal(queda.rxAntes, -21.4);

  // Mudar só o detalhe também conta: é o que separa queda de fibra de falha
  // de autenticação, com o mesmo "offline" nas duas pontas.
  const camada = transicaoGpon({ ...base, status: "offline", state_detail: "Radius offline" },
    { ...base, status: "offline", state_detail: "ONU ativa • Radius offline" });
  assert.equal(camada.event, "status");
});

test("o ruído do sinal óptico não entra no histórico", () => {
  const base = { status: "online", state_detail: "ONU working", rx_power: -21.4, tx_power: 2.1 };
  assert.equal(transicaoGpon(base, { ...base, rx_power: -22.0 }), null);
  const degradou = transicaoGpon(base, { ...base, rx_power: -24.9 });
  assert.equal(degradou.event, "signal");
  assert.equal(degradou.rxAntes, -21.4);
});

test("cliente novo é registrado como primeira leitura", () => {
  const evento = transicaoGpon(undefined, { status: "online", state_detail: "ONU working" });
  assert.equal(evento.event, "baseline");
  assert.equal(evento.statusAntes, null);
});

test("o banco guarda transições e ciclos de coleta", () => {
  for (const fonte of [worker, migration]) {
    assert.match(fonte, /CREATE TABLE IF NOT EXISTS gpon_status_history/);
    assert.match(fonte, /CREATE TABLE IF NOT EXISTS gpon_sync_runs/);
    assert.match(fonte, /idx_gpon_history_client/);
  }
  // A identidade da ONU viaja com a mudança: sem ela o histórico seria uma
  // lista de ids sem quem, onde nem em qual OLT.
  for (const coluna of ["olt_id", "onu_index", "serial", "client_name", "origin", "run_id"])
    assert.match(migration, new RegExp(`  ${coluna} `));
});

test("as duas ingestões gravam histórico e auditam o ciclo", () => {
  assert.match(worker, /async function gravarHistoricoGpon/);
  assert.match(worker, /async function registrarCicloGpon/);
  assert.match(worker, /GPON_HISTORY_MAX_PER_RUN/);
  // Um ciclo sem nenhuma transição ainda precisa aparecer na auditoria.
  assert.match(worker, /kind: "status"/);
  assert.match(worker, /kind: "snapshot"/);
  // A primeira fotografia não vira 30 mil linhas de nascimento.
  assert.match(worker, /primeiraCarga && mudanca\.event === "baseline"/);
});

test("ciclo sem mudança move o batimento, não a revisão", () => {
  // Mexer em synced_at sem dado novo faria cada tela reabrir o snapshot inteiro.
  assert.match(worker, /UPDATE gpon_snapshot_state SET updated_at=CURRENT_TIMESTAMP WHERE id=1/);
});

test("filtro e poda comparam no formato que o SQLite grava", () => {
  // CURRENT_TIMESTAMP grava "AAAA-MM-DD HH:MM:SS"; comparar isso com um ISO
  // ordena errado (o espaço vem antes do "T") e a poda apagaria o dia do corte.
  assert.ok(worker.includes(`const carimboSqlGpon = (data) => data.toISOString().replace("T", " ").slice(0, 19);`));
  assert.ok(worker.includes("const corte = (dias) => carimboSqlGpon("));
  assert.ok(worker.includes("carimboSqlGpon(desdeData) : \"\""));
});

test("histórico e auditoria têm leitura protegida por permissão", () => {
  assert.match(worker, /\/api\/gpon\/history/);
  assert.match(worker, /\/api\/gpon\/sync-runs/);
  assert.match(worker, /async function handleGponHistory[\s\S]{0,200}requirePermission\(env, request, "topology\.view"\)/);
  assert.match(worker, /async function handleGponSyncRuns[\s\S]{0,200}requirePermission\(env, request, "audit\.view"\)/);
});

test("a retenção do histórico roda no cron mesmo sem Zabbix", () => {
  assert.match(worker, /async function podarHistoricoGpon/);
  const agendado = worker.slice(worker.indexOf("async scheduled(event, env, ctx)"));
  assert.ok(agendado.indexOf("podarHistoricoGpon") < agendado.indexOf("if (!env.ZABBIX_URL"),
    "a poda precisa acontecer antes da saída antecipada do Zabbix");
});

test("o coletor lê ONT e IXC em ciclos rápidos independentes", () => {
  assert.match(collector, /async function syncOnt\(\)/);
  assert.match(collector, /async function syncRadius\(\)/);
  assert.match(collector, /collectZteStates/);
  // Um ciclo lento não pode empilhar chamadas no mesmo equipamento.
  assert.match(collector, /state\.ontSyncing \|\| state\.syncing/);
  assert.match(collector, /state\.radiusSyncing \|\| state\.syncing/);
  // Os dois timers batem no mesmo intervalo curto.
  assert.match(collector, /setInterval\(\(\) => \{ void syncOnt\(\); \}, config\.intervalMs\)/);
  assert.match(collector, /setInterval\(\(\) => \{ void syncRadius\(\); \}, config\.intervalMs\)/);
});

test("a sessão da OLT é reaproveitada entre ciclos", () => {
  // Abrir SSH/Telnet a cada 10 s custaria mais que a própria consulta.
  assert.match(cli, /export async function withZteSession/);
  assert.match(cli, /export function closeZteSessions/);
  assert.match(cli, /entry\.queue = execucao\.then/);
  // Falha derruba a sessão em vez de reaproveitar um shell fora de sincronia.
  assert.match(cli, /entry\.shell = null;\s*\n\s*throw error;/);
});

test("a ONU acesa e o cliente autenticado aparecem na mesma linha", () => {
  assert.match(collector, /function combinarEstado/);
  assert.match(collector, /ONU ativa • Radius offline/);
});

test("a tela aplica o delta de estado sem rebaixar o snapshot inteiro", () => {
  assert.match(runtime, /async function patchStatus\(\)/);
  assert.match(runtime, /NOC\.api\("\/api\/gpon\/status"\)/);
  // A versão do snapshot é o que separa "mudou cadastro" de "mudou estado".
  assert.match(runtime, /revision\.version !== state\.revision\) return load\(false\)/);
  assert.match(runtime, /setInterval\(refreshIfChanged, 10000\)/);
});

test("o detalhe do cliente mostra a linha do tempo da ONU", () => {
  assert.match(runtime, /async function carregarHistorico/);
  assert.match(runtime, /\/api\/gpon\/history\?limit=25&client_id=/);
  // Clicar noutro cliente durante a busca não pode pintar o histórico errado.
  assert.match(runtime, /if \(token !== state\.historyToken\) return;/);
});
