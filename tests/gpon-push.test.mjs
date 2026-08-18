import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

test("rota GPON aceita ingestão protegida e usa snapshot como fonte", () => {
  const worker = fs.readFileSync(new URL("../src/worker.js", import.meta.url), "utf8");
  assert.match(worker, /GPON_SYNC_TOKEN/);
  assert.match(worker, /await timingSafeEqual\(authorization/);
  assert.match(worker, /gpon_snapshot_chunks/);
  assert.match(worker, /\/api\/gpon\/ingest/);
  assert.match(worker, /\/api\/gpon\/status/);
  assert.match(worker, /gpon_client_status/);
  assert.match(worker, /gpon_status_snapshot/);
  assert.match(worker, /\/api\/gpon\/revision/);
  assert.match(worker, /\/api\/gpon\/collector-status/);
  assert.match(worker, /loadGponSnapshot/);
});
