import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const html = fs.readFileSync(new URL("../public/gpon.html", import.meta.url), "utf8");
const runtime = fs.readFileSync(new URL("../public/js/noc-gpon-map.js", import.meta.url), "utf8");
const css = fs.readFileSync(new URL("../public/css/noc/gpon-map.css", import.meta.url), "utf8");

test("Topologia GPON alterna mapa e lista usando o feed operacional", () => {
  assert.match(html, /data-gpon-view="map"/);
  assert.match(html, /data-gpon-view="list"/);
  assert.match(html, /id="gponMapView"/);
  assert.match(html, /id="gponListView"/);
  assert.match(html, /noc-gpon-map\.js/);
  assert.doesNotMatch(html, /noc-topology\.js/);
  assert.match(runtime, /NOC\.api\("\/api\/gpon\/clients"\)/);
  assert.match(runtime, /function renderTable\(\)/);
  assert.match(runtime, /data-client-map/);
});

test("o mapa da GPON traz o painel lateral completo", () => {
  assert.match(html, /id="gponFocus"/);
  assert.match(html, /id="mapSearchClear"/);
  assert.match(html, /data-status="offline"/);
  assert.match(html, /data-layer="drops"/);
  assert.match(html, /data-side-tab="alerts"/);
  assert.match(html, /id="sideToggle"/);
  assert.match(html, /id="mapCount"/);
  // As camadas deixaram de ser caixas de seleção de 13 px.
  assert.doesNotMatch(html, /<input type="checkbox" data-layer/);
});

test("coordenada 0,0 não conta como localização", () => {
  // Um cadastro sem GPS que grava zero levava o enquadramento para o Atlântico.
  assert.match(runtime, /NULL_ISLAND/);
  assert.match(runtime, /const hasCoord = \(o\) => !!o && GEO\.isCoord/);
});

test("o enquadramento descarta as caudas e não estoura a pilha", () => {
  // O espalhamento de todas as coordenadas em Math.min quebrava com base grande
  // (RangeError) e um único cadastro errado decidia o zoom de toda a operação.
  // O comentário do runtime cita a forma antiga, então a busca ignora comentários.
  const codigo = runtime.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*/g, "");
  assert.doesNotMatch(codigo, /Math\.(min|max)\(\.\.\./);
  assert.match(runtime, /function quantile\(/);
  assert.match(runtime, /function frame\(points, trim\)/);
});

test("o foco do mapa abre na maior concentração de clientes e é lembrado", () => {
  assert.match(runtime, /function computeAreas\(\)/);
  assert.match(runtime, /FOCUS_KEY/);
  assert.match(runtime, /localStorage\.setItem\(FOCUS_KEY, value\)/);
  assert.match(runtime, /state\.focus === "auto"/);
});

test("a atualização automática não reposiciona a câmera do operador", () => {
  assert.match(runtime, /if \(state\.view === "map" && !state\.fitted\) fit\(\);/);
  assert.match(runtime, /document\.visibilityState === "hidden"/);
});

test("o desenho do mapa é recortado, agrupado e limitado a um quadro", () => {
  assert.match(runtime, /function scheduleMap\(\)/);
  assert.match(runtime, /requestAnimationFrame\(\(\) => \{ state\.frame = 0; renderMap\(\); \}\)/);
  assert.match(runtime, /function cull\(wx0, wx1, wy0, wy1\)/);
  assert.match(runtime, /function lowerBound\(arr, v\)/);
  assert.match(runtime, /gpon-cluster/);
  assert.match(runtime, /SOLO_MAX/);
  // Índices no lugar de varredura linear dentro do laço de desenho.
  assert.match(runtime, /state\.idx\.device\.get\(String\(id\)\)/);
  assert.match(runtime, /state\.idx\.client\.get\(String\(id\)\)/);
});

test("o marcador é posicionado por translate, deixando transform para o CSS", () => {
  assert.match(runtime, /style="translate:\$\{x\.toFixed\(1\)\}px \$\{y\.toFixed\(1\)\}px"/);
  assert.match(css, /\.gpon-marker, \.gpon-cluster \{[^}]*transform: translate\(-50%, -50%\)/s);
});

test("no telefone o mapa aparece antes do painel de filtros", () => {
  assert.match(css, /\.gpon-map \{ order: 1;/);
  assert.match(css, /\.gpon-list-panel \{ order: 3;/);
});

test("o Worker repassa a porta da CTO, o código do ERP e a capacidade da caixa", () => {
  // O coletor já resolvia porta_ftth/ftth_porta do IXC, mas a normalização do
  // Worker descartava o campo e a tela da caixa nunca via a porta.
  const worker = fs.readFileSync(new URL("../src/worker.js", import.meta.url), "utf8");
  assert.match(worker, /box_port: String\(primeiroGpon\(c\?\.box_port, c\?\.porta_ftth, c\?\.ftth_porta/);
  assert.match(worker, /ixc_id: String\(primeiroGpon\(c\?\.ixc_id/);
  assert.match(worker, /capacity: numeroGpon\(primeiroGpon\(c\?\.capacity, c\?\.capacidade/);
});

test("nome do cliente na caixa vira primeiro + último nome", () => {
  const trecho = runtime.match(/const CONECTIVO = [\s\S]*?\n {2}\}/)[0];
  const shortName = new Function(`${trecho}; return shortName;`)();
  assert.equal(shortName("Maria Das Gracas De Oliveira Santos"), "Maria Santos");
  assert.equal(shortName("Ana Paula Rodrigues Da Silva Ferreira"), "Ana Ferreira");
  assert.equal(shortName("Jose Carlos"), "Jose Carlos");
  assert.equal(shortName("Joao"), "Joao");
  assert.equal(shortName("  "), "Sem nome");
});

test("a linha da caixa traz bolinha de estado, código, nome e porta", () => {
  assert.match(runtime, /class="gpon-box-client/);
  assert.match(runtime, /gpon-box-code/);
  assert.match(runtime, /gpon-box-name/);
  assert.match(runtime, /gpon-box-port/);
  assert.match(runtime, /r\.off \? "Offline" : r\.low \? "Sinal alto" : "Online"/);
  // ordenada como o painel físico: porta 2 antes da porta 10
  assert.match(runtime, /const porPorta = /);
  // o nome é a única coluna elástica e corta com reticências
  assert.match(css, /\.gpon-box-client \{[^}]*grid-template-columns: 8px minmax\(34px, auto\) minmax\(0, 1fr\) auto/s);
  assert.match(css, /\.gpon-box-name \{[^}]*text-overflow: ellipsis/s);
  // verde/vermelho/âmbar saem dos tokens de estado, não de cor cravada
  assert.match(css, /\.gpon-dot \{[^}]*background: var\(--ok-500\)/s);
  assert.match(css, /\.gpon-dot\.is-off \{ background: var\(--danger-500\)/);
  assert.match(css, /\.gpon-dot\.is-low \{ background: var\(--warn-500\)/);
});

test("o log RADIUS mostra que está vivo mesmo sem evento novo", () => {
  // O poll de 2 s só redesenhava quando chegava evento. Numa madrugada de
  // poucas transições o "atualizado há Xs" envelhecia na tela e o log parecia
  // ter parado — sem ter parado. O rodapé é separado do corpo justamente para
  // poder andar a cada volta sem reescrever centenas de <tr>.
  assert.match(runtime, /function renderRodape\(host\)/);
  assert.match(runtime, /function filtrados\(\)/);
  assert.match(runtime, /if \(rl\.ready\) renderRodape\(mountedHost\);/);
});

test("uma falha do poll do log RADIUS aparece na tela, não vira imobilidade", () => {
  // Continua sem toast (a cada 2 s seria insuportável), mas o catch vazio
  // fazia "servidor fora do ar" e "rede calma" ficarem idênticos para quem
  // olha. Hoje ~20% das requisições ao Worker falham, então o caso é real.
  assert.match(runtime, /rl\.erro = err\?\.message \|\| "falha na consulta"/);
  assert.match(runtime, /sem resposta do servidor • última leitura/);
  assert.doesNotMatch(runtime, /\} catch \{ \/\* silencioso: a próxima rodada de 2 s tenta de novo \*\/ \}/);
});
