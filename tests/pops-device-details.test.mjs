import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const client = await readFile(new URL("../public/js/noc-pops.js", import.meta.url), "utf8");

test("POPs oferece detalhes editáveis para equipamentos vinculados", () => {
  assert.match(client, /data-device-details=/);
  assert.match(client, /function openDeviceDetails\(deviceId\)/);
  assert.match(client, /topology\.equipment\.edit/);
  assert.match(client, /await NOC\.save\("TOPOLOGY_UPDATE"\)/);
});

test("a ficha preserva o acesso à topologia completa", () => {
  assert.match(client, /Abrir na Topologia/);
  assert.match(client, /\/topologia\.html\?device=/);
});
