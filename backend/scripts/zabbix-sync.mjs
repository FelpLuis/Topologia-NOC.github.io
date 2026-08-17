#!/usr/bin/env node
//
// Sincroniza o inventário de interfaces do Zabbix com o banco D1.
//
// Reusa exatamente o mesmo módulo que o Worker usa (src/zabbix.js), então o
// resultado é idêntico ao endpoint POST /api/zabbix/sync.
//
// Uso:
//   node backend/scripts/zabbix-sync.mjs            # gera o SQL
//   node backend/scripts/zabbix-sync.mjs --apply    # gera e aplica no D1 remoto
//   node backend/scripts/zabbix-sync.mjs --apply --local
//
// Credenciais: lidas de .dev.vars (ou das variáveis de ambiente).

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { fetchNetworkInventory } from "../../src/zabbix.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

/** Lê .dev.vars no formato CHAVE=valor, sem sobrescrever o ambiente. */
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

/** Escapa um valor para literal SQL do SQLite. */
function sqlValue(value) {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "number") return String(value);
  return `'${String(value).replace(/'/g, "''")}'`;
}

function buildSql({ hosts, interfaces }) {
  const lines = [
    "-- Gerado por backend/scripts/zabbix-sync.mjs",
    `-- Sincronizado em ${new Date().toISOString()}`,
    `-- ${hosts.length} hosts, ${interfaces.length} interfaces`,
    ""
  ];

  const hostColumns = [
    "hostid", "host", "name", "status", "available",
    "snmp_ip", "snmp_port", "agent_ip", "equipamento_id", "match_source"
  ];

  for (const host of hosts) {
    lines.push(
      `INSERT INTO zabbix_hosts (${hostColumns.join(",")}, synced_at) VALUES (` +
      `${hostColumns.map(c => sqlValue(host[c] ?? null)).join(",")}, CURRENT_TIMESTAMP) ` +
      `ON CONFLICT(hostid) DO UPDATE SET ` +
      `host=excluded.host, name=excluded.name, status=excluded.status, ` +
      `available=excluded.available, snmp_ip=excluded.snmp_ip, ` +
      `snmp_port=excluded.snmp_port, agent_ip=excluded.agent_ip, ` +
      `equipamento_id=CASE WHEN zabbix_hosts.match_source='manual' ` +
      `THEN zabbix_hosts.equipamento_id ELSE excluded.equipamento_id END, ` +
      `match_source=CASE WHEN zabbix_hosts.match_source='manual' ` +
      `THEN 'manual' ELSE excluded.match_source END, ` +
      `synced_at=CURRENT_TIMESTAMP;`
    );
  }

  const ifColumns = [
    "hostid", "if_index", "if_name", "if_alias", "if_type", "oper_status",
    "speed_bps", "in_bps", "out_bps", "in_errors", "out_errors",
    "in_discards", "out_discards", "last_clock"
  ];

  for (const iface of interfaces) {
    lines.push(
      `INSERT INTO zabbix_interfaces (${ifColumns.join(",")}, synced_at) VALUES (` +
      `${ifColumns.map(c => sqlValue(iface[c] ?? null)).join(",")}, CURRENT_TIMESTAMP) ` +
      `ON CONFLICT(hostid, if_index) DO UPDATE SET ` +
      `if_name=excluded.if_name, if_alias=excluded.if_alias, if_type=excluded.if_type, ` +
      `oper_status=excluded.oper_status, speed_bps=excluded.speed_bps, ` +
      `in_bps=excluded.in_bps, out_bps=excluded.out_bps, ` +
      `in_errors=excluded.in_errors, out_errors=excluded.out_errors, ` +
      `in_discards=excluded.in_discards, out_discards=excluded.out_discards, ` +
      `last_clock=excluded.last_clock, synced_at=CURRENT_TIMESTAMP;`
    );
  }

  lines.push(
    `INSERT INTO zabbix_sync_runs (finished_at, ok, hosts_count, interfaces_count, source) ` +
    `VALUES (CURRENT_TIMESTAMP, 1, ${hosts.length}, ${interfaces.length}, 'cli');`
  );

  return lines.join("\n") + "\n";
}

const env = loadEnv();
const apply = process.argv.includes("--apply");
const local = process.argv.includes("--local");

console.log("Consultando o Zabbix...");
const inventory = await fetchNetworkInventory(env);

const vinculados = inventory.hosts.filter(h => h.equipamento_id);
const documentadas = inventory.interfaces.filter(i => i.if_alias);
const ativas = inventory.interfaces.filter(i => i.oper_status === 1);

console.log(`  hosts SNMP.................. ${inventory.hosts.length}`);
console.log(`  vinculados à topologia...... ${vinculados.length}`);
console.log(`  interfaces.................. ${inventory.interfaces.length}`);
console.log(`  interfaces ativas (up)...... ${ativas.length}`);
console.log(`  com enlace documentado...... ${documentadas.length}`);

mkdirSync(resolve(ROOT, "backend/data"), { recursive: true });

const sqlPath = resolve(ROOT, "backend/data/zabbix-sync.sql");
writeFileSync(sqlPath, buildSql(inventory), "utf8");
console.log(`\nSQL gerado: ${sqlPath}`);

const jsonPath = resolve(ROOT, "backend/data/zabbix-inventory.json");
writeFileSync(jsonPath, JSON.stringify(inventory, null, 2), "utf8");
console.log(`Inventário JSON: ${jsonPath}`);

if (!apply) {
  console.log("\nPara aplicar no banco:");
  console.log("  node backend/scripts/zabbix-sync.mjs --apply");
  process.exit(0);
}

const target = local ? "--local" : "--remote";
console.log(`\nAplicando no D1 (${target})...`);

// No Windows o executável é npx.cmd e, desde o Node 20, o spawn de um .cmd
// exige shell — sem isso o erro é EINVAL. Com shell, o comando vai como string
// única: passar `args` junto com `shell:true` é depreciado, porque o Node
// concatena sem escapar. Aqui não há entrada externa, os nomes são fixos.
const isWindows = process.platform === "win32";

for (const file of ["migrations/0004_zabbix.sql", "backend/data/zabbix-sync.sql"]) {
  console.log(`  ${file}`);

  const args = ["wrangler", "d1", "execute", "bd", target, "--file", file, "--yes"];

  if (isWindows) {
    execFileSync(`npx.cmd ${args.join(" ")}`, { cwd: ROOT, stdio: "inherit", shell: true });
  } else {
    execFileSync("npx", args, { cwd: ROOT, stdio: "inherit" });
  }
}

console.log("\nBanco atualizado.");
