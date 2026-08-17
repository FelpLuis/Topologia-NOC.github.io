#!/usr/bin/env node
//
// Projeta o inventário do Zabbix na topologia, direto no D1.
//
// É a mesma lógica do endpoint POST /api/zabbix/topology/apply — importa os
// mesmos módulos — mas roda pela linha de comando, útil para a primeira carga
// e para quem tem acesso ao banco sem ter sessão na aplicação. O registro de
// auditoria é gravado explicitamente, igual ao que o endpoint grava.
//
// Uso:
//   node backend/scripts/zabbix-apply-topology.mjs            # ensaio (não grava)
//   node backend/scripts/zabbix-apply-topology.mjs --apply
//   node backend/scripts/zabbix-apply-topology.mjs --apply --local

import { execFileSync } from "node:child_process";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { deriveLinks } from "../../src/zabbix-links.js";
import { applyZabbixToTopology } from "../../src/zabbix-topology.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const isWindows = process.platform === "win32";
const apply = process.argv.includes("--apply");
const target = process.argv.includes("--local") ? "--local" : "--remote";

function wrangler(args) {
  const cmd = ["wrangler", ...args];
  return isWindows
    ? execFileSync(`npx.cmd ${cmd.join(" ")}`, { cwd: ROOT, shell: true, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 })
    : execFileSync("npx", cmd, { cwd: ROOT, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
}

/* O wrangler imprime um cabeçalho antes do JSON; pega do primeiro "[" em diante.
   O SQL vai em uma única linha: quebras de linha rompem o argumento no shell. */
function query(sql) {
  const umaLinha = sql.replace(/\s+/g, " ").trim();
  const out = wrangler(["d1", "execute", "bd", target, "--yes", "--json", "--command", `"${umaLinha.replace(/"/g, '\\"')}"`]);
  const start = out.indexOf("[");
  if (start < 0) throw new Error(`Resposta inesperada do wrangler:\n${out.slice(0, 400)}`);
  return JSON.parse(out.slice(start))[0].results || [];
}

const sqlValue = (v) =>
  v === null || v === undefined ? "NULL"
    : typeof v === "number" ? String(v)
      : `'${String(v).replace(/'/g, "''")}'`;

console.log(`Lendo o banco (${target})...`);

const estado = query("SELECT data_json, version FROM topology_state WHERE id=1");
if (!estado.length) {
  console.error("topology_state está vazia. Abra a topologia na aplicação uma vez para inicializá-la.");
  process.exit(1);
}

const versaoAtual = Number(estado[0].version || 0);
const antes = JSON.parse(estado[0].data_json);

const hosts = query(`
  SELECT hostid, host, name, status, available, snmp_ip, equipamento_id, match_source
  FROM zabbix_hosts
`);
const interfaces = query(`
  SELECT hostid, if_index, if_name, if_alias, if_type, oper_status,
         speed_bps, in_bps, out_bps, in_errors, out_errors, last_clock
  FROM zabbix_interfaces
`);

if (!interfaces.length) {
  console.error("Nenhuma interface no banco. Rode antes: node backend/scripts/zabbix-sync.mjs --apply");
  process.exit(1);
}

const inventory = { hosts, interfaces };
const links = deriveLinks(inventory);
const { topology: depois, relatorio } = applyZabbixToTopology(antes, inventory, links);

console.log(`\nhosts=${hosts.length} interfaces=${interfaces.length} enlaces derivados=${links.length}`);

console.log("\n=== PORTAS ===");
for (const p of relatorio.portas)
  console.log(`  ${p.equipamento.padEnd(10)} ${String(p.reais).padStart(3)} interfaces reais + livres = ${p.total} (antes ${p.antes})`);

for (const [titulo, lista] of [
  ["CONEXOES DERIVADAS", relatorio.conexoes.derivadas],
  ["ENLACES A EQUIPAMENTO NAO MONITORADO", relatorio.conexoes.externas],
  ["PRESERVADAS", relatorio.conexoes.preservadas],
  ["SUBSTITUIDAS", relatorio.conexoes.descartadas],
  ["CONFLITOS DE PORTA (recusados)", relatorio.conexoes.conflitos]
]) {
  console.log(`\n=== ${titulo} (${lista.length}) ===`);
  lista.forEach(x => console.log("  " + x));
}

console.log(`\nconexoes: ${(antes.conexoes || []).length} -> ${depois.conexoes.length}`);

if (!apply) {
  console.log("\nEnsaio: nada foi gravado. Para aplicar, repita com --apply");
  process.exit(0);
}

const novaVersao = versaoAtual + 1;
const detalhes = {
  origem: "cli:zabbix-apply-topology",
  version_before: versaoAtual,
  version_after: novaVersao,
  resumo: {
    equipamentos_reconstruidos: relatorio.portas.length,
    conexoes_antes: (antes.conexoes || []).length,
    conexoes_depois: depois.conexoes.length,
    derivadas: relatorio.conexoes.derivadas.length,
    externas: relatorio.conexoes.externas.length,
    preservadas: relatorio.conexoes.preservadas.length,
    substituidas: relatorio.conexoes.descartadas.length
  },
  relatorio
};

/* O audit_logs varia entre instalações: bancos vindos das migrações originais
   têm `resource`/`details` (NOT NULL), os criados pelo schema atual têm
   `resource_type`/`details_json`. Monta o INSERT com as colunas que existirem,
   como o audit() do Worker faz.

   Grava before_json e NÃO after_json: a topologia passa de 50 KB, e os dois
   juntos estouram o limite de tamanho de statement do D1 (SQLITE_TOOBIG). O
   estado posterior já está em topology_state; o anterior é o que serve para
   reverter, então é ele que precisa ficar registrado. */
const colunas = new Set(query("SELECT name FROM pragma_table_info('audit_logs')").map(r => r.name));

const auditoria = [
  ["action", "ZABBIX_TOPOLOGY_APPLY"],
  ["resource", "topology"],
  ["resource_type", "topology"],
  ["resource_id", "1"],
  ["method", "CLI"],
  ["path", "backend/scripts/zabbix-apply-topology.mjs"],
  ["ip", "cli"],
  ["user_agent", "wrangler-cli"],
  ["before_json", JSON.stringify(antes)],
  ["details", JSON.stringify(detalhes.resumo)],
  ["details_json", JSON.stringify(detalhes)]
].filter(([nome]) => colunas.has(nome));

const sql = [
  "UPDATE topology_state SET",
  `  data_json=${sqlValue(JSON.stringify(depois))},`,
  `  version=${novaVersao},`,
  "  updated_at=CURRENT_TIMESTAMP",
  "WHERE id=1;",
  "",
  `INSERT INTO audit_logs (${auditoria.map(([nome]) => nome).join(", ")})`,
  `VALUES (${auditoria.map(([, valor]) => sqlValue(valor)).join(", ")});`
].join("\n");

mkdirSync(resolve(ROOT, "backend/data"), { recursive: true });
const caminho = resolve(ROOT, "backend/data/zabbix-topology-apply.sql");
writeFileSync(caminho, sql + "\n", "utf8");

console.log(`\nAplicando (${target})...`);
console.log(wrangler(["d1", "execute", "bd", target, "--yes", "--file", "backend/data/zabbix-topology-apply.sql"]).slice(-600));
console.log(`\nTopologia na versão ${novaVersao}. Estado anterior guardado em audit_logs.before_json.`);
