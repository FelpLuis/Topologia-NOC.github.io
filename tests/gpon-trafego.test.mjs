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
  assert.match(assinatura, /mib\(linha\.down_bytes\), mib\(linha\.up_bytes\)/);
  assert.match(collector, /const mib = \(bytes\)/);
});

test("a assinatura é calculada sobre a linha publicada, não sobre o cliente", () => {
  // Assinar o cliente e publicar uma projeção dele deixava as duas leituras
  // divergirem: Number(null) é 0, então o consumo ausente valia null de um lado
  // e 0 do outro, e toda ONU sem consumo no IXC voltava no delta a cada 10 s
  // sem ter mudado nada — o parque inteiro no fio, que é exatamente o que o
  // delta existe para evitar.
  assert.match(collector, /const linhaStatus = \(client\) => \(\{/);
  assert.match(collector, /const changes = state\.clients\.map\(linhaStatus\)/);
  assert.match(collector, /\.filter\(\(linha\) => state\.publishedStatus\.get\(linha\.id\) !== statusSignature\(linha\)\);/);
  assert.match(collector, /state\.publishedStatus\.set\(linha\.id, statusSignature\(linha\)\)/);
  // A semeadura do ciclo completo passa pela mesma projeção: sem ela o primeiro
  // ciclo rápido reenviaria o parque inteiro de novo.
  assert.match(collector, /statusSignature\(linhaStatus\(client\)\)/);
  // Ausência de dado não é zero: o consumo que o IXC não informa segue null.
  assert.match(collector, /if \(bytes === null \|\| bytes === undefined \|\| bytes === ""\) return null;/);
});

test("mudança só de conexão não vira transição, mas ainda é dado novo para servir", () => {
  const base = { status: "online", state_detail: "ONU working", rx_power: -21.4, tx_power: 2.1 };
  // Trocar de IP numa reconexão não é queda: poluir o histórico com isso
  // tornaria a linha do tempo ilegível justamente quando ela importa.
  assert.equal(transicaoGpon({ ...base, ip: "10.0.0.1" }, { ...base, ip: "10.0.0.9" }), null);

  // Mas o synced_at precisa andar, senão a tela nunca volta para buscar.
  assert.match(worker, /const conexaoNova = !anterior \|\| CONEXAO_GPON\.some\(campo => anterior\[campo\] !== atual\[campo\]\)/);
  assert.match(worker, /if \(mudadas\.length\) await db\.batch/);
  // A recíproca também importa: linha reenviada idêntica não pode ser gravada.
  // Escrever sem mudar nada faria o synced_at dela andar, e a leitura
  // incremental traria de volta uma ONU que não mexeu.
  assert.match(worker, /if \(mudanca \|\| conexaoNova\) mudadas\.push\(atual\);/);
});

test("o delta de 10 s não abre o parque inteiro", () => {
  // O estado corrente virou linha por cliente justamente para que a ingestão
  // custe o tamanho da mudança e não o do parque: com o blob JSON, cada ciclo
  // parseava ~2,5 MB, montava um Map de ~8,9 mil entradas e reescrevia tudo —
  // acima do teto de CPU do Worker, e o isolate morrendo levava junto login e
  // páginas em voo.
  assert.ok(!/gpon_status_snapshot/.test(worker.slice(worker.indexOf("async function handleGponStatusIngest"))),
    "o delta não pode voltar a tocar no blob de estado");
  assert.match(worker, /const anteriores = await lerEstadoGpon\(db, rows\.map\(row => row\.id\)\)/);
  // Um statement grava N clientes: o array vai como parâmetro e o json_each o
  // abre dentro do banco. Um statement por cliente estouraria as duas contas —
  // CPU no Worker e subrequisições por invocação.
  // O WHERE não é decorativo: sem ele o parser do SQLite lê o ON CONFLICT como
  // o ON de um join e recusa a instrução inteira.
  assert.match(worker, /FROM json_each\(\?1\) AS j WHERE json_extract\(j\.value,'\$\.client_id'\)<>''\s*\n\s*ON CONFLICT\(client_id\) DO UPDATE/);
  assert.match(worker, /JOIN json_each\(\?1\) j ON j\.value=s\.client_id/);
  // Os totais do ciclo saem de uma contagem no banco: contar em JavaScript
  // exigiria trazer o parque de volta, que é o que se está evitando.
  assert.match(worker, /SUM\(CASE WHEN status IN \(\$\{lista\}\) THEN 1 ELSE 0 END\) AS online/);
});

test("a leitura de estado é montada pelo SQLite, não pelo Worker", () => {
  // json_group_array devolve o array pronto como UMA string: nem a leitura
  // completa materializa milhares de objetos JavaScript no isolate.
  assert.match(worker, /const ESTADO_GPON_JSON = `json_group_array\(json_object\(/);
  assert.match(worker, /FROM gpon_client_status WHERE synced_at>\?/);
  // E o corpo é concatenado como texto: parsear o array só para reserializá-lo
  // pagaria duas vezes o único custo que a rota tem.
  assert.match(worker, /"partial":\$\{desde \? "true" : "false"\},"clients":\$\{clientes\}\}/);
});

test("os caminhos de escrita do Worker produzem os mesmos campos de conexão", () => {
  // Snapshot completo e delta passam pelo mesmo normalizador: divergir faria a
  // ficha do cliente mudar de forma conforme o ciclo que chegou por último.
  assert.match(worker, /const conexaoGpon = \(c\) => \(\{/);
  assert.match(worker, /const CONEXAO_GPON = \["ip", "down_kbps", "up_kbps", "down_bytes", "up_bytes", "uptime_s", "conn_since", "nas_id"\]/);
  assert.equal(worker.match(/conexaoGpon\(/g).length, 3,
    "normalizador do cliente, compacto da fotografia e delta");
  assert.match(worker, /conexao: conexaoGpon\(change\)/, "o delta normaliza antes de comparar");

  // A LEITURA não normaliza mais: desde que o estado virou linha por cliente,
  // ela devolve as colunas como estão. Normalizar na saída obrigaria o Worker a
  // percorrer o parque a cada leitura — o custo que a mudança existe para
  // eliminar. Em troca, a lista de campos precisa bater nos dois lugares.
  const gravados = worker.match(/const ESTADO_GPON_CAMPOS = \[([^\]]+)\]/)[1];
  const lidos = worker.match(/const ESTADO_GPON_JSON = `json_group_array\(json_object\(([\s\S]*?)\)\)`/)[1];
  for (const campo of ["ip", "down_kbps", "up_kbps", "down_bytes", "up_bytes", "uptime_s", "conn_since", "nas_id"]) {
    assert.ok(gravados.includes(`"${campo}"`), `${campo} precisa ser gravado`);
    assert.ok(lidos.includes(`'${campo}',${campo}`), `${campo} precisa ser lido`);
  }
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
  // Pelo TEMPO, e não por um Date.parse solto: o coletor manda o instante em
  // UTC, e lê-lo como hora local devolvia um uptime três horas maior.
  assert.match(runtime, /const inicio = TEMPO\.instante\(c\.conn_since\);/);
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
