/* O POP é um cadastro só. Quem abre a topologia do NOC e quem abre a PARTE ISP
   olham para o mesmo prédio, o mesmo bastidor e o mesmo equipamento instalado
   lá dentro — os recortes existem para separar o que cada mapa desenha (anel,
   rotas, fibras), não para ter dois cadastros de POP que se contradizem.
   Os testes abaixo fixam essa regra e o limite dela: o cliente ISP continua
   sendo só da PARTE ISP, e equipamento sem POP continua só no recorte dono. */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createClient } from "@libsql/client";
import { createTursoD1 } from "../src/turso-d1.js";
import { montarPops, montarEquipamentos, persistPops, persistEquipamentos } from "../src/worker.js";

const worker = fs.readFileSync(new URL("../src/worker.js", import.meta.url), "utf8");

/* O esquema sai do próprio Worker: uma cópia aqui envelheceria sozinha e o
   teste passaria a garantir um banco que não existe mais. */
const ddl = (tabela) => {
  const achado = worker.match(new RegExp(`CREATE TABLE IF NOT EXISTS ${tabela} \\([\\s\\S]*?\\n\\);`));
  assert.ok(achado, `DDL de ${tabela} não encontrada no Worker`);
  return achado[0];
};

async function bancoDeTeste() {
  const client = createClient({ url: "file::memory:" });
  // locais.updated_by aponta para users: a tabela só precisa existir.
  await client.executeMultiple(`CREATE TABLE users(id INTEGER PRIMARY KEY);
${ddl("locais")}
${ddl("produtos")}
${ddl("topology_local_links")}`);
  const db = createTursoD1(client);

  const local = (id, nome, tipo) => db.prepare(
    `INSERT INTO locais(id,nome,tipo) VALUES (?,?,?)`).bind(id, nome, tipo);
  const link = (scope, id, ordem) => db.prepare(
    `INSERT INTO topology_local_links(scope,local_id,ordem) VALUES (?,?,?)`).bind(scope, id, ordem);
  const produto = (id, escopo, localId, categoria) => db.prepare(
    `INSERT INTO produtos(id,nome,categoria,local_id,escopo) VALUES (?,?,?,?,?)`)
    .bind(id, id, categoria, localId, escopo);

  await db.batch([
    local("pop-santos", "POP SANTOS", "POP"),
    local("dc-ascenty", "DC ASCENTY", "Data Center"),
    local("isp-dido", "dido net", "ISP"),
    // POP ligado só no mapa do NOC e Data Center ligado só no da PARTE ISP:
    // cada um foi criado em uma tela, e os dois valem para as duas.
    link("noc", "pop-santos", 0),
    link("isp", "dc-ascenty", 1),
    link("isp", "isp-dido", 2),
    produto("sw-santos", "noc", "pop-santos", "Agregação"),
    produto("ont-dido", "isp", "isp-dido", "ONT"),
    produto("core-f1a", "noc", null, "Núcleo"),
    produto("legado-pop", "noc", null, "POP")
  ]);
  return db;
}

const ids = (lista) => lista.map((x) => x.id).sort();

test("os dois mapas mostram os mesmos POPs, e só o cliente ISP fica de fora", async () => {
  const db = await bancoDeTeste();
  assert.deepEqual(ids(await montarPops(db, "noc")), ["dc-ascenty", "pop-santos"]);
  assert.deepEqual(ids(await montarPops(db, "isp")), ["dc-ascenty", "isp-dido", "pop-santos"]);
});

test("o POP volta uma vez só, com a posição do mapa que está sendo lido", async () => {
  const db = await bancoDeTeste();
  await db.prepare(`INSERT INTO topology_local_links(scope,local_id,ordem,rotas_json) VALUES ('isp','pop-santos',9,'["Aérea → Cubatão"]')`).run();
  const noAnelDoNoc = (await montarPops(db, "noc")).filter((p) => p.id === "pop-santos");
  assert.equal(noAnelDoNoc.length, 1, "POP ligado nos dois recortes não pode aparecer duplicado");
  assert.deepEqual(noAnelDoNoc[0].rotas, [], "vale a linha do recorte lido, não a do outro");
  assert.deepEqual((await montarPops(db, "isp")).find((p) => p.id === "pop-santos").rotas, ["Aérea → Cubatão"]);
});

test("equipamento em POP é dos dois mapas; sem POP, só do recorte dono", async () => {
  const db = await bancoDeTeste();
  // "legado-pop" é o equipamento do POP do cadastro antigo, que nasceu sem vínculo.
  assert.deepEqual(ids(await montarEquipamentos(db, "noc")), ["core-f1a", "legado-pop", "sw-santos"]);
  assert.deepEqual(ids(await montarEquipamentos(db, "isp")), ["legado-pop", "ont-dido", "sw-santos"]);
});

test("POP criado em um mapa nasce ligado no outro, sem mexer no anel de lá", async () => {
  const db = await bancoDeTeste();
  const before = { pops: await montarPops(db, "noc") };
  const after = { pops: [...before.pops, { id: "pop-novo", nome: "POP NOVO", tipo: "POP", rotas: ["Aérea → Santos"] }] };
  await persistPops(db, "noc", before, after, null);

  assert.ok((await montarPops(db, "isp")).some((p) => p.id === "pop-novo"), "o POP novo entra na PARTE ISP");
  // A ordem do outro mapa continua sendo dele: só o vínculo que faltava foi criado.
  const ordemIsp = await db.prepare(`SELECT ordem FROM topology_local_links WHERE scope='isp' AND local_id='dc-ascenty'`).first("ordem");
  assert.equal(Number(ordemIsp), 1);
});

test("cliente ISP criado na PARTE ISP não entra na topologia do NOC", async () => {
  const db = await bancoDeTeste();
  const before = { pops: await montarPops(db, "isp") };
  const after = { pops: [...before.pops, { id: "isp-novo", nome: "Cliente Novo", tipo: "ISP" }] };
  await persistPops(db, "isp", before, after, null);
  assert.ok(!(await montarPops(db, "noc")).some((p) => p.id === "isp-novo"));
});

test("excluir um POP o tira dos dois mapas; excluir um cliente ISP, só do dele", async () => {
  const db = await bancoDeTeste();
  const before = { pops: await montarPops(db, "isp") };
  await persistPops(db, "isp", before, { pops: before.pops.filter((p) => p.id !== "dc-ascenty") }, null);
  assert.ok(!(await montarPops(db, "noc")).some((p) => p.id === "dc-ascenty"),
    "deixar o POP em um mapa só o traria de volta na leitura seguinte");

  const antesIsp = { pops: await montarPops(db, "isp") };
  await persistPops(db, "isp", antesIsp, { pops: antesIsp.pops.filter((p) => p.id !== "isp-dido") }, null);
  assert.ok(!(await montarPops(db, "isp")).some((p) => p.id === "isp-dido"));
});

test("a tela grava o equipamento de POP que ela mostra, sem trocar o dono", async () => {
  const db = await bancoDeTeste();
  const before = { equipamentos: await montarEquipamentos(db, "isp") };
  const after = { equipamentos: before.equipamentos.map((e) => e.id === "sw-santos" ? { ...e, nome: "SW SANTOS (ISP)" } : e) };
  await persistEquipamentos(db, "isp", before, after, null);

  const row = await db.prepare(`SELECT nome,escopo FROM produtos WHERE id='sw-santos'`).first();
  assert.equal(row.nome, "SW SANTOS (ISP)", "equipamento de POP é o mesmo nos dois mapas e é editável nos dois");
  assert.equal(row.escopo, "noc", "o dono diz onde o equipamento foi cadastrado e não muda com a edição");
});

test("gravação não altera nem apaga o que o recorte não enxerga", async () => {
  const db = await bancoDeTeste();
  const visiveis = await montarEquipamentos(db, "isp");
  // "core-f1a" não está na PARTE ISP: uma gravação que o traga é ignorada.
  const before = { equipamentos: [...visiveis, { id: "core-f1a", nome: "sequestrado", portas: [] }] };
  await persistEquipamentos(db, "isp", before, { equipamentos: visiveis }, null);
  const row = await db.prepare(`SELECT nome FROM produtos WHERE id='core-f1a'`).first();
  assert.equal(row?.nome, "core-f1a", "equipamento fora do recorte não pode ser removido por ele");
});
