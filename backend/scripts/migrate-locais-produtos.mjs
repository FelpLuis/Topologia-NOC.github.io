#!/usr/bin/env node
//
// Preenche as tabelas `locais` e `produtos` a partir do que já está gravado
// em topology_state (rede NOC) e topology_scopes (recorte ISP) — os arrays
// `pops` e `equipamentos` que hoje vivem soltos dentro do blob JSON de cada
// recorte.
//
// Um mesmo id de POP pode existir nos dois recortes (ambos nasceram do mesmo
// pops.json) e pode ter divergido depois de editado separadamente; um mesmo
// id de equipamento também pode existir nos dois quando o recorte ISP herdou,
// na primeira semeadura, uma cópia de um equipamento de backbone do NOC (ver
// loadInitialTopology em src/worker.js). Em qualquer conflito de id, o
// registro do recorte "noc" vence — é o dado "real"; a cópia do ISP era só
// contexto visual, listada no relatório para conferência manual.
//
// Uso:
//   node backend/scripts/migrate-locais-produtos.mjs             # ensaio (não grava)
//   node backend/scripts/migrate-locais-produtos.mjs --apply     # grava de verdade
//
// Credenciais: lidas de .dev.vars (ou das variáveis de ambiente),
// TURSO_DATABASE_URL e TURSO_AUTH_TOKEN.

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@libsql/client";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const apply = process.argv.includes("--apply");

function loadEnv() {
  const env = { ...process.env };
  try {
    const text = readFileSync(resolve(ROOT, ".dev.vars"), "utf8");
    for (const line of text.split(/\r?\n/)) {
      const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (match && !env[match[1]]) env[match[1]] = match[2];
    }
  } catch {
    // .dev.vars é opcional quando as variáveis já estão no ambiente.
  }
  return env;
}

const env = loadEnv();
const url = String(env.TURSO_DATABASE_URL || "").trim();
const authToken = String(env.TURSO_AUTH_TOKEN || "").trim();
if (!url || !authToken) {
  console.error("Faltam TURSO_DATABASE_URL / TURSO_AUTH_TOKEN (ambiente ou .dev.vars).");
  process.exit(1);
}
const db = createClient({ url, authToken });

const LOCAL_TIPOS = new Set(["POP", "Data Center", "ISP"]);

console.log(`Lendo o banco (${apply ? "aplicando" : "ensaio, nada será gravado"})...`);

const nocRow = (await db.execute(`SELECT data_json FROM topology_state WHERE id=1`)).rows[0];
if (!nocRow) {
  console.error("topology_state está vazia. Abra o mapa NOC na aplicação uma vez para inicializá-la.");
  process.exit(1);
}
const nocDoc = JSON.parse(nocRow[0]);

const ispRow = (await db.execute(`SELECT data_json FROM topology_scopes WHERE scope='isp'`)).rows[0];
const ispDoc = ispRow ? JSON.parse(ispRow[0]) : { pops: [], equipamentos: [] };

const recortes = [
  ["noc", nocDoc],
  ["isp", ispDoc]
];

// ---- locais (a partir de pops[]) ----
const locaisPorId = new Map(); // id -> {row, scope}
const linksPorScope = []; // {scope, local_id, ordem, rotas_json, legado_equipamentos_json}
const conflitosLocal = [];

for (const [scope, doc] of recortes) {
  const pops = Array.isArray(doc.pops) ? doc.pops : [];
  pops.forEach((pop, indice) => {
    if (!pop?.id) return;
    const atual = locaisPorId.get(pop.id);
    const candidato = {
      id: String(pop.id),
      nome: String(pop.nome || "").trim(),
      tipo: LOCAL_TIPOS.has(pop.tipo) ? pop.tipo : "POP",
      endereco: String(pop.endereco || "").trim(),
      lat: Number.isFinite(pop.lat) ? pop.lat : null,
      lon: Number.isFinite(pop.lon) ? pop.lon : null,
      observacao: String(pop.observacao || "").trim()
    };
    if (atual && atual.scope !== scope && JSON.stringify(atual.row) !== JSON.stringify(candidato)) {
      conflitosLocal.push({ id: pop.id, ganhou: atual.scope, perdeu: scope });
    }
    // "noc" sempre vence; entre dois do mesmo recorte (não deveria acontecer),
    // fica o primeiro.
    if (!atual || (atual.scope !== "noc" && scope === "noc")) {
      locaisPorId.set(pop.id, { row: candidato, scope });
    }
    linksPorScope.push({
      scope,
      local_id: String(pop.id),
      ordem: indice,
      rotas_json: JSON.stringify(Array.isArray(pop.rotas) ? pop.rotas : []),
      legado_equipamentos_json: JSON.stringify(Array.isArray(pop.equipamentos) ? pop.equipamentos : [])
    });
  });
}

// ---- produtos (a partir de equipamentos[]) ----
const produtosPorId = new Map(); // id -> {row, scope}
const conflitosProduto = [];

for (const [scope, doc] of recortes) {
  const equipamentos = Array.isArray(doc.equipamentos) ? doc.equipamentos : [];
  for (const eq of equipamentos) {
    if (!eq?.id) continue;
    const atual = produtosPorId.get(eq.id);
    const candidato = {
      id: String(eq.id),
      nome: String(eq.nome || "").trim(),
      fabricante: String(eq.fabricante || "").trim(),
      modelo: String(eq.modelo || "").trim(),
      categoria: String(eq.categoria || "").trim(),
      serial: String(eq.serial || "").trim(),
      local_id: eq.popId ? String(eq.popId) : null,
      observacao: String(eq.observacao || "").trim(),
      portas_json: JSON.stringify(Array.isArray(eq.portas) ? eq.portas : []),
      imagem: String(eq.imagem || "").trim(),
      imagem_alt: String(eq.imagemAlt || "").trim(),
      hotspots_json: eq.hotspots ? JSON.stringify(eq.hotspots) : "",
      layout_portas: String(eq.layoutPortas || "").trim()
    };
    if (atual && atual.scope !== scope) {
      conflitosProduto.push({ id: eq.id, ganhou: atual.scope, perdeu: scope });
      continue; // "noc" já está guardado (ou o primeiro visto); a cópia emprestada é descartada.
    }
    if (!atual) produtosPorId.set(eq.id, { row: candidato, scope });
  }
}
console.log(`\nlocais: ${locaisPorId.size} únicos (${linksPorScope.length} vínculos de recorte)`);
if (conflitosLocal.length) {
  console.log(`  conflitos (id em noc e isp com dados diferentes, noc venceu): ${conflitosLocal.length}`);
  conflitosLocal.forEach(c => console.log(`    - ${c.id}`));
}
console.log(`produtos: ${produtosPorId.size} únicos`);
if (conflitosProduto.length) {
  console.log(`  ids emprestados do backbone descartados da cópia isp (mantido o do noc): ${conflitosProduto.length}`);
  conflitosProduto.forEach(c => console.log(`    - ${c.id}`));
}

if (!apply) {
  console.log("\nEnsaio: nada foi gravado. Para aplicar, repita com --apply");
  process.exit(0);
}

console.log("\nGravando...");

const statements = [];
for (const { row, scope } of locaisPorId.values()) {
  statements.push({
    sql: `INSERT OR IGNORE INTO locais(id,nome,tipo,endereco,lat,lon,observacao,origem) VALUES (?,?,?,?,?,?,?,?)`,
    args: [row.id, row.nome, row.tipo, row.endereco, row.lat, row.lon, row.observacao, `migracao:${scope}`]
  });
}
for (const link of linksPorScope) {
  statements.push({
    sql: `INSERT OR IGNORE INTO topology_local_links(scope,local_id,ordem,rotas_json,legado_equipamentos_json) VALUES (?,?,?,?,?)`,
    args: [link.scope, link.local_id, link.ordem, link.rotas_json, link.legado_equipamentos_json]
  });
}
for (const { row, scope } of produtosPorId.values()) {
  statements.push({
    sql: `INSERT OR IGNORE INTO produtos(id,nome,fabricante,modelo,categoria,serial,local_id,escopo,observacao,
      portas_json,imagem,imagem_alt,hotspots_json,layout_portas)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    args: [row.id, row.nome, row.fabricante, row.modelo, row.categoria, row.serial, row.local_id, scope,
      row.observacao, row.portas_json, row.imagem, row.imagem_alt, row.hotspots_json, row.layout_portas]
  });
}

await db.batch(statements, "write");
console.log(`\nGravado: ${locaisPorId.size} locais, ${linksPorScope.length} vínculos de recorte, ${produtosPorId.size} produtos.`);
console.log("Confira as tabelas antes de ativar a leitura da topologia a partir delas.");
