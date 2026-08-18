import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const html = fs.readFileSync(new URL("../public/gpon.html", import.meta.url), "utf8");
const runtime = fs.readFileSync(new URL("../public/js/noc-gpon-map.js", import.meta.url), "utf8");

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
