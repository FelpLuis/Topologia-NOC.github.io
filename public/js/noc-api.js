/* ============================================================
   UPDOWN NOC — acesso à API e regras de domínio compartilhadas
   Toda tela nova (topologia, POPs, dashboard) lê e grava por aqui.
   Nada é gravado em localStorage: a fonte é o Worker + D1.
   ============================================================ */
window.NOC = (() => {
  "use strict";

  /* ---------------- transporte ---------------- */
  async function api(url, opts = {}) {
    const res = await fetch(url, {
      credentials: "same-origin",
      cache: "no-store",
      headers: opts.body ? { "Content-Type": "application/json" } : undefined,
      ...opts,
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401) {
      location.href = "/login.html";
      throw new Error("Sessão expirada.");
    }
    if (!res.ok) {
      const e = new Error(mensagemDeErro(data, res.status));
      e.status = res.status;
      e.data = data;
      throw e;
    }
    return data;
  }

  function mensagemDeErro(data, status) {
    if (data?.error === "FORBIDDEN") return `Seu perfil não tem a permissão necessária (${data.permission || "acesso"}).`;
    if (data?.error === "TOPOLOGIA_INVALIDA") return "A topologia enviada está incompleta.";
    if (data?.error) return String(data.error);
    return `Falha na requisição (HTTP ${status}).`;
  }

  /* ---------------- estado da topologia ---------------- */
  const state = { topology: null, permissions: new Set(), version: null };

  async function load() {
    const [topology, perms] = await Promise.all([
      api("/api/topology"),
      api("/api/topology/permissions").catch(() => ({ permissions: [] })),
    ]);
    topology.equipamentos = Array.isArray(topology.equipamentos) ? topology.equipamentos : [];
    topology.conexoes = Array.isArray(topology.conexoes) ? topology.conexoes : [];
    topology.pops = Array.isArray(topology.pops) ? topology.pops : [];
    topology.equipamentos.forEach((e) => {
      if (!Array.isArray(e.portas)) e.portas = [];
      if (e.popId === undefined) e.popId = null;
    });
    state.topology = topology;
    state.version = topology.version;
    state.permissions = new Set(perms.permissions || []);
    return topology;
  }

  const can = (code) => state.permissions.has(code);
  const data = () => state.topology;

  /* Grava a topologia inteira: é assim que a API foi desenhada, e é o que
     garante o registro de auditoria com estado anterior e posterior. */
  async function save(reason = "TOPOLOGY_UPDATE") {
    const t = state.topology;
    const payload = { equipamentos: t.equipamentos, conexoes: t.conexoes, pops: t.pops, config: t.config };
    const r = await api("/api/topology", { method: "PUT", body: JSON.stringify({ topology: payload, reason }) });
    if (r.topology) {
      state.topology = { ...r.topology, version: r.version };
      state.version = r.version;
    }
    return state.topology;
  }

  /* ---------------- POPs e vínculo ---------------- */
  const semAcento = (s) => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

  const pops = () => (state.topology?.pops || []).map((p) => ({
    id: p.id,
    nome: p.nome || p.id,
    rotas: Array.isArray(p.rotas) ? p.rotas : [],
    equipamentos: Array.isArray(p.equipamentos) ? p.equipamentos : [],
  }));

  const popById = (id) => pops().find((p) => p.id === id) || null;

  /* Sugestão de POP a partir do cadastro antigo (campo local/nome).
     É só sugestão: o vínculo válido é o campo popId. */
  function suggestPop(equipamento) {
    const texto = semAcento([equipamento.local, equipamento.nome, equipamento.id].join(" "));
    let melhor = null;
    pops().forEach((p) => {
      const alvo = semAcento(p.nome).replace(/^pop\s*/, "").trim();
      if (alvo && texto.includes(alvo)) melhor = p.id;
    });
    return melhor;
  }

  // POP usado para exibição: o vínculo explícito manda; sem ele, a sugestão.
  const effectivePop = (e) => e.popId || suggestPop(e) || null;
  const isSuggested = (e) => !e.popId && !!suggestPop(e);
  const devicesOfPop = (popId) => (state.topology?.equipamentos || []).filter((e) => effectivePop(e) === popId);
  const unlinked = () => (state.topology?.equipamentos || []).filter((e) => !effectivePop(e));

  async function setPop(deviceId, popId) {
    const e = (state.topology.equipamentos || []).find((x) => x.id === deviceId);
    if (!e) return null;
    const antes = e.popId ?? null;
    e.popId = popId || null;
    try {
      await save(popId ? "TOPOLOGY_LINK_POP" : "TOPOLOGY_UNLINK_POP");
    } catch (err) {
      e.popId = antes; // rollback local: a tela nunca mostra o que não foi gravado
      throw err;
    }
    return antes;
  }

  /* ---------------- portas e enlaces ---------------- */
  const connectionsOf = (id) =>
    (state.topology?.conexoes || []).filter((c) => c.origem === id || c.destino === id);

  const portConnection = (id, porta) =>
    (state.topology?.conexoes || []).find((c) =>
      (c.origem === id && Number(c.portaOrigem) === Number(porta)) ||
      (c.destino === id && Number(c.portaDestino) === Number(porta)));

  // Porta em uso = porta com enlace documentado. Mesma regra do sistema atual.
  const portaEmUso = (deviceId, porta) => !!portConnection(deviceId, porta);
  const usedPorts = (e) => (e.portas || []).filter((p) => portaEmUso(e.id, p.numero)).length;
  const occupancy = (e) => (e.portas?.length ? Math.round((usedPorts(e) / e.portas.length) * 100) : 0);
  const occClass = (v) => (v > 85 ? "is-danger" : v > 60 ? "is-warn" : "");

  function statsOf(list) {
    const portas = list.reduce((a, e) => a + (e.portas?.length || 0), 0);
    const emUso = list.reduce((a, e) => a + usedPorts(e), 0);
    return { portas, emUso, livres: portas - emUso, ocup: portas ? Math.round((emUso / portas) * 100) : 0 };
  }

  /* Status vem do monitoramento quando a integração com o Grafana estiver
     ligada. Sem dado, o protótipo do sistema NÃO inventa: mostra "aguardando". */
  function statusInfo(e) {
    const s = e?.monitoramento?.status;
    if (s === "online") return { dot: "dot-ok", label: "Online", badge: "badge-ok" };
    if (s === "offline") return { dot: "dot-danger", label: "Offline", badge: "badge-danger" };
    if (s === "degradado") return { dot: "dot-warn", label: "Degradado", badge: "badge-warn" };
    return { dot: "", label: "Aguardando Grafana", badge: "" };
  }

  async function grafanaHealth() {
    try {
      const r = await fetch("/api/grafana/health", { cache: "no-store" });
      return r.ok ? await r.json() : null;
    } catch (e) {
      return null;
    }
  }

  /* ---------------- utilidades de tela ---------------- */
  function skeleton(host, linhas = 4) {
    if (!host) return;
    host.innerHTML = `<div class="stack" style="padding:var(--s-5)">
      ${Array.from({ length: linhas }, (_, i) => `<div class="skeleton skeleton-line" style="width:${90 - i * 12}%"></div>`).join("")}
    </div>`;
  }

  function errorState(host, err, retry) {
    if (!host) return;
    host.innerHTML = `<div class="empty">
      <span class="empty-icon">${UI.icon("alert")}</span>
      <b>Não foi possível carregar</b>
      <p>${UI.esc(err?.message || "Erro inesperado.")}</p>
      <button class="btn btn-sm" type="button" data-retry style="margin-top:var(--s-3)">Tentar de novo</button>
    </div>`;
    const b = host.querySelector("[data-retry]");
    if (b && retry) b.onclick = retry;
  }

  return {
    api, load, save, data, can, pops, popById, suggestPop, effectivePop, isSuggested,
    devicesOfPop, unlinked, setPop, connectionsOf, portConnection, portaEmUso,
    usedPorts, occupancy, occClass, statsOf, statusInfo, grafanaHealth, skeleton, errorState,
  };
})();
