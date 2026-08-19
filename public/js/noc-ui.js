/* ============================================================
   UPDOWN NOC — runtime de interface (aplicação real)
   Shell, tema, atalhos, paleta de comandos, avisos e diálogos.
   Convive com auth-guard.js: a sessão e o controle de telas
   continuam vindo de /api/auth/me e /api/access.
   ============================================================ */
window.UI = (() => {
  "use strict";

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
  const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" }[c]));
  const num = (v, d = 0) => Number(v ?? 0).toLocaleString("pt-BR", { minimumFractionDigits: d, maximumFractionDigits: d });
  const pct = (a, b) => (b ? Math.round((a / b) * 100) : 0);

  /* ---------------- ícones ---------------- */
  const PATHS = {
    home: '<path d="M4 11.2 12 4.5l8 6.7"/><path d="M6.3 10.2V19a1 1 0 0 0 1 1h9.4a1 1 0 0 0 1-1v-8.8"/><path d="M10 20v-5h4v5"/>',
    topology: '<circle cx="5" cy="12" r="2.4"/><circle cx="19" cy="6" r="2.4"/><circle cx="19" cy="18" r="2.4"/><path d="M7.2 11l9.5-4.2M7.2 13l9.5 4.2"/>',
    pops: '<path d="M12 21s7-5.7 7-11a7 7 0 1 0-14 0c0 5.3 7 11 7 11z"/><circle cx="12" cy="10" r="2.5"/>',
    dashboard: '<path d="M3 12h4l2.5 7 4-15 2.5 8h5"/>',
    platform: '<path d="M12 3l8 3.5v5c0 5-3.4 8.6-8 9.5-4.6-.9-8-4.5-8-9.5v-5z"/><path d="M9.2 12.2l2 2 3.6-3.8"/>',
    finance: '<circle cx="12" cy="12" r="8.5"/><path d="M12 6.5v11M15.2 8.5h-4.8a2.2 2.2 0 0 0 0 4.4h3.2a2.2 2.2 0 0 1 0 4.4H8.8"/>',
    guide: '<rect x="3.5" y="4" width="17" height="16" rx="2.5"/><path d="M9 4v16M13 9h4M13 13h4"/>',
    search: '<circle cx="11" cy="11" r="6.5"/><path d="M20 20l-3.6-3.6"/>',
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
    moon: '<path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5z"/>',
    bell: '<path d="M18 9a6 6 0 1 0-12 0c0 6-2 7-2 7h16s-2-1-2-7z"/><path d="M13.7 20a2 2 0 0 1-3.4 0"/>',
    calendar: '<rect x="3.5" y="5" width="17" height="16" rx="2.5"/><path d="M8 3v4M16 3v4M3.5 10h17M8 14h.01M12 14h.01M16 14h.01M8 18h.01M12 18h.01"/>',
    logout: '<path d="M10 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h4"/><path d="M15 8l4 4-4 4M19 12H9"/>',
    close: '<path d="M6 6l12 12M18 6L6 18"/>',
    chevronLeft: '<path d="M14.5 5.5L8 12l6.5 6.5"/>',
    chevronRight: '<path d="M9.5 5.5L16 12l-6.5 6.5"/>',
    chevronDown: '<path d="M6 9.5l6 6 6-6"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    check: '<path d="M5 12.5l4.5 4.5L19 7"/>',
    circle: '<circle cx="12" cy="12" r="7.5"/>',
    alert: '<path d="M12 3.8L21 19H3z"/><path d="M12 10v4M12 17h.01"/>',
    info: '<circle cx="12" cy="12" r="8.5"/><path d="M12 11v5M12 8h.01"/>',
    zoomIn: '<circle cx="11" cy="11" r="6.5"/><path d="M20 20l-3.6-3.6M11 8.5v5M8.5 11h5"/>',
    zoomOut: '<circle cx="11" cy="11" r="6.5"/><path d="M20 20l-3.6-3.6M8.5 11h5"/>',
    fit: '<path d="M4 9V5.5A1.5 1.5 0 0 1 5.5 4H9M15 4h3.5A1.5 1.5 0 0 1 20 5.5V9M20 15v3.5a1.5 1.5 0 0 1-1.5 1.5H15M9 20H5.5A1.5 1.5 0 0 1 4 18.5V15"/>',
    eye: '<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="2.8"/>',
    eyeOff: '<path d="M10 5.9A8 8 0 0 1 12 5.7c6 0 9.5 6.3 9.5 6.3a17 17 0 0 1-3.3 4M6.4 7.5A16.6 16.6 0 0 0 2.5 12S6 18.3 12 18.3a8.6 8.6 0 0 0 3.9-.9"/><path d="M4 4l16 16"/>',
    lock: '<rect x="4.5" y="10.5" width="15" height="9.5" rx="2"/><path d="M8 10.5V8a4 4 0 0 1 8 0v2.5"/>',
    user: '<circle cx="12" cy="8.5" r="3.6"/><path d="M4.8 20a7.2 7.2 0 0 1 14.4 0"/>',
    users: '<circle cx="9.5" cy="8.5" r="3.2"/><path d="M3.5 19.5a6 6 0 0 1 12 0"/><path d="M16.5 6.2a3.2 3.2 0 0 1 0 6.1M17.5 14a6 6 0 0 1 3.5 5.5"/>',
    filter: '<path d="M4 5.5h16l-6.2 7.3v5.4l-3.6 2v-7.4z"/>',
    refresh: '<path d="M20 11a8 8 0 1 0-.7 4.4"/><path d="M20 5v6h-6"/>',
    download: '<path d="M12 4v11M7.5 10.5L12 15l4.5-4.5"/><path d="M5 19h14"/>',
    keyboard: '<rect x="2.5" y="6" width="19" height="12" rx="2"/><path d="M6.5 10h.01M10 10h.01M13.5 10h.01M17 10h.01M8 14h8"/>',
    tv: '<rect x="2.5" y="4.5" width="19" height="13" rx="2"/><path d="M8 21h8"/>',
    edit: '<path d="M4 20h4L19 9a2.1 2.1 0 0 0-3-3L5 17z"/>',
    trash: '<path d="M4.5 7h15M9.5 7V5.5A1.5 1.5 0 0 1 11 4h2a1.5 1.5 0 0 1 1.5 1.5V7"/><path d="M6.5 7l.9 12.1A1.5 1.5 0 0 0 8.9 20.5h6.2a1.5 1.5 0 0 0 1.5-1.4L17.5 7"/>',
    clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
    port: '<rect x="3.5" y="7" width="17" height="10" rx="2"/><path d="M8 7V5M16 7V5M8 17v2M16 17v2"/>',
    link: '<path d="M10 13.5a4 4 0 0 0 5.7 0l2.6-2.6a4 4 0 1 0-5.7-5.7L11.5 6.5"/><path d="M14 10.5a4 4 0 0 0-5.7 0l-2.6 2.6a4 4 0 1 0 5.7 5.7l1.1-1.1"/>',
    arrowRight: '<path d="M5 12h14M13.5 6.5L19 12l-5.5 5.5"/>',
    shield: '<path d="M12 3l8 3.5v5c0 5-3.4 8.6-8 9.5-4.6-.9-8-4.5-8-9.5v-5z"/>',
    sort: '<path d="M12 5v14M7.5 15L12 19.5 16.5 15"/>',
    menu: '<path d="M4 7h16M4 12h16M4 17h16"/>',
    trafego: '<path d="M7 20V10M7 10L4 13M7 10l3 3"/><path d="M17 4v10M17 14l3-3M17 14l-3-3"/>',
  };
  const icon = (name, cls = "icon") =>
    `<svg class="${cls}" viewBox="0 0 24 24" aria-hidden="true" focusable="false">${PATHS[name] || PATHS.circle}</svg>`;

  /* ---------------- tema ---------------- */
  const THEME_KEY = "updown.theme";
  // Mesma cor de --bg em tokens.css para cada tema. Repetida aqui porque o
  // navegador lê a cor da barra do sistema (Android, PWA instalada) direto do
  // <meta>, antes mesmo de qualquer CSS carregar — não dá para apontar para
  // uma custom property.
  const THEME_COLOR = { dark: "#050d17", light: "#eef3f9" };
  function applyTheme(mode) {
    document.documentElement.dataset.theme = mode;
    try { localStorage.setItem(THEME_KEY, mode); } catch (e) { /* modo privado */ }
    $$("[data-theme-toggle]").forEach((b) => {
      b.innerHTML = icon(mode === "dark" ? "sun" : "moon");
      b.setAttribute("aria-label", mode === "dark" ? "Usar tema claro" : "Usar tema escuro");
      b.title = mode === "dark" ? "Tema claro" : "Tema escuro";
    });
    let meta = $('meta[name="theme-color"]');
    if (!meta) {
      meta = document.createElement("meta");
      meta.name = "theme-color";
      document.head.appendChild(meta);
    }
    meta.content = THEME_COLOR[mode] || THEME_COLOR.dark;
  }
  function initTheme() {
    let saved = null;
    try { saved = localStorage.getItem(THEME_KEY); } catch (e) { /* ignore */ }
    applyTheme(saved || (matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark"));
  }
  const toggleTheme = () => applyTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark");
  initTheme();

  /* ---------------- sessão (vem da API via auth-guard) ---------------- */
  const session = () => {
    const u = window.UPDOWN_AUTH || {};
    return { name: u.display_name || u.username || "Usuário", username: u.username || "", role: u.role || "" };
  };
  const initials = (n) => String(n || "?").trim().split(/\s+/).slice(0, 2).map((p) => p[0]).join("").toUpperCase();

  /* ---------------- avisos ---------------- */
  /* O host dos avisos é criado junto com o shell, e não no primeiro aviso.
     Região `aria-live` inserida no DOM ao mesmo tempo que o conteúdo dela
     costuma não ser anunciada: o leitor de tela precisa já estar observando o
     elemento quando o texto chega. `role="status"` dá a mesma garantia em
     leitores que ignoram `aria-live` isolado. */
  function toastHost() {
    let host = $(".toasts");
    if (!host) {
      host = document.createElement("div");
      host.className = "toasts";
      host.setAttribute("role", "status");
      host.setAttribute("aria-live", "polite");
      host.setAttribute("aria-atomic", "false");
      document.body.appendChild(host);
    }
    return host;
  }
  function toast(title, opts = {}) {
    const { text = "", type = "info", action = null, timeout = 4600 } = opts;
    const el = document.createElement("div");
    el.className = `toast toast-${type}`;
    el.innerHTML =
      `${icon(type === "ok" ? "check" : type === "danger" || type === "warn" ? "alert" : "info")}
       <div class="grow"><b>${esc(title)}</b>${text ? `<p>${esc(text)}</p>` : ""}</div>
       ${action ? `<button class="btn btn-sm" type="button">${esc(action.label)}</button>` : ""}`;
    const close = () => { el.classList.add("is-out"); setTimeout(() => el.remove(), 220); };
    if (action) $("button", el).onclick = () => { action.run(); close(); };
    toastHost().appendChild(el);
    if (timeout) setTimeout(close, timeout);
    return close;
  }

  /* ---------------- foco preso ---------------- */
  const FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';
  function trapFocus(container, onClose) {
    const previous = document.activeElement;
    (($(FOCUSABLE, container)) || container).focus({ preventScroll: true });
    function onKey(e) {
      if (e.key === "Escape") { e.preventDefault(); onClose(); return; }
      if (e.key !== "Tab") return;
      const items = $$(FOCUSABLE, container).filter((el) => el.offsetParent !== null);
      if (!items.length) return;
      const first = items[0], last = items[items.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
    container.addEventListener("keydown", onKey);
    return () => {
      container.removeEventListener("keydown", onKey);
      if (previous && previous.focus) previous.focus({ preventScroll: true });
    };
  }

  /* ---------------- camadas ---------------- */
  let openLayers = [];
  function layer({ html, className = "modal", labelledBy = null, onMount = null, dismissible = true }) {
    const overlay = document.createElement("div");
    overlay.className = "overlay";
    const host = document.createElement("div");
    host.className = className;
    host.innerHTML = html;
    const card = host.firstElementChild;
    card.setAttribute("role", "dialog");
    card.setAttribute("aria-modal", "true");
    card.tabIndex = -1;
    if (labelledBy) card.setAttribute("aria-labelledby", labelledBy);

    document.body.append(overlay, host);
    document.body.style.overflow = "hidden";

    const close = () => {
      release();
      overlay.remove();
      host.remove();
      openLayers = openLayers.filter((l) => l !== close);
      if (!openLayers.length) document.body.style.overflow = "";
    };
    const release = trapFocus(card, () => dismissible && close());
    if (dismissible) overlay.onclick = close;
    $$("[data-close]", host).forEach((b) => (b.onclick = close));
    openLayers.push(close);
    if (onMount) onMount(host, close);
    return { host, close };
  }
  const drawer = (opts) => layer({ ...opts, className: "drawer-host", html: `<aside class="drawer">${opts.html}</aside>` });
  const modal = (opts) => layer({ ...opts, html: `<div class="modal-card ${opts.wide ? "is-wide" : ""}">${opts.html}</div>` });

  function confirm({ title, text, confirmLabel = "Confirmar", danger = false, onConfirm }) {
    return modal({
      labelledBy: "confirmTitle",
      html: `
        <div class="modal-head">
          <div><h2 id="confirmTitle">${esc(title)}</h2><p class="muted" style="margin-top:6px;font-size:var(--fs-13)">${esc(text)}</p></div>
          <button class="btn btn-ghost btn-icon" data-close type="button" aria-label="Fechar">${icon("close")}</button>
        </div>
        <div class="modal-foot">
          <span class="dim" style="font-size:var(--fs-11)">Esta ação é registrada na auditoria.</span>
          <span class="row">
            <button class="btn" data-close type="button">Cancelar</button>
            <button class="btn ${danger ? "btn-danger" : "btn-primary"}" data-confirm type="button">${esc(confirmLabel)}</button>
          </span>
        </div>`,
      onMount: (host, close) => {
        $("[data-confirm]", host).onclick = () => { close(); onConfirm && onConfirm(); };
      },
    });
  }

  /* ---------------- navegação da aplicação ---------------- */
  /* O menu é montado a partir das telas liberadas para o perfil (/api/access).
     Esta lista é só o desenho inicial, usada enquanto o acesso não chega. */
  const NAV_PADRAO = [
    { code: "home", label: "Home", href: "/", icon: "home", sector: "noc", desc: "Clientes, tráfego da rede e alertas não vistos" },
    { code: "crm", label: "Central CRM", href: "/crm.html", icon: "users", sector: "comercial", desc: "Leads, clientes e solicitações separados por setor" },
    { code: "network", label: "BACKBONE", href: "/topologia.html", icon: "topology", sector: "noc", desc: "Mapa por localidade, equipamentos e portas" },
    { code: "gpon", label: "GPON", href: "/gpon.html", icon: "topology", sector: "noc", desc: "Mapa da topologia da rede GPON" },
    { code: "gpon-mapa", label: "Mapas GPON", href: "/gpon-mapa.html", icon: "pops", sector: "noc", desc: "Clientes, caixas, POPs, drops e caminho ponta a ponta" },
    { code: "isp", label: "Topologia ISP", href: "/isp.html", icon: "topology", sector: "noc", desc: "Mapa por cliente ISP, equipamentos e portas" },
    { code: "isp-mapa", label: "Mapa de fibra ISP", href: "/isp-mapa.html", icon: "noc", sector: "noc", desc: "Clientes ISP e caminhos de fibra no mapa" },
    { code: "isp-cadastro", label: "Cadastro de POPs ISP", href: "/isp-cadastro.html", icon: "users", sector: "noc", desc: "Cadastrar, editar e excluir ISPs e equipamentos" },
    { code: "pops", label: "Cadastro de POPs Backbone", href: "/pops.html", icon: "pops", sector: "noc", desc: "Inventário por POP e rotas ópticas" },
    { code: "dashboard", label: "Dashboard NOC", href: "/dashboard.html", icon: "dashboard", sector: "noc", desc: "Painel operacional para TV" },
    { code: "platform", label: "Gerenciar plataforma", href: "/platform.html", icon: "platform", sector: "noc", desc: "Perfis, ações, telas, usuários e auditoria" },
    { code: "trafego", label: "Tráfego", desc: "Monitoramento de tráfego, utilização e erros por interface", href: "/trafego.html", icon: "trafego"},
  ];

  /* Setores fixos do menu. As telas existentes (incluindo GPON e ISP) ficam
     reunidas em NOC; os demais blocos já estão prontos para receber telas. */
  const SETORES_PADRAO = [
    { code: "atendimento", label: "HELPDESK", icon: "user" },
    { code: "logistica", label: "LOGÍSTICA", icon: "pops" },
    { code: "comercial", label: "COMERCIAL", icon: "dashboard" },
    { code: "sac", label: "SAC", icon: "bell" },
    { code: "financeiro", label: "FINANCEIRO", icon: "finance" },
    { code: "noc", label: "NOC", icon: "topology" },
  ];

  function SETORES() {
    const setores = window.UPDOWN_ACCESS?.sectors;
    if (!Array.isArray(setores) || !setores.length) return SETORES_PADRAO;
    return setores.map((s) => ({
      code: s.code,
      label: s.name,
      icon: s.icon || "circle",
      color: s.color || ""
    }));
  }

  function NAV() {
    const telas = window.UPDOWN_ACCESS?.screens;
    if (!Array.isArray(telas) || !telas.length) return NAV_PADRAO;
    return telas
      .filter((s) => s.nav !== 0 && s.route)
      .map((s) => ({ code: s.code, label: s.name, href: s.route, icon: s.icon || "topology", sector: s.sector || "noc", desc: s.description || "" }));
  }

  // A tela atual é reconhecida pela rota, e não por um id fixo em cada página.
  const rotaAtual = () => location.pathname.replace(/\/index\.html$/, "/") || "/";
  const ehAtual = (href) => rotaAtual() === href;

  const SIDEBAR_KEY = "updown.sidebar";
  let searchProvider = null; // a tela pode registrar itens próprios na paleta

  /* `active` continua aceito pelas telas, mas o item atual do menu é
     reconhecido pela rota — o menu agora vem do catálogo de telas. */
  function mountShell({ search = null } = {}) {
    if (search) searchProvider = search;
    const user = session();

    const bar = $("[data-appbar]");
    if (bar) {
      bar.className = "appbar";
      bar.innerHTML = `
        <button class="btn btn-ghost btn-icon" data-sidebar-toggle type="button" aria-label="Recolher menu lateral" title="Recolher menu (Ctrl+B)">${icon("menu")}</button>
        <a class="brand" href="/" aria-label="UPDOWN Telecom">
          <span class="brand-art" aria-hidden="true"></span>
        </a>
        <div class="appbar-search">
          <div class="input-affix">
            <span class="affix-icon">${icon("search")}</span>
            <input class="input" id="globalSearch" type="search" placeholder="Buscar equipamento, porta, POP ou capacidade…" aria-label="Busca global" autocomplete="off">
          </div>
        </div>
        <div class="appbar-actions">
          <button class="btn btn-ghost btn-icon appbar-search-btn" data-palette-open type="button" aria-label="Buscar equipamento, POP ou tela">${icon("search")}</button>
          <button class="btn btn-ghost btn-icon" data-palette-open type="button" title="Paleta de comandos (Ctrl+K)" aria-label="Abrir paleta de comandos">${icon("keyboard")}</button>
          <button class="btn btn-ghost btn-icon" data-theme-toggle type="button"></button>
          <div style="position:relative">
            <button class="user-menu" data-user-menu type="button" aria-haspopup="true" aria-expanded="false">
              <span class="avatar">${esc(initials(user.name))}</span>
              <span class="user-info"><b>${esc(user.name)}</b><small>${esc(user.role)}</small></span>
              ${icon("chevronDown")}
            </button>
          </div>
        </div>`;
      applyTheme(document.documentElement.dataset.theme);
      wireUserMenu(bar);
      $("#globalSearch", bar).addEventListener("focus", (e) => { e.target.blur(); openPalette(); });
    }

    renderNav();

    const shell = $(".shell");
    if (shell) {
      let collapsed = false;
      try { collapsed = localStorage.getItem(SIDEBAR_KEY) === "1"; } catch (e) { /* ignore */ }
      shell.classList.toggle("is-collapsed", collapsed);
      const toggle = $("[data-sidebar-toggle]");
      if (toggle) toggle.onclick = () => {
        const now = shell.classList.toggle("is-collapsed");
        try { localStorage.setItem(SIDEBAR_KEY, now ? "1" : "0"); } catch (e) { /* ignore */ }
      };
    }

    $$("[data-shortcuts]").forEach((b) => (b.onclick = openShortcuts));
    $$("[data-palette-open]").forEach((b) => (b.onclick = () => openPalette()));
    $$("[data-theme-toggle]").forEach((b) => (b.onclick = toggleTheme));
    toastHost();
    bindGlobalKeys();
    applyAccess(window.UPDOWN_ACCESS);
  }

  /* Monta o menu lateral e o inferior com as telas liberadas para o perfil. */
  function renderNav() {
    const itens = NAV();
    const setores = SETORES();
    const porSetor = new Map(setores.map((setor) => [setor.code, []]));
    const setorPadrao = porSetor.get("noc") || porSetor.values().next().value || [];
    itens.forEach((n) => (porSetor.get(n.sector) || setorPadrao).push(n));
    const item = (n) => `
      <a class="nav-item" data-nav="${n.code}" data-code="${n.code}" href="${n.href}" ${ehAtual(n.href) ? 'aria-current="page"' : ""}>
        ${icon(n.icon)}<span>${esc(n.label)}</span>
      </a>`;
    const setor = (s) => {
      const menus = porSetor.get(s.code) || [];
      const contemTelaAtual = menus.some((n) => ehAtual(n.href));
      const aberto = s.code === "noc" || contemTelaAtual;
      return `
        <details class="nav-sector" data-sector="${s.code}" style="--sector-color:${esc(s.color || "var(--cyan-400)")}" ${aberto ? "open" : ""}>
          <summary class="nav-sector-trigger">
            ${icon(s.icon)}<span>${esc(s.label)}</span>${icon("chevronDown", "icon nav-sector-chevron")}
          </summary>
          <div class="nav-sector-menu">
            ${menus.length ? menus.map(item).join("") : '<span class="nav-sector-empty">Nenhum menu cadastrado</span>'}
          </div>
        </details>`;
    };

    const side = $("[data-sidebar]");
    if (side) {
      side.className = "sidebar";
      side.innerHTML = `
        <nav class="nav" aria-label="Navegação principal">
          ${setores.map(setor).join("")}
        </nav>
        <div class="sidebar-foot stack" style="gap:var(--s-3)">
          <button class="btn btn-sm btn-block" data-shortcuts type="button">${icon("keyboard")} Atalhos de teclado</button>
        </div>`;
      $$("[data-shortcuts]", side).forEach((b) => (b.onclick = openShortcuts));
    }

    /* Barra inferior do celular: quatro telas e o botão do menu completo.
       A barra não tenta caber todas as telas — com dez itens cada alvo ficava
       com menos de 44px e o rótulo, cortado na primeira palavra, repetia
       "Topologia" e "Cadastro" em linhas diferentes. A tela aberta sempre
       aparece entre as quatro, mesmo quando não está no topo da lista. */
    const mobile = $("[data-mobile-nav]");
    if (mobile) {
      mobile.className = "mobile-nav";
      const atual = itens.find((n) => ehAtual(n.href));
      const principais = itens.slice(0, 4);
      if (atual && !principais.includes(atual)) principais.splice(3, 1, atual);
      const rotulos = rotulosCurtos(principais);

      mobile.innerHTML =
        principais.map((n, i) => `
          <a href="${n.href}" data-nav="${n.code}" data-code="${n.code}" title="${esc(n.label)}" ${ehAtual(n.href) ? 'aria-current="page"' : ""}>
            ${icon(n.icon)}<span>${esc(rotulos[i])}</span>
          </a>`).join("") +
        `<button type="button" data-nav-sheet aria-haspopup="dialog">
           ${icon("menu")}<span>Menu</span>
         </button>`;
      $("[data-nav-sheet]", mobile).onclick = openNavSheet;
    }
  }

  /* Rótulos da barra inferior. O nome cadastrado da tela ("Cadastro de POPs
     Backbone") não cabe em um sexto da largura do telefone, e cortar na
     primeira palavra — como era feito — dava dois itens "Topologia" e dois
     "Cadastro" lado a lado. A regra aqui tira só o que não diferencia:

     1. o verbo genérico do começo ("Cadastro de", "Gerenciar");
     2. a primeira palavra, quando ela se repete entre os itens visíveis —
        se duas telas começam com "Topologia", é o que vem depois que as
        distingue.

     O nome completo continua no `title` e no menu lateral. */
  function rotulosCurtos(itens) {
    const primeira = (label) => String(label || "").trim().split(/\s+/)[0].toLowerCase();
    const repetidas = new Map();
    itens.forEach((n) => repetidas.set(primeira(n.label), (repetidas.get(primeira(n.label)) || 0) + 1));

    return itens.map((n) => {
      const semVerbo = String(n.label || "").trim().replace(/^(cadastro|gerenciar)\s+(de\s+|da\s+|do\s+)?/i, "");
      const palavras = semVerbo.split(/\s+/);
      if (palavras.length > 1 && repetidas.get(primeira(n.label)) > 1) palavras.shift();
      const curto = palavras.join(" ");
      return curto.length > 13 ? `${curto.slice(0, 12)}…` : curto;
    });
  }

  /* Gaveta com a navegação completa: os mesmos setores e telas do menu lateral,
     que no celular fica oculto. Sem ela, as telas fora das quatro primeiras não
     teriam caminho de navegação nenhum no telefone. */
  function openNavSheet() {
    const nav = $("[data-sidebar] .nav");
    return drawer({
      labelledBy: "navSheetTitle",
      html: `
        <div class="drawer-head row-between">
          <h2 id="navSheetTitle" style="font-size:var(--fs-16)">Navegação</h2>
          <button class="btn btn-ghost btn-icon btn-sm" data-close type="button" aria-label="Fechar navegação">${icon("close")}</button>
        </div>
        <div class="drawer-body nav-sheet">${nav ? nav.outerHTML : ""}</div>`,
      onMount(host, close) {
        // Fecha ao escolher uma tela: sem isto a gaveta fica por cima durante
        // o carregamento da página seguinte.
        $$(".nav-item", host).forEach((a) => a.addEventListener("click", close));
      },
    });
  }

  /* O RBAC continua mandando: tela sem acesso some do menu. */
  function applyAccess(access) {
    if (!access || !Array.isArray(access.screens)) return;
    const codes = new Set(access.screens.map((s) => s.code));
    $$("[data-code]").forEach((el) => { el.hidden = !codes.has(el.dataset.code); });
  }

  addEventListener("updown:auth-ready", (ev) => {
    // Quando a autenticação responde, o chip do usuário e o menu se atualizam.
    const u = ev.detail?.user || {};
    const chip = $("[data-user-menu]");
    if (chip) {
      const nome = u.display_name || u.username || "Usuário";
      $(".avatar", chip).textContent = initials(nome);
      $(".user-info", chip).innerHTML = `<b>${esc(nome)}</b><small>${esc(u.role || "")}</small>`;
    }
    renderNav();
    applyAccess(ev.detail?.access);
    initCalendarAlerts();
  });

  /* ---------------- agenda pessoal importada por arquivo .ics ---------------- */
  async function calendarApi(url, options = {}) {
    const response = await fetch(url, {
      credentials: "same-origin",
      cache: "no-store",
      headers: options.body ? { "Content-Type": "application/json" } : undefined,
      ...options,
    });
    const data = await response.json().catch(() => ({}));
    if (response.status === 401) {
      location.replace("/login.html");
      throw new Error("Sessão expirada.");
    }
    if (!response.ok) throw new Error(data.error || "Não foi possível acessar a agenda.");
    return data;
  }

  function openAgendaImport() {
    modal({
      labelledBy: "calendarSettingsTitle",
      wide: true,
      html: `
        <div class="modal-head">
          <div><span class="kicker">${icon("calendar")} Importação gratuita</span><h2 id="calendarSettingsTitle" style="margin-top:8px">Importar agenda pessoal</h2>
          <p class="muted" style="font-size:var(--fs-13);margin-top:6px">Exporte sua agenda como arquivo .ics e selecione-o aqui. Nenhuma conta externa será vinculada.</p></div>
          <button class="btn btn-ghost btn-icon" data-close type="button" aria-label="Fechar">${icon("close")}</button>
        </div>
        <div class="modal-body stack">
          <div class="notice notice-info">${icon("info")}<span><b>Como obter o arquivo</b><br>Na agenda da sua conta pessoal, abra Configurações → Importar e exportar → Exportar. Extraia o arquivo .zip e selecione aqui todos os arquivos .ics desejados.</span></div>
          <div class="field"><label for="agendaIcsFile">Arquivo(s) da agenda (.ics)</label><input class="input" id="agendaIcsFile" type="file" accept=".ics,text/calendar" multiple></div>
          <p class="muted" style="font-size:var(--fs-12)">Uma nova importação atualiza os compromissos importados anteriormente. Compromissos criados diretamente no NOC e agendas dos setores não são alterados.</p>
          <span class="field-error" data-import-error hidden></span>
        </div>
        <div class="modal-foot"><span></span><span class="row"><button class="btn" data-close type="button">Cancelar</button><button class="btn btn-primary" data-import-ics type="button">Importar agenda</button></span></div>`,
      onMount: (host, close) => {
        $("[data-import-ics]", host).onclick = async event => {
          const files = [...($("#agendaIcsFile", host).files || [])];
          const error = $("[data-import-error]", host);
          if (!files.length || files.some(file => !file.name.toLowerCase().endsWith(".ics"))) {
            error.hidden = false; error.textContent = "Selecione somente arquivos .ics exportados da sua agenda."; return;
          }
          if (files.reduce((total, file) => total + file.size, 0) > 5 * 1024 * 1024) {
            error.hidden = false; error.textContent = "Os arquivos devem somar no máximo 5 MB."; return;
          }
          event.currentTarget.disabled = true;
          try {
            const calendarText = (await Promise.all(files.map(file => file.text()))).join("\r\n");
            const result = await calendarApi("/api/agenda/import-ics", {
              method: "POST", headers: { "Content-Type": "text/calendar; charset=utf-8" }, body: calendarText
            });
            close();
            toast("Agenda importada", { text: `${result.imported} compromisso(s) carregado(s).`, type: "ok", timeout: 7000 });
            dispatchEvent(new CustomEvent("updown:agenda-imported", { detail: result }));
            pollCalendarEvents(true);
          } catch (failure) {
            const messages = {
              ARQUIVO_ICS_INVALIDO: "O arquivo selecionado não é uma agenda válida.",
              ARQUIVO_ICS_SEM_COMPROMISSOS: "Nenhum compromisso foi encontrado nos arquivos.",
              ARQUIVO_ICS_MUITO_GRANDE: "A agenda excede o limite de 5 MB.",
              FORBIDDEN: "Seu perfil não tem acesso à agenda."
            };
            error.hidden = false;
            error.textContent = messages[failure.message] || "Não foi possível importar a agenda. Tente exportar os arquivos novamente.";
            event.currentTarget.disabled = false;
          }
        };
      }
    });
  }

  let calendarAlertsStarted = false;
  let calendarPolling = false;
  const calendarSeenKey = () => `updown.calendar.seen.${window.UPDOWN_AUTH?.id || "user"}`;

  function seenCalendarAlerts() {
    try {
      const data = JSON.parse(localStorage.getItem(calendarSeenKey()) || "{}");
      const cutoff = Date.now() - 2 * 24 * 60 * 60_000;
      return Object.fromEntries(Object.entries(data).filter(([, timestamp]) => Number(timestamp) >= cutoff));
    } catch { return {}; }
  }

  function persistSeenCalendarAlerts(seen) {
    try { localStorage.setItem(calendarSeenKey(), JSON.stringify(seen)); } catch { /* armazenamento indisponível */ }
  }

  function formatAppointmentStart(event) {
    if (event.all_day) return "Hoje, dia inteiro";
    const date = new Date(event.start);
    return date.toLocaleString("pt-BR", { weekday: "long", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
  }

  function showAppointmentPopup(events) {
    const first = events[0];
    modal({
      labelledBy: "appointmentAlertTitle",
      html: `
        <div class="modal-head">
          <div><span class="kicker">${icon("bell")} Alerta de agenda</span><h2 id="appointmentAlertTitle" style="margin-top:8px">${events.length === 1 ? esc(first.title) : `${events.length} compromissos próximos`}</h2></div>
          <button class="btn btn-ghost btn-icon" data-close type="button" aria-label="Fechar">${icon("close")}</button>
        </div>
        <div class="modal-body stack">
          ${events.map(event => `<div class="card" style="padding:var(--s-4)">
            <b>${esc(event.title)}</b>
            <p class="muted" style="margin-top:5px">${icon("clock")} ${esc(formatAppointmentStart(event))}${event.location ? `<br>${esc(event.location)}` : ""}</p>
          </div>`).join("")}
        </div>
        <div class="modal-foot"><span></span><span class="row">
          <button class="btn btn-primary" data-close type="button">Entendi</button>
        </span></div>`,
    });
    if ("Notification" in window && Notification.permission === "granted") {
      try {
        new Notification(events.length === 1 ? first.title : `${events.length} compromissos próximos`, {
          body: events.map(event => `${formatAppointmentStart(event)} — ${event.title}`).join("\n"),
          icon: "/assets/brand/updown-symbol.png",
          tag: `updown-calendar-${first.id}`
        });
      } catch { /* o pop-up interno continua disponível */ }
    }
  }

  async function pollCalendarEvents(force = false) {
    if (calendarPolling || (!force && document.visibilityState === "hidden")) return;
    calendarPolling = true;
    try {
      const now = Date.now();
      const start = new Date(now - 5 * 60_000).toISOString();
      const end = new Date(now + 24 * 60 * 60_000).toISOString();
      const data = await calendarApi(`/api/agenda?start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}`);
      const seen = seenCalendarAlerts();
      const current = new Date();
      const today = `${current.getFullYear()}-${String(current.getMonth()+1).padStart(2,"0")}-${String(current.getDate()).padStart(2,"0")}`;
      const due = (data.events || []).filter(event => {
        if (!event.alert_popup) return false;
        const key = `${event.source || "updown"}:${event.id}:${event.start}`;
        if (seen[key]) return false;
        if (event.all_day) {
          if (String(event.start).slice(0, 10) !== today) return false;
        } else {
          const starts = new Date(event.start).getTime();
          const lead = Math.max(0, Number(event.alert_minutes || 0)) * 60_000;
          if (!Number.isFinite(starts) || starts < now - 5 * 60_000 || starts > now + lead) return false;
        }
        seen[key] = now;
        return true;
      });
      if (due.length) {
        persistSeenCalendarAlerts(seen);
        showAppointmentPopup(due.slice(0, 8));
      }
    } catch { /* falhas temporárias não interrompem as demais telas */ }
    finally { calendarPolling = false; }
  }

  function initCalendarAlerts() {
    if (calendarAlertsStarted) return;
    calendarAlertsStarted = true;
    pollCalendarEvents();
    setInterval(pollCalendarEvents, 60_000);
    document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") pollCalendarEvents(); });
  }

  // Em navegação muito rápida, o guardião pode concluir antes deste arquivo
  // chegar ao fim. Nesse caso, inicia sem depender de um segundo evento.
  if (window.UPDOWN_AUTH) queueMicrotask(initCalendarAlerts);

  function wireUserMenu(root) {
    const btn = $("[data-user-menu]", root);
    if (!btn) return;
    let menu = null;
    const close = () => {
      if (!menu) return;
      menu.remove(); menu = null;
      btn.setAttribute("aria-expanded", "false");
      document.removeEventListener("click", onDoc, true);
    };
    const onDoc = (e) => { if (menu && !menu.contains(e.target) && !btn.contains(e.target)) close(); };
    btn.onclick = () => {
      if (menu) return close();
      const user = session();
      menu = document.createElement("div");
      menu.className = "menu";
      menu.innerHTML = `
        <div class="menu-label">Sessão</div>
        <div class="menu-item" style="pointer-events:none">
          <span class="avatar">${esc(initials(user.name))}</span>
          <span><b style="display:block">${esc(user.name)}</b><small class="dim">${esc(user.username)} • ${esc(user.role)}</small></span>
        </div>
        <div class="menu-sep"></div>
        <a class="menu-item" href="/change-password.html">${icon("lock")} Trocar senha</a>
        <button class="menu-item" data-calendar-menu type="button">${icon("calendar")} Importar agenda (.ics)</button>
        <button class="menu-item" data-theme-menu type="button">${icon("moon")} Alternar tema</button>
        <button class="menu-item" data-shortcuts type="button">${icon("keyboard")} Atalhos de teclado</button>
        <div class="menu-sep"></div>
        <button class="menu-item is-danger" id="logoutBtn" type="button">${icon("logout")} Encerrar sessão</button>`;
      btn.parentElement.appendChild(menu);
      btn.setAttribute("aria-expanded", "true");
      $("[data-calendar-menu]", menu).onclick = () => { close(); openAgendaImport(); };
      $("[data-theme-menu]", menu).onclick = () => { toggleTheme(); close(); };
      $("[data-shortcuts]", menu).onclick = () => { close(); openShortcuts(); };
      // Logout pela API: o Worker limpa o cookie HttpOnly.
      $("#logoutBtn", menu).onclick = async () => {
        try {
          await fetch("/api/auth/logout", { method: "POST", credentials: "same-origin", cache: "no-store" });
        } catch (e) { /* mesmo com falha, sair da tela autenticada */ }
        location.replace("/login.html?logged_out=1");
      };
      setTimeout(() => document.addEventListener("click", onDoc, true), 0);
    };
  }

  /* ---------------- paleta de comandos ---------------- */
  function paletteCommands() {
    const cmds = NAV().map((n) => ({ group: "Ir para", label: n.label, hint: n.desc, icon: n.icon, run: () => (location.href = n.href) }));
    cmds.push(
      { group: "Ações", label: "Alternar tema claro/escuro", hint: "Atalho: T", icon: "moon", run: toggleTheme },
      { group: "Ações", label: "Ver atalhos de teclado", hint: "Atalho: ?", icon: "keyboard", run: openShortcuts },
      { group: "Ações", label: "Abrir Dashboard em modo TV", hint: "Telão do NOC", icon: "tv", run: () => (location.href = "/dashboard.html?tv=1") },
      { group: "Ações", label: "Editor clássico da topologia", hint: "Edição completa de portas, POPs e títulos", icon: "edit", run: () => (location.href = "/legado.html") }
    );
    if (searchProvider) {
      try { cmds.push(...searchProvider()); } catch (e) { console.warn("Busca da tela indisponível:", e); }
    }
    return cmds;
  }

  let paletteOpen = false;
  function openPalette(initial = "") {
    if (paletteOpen) return;
    paletteOpen = true;
    const commands = paletteCommands();
    const { host } = layer({
      className: "palette",
      html: `
        <div class="palette-card">
          <input class="palette-input" type="text" placeholder="Buscar telas, equipamentos, POPs ou ações…"
                 aria-label="Buscar na plataforma" value="${esc(initial)}" autocomplete="off" role="combobox"
                 aria-expanded="true" aria-controls="paletteList">
          <div class="palette-list" id="paletteList" role="listbox" aria-label="Resultados"></div>
          <div class="palette-foot">
            <span><span class="kbd">↑</span><span class="kbd">↓</span> navegar</span>
            <span><span class="kbd">↵</span> abrir</span>
            <span><span class="kbd">esc</span> fechar</span>
          </div>
        </div>`,
      onMount: (h, closeFn) => {
        const input = $(".palette-input", h);
        const list = $(".palette-list", h);
        let results = [], index = 0;
        const render = () => {
          const q = input.value.trim().toLowerCase();
          results = (q ? commands.filter((c) => (c.label + " " + c.hint + " " + c.group).toLowerCase().includes(q)) : commands).slice(0, 40);
          if (index >= results.length) index = 0;
          if (!results.length) {
            list.innerHTML = `<div class="empty"><b>Nada encontrado</b><p>Tente o nome do equipamento, o POP ou a tela.</p></div>`;
            return;
          }
          let group = "";
          list.innerHTML = results.map((c, i) => {
            const head = c.group !== group ? `<div class="palette-group">${esc((group = c.group))}</div>` : "";
            return `${head}<button class="palette-item" type="button" role="option" data-i="${i}" aria-selected="${i === index}">
              ${icon(c.icon)}<span class="grow"><span>${esc(c.label)}</span><small>${esc(c.hint)}</small></span>${icon("arrowRight")}</button>`;
          }).join("");
          $$(".palette-item", list).forEach((b) => {
            b.onmousemove = () => { index = +b.dataset.i; syncSel(); };
            b.onclick = () => { closeFn(); results[+b.dataset.i].run(); };
          });
        };
        const syncSel = () => {
          $$(".palette-item", list).forEach((b) => b.setAttribute("aria-selected", +b.dataset.i === index));
          $('.palette-item[aria-selected="true"]', list)?.scrollIntoView({ block: "nearest" });
        };
        input.addEventListener("input", render);
        input.addEventListener("keydown", (e) => {
          if (e.key === "ArrowDown") { e.preventDefault(); index = Math.min(index + 1, results.length - 1); syncSel(); }
          else if (e.key === "ArrowUp") { e.preventDefault(); index = Math.max(index - 1, 0); syncSel(); }
          else if (e.key === "Enter") { e.preventDefault(); const c = results[index]; if (c) { closeFn(); c.run(); } }
        });
        render();
        setTimeout(() => input.focus(), 10);
      },
    });
    const observer = new MutationObserver(() => {
      if (!document.body.contains(host)) { paletteOpen = false; observer.disconnect(); }
    });
    observer.observe(document.body, { childList: true });
  }

  /* ---------------- atalhos ---------------- */
  const SHORTCUTS = [
    ["Ctrl / ⌘ + K", "Abrir a paleta de comandos e a busca global"],
    ["/", "Focar a busca sem sair do teclado"],
    ["Ctrl / ⌘ + B", "Recolher ou expandir o menu lateral"],
    ["T", "Alternar tema claro e escuro"],
    ["G depois H", "Ir para a Home"],
    ["G depois T", "Ir para a Topologia"],
    ["G depois D", "Ir para o Dashboard NOC"],
    ["G depois P", "Ir para os POPs"],
    ["G depois A", "Ir para a Plataforma"],
    ["?", "Abrir esta lista de atalhos"],
    ["Esc", "Fechar gaveta, modal ou paleta"],
  ];
  function openShortcuts() {
    modal({
      labelledBy: "scTitle",
      html: `
        <div class="modal-head">
          <div><span class="kicker">${icon("keyboard")} Produtividade</span><h2 id="scTitle" style="margin-top:8px">Atalhos de teclado</h2>
          <p class="muted" style="font-size:var(--fs-13);margin-top:6px">Toda ação frequente do NOC tem um caminho sem mouse.</p></div>
          <button class="btn btn-ghost btn-icon" data-close type="button" aria-label="Fechar">${icon("close")}</button>
        </div>
        <div class="modal-body">
          <div class="stack" style="gap:0">
            ${SHORTCUTS.map(([k, d]) => `
              <div class="row-between" style="padding:10px 0;border-bottom:1px solid var(--line)">
                <span style="font-size:var(--fs-13)">${esc(d)}</span>
                <span class="row" style="gap:4px">${k.split(" ").map((p) => (p === "+" || p === "depois" ? `<span class="dim" style="font-size:var(--fs-11)">${p}</span>` : `<span class="kbd">${esc(p)}</span>`)).join("")}</span>
              </div>`).join("")}
          </div>
        </div>`,
    });
  }

  let keysBound = false, gPressed = false;
  function bindGlobalKeys() {
    if (keysBound) return;
    keysBound = true;
    document.addEventListener("keydown", (e) => {
      const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName) || document.activeElement?.isContentEditable;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") { e.preventDefault(); openPalette(); return; }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "b") { e.preventDefault(); $("[data-sidebar-toggle]")?.click(); return; }
      if (typing || e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key === "/") { e.preventDefault(); openPalette(); return; }
      if (e.key === "?") { e.preventDefault(); openShortcuts(); return; }
      if (e.key.toLowerCase() === "t") { toggleTheme(); return; }
      if (e.key.toLowerCase() === "g") { gPressed = true; setTimeout(() => (gPressed = false), 1200); return; }
      if (gPressed) {
        const map = { h: "/", t: "/topologia.html", d: "/dashboard.html", p: "/pops.html", a: "/platform.html" };
        const dest = map[e.key.toLowerCase()];
        if (dest) { gPressed = false; location.href = dest; }
      }
    });
  }

  function clock(strongSel, smallSel) {
    const s = $(strongSel), d = $(smallSel);
    const tick = () => {
      const now = new Date();
      if (s) s.textContent = now.toLocaleTimeString("pt-BR");
      if (d) d.textContent = now.toLocaleDateString("pt-BR", { weekday: "long", day: "2-digit", month: "long", year: "numeric" });
    };
    tick();
    setInterval(tick, 1000);
  }

  return {
    $, $$, esc, num, pct, icon, toast, modal, drawer, confirm, layer,
    mountShell, openPalette, openShortcuts, toggleTheme, applyTheme,
    session, initials, clock, openAgendaImport, NAV, trapFocus,
  };
})();
