import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const html = fs.readFileSync(new URL("../public/gpon.html", import.meta.url), "utf8");
const htmlMapa = fs.readFileSync(new URL("../public/gpon-mapa.html", import.meta.url), "utf8");
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

test("as duas telas do mapa compartilham o mesmo painel lateral", () => {
  for (const pagina of [html, htmlMapa]) {
    assert.match(pagina, /id="gponFocus"/);
    assert.match(pagina, /id="mapSearchClear"/);
    assert.match(pagina, /data-status="offline"/);
    assert.match(pagina, /data-layer="drops"/);
    assert.match(pagina, /data-side-tab="alerts"/);
    assert.match(pagina, /id="sideToggle"/);
    assert.match(pagina, /id="mapCount"/);
    // As camadas deixaram de ser caixas de seleção de 13 px.
    assert.doesNotMatch(pagina, /<input type="checkbox" data-layer/);
  }
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
  assert.match(css, /\.gpon-side \{ order: 3;/);
});
