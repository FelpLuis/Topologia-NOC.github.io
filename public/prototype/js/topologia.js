/* ============================================================
   UPDOWN NOC — Tela de topologia
   Mapa em dois níveis: localidades (POPs / sites) que se expandem
   nos equipamentos e enlaces internos. Gaveta de detalhe com
   portas, conexões e ficha, com permissão por perfil.
   ============================================================ */
(() => {
  "use strict";
  const { $, $$, esc, icon, toast, drawer, modal, confirm: askConfirm } = UI;
  const D = window.MOCK;

  /* ---------- permissões do perfil em sessão ---------- */
  const role = UI.session().role;
  const perms = new Set(D.rolePermissions[role] || D.rolePermissions.atendimento);
  const can = (code) => {
    const p = D.permissions.find((x) => x.code === code);
    return !!p && perms.has(p.id);
  };
  const canEdit = can("topology.edit");
  const canDelete = can("topology.delete");

  /* ---------- estado da tela ---------- */
  const state = {
    query: "",
    cats: new Set(),
    selected: null,
    expanded: new Set(),       // localidades abertas
    scale: 1, tx: 0, ty: 0,
    flow: true,
    view: "mapa",
    boxes: {}, nodes: {},      // geometria calculada
    world: { w: 1, h: 1, fit: 1 },
  };

  /* ---------- derivados de equipamento ---------- */
  const device = (id) => D.equipamentos.find((e) => e.id === id);
  const used = (e) => e.portas.filter((p) => p.status === "conectada").length;
  const occupancy = (e) => UI.pct(used(e), e.portas.length);
  const occClass = (v) => (v > 85 ? "is-danger" : v > 60 ? "is-warn" : "");
  const statusInfo = (e) => {
    const s = e.monitoramento.status;
    return s === "online" ? { dot: "dot-ok", label: "Online", badge: "badge-ok" }
      : s === "degradado" ? { dot: "dot-warn", label: "Degradado", badge: "badge-warn" }
      : { dot: "dot-danger", label: "Offline", badge: "badge-danger" };
  };
  const connectionsOf = (id) => D.conexoes.filter((c) => c.origem === id || c.destino === id);
  const portConnection = (id, porta) =>
    D.conexoes.find((c) =>
      (c.origem === id && +c.portaOrigem === +porta) || (c.destino === id && +c.portaDestino === +porta));

  /* ---------- localidades (POPs) ----------
     A localidade de um equipamento é o campo popId do cadastro. Vincular e
     desvincular é uma ação explícita da gerência de rede — e é esse mesmo
     vínculo que organiza o Dashboard NOC. */
  const SEM_POP = "sem-pop";
  const POPS = () => D.pops.map((p) => ({
    id: p.id,
    nome: p.nome,
    local: p.local,
    tipo: p.id === "ascenty" ? "Núcleo" : "POP",
  }));
  const sites = () => [...POPS(), { id: SEM_POP, nome: "SEM POP VINCULADO", local: "Equipamentos aguardando vínculo", tipo: "Pendente" }];
  const siteById = (id) => sites().find((s) => s.id === id);
  const siteOf = (e) => (e && e.popId) || SEM_POP;
  const devicesOf = (siteId) => D.equipamentos.filter((e) => siteOf(e) === siteId);
  const visibleSites = () => sites().filter((s) => s.id !== SEM_POP || devicesOf(SEM_POP).length);

  /* Vincula ou desvincula, com desfazer imediato. */
  function setPop(deviceId, popId, { silent = false } = {}) {
    const e = device(deviceId);
    if (!e) return;
    const antes = e.popId ?? null;
    e.popId = popId || null;
    e.local = popId ? (siteById(popId)?.nome || e.local) : "Sem POP vinculado";
    if (popId) state.expanded.add(popId);
    layout();
    renderAll();
    if (silent) return;
    const nome = popId ? siteById(popId)?.nome : null;
    toast(popId ? `${e.nome} vinculado a ${nome}` : `${e.nome} desvinculado`, {
      text: popId
        ? "O equipamento passa a contar nos indicadores desse POP no Dashboard NOC."
        : "Ele sai dos indicadores do POP e vai para a lista de pendentes do Dashboard.",
      type: popId ? "ok" : "warn",
      action: {
        label: "Desfazer",
        run: () => setPop(deviceId, antes, { silent: true }),
      },
    });
  }

  function siteStats(siteId) {
    const list = devicesOf(siteId);
    const portas = list.reduce((a, e) => a + e.portas.length, 0);
    const emUso = list.reduce((a, e) => a + used(e), 0);
    const alarme = list.some((e) => e.monitoramento.status !== "online");
    return { list, portas, emUso, livres: portas - emUso, ocup: UI.pct(emUso, portas), alarme };
  }

  /* Rotas do anel óptico entre POPs — vêm do cadastro de POPs. */
  function ringLinks() {
    const alvo = (txt) => {
      const t = txt.toLowerCase();
      if (t.includes("praia")) return "praia-grande";
      if (t.includes("santos")) return "santos";
      if (t.includes("vicente")) return "sao-vicente";
      if (t.includes("cubat")) return "cubatao";
      return null;
    };
    const map = new Map();
    D.pops.forEach((p) => {
      (p.rotas || []).forEach((r) => {
        const to = alvo(r);
        if (!to || to === p.id) return;
        const key = [p.id, to].sort().join("|");
        const tipo = /subterr/i.test(r) ? "Subterrânea" : "Aérea";
        const cur = map.get(key) || { a: key.split("|")[0], b: key.split("|")[1], tipos: new Set() };
        cur.tipos.add(tipo);
        map.set(key, cur);
      });
    });
    return [...map.values()];
  }

  const matches = (e) => {
    const okCat = !state.cats.size || state.cats.has(e.categoria || "Outros");
    if (!okCat) return false;
    if (!state.query) return true;
    const hay = [e.nome, e.modelo, e.categoria, e.local, ...e.portas.map((p) => p.capacidade)].join(" ").toLowerCase();
    return hay.includes(state.query);
  };

  /* ---------- filtros ---------- */
  function renderFilters() {
    const cats = [...new Set(D.equipamentos.map((e) => e.categoria || "Outros"))];
    $("#catFilters").innerHTML = cats.map((c) => {
      const n = D.equipamentos.filter((e) => (e.categoria || "Outros") === c).length;
      return `<button class="chip" type="button" data-cat="${esc(c)}" aria-pressed="${state.cats.has(c)}">
        ${esc(c)} <span class="count">${n}</span></button>`;
    }).join("");
    $$("#catFilters .chip").forEach((b) => (b.onclick = () => {
      const c = b.dataset.cat;
      state.cats.has(c) ? state.cats.delete(c) : state.cats.add(c);
      renderFilters();
      renderAll();
    }));
  }

  /* ---------- lista lateral, agrupada por localidade ---------- */
  function renderList() {
    const total = D.equipamentos.filter(matches);
    $("#listCount").textContent = `${total.length} de ${D.equipamentos.length} equipamentos`;

    const html = visibleSites().map((s) => {
      const list = devicesOf(s.id).filter(matches);
      if (!list.length) return "";
      return `
        <div class="list-group">
          <div class="list-group-head">
            <span>${esc(s.nome)}</span>
            <button class="btn btn-ghost btn-sm" type="button" data-site-jump="${esc(s.id)}">
              ${state.expanded.has(s.id) ? "Recolher" : "Expandir"}</button>
          </div>
          ${list.map((e) => {
            const o = occupancy(e);
            const st = statusInfo(e);
            return `<button class="device-item" type="button" data-id="${esc(e.id)}" aria-current="${state.selected === e.id}">
              <span class="row-between"><b>${esc(e.nome)}</b><i class="dot ${st.dot}" title="${st.label}"></i></span>
              <small>${esc(e.modelo || "Modelo não informado")}</small>
              <span class="row" style="gap:var(--s-2);margin-top:6px">
                <span class="meter meter-sm ${occClass(o)} grow"><span style="width:${o}%"></span></span>
                <small class="mono dim">${used(e)}/${e.portas.length}</small>
              </span>
            </button>`;
          }).join("")}
        </div>`;
    }).join("");

    $("#deviceList").innerHTML = html || `<div class="empty">
        <span class="empty-icon">${icon("search")}</span>
        <b>Nenhum equipamento encontrado</b>
        <p>Ajuste a busca ou remova os filtros de categoria.</p>
      </div>`;

    $$("#deviceList .device-item").forEach((b) => (b.onclick = () => {
      const id = b.dataset.id;
      state.expanded.add(siteOf(device(id)));
      state.selected = id;
      layout();
      renderAll();
      centerOn(id);
      openDevice(id);
    }));
    $$("#deviceList [data-site-jump]").forEach((b) => (b.onclick = () => toggleSite(b.dataset.siteJump)));
  }

  /* ---------- visão em lista ---------- */
  function renderTable() {
    const rows = D.equipamentos.filter(matches);
    $("#listBody").innerHTML = rows.map((e) => {
      const o = occupancy(e);
      const s = statusInfo(e);
      return `<tr>
        <td><b>${esc(e.nome)}</b><br><small class="dim">${esc(e.modelo || "—")}</small></td>
        <td>${esc(siteById(siteOf(e))?.nome || e.local || "—")}</td>
        <td>${esc(e.categoria || "—")}</td>
        <td class="num">${e.portas.length}</td>
        <td class="num">${used(e)}</td>
        <td class="num">${e.portas.length - used(e)}</td>
        <td><span class="row" style="gap:var(--s-2)"><span class="meter meter-sm ${occClass(o)} grow"><span style="width:${o}%"></span></span><small class="mono">${o}%</small></span></td>
        <td><span class="badge ${s.badge}"><i class="dot ${s.dot}"></i>${s.label}</span></td>
        <td><button class="btn btn-sm" type="button" data-open="${esc(e.id)}">Detalhes</button></td>
      </tr>`;
    }).join("");
    $$("#listBody [data-open]").forEach((b) => (b.onclick = () => openDevice(b.dataset.open)));
  }

  /* =========================================================
     MAPA
     ========================================================= */
  const SITE_W = 268, SITE_H = 156;          // caixa recolhida
  const DEV_W = 190, DEV_H = 118;            // equipamento dentro da caixa
  const PAD = 18, HEAD = 92, GAP = 16, SITE_GAP = 92;

  const stage = () => $("#stage");
  const world = () => $("#world");

  function siteSize(s) {
    const n = devicesOf(s.id).length;
    if (!state.expanded.has(s.id) || !n) return { w: SITE_W, h: SITE_H };
    const cols = Math.min(3, n);
    const rows = Math.ceil(n / cols);
    return {
      w: Math.max(SITE_W, PAD * 2 + cols * DEV_W + (cols - 1) * GAP),
      h: HEAD + PAD + rows * DEV_H + (rows - 1) * GAP + PAD,
    };
  }

  /* Empacotamento em faixas: as caixas fluem e quebram na largura alvo,
     assim o mapa continua legível quando uma localidade abre. */
  function layout() {
    const st = stage().getBoundingClientRect();
    const sizes = visibleSites().map((s) => ({ site: s, ...siteSize(s) }));
    const totalW = sizes.reduce((a, s) => a + s.w, 0) + SITE_GAP * (sizes.length - 1);
    const targetW = Math.max(900, Math.min(totalW, Math.max(st.width, 900) * 1.25));

    const boxes = {};
    let x = 0, y = 0, rowH = 0, maxW = 0;
    sizes.forEach((s) => {
      if (x > 0 && x + s.w > targetW) { x = 0; y += rowH + SITE_GAP; rowH = 0; }
      boxes[s.site.id] = { x, y, w: s.w, h: s.h };
      rowH = Math.max(rowH, s.h);
      x += s.w + SITE_GAP;
      maxW = Math.max(maxW, x - SITE_GAP);
    });
    const worldH = y + rowH;

    // Alinha verticalmente pelo centro da faixa e posiciona os equipamentos.
    const nodes = {};
    visibleSites().forEach((s) => {
      const b = boxes[s.id];
      const list = devicesOf(s.id);
      if (!state.expanded.has(s.id) || !list.length) return;
      const cols = Math.min(3, list.length);
      list.forEach((e, i) => {
        nodes[e.id] = {
          x: b.x + PAD + (i % cols) * (DEV_W + GAP),
          y: b.y + HEAD + Math.floor(i / cols) * (DEV_H + GAP),
          w: DEV_W, h: DEV_H,
        };
      });
    });

    state.boxes = boxes;
    state.nodes = nodes;
    state.world = {
      w: maxW,
      h: worldH,
      fit: Math.min((st.width - 110) / maxW, (st.height - 110) / worldH, 1.1),
    };
    const w = world();
    w.style.width = maxW + "px";
    w.style.height = worldH + "px";
    $("#edges").setAttribute("viewBox", `0 0 ${maxW} ${worldH}`);
  }

  const boxCenter = (id) => {
    const b = state.boxes[id];
    return b ? { x: b.x + b.w / 2, y: b.y + b.h / 2 } : null;
  };
  const anchorOf = (deviceId) => {
    const n = state.nodes[deviceId];
    if (n) return { x: n.x + n.w / 2, y: n.y + n.h / 2, level: "device" };
    const c = boxCenter(siteOf(device(deviceId) || {}));
    return c ? { ...c, level: "site" } : null;
  };

  /* Enlaces desenhados: entre equipamentos quando a localidade está aberta,
     entre caixas quando está fechada — vários enlaces viram um só traço. */
  function edgesToDraw() {
    const out = new Map();
    D.conexoes.forEach((c) => {
      const da = device(c.origem), db = device(c.destino);
      if (!da || !db) return;
      const sa = siteOf(da), sb = siteOf(db);
      const aOpen = state.expanded.has(sa), bOpen = state.expanded.has(sb);
      if (sa === sb && !aOpen) return; // enlace interno de caixa fechada
      const ka = aOpen ? "d:" + c.origem : "s:" + sa;
      const kb = bOpen ? "d:" + c.destino : "s:" + sb;
      if (ka === kb) return;
      const key = [ka, kb].sort().join("→");
      const item = out.get(key) || { key, ka, kb, conns: [], tipo: "enlace" };
      item.conns.push(c);
      out.set(key, item);
    });
    return [...out.values()];
  }

  function resolve(key) {
    if (key.startsWith("d:")) {
      const n = state.nodes[key.slice(2)];
      return n ? { x: n.x + n.w / 2, y: n.y + n.h / 2 } : null;
    }
    return boxCenter(key.slice(2));
  }

  function renderEdges() {
    const parts = [];

    // Anel óptico entre POPs
    ringLinks().forEach((r, i) => {
      const a = boxCenter(r.a), b = boxCenter(r.b);
      if (!a || !b) return;
      const d = curve(a, b);
      parts.push(`<path class="topo-edge is-ring" d="${d}" data-ring="${i}">
        <title>Anel óptico ${esc(r.a)} ↔ ${esc(r.b)} — ${[...r.tipos].join(" e ")}</title></path>`);
    });

    // Enlaces de equipamento
    edgesToDraw().forEach((e, i) => {
      const a = resolve(e.ka), b = resolve(e.kb);
      if (!a || !b) return;
      const envolve = (k) => (state.selected ? k === "d:" + state.selected || k === "s:" + siteOf(device(state.selected)) : false);
      const active = state.selected && (envolve(e.ka) || envolve(e.kb));
      const dim = state.selected && !active;
      const d = curve(a, b);
      const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
      const label = e.conns.length > 1
        ? `${e.conns.length} enlaces`
        : `${e.conns[0].portaOrigem} ↔ ${e.conns[0].portaDestino}`;
      parts.push(`
        <path class="topo-edge ${active ? "is-active" : ""} ${dim ? "is-dim" : ""}" d="${d}" data-edge="${i}">
          <title>${esc(label)}</title></path>
        ${state.flow && !dim ? `<path class="topo-flow" d="${d}"/>` : ""}
        <g data-edge="${i}" style="${dim ? "opacity:.22" : ""}">
          <rect class="topo-edge-chip" x="${mx - 44}" y="${my - 26}" width="88" height="19" rx="6"/>
          <text class="topo-edge-label" x="${mx}" y="${my - 12}" text-anchor="middle">${esc(label)}</text>
        </g>`);
    });

    const svg = $("#edges");
    svg.innerHTML = parts.join("");
    const list = edgesToDraw();
    $$("[data-edge]", svg).forEach((el) => {
      el.style.cursor = "pointer";
      el.addEventListener("click", () => openEdge(list[+el.dataset.edge]));
    });
    $$("[data-ring]", svg).forEach((el) => {
      el.style.cursor = "pointer";
      const r = ringLinks()[+el.dataset.ring];
      el.addEventListener("click", () => openRing(r));
    });
  }

  function curve(a, b) {
    const dx = Math.abs(b.x - a.x), dy = Math.abs(b.y - a.y);
    if (dy > dx) { // ligação mais vertical: curva pelo eixo Y
      const my = (a.y + b.y) / 2;
      return `M ${a.x} ${a.y} C ${a.x} ${my}, ${b.x} ${my}, ${b.x} ${b.y}`;
    }
    const mx = (a.x + b.x) / 2;
    return `M ${a.x} ${a.y} C ${mx} ${a.y}, ${mx} ${b.y}, ${b.x} ${b.y}`;
  }

  function renderSites() {
    const host = $("#nodes");
    host.innerHTML = visibleSites().map((s) => {
      const b = state.boxes[s.id];
      const st = siteStats(s.id);
      const aberto = state.expanded.has(s.id);
      const temEquip = st.list.length > 0;
      const dim = state.query && !st.list.some(matches);

      const devicesHtml = aberto ? st.list.map((e) => {
        const n = state.nodes[e.id];
        if (!n) return "";
        const o = occupancy(e);
        const si = statusInfo(e);
        const fade = !matches(e) || (state.selected && state.selected !== e.id && !isNeighbor(e.id));
        return `<button class="topo-device ${state.selected === e.id ? "is-active" : ""} ${fade ? "is-dim" : ""}"
                  type="button" data-id="${esc(e.id)}"
                  style="left:${n.x - b.x}px;top:${n.y - b.y}px"
                  aria-label="${esc(e.nome)}, ${used(e)} de ${e.portas.length} portas em uso">
          <span class="row-between"><span class="badge">${esc(e.categoria || "")}</span><i class="dot ${si.dot}"></i></span>
          <b class="truncate">${esc(e.nome)}</b>
          <small class="truncate dim">${esc(e.modelo || "")}</small>
          <span class="meter meter-sm ${occClass(o)}"><span style="width:${o}%"></span></span>
          <span class="row-between mono" style="font-size:var(--fs-10);color:var(--text-3)">
            <span>${used(e)}/${e.portas.length} portas</span><span>${o}%</span></span>
        </button>`;
      }).join("") : "";

      return `<section class="topo-site ${aberto ? "is-expanded" : ""} ${s.tipo === "Núcleo" ? "is-core" : ""} ${dim ? "is-dim" : ""}"
                style="left:${b.x}px;top:${b.y}px;width:${b.w}px;height:${b.h}px">
        <button class="site-head" type="button" data-site="${esc(s.id)}"
                aria-expanded="${aberto}" ${temEquip ? "" : 'disabled title="Localidade sem equipamento cadastrado"'}>
          <span class="site-chevron">${icon(aberto ? "chevronDown" : "chevronRight")}</span>
          <span class="grow" style="min-width:0">
            <span class="row" style="gap:6px">
              <span class="badge ${s.tipo === "Núcleo" ? "badge-brand" : s.tipo === "Backbone" ? "badge-info" : ""}">${esc(s.tipo)}</span>
              ${st.alarme ? '<span class="badge badge-warn"><i class="dot dot-warn"></i>alarme</span>' : ""}
            </span>
            <b class="truncate" style="display:block;margin-top:6px">${esc(s.nome)}</b>
            <small class="dim truncate" style="display:block">${esc(s.local)}</small>
          </span>
          <span class="site-metrics">
            <span><strong>${st.list.length}</strong><small>equip.</small></span>
            <span><strong>${st.portas}</strong><small>portas</small></span>
            <span><strong>${st.ocup}%</strong><small>ocupação</small></span>
          </span>
        </button>
        ${aberto ? "" : `<div class="site-foot">
            <span class="meter meter-sm ${occClass(st.ocup)} grow"><span style="width:${st.ocup}%"></span></span>
            <small class="mono dim">${st.emUso}/${st.portas}</small>
          </div>`}
        ${devicesHtml}
      </section>`;
    }).join("");

    $$("[data-site]", host).forEach((b) => (b.onclick = () => toggleSite(b.dataset.site)));
    $$(".topo-device", host).forEach((b) => (b.onclick = () => {
      state.selected = b.dataset.id;
      renderAll();
      openDevice(b.dataset.id);
    }));
  }

  const isNeighbor = (id) => {
    if (!state.selected || state.selected === id) return true;
    return connectionsOf(state.selected).some((c) => c.origem === id || c.destino === id);
  };

  function toggleSite(id) {
    const abrindo = !state.expanded.has(id);
    abrindo ? state.expanded.add(id) : state.expanded.delete(id);
    layout();
    renderAll();
    if (abrindo) centerOnBox(id); else fit();
    const s = siteById(id);
    toast(abrindo ? `${s.nome} expandida` : `${s.nome} recolhida`, {
      text: abrindo ? `${devicesOf(id).length} equipamentos e os enlaces internos apareceram no mapa.` : "",
      type: "info", timeout: 2200,
    });
  }

  /* ---------- zoom e deslocamento ---------- */
  function applyTransform(animate = true) {
    const w = world();
    w.classList.toggle("no-anim", !animate);
    w.style.transform = `translate(${state.tx}px, ${state.ty}px) scale(${state.scale})`;
    $("#zoomLabel").textContent = Math.round(state.scale * 100) + "%";
  }
  function setScale(next, originX, originY) {
    const s = Math.min(2, Math.max(0.25, next));
    const st = stage().getBoundingClientRect();
    const cx = originX ?? st.width / 2;
    const cy = originY ?? st.height / 2;
    // Mantém sob o cursor o mesmo ponto do mundo antes e depois do zoom.
    state.tx = cx - ((cx - state.tx) * s) / state.scale;
    state.ty = cy - ((cy - state.ty) * s) / state.scale;
    state.scale = s;
    applyTransform(false);
  }
  function fit() {
    layout();
    renderSites();
    renderEdges();
    const st = stage().getBoundingClientRect();
    state.scale = Math.max(0.25, Math.min(state.world.fit, 1.1));
    state.tx = (st.width - state.world.w * state.scale) / 2;
    state.ty = (st.height - state.world.h * state.scale) / 2;
    applyTransform();
  }
  function centerOnBox(id) {
    const b = state.boxes[id];
    if (!b) return;
    const st = stage().getBoundingClientRect();
    // Zoom confortável de leitura ao abrir uma localidade.
    state.scale = Math.max(0.4, Math.min(0.9, (st.width - 120) / b.w, (st.height - 120) / b.h));
    state.tx = st.width / 2 - (b.x + b.w / 2) * state.scale;
    state.ty = st.height / 2 - (b.y + b.h / 2) * state.scale;
    applyTransform();
  }
  function centerOn(id) {
    const a = state.nodes[id] ? { x: state.nodes[id].x + DEV_W / 2, y: state.nodes[id].y + DEV_H / 2 } : boxCenter(siteOf(device(id)));
    if (!a) return;
    const st = stage().getBoundingClientRect();
    state.scale = Math.max(state.scale, 0.65);
    state.tx = st.width / 2 - a.x * state.scale;
    state.ty = st.height / 2 - a.y * state.scale;
    applyTransform();
  }

  function bindStage() {
    const st = stage();
    st.addEventListener("wheel", (e) => {
      e.preventDefault();
      const r = st.getBoundingClientRect();
      if (e.ctrlKey || e.metaKey) setScale(state.scale * (e.deltaY > 0 ? 0.92 : 1.08), e.clientX - r.left, e.clientY - r.top);
      else { state.tx -= e.deltaX; state.ty -= e.deltaY; applyTransform(false); }
    }, { passive: false });

    let dragging = false, sx = 0, sy = 0, ox = 0, oy = 0, moved = false;
    const ignore = ".topo-device, .site-head, .topo-hud, .topo-legend, [data-edge], [data-ring]";
    st.addEventListener("pointerdown", (e) => {
      if (e.target.closest(ignore)) return;
      dragging = true; moved = false;
      sx = e.clientX; sy = e.clientY; ox = state.tx; oy = state.ty;
      st.classList.add("is-panning");
      st.setPointerCapture(e.pointerId);
    });
    st.addEventListener("pointermove", (e) => {
      if (!dragging) return;
      state.tx = ox + (e.clientX - sx);
      state.ty = oy + (e.clientY - sy);
      if (Math.abs(e.clientX - sx) + Math.abs(e.clientY - sy) > 4) moved = true;
      applyTransform(false);
    });
    const end = () => { dragging = false; st.classList.remove("is-panning"); };
    st.addEventListener("pointerup", end);
    st.addEventListener("pointercancel", end);
    st.addEventListener("click", (e) => {
      if (!moved && !e.target.closest(ignore) && state.selected) { state.selected = null; renderAll(); }
    });

    // O mapa inteiro é operável sem mouse.
    st.addEventListener("keydown", (e) => {
      const step = 70;
      const keys = {
        ArrowLeft: () => (state.tx += step), ArrowRight: () => (state.tx -= step),
        ArrowUp: () => (state.ty += step), ArrowDown: () => (state.ty -= step),
      };
      if (keys[e.key]) { e.preventDefault(); keys[e.key](); applyTransform(false); return; }
      if (e.key === "+" || e.key === "=") { e.preventDefault(); setScale(state.scale * 1.15); }
      if (e.key === "-" || e.key === "_") { e.preventDefault(); setScale(state.scale * 0.87); }
      if (e.key === "0") { e.preventDefault(); fit(); }
    });

    $("#zoomIn").onclick = () => setScale(state.scale * 1.15);
    $("#zoomOut").onclick = () => setScale(state.scale * 0.87);
    $("#zoomFit").onclick = fit;
  }

  /* ---------- enlaces: detalhe ---------- */
  function openEdge(e) {
    if (!e) return;
    if (e.conns.length === 1) return openConnection(e.conns[0]);
    const nome = (id) => device(id)?.nome || id;
    modal({
      labelledBy: "edgesTitle",
      html: `
        <div class="modal-head">
          <div><span class="kicker">${icon("link")} Enlaces agregados</span>
            <h2 id="edgesTitle" style="margin-top:6px">${e.conns.length} enlaces neste caminho</h2>
            <p class="muted" style="font-size:var(--fs-13);margin-top:4px">Expanda a localidade no mapa para ver cada enlace ligado à porta de origem.</p></div>
          <button class="btn btn-ghost btn-icon" data-close type="button" aria-label="Fechar">${icon("close")}</button>
        </div>
        <div class="modal-body">
          <div class="table-wrap"><table class="table">
            <thead><tr><th>Origem</th><th>Destino</th><th>Tipo</th><th>Capacidade</th></tr></thead>
            <tbody>${e.conns.map((c) => `<tr>
              <td><b>${esc(nome(c.origem))}</b> <span class="dim mono">p${c.portaOrigem}</span></td>
              <td><b>${esc(nome(c.destino))}</b> <span class="dim mono">p${c.portaDestino}</span></td>
              <td>${esc(c.tipo || "—")}</td><td>${esc(c.capacidade || "A confirmar")}</td></tr>`).join("")}</tbody>
          </table></div>
        </div>`,
    });
  }

  function openRing(r) {
    if (!r) return;
    const a = siteById(r.a), b = siteById(r.b);
    modal({
      labelledBy: "ringTitle",
      html: `
        <div class="modal-head">
          <div><span class="kicker">Anel óptico</span>
            <h2 id="ringTitle" style="margin-top:6px">${esc(a?.nome)} ↔ ${esc(b?.nome)}</h2></div>
          <button class="btn btn-ghost btn-icon" data-close type="button" aria-label="Fechar">${icon("close")}</button>
        </div>
        <div class="modal-body stack">
          <div class="row wrap" style="gap:6px">${[...r.tipos].map((t) => `<span class="badge badge-info">Rota ${esc(t)}</span>`).join("")}</div>
          <p class="muted" style="font-size:var(--fs-13)">
            Rotas registradas no cadastro do POP. A redundância aérea + subterrânea é o que mantém o anel
            em pé quando um trecho cai — por isso as duas aparecem no mapa.</p>
          <a class="btn" href="pops.html?pop=${encodeURIComponent(r.a)}">Abrir ficha do POP</a>
        </div>`,
    });
  }

  /* ---------- gaveta: detalhe do equipamento ---------- */
  function openDevice(id) {
    const e = device(id);
    if (!e) return;
    state.selected = id;
    renderSites();
    renderEdges();
    renderList();

    const s = statusInfo(e);
    const o = occupancy(e);
    const m = e.monitoramento;

    drawer({
      labelledBy: "devTitle",
      html: `
        <header class="drawer-head">
          <div class="row-between" style="align-items:flex-start">
            <div>
              <span class="kicker">${esc(siteById(siteOf(e))?.nome || e.local || "")} • ${esc(e.categoria || "Equipamento")}</span>
              <h2 id="devTitle" style="margin:6px 0 4px">${esc(e.nome)}</h2>
              <p class="muted" style="font-size:var(--fs-13)">${esc(e.modelo || "Modelo não informado")}</p>
            </div>
            <button class="btn btn-ghost btn-icon" data-close type="button" aria-label="Fechar detalhe">${icon("close")}</button>
          </div>
          <div class="row wrap" style="gap:6px;margin-top:var(--s-4)">
            <span class="badge ${s.badge}"><i class="dot ${s.dot}"></i>${s.label}</span>
            <span class="badge">${e.portas.length} portas</span>
            <span class="badge ${o > 85 ? "badge-danger" : o > 60 ? "badge-warn" : "badge-info"}">${o}% ocupado</span>
            <span class="badge">uptime ${m.uptimeDias} d</span>
          </div>
          <div class="tabs" style="margin-top:var(--s-4)" role="tablist" aria-label="Seções do equipamento">
            <button class="tab" role="tab" aria-selected="true" data-tab="portas">Portas</button>
            <button class="tab" role="tab" aria-selected="false" data-tab="conexoes">Conexões <span class="badge">${connectionsOf(id).length}</span></button>
            <button class="tab" role="tab" aria-selected="false" data-tab="ficha">Ficha técnica</button>
          </div>
        </header>
        <div class="drawer-body" id="devBody"></div>
        <footer class="drawer-foot">
          <span class="dim" style="font-size:var(--fs-11)">${canEdit ? "Alterações são auditadas com usuário, IP e data/hora." : `Seu perfil (${esc(role)}) tem acesso somente de leitura.`}</span>
          <span class="row">
            <a class="btn btn-sm" href="dashboard.html">Ver no dashboard</a>
            <button class="btn btn-sm btn-primary" data-edit type="button" ${canEdit ? "" : "disabled title='Requer a permissão topology.edit'"}>Editar</button>
          </span>
        </footer>`,
      onMount: (host, close) => {
        const body = $("#devBody", host);
        let tab = "portas";
        const paint = () => {
          $$(".tab", host).forEach((t) => t.setAttribute("aria-selected", String(t.dataset.tab === tab)));
          body.innerHTML = tab === "portas" ? portsTab(e) : tab === "conexoes" ? connTab(e) : sheetTab(e);
          if (tab === "portas") wirePorts(e, body);
          if (tab === "conexoes") wireConn(body, close);
        };
        $$(".tab", host).forEach((t) => (t.onclick = () => { tab = t.dataset.tab; paint(); }));
        $("[data-edit]", host).onclick = () => { tab = "ficha"; paint(); setTimeout(() => $("[data-editmode]", body)?.click(), 0); };
        paint();
      },
    });
  }

  /* --- aba portas --- */
  function portsTab(e) {
    const m = e.monitoramento;
    return `
      <div class="kv" style="margin-bottom:var(--s-5)">
        <div><label>Em uso</label><strong>${used(e)}<span class="unit"> / ${e.portas.length}</span></strong></div>
        <div><label>Livres</label><strong>${e.portas.length - used(e)}</strong></div>
        <div><label>CPU</label><strong>${m.cpu}<span class="unit">%</span></strong></div>
        <div><label>Temperatura</label><strong>${m.temperatura}<span class="unit">°C</span></strong></div>
      </div>

      <div class="row-between" style="margin-bottom:var(--s-3)">
        <h3 style="font-size:var(--fs-13)">Face do equipamento</h3>
        <span class="dim" style="font-size:var(--fs-11)">Clique numa porta para ver o enlace</span>
      </div>
      <div class="port-grid" id="portGrid">
        ${e.portas.map((p) => {
          const on = p.status === "conectada";
          const alerta = e.monitoramento.status === "degradado" && on;
          return `<button class="port ${on ? "is-used" : ""} ${alerta ? "is-alert" : ""}" type="button" data-port="${p.numero}"
                    aria-label="Porta ${p.numero}, ${on ? "em uso" : "livre"}, ${esc(p.capacidade || "")}">${String(p.numero).padStart(2, "0")}</button>`;
        }).join("")}
      </div>

      <div class="row-between" style="margin:var(--s-5) 0 var(--s-3)">
        <h3 style="font-size:var(--fs-13)">Lista de portas</h3>
        <div class="row" style="gap:6px">
          <button class="chip" type="button" data-pf="todas" aria-pressed="true">Todas</button>
          <button class="chip" type="button" data-pf="uso" aria-pressed="false">Em uso <span class="count">${used(e)}</span></button>
          <button class="chip" type="button" data-pf="livres" aria-pressed="false">Livres <span class="count">${e.portas.length - used(e)}</span></button>
        </div>
      </div>
      <div class="table-wrap" style="max-height:340px">
        <table class="table">
          <thead><tr><th>Porta</th><th>Capacidade</th><th>Tipo</th><th>Status</th><th>Conexão</th><th class="num">RX/TX</th></tr></thead>
          <tbody id="portRows"></tbody>
        </table>
      </div>`;
  }

  function wirePorts(e, root) {
    let filter = "todas";
    const rows = () => {
      const list = e.portas.filter((p) =>
        filter === "todas" ? true : filter === "uso" ? p.status === "conectada" : p.status !== "conectada");
      $("#portRows", root).innerHTML = list.length ? list.map((p) => {
        const c = portConnection(e.id, p.numero);
        const remoto = c ? device(c.origem === e.id ? c.destino : c.origem) : null;
        const remotaPorta = c ? (c.origem === e.id ? c.portaDestino : c.portaOrigem) : null;
        return `<tr>
          <td class="mono"><b>${String(p.numero).padStart(2, "0")}</b></td>
          <td>${esc(p.capacidade || "A confirmar")}</td>
          <td class="dim">${esc(p.tipo || "—")}</td>
          <td>${p.status === "conectada"
            ? '<span class="badge badge-ok"><i class="dot dot-ok"></i>Em uso</span>'
            : '<span class="badge">Livre</span>'}</td>
          <td>${remoto ? `<button class="btn btn-ghost btn-sm" data-goto="${esc(remoto.id)}">${esc(remoto.nome)} • porta ${remotaPorta}</button>` : '<span class="dim">—</span>'}</td>
          <td class="num">${p.status === "conectada" ? `${p.rx} / ${p.tx} <span class="dim">Gb/s</span>` : "—"}</td>
        </tr>`;
      }).join("") : `<tr><td colspan="6"><div class="empty"><b>Nenhuma porta nesse filtro</b><p>Troque o filtro acima para ver as demais portas.</p></div></td></tr>`;
      $$("#portRows [data-goto]", root).forEach((b) => (b.onclick = () => openDevice(b.dataset.goto)));
    };
    $$("[data-pf]", root).forEach((b) => (b.onclick = () => {
      filter = b.dataset.pf;
      $$("[data-pf]", root).forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
      rows();
    }));
    $$("#portGrid .port", root).forEach((b) => (b.onclick = () => openPort(e, +b.dataset.port)));
    rows();
  }

  /* --- detalhe de uma porta --- */
  function openPort(e, numero) {
    const p = e.portas.find((x) => +x.numero === numero);
    if (!p) return;
    const c = portConnection(e.id, numero);
    const remoto = c ? device(c.origem === e.id ? c.destino : c.origem) : null;
    const remotaPorta = c ? (c.origem === e.id ? c.portaDestino : c.portaOrigem) : null;
    const uso = p.capacidadeGbps ? UI.pct(p.rx, p.capacidadeGbps) : 0;

    modal({
      labelledBy: "portTitle",
      html: `
        <div class="modal-head">
          <div>
            <span class="kicker">${esc(e.nome)}</span>
            <h2 id="portTitle" style="margin-top:6px">Porta ${String(numero).padStart(2, "0")}</h2>
            <p class="muted" style="font-size:var(--fs-13);margin-top:4px">${esc(p.tipo || "—")} • ${esc(p.capacidade || "A confirmar")}</p>
          </div>
          <button class="btn btn-ghost btn-icon" data-close type="button" aria-label="Fechar">${icon("close")}</button>
        </div>
        <div class="modal-body stack">
          <div class="kv">
            <div><label>Status</label><strong>${p.status === "conectada" ? "Em uso" : "Livre"}</strong></div>
            <div><label>Interface</label><strong style="font-size:var(--fs-13)">${esc(p.interface || "—")}</strong></div>
            <div><label>RX</label><strong>${p.rx}<span class="unit"> Gb/s</span></strong></div>
            <div><label>TX</label><strong>${p.tx}<span class="unit"> Gb/s</span></strong></div>
          </div>
          ${p.status === "conectada" ? `
            <div>
              <div class="row-between" style="font-size:var(--fs-12);margin-bottom:6px">
                <span class="muted">Utilização do enlace</span><span class="mono">${uso}%</span>
              </div>
              <span class="meter ${occClass(uso)}"><span style="width:${uso}%"></span></span>
            </div>` : ""}
          ${remoto ? `
            <div class="card" style="padding:var(--s-4)">
              <span class="kicker">${icon("link")} Enlace</span>
              <div class="row-between" style="margin-top:var(--s-3)">
                <div><b>${esc(e.nome)}</b><br><small class="dim">porta ${numero}</small></div>
                ${icon("arrowRight")}
                <div style="text-align:right"><b>${esc(remoto.nome)}</b><br><small class="dim">porta ${remotaPorta}</small></div>
              </div>
              <div class="row" style="gap:6px;margin-top:var(--s-3)">
                <span class="badge badge-info">${esc(c.tipo || "Enlace")}</span>
                <span class="badge">${esc(c.capacidade || "A confirmar")}</span>
              </div>
            </div>` : `
            <div class="alert alert-info" style="animation:none">${icon("info")}
              <span>Porta livre e disponível para novo cliente ou expansão do anel.</span></div>`}
        </div>
        <div class="modal-foot">
          <span class="dim" style="font-size:var(--fs-11)">RX/TX vêm da integração com o Zabbix.</span>
          <span class="row">
            <button class="btn" data-close type="button">Fechar</button>
            ${remoto ? `<button class="btn btn-primary" data-goto="${esc(remoto.id)}" type="button">Abrir ${esc(remoto.nome)}</button>` : ""}
          </span>
        </div>`,
      onMount: (host, close) => {
        const g = $("[data-goto]", host);
        if (g) g.onclick = () => { close(); openDevice(g.dataset.goto); };
      },
    });
  }

  /* --- aba conexões --- */
  function connTab(e) {
    const list = connectionsOf(e.id);
    if (!list.length) {
      return `<div class="empty"><span class="empty-icon">${icon("link")}</span>
        <b>Sem enlaces cadastrados</b><p>Este equipamento ainda não possui conexões documentadas na topologia.</p></div>`;
    }
    return `<div class="stack">${list.map((c) => {
      const saida = c.origem === e.id;
      const remoto = device(saida ? c.destino : c.origem);
      return `<div class="card" style="padding:var(--s-4)">
        <div class="row-between">
          <div class="row" style="gap:var(--s-3)">
            <span class="badge badge-info">${esc(c.tipo || "Enlace")}</span>
            <div><b>${esc(remoto?.nome || (saida ? c.destino : c.origem))}</b>
              <br><small class="dim">porta ${saida ? c.portaOrigem : c.portaDestino} → porta ${saida ? c.portaDestino : c.portaOrigem}</small>
              <br><small class="dim">${esc(siteById(siteOf(remoto || e))?.nome || "")}</small></div>
          </div>
          <div class="row">
            <span class="badge">${esc(c.capacidade || "A confirmar")}</span>
            <button class="btn btn-sm" type="button" data-focus="${esc(remoto?.id || "")}">Ver no mapa</button>
          </div>
        </div>
      </div>`;
    }).join("")}</div>`;
  }
  function wireConn(root, close) {
    $$("[data-focus]", root).forEach((b) => (b.onclick = () => {
      if (!b.dataset.focus) return;
      close();
      state.expanded.add(siteOf(device(b.dataset.focus)));
      state.selected = b.dataset.focus;
      layout();
      renderAll();
      centerOn(b.dataset.focus);
    }));
  }

  /* --- aba ficha técnica --- */
  function sheetTab(e) {
    return `
      <form id="sheetForm" class="stack">
        <div class="row-between">
          <h3 style="font-size:var(--fs-13)">Dados cadastrais</h3>
          <button class="btn btn-sm" type="button" data-editmode ${canEdit ? "" : "disabled"}>${icon("edit")} Editar</button>
        </div>
        <div class="field"><label for="fNome">Nome</label><input class="input" id="fNome" value="${esc(e.nome)}" disabled></div>
        <div class="field"><label for="fModelo">Modelo</label><input class="input" id="fModelo" value="${esc(e.modelo || "")}" disabled></div>
        <div class="row" style="gap:var(--s-3);align-items:flex-start">
          <div class="field grow"><label for="fCat">Categoria</label><input class="input" id="fCat" value="${esc(e.categoria || "")}" disabled></div>
          <div class="field grow"><label for="fPop">POP vinculado</label>
            <select class="select" id="fPop" disabled>
              <option value="">— Sem POP vinculado —</option>
              ${POPS().map((p) => `<option value="${esc(p.id)}" ${e.popId === p.id ? "selected" : ""}>${esc(p.nome)}</option>`).join("")}
            </select>
            <span class="field-hint">Um equipamento pertence a um único POP. O Dashboard NOC agrupa por esse campo.</span>
          </div>
        </div>
        <div class="field"><label for="fObs">Observação operacional</label>
          <textarea class="textarea" id="fObs" disabled>${esc(e.observacao || "")}</textarea></div>

        <div class="row-between" id="sheetActions" hidden>
          <span class="dim" style="font-size:var(--fs-11)">${icon("info")} A alteração vai para a auditoria com estado anterior e posterior.</span>
          <span class="row">
            <button class="btn" type="button" data-cancel>Cancelar</button>
            <button class="btn btn-primary" type="submit">Salvar alterações</button>
          </span>
        </div>

        <hr>
        <div class="row-between">
          <div><b style="font-size:var(--fs-13)">Remover equipamento</b>
            <p class="dim" style="font-size:var(--fs-11)">Remove o equipamento, as portas e os enlaces ligados a ele.</p></div>
          <button class="btn btn-danger btn-sm" type="button" data-delete ${canDelete ? "" : "disabled title='Requer a permissão topology.delete'"}>${icon("trash")} Remover</button>
        </div>
      </form>`;
  }

  // A edição usa o mesmo layout da leitura: os campos só destravam.
  document.addEventListener("click", (ev) => {
    const trigger = ev.target.closest("[data-editmode]");
    if (trigger) {
      const form = trigger.closest("#sheetForm");
      $$("input, textarea, select", form).forEach((i) => (i.disabled = false));
      $("#sheetActions", form).hidden = false;
      trigger.hidden = true;
      $("#fNome", form).focus();
      return;
    }
    const cancel = ev.target.closest("[data-cancel]");
    if (cancel) {
      const form = cancel.closest("#sheetForm");
      $$("input, textarea, select", form).forEach((i) => (i.disabled = true));
      $("#sheetActions", form).hidden = true;
      $("[data-editmode]", form).hidden = false;
      return;
    }
    const del = ev.target.closest("[data-delete]");
    if (del && !del.disabled) {
      const e = device(state.selected);
      if (!e) return;
      askConfirm({
        title: `Remover ${e.nome}?`,
        text: `${e.portas.length} portas e ${connectionsOf(e.id).length} enlaces deixam de existir na topologia. A ação fica registrada na auditoria.`,
        confirmLabel: "Remover equipamento",
        danger: true,
        onConfirm: () => toast("Remoção registrada", { text: `${e.nome} sairia da topologia. No protótipo nada é gravado.`, type: "warn" }),
      });
    }
  });

  document.addEventListener("submit", (ev) => {
    if (!ev.target.matches("#sheetForm")) return;
    ev.preventDefault();
    const e = device(state.selected);
    if (!e) return;
    const before = { nome: e.nome, modelo: e.modelo, categoria: e.categoria, local: e.local, popId: e.popId ?? null, observacao: e.observacao };
    e.nome = $("#fNome").value.trim() || e.nome;
    e.modelo = $("#fModelo").value.trim();
    e.categoria = $("#fCat").value.trim();
    e.observacao = $("#fObs").value.trim();
    const novoPop = $("#fPop").value || null;
    if (novoPop !== (e.popId ?? null)) setPop(e.id, novoPop, { silent: true });
    layout();
    renderAll();
    $$("#sheetForm input, #sheetForm textarea, #sheetForm select").forEach((i) => (i.disabled = true));
    $("#sheetActions").hidden = true;
    $("[data-editmode]").hidden = false;
    // Desfazer imediato: a saída de erro mais rápida possível.
    toast("Equipamento atualizado", {
      text: "Alteração registrada na auditoria.",
      type: "ok",
      action: {
        label: "Desfazer",
        run: () => { Object.assign(e, before); layout(); renderAll(); toast("Alteração desfeita", { type: "info" }); },
      },
    });
  });

  /* ---------- enlace individual ---------- */
  function openConnection(c) {
    if (!c) return;
    const a = device(c.origem), b = device(c.destino);
    modal({
      labelledBy: "connTitle",
      html: `
        <div class="modal-head">
          <div><span class="kicker">${icon("link")} Enlace da topologia</span>
            <h2 id="connTitle" style="margin-top:6px">${esc(a?.nome || c.origem)} ↔ ${esc(b?.nome || c.destino)}</h2></div>
          <button class="btn btn-ghost btn-icon" data-close type="button" aria-label="Fechar">${icon("close")}</button>
        </div>
        <div class="modal-body stack">
          <div class="kv">
            <div><label>Tipo</label><strong style="font-size:var(--fs-14)">${esc(c.tipo || "—")}</strong></div>
            <div><label>Capacidade</label><strong style="font-size:var(--fs-14)">${esc(c.capacidade || "A confirmar")}</strong></div>
            <div><label>Porta origem</label><strong>${c.portaOrigem}</strong></div>
            <div><label>Porta destino</label><strong>${c.portaDestino}</strong></div>
          </div>
          <div class="alert alert-info" style="animation:none">${icon("info")}
            <span>Quando a capacidade aparece como “A confirmar”, o dado ainda não foi validado no equipamento. O protótipo mantém a informação explícita em vez de inventar um valor.</span></div>
        </div>
        <div class="modal-foot">
          <span class="dim" style="font-size:var(--fs-11)">Enlace documentado na topologia</span>
          <span class="row">
            <button class="btn" data-open="${esc(c.origem)}" type="button">${esc(a?.nome || c.origem)}</button>
            <button class="btn btn-primary" data-open="${esc(c.destino)}" type="button">${esc(b?.nome || c.destino)}</button>
          </span>
        </div>`,
      onMount: (host, close) => {
        $$("[data-open]", host).forEach((btn) => (btn.onclick = () => { close(); openDevice(btn.dataset.open); }));
      },
    });
  }

  /* ---------- gerenciar rede ---------- */
  function openManage() {
    modal({
      wide: true,
      labelledBy: "mgTitle",
      html: `
        <div class="modal-head">
          <div><span class="kicker">Configuração da topologia</span>
            <h2 id="mgTitle" style="margin-top:6px">Gerenciar rede</h2>
            <p class="muted" style="font-size:var(--fs-13);margin-top:4px">Cadastre equipamentos, POPs e enlaces. Tudo passa pela API e vai para a auditoria.</p></div>
          <button class="btn btn-ghost btn-icon" data-close type="button" aria-label="Fechar">${icon("close")}</button>
        </div>
        <div class="modal-body stack">
          <div class="tabs" role="tablist">
            <button class="tab" role="tab" aria-selected="true" data-mt="vinculo">Vínculo com POP</button>
            <button class="tab" role="tab" aria-selected="false" data-mt="novo">Novo equipamento</button>
            <button class="tab" role="tab" aria-selected="false" data-mt="pops">Localidades</button>
            <button class="tab" role="tab" aria-selected="false" data-mt="enlaces">Enlaces</button>
          </div>
          <div id="mgBody"></div>
        </div>`,
      onMount: (host, close) => {
        const body = $("#mgBody", host);
        const popOptions = (sel) =>
          `<option value="">— Sem POP vinculado —</option>` +
          POPS().map((p) => `<option value="${esc(p.id)}" ${sel === p.id ? "selected" : ""}>${esc(p.nome)}</option>`).join("");

        const views = {
          /* Um equipamento pertence a um POP e só a um. Aqui se vincula,
             troca ou desvincula — e o Dashboard NOC segue esse vínculo. */
          vinculo: () => {
            const pendentes = devicesOf(SEM_POP).length;
            return `
            <div class="stack">
              ${pendentes ? `<div class="alert alert-warn" style="animation:none">${icon("alert")}
                <span><b>${pendentes} equipamento(s) sem POP.</b> Enquanto não forem vinculados, eles aparecem
                separados no Dashboard NOC e não entram na ocupação de nenhum POP.</span></div>` : ""}
              <div class="table-wrap" style="max-height:420px">
                <table class="table">
                  <thead><tr><th>Equipamento</th><th>Categoria</th><th style="min-width:220px">POP vinculado</th><th class="num">Portas</th><th></th></tr></thead>
                  <tbody>${D.equipamentos.map((e) => `<tr>
                    <td><b>${esc(e.nome)}</b><br><small class="dim">${esc(e.modelo || "—")}</small></td>
                    <td>${esc(e.categoria || "—")}</td>
                    <td>
                      <label class="sr-only" for="pop-${esc(e.id)}">POP de ${esc(e.nome)}</label>
                      <select class="select" id="pop-${esc(e.id)}" data-link="${esc(e.id)}" ${canEdit ? "" : "disabled"}>
                        ${popOptions(e.popId)}
                      </select>
                    </td>
                    <td class="num">${e.portas.length}</td>
                    <td><button class="btn btn-sm" type="button" data-unlink="${esc(e.id)}"
                          ${e.popId && canEdit ? "" : "disabled"} title="Desvincular do POP">Desvincular</button></td>
                  </tr>`).join("")}</tbody>
                </table>
              </div>
              <p class="dim" style="font-size:var(--fs-11)">
                ${icon("info")} A troca de vínculo é gravada na auditoria com o POP anterior e o novo.
              </p>
            </div>`;
          },
          novo: () => `
            <form class="stack" id="newDevice">
              <div class="row" style="gap:var(--s-3);align-items:flex-start">
                <div class="field grow"><label for="nNome">Nome *</label><input class="input" id="nNome" placeholder="Ex.: 6730 • POP Cubatão" required></div>
                <div class="field grow"><label for="nModelo">Modelo</label><input class="input" id="nModelo" placeholder="Ex.: Huawei CloudEngine S6730-H24X6C"></div>
              </div>
              <div class="row" style="gap:var(--s-3);align-items:flex-start">
                <div class="field grow"><label for="nCat">Categoria</label>
                  <select class="select" id="nCat">${[...new Set(D.equipamentos.map((e) => e.categoria))].map((c) => `<option>${esc(c)}</option>`).join("")}</select></div>
                <div class="field grow"><label for="nLocal">POP vinculado</label>
                  <select class="select" id="nLocal">${popOptions(null)}</select></div>
                <div class="field" style="width:130px"><label for="nPortas">Portas</label><input class="input" id="nPortas" type="number" min="1" max="96" value="24"></div>
              </div>
              <div class="field"><label for="nObs">Observação</label><textarea class="textarea" id="nObs" placeholder="Contexto operacional, licenciamento, pendências de confirmação…"></textarea></div>
              <div class="row-between">
                <span class="dim" style="font-size:var(--fs-11)">Campos marcados com * são obrigatórios.</span>
                <span class="row"><button class="btn" data-close type="button">Cancelar</button>
                <button class="btn btn-primary" type="submit" ${canEdit ? "" : "disabled"}>Cadastrar equipamento</button></span>
              </div>
            </form>`,
          pops: () => `
            <div class="table-wrap"><table class="table">
              <thead><tr><th>Localidade</th><th>Tipo</th><th class="num">Equipamentos</th><th class="num">Portas</th><th></th></tr></thead>
              <tbody>${sites().map((s) => {
                const st = siteStats(s.id);
                return `<tr>
                  <td><b>${esc(s.nome)}</b><br><small class="dim">${esc(s.local)}</small></td>
                  <td>${esc(s.tipo)}</td>
                  <td class="num">${st.list.length}</td>
                  <td class="num">${st.portas}</td>
                  <td><a class="btn btn-sm" href="pops.html?pop=${encodeURIComponent(s.id)}">Abrir</a></td>
                </tr>`;
              }).join("")}</tbody>
            </table></div>`,
          enlaces: () => `
            <div class="table-wrap"><table class="table">
              <thead><tr><th>Origem</th><th>Destino</th><th>Tipo</th><th>Capacidade</th></tr></thead>
              <tbody>${D.conexoes.map((c) => `<tr>
                <td><b>${esc(device(c.origem)?.nome || c.origem)}</b> <span class="dim mono">porta ${c.portaOrigem}</span></td>
                <td><b>${esc(device(c.destino)?.nome || c.destino)}</b> <span class="dim mono">porta ${c.portaDestino}</span></td>
                <td>${esc(c.tipo || "—")}</td>
                <td>${esc(c.capacidade || "A confirmar")}</td>
              </tr>`).join("")}</tbody>
            </table></div>`,
        };
        let cur = "vinculo";
        const paint = () => {
          $$("[data-mt]", host).forEach((t) => t.setAttribute("aria-selected", String(t.dataset.mt === cur)));
          body.innerHTML = views[cur]();

          // Vincular / desvincular sem sair da tela: o mapa e o dashboard
          // atrás já refletem a mudança, e cada ação pode ser desfeita.
          $$("[data-link]", body).forEach((sel) => (sel.onchange = () => {
            setPop(sel.dataset.link, sel.value);
            paint();
          }));
          $$("[data-unlink]", body).forEach((b) => (b.onclick = () => {
            setPop(b.dataset.unlink, null);
            paint();
          }));

          const form = $("#newDevice", body);
          if (form) form.onsubmit = (ev) => {
            ev.preventDefault();
            const nome = $("#nNome", form).value.trim();
            if (!nome) return $("#nNome", form).focus();
            const total = Math.max(1, Math.min(96, +$("#nPortas", form).value || 24));
            const popId = $("#nLocal", form).value || null;
            const novo = {
              id: "novo-" + Date.now(),
              nome,
              modelo: $("#nModelo", form).value.trim(),
              categoria: $("#nCat", form).value,
              popId,
              local: popId ? siteById(popId).nome : "Sem POP vinculado",
              observacao: $("#nObs", form).value.trim(),
              portas: Array.from({ length: total }, (_, i) => ({
                numero: i + 1, capacidade: "1 / 10 Gbps", tipo: "GE / 10GE", status: "livre", rx: 0, tx: 0, capacidadeGbps: 10,
              })),
              monitoramento: { status: "online", cpu: 14, memoria: 30, temperatura: 34, uptimeDias: 1, consumo: { value: 0, unit: "%" }, latenciaMs: 0.6 },
            };
            D.equipamentos.push(novo);
            state.expanded.add(siteOf(novo));
            close();
            layout();
            renderAll();
            toast("Equipamento cadastrado", {
              text: `${nome} entrou em ${novo.local} com ${total} portas.`,
              type: "ok",
              action: {
                label: "Desfazer",
                run: () => {
                  D.equipamentos = D.equipamentos.filter((x) => x.id !== novo.id);
                  window.MOCK.equipamentos = D.equipamentos;
                  layout();
                  renderAll();
                },
              },
            });
          };
        };
        $$("[data-mt]", host).forEach((t) => (t.onclick = () => { cur = t.dataset.mt; paint(); }));
        paint();
      },
    });
  }

  /* ---------- exportar ---------- */
  function openExport() {
    modal({
      labelledBy: "exTitle",
      html: `
        <div class="modal-head">
          <div><span class="kicker">${icon("download")} Exportação</span><h2 id="exTitle" style="margin-top:6px">Exportar topologia</h2></div>
          <button class="btn btn-ghost btn-icon" data-close type="button" aria-label="Fechar">${icon("close")}</button>
        </div>
        <div class="modal-body stack">
          <label class="radio"><input type="radio" name="fmt" checked><span><b>Inventário de portas (CSV)</b><small>Localidade, equipamento, porta, capacidade, status, enlace e tráfego.</small></span></label>
          <label class="radio"><input type="radio" name="fmt"><span><b>Topologia completa (JSON)</b><small>Equipamentos, POPs e conexões no formato da API.</small></span></label>
          <label class="radio"><input type="radio" name="fmt"><span><b>Relatório de capacidade (PDF)</b><small>Ocupação por localidade e projeção de esgotamento de portas.</small></span></label>
        </div>
        <div class="modal-foot">
          <span class="dim" style="font-size:var(--fs-11)">${D.equipamentos.length} equipamentos • ${D.equipamentos.reduce((a, e) => a + e.portas.length, 0)} portas</span>
          <span class="row"><button class="btn" data-close type="button">Cancelar</button>
          <button class="btn btn-primary" data-go type="button">Gerar arquivo</button></span>
        </div>`,
      onMount: (host, close) => {
        $("[data-go]", host).onclick = () => {
          close();
          toast("Exportação em preparo", { text: "No sistema real o arquivo é gerado pelo Worker e baixado aqui.", type: "info" });
        };
      },
    });
  }

  /* ---------- render geral ---------- */
  function renderAll() {
    renderList();
    renderSites();
    renderEdges();
    renderTable();
  }

  /* ---------- inicialização ---------- */
  UI.mountShell({ active: "topologia" });
  $("#iconSearch").innerHTML = icon("search");
  $("#zoomIn").innerHTML = icon("zoomIn");
  $("#zoomOut").innerHTML = icon("zoomOut");
  $("#zoomFit").innerHTML = icon("fit");
  $("#toggleSide").innerHTML = icon("chevronLeft");
  $("#btnExport").innerHTML = icon("download") + " Exportar";
  $("#btnManage").innerHTML = icon("plus") + " Gerenciar rede";

  if (!canEdit) {
    const b = $("#btnManage");
    b.disabled = true;
    b.title = `O perfil ${role} não possui a permissão topology.edit`;
  }

  renderFilters();
  layout();
  renderAll();
  bindStage();
  requestAnimationFrame(fit);

  let resizeTimer = null;
  addEventListener("resize", () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => { if (state.view === "mapa") fit(); }, 160);
  });

  $("#deviceSearch").addEventListener("input", (e) => {
    state.query = e.target.value.trim().toLowerCase();
    renderAll();
  });
  $("#clearFilters").onclick = () => {
    state.query = "";
    state.cats.clear();
    $("#deviceSearch").value = "";
    renderFilters();
    renderAll();
  };
  $("#toggleSide").onclick = () => {
    const hidden = $("#topoMain").classList.toggle("is-side-hidden");
    $("#toggleSide").innerHTML = icon(hidden ? "chevronRight" : "chevronLeft");
    $("#toggleSide").setAttribute("aria-label", hidden ? "Mostrar lista de equipamentos" : "Ocultar lista de equipamentos");
    setTimeout(fit, 60);
  };
  $("#toggleFlow").onclick = () => {
    state.flow = !state.flow;
    $("#toggleFlow").setAttribute("aria-pressed", String(state.flow));
    renderEdges();
  };
  $("#expandAll").onclick = () => {
    const abrir = state.expanded.size < visibleSites().filter((s) => devicesOf(s.id).length).length;
    state.expanded = abrir ? new Set(visibleSites().filter((s) => devicesOf(s.id).length).map((s) => s.id)) : new Set();
    $("#expandAll").textContent = abrir ? "Recolher tudo" : "Expandir tudo";
    fit();
    renderList();
  };
  $("#btnManage").onclick = openManage;
  $("#btnExport").onclick = openExport;

  $$("[data-view]").forEach((b) => (b.onclick = () => {
    state.view = b.dataset.view;
    $$("[data-view]").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
    const mapa = state.view === "mapa";
    $("#stage").hidden = !mapa;
    $(".topo-side").hidden = !mapa;
    $("#listView").hidden = mapa;
    if (mapa) setTimeout(fit, 30);
  }));

  // Abertura direta por link: topologia.html?device=f1a  |  ?site=ascenty
  const params = new URLSearchParams(location.search);
  const wanted = params.get("device");
  const wantedSite = params.get("site");
  if (wanted && device(wanted)) {
    state.expanded.add(siteOf(device(wanted)));
    state.selected = wanted;
    setTimeout(() => { layout(); renderAll(); centerOn(wanted); openDevice(wanted); }, 260);
  } else if (wantedSite && siteById(wantedSite)) {
    state.expanded.add(wantedSite);
    setTimeout(() => { layout(); renderAll(); centerOnBox(wantedSite); }, 260);
  }
})();
