import http from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { createHash, timingSafeEqual } from "node:crypto";
import { loadCollectorEnv, collectorConfig } from "./env.mjs";
import { collectZte } from "./zte-cli.mjs";

await loadCollectorEnv();
const config = collectorConfig();
const state = { clients: [], boxes: [], alerts: [], syncedAt: null, syncing: null, errors: [] };

const safeEqual = (a, b) => {
  const digest = (value) => createHash("sha256").update(String(value)).digest();
  return timingSafeEqual(digest(a), digest(b));
};
const authorized = (request) => safeEqual(request.headers.authorization || "", `Bearer ${config.token}`);

async function loadMap() {
  try {
    const raw = await readFile(path.resolve("collector/client-map.json"), "utf8");
    return JSON.parse(raw);
  } catch (error) {
    if (error?.code === "ENOENT") return {};
    throw error;
  }
}

async function sync() {
  if (state.syncing) return state.syncing;
  state.syncing = (async () => {
    const mapping = await loadMap(), collected = [], errors = [];
    const results = await Promise.allSettled(config.devices.map((device) => collectZte(device)));
    results.forEach((result, index) => {
      if (result.status === "fulfilled") collected.push(...result.value);
      else errors.push({ olt_id: config.devices[index].id, message: result.reason?.message || String(result.reason) });
    });
    state.clients = collected.map((client) => ({ ...client, ...(mapping[`${client.olt_id}|${client.onu_index}`] || {}) }));
    state.boxes = Array.isArray(mapping.boxes) ? mapping.boxes : [];
    state.errors = errors;
    state.alerts = [
      ...state.clients.filter((c) => c.status !== "online").map((c) => ({ level: "warning", client_id: c.id, title: `${c.name} — ${c.state_detail}`, detail: `${c.olt_id} • ${c.onu_index}` })),
      ...errors.map((e) => ({ level: "critical", title: `Falha ao consultar ${e.olt_id}`, detail: e.message })),
    ];
    state.syncedAt = new Date().toISOString();
    return state;
  })().finally(() => { state.syncing = null; });
  return state.syncing;
}

if (process.argv.includes("--once")) {
  await sync();
  console.log(JSON.stringify({ synced_at: state.syncedAt, clients: state.clients.length, errors: state.errors }, null, 2));
  process.exit(state.errors.length ? 1 : 0);
}

const server = http.createServer(async (request, response) => {
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("Cache-Control", "no-store");
  if (request.url === "/health") return response.end(JSON.stringify({ ok: true, syncing: Boolean(state.syncing), synced_at: state.syncedAt, errors: state.errors }));
  if (request.url !== "/api/gpon/clientes") { response.statusCode = 404; return response.end(JSON.stringify({ error: "NOT_FOUND" })); }
  if (!authorized(request)) { response.statusCode = 401; return response.end(JSON.stringify({ error: "UNAUTHORIZED" })); }
  try {
    if (!state.syncedAt) await sync();
    response.end(JSON.stringify({ source: "Coletor ZTE C300/C350", synced_at: state.syncedAt, clients: state.clients, boxes: state.boxes, alerts: state.alerts }));
  } catch (error) {
    response.statusCode = 503; response.end(JSON.stringify({ error: "COLLECTOR_UNAVAILABLE" }));
  }
});

server.listen(config.port, config.host, () => {
  console.log(JSON.stringify({ message: "Coletor GPON iniciado", address: `${config.host}:${config.port}`, interval_ms: config.intervalMs }));
  void sync().catch((error) => console.error(JSON.stringify({ message: "Falha na sincronização GPON", error: error?.message || String(error) })));
});
const timer = setInterval(() => {
  void sync().catch((error) => console.error(JSON.stringify({ message: "Falha na sincronização GPON", error: error?.message || String(error) })));
}, config.intervalMs);
timer.unref();
