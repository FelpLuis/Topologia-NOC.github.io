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

  /* ---------------- acesso do usuário ---------------- */
  /* Ações e telas do perfil vêm de /api/access. É a mesma lista que a tela
     Plataforma monta em Perfis: o que não está marcado lá não aparece aqui. */
  const state = { topology: null, permissions: new Set(), screens: [], version: null };
  let accessPromise = null;

  function loadAccess() {
    if (!accessPromise) {
      accessPromise = api("/api/access")
        .then((a) => {
          state.permissions = new Set(a.permissions || []);
          state.screens = Array.isArray(a.screens) ? a.screens : [];
          return a;
        })
        .catch((err) => { accessPromise = null; throw err; });
    }
    return accessPromise;
  }

  const can = (code) => state.permissions.has(code);
  const canAll = (codes) => codes.every(can);
  const screens = () => state.screens;
  const hasScreen = (code) => state.screens.some((s) => s.code === code);

  /* Gating declarativo: o HTML anuncia a ação exigida com data-action e a
     regra de acesso é aplicada em um lugar só, em vez de espalhada por tela.
     data-action-hide esconde em vez de desabilitar. */
  function applyActions(root = document) {
    root.querySelectorAll("[data-action]").forEach((el) => {
      const codes = el.dataset.action.split(/\s+/).filter(Boolean);
      const liberado = canAll(codes);
      if (el.hasAttribute("data-action-hide")) {
        el.hidden = !liberado;
        return;
      }
      el.disabled = !liberado;
      el.classList.toggle("is-denied", !liberado);
      if (!liberado) el.title = `Requer a ação ${codes.join(" + ")} no seu perfil.`;
      else if (el.dataset.actionTitle !== undefined) el.title = el.dataset.actionTitle;
    });
  }

  /* ---------------- estado da topologia ---------------- */
  async function load() {
    const [topology] = await Promise.all([
      api("/api/topology"),
      loadAccess().catch(() => ({ permissions: [] })),
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
    return topology;
  }

  const data = () => state.topology;

  /* Grava a topologia inteira: é assim que a API foi desenhada, e é o que
     garante o registro de auditoria com estado anterior e posterior. */
  async function save(reason = "TOPOLOGY_UPDATE") {
    const t = state.topology;
    const payload = { equipamentos: t.equipamentos, conexoes: t.conexoes, pops: t.pops, config: t.config };
    const r = await api("/api/topology", { method: "PUT", body: JSON.stringify({ topology: payload, reason }) });
    /* O Worker devolve exatamente o que foi enviado (só completa o config com os
       padrões). Mantemos os objetos locais para que as telas não fiquem com
       referências órfãs entre uma gravação e outra — só o config e a versão
       vêm da resposta. */
    if (r.topology?.config) t.config = r.topology.config;
    t.version = r.version;
    t.updated_at = r.updated_at;
    state.version = r.version;
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

  /* ---------------- Zabbix ---------------- */
  /* Espelho do inventário de interfaces. A fonte é o Zabbix; o D1 guarda o
     resultado da última sincronização, então a leitura aqui é sempre barata. */
  const zabbix = {
    health: () => api("/api/zabbix/health"),
    status: () => api("/api/zabbix/status"),
    hosts: () => api("/api/zabbix/hosts"),
    sync: () => api("/api/zabbix/sync", { method: "POST" }),

    /* Enlaces físicos derivados das descrições de interface. */
    links: () => api("/api/zabbix/links"),

    /* Projeta o inventário na topologia. Sem { aplicar: true } é só ensaio. */
    aplicarTopologia: (aplicar = false) =>
      api("/api/zabbix/topology/apply", {
        method: "POST",
        body: JSON.stringify({ aplicar }),
      }),

    /* filtros: { equipamento, hostid, status: "up"|"down", conectadas: 1, q, limit } */
    interfaces(filtros = {}) {
      const qs = new URLSearchParams(
        Object.entries(filtros).filter(([, v]) => v !== undefined && v !== null && v !== "")
      );
      return api(`/api/zabbix/interfaces${qs.toString() ? `?${qs}` : ""}`);
    },

    /* equipamentoId null desfaz o vínculo e devolve o host ao match automático. */
    vincular: (hostid, equipamentoId) =>
      api(`/api/zabbix/hosts/${hostid}`, {
        method: "PATCH",
        body: JSON.stringify({ equipamento_id: equipamentoId }),
      }),
  };

  /* 1 = up e 2 = down são os valores de ifOperStatus (SNMP). */
  const interfaceStatus = (i) =>
    i?.oper_status === 1 ? { dot: "dot-ok", label: "Up", badge: "badge-ok" }
      : i?.oper_status === 2 ? { dot: "dot-danger", label: "Down", badge: "badge-danger" }
        : { dot: "", label: "Sem dado", badge: "" };

  /* speed_bps e in_bps/out_bps vêm em bits/s. */
  function formatBps(bps) {
    const n = Number(bps);
    if (!Number.isFinite(n) || n <= 0) return "—";
    const unidades = ["bps", "Kbps", "Mbps", "Gbps", "Tbps"];
    const i = Math.min(Math.floor(Math.log10(n) / 3), unidades.length - 1);
    const valor = n / 1000 ** i;
    return `${valor >= 100 ? Math.round(valor) : valor.toFixed(valor >= 10 ? 1 : 2)} ${unidades[i]}`;
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
    api, load, save, data, can, canAll, loadAccess, applyActions, screens, hasScreen,
    pops, popById, suggestPop, effectivePop, isSuggested,
    devicesOfPop, unlinked, setPop, connectionsOf, portConnection, portaEmUso,
    usedPorts, occupancy, occClass, statsOf, statusInfo, grafanaHealth, skeleton, errorState,
    zabbix, interfaceStatus, formatBps,
  };
})();
