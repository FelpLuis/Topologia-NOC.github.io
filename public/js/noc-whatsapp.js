(() => {
  "use strict";
  const { $, $$, esc, icon, toast, modal, confirm: askConfirm, session, initials } = UI;

  const state = {
    data: null,            // resposta do /api/whatsapp
    sector: "",            // filtro de setor ("" = todos)
    status: "open",        // aba: open | queue | routing | closed
    search: "",
    mineOnly: false,
    activeId: null,        // conversa aberta no painel
    conversation: null,    // detalhe da conversa aberta
    messages: [],
    cliente: null,         // cadastro vinculado à conversa aberta (cliente_cadastro)
    diagnostico: null,     // celular do cliente ao abrir chamado no App UpDown
    can: { chat: false, supervise: false, manage: false, clientes: false },
    messagesSig: "",
    sideTab: "client",
    quickIndex: 0,
    sending: false,
    recording: null,       // gravação de áudio em andamento (NOCGravador)
    timer: null
  };

  const SIDE_KEY = "updown.wa.side";
  const narrow = window.matchMedia("(max-width: 1279px)");
  const coarse = window.matchMedia("(pointer: coarse)");

  /* ---------- ícones próprios do chat ---------- */
  const SVG = {
    whatsapp: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 2.2a9.8 9.8 0 0 0-8.4 14.8L2.3 21.7l4.8-1.3A9.8 9.8 0 1 0 12 2.2zm5.3 13.6c-.2.6-1.3 1.2-1.8 1.3-.5 0-1 .2-3.2-.7-2.7-1.1-4.4-3.8-4.5-4-.1-.2-1.1-1.4-1.1-2.7 0-1.3.7-1.9.9-2.2.2-.3.5-.3.7-.3h.5c.2 0 .4 0 .6.5l.8 2c.1.2.1.3 0 .5l-.3.5-.4.4c-.1.1-.3.3-.1.6.2.3.8 1.3 1.7 2.1 1.2 1 2.1 1.3 2.4 1.5.3.1.5.1.6-.1l.9-1c.2-.3.4-.2.6-.1l1.9.9c.3.1.5.2.5.3.1.1.1.7-.1 1.3z"/></svg>',
    globe: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.5 2.6 3.8 5.6 3.8 9s-1.3 6.4-3.8 9c-2.5-2.6-3.8-5.6-3.8-9S9.5 5.6 12 3z"/></svg>',
    phone: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><rect x="6.5" y="2.5" width="11" height="19" rx="2.5"/><path d="M11 18h2"/></svg>',
    send: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M3.4 20.4 21 12 3.4 3.6l-.1 6.5L15 12 3.3 13.9z"/></svg>',
    smile: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M8.5 14.5c.9 1.2 2.1 1.8 3.5 1.8s2.6-.6 3.5-1.8"/><circle cx="9" cy="10" r=".6" fill="currentColor"/><circle cx="15" cy="10" r=".6" fill="currentColor"/></svg>',
    transfer: '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 8h13M13.5 4.5 17 8l-3.5 3.5M20 16H7M10.5 12.5 7 16l3.5 3.5"/></svg>',
    panel: '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><rect x="3.5" y="4.5" width="17" height="15" rx="2"/><path d="M14.5 4.5v15"/></svg>',
    tick: '<svg viewBox="0 0 16 11" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M1.5 6l3 3 6.5-7.5"/></svg>',
    ticks: '<svg viewBox="0 0 16 11" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M1 6l3 3 6.5-7.5"/><path d="M7.6 8.4l.6.6 6.5-7.5"/></svg>',
    clip: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20.5 11.5 12 20a5.3 5.3 0 0 1-7.5-7.5l8.8-8.8a3.5 3.5 0 0 1 5 5l-8.8 8.8a1.8 1.8 0 0 1-2.5-2.5l8.1-8.1"/></svg>',
    mic: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><rect x="9" y="3" width="6" height="11" rx="3" fill="currentColor"/><path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21"/></svg>',
    trash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 7h16M9.5 7V4.5h5V7M6.5 7l1 13h9l1-13M10 11v5.5M14 11v5.5"/></svg>',
    doc: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round" aria-hidden="true"><path d="M6 2.8h8.2L19 7.6v13.6H6z"/><path d="M14 2.8v5h5"/></svg>',
    download: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 4v11M7.5 10.5 12 15l4.5-4.5M5 19.5h14"/></svg>',
    clockSm: '<svg viewBox="0 0 16 11" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" aria-hidden="true"><circle cx="8" cy="5.5" r="4.2"/><path d="M8 3.3v2.4l1.5 1"/></svg>'
  };

  const EMOJIS = ["😀", "😁", "😂", "😊", "😉", "😍", "🤔", "😅", "😢", "😮", "🙏", "👍", "👎", "👏", "🙌", "💪", "👋", "🤝", "✅", "❌", "⚠️", "📌", "📞", "📶", "📡", "🔧", "🛠️", "💻", "🏠", "⏳", "🚀", "❤️"];

  const formatPhone = p => {
    const d = String(p || "").replace(/\D/g, "");
    const m = d.match(/^(\d{2})(\d{2})(\d{4,5})(\d{4})$/);
    if (m) return `+${m[1]} (${m[2]}) ${m[3]}-${m[4]}`;
    // cadastro do IXC costuma vir sem o DDI
    const local = d.match(/^(\d{2})(\d{4,5})(\d{4})$/);
    if (local) return `(${local[1]}) ${local[2]}-${local[3]}`;
    return d || "—";
  };
  /* Hora da mensagem no fuso de São Paulo: o carimbo chega em UTC (ISO do
     webhook ou "YYYY-MM-DD HH:MM:SS" do banco) e quem converte é TEMPO. */
  const formatTime = t => TEMPO.hora(t, "");
  const isYesterday = t => TEMPO.mesmoDia(t, new Date(Date.now() - 86400000));
  const timeLabel = t => {
    if (!t) return "";
    // "Hoje" é o dia de Brasília — senão, perto da meia-noite, a conversa de
    // ontem aparece com hora seca e a de hoje com data.
    if (TEMPO.hoje(t)) return formatTime(t);
    if (isYesterday(t)) return "Ontem";
    return TEMPO.fmt(t, { day: "2-digit", month: "2-digit" }, "");
  };
  const dayLabel = t => TEMPO.hoje(t) ? "Hoje" : isYesterday(t) ? "Ontem" : TEMPO.fmt(t, { day: "2-digit", month: "long", year: "numeric" }, "");
  const since = t => {
    const d = TEMPO.instante(t);
    return d ? Math.max(0, Date.now() - d.getTime()) : 0;
  };
  const duration = ms => {
    const min = Math.floor(ms / 60000);
    if (min < 1) return "agora";
    if (min < 60) return `${min} min`;
    const h = Math.floor(min / 60);
    if (h < 24) return `${h} h ${String(min % 60).padStart(2, "0")}`;
    return `${Math.floor(h / 24)} d`;
  };

  // Canal nativo (Meta direto) não ganha selo na lista — é o padrão. Os
  // externos, que chegam via webhook do Opa!Suite ou pelo app, ganham um selo
  // pra distinguir; todos ganham o ícone no canto do avatar.
  const CHANNEL_LABELS = {
    whatsapp: { label: "WhatsApp", color: "#25d366", svg: "whatsapp", native: true },
    opasuite_meta: { label: "Opa!Suite", color: "#7c5cff", svg: "whatsapp" },
    opasuite_webchat: { label: "Webchat", color: "#f59e0b", svg: "globe" },
    app: { label: "App", color: "#2563eb", svg: "phone" },
    updown_app: { label: "App UpDown", color: "#0dbbef", svg: "phone" }
  };
  const channelOf = c => CHANNEL_LABELS[c?.channel] || CHANNEL_LABELS.whatsapp;
  const channelBadge = c => {
    const info = CHANNEL_LABELS[c.channel];
    return info && !info.native ? `<span class="wa-tag" style="--tag:${info.color}">${esc(info.label)}</span>` : "";
  };

  const AVATAR_COLORS = ["#2563eb", "#7c3aed", "#db2777", "#ea580c", "#0891b2", "#059669", "#4f46e5", "#b45309", "#0d9488", "#9333ea"];
  const colorFor = key => {
    let h = 0;
    for (const ch of String(key || "")) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    return AVATAR_COLORS[h % AVATAR_COLORS.length];
  };
  const nameOf = c => c?.customer_name && c.customer_name !== c.phone ? c.customer_name : formatPhone(c?.phone);
  const avatar = (c, size = "") => {
    const ch = channelOf(c);
    // sem nome, as "iniciais" do telefone viravam "+(": mostra a silhueta
    const known = c.customer_name && c.customer_name !== c.phone;
    return `<span class="wa-avatar ${size}" style="--av:${colorFor(c.phone || c.id)}">${known ? esc(initials(c.customer_name)) : icon("user")}<span class="wa-channel" style="--ch:${ch.color}" title="${esc(ch.label)}">${SVG[ch.svg]}</span></span>`;
  };

  const sectorOf = id => (state.data?.sectors || []).find(s => String(s.id) === String(id));
  const convOf = id => (state.data?.conversations || []).find(c => String(c.id) === String(id));
  const myId = () => Number(window.UPDOWN_AUTH?.id);
  const mine = c => c && Number(c.assigned_user_id) === myId();
  /* As abas seguem o Opa!Suite: "Fila" é conversa com setor e sem atendente,
     "Triagem" é o agente virtual (bot) ainda perguntando o setor. */
  const bucketOf = c => c.status === "closed" ? "closed" : c.status === "routing" ? "routing" : c.assigned_user_id ? "open" : "queue";
  const inScope = c =>
    // Conversa na triagem ainda não tem setor (sector_id null) — o filtro de
    // setor não se aplica a ela, senão some da tela.
    (c.status === "routing" || !state.sector || String(c.sector_id) === state.sector) &&
    (!state.mineOnly || mine(c));
  const matchesSearch = c => {
    const q = state.search.trim().toLowerCase();
    if (!q) return true;
    const digits = q.replace(/\D/g, "");
    const hay = [c.customer_name, c.client_nome, c.assigned_name, c.sector_name].filter(Boolean).join(" ").toLowerCase();
    return hay.includes(q) ||
      (digits && (String(c.phone || "").includes(digits) || String(c.id) === digits.replace(/^0+/, ""))) ||
      q.replace(/^#/, "") === String(c.id);
  };

  /* ---------- carregamento ---------- */

  async function load(silent = false) {
    try {
      const data = await NOC.api("/api/whatsapp");
      state.data = data;
      state.can = data.can || state.can;
      if (state.sector && !data.sectors.some(s => String(s.id) === state.sector)) state.sector = "";
      renderFilters();
      renderConvList();
      renderPresence();
      renderTitle();
      if (state.activeId) {
        const fresh = convOf(state.activeId);
        // saiu do alcance (transferida para outro setor, encerrada há mais de 7 dias)
        if (!fresh) closePane(true);
        else if (state.conversation) { updateHead(fresh); renderSide(); }
      }
      if (!silent) $("#newChatBtn").disabled = !state.can.chat;
    } catch (err) {
      if (!silent) NOC.errorState($("#convList"), err, () => boot());
    }
  }

  async function loadConversation(id) {
    try {
      const detail = await NOC.api(`/api/whatsapp/conversations/${id}`);
      state.activeId = String(id);
      state.conversation = { ...(convOf(id) || {}), ...detail.conversation };
      state.messages = detail.messages || [];
      state.cliente = detail.cliente || null;
      state.diagnostico = detail.diagnostico || null;
      renderChat();
      renderConvList();
      renderPresence();
      if (state.conversation.status === "open" && state.conversation.unread > 0) load(true);
    } catch (err) {
      toast("Não foi possível abrir a conversa", { text: err.message, type: "danger" });
    }
  }

  const openConversation = id => {
    state.activeId = String(id);
    $("#waDesk").classList.add("chat-open");
    loadConversation(Number(id));
  };

  /* ---------- lista ---------- */

  function renderFilters() {
    const sectors = state.data?.sectors || [];
    $("#sectorFilter").innerHTML = '<option value="">Todos os setores</option>' +
      sectors.map(s => `<option value="${s.id}" ${state.sector === String(s.id) ? "selected" : ""}>${esc(s.name)}</option>`).join("");
  }

  function renderTitle() {
    const pending = (state.data?.conversations || []).filter(c => c.status !== "closed" && mine(c)).reduce((n, c) => n + Number(c.unread || 0), 0);
    document.title = `${pending ? `(${pending}) ` : ""}UPDOWN • Chat WhatsApp`;
  }

  function waitTag(c) {
    const bucket = bucketOf(c);
    const waiting = bucket === "queue" || bucket === "routing" || (bucket === "open" && Number(c.unread) > 0);
    if (!waiting) return "";
    const ms = since(c.last_message_at || c.created_at);
    const cls = ms > 15 * 60000 ? "is-late" : ms > 5 * 60000 ? "is-wait" : "is-plain";
    return `<span class="wa-tag ${cls}" title="Cliente aguardando há ${duration(ms)}">${icon("clock")} ${duration(ms)}</span>`;
  }

  function renderConvList() {
    const host = $("#convList");
    const all = (state.data?.conversations || []).filter(inScope);
    const counts = { open: 0, queue: 0, routing: 0, closed: 0 };
    for (const c of all) counts[bucketOf(c)]++;
    for (const [k, n] of Object.entries(counts)) {
      const el = $(`[data-count="${k}"]`);
      if (el) el.textContent = n;
    }
    $('.wa-tab[data-status="queue"]').classList.toggle("has-alert", counts.queue > 0 && state.status !== "queue");

    const at = c => since(c.last_message_at || c.created_at);
    const list = all.filter(c => bucketOf(c) === state.status && matchesSearch(c));
    // fila e triagem: quem espera há mais tempo primeiro, como a roleta do Opa!Suite
    if (state.status === "queue" || state.status === "routing") list.sort((a, b) => at(b) - at(a));
    if (!list.length) {
      const msg = state.search ? ["Nada encontrado", "Nenhum atendimento corresponde à busca nesta aba."] :
        {
          open: ["Nenhum atendimento em andamento", "Os atendimentos assumidos aparecem aqui."],
          queue: ["Fila vazia", "Conversas com setor definido e sem atendente aparecem aqui."],
          routing: ["Ninguém na triagem", "Novos contatos escolhendo o setor com o agente virtual aparecem aqui."],
          closed: ["Nenhum encerrado", "Os atendimentos encerrados nos últimos 7 dias aparecem aqui."]
        }[state.status];
      host.innerHTML = `<div class="wa-list-empty">${icon(state.search ? "search" : "users")}<b>${msg[0]}</b><p>${msg[1]}</p></div>`;
      return;
    }
    host.innerHTML = list.map(c => {
      const unread = c.status !== "closed" ? Number(c.unread || 0) : 0;
      const sector = c.sector_name ? `<span class="wa-tag" style="--tag:${esc(c.sector_color || "var(--cyan-400)")}">${esc(c.sector_name)}</span>` : "";
      const agent = c.assigned_name && c.status !== "routing" ? `<span class="wa-tag is-plain" title="Atendente">${icon("user")} ${esc(mine(c) ? "Você" : c.assigned_name)}</span>` : "";
      const client = c.client_id ? `<span class="wa-tag" style="--tag:var(--ok-500)" title="Cliente vinculado: ${esc(c.client_nome || c.client_id)}">${icon("link")}</span>` : "";
      return `<button class="wa-conv-item ${state.activeId === String(c.id) ? "is-active" : ""} ${unread ? "has-unread" : ""}" data-conv="${c.id}" type="button">
        ${avatar(c)}
        <span class="wa-conv-main">
          <span class="wa-conv-row"><span class="wa-conv-name">${esc(nameOf(c))}</span><span class="wa-conv-time">${esc(timeLabel(c.status === "closed" ? (c.closed_at || c.updated_at) : (c.last_message_at || c.created_at)))}</span></span>
          <span class="wa-conv-row"><span class="wa-conv-last">${esc(c.last_message || "Sem mensagens")}</span>${unread ? `<b class="wa-unread">${unread}</b>` : ""}</span>
          <span class="wa-conv-tags">${sector}${agent}${channelBadge(c)}${client}${waitTag(c)}<span class="wa-tag is-plain" title="Protocolo">#${c.id}</span></span>
        </span>
      </button>`;
    }).join("");
    $$("[data-conv]", host).forEach(item => item.onclick = () => openConversation(item.dataset.conv));
  }

  /* ---------- equipe / presença ---------- */

  function selfPresence() {
    return (state.data?.presence || []).find(p => Number(p.user_id) === myId());
  }

  // Setores da aba Equipe em "Todos os setores": os do próprio usuário que
  // atendem no WhatsApp. O presence vem com todos os setores visíveis (o
  // administrador vê todos) porque a transferência precisa deles; sem esse
  // recorte a aba listava todo mundo. Quem não está em nenhum setor do
  // WhatsApp vê a equipe inteira do WhatsApp; null é sem recorte.
  function teamSectorIds() {
    const routed = enabledSectors().map(s => Number(s.id));
    const base = routed.length ? routed : null;
    const own = (selfPresence()?.sectors || []).filter(id => !base || base.includes(id));
    return own.length ? own : base;
  }

  function renderPresence() {
    const self = selfPresence();
    const pill = $("#presenceToggle");
    const status = self?.available === false ? "paused" : self?.busy ? "busy" : "available";
    pill.className = `wa-status-pill ${status === "busy" ? "is-busy" : status === "paused" ? "is-paused" : ""}`;
    pill.innerHTML = `<span class="wa-dot"></span><span class="wa-status-text">${
      status === "paused" ? "Pausado" : status === "busy" ? "Online · em atendimento" : "Online · disponível"
    } <small>— ${status === "paused" ? "retomar" : "pausar"}</small></span>${icon("chevronDown")}`;
    pill.title = status === "paused" ? "Você não recebe novos atendimentos. Clique para voltar." : "Clique para pausar o recebimento de atendimentos.";

    const team = teamSectorIds();
    const list = (state.data?.presence || []).filter(p => state.sector
      ? p.sectors.includes(Number(state.sector))
      : !team || p.sectors.some(id => team.includes(id)));
    const groups = [
      ["Em atendimento", list.filter(p => p.busy)],
      ["Disponíveis", list.filter(p => !p.busy && p.available !== false)],
      ["Pausados", list.filter(p => !p.busy && p.available === false)]
    ];
    const item = p => {
      const label = p.busy
        ? (state.can.supervise && p.current ? `Com ${esc(nameOf(p.current))}` : "Em conversa")
        : (p.available === false ? "Pausado" : "Disponível");
      return `<div class="wa-presence-item ${p.busy ? "is-busy" : ""} ${p.available === false ? "is-paused" : ""}" ${state.can.supervise && p.current ? `data-conv="${p.current.conversation_id}" title="Abrir a conversa"` : ""}>
        <span class="wa-avatar is-sm">${esc(initials(p.display_name))}<span class="wa-channel"></span></span>
        <span class="wa-presence-who"><b>${esc(p.display_name)}${Number(p.user_id) === myId() ? " (você)" : ""}</b><small>${label}</small></span>
      </div>`;
    };
    $("#presenceList").innerHTML = list.length
      ? groups.filter(([, items]) => items.length).map(([title, items]) => `<div class="wa-presence-group">${title} · ${items.length}</div>${items.map(item).join("")}`).join("")
      : `<div class="wa-side-empty">${icon("users")}<b>Ninguém por aqui</b>Nenhum atendente no setor selecionado.</div>`;
    if (state.can.supervise) {
      $$(".wa-presence-item[data-conv]").forEach(el => el.onclick = () => openConversation(el.dataset.conv));
    }
  }

  /* ---------- conversa ---------- */

  function updateHead(conv) {
    state.conversation = { ...(state.conversation || {}), ...conv };
    const c = state.conversation;
    $("#chatName").textContent = nameOf(c);
    $("#chatAvatar").outerHTML = avatar(c).replace('class="wa-avatar ', 'id="chatAvatar" class="wa-avatar ');
    const parts = [`Protocolo #${c.id}`, channelOf(c).label, formatPhone(c.phone)];
    if (c.sector_name) parts.splice(1, 0, c.sector_name);
    $("#chatMeta").textContent = parts.join(" · ");
    renderHeadButtons(c);
  }

  function renderHeadButtons(conv) {
    const take = $("#takeBtn"), assign = $("#assignBtn"), close = $("#closeBtn");
    const isMine = mine(conv);
    const closed = conv.status === "closed";
    const routing = conv.status === "routing";
    take.hidden = closed || isMine || !state.can.chat;
    take.innerHTML = `${icon("plus")}<span class="wa-btn-label"> Assumir</span>`;
    take.title = routing ? "Assumir e escolher o setor" : "Assumir o atendimento";
    assign.hidden = closed || !state.can.supervise;
    assign.innerHTML = `${SVG.transfer}<span class="wa-btn-label"> Transferir</span>`;
    assign.title = "Transferir para outro setor ou atendente";
    close.hidden = closed || !state.can.chat;
    close.innerHTML = `${icon("check")}<span class="wa-btn-label"> Encerrar</span>`;
    close.title = "Encerrar o atendimento";

    const canRespond = !closed && !routing && state.can.chat && (isMine || state.can.supervise);
    $("#composer").hidden = !canRespond;
    $("#composer").dataset.ready = canRespond ? "1" : "0";
    const locked = $("#composerLocked");
    locked.hidden = canRespond;
    if (!canRespond) {
      const canTake = state.can.chat && !closed && !isMine;
      const text = closed ? `Atendimento encerrado${conv.closed_at ? ` em ${TEMPO.dataHora(conv.closed_at, "")}` : ""}.`
        : !state.can.chat ? "Seu perfil permite apenas acompanhar as conversas."
        : routing ? "O agente virtual está aguardando o cliente escolher o setor."
        : conv.assigned_name ? `Em atendimento com ${conv.assigned_name}.`
        : `Aguardando atendente${conv.sector_name ? ` no setor ${conv.sector_name}` : ""}.`;
      locked.innerHTML = `${icon(closed ? "lock" : "info")}<span>${esc(text)}</span>${canTake ? `<button class="btn btn-primary btn-sm" type="button" data-locked-take>${icon("plus")} Assumir atendimento</button>` : ""}`;
      const btn = $("[data-locked-take]", locked);
      if (btn) btn.onclick = () => takeConversation(state.conversation);
    }
  }

  const linkify = text => esc(text).replace(/\bhttps?:\/\/[^\s<]+[^\s<.,;:!?)"']/g, url => `<a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>`);

  function ticks(m) {
    if (m.direction !== "out") return "";
    const map = {
      sent: ["", SVG.tick, "Enviada"],
      delivered: ["", SVG.ticks, "Entregue"],
      read: ["is-read", SVG.ticks, "Lida"],
      failed: ["is-failed", SVG.clockSm, "Falhou o envio"],
      sending: ["", SVG.clockSm, "Enviando"]
    };
    const [cls, svg, label] = map[m.status] || map.sent;
    return `<span class="wa-ticks ${cls}" title="${label}" aria-label="${label}">${svg}</span>`;
  }

  function renderMessages(forceBottom = false) {
    const host = $("#messages");
    const nearBottom = host.scrollHeight - host.scrollTop - host.clientHeight < 120;
    const messages = state.messages || [];
    state.messagesSig = messages.map(m => `${m.id}:${m.status}`).join(",");
    if (!messages.length) {
      host.innerHTML = '<p class="wa-thread-empty">Nenhuma mensagem nesta conversa ainda.</p>';
      return;
    }
    let prevDay = "", prevKey = "";
    const out = [];
    for (const m of messages) {
      const day = TEMPO.chaveDia(m.created_at);
      if (day !== prevDay) { out.push(`<div class="wa-day">${esc(dayLabel(m.created_at))}</div>`); prevDay = day; prevKey = ""; }
      const kind = m.direction === "in" ? "is-in" : m.direction === "bot" ? "is-bot" : "is-out";
      const key = `${m.direction}:${m.sender_name || ""}`;
      const first = key !== prevKey;
      prevKey = key;
      const sender = m.direction === "bot" ? (m.sender_name || "Agente virtual")
        : m.direction === "out" && first ? (Number(m.sender_user_id) === myId() ? "Você" : (m.sender_name || "Atendente")) : "";
      const media = mediaHtml(m);
      const body = media || linkify(m.body);
      out.push(`<div class="wa-msg ${kind} ${first ? "is-first" : ""}${media ? " has-media" : ""}"><div class="wa-bubble">${sender ? `<span class="wa-sender">${esc(sender)}</span>` : ""}${body}<span class="wa-meta">${esc(formatTime(m.created_at))}${ticks(m)}</span></div></div>`);
    }
    // Áudio e vídeo sobrevivem ao redesenho do polling: sem isso, uma
    // mensagem nova chegando cortava no meio o áudio que o atendente ouvia.
    const players = new Map($$("audio[data-mid], video[data-mid]", host).map(el => [el.dataset.mid, el]));
    host.innerHTML = out.join("");
    $$("audio[data-mid], video[data-mid]", host).forEach(el => {
      const old = players.get(el.dataset.mid);
      if (old && old.getAttribute("src") === el.getAttribute("src")) el.replaceWith(old);
    });
    if (forceBottom || nearBottom) host.scrollTop = host.scrollHeight;
    $$(".wa-img", host).forEach(img => {
      img.onclick = () => openLightbox(img.src);
      img.onload = () => { if (forceBottom || nearBottom) host.scrollTop = host.scrollHeight; };
    });
  }

  function mediaHtml(m) {
    const src = String(m.body || "");
    if (!src.startsWith("/api/media/") && !src.startsWith("blob:")) return "";
    const caption = m.caption ? `<span class="wa-caption">${linkify(m.caption)}</span>` : "";
    const mid = esc(String(m.id));
    if (m.type === "image") return `<img class="wa-img" src="${esc(src)}" alt="Imagem enviada na conversa" loading="lazy">${caption}`;
    if (m.type === "audio") return `<audio class="wa-audio" data-mid="${mid}" controls preload="metadata" src="${esc(src)}"></audio>`;
    if (m.type === "video") return `<video class="wa-video" data-mid="${mid}" controls preload="metadata" src="${esc(src)}"></video>${caption}`;
    if (m.type === "document") {
      const name = m.media_name || "Documento";
      const ext = (name.includes(".") ? name.split(".").pop() : src.split(".").pop()).slice(0, 5).toUpperCase();
      return `<a class="wa-doc" href="${esc(src)}" download="${esc(name)}" target="_blank" rel="noopener" title="Baixar ${esc(name)}"><span class="wa-doc-icon">${SVG.doc}<b>${esc(ext)}</b></span><span class="wa-doc-name">${esc(name)}</span><span class="wa-doc-dl">${SVG.download}</span></a>${caption}`;
    }
    return "";
  }

  function openLightbox(src) {
    const box = document.createElement("div");
    box.className = "wa-lightbox";
    box.innerHTML = `<img src="${esc(src)}" alt="Imagem ampliada">`;
    const close = () => { box.remove(); document.removeEventListener("keydown", onKey); };
    const onKey = e => { if (e.key === "Escape") close(); };
    box.onclick = close;
    document.addEventListener("keydown", onKey);
    document.body.append(box);
  }

  function renderChat() {
    const conv = state.conversation;
    if (!conv) { closePane(true); return; }
    $("#chatEmpty").hidden = true;
    $("#chatThread").hidden = false;
    closePopovers();
    updateHead(conv);
    renderMessages(true);
    renderSide();
    if ($("#composer").dataset.ready === "1" && !coarse.matches) setTimeout(() => $("#msgInput").focus(), 30);
  }

  function closePane(silent = false) {
    cancelRecording();
    state.activeId = null;
    state.conversation = null;
    state.messages = [];
    state.cliente = null;
    state.diagnostico = null;
    state.messagesSig = "";
    $("#chatEmpty").hidden = false;
    $("#chatThread").hidden = true;
    $("#waDesk").classList.remove("chat-open");
    closePopovers();
    renderSide();
    if (!silent) renderConvList();
  }

  /* ---------- painel lateral: cliente ---------- */

  function sideVisible() {
    const desk = $("#waDesk");
    return narrow.matches ? desk.classList.contains("side-open") : !desk.classList.contains("side-collapsed");
  }

  function toggleSide(force) {
    const desk = $("#waDesk");
    const show = force ?? !sideVisible();
    if (narrow.matches) {
      desk.classList.toggle("side-open", show);
      $("#sideScrim").hidden = !show;
    } else {
      desk.classList.toggle("side-collapsed", !show);
      try { localStorage.setItem(SIDE_KEY, show ? "open" : "closed"); } catch { /* sem armazenamento */ }
    }
    syncSideButton();
  }

  function syncSideButton() {
    const open = sideVisible();
    $("#infoBtn").setAttribute("aria-expanded", String(open));
    $("#infoBtn").setAttribute("aria-label", open ? "Ocultar painel do cliente" : "Mostrar painel do cliente");
  }

  function setSideTab(tab) {
    state.sideTab = tab;
    $$("[data-side]").forEach(b => b.setAttribute("aria-selected", String(b.dataset.side === tab)));
    $("#sideClient").hidden = tab !== "client";
    $("#sideTeam").hidden = tab !== "team";
  }

  function renderSide() {
    const host = $("#sideClient");
    const conv = state.conversation;
    if (!conv) {
      host.innerHTML = `<div class="wa-side-empty">${icon("user")}<b>Painel do cliente</b>Selecione um atendimento para ver os dados do contato, o cadastro vinculado e o histórico.</div>`;
      return;
    }
    const ch = channelOf(conv);
    const canManage = state.can.clientes && state.can.chat && conv.status !== "closed" &&
      (mine(conv) || state.can.supervise || conv.status === "routing");
    const cliente = state.cliente;
    const statusText = conv.status === "closed" ? "Encerrado" : conv.status === "routing" ? "Triagem (agente virtual)" : conv.assigned_user_id ? "Em atendimento" : "Na fila";
    const row = (label, value) => value ? `<div><dt>${esc(label)}</dt><dd>${esc(value)}</dd></div>` : "";
    let clientBlock;
    if (cliente) {
      const endereco = [cliente.endereco, cliente.bairro, [cliente.cidade, cliente.uf].filter(Boolean).join("/")].filter(Boolean).join(", ");
      clientBlock = `<div class="wa-client-card">
          <b>${esc(cliente.nome || cliente.client_id)}</b>
          <small>Código ${esc(cliente.client_id)}</small>
        </div>
        <dl class="wa-dl">
          ${row("CPF/CNPJ", cliente.cpf_cnpj)}${row("Plano", cliente.plano)}${row("Faturamento", cliente.status_faturamento)}
          ${row("Telefone", cliente.telefone ? formatPhone(cliente.telefone) : "")}${row("E-mail", cliente.email)}${row("Endereço", endereco)}
        </dl>`;
    } else {
      clientBlock = `<p class="wa-side-note">Nenhum cadastro vinculado a este contato.</p>`;
    }
    host.innerHTML = `
      <div class="wa-profile">
        ${avatar(conv, "is-lg")}
        <b>${esc(nameOf(conv))}</b>
        <small>${esc(formatPhone(conv.phone))}</small>
        <span class="wa-conv-tags"><span class="wa-tag" style="--tag:${ch.color}">${esc(ch.label)}</span>${conv.sector_name ? `<span class="wa-tag" style="--tag:${esc(conv.sector_color || "var(--cyan-400)")}">${esc(conv.sector_name)}</span>` : ""}</span>
      </div>
      <section class="wa-section">
        <div class="wa-section-head"><h3>Cliente vinculado</h3>${canManage ? (cliente
          ? `<button class="btn btn-sm btn-ghost" id="clientUnlinkBtn" type="button">Desvincular</button>`
          : `<button class="btn btn-sm" id="clientLinkBtn" type="button">${icon("link")} Vincular</button>`) : ""}</div>
        ${clientBlock}
      </section>
      ${conv.channel === "updown_app" ? deviceSection(state.diagnostico) : ""}
      <section class="wa-section">
        <div class="wa-section-head"><h3>Atendimento</h3></div>
        <dl class="wa-dl">
          ${row("Protocolo", `#${conv.id}`)}${row("Situação", statusText)}${row("Setor", conv.sector_name || "—")}
          ${row("Atendente", conv.assigned_name || "—")}${row("Canal", ch.label)}
          ${row("Aberto em", TEMPO.dataHora(conv.created_at, ""))}
          ${row("Última mensagem", TEMPO.dataHora(conv.last_message_at, ""))}
          ${conv.status === "closed" ? row("Encerrado em", TEMPO.dataHora(conv.closed_at || conv.updated_at, "")) : row("Duração", duration(since(conv.created_at)))}
        </dl>
      </section>`;
    const unlinkBtn = $("#clientUnlinkBtn", host), linkBtn = $("#clientLinkBtn", host);
    if (unlinkBtn) unlinkBtn.onclick = () => unlinkClient(conv);
    if (linkBtn) linkBtn.onclick = () => openClientLinkModal(conv);
  }

  /* O que o App UpDown mediu do celular ao abrir o chamado de suporte: velocidade
     contra o nosso servidor, Wi-Fi (nome da rede) ou dados móveis (operadora) e a
     localização. Chega pela sincronização do app (uaGuardarDiagnostico no worker). */
  const DIAG_AVISOS = {
    localizacao_negada: "O cliente não liberou a localização.",
    localizacao_desligada: "A localização do celular estava desligada.",
    localizacao_sem_sinal: "O celular não conseguiu se localizar a tempo.",
    teste_falhou: "O teste de velocidade não terminou.",
    teste_sem_conexao: "O celular estava sem internet na hora do teste."
  };

  function deviceSection(d) {
    const head = extra => `<div class="wa-section-head"><h3>Celular do cliente</h3>${extra || ""}</div>`;
    if (!d) {
      return `<section class="wa-section">${head()}
        <p class="wa-side-note">O app ainda não mandou o diagnóstico. Ele chega uns segundos depois de o cliente abrir um chamado de suporte técnico.</p>
      </section>`;
    }
    const row = (label, value) => value ? `<div><dt>${esc(label)}</dt><dd>${value}</dd></div>` : "";
    const mbps = v => (v >= 100 ? Math.round(v) : Math.round(v * 10) / 10).toLocaleString("pt-BR");
    const v = d.velocidade;
    const speed = v
      ? `<div class="wa-diag-speed">
          <div><small>Download</small><b>${esc(mbps(v.downloadMbps))}</b><small>Mbps</small></div>
          <div><small>Upload</small><b>${esc(mbps(v.uploadMbps))}</b><small>Mbps</small></div>
          <div><small>Ping</small><b>${esc(String(v.pingMs ?? "—"))}</b><small>ms${v.jitterMs != null ? ` · jitter ${esc(String(v.jitterMs))}` : ""}</small></div>
        </div>`
      : "";
    const updown = d.naRedeDaUpdown === true ? `<span class="wa-diag-tag is-ok">Rede UpDown</span>`
      : d.naRedeDaUpdown === false ? `<span class="wa-diag-tag is-warn">Fora da rede UpDown</span>` : "";
    const conexao = d.conexao === "wifi" ? `Wi-Fi${d.redeWifi ? ` · <b>${esc(d.redeWifi)}</b>` : " · nome da rede não informado"}`
      : d.conexao === "movel" ? `Dados móveis${d.operadora ? ` · <b>${esc(d.operadora)}</b>` : ""}`
      : d.conexao === "cabo" ? "Cabo de rede"
      : d.conexao === "sem_conexao" ? "Sem conexão" : "Não identificada";
    const loc = d.localizacao;
    const local = loc
      ? `${esc(loc.latitude.toFixed(5))}, ${esc(loc.longitude.toFixed(5))}${loc.precisaoMetros ? ` <span class="dim">(±${esc(String(Math.round(loc.precisaoMetros)))} m)</span>` : ""}
         <a class="wa-diag-map" href="https://www.google.com/maps?q=${encodeURIComponent(`${loc.latitude},${loc.longitude}`)}" target="_blank" rel="noopener noreferrer">Abrir no mapa</a>`
      : "";
    const avisos = (d.avisos || []).map(a => DIAG_AVISOS[a]).filter(Boolean);
    return `<section class="wa-section">
        ${head(`<small class="wa-side-note" title="${esc(TEMPO.dataHora(d.medidoEm, ""))}">${esc(timeLabel(d.medidoEm))}</small>`)}
        ${speed || `<p class="wa-side-note">Sem resultado do teste de velocidade.</p>`}
        <dl class="wa-dl">
          ${row("Conexão", `${conexao}${updown ? ` ${updown}` : ""}`)}
          ${row("Localização", local || '<span class="dim">Não enviada</span>')}
          ${row("Medido em", esc(TEMPO.dataHora(d.medidoEm, "")))}
          ${v?.servidor ? row("Servidor", esc(v.servidor)) : ""}
        </dl>
        ${avisos.length ? `<ul class="wa-diag-avisos">${avisos.map(a => `<li>${esc(a)}</li>`).join("")}</ul>` : ""}
      </section>`;
  }

  function openClientLinkModal(conv) {
    modal({
      labelledBy: "waLinkClientTitle",
      html: `
        <div class="modal-head"><div><span class="kicker">Cadastro de cliente</span><h2 id="waLinkClientTitle">Vincular cliente ao atendimento</h2></div><button class="btn btn-ghost btn-icon" data-close type="button">${icon("close")}</button></div>
        <div class="modal-body">
          <div class="field"><label for="clientSearch">Buscar por nome, código, telefone ou CPF/CNPJ</label><input class="input" id="clientSearch" autocomplete="off" placeholder="Digite para buscar…"></div>
          <div class="wa-client-search-results" id="clientSearchResults"></div>
          <span class="field-error" id="clientLinkError" hidden></span>
        </div>
        <div class="modal-foot"><span></span><span class="row"><button class="btn" data-close type="button">Cancelar</button></span></div>`,
      onMount: (host, close) => {
        const input = $("#clientSearch", host), results = $("#clientSearchResults", host), error = $("#clientLinkError", host);
        let timer = null;
        const search = async () => {
          const q = input.value.trim();
          if (!q) { results.innerHTML = ""; return; }
          try {
            const data = await NOC.api(`/api/clientes?q=${encodeURIComponent(q)}`);
            const registros = (data.registros || []).slice(0, 25);
            results.innerHTML = registros.length
              ? registros.map(c => `<button class="wa-client-search-item" type="button" data-client="${esc(c.client_id)}"><b>${esc(c.nome || c.client_id)}</b><small>${esc([c.client_id, c.telefone ? formatPhone(c.telefone) : "", c.plano].filter(Boolean).join(" · "))}</small></button>`).join("")
              : '<p class="dim" style="text-align:center;padding:var(--s-3);font-size:var(--fs-12)">Nenhum cliente encontrado.</p>';
            $$("[data-client]", results).forEach(btn => btn.onclick = async () => {
              try {
                await NOC.api(`/api/whatsapp/conversations/${conv.id}/client`, { method: "POST", body: JSON.stringify({ client_id: btn.dataset.client }) });
                close();
                toast("Cliente vinculado", { type: "ok" });
                await loadConversation(conv.id);
                load(true);
              } catch (err) { error.hidden = false; error.textContent = err.message; }
            });
          } catch (err) { error.hidden = false; error.textContent = err.message; }
        };
        input.addEventListener("input", () => { clearTimeout(timer); timer = setTimeout(search, 300); });
        // começa pelo telefone do contato: quase sempre é o que acha o cadastro
        const digits = String(conv.phone || "").replace(/\D/g, "").replace(/^55(?=\d{10,11}$)/, "");
        if (digits) { input.value = digits; search(); }
        setTimeout(() => input.focus(), 30);
      }
    });
  }

  function unlinkClient(conv) {
    askConfirm({
      title: "Desvincular este cliente?",
      text: "O atendimento deixa de estar associado ao cadastro do cliente.",
      confirmLabel: "Desvincular",
      danger: true,
      onConfirm: async () => {
        try {
          await NOC.api(`/api/whatsapp/conversations/${conv.id}/client`, { method: "DELETE" });
          toast("Cliente desvinculado", { type: "ok" });
          await loadConversation(conv.id);
          load(true);
        } catch (err) { toast("Não foi possível desvincular", { text: err.message, type: "danger" }); }
      }
    });
  }

  /* ---------- composer: emojis e mensagens rápidas ---------- */

  const quickReplies = () => state.data?.settings?.quickReplies || [];

  function fillVariables(text) {
    const conv = state.conversation || {};
    const cliente = (state.cliente?.nome || (conv.customer_name !== conv.phone ? conv.customer_name : "") || "").trim().split(/\s+/)[0] || "";
    const pretty = cliente ? cliente[0].toUpperCase() + cliente.slice(1).toLowerCase() : "";
    return text
      // sem nome conhecido, "Olá, {cliente}!" vira "Olá!" em vez de "Olá, !"
      .replace(/,?\s*\{cliente\}/g, m => pretty ? m.replace("{cliente}", pretty) : "")
      .replace(/\{atendente\}/g, session().name.split(/\s+/)[0]);
  }

  function closePopovers() {
    $("#quickMenu").hidden = true;
    $("#emojiMenu").hidden = true;
    $("#quickBtn").setAttribute("aria-expanded", "false");
    $("#emojiBtn").setAttribute("aria-expanded", "false");
  }

  function quickMatches() {
    const value = $("#msgInput").value;
    const m = value.match(/^\/([^\s]*)$/);
    const term = (m ? m[1] : "").toLowerCase();
    return quickReplies().filter(q => !term || q.shortcut.includes(term) || q.text.toLowerCase().includes(term));
  }

  function renderQuick() {
    const menu = $("#quickMenu");
    const items = quickMatches();
    state.quickIndex = Math.min(state.quickIndex, Math.max(0, items.length - 1));
    menu.innerHTML = `<div class="wa-quick-head">Mensagens rápidas</div>` + (items.length
      ? items.map((q, i) => `<button class="wa-quick-item" type="button" role="option" data-quick="${i}" aria-selected="${i === state.quickIndex}"><b>/${esc(q.shortcut)}</b><span>${esc(fillVariables(q.text))}</span></button>`).join("")
      : `<div class="wa-quick-empty">${quickReplies().length ? "Nenhum atalho com esse nome." : "Nenhuma mensagem rápida cadastrada."}${state.can.manage ? " Cadastre em Configurar o chat." : ""}</div>`);
    $$("[data-quick]", menu).forEach(btn => {
      btn.onmousedown = e => e.preventDefault();
      btn.onclick = () => applyQuick(items[Number(btn.dataset.quick)]);
    });
    const sel = $('[aria-selected="true"]', menu);
    if (sel) sel.scrollIntoView({ block: "nearest" });
    return items;
  }

  function openQuick() {
    $("#emojiMenu").hidden = true;
    $("#emojiBtn").setAttribute("aria-expanded", "false");
    $("#quickMenu").hidden = false;
    $("#quickBtn").setAttribute("aria-expanded", "true");
    renderQuick();
  }

  function applyQuick(q) {
    if (!q) return;
    const input = $("#msgInput");
    input.value = fillVariables(q.text);
    closePopovers();
    autoGrow();
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
  }

  function insertAtCaret(text) {
    const input = $("#msgInput");
    const start = input.selectionStart ?? input.value.length, end = input.selectionEnd ?? input.value.length;
    input.value = input.value.slice(0, start) + text + input.value.slice(end);
    input.focus();
    input.setSelectionRange(start + text.length, start + text.length);
    autoGrow();
  }

  function autoGrow() {
    const input = $("#msgInput");
    input.style.height = "auto";
    input.style.height = Math.min(input.scrollHeight, 140) + "px";
  }

  /* ---------- ações ---------- */

  function enabledSectors() {
    const codes = state.data?.settings?.routedSectors || [];
    return (state.data?.sectors || []).filter(s => codes.includes(s.code));
  }

  async function sendMessage() {
    const input = $("#msgInput");
    const text = input.value.trim();
    if (!text || state.sending || !state.activeId) return;
    state.sending = true;
    const sendBtn = $("#sendBtn");
    sendBtn.disabled = true;
    closePopovers();
    try {
      await NOC.api(`/api/whatsapp/conversations/${state.activeId}/messages`, { method: "POST", body: JSON.stringify({ body: text }) });
      input.value = "";
      autoGrow();
      syncSendMode();
      state.messages.push({ id: `tmp-${Date.now()}`, direction: "out", body: text, status: "sent", created_at: new Date().toISOString(), sender_user_id: myId(), sender_name: session().name });
      renderMessages(true);
      load(true);
    } catch (err) {
      toast("Não foi possível enviar", { text: err.message, type: "danger" });
    } finally {
      state.sending = false;
      sendBtn.disabled = false;
      input.focus();
    }
  }

  /* ---------- anexos e áudio ---------- */

  const MAX_BYTES = 16 * 1024 * 1024;
  // Mesma lista de MEDIA_ALLOWED_TYPES no worker. Navegador às vezes manda
  // o tipo vazio (docx no Windows sem Office) ou um apelido (audio/x-m4a):
  // a extensão desempata.
  const FILE_TYPES = {
    jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp", gif: "image/gif",
    ogg: "audio/ogg", opus: "audio/ogg", mp3: "audio/mpeg", m4a: "audio/mp4", aac: "audio/aac", amr: "audio/amr",
    mp4: "video/mp4", "3gp": "video/3gpp",
    pdf: "application/pdf", txt: "text/plain",
    doc: "application/msword", docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    xls: "application/vnd.ms-excel", xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ppt: "application/vnd.ms-powerpoint", pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation"
  };
  const TYPE_ALIASES = { "audio/x-m4a": "audio/mp4", "audio/m4a": "audio/mp4", "audio/mp3": "audio/mpeg", "audio/opus": "audio/ogg", "image/jpg": "image/jpeg" };
  const ACCEPTED = new Set(Object.values(FILE_TYPES));

  function fileTypeOf(file) {
    const raw = String(file.type || "").split(";")[0].toLowerCase();
    const type = TYPE_ALIASES[raw] || raw;
    if (ACCEPTED.has(type)) return type;
    return FILE_TYPES[String(file.name || "").split(".").pop().toLowerCase()] || "";
  }

  const kindOfType = type => ["image", "audio", "video"].includes(type.split("/")[0]) ? type.split("/")[0] : "document";
  const stamp = () => new Date().toISOString().slice(0, 19).replace(/[T:]/g, "-");

  // Sobe o arquivo e manda a mensagem que aponta para ele. Enquanto isso, uma
  // bolha provisória com o próprio arquivo local mostra que está indo.
  async function sendMedia(blob, type, name) {
    const convId = state.activeId;
    const tmp = {
      id: `tmp-${Date.now()}-${Math.random().toString(36).slice(2)}`, direction: "out", type: kindOfType(type), body: URL.createObjectURL(blob),
      media_name: name, status: "sending", created_at: new Date().toISOString(), sender_user_id: myId(), sender_name: session().name
    };
    state.messages.push(tmp);
    renderMessages(true);
    try {
      const up = await NOC.api("/api/whatsapp/uploads", { method: "POST", headers: { "Content-Type": type }, body: blob });
      await NOC.api(`/api/whatsapp/conversations/${convId}/messages`, { method: "POST", body: JSON.stringify({ type: up.kind || tmp.type, body: up.path, name }) });
      tmp.status = "sent";
      return true;
    } catch (err) {
      tmp.status = "failed";
      toast(`Não foi possível enviar ${name || "o arquivo"}`, { text: err.message, type: "danger" });
      return false;
    } finally {
      if (state.activeId === convId) { renderMessages(true); refreshConversation(); }
      load(true);
    }
  }

  async function sendFiles(files) {
    if (!state.activeId || $("#composer").dataset.ready !== "1") return;
    for (const file of files) {
      const type = fileTypeOf(file);
      if (!type) { toast(`${file.name}: tipo de arquivo não aceito`, { text: "Envie imagem, áudio, vídeo MP4, PDF, Word, Excel, PowerPoint ou TXT.", type: "danger" }); continue; }
      if (file.size > MAX_BYTES) { toast(`${file.name}: acima de 16 MB`, { text: "O WhatsApp não entrega arquivos maiores que isso.", type: "danger" }); continue; }
      if (!file.size) continue;
      // print colado chega sempre como "image.png": dá um nome que diga quando foi
      const name = file.name && file.name !== "image.png" ? file.name : `imagem-${stamp()}.${type.split("/")[1]}`;
      await sendMedia(file, type, name);
    }
  }

  async function refreshConversation() {
    const id = state.activeId;
    if (!id) return;
    try {
      const detail = await NOC.api(`/api/whatsapp/conversations/${id}`);
      if (state.activeId !== id) return;
      // bolhas provisórias ainda subindo (ou que falharam) continuam na tela
      const local = state.messages.filter(m => String(m.id).startsWith("tmp-") && m.status !== "sent");
      state.messages = [...(detail.messages || []), ...local];
      renderMessages();
    } catch { /* o polling tenta de novo */ }
  }

  /* O botão redondo segue o WhatsApp: sem texto ele grava áudio; com texto
     ou com uma gravação em andamento, ele envia. */
  function syncSendMode() {
    const btn = $("#sendBtn");
    const mic = !state.recording && !$("#msgInput").value.trim() && !!window.NOCGravador?.suportado();
    btn.dataset.mode = mic ? "mic" : "send";
    btn.innerHTML = mic ? SVG.mic : SVG.send;
    const label = mic ? "Gravar áudio" : state.recording ? "Enviar áudio" : "Enviar mensagem";
    btn.setAttribute("aria-label", label);
    btn.title = mic || state.recording ? label : "Enviar (Enter)";
  }

  const fmtRec = ms => { const sec = Math.floor(ms / 1000); return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")}`; };

  async function startRecording() {
    if (state.recording || state.startingRec || !state.activeId) return;
    closePopovers();
    state.startingRec = true;
    let rec;
    try {
      rec = await NOCGravador.iniciar();
    } catch (err) {
      const denied = err?.name === "NotAllowedError" || err?.name === "SecurityError";
      toast("Não foi possível gravar", { text: denied ? "O microfone está bloqueado para este site. Clique no cadeado ao lado do endereço, em Microfone escolha Permitir e recarregue a página." : err?.name === "NotFoundError" ? "Nenhum microfone encontrado." : String(err?.message || err), type: "danger" });
      return;
    } finally {
      state.startingRec = false;
    }
    state.recording = { rec, convId: state.activeId, tick: setInterval(() => { $("#recTime").textContent = fmtRec(Date.now() - rec.inicio); }, 250) };
    $("#recTime").textContent = "0:00";
    $(".wa-composer-box").hidden = true;
    $("#recorder").hidden = false;
    $("#composer").classList.add("is-recording");
    syncSendMode();
  }

  function endRecordingUi() {
    const r = state.recording;
    if (r) clearInterval(r.tick);
    state.recording = null;
    $(".wa-composer-box").hidden = false;
    $("#recorder").hidden = true;
    $("#composer").classList.remove("is-recording");
    syncSendMode();
  }

  function cancelRecording() {
    const r = state.recording;
    if (!r) return;
    r.rec.cancelar();
    endRecordingUi();
  }

  async function finishRecording() {
    const r = state.recording;
    if (!r) return;
    const elapsed = Date.now() - r.rec.inicio;
    endRecordingUi();
    if (elapsed < 800) { r.rec.cancelar(); toast("Áudio muito curto", { text: "Grave por pelo menos um segundo." }); return; }
    const { blob, tipo } = await r.rec.parar();
    if (r.convId !== state.activeId) return;
    const ext = { "audio/ogg": "ogg", "audio/mp4": "m4a", "audio/webm": "weba" }[tipo] || "ogg";
    await sendMedia(blob, tipo, `audio-${stamp()}.${ext}`);
  }

  function primaryAction() {
    if (state.recording) return finishRecording();
    if ($("#sendBtn").dataset.mode === "mic") return startRecording();
    return sendMessage();
  }

  async function afterTake(id) {
    toast("Atendimento assumido", { type: "ok" });
    setStatusTab("open");
    await load();
    await loadConversation(id);
  }

  async function takeConversation(conv) {
    if (conv.status === "routing") {
      const options = state.data?.sectors || [];
      if (options.length > 1) {
        modal({
          labelledBy: "waTakeTitle",
          html: `
            <div class="modal-head"><div><span class="kicker">Triagem</span><h2 id="waTakeTitle">Assumir atendimento</h2></div><button class="btn btn-ghost btn-icon" data-close type="button">${icon("close")}</button></div>
            <div class="modal-body"><div class="field"><label for="takeSector">Setor do atendimento</label><select class="select" id="takeSector">${options.map(s => `<option value="${s.id}">${esc(s.name)}</option>`).join("")}</select><span class="field-hint">O atendimento entra no setor escolhido e fica com você.</span></div></div>
            <div class="modal-foot"><span></span><span class="row"><button class="btn" data-close type="button">Cancelar</button><button class="btn btn-primary" data-take type="button">Assumir</button></span></div>`,
          onMount: (host, close) => {
            $("[data-take]", host).onclick = async () => {
              try {
                await NOC.api(`/api/whatsapp/conversations/${conv.id}/take`, { method: "POST", body: JSON.stringify({ sector_id: Number($("#takeSector", host).value) }) });
                close();
                await afterTake(conv.id);
              } catch (err) { toast("Não foi possível assumir", { text: err.message, type: "danger" }); }
            };
          }
        });
        return;
      }
      try {
        await NOC.api(`/api/whatsapp/conversations/${conv.id}/take`, { method: "POST", body: JSON.stringify({ sector_id: options[0]?.id }) });
        await afterTake(conv.id);
      } catch (err) { toast("Não foi possível assumir", { text: err.message, type: "danger" }); }
      return;
    }
    try {
      await NOC.api(`/api/whatsapp/conversations/${conv.id}/take`, { method: "POST" });
      await afterTake(conv.id);
    } catch (err) { toast("Não foi possível assumir", { text: err.message, type: "danger" }); }
  }

  function assignConversation(conv) {
    const sectors = state.data?.sectors || [];
    const presence = state.data?.presence || [];
    modal({
      wide: true,
      labelledBy: "waAssignTitle",
      html: `
        <div class="modal-head"><div><span class="kicker">Protocolo #${conv.id}</span><h2 id="waAssignTitle">Transferir atendimento</h2><p class="dim">${esc(nameOf(conv))}</p></div><button class="btn btn-ghost btn-icon" data-close type="button">${icon("close")}</button></div>
        <div class="modal-body"><div class="row wrap">
          <div class="field" style="flex:1;min-width:220px"><label for="assignSector">Setor</label><select class="select" id="assignSector">${sectors.map(s => `<option value="${s.id}" ${String(s.id) === String(conv.sector_id || "") ? "selected" : ""}>${esc(s.name)}</option>`).join("")}</select></div>
          <div class="field" style="flex:1;min-width:220px"><label for="assignUser">Atendente</label><select class="select" id="assignUser"><option value="">Sem atendente (fila do setor)</option></select></div>
        </div><span class="field-error" id="assignError" hidden></span></div>
        <div class="modal-foot"><span></span><span class="row"><button class="btn" data-close type="button">Cancelar</button><button class="btn btn-primary" data-save type="button">Transferir</button></span></div>`,
      onMount: (host, close) => {
        const sector = $("#assignSector", host), user = $("#assignUser", host);
        const choices = () => {
          const sid = Number(sector.value);
          const members = [...new Map(presence.filter(p => p.sectors.includes(sid)).map(p => [p.user_id, p])).values()];
          const status = p => p.busy ? " — em atendimento" : p.available === false ? " — pausado" : " — disponível";
          user.innerHTML = '<option value="">Sem atendente (fila do setor)</option>' + members.map(m => `<option value="${m.user_id}" ${String(m.user_id) === String(conv.assigned_user_id || "") ? "selected" : ""}>${esc(m.display_name + status(m))}</option>`).join("");
        };
        choices();
        sector.onchange = choices;
        $("[data-save]", host).onclick = async () => {
          const payload = { sector_id: Number(sector.value) };
          if (user.value) payload.user_id = Number(user.value);
          try {
            await NOC.api(`/api/whatsapp/conversations/${conv.id}/assign`, { method: "POST", body: JSON.stringify(payload) });
            close(); toast("Atendimento transferido", { type: "ok" }); await load();
            if (state.activeId === String(conv.id)) await loadConversation(conv.id);
          } catch (err) {
            const error = $("#assignError", host);
            error.hidden = false; error.textContent = err.message;
          }
        };
      }
    });
  }

  async function closeConversation(conv) {
    askConfirm({
      title: "Encerrar este atendimento?",
      text: `O atendimento com ${nameOf(conv)} (protocolo #${conv.id}) será encerrado e o cliente recebe a mensagem de encerramento.`,
      confirmLabel: "Encerrar",
      danger: true,
      onConfirm: async () => {
        try {
          await NOC.api(`/api/whatsapp/conversations/${conv.id}/close`, { method: "POST" });
          toast("Atendimento encerrado", { type: "ok" });
          closePane(); await load();
        } catch (err) { toast("Não foi possível encerrar", { text: err.message, type: "danger" }); }
      }
    });
  }

  async function togglePresence() {
    const self = selfPresence();
    const next = !(self?.available ?? true);
    try {
      await NOC.api("/api/whatsapp/presence", { method: "POST", body: JSON.stringify({ available: next }) });
      toast(next ? "Você está disponível" : "Você pausou o atendimento", { type: "ok" });
      await load();
    } catch (err) { toast("Não foi possível atualizar", { text: err.message, type: "danger" }); }
  }

  function newChat() {
    const sectors = state.data?.sectors || [];
    modal({
      wide: true,
      labelledBy: "waNewTitle",
      html: `
        <div class="modal-head"><div><span class="kicker">Novo atendimento</span><h2 id="waNewTitle">Abrir atendimento pelo WhatsApp</h2></div><button class="btn btn-ghost btn-icon" data-close type="button">${icon("close")}</button></div>
        <div class="modal-body"><div class="crm-form-grid">
          <div class="field span-2"><label for="newPhone">Número do WhatsApp</label><input class="input" id="newPhone" inputmode="tel" placeholder="5511999999999 (DDI + DDD + número)"></div>
          <div class="field"><label for="newName">Nome do contato</label><input class="input" id="newName" maxlength="200"></div>
          <div class="field"><label for="newSector">Setor</label><select class="select" id="newSector">${sectors.map(s => `<option value="${s.id}">${esc(s.name)}</option>`).join("")}</select></div>
          <div class="field span-2"><label for="newBody">Primeira mensagem</label><textarea class="textarea" id="newBody" rows="3">Olá! Aqui é a UPDOWN Telecom.</textarea></div>
          <span class="field-error span-2" id="newError" hidden></span>
        </div></div>
        <div class="modal-foot"><span></span><span class="row"><button class="btn" data-close type="button">Cancelar</button><button class="btn btn-primary" data-save type="button">Abrir atendimento</button></span></div>`,
      onMount: (host, close) => {
        $("[data-save]", host).onclick = async () => {
          const error = $("#newError", host);
          const payload = {
            phone: $("#newPhone", host).value.trim(),
            customer_name: $("#newName", host).value.trim(),
            sector_id: Number($("#newSector", host).value),
            body: $("#newBody", host).value.trim()
          };
          if (!payload.phone || !payload.body) { error.hidden = false; error.textContent = "Informe o número e a primeira mensagem."; return; }
          try {
            const saved = await NOC.api("/api/whatsapp/conversations", { method: "POST", body: JSON.stringify(payload) });
            close(); toast("Atendimento aberto", { type: "ok" });
            setStatusTab("open");
            await load();
            openConversation(saved.id);
          } catch (err) { error.hidden = false; error.textContent = err.message; }
        };
      }
    });
  }

  function settings() {
    const data = state.data;
    if (!data?.settings) return;
    const s = data.settings;
    const options = enabledSectors();
    const qrRow = (q = { shortcut: "", text: "" }) => `<div class="wa-qr-row">
      <input class="input" data-qr-shortcut maxlength="30" placeholder="atalho" value="${esc(q.shortcut)}" aria-label="Atalho">
      <textarea class="textarea" data-qr-text rows="1" maxlength="1000" placeholder="Texto da mensagem" aria-label="Texto">${esc(q.text)}</textarea>
      <button class="btn btn-ghost btn-icon btn-sm" type="button" data-qr-remove aria-label="Remover">${icon("trash")}</button>
    </div>`;
    modal({
      wide: true,
      labelledBy: "waSettingsTitle",
      html: `
        <div class="modal-head"><div><span class="kicker">Agente virtual e atendimento</span><h2 id="waSettingsTitle">Configurar o chat</h2></div><button class="btn btn-ghost btn-icon" data-close type="button">${icon("close")}</button></div>
        <div class="modal-body"><div class="crm-form-grid">
          <div class="field span-2"><label for="setGreeting">Saudação do agente virtual</label><textarea class="textarea" id="setGreeting" rows="3">${esc(s.greeting || "")}</textarea></div>
          <div class="field span-2"><label>Setores disponíveis no menu</label>
            <div class="wa-check-grid">${(state.data?.sectors || []).map(x => `<label class="wa-check"><input type="checkbox" value="${esc(x.code)}" ${options.some(o => o.code === x.code) ? "checked" : ""}>${esc(x.name)}</label>`).join("")}</div>
          </div>
          <div class="field span-2"><label for="setRoutingDone">Confirmação de roteamento</label><textarea class="textarea" id="setRoutingDone" rows="2">${esc(s.routingDone || "")}</textarea><span class="field-hint">Use {setor} para inserir o nome do setor escolhido.</span></div>
          <div class="field span-2"><label for="setRoutingError">Resposta quando a opção não é reconhecida</label><textarea class="textarea" id="setRoutingError" rows="2">${esc(s.routingError || "")}</textarea></div>
          <div class="field span-2"><label for="setClosed">Mensagem de atendimento encerrado</label><textarea class="textarea" id="setClosed" rows="2">${esc(s.closedMessage || "")}</textarea></div>
          <div class="field span-2"><label>Mensagens rápidas</label>
            <div class="wa-qr-list" id="qrList">${(s.quickReplies || []).map(qrRow).join("")}</div>
            <div class="row" style="justify-content:space-between;margin-top:var(--s-2)"><span class="field-hint">No chat, digite / e o atalho. {cliente} e {atendente} viram o primeiro nome de cada um.</span><button class="btn btn-sm" type="button" id="qrAdd">${icon("plus")} Adicionar</button></div>
          </div>
          <span class="field-error span-2" id="setError" hidden></span>
        </div></div>
        <div class="modal-foot"><span></span><span class="row"><button class="btn" data-close type="button">Cancelar</button><button class="btn btn-primary" data-save type="button">Salvar</button></span></div>`,
      onMount: (host, close) => {
        const list = $("#qrList", host);
        const bindRemove = () => $$("[data-qr-remove]", list).forEach(b => b.onclick = () => b.closest(".wa-qr-row").remove());
        bindRemove();
        $("#qrAdd", host).onclick = () => {
          list.insertAdjacentHTML("beforeend", qrRow());
          bindRemove();
          $(".wa-qr-row:last-child [data-qr-shortcut]", list).focus();
        };
        $("[data-save]", host).onclick = async () => {
          const routedSectors = $$(".wa-check-grid input[type=checkbox]:checked", host).map(cb => cb.value);
          const quick = $$(".wa-qr-row", list).map(r => ({
            shortcut: $("[data-qr-shortcut]", r).value.trim(),
            text: $("[data-qr-text]", r).value.trim()
          })).filter(q => q.shortcut || q.text);
          const payload = {
            greeting: $("#setGreeting", host).value.trim(),
            routingDone: $("#setRoutingDone", host).value.trim(),
            routingError: $("#setRoutingError", host).value.trim(),
            closedMessage: $("#setClosed", host).value.trim(),
            routedSectors,
            quickReplies: quick
          };
          const error = $("#setError", host);
          if (quick.some(q => !q.shortcut || !q.text)) { error.hidden = false; error.textContent = "Cada mensagem rápida precisa de atalho e texto."; return; }
          try {
            await NOC.api("/api/whatsapp/settings", { method: "PUT", body: JSON.stringify(payload) });
            close(); toast("Configurações salvas", { type: "ok" }); await load();
          } catch (err) {
            error.hidden = false; error.textContent = err.message;
          }
        };
      }
    });
  }

  function setStatusTab(status) {
    state.status = status;
    $$("[data-status]").forEach(b => b.setAttribute("aria-selected", String(b.dataset.status === status)));
  }

  /* ---------- polling ---------- */

  function startPolling() {
    if (state.timer) clearInterval(state.timer);
    state.timer = setInterval(async () => {
      await load(true);
      if (state.activeId && state.conversation && state.conversation.status !== "closed") {
        try {
          const detail = await NOC.api(`/api/whatsapp/conversations/${state.activeId}`);
          if (String(detail.conversation?.id) !== state.activeId) return;
          const clienteChanged = (detail.cliente?.client_id || null) !== (state.cliente?.client_id || null);
          const local = state.messages.filter(m => String(m.id).startsWith("tmp-") && m.status !== "sent");
          state.messages = [...(detail.messages || []), ...local];
          state.cliente = detail.cliente || null;
          // O diagnóstico chega uns 15 s depois de o chamado abrir no app: o painel
          // se atualiza sozinho, sem o atendente reabrir a conversa.
          const diagChanged = JSON.stringify(detail.diagnostico || null) !== JSON.stringify(state.diagnostico);
          state.diagnostico = detail.diagnostico || null;
          updateHead(detail.conversation);
          if (clienteChanged || diagChanged) renderSide();
          const sig = state.messages.map(m => `${m.id}:${m.status}`).join(",");
          if (sig !== state.messagesSig) renderMessages();
        } catch { /* mantém o estado atual */ }
      }
    }, 5000);
  }

  /* ---------- boot ---------- */

  async function boot() {
    UI.mountShell();
    $("#newChatBtn").innerHTML = icon("plus") + " Novo";
    $("#settingsBtn").innerHTML = icon("edit");
    $("#refreshBtn").innerHTML = icon("refresh");
    $("#searchIcon").innerHTML = icon("search");
    $("#chatEmptyIcon").innerHTML = SVG.whatsapp;
    $("#emojiBtn").innerHTML = SVG.smile;
    $("#attachBtn").innerHTML = SVG.clip;
    $("#recCancel").innerHTML = SVG.trash;
    syncSendMode();
    $("#quickBtn").innerHTML = '<span class="wa-slash">/</span>';
    $("#backBtn").innerHTML = icon("chevronLeft");
    $("#infoBtn").innerHTML = SVG.panel;
    $("#sideCloseBtn").innerHTML = icon("close");
    $("#emojiMenu").innerHTML = EMOJIS.map(e => `<button type="button" data-emoji="${e}" aria-label="${e}">${e}</button>`).join("");

    let savedSide = "open";
    try { savedSide = localStorage.getItem(SIDE_KEY) || "open"; } catch { /* sem armazenamento */ }
    $("#waDesk").classList.toggle("side-collapsed", savedSide === "closed");
    syncSideButton();
    narrow.addEventListener("change", () => {
      $("#waDesk").classList.remove("side-open");
      $("#sideScrim").hidden = true;
      syncSideButton();
    });

    $("#refreshBtn").onclick = () => load();
    $("#newChatBtn").onclick = () => newChat();
    $("#settingsBtn").onclick = () => settings();
    $("#presenceToggle").onclick = () => togglePresence();
    $("#sectorFilter").onchange = e => { state.sector = e.target.value; renderConvList(); renderPresence(); };
    $("#mineOnly").onclick = e => {
      state.mineOnly = !state.mineOnly;
      e.currentTarget.setAttribute("aria-pressed", String(state.mineOnly));
      renderConvList();
    };
    let searchTimer = null;
    $("#convSearch").addEventListener("input", e => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => { state.search = e.target.value; renderConvList(); }, 120);
    });
    $$("[data-status]").forEach(btn => btn.onclick = () => { setStatusTab(btn.dataset.status); renderConvList(); });
    $$("[data-side]").forEach(btn => btn.onclick = () => setSideTab(btn.dataset.side));
    $("#takeBtn").onclick = () => state.conversation && takeConversation(state.conversation);
    $("#assignBtn").onclick = () => state.conversation && assignConversation(state.conversation);
    $("#closeBtn").onclick = () => state.conversation && closeConversation(state.conversation);
    $("#backBtn").onclick = () => closePane();
    $("#infoBtn").onclick = () => toggleSide();
    $("#sideCloseBtn").onclick = () => toggleSide(false);
    $("#sideScrim").onclick = () => toggleSide(false);

    $("#composer").onsubmit = e => { e.preventDefault(); primaryAction(); };
    $("#attachBtn").onclick = () => { closePopovers(); $("#fileInput").click(); };
    $("#fileInput").onchange = e => {
      const files = [...e.target.files];
      e.target.value = "";
      sendFiles(files);
    };
    $("#recCancel").onclick = () => cancelRecording();
    // Arrastar arquivo para a conversa ou colar um print no campo também anexa.
    const thread = $("#chatThread");
    thread.addEventListener("dragover", e => {
      if (![...(e.dataTransfer?.types || [])].includes("Files") || $("#composer").dataset.ready !== "1") return;
      e.preventDefault();
      thread.classList.add("is-dropping");
    });
    thread.addEventListener("dragleave", e => { if (!thread.contains(e.relatedTarget)) thread.classList.remove("is-dropping"); });
    thread.addEventListener("drop", e => {
      thread.classList.remove("is-dropping");
      if (!e.dataTransfer?.files?.length || $("#composer").dataset.ready !== "1") return;
      e.preventDefault();
      sendFiles([...e.dataTransfer.files]);
    });
    $("#msgInput").addEventListener("paste", e => {
      const files = [...(e.clipboardData?.files || [])];
      if (!files.length) return;
      e.preventDefault();
      sendFiles(files);
    });
    $("#emojiBtn").onclick = () => {
      const menu = $("#emojiMenu");
      const open = menu.hidden;
      closePopovers();
      menu.hidden = !open;
      $("#emojiBtn").setAttribute("aria-expanded", String(open));
    };
    $("#emojiMenu").onclick = e => {
      const btn = e.target.closest("[data-emoji]");
      if (btn) insertAtCaret(btn.dataset.emoji);
    };
    $("#quickBtn").onclick = () => {
      if (!$("#quickMenu").hidden) { closePopovers(); return; }
      state.quickIndex = 0;
      openQuick();
      $("#msgInput").focus();
    };

    const input = $("#msgInput");
    input.addEventListener("keydown", e => {
      const quickOpen = !$("#quickMenu").hidden;
      if (quickOpen && ["ArrowDown", "ArrowUp"].includes(e.key)) {
        e.preventDefault();
        const total = quickMatches().length;
        if (total) state.quickIndex = (state.quickIndex + (e.key === "ArrowDown" ? 1 : -1) + total) % total;
        renderQuick();
        return;
      }
      if (quickOpen && (e.key === "Enter" || e.key === "Tab") && !e.shiftKey) {
        const items = quickMatches();
        if (items.length) { e.preventDefault(); applyQuick(items[state.quickIndex]); return; }
      }
      if (e.key === "Escape" && (quickOpen || !$("#emojiMenu").hidden)) { e.preventDefault(); closePopovers(); return; }
      if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendMessage(); }
    });
    input.addEventListener("input", () => {
      autoGrow();
      syncSendMode();
      if (/^\/[^\s]*$/.test(input.value)) { state.quickIndex = 0; openQuick(); }
      else if (!$("#quickMenu").hidden && input.value && !input.value.startsWith("/")) closePopovers();
    });
    document.addEventListener("click", e => {
      if (!e.target.closest(".wa-composer")) closePopovers();
    });

    setSideTab("client");
    renderSide();

    try {
      await NOC.loadAccess();
      NOC.applyActions();
      await load();
      // quem já tem atendimento assumido cai direto neles; senão, na fila
      const convs = state.data?.conversations || [];
      if (!convs.some(c => bucketOf(c) === "open" && inScope(c)) && convs.some(c => bucketOf(c) === "queue")) {
        setStatusTab("queue");
        renderConvList();
      }
      startPolling();
    } catch (err) {
      NOC.errorState($("#convList"), err, () => boot());
    }
  }

  boot();
})();
