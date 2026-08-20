import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const ler = (rel) => fs.readFileSync(new URL(rel, import.meta.url), "utf8");

const worker = ler("../src/worker.js");
const api = ler("../public/js/noc-api.js");
const traf = ler("../public/js/noc-trafego-enlace.js");
const css = ler("../public/css/noc/trafego-enlace.css");
const topology = ler("../public/js/noc-topology.js");
const pops = ler("../public/js/noc-pops.js");
const gpon = ler("../public/js/noc-gpon-map.js");

const TELAS = ["topologia", "isp", "isp-mapa", "pops", "gpon"];

test("worker publica a utilização por interface para os mapas", () => {
  assert.match(worker, /\/api\/zabbix\/utilizacao/);
  assert.match(worker, /handleZabbixUtilizacao/);
  // A leitura é do espelho no D1, não da API do Zabbix: tela aberta não pode
  // virar carga no monitoramento.
  assert.match(worker, /FROM zabbix_interfaces/);
  // O recorte precisa das colunas que viram cor e dica.
  for (const coluna of ["oper_status", "speed_bps", "in_bps", "out_bps"]) {
    assert.match(worker, new RegExp(`${coluna}:`), `falta ${coluna} na resposta`);
  }
  // A chave que casa com a porta da topologia é (hostid, if_index).
  assert.match(worker, /hostid: String\(i\.hostid\)/);
  assert.match(worker, /if_index: Number\(i\.if_index\)/);
  // Ver o tráfego exige a mesma ação de ver o Zabbix.
  assert.match(worker, /handleZabbixUtilizacao[\s\S]{0,320}requirePermission\(env, request, "zabbix\.view"\)/);
});

test("cliente da API expõe a leitura de utilização", () => {
  assert.match(api, /utilizacao: [\s\S]{0,120}\/api\/zabbix\/utilizacao/);
});

test("a escala tem as dez faixas da legenda, na ordem", () => {
  const faixas = [...traf.matchAll(/\{ min: (\d+),\s+rotulo: "([^"]+)",\s+cor: "(#[0-9a-f]{6})" \}/g)]
    .map(([, min, rotulo, cor]) => ({ min: Number(min), rotulo, cor }));

  assert.deepEqual(faixas.map((f) => f.rotulo),
    ["0%", "1%", "5%", "15%", "25%", "50%", "70%", "80%", "90%"]);
  // O rótulo é o próprio limite da faixa: um não pode desandar do outro.
  assert.deepEqual(faixas.map((f) => `${f.min}%`), faixas.map((f) => f.rotulo));
  // Crescente: uma faixa nunca começa antes da anterior.
  const mins = faixas.map((f) => f.min);
  assert.deepEqual(mins, [...mins].sort((a, b) => a - b));
  // Offline fica fora da escala de uso, como na legenda de referência.
  assert.match(traf, /const OFFLINE = \{ rotulo: "Offline", cor: "#[0-9a-f]{6}" \}/);
  // Cada faixa tem cor própria: duas iguais tornariam a legenda ilegível.
  const cores = faixas.map((f) => f.cor);
  assert.equal(new Set(cores).size, cores.length);
});

test("enlace sem interface monitorada não recebe cor de uso", () => {
  // "sem dado" é um estado à parte de "0%": pintar os dois igual afirmaria
  // ausência de tráfego onde ninguém mediu.
  assert.match(traf, /const SEM_DADO = \{ rotulo: "Sem dado"/);
  assert.match(traf, /if \(!m \|\| m\.estado === "sem-dado"\) return SEM_DADO;/);
  assert.match(traf, /if \(m\.estado === "offline"\) return OFFLINE;/);
});

test("a medida do enlace não conta o mesmo tráfego duas vezes", () => {
  // Ponto a ponto é simétrico: a leitura vem de uma ponta só.
  assert.match(traf, /const ref = \(a && a\.medido \? a : null\) \|\| \(b && b\.medido \? b : null\);/);
  // A capacidade é a da ponta mais estreita.
  assert.match(traf, /Math\.min\(\.\.\.capacidades\)/);
  // Utilização é o pico entre as direções sobre a capacidade.
  assert.match(traf, /Math\.max\(entrada, saida\) \/ capacidade/);
  // Sem capacidade conhecida não há percentual inventado.
  assert.match(traf, /capacidade > 0\s*\?\s*\(Math\.max/);
});

test("a dica de tráfego mostra entrada, saída e utilização", () => {
  assert.match(traf, /Entrada \$\{bps\(m\.entrada\)\} · Saída \$\{bps\(m\.saida\)\}/);
  assert.match(traf, /\$\{pctTexto\(m\.pct\)\} de \$\{bps\(m\.capacidade\)\}/);
  // A dica flutuante existe porque o <title> nativo demora e some ao mover o
  // ponteiro; as duas saem do mesmo texto para não divergirem.
  assert.match(traf, /function ligarDica/);
  assert.match(traf, /dica: linhas\.join\("\|"\), title: linhas\.join\(" — "\)/);
  assert.match(css, /\.traf-dica \{/);
});

test("a legenda mostra a escala inteira, com a contagem de cada faixa", () => {
  assert.match(traf, /function legendaHTML/);
  // Faixa vazia continua visível: é a posição fixa que permite ler a cor.
  assert.match(traf, /ESCALA\.map\(\(f\) => item\(f, conta\.get\(f\.rotulo\) \|\| 0\)\)/);
  assert.match(traf, /item\(OFFLINE, conta\.get\(OFFLINE\.rotulo\) \|\| 0\)/);
  assert.match(css, /\.traf-legenda \{/);
  assert.match(css, /\.traf-faixa i \{[\s\S]{0,160}background: var\(--traf-cor\)/);
});

test("a leitura se repete sozinha e para com a aba escondida", () => {
  assert.match(traf, /function acompanhar/);
  assert.match(traf, /visibilitychange/);
  assert.match(traf, /if \(!state\.inscritos\.size \|\| document\.hidden\) return;/);
  // Falha de rede não apaga a última medida boa.
  assert.match(traf, /state\.erro = err\?\.message[\s\S]{0,80}avisar\(\);/);
});

test("o aviso percorre os inscritos pela chave do mapa", () => {
  // `inscritos` é um Map de callback -> necessidade. Percorrê-lo como se fosse
  // um Set entrega o VALOR no lugar da função, e nenhuma tela repinta —
  // silenciosamente, porque o erro cai no catch de isolamento.
  assert.match(traf, /state\.inscritos\.forEach\(\(_, cb\) =>/);
  assert.doesNotMatch(traf, /state\.inscritos\.forEach\(\(cb\) =>/);
  // Um inscrito que quebra não derruba os outros, mas também não some do log.
  assert.match(traf, /catch \(err\) \{ console\.error\(/);
});

test("topologia pinta enlace e anel pela escala e monta a legenda", () => {
  assert.match(topology, /TRAF\.doConjunto\(e\.conns\)/);
  assert.match(topology, /TRAF\.doConjunto\(conexoesEntreSites\(r\.a, r\.b\)\)/);
  // A cor sai inline porque precisa vencer as regras de estado da folha.
  assert.match(topology, /style="stroke:\$\{t\.cor\}"/);
  assert.match(topology, /data-traf="\$\{esc\(t\.dica\)\}"/);
  // Faixa larga e invisível: uma linha de 2 px é fina demais para o ponteiro.
  assert.match(topology, /class="traf-alvo"/);
  assert.match(topology, /TRAF\.legendaHTML\(medidas\)/);
  assert.match(topology, /TRAF\.ligarDica\(stage\(\)\)/);
  assert.match(topology, /TRAF\.acompanhar\(renderEdges\)/);
});

test("anel de POPs usa a mesma escala, com o tracejado ainda dizendo a rota", () => {
  assert.match(pops, /function conexoesEntrePops/);
  assert.match(pops, /TRAF\.doConjunto\(conexoesEntrePops\(l\.a, l\.b\)\)/);
  assert.match(pops, /stroke="\$\{t\.cor\}" stroke-dasharray="\$\{sub \? "6 5" : "0"\}"/);
  assert.match(pops, /TRAF\.legendaHTML\(medidas\)/);
  assert.match(pops, /TRAF\.acompanhar\(renderRing\)/);
  // A legenda antiga dizia que ciano era rota aérea; agora a cor é tráfego.
  assert.doesNotMatch(pops, /background:var\(--cyan-400\);display:block"><\/i> Rota aérea/);
});

test("mapa GPON pinta a conexão de rede sem varrer os enlaces a cada quadro", () => {
  assert.match(gpon, /cargaDoPar\(a\.id, b\.id\)/);
  assert.match(gpon, /function indexarCarga/);
  // O índice é descartado quando a topologia muda e a cada leitura nova.
  assert.match(gpon, /cargaPorPar = null;\s+\/\/ a topologia mudou/);
  assert.match(gpon, /TRAF\.acompanhar\(\(\) => \{ cargaPorPar = null; scheduleMap\(\); \}\)/);
  assert.match(gpon, /gpon-route-network is-traf/);
  assert.match(gpon, /TRAF\.legendaHTML\(medidas\)/);
  // O SVG das rotas é inerte ao ponteiro; só a faixa de acerto volta a receber.
  assert.match(css, /\.gpon-routes \.traf-alvo \{ pointer-events: stroke; \}/);
});

test("todas as telas de mapa carregam o módulo e a folha de estilo", () => {
  for (const tela of TELAS) {
    const html = ler(`../public/${tela}.html`);
    assert.match(html, /<script src="\/js\/noc-trafego-enlace\.js/, `${tela}.html sem o módulo`);
    assert.match(html, /<link rel="stylesheet" href="\/css\/noc\/trafego-enlace\.css/, `${tela}.html sem a folha`);
  }
});

test("as telas da topologia têm onde desenhar a legenda", () => {
  for (const tela of ["topologia", "isp", "isp-mapa"]) {
    assert.match(ler(`../public/${tela}.html`), /id="trafLegend"/, `${tela}.html sem o espaço da legenda`);
  }
  assert.match(ler("../public/gpon.html"), /id="gponTrafLegend"/);
});

test("a legenda também aparece no mapa geográfico", () => {
  // Sem declarar os dois modos, `setView` esconde o painel ao sair do esquema
  // — justamente onde o mapa com as cidades e os enlaces coloridos aparece.
  for (const tela of ["topologia", "isp"]) {
    assert.match(ler(`../public/${tela}.html`),
      /id="legend" data-views="mapa geo"/, `${tela}.html não mostra a legenda no mapa`);
  }
  assert.match(ler("../public/isp-mapa.html"), /id="legend" data-views="geo"/);
});

test("setView não estoura nas telas sem a aba POPs", () => {
  // isp.html e isp-mapa.html não têm #popsView. Sem a guarda, `setView`
  // estourava antes de aplicar a legenda, o fundo do mapa e o enquadramento.
  assert.match(topology, /const popsView = \$\("#popsView"\);\s+if \(popsView\) popsView\.hidden/);
  assert.doesNotMatch(topology, /\$\("#popsView"\)\.hidden/);
  for (const tela of ["isp", "isp-mapa"]) {
    assert.doesNotMatch(ler(`../public/${tela}.html`), /id="popsView"/);
  }
});
