import { readFile } from "node:fs/promises";
import path from "node:path";

export async function loadCollectorEnv(file = path.resolve(".collector.env")) {
  let text = "";
  try { text = await readFile(file, "utf8"); } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const at = line.indexOf("=");
    if (at < 1) continue;
    const key = line.slice(0, at).trim();
    let value = line.slice(at + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

export function collectorConfig() {
  const required = (key) => {
    const value = String(process.env[key] || "").trim();
    if (!value) throw new Error(`Configuração ausente: ${key}`);
    return value;
  };
  const device = (prefix) => ({
    id: required(`${prefix}_ID`), name: required(`${prefix}_NAME`),
    host: required(`${prefix}_HOST`), port: Number(required(`${prefix}_PORT`)),
    protocol: required(`${prefix}_PROTOCOL`).toLowerCase(),
    username: required(`${prefix}_USERNAME`), password: required(`${prefix}_PASSWORD`),
  });
  return {
    host: String(process.env.COLLECTOR_HOST || "127.0.0.1"),
    port: Number(process.env.COLLECTOR_PORT || 8790),
    token: required("COLLECTOR_TOKEN"),
    intervalMs: Math.max(60000, Number(process.env.COLLECTOR_INTERVAL_MS || 300000)),
    devices: [device("ZTE_C350"), device("ZTE_C300")],
    ixc: {
      baseUrl: required("IXC_BASE_URL").replace(/\/+$/, ""),
      token: required("IXC_API_TOKEN"),
    },
  };
}
