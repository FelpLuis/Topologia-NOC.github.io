import { readFileSync } from "node:fs";
import { createClient } from "@libsql/client";

function loadEnv(path) {
  const env = {};
  try {
    const text = readFileSync(path, "utf8");
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq < 0) continue;
      const key = trimmed.slice(0, eq).trim();
      let val = trimmed.slice(eq + 1).trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
      env[key] = val;
    }
  } catch {}
  return env;
}

const env = { ...loadEnv(".env.production"), ...loadEnv(".dev.vars"), ...loadEnv(".collector.env") };
const url = env.TURSO_DATABASE_URL || env.LIBSQL_URL;
const token = env.TURSO_AUTH_TOKEN || env.LIBSQL_AUTH_TOKEN;
const db = createClient({ url, authToken: token });

const total = await db.execute(`SELECT COUNT(*) AS c FROM cliente_cadastro`);
const comCpf = await db.execute(`SELECT COUNT(*) AS c FROM cliente_cadastro WHERE cpf_cnpj <> ''`);
const comSenha = await db.execute(`SELECT COUNT(*) AS c FROM cliente_cadastro WHERE senha_pppoe_cipher <> ''`);
const pbkdf2 = await db.execute(`SELECT COUNT(*) AS c FROM cliente_cadastro WHERE senha_pppoe_cipher LIKE 'pbkdf2$%'`);
const v1 = await db.execute(`SELECT COUNT(*) AS c FROM cliente_cadastro WHERE senha_pppoe_cipher LIKE 'v1.%'`);
const outros = await db.execute(`SELECT COUNT(*) AS c FROM cliente_cadastro WHERE senha_pppoe_cipher <> '' AND senha_pppoe_cipher NOT LIKE 'pbkdf2$%' AND senha_pppoe_cipher NOT LIKE 'v1.%'`);

console.log("Total de clientes:", total.rows[0].c);
console.log("Com CPF/CNPJ preenchido:", comCpf.rows[0].c);
console.log("Com senha_pppoe_cipher NÃO vazia:", comSenha.rows[0].c);
console.log("  -> formato pbkdf2$ (verificável):", pbkdf2.rows[0].c);
console.log("  -> formato v1. (cifrado, NÃO verificável):", v1.rows[0].c);
console.log("  -> outro formato:", outros.rows[0].c);

await db.close();
