import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const worker = await readFile(new URL("../src/worker.js", import.meta.url), "utf8");
const page = await readFile(new URL("../public/crm.html", import.meta.url), "utf8");
const client = await readFile(new URL("../public/js/noc-crm.js", import.meta.url), "utf8");

test("CRM persiste funil, registros e histórico por setor", () => {
  assert.match(worker, /CREATE TABLE IF NOT EXISTS crm_stages/);
  assert.match(worker, /CREATE TABLE IF NOT EXISTS crm_cases/);
  assert.match(worker, /CREATE TABLE IF NOT EXISTS crm_activities/);
  assert.match(worker, /user_sectors visible/);
});

test("rotas do CRM exigem permissões granulares", () => {
  for (const permission of ["crm.view", "crm.create", "crm.edit", "crm.interact", "crm.delete"])
    assert.match(worker, new RegExp(`requirePermission\\(env,request,"${permission.replace(".", "\\.")}"\\)`));
  assert.match(worker, /\/api\/crm\/cases/);
});

test("tela oferece filtros, funil e criação de interações", () => {
  assert.match(page, /id="sectorTabs"/);
  assert.match(page, /id="crmContent"/);
  assert.match(client, /crm-board/);
  assert.match(client, /activities/);
});
