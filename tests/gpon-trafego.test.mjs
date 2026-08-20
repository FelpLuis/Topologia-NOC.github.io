import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import { transicaoGpon } from "../src/worker.js";

const worker = fs.readFileSync(new URL("../src/worker.js", import.meta.url), "utf8");
const collector = fs.readFileSync(new URL("../collector/server.mjs", import.meta.url), "utf8");
const ixc = fs.readFileSync(new URL("../collector/ixc-client.mjs", import.meta.url), "utf8");
const runtime = fs.readFileSync(new URL("../public/js/noc-gpon-map.js", import.meta.url), "utf8");
const pagina = fs.readFileSync(new URL("../public/gpon.html", import.meta.url), "utf8");

test("o ciclo rápido do Radius aproveita a mesma paginação para trazer a conexão", () => {
  // Ler só o "online" de uma resposta que já traz IP, velocidade e consumo era
  // pagar a paginação inteira do IXC e jogar o resultado fora.
  assert.match(ixc, /export function radiusConnection/);
  assert.match(ixc, /return new Map\(logins\.map\(\(login\) => \[text\(login\.id\), radiusConnection\(login\)\]\)\);/);
  // Os dois ritmos extraem os mesmos campos: divergir faria o estado do
  // cliente oscilar conforme o ciclo que chegou por último.
  assert.match(ixc, /export const RADIUS_FIELDS/);
  assert.match(ixc, /const loginById = indexSelected\(logins, \["id_cliente", "id_contrato", \.\.\.RADIUS_FIELDS/);
  assert.match(ixc, /\.\.\.conexaoNoCliente\(radiusConnection\(login\)\)/);
});

test("tráfego e conexão viajam no delta de 10 s junto do estado", () => {
  assert.match(collector, /ip: client\.ip \|\| "", down_kbps: client\.down_kbps/);
  assert.match(collector, /uptime_s: client\.uptime_s \?\? null, conn_since: client\.conn_since/);
  // O ciclo completo semeia a conexão inteira; semear só o "S"/"N" faria a
  // ficha piscar vazia entre o cadastro e o primeiro ciclo rápido.
  assert.match(collector, /const radiusOnline = \(entry\)/);
  assert.match(collector, /const radiusDados = \(entry\)/);
});

test("uptime fica fora da assinatura do delta e o consumo entra arredondado", () => {
  // Uptime avança um segundo por segundo: incluí-lo faria todo cliente online
  // ocupar uma linha do delta a cada ciclo — o parque inteiro no fio de 10 em
  // 10 segundos, exatamente o que o delta existe para evitar.
  const assinatura = collector.slice(collector.indexOf("const statusSignature"),
    collector.indexOf("async function enviarStatus"));
  assert.ok(!/uptime_s/.test(assinatura), "uptime não pode entrar na assinatura");
  assert.match(assinatura, /conn_since/, "o instante da conexão é o substituto estático do uptime");
  assert.match(assinatura, /mib\(client\.down_bytes\), mib\(client\.up_bytes\)/);
  assert.match(collector, /const mib = \(bytes\)/);
});

test("mudança só de conexão não vira transição, mas ainda é dado novo para servir", () => {
  const base = { status: "online", state_detail: "ONU working", rx_power: -21.4, tx_power: 2.1 };
  // Trocar de IP numa reconexão não é queda: poluir o histórico com isso
  // tornaria a linha do tempo ilegível justamente quando ela importa.
  assert.equal(transicaoGpon({ ...base, ip: "10.0.0.1" }, { ...base, ip: "10.0.0.9" }), null);

  // Mas o synced_at precisa andar, senão a tela nunca volta para buscar.
  assert.match(worker, /let conexoesMudadas = 0;/);
  assert.match(worker, /CONEXAO_GPON\.some\(campo => anterior\[campo\] !== atual\[campo\]\)/);
  assert.match(worker, /if \(transicoes\.length \|\| conexoesMudadas\) await db\.batch/);
});

test("os três caminhos do Worker produzem os mesmos campos de conexão", () => {
  // Snapshot completo, delta e leitura de estado passam pelo mesmo
  // normalizador: divergir faria a ficha do cliente mudar de forma conforme o
  // ciclo que chegou por último.
  assert.match(worker, /const conexaoGpon = \(c\) => \(\{/);
  assert.match(worker, /const CONEXAO_GPON = \["ip", "down_kbps", "up_kbps", "down_bytes", "up_bytes", "uptime_s", "conn_since", "nas_id"\]/);
  assert.equal(worker.match(/conexaoGpon\(/g).length, 4,
    "normalizador do cliente, compacto da fotografia, delta e leitura de estado");
  assert.match(worker, /conexao: conexaoGpon\(change\)/, "o delta normaliza antes de comparar");
});

test("a tela aplica tráfego e conexão sem redesenhar o parque", () => {
  assert.match(runtime, /const CONEXAO = \["ip", "down_kbps"/);
  assert.match(runtime, /for \(const campo of CONEXAO\)/);
  // Nenhum marcador muda de cor quando só o tráfego andou: redesenhar o mapa
  // inteiro seria desperdício, mas a ficha aberta precisa do número novo.
  assert.match(runtime, /if \(conexao && state\.selected\?\.type === "client"\) renderDetail\(true\);/);
});

test("o re-render de 10 s não recarrega o histórico já aberto", () => {
  // Sem isso, a linha do tempo virava "Carregando…" seis vezes por minuto e
  // cada volta gastava uma consulta para trazer o mesmo resultado.
  assert.match(runtime, /function renderDetail\(manterHistorico\)/);
  assert.match(runtime, /const historicoAtual = manterHistorico \? \$\("#gponHistory"\)\?\.innerHTML : null;/);
  assert.match(runtime, /if \(historicoAtual === null \|\| historicoAtual === undefined\) carregarHistorico\(c\.id\);/);
});

test("a ficha e a lista mostram velocidade, IP e tempo de conexão", () => {
  assert.match(runtime, /<span>Velocidade<\/span>/);
  assert.match(runtime, /<span>Conectado há<\/span>/);
  assert.match(runtime, /consumo\(c\) \? `<div><span>Consumo<\/span>/);
  assert.match(pagina, /<th>Velocidade \/ IP<\/th>/);
  // A coluna nova precisa do colspan do estado vazio junto, senão a linha de
  // "nenhum cliente" desalinha a tabela inteira.
  assert.match(runtime, /colspan="8"/);
});

test("o uptime é derivado na tela a partir do instante da conexão", () => {
  // Mandar o contador obrigaria todo cliente online a ocupar o delta a cada
  // ciclo; mandar o instante deixa o relógio vivo de graça.
  assert.match(runtime, /function duracao\(c\)/);
  assert.match(runtime, /Date\.parse\(String\(c\.conn_since \|\| ""\)\.replace\(" ", "T"\)\)/);
});

test("o botão Atualizar força a releitura da OLT e do IXC", () => {
  // O manual não é o ciclo de 10 s com outro nome: ele pede sincronização
  // forçada ao coletor, que relê a OLT inteira e ignora a janela do IXC.
  assert.match(runtime, /manual \? NOC\.api\("\/api\/gpon\/refresh", \{ method: "POST" \}\)/);
  assert.match(worker, /async function handleGponRefresh/);
  assert.match(worker, /sourceUrl\.pathname = "\/api\/gpon\/sync";/);
  assert.match(collector, /await syncFull\(true\);/);
  assert.match(collector, /const refreshIxc = forcar \|\| !state\.ixc \|\| Date\.now\(\) - state\.ixcSyncedAt >= config\.ixcIntervalMs;/);
});
