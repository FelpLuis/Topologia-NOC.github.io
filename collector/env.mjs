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
  const provisioningUrl = (() => {
    const base = String(process.env.PROVISIONING_PUSH_URL || "").replace(/\/+$/, "");
    if (base) return base;
    const derived = String(process.env.GPON_PUSH_URL || "").replace(/\/api\/gpon\/ingest$/, "").replace(/\/+$/, "");
    return derived ? derived : "";
  })();
  return {
    host: String(process.env.COLLECTOR_HOST || "127.0.0.1"),
    port: Number(process.env.COLLECTOR_PORT || 8790),
    token: required("COLLECTOR_TOKEN"),
    pushUrl: required("GPON_PUSH_URL"),
    pushToken: String(process.env.GPON_PUSH_TOKEN || required("COLLECTOR_TOKEN")),
    intervalMs: Math.max(10000, Number(process.env.COLLECTOR_INTERVAL_MS || 10000)),
    ixcIntervalMs: Math.max(60000, Number(process.env.IXC_REFRESH_INTERVAL_MS || 600000)),
    /* A leitura rápida na OLT é o único ciclo que fala com o equipamento de
       produção a cada 10 s. Um parque muito grande, ou uma OLT que não aguenta
       o "show gpon onu state" nesse ritmo, desliga aqui e continua com o
       Radius do IXC em 10 s e a OLT no ciclo completo. */
    ontFast: !/^(0|false|nao|não|off)$/i.test(String(process.env.ONT_FAST_ENABLED ?? "1").trim()),
    devices: [device("ZTE_C350"), device("ZTE_C300")],
    ixc: {
      baseUrl: required("IXC_BASE_URL").replace(/\/+$/, ""),
      token: required("IXC_API_TOKEN"),
    },
    provisioning: {
      url: provisioningUrl,
      pushToken: String(process.env.PROVISIONING_PUSH_TOKEN || process.env.GPON_PUSH_TOKEN || process.env.COLLECTOR_TOKEN || ""),
      intervalMs: Math.max(15000, Number(process.env.PROVISIONING_INTERVAL_MS || 30000)),
    },
  };
}
