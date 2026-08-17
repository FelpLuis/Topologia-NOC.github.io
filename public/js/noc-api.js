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
    const connectionErrors = {
      IP_DE_GERENCIA_INVALIDO: "Informe um endereço IPv4 ou IPv6 válido.",
      PROTOCOLO_INVALIDO: "Escolha SSH ou TELNET.",
      PORTA_INVALIDA: "Informe uma porta entre 1 e 65535.",
      USUARIO_DE_ACESSO_INVALIDO: "Informe o usuário usado para entrar no aparelho.",
      SENHA_DE_ACESSO_OBRIGATORIA: "Informe a senha desse usuário no aparelho.",
      CRIPTOGRAFIA_DE_CREDENCIAIS_NAO_CONFIGURADA: "A proteção de credenciais ainda não foi configurada no servidor.",
      NAO_FOI_POSSIVEL_DECIFRAR_A_CREDENCIAL: "A senha salva não pôde ser aberta. Cadastre-a novamente.",
      CREDENCIAL_SEM_SENHA: "Nenhuma senha foi cadastrada para este aparelho.",
      EQUIPAMENTO_NAO_ENCONTRADO: "O equipamento não existe mais na topologia.",
    };
    if (connectionErrors[data?.error]) return connectionErrors[data.error];
    if (data?.error) return String(data.error);
    return `Falha na requisição (HTTP ${status}).`;
  }

  /* ---------------- acesso do usuário ---------------- */
  /* Ações e telas do perfil vêm de /api/access. É a mesma lista que a tela
     Plataforma monta em Perfis: o que não está marcado lá não aparece aqui. */
  const state = { topology: null, permissions: new Set(), screens: [], version: null };
  let accessPromise = null;

  /* O auth-guard já pede /api/access na abertura da página e deixa a Promise
     em window.UPDOWN_ACCESS_PROMISE. Reaproveitá-la evita uma segunda
     requisição idêntica — que, por acontecer depois do guardião responder,
     entrava inteira no caminho crítico de cada tela. Se ela falhar, o pedido
     próprio ainda é feito: nenhuma tela depende do guardião ter dado certo. */
  function loadAccess() {
    if (!accessPromise) {
      const compartilhada = window.UPDOWN_ACCESS_PROMISE;
      const origem = compartilhada
        ? Promise.resolve(compartilhada).catch(() => api("/api/access"))
        : api("/api/access");
      accessPromise = origem
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

  /* ---------------- memória de uma repintura ---------------- */
  /* Cada repintura consulta o POP e a ocupação de porta de todo equipamento.
     Sem memória, `suggestPop` normalizava o nome de cada POP para cada
     equipamento e `portConnection` varria a lista inteira de enlaces para cada
     porta — custo quadrático, repetido a cada alteração salva.

     O cache vive só enquanto a pilha de execução atual não esvazia. Toda
     mutação da topologia acontece em outra tarefa (clique, resposta da API) e
     encontra o cache já descartado, então a tela nunca lê dado velho e não é
     preciso invalidar nada à mão. */
  let memo = null;
  function passe() {
    if (!memo) {
      memo = {};
      queueMicrotask(() => { memo = null; });
    }
    return memo;
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
  async function enviarTopologia(reason) {
    const t = state.topology;
    const payload = { equipamentos: t.equipamentos, conexoes: t.conexoes, pops: t.pops, config: t.config };
    /* echo:false — só o config e a versão são aproveitados abaixo, e sem isso o
       Worker repetia de volta os mesmos ~50 KB que acabaram de subir. */
    const r = await api("/api/topology", {
      method: "PUT",
      body: JSON.stringify({ topology: payload, reason, echo: false }),
    });
    /* Mantemos os objetos locais para que as telas não fiquem com referências
       órfãs entre uma gravação e outra — só o config e a versão vêm da
       resposta. */
    if (r.topology?.config) t.config = r.topology.config;
    t.version = r.version;
    t.updated_at = r.updated_at;
    state.version = r.version;
    return state.topology;
  }

  /* Uma gravação por vez, e no máximo uma na fila. O corpo é sempre o estado
     atual inteiro, então várias alterações seguidas (arrastar, vincular,
     editar portas) não geram uma requisição de ~50 KB para cada uma: a que
     está na fila sobe já com tudo o que se acumulou. Serializar também evita
     que duas gravações concorrentes disputem a mesma versão no D1. */
  let saveEmCurso = null;
  let saveEnfileirado = null;

  function save(reason = "TOPOLOGY_UPDATE") {
    if (!saveEmCurso) {
      saveEmCurso = enviarTopologia(reason).finally(() => { saveEmCurso = null; });
      return saveEmCurso;
    }
    if (!saveEnfileirado) {
      saveEnfileirado = saveEmCurso
        .catch(() => {})
        .then(() => { saveEnfileirado = null; return save(reason); });
    }
    return saveEnfileirado;
  }

  /* ---------------- POPs e vínculo ---------------- */
  const semAcento = (s) => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

  const pops = () => {
    const c = passe();
    if (!c.pops) {
      c.pops = (state.topology?.pops || []).map((p) => ({
        id: p.id,
        nome: p.nome || p.id,
        rotas: Array.isArray(p.rotas) ? p.rotas : [],
        equipamentos: Array.isArray(p.equipamentos) ? p.equipamentos : [],
      }));
    }
    return c.pops;
  };

  const popById = (id) => pops().find((p) => p.id === id) || null;

  /* Sugestão de POP a partir do cadastro antigo (campo local/nome).
     É só sugestão: o vínculo válido é o campo popId. */
  function suggestPop(equipamento) {
    const c = passe();
    /* Os nomes dos POPs são normalizados uma vez por repintura, não uma vez
       por equipamento: `normalize("NFD")` em cada nome custa caro no laço. */
    if (!c.alvos) {
      c.alvos = pops()
        .map((p) => ({ id: p.id, alvo: semAcento(p.nome).replace(/^pop\s*/, "").trim() }))
        .filter((x) => x.alvo);
    }
    if (!c.sugestao) c.sugestao = new Map();
    if (c.sugestao.has(equipamento)) return c.sugestao.get(equipamento);

    const texto = semAcento([equipamento.local, equipamento.nome, equipamento.id].join(" "));
    let melhor = null;
    for (const { id, alvo } of c.alvos) if (texto.includes(alvo)) melhor = id;
    c.sugestao.set(equipamento, melhor);
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

  /* Índice equipamento+porta → enlace, montado uma vez por repintura. Antes,
     cada porta de cada equipamento varria a lista inteira de enlaces, e as
     telas fazem isso para ocupação, status e enlaces caídos. A primeira
     ocorrência vence, como no `find` que este índice substitui. */
  // O separador é o caractere NUL, que nunca aparece em id de equipamento:
  // a chave equipamento+porta é sempre sem ambiguidade.
  function indicePortas() {
    const c = passe();
    if (!c.portas) {
      const m = new Map();
      const por = (dispositivo, porta, conexao) => {
        const chave = `${dispositivo} ${Number(porta)}`;
        if (!m.has(chave)) m.set(chave, conexao);
      };
      for (const cx of state.topology?.conexoes || []) {
        por(cx.origem, cx.portaOrigem, cx);
        por(cx.destino, cx.portaDestino, cx);
      }
      c.portas = m;
    }
    return c.portas;
  }

  const portConnection = (id, porta) => indicePortas().get(`${id} ${Number(porta)}`);

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

  /* O status vem das interfaces sincronizadas do Zabbix que foram projetadas na
     topologia. Sem inventário aplicado, a tela informa que aguarda o Zabbix.

     Degradação é avaliada só nas portas com enlace documentado: porta livre fica
     administrativamente desligada, e contá-la deixaria quase todo equipamento
     "Degradado" para sempre (o DWDM tem 10 portas e usa 5). Quando não há enlace
     documentado, o que importa é se o equipamento responde — aí basta uma porta
     no ar para considerá-lo online. */
  const monitorada = (p) => Number.isFinite(Number(p?.zabbix?.operStatus));
  const noAr = (p) => Number(p.zabbix.operStatus) === 1;

  function statusInfo(e) {
    const monitoradas = (e?.portas || []).filter(monitorada);
    if (!monitoradas.length) return { dot: "", label: "Aguardando Zabbix", badge: "" };

    const comEnlace = monitoradas.filter((p) => portaEmUso(e.id, p.numero));
    const base = comEnlace.length ? comEnlace : monitoradas;
    const up = base.filter(noAr).length;

    if (!up) return { dot: "dot-danger", label: "Offline", badge: "badge-danger" };
    if (up === base.length) return { dot: "dot-ok", label: "Online", badge: "badge-ok" };
    return { dot: "dot-warn", label: "Degradado", badge: "badge-warn" };
  }

  /* Enlaces documentados que estão fora do ar — é o que a operação precisa ver
     primeiro. Devolve a porta e o enlace correspondente. */
  function enlacesCaidos(e) {
    return (e?.portas || [])
      .filter((p) => monitorada(p) && !noAr(p) && portaEmUso(e.id, p.numero))
      .map((p) => ({ porta: p, conexao: portConnection(e.id, p.numero) }));
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

    /* Tudo o que o painel de tráfego desenha na abertura, em uma requisição:
       ajustes, status, hosts, interfaces, enlaces e histórico. O servidor lê o
       inventário uma vez só para montar os dois recortes. */
    overview: (horas) => api(`/api/zabbix/overview${horas ? `?horas=${Number(horas)}` : ""}`),

    /* Série agregada do tráfego da rede (uma amostra por sincronização). */
    history: (horas = 6) => api(`/api/zabbix/history?horas=${Number(horas)}`),

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

  /* Ajustes do painel de tráfego. Ficam em platform_meta no servidor: são
     configuração de tela, não topologia, e por isso não arrastam os ~50 KB da
     topologia a cada gravação. Ler exige zabbix.view; gravar, trafego.settings. */
  const trafego = {
    settings: () => api("/api/trafego/settings"),
    saveSettings: (settings) => api("/api/trafego/settings", {
      method: "PUT",
      body: JSON.stringify({ settings }),
    }),
  };

  /* A topologia só é necessária para editar a documentação dos enlaces e para
     vincular host a equipamento. Carregá-la sob demanda tira ~50 KB e um
     ida-e-volta do caminho crítico de abertura das telas que apenas monitoram.
     A Promise é memorizada: várias chamadas não viram várias requisições. */
  let topologyPromise = null;
  function loadTopologyOnce() {
    if (!topologyPromise) {
      topologyPromise = load().catch((err) => { topologyPromise = null; throw err; });
    }
    return topologyPromise;
  }

  /* 1 = up e 2 = down são os valores de ifOperStatus (SNMP). */
  const interfaceStatus = (i) =>
    i?.oper_status === 1 ? { dot: "dot-ok", label: "Up", badge: "badge-ok" }
      : i?.oper_status === 2 ? { dot: "dot-danger", label: "Down", badge: "badge-danger" }
        : { dot: "", label: "Sem dado", badge: "" };

  /* ---------------- acesso remoto aos equipamentos ---------------- */
  const deviceConnection = {
    get: (deviceId) => api(`/api/equipment-connections/${encodeURIComponent(deviceId)}`),
    create: (deviceId, target) => api(`/api/equipment-connections/${encodeURIComponent(deviceId)}`, {
      method: "POST", body: JSON.stringify(target),
    }),
    save: (deviceId, targetId, target) => api(`/api/equipment-connections/${encodeURIComponent(deviceId)}/${encodeURIComponent(targetId)}`, {
      method: "PUT", body: JSON.stringify(target),
    }),
    remove: (deviceId, targetId) => api(`/api/equipment-connections/${encodeURIComponent(deviceId)}/${encodeURIComponent(targetId)}`, { method: "DELETE" }),
    saveCredentials: (deviceId, targetId, credentials) => api(`/api/equipment-connections/${encodeURIComponent(deviceId)}/${encodeURIComponent(targetId)}/credentials`, {
      method: "PUT", body: JSON.stringify(credentials),
    }),
    removeCredentials: (deviceId, targetId) => api(`/api/equipment-connections/${encodeURIComponent(deviceId)}/${encodeURIComponent(targetId)}/credentials`, { method: "DELETE" }),
    revealPassword: (deviceId, targetId) => api(`/api/equipment-connections/${encodeURIComponent(deviceId)}/${encodeURIComponent(targetId)}/credentials/reveal`, { method: "POST" }),
  };

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
    loadTopologyOnce, trafego,
    pops, popById, suggestPop, effectivePop, isSuggested,
    devicesOfPop, unlinked, setPop, connectionsOf, portConnection, portaEmUso,
    usedPorts, occupancy, occClass, statsOf, statusInfo, enlacesCaidos, skeleton, errorState,
    zabbix, interfaceStatus, formatBps, deviceConnection,
  };
})();
