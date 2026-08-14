/**
 * UPDOWN Topologia NOC
 * Cloudflare Worker + Static Assets
 *
 * Variáveis:
 *   GRAFANA_URL   = https://dashboard.lv.network
 *
 * Secret:
 *   GRAFANA_TOKEN = token da API do Grafana
 *
 * O navegador nunca recebe o token. As chamadas para /api/grafana/*
 * são feitas pelo Worker.
 */

function json(data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "content-type": "application/json; charset=UTF-8",
      "cache-control": "no-store",
      ...extra
    }
  });
}

function grafanaHeaders(env) {
  const headers = {
    "Accept": "application/json",
    "Content-Type": "application/json"
  };

  if (env.GRAFANA_TOKEN) {
    headers.Authorization = `Bearer ${env.GRAFANA_TOKEN}`;
  }

  return headers;
}

function grafanaBase(env) {
  return String(env.GRAFANA_URL || "").replace(/\/+$/, "");
}

async function grafanaRequest(env, path, init = {}) {
  const base = grafanaBase(env);
  if (!base) throw new Error("GRAFANA_URL não configurada.");
  const url = `${base}${path}`;

  const response = await fetch(url, {
    ...init,
    headers: {
      ...grafanaHeaders(env),
      ...(init.headers || {})
    }
  });

  const text = await response.text();
  let body;
  try { body = text ? JSON.parse(text) : null; }
  catch { body = { raw: text }; }

  return { response, body };
}

async function handleGrafana(request, env, url) {
  // GET /api/grafana/health
  if (request.method === "GET" && url.pathname === "/api/grafana/health") {
    try {
      const result = await grafanaRequest(env, "/api/health");
      return json({
        ok: result.response.ok,
        grafanaStatus: result.response.status,
        data: result.body
      }, result.response.ok ? 200 : 502);
    } catch (error) {
      return json({
        ok: false,
        error: error.message,
        hint: "Configure GRAFANA_URL e GRAFANA_TOKEN nos Secrets/Variables do Worker."
      }, 500);
    }
  }

  // POST /api/grafana/query
  // Proxy genérico para a API moderna de consulta do Grafana.
  // O frontend envia somente a consulta; a credencial fica no Worker.
  if (request.method === "POST" && url.pathname === "/api/grafana/query") {
    try {
      const payload = await request.json();
      const result = await grafanaRequest(env, "/api/ds/query", {
        method: "POST",
        body: JSON.stringify(payload)
      });

      return json(result.body, result.response.status);
    } catch (error) {
      return json({ ok: false, error: error.message }, 400);
    }
  }

  // GET /api/grafana/dashboard/:uid
  if (request.method === "GET" && url.pathname.startsWith("/api/grafana/dashboard/")) {
    const uid = url.pathname.split("/").filter(Boolean).pop();
    if (!uid) return json({ error: "UID do dashboard não informado." }, 400);

    try {
      const result = await grafanaRequest(
        env,
        `/api/dashboards/uid/${encodeURIComponent(uid)}`
      );
      return json(result.body, result.response.status);
    } catch (error) {
      return json({ ok: false, error: error.message }, 500);
    }
  }

  return json({ error: "Endpoint Grafana não encontrado." }, 404);
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname.startsWith("/api/grafana/")) {
      return handleGrafana(request, env, url);
    }

    // Todos os demais caminhos são entregues pelos arquivos estáticos.
    return env.ASSETS.fetch(request);
  }
};
