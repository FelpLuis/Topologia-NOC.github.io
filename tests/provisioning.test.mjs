import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const worker = fs.readFileSync(new URL("../src/worker.js", import.meta.url), "utf8");
const provision = fs.readFileSync(new URL("../collector/provision.mjs", import.meta.url), "utf8");
const env = fs.readFileSync(new URL("../collector/env.mjs", import.meta.url), "utf8");
const collector = fs.readFileSync(new URL("../collector/server.mjs", import.meta.url), "utf8");
const topology = fs.readFileSync(new URL("../public/js/noc-topology.js", import.meta.url), "utf8");
const platform = fs.readFileSync(new URL("../public/js/noc-platform.js", import.meta.url), "utf8");

test("Worker expõe o fluxo de provisionamento de usuários", () => {
  assert.match(worker, /userDeviceCredentialsMatch=url\.pathname\.match/);
  assert.match(worker, /\/api\/provisioning\/pending/);
  assert.match(worker, /provisioningReportMatch=url\.pathname\.match/);
  assert.match(worker, /device_target_provisioning/);
  assert.match(worker, /topology\.connection\.provision/);
  assert.match(worker, /PROVISIONING_TOKEN\|\|env\.GPON_SYNC_TOKEN/);
  assert.match(worker, /DEVICE_PROVISIONING_QUEUED/);
  assert.match(worker, /DEVICE_PROVISIONING_REPORT/);
  assert.match(worker, /provisionAdditionalData/);
});

test("Worker catalogava fabricantes do coletor e valida credencial de provisionamento", () => {
  assert.match(worker, /zte:/);
  assert.match(worker, /huawei:/);
  assert.match(worker, /cisco:/);
  assert.match(worker, /mikrotik:/);
  assert.match(worker, /datacom:/);
  assert.match(worker, /nokia:/);
  assert.match(worker, /linux:/);
  assert.match(worker, /FABRICANTE_INVALIDO/);
  assert.match(worker, /SENHA_DE_PROVISIONAMENTO_OBRIGATORIA/);
  assert.match(worker, /CRIPTOGRAFIA_DE_CREDENCIAIS_NAO_CONFIGURADA/);
});

test("Coletor cria comandos por fabricante e reporta ao Worker", () => {
  assert.match(provision, /ADAPTERS/);
  for (const vendor of ["zte", "huawei", "cisco", "mikrotik", "datacom", "nokia", "linux"]) {
    assert.match(provision, new RegExp(`${vendor}:\\s*\\{`));
  }
  assert.match(provision, /provisionPendingJobs/);
  assert.match(provision, /\/api\/provisioning\/pending/);
  assert.match(provision, /\/report/);
  assert.match(provision, /AbortSignal\.timeout/);
});

test("coletor e provisionamento falam do mesmo objeto de configuração", () => {
  // O objeto que server.mjs entrega é o "provisioning" de env.mjs — {url,
  // pushToken, intervalMs}. Ler outro nome dentro de provision.mjs não é erro
  // de sintaxe nem de tipo: vira undefined, e o provisionamento morre a cada
  // ciclo alegando configuração ausente enquanto o log de partida jura que
  // está ativo. Só conferir os nomes dos dois lados pega isso.
  assert.match(env, /provisioning: \{/);
  assert.match(env, /url: provisioningUrl,/);
  assert.match(collector, /provisionPendingJobs\(config\.provisioning,/);
  assert.match(provision, /const base = String\(config\.url \|\| ""\)/);
  assert.doesNotMatch(provision, /config\.provisioningUrl/);
});

test("Frontend de topologia coleta fabricante e credencial bootstrap do destino", () => {
  assert.match(topology, /name="vendor"/);
  assert.match(topology, /name="provision_username"/);
  assert.match(topology, /name="provision_password"/);
  assert.match(topology, /provision_password/);
  assert.match(topology, /Provisionamento ativo/);
});

test("Frontend da plataforma permite definir acessos SSH por usuário", () => {
  assert.match(platform, /openUserDeviceAccess/);
  assert.match(platform, /data-device-access/);
  assert.match(platform, /NOC\.userDeviceCredentials\.get/);
  assert.match(platform, /NOC\.userDeviceCredentials\.save/);
  assert.match(platform, /provisonBadge|provisionBadge/);
});

test("Adaptadores geram comandos esperados para criar o usuário", async () => {
  const { ADAPTERS } = await import("../collector/provision.mjs");
  const cmds = (vendor, user, pass) =>
    ADAPTERS[vendor].steps(user, pass).map((entry) => (typeof entry === "string" ? entry : entry.cmd));
  assert.ok(cmds("cisco", "fulano", "s3cret").includes("username fulano privilege 15 secret s3cret"));
  assert.ok(cmds("huawei", "fulano", "s3cret").some((c) => c.includes("local-user fulano password cipher s3cret")));
  assert.ok(cmds("zte", "fulano", "s3cret").some((c) => c.includes("user add username fulano password s3cret")));
  assert.ok(cmds("mikrotik", "fulano", "s3cret").some((c) => c.includes("user add name=fulano password=s3cret group=full")));
  assert.ok(cmds("linux", "fulano", "s3cret").some((c) => c.includes("chpasswd")));
});