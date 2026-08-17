/* ============================================================
   UPDOWN NOC — Topologia (aplicação real)
   Mapa em dois níveis: POP → equipamentos → portas.
   Lê e grava por /api/topology, respeitando RBAC e auditoria.
   ============================================================ */
(() => {
  "use strict";
  const { $, $$, esc, icon, toast, drawer, modal, confirm: askConfirm } = UI;

  const SEM_POP = "__sem-pop__";
  const GRID = 8; // arrasto encaixa nesta malha, para o mapa não ficar torto
  const state = {
    query: "", cats: new Set(), selected: null,
    expanded: new Set(),
    scale: 1, tx: 0, ty: 0, flow: true, view: "mapa",
    boxes: {}, nodes: {}, world: { w: 1, h: 1, fit: 1 },
    /* layout: posições manuais dos POPs, gravadas em config.layout e válidas
       para todos os usuários. Vazio = posicionamento automático. */
    editLayout: false, layout: {}, layoutDirty: false, dragEndAt: 0,
  };
  let repaintDevice = null; // repinta a gaveta aberta depois de editar uma porta

  /* Cada funcionalidade da tela exige a sua ação, do mesmo jeito que o Worker
     verifica na gravação — os nomes são os do catálogo em Plataforma → Perfis.
     topology.edit/delete continuam sendo a base de qualquer escrita. */
  const podeCriarEquipamento = () => NOC.canAll(["topology.edit", "topology.equipment.create"]);
  const podeEditarEquipamento = () => NOC.canAll(["topology.edit", "topology.equipment.edit"]);
  const podeExcluirEquipamento = () => NOC.canAll(["topology.delete", "topology.equipment.delete"]);
  const podeEditarPorta = () => NOC.canAll(["topology.edit", "topology.port.edit"]);
  const podeCriarEnlace = () => NOC.canAll(["topology.edit", "topology.link.create"]);
  const podeRemoverEnlace = () => NOC.canAll(["topology.delete", "topology.link.delete"]);
  const podeVincularPop = () => NOC.canAll(["topology.edit", "topology.pop.link"]);
  const podeCriarPop = () => NOC.canAll(["topology.edit", "pops.create"]);

  const device = (id) => (NOC.data()?.equipamentos || []).find((e) => e.id === id);
  const sites = () => [
    ...NOC.pops().map((p) => ({ id: p.id, nome: p.nome, local: (p.rotas || []).length + " rota(s)", tipo: "POP" })),
    { id: SEM_POP, nome: "SEM POP VINCULADO", local: "Equipamentos aguardando vínculo", tipo: "Pendente" },
  ];
  const siteById = (id) => sites().find((s) => s.id === id);
  const siteOf = (e) => NOC.effectivePop(e) || SEM_POP;
  const devicesOf = (siteId) => (NOC.data()?.equipamentos || []).filter((e) => siteOf(e) === siteId);
  const visibleSites = () => sites().filter((s) => s.id !== SEM_POP || devicesOf(SEM_POP).length);

  const matches = (e) => {
    const okCat = !state.cats.size || state.cats.has(e.categoria || "Outros");
    if (!okCat) return false;
    if (!state.query) return true;
    const hay = [e.nome, e.modelo, e.categoria, e.local, ...(e.portas || []).map((p) => p.capacidade)].join(" ").toLowerCase();
    return hay.includes(state.query);
  };

  function siteStats(siteId) {
    const list = devicesOf(siteId);
    return { list, ...NOC.statsOf(list) };
  }

  /* ---------------- gravação com desfazer ---------------- */
  async function persist(reason, mensagem, undo) {
    try {
      await NOC.save(reason);
      layout();
      renderAll();
      toast(mensagem.titulo, {
        text: mensagem.texto,
        type: mensagem.tipo || "ok",
        action: undo ? { label: "Desfazer", run: undo } : null,
      });
      return true;
    } catch (err) {
      layout();
      renderAll();
      toast("Não foi possível salvar", { text: err.message, type: "danger", timeout: 7000 });
      return false;
    }
  }

  async function vincular(deviceId, popId) {
    const e = device(deviceId);
    if (!e) return;
    const antes = e.popId ?? null;
    e.popId = popId || null;
    if (popId) state.expanded.add(popId);
    await persist(
      popId ? "TOPOLOGY_LINK_POP" : "TOPOLOGY_UNLINK_POP",
      {
        titulo: popId ? `${e.nome} vinculado a ${siteById(popId)?.nome || ""}` : `${e.nome} desvinculado`,
        texto: popId
          ? "O equipamento passa a contar nos indicadores desse POP no Dashboard NOC."
          : "Ele sai dos indicadores do POP e vai para a lista de pendentes do Dashboard.",
        tipo: popId ? "ok" : "warn",
      },
      async () => { e.popId = antes; await persist("TOPOLOGY_LINK_POP", { titulo: "Vínculo revertido", tipo: "info" }); }
    );
  }

  /* ---------------- filtros e listas ---------------- */
  function renderFilters() {
    const eqs = NOC.data()?.equipamentos || [];
    const cats = [...new Set(eqs.map((e) => e.categoria || "Outros"))];
    $("#catFilters").innerHTML = cats.map((c) => {
      const n = eqs.filter((e) => (e.categoria || "Outros") === c).length;
      return `<button class="chip" type="button" data-cat="${esc(c)}" aria-pressed="${state.cats.has(c)}">${esc(c)} <span class="count">${n}</span></button>`;
    }).join("");
    $$("#catFilters .chip").forEach((b) => (b.onclick = () => {
      const c = b.dataset.cat;
      state.cats.has(c) ? state.cats.delete(c) : state.cats.add(c);
      renderFilters();
      renderAll();
    }));
  }

  function renderList() {
    const eqs = NOC.data()?.equipamentos || [];
    $("#listCount").textContent = `${eqs.filter(matches).length} de ${eqs.length} equipamentos`;

    const html = visibleSites().map((s) => {
      const list = devicesOf(s.id).filter(matches);
      if (!list.length) return "";
      return `<div class="list-group">
        <div class="list-group-head">
          <span>${esc(s.nome)}</span>
          <button class="btn btn-ghost btn-sm" type="button" data-site-jump="${esc(s.id)}">${state.expanded.has(s.id) ? "Recolher" : "Expandir"}</button>
        </div>
        ${list.map((e) => {
          const o = NOC.occupancy(e);
          return `<button class="device-item" type="button" data-id="${esc(e.id)}" aria-current="${state.selected === e.id}">
            <span class="row-between"><b>${esc(e.nome)}</b>${NOC.isSuggested(e) ? '<span class="badge badge-warn">sugerido</span>' : ""}</span>
            <small>${esc(e.modelo || "Modelo não informado")}</small>
            <span class="row" style="gap:var(--s-2);margin-top:6px">
              <span class="meter meter-sm ${NOC.occClass(o)} grow"><span style="width:${o}%"></span></span>
              <small class="mono dim">${NOC.usedPorts(e)}/${e.portas.length}</small>
            </span>
          </button>`;
        }).join("")}
      </div>`;
    }).join("");

    $("#deviceList").innerHTML = html || `<div class="empty">
      <span class="empty-icon">${icon("search")}</span><b>Nenhum equipamento encontrado</b>
      <p>Ajuste a busca ou remova os filtros de categoria.</p></div>`;

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

  function renderTable() {
    const rows = (NOC.data()?.equipamentos || []).filter(matches);
    $("#listBody").innerHTML = rows.map((e) => {
      const o = NOC.occupancy(e);
      const pop = siteById(siteOf(e));
      return `<tr>
        <td><b>${esc(e.nome)}</b><br><small class="dim">${esc(e.modelo || "—")}</small></td>
        <td>${esc(pop?.nome || "—")}${NOC.isSuggested(e) ? ' <span class="badge badge-warn">sugerido</span>' : ""}</td>
        <td>${esc(e.categoria || "—")}</td>
        <td class="num">${e.portas.length}</td>
        <td class="num">${NOC.usedPorts(e)}</td>
        <td class="num">${e.portas.length - NOC.usedPorts(e)}</td>
        <td><span class="row" style="gap:var(--s-2)"><span class="meter meter-sm ${NOC.occClass(o)} grow"><span style="width:${o}%"></span></span><small class="mono">${o}%</small></span></td>
        <td><button class="btn btn-sm" type="button" data-open="${esc(e.id)}">Detalhes</button></td>
      </tr>`;
    }).join("");
    $$("#listBody [data-open]").forEach((b) => (b.onclick = () => openDevice(b.dataset.open)));
  }

  /* ================= MAPA ================= */
  const SITE_W = 268, SITE_H = 156, DEV_W = 190, DEV_H = 118;
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

  /* Reposiciona os equipamentos de um POP a partir da caixa dele. Usado no
     cálculo geral e a cada quadro do arrasto, para as linhas acompanharem. */
  function placeNodes(siteId, nodes = state.nodes) {
    const b = state.boxes[siteId];
    const list = devicesOf(siteId);
    if (!b || !state.expanded.has(siteId) || !list.length) return;
    const cols = Math.min(3, list.length);
    list.forEach((e, i) => {
      nodes[e.id] = {
        x: b.x + PAD + (i % cols) * (DEV_W + GAP),
        y: b.y + HEAD + Math.floor(i / cols) * (DEV_H + GAP),
        w: DEV_W, h: DEV_H,
      };
    });
  }

  function layout() {
    const st = stage().getBoundingClientRect();
    const sizes = visibleSites().map((s) => ({ site: s, ...siteSize(s) }));
    if (!sizes.length) { state.boxes = {}; state.nodes = {}; return; }
    const totalW = sizes.reduce((a, s) => a + s.w, 0) + SITE_GAP * (sizes.length - 1);
    const targetW = Math.max(900, Math.min(totalW, Math.max(st.width, 900) * 1.25));

    const boxes = {};
    let x = 0, y = 0, rowH = 0;
    sizes.forEach((s) => {
      // POP com posição gravada sai do fluxo automático e fica onde o admin deixou.
      const fixo = state.layout[s.site.id];
      if (fixo) {
        boxes[s.site.id] = { x: Math.max(0, +fixo.x || 0), y: Math.max(0, +fixo.y || 0), w: s.w, h: s.h, fixo: true };
        return;
      }
      if (x > 0 && x + s.w > targetW) { x = 0; y += rowH + SITE_GAP; rowH = 0; }
      boxes[s.site.id] = { x, y, w: s.w, h: s.h };
      rowH = Math.max(rowH, s.h);
      x += s.w + SITE_GAP;
    });

    const cantos = Object.values(boxes);
    const maxW = Math.max(...cantos.map((b) => b.x + b.w));
    const worldH = Math.max(...cantos.map((b) => b.y + b.h));

    state.boxes = boxes;
    state.nodes = {};
    visibleSites().forEach((s) => placeNodes(s.id));

    state.world = {
      w: maxW, h: worldH,
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
  const resolve = (key) => {
    if (key.startsWith("d:")) {
      const n = state.nodes[key.slice(2)];
      return n ? { x: n.x + n.w / 2, y: n.y + n.h / 2 } : null;
    }
    return boxCenter(key.slice(2));
  };

  function curve(a, b) {
    const dx = Math.abs(b.x - a.x), dy = Math.abs(b.y - a.y);
    if (dy > dx) {
      const my = (a.y + b.y) / 2;
      return `M ${a.x} ${a.y} C ${a.x} ${my}, ${b.x} ${my}, ${b.x} ${b.y}`;
    }
    const mx = (a.x + b.x) / 2;
    return `M ${a.x} ${a.y} C ${mx} ${a.y}, ${mx} ${b.y}, ${b.x} ${b.y}`;
  }

  function edgesToDraw() {
    const out = new Map();
    (NOC.data()?.conexoes || []).forEach((c) => {
      const da = device(c.origem), db = device(c.destino);
      if (!da || !db) return;
      const sa = siteOf(da), sb = siteOf(db);
      const aOpen = state.expanded.has(sa), bOpen = state.expanded.has(sb);
      if (sa === sb && !aOpen) return;
      const ka = aOpen ? "d:" + c.origem : "s:" + sa;
      const kb = bOpen ? "d:" + c.destino : "s:" + sb;
      if (ka === kb) return;
      const key = [ka, kb].sort().join("→");
      const item = out.get(key) || { key, ka, kb, conns: [] };
      item.conns.push(c);
      out.set(key, item);
    });
    return [...out.values()];
  }

  /* Rotas do anel a partir do cadastro de POPs (campo rotas). */
  function ringLinks() {
    const pops = NOC.pops();
    const norm = (s) => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
    const map = new Map();
    pops.forEach((p) => (p.rotas || []).forEach((r) => {
      const destino = pops.find((q) => q.id !== p.id && norm(r).includes(norm(q.nome).replace(/^pop\s*/, "").trim()));
      if (!destino) return;
      const key = [p.id, destino.id].sort().join("|");
      const cur = map.get(key) || { a: key.split("|")[0], b: key.split("|")[1], tipos: new Set() };
      cur.tipos.add(/subterr/i.test(r) ? "Subterrânea" : "Aérea");
      map.set(key, cur);
    }));
    return [...map.values()];
  }

  function renderEdges() {
    const parts = [];
    const rings = ringLinks();
    rings.forEach((r, i) => {
      const a = boxCenter(r.a), b = boxCenter(r.b);
      if (!a || !b) return;
      parts.push(`<path class="topo-edge is-ring" d="${curve(a, b)}" data-ring="${i}">
        <title>Anel óptico — ${[...r.tipos].join(" e ")}</title></path>`);
    });

    const list = edgesToDraw();
    list.forEach((e, i) => {
      const a = resolve(e.ka), b = resolve(e.kb);
      if (!a || !b) return;
      const envolve = (k) => (state.selected ? k === "d:" + state.selected || k === "s:" + siteOf(device(state.selected) || {}) : false);
      const active = state.selected && (envolve(e.ka) || envolve(e.kb));
      const dim = state.selected && !active;
      const d = curve(a, b);
      const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
      const label = e.conns.length > 1 ? `${e.conns.length} enlaces` : `${e.conns[0].portaOrigem} ↔ ${e.conns[0].portaDestino}`;
      parts.push(`
        <path class="topo-edge ${active ? "is-active" : ""} ${dim ? "is-dim" : ""}" d="${d}" data-edge="${i}"><title>${esc(label)}</title></path>
        ${state.flow && !dim ? `<path class="topo-flow" d="${d}"/>` : ""}
        <g data-edge="${i}" style="${dim ? "opacity:.22" : ""}">
          <rect class="topo-edge-chip" x="${mx - 44}" y="${my - 26}" width="88" height="19" rx="6"/>
          <text class="topo-edge-label" x="${mx}" y="${my - 12}" text-anchor="middle">${esc(label)}</text>
        </g>`);
    });

    const svg = $("#edges");
    svg.innerHTML = parts.join("");
    $$("[data-edge]", svg).forEach((el) => {
      el.style.cursor = "pointer";
      el.addEventListener("click", () => openEdge(list[+el.dataset.edge]));
    });
    $$("[data-ring]", svg).forEach((el) => {
      el.style.cursor = "pointer";
      el.addEventListener("click", () => openRing(rings[+el.dataset.ring]));
    });
  }

  function renderSites() {
    const host = $("#nodes");
    host.innerHTML = visibleSites().map((s) => {
      const b = state.boxes[s.id];
      if (!b) return "";
      const st = siteStats(s.id);
      const aberto = state.expanded.has(s.id);
      const temEquip = st.list.length > 0;
      const dim = state.query && !st.list.some(matches);
      const pendente = s.id === SEM_POP;

      const devicesHtml = aberto ? st.list.map((e) => {
        const n = state.nodes[e.id];
        if (!n) return "";
        const o = NOC.occupancy(e);
        const fade = !matches(e) || (state.selected && state.selected !== e.id && !isNeighbor(e.id));
        return `<button class="topo-device ${state.selected === e.id ? "is-active" : ""} ${fade ? "is-dim" : ""}"
                  type="button" data-id="${esc(e.id)}" style="left:${n.x - b.x}px;top:${n.y - b.y}px"
                  aria-label="${esc(e.nome)}, ${NOC.usedPorts(e)} de ${e.portas.length} portas em uso">
          <span class="row-between"><span class="badge">${esc(e.categoria || "")}</span>${NOC.isSuggested(e) ? '<span class="badge badge-warn">sugerido</span>' : ""}</span>
          <b class="truncate">${esc(e.nome)}</b>
          <small class="truncate dim">${esc(e.modelo || "")}</small>
          <span class="meter meter-sm ${NOC.occClass(o)}"><span style="width:${o}%"></span></span>
          <span class="row-between mono" style="font-size:var(--fs-10);color:var(--text-3)">
            <span>${NOC.usedPorts(e)}/${e.portas.length} portas</span><span>${o}%</span></span>
        </button>`;
      }).join("") : "";

      const posicionado = !!state.layout[s.id];
      return `<section class="topo-site ${aberto ? "is-expanded" : ""} ${pendente ? "" : "is-core"} ${dim ? "is-dim" : ""} ${state.editLayout && posicionado ? "is-placed" : ""}"
                data-box="${esc(s.id)}" style="left:${b.x}px;top:${b.y}px;width:${b.w}px;height:${b.h}px">
        ${state.editLayout ? `<span class="site-grip">${icon("sort")} arraste</span>` : ""}
        <button class="site-head" type="button" data-site="${esc(s.id)}" aria-expanded="${aberto}"
                ${temEquip ? "" : 'data-empty="1"'}
                ${temEquip || state.editLayout ? "" : 'disabled title="Nenhum equipamento vinculado a este POP"'}>
          <span class="site-chevron">${icon(aberto ? "chevronDown" : "chevronRight")}</span>
          <span class="grow" style="min-width:0">
            <span class="row" style="gap:6px">
              <span class="badge ${pendente ? "badge-warn" : "badge-brand"}">${esc(s.tipo)}</span>
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
          <span class="meter meter-sm ${NOC.occClass(st.ocup)} grow"><span style="width:${st.ocup}%"></span></span>
          <small class="mono dim">${st.emUso}/${st.portas}</small></div>`}
        ${devicesHtml}
      </section>`;
    }).join("");

    $$("[data-site]", host).forEach((b) => (b.onclick = () => {
      if (performance.now() - state.dragEndAt < 300) return; // clique que veio do arrasto
      if (b.dataset.empty) return;
      toggleSite(b.dataset.site);
    }));
    $$(".topo-device", host).forEach((b) => (b.onclick = () => {
      if (state.editLayout) return; // no modo layout o clique não abre a gaveta
      state.selected = b.dataset.id;
      renderAll();
      openDevice(b.dataset.id);
    }));
    if (state.editLayout) $$("[data-box]", host).forEach((el) => bindSiteDrag(el, el.dataset.box));
  }

  /* ---------------- arrastar POPs (edição de layout) ---------------- */
  function bindSiteDrag(el, siteId) {
    const handle = $(".site-head", el) || el;
    let arrastando = false, movido = false, sx = 0, sy = 0, ox = 0, oy = 0, quadro = null;

    handle.addEventListener("pointerdown", (ev) => {
      if (!state.editLayout || ev.button !== 0) return;
      const b = state.boxes[siteId];
      if (!b) return;
      ev.preventDefault();
      ev.stopPropagation();
      arrastando = true; movido = false;
      sx = ev.clientX; sy = ev.clientY; ox = b.x; oy = b.y;
      try { handle.setPointerCapture(ev.pointerId); } catch (e) { /* navegador antigo */ }
      el.classList.add("is-dragging");
    });

    handle.addEventListener("pointermove", (ev) => {
      if (!arrastando) return;
      const b = state.boxes[siteId];
      if (!b) return;
      if (Math.abs(ev.clientX - sx) + Math.abs(ev.clientY - sy) > 4) movido = true;
      // o mundo está escalado: o deslocamento da tela vira deslocamento do mapa
      b.x = Math.max(0, Math.round((ox + (ev.clientX - sx) / state.scale) / GRID) * GRID);
      b.y = Math.max(0, Math.round((oy + (ev.clientY - sy) / state.scale) / GRID) * GRID);
      el.style.left = b.x + "px";
      el.style.top = b.y + "px";
      placeNodes(siteId);
      if (!quadro) quadro = requestAnimationFrame(() => { quadro = null; renderEdges(); });
    });

    const soltar = () => {
      if (!arrastando) return;
      arrastando = false;
      el.classList.remove("is-dragging");
      if (!movido) return;
      const b = state.boxes[siteId];
      state.layout[siteId] = { x: b.x, y: b.y };
      state.layoutDirty = true;
      state.dragEndAt = performance.now();
      layout();
      renderAll();
      renderLayoutBar();
    };
    handle.addEventListener("pointerup", soltar);
    handle.addEventListener("pointercancel", soltar);
  }

  function renderLayoutBar() {
    const bar = $("#layoutBar");
    if (!bar) return;
    bar.hidden = !state.editLayout;
    const n = Object.keys(state.layout).length;
    $("#layoutStatus").textContent = state.layoutDirty
      ? "alterações ainda não salvas"
      : n ? `${n} POP(s) com posição própria` : "arraste os POPs para posicionar";
    $("#layoutSave").disabled = !state.layoutDirty;
    $("#layoutDiscard").disabled = !state.layoutDirty;
    $("#layoutAuto").disabled = !n;
    const b = $("#btnLayout");
    b.setAttribute("aria-pressed", String(state.editLayout));
    b.textContent = state.editLayout ? "Sair do layout" : "Editar layout";
    stage().classList.toggle("is-editing-layout", state.editLayout);
  }

  function setLayoutEdit(on) {
    state.editLayout = on;
    if (!on) state.selected = null;
    renderLayoutBar();
    layout();
    renderAll();
  }

  function toggleLayoutEdit() {
    if (state.editLayout && state.layoutDirty) {
      askConfirm({
        title: "Sair sem salvar as posições?",
        text: "Os POPs voltam para onde estavam na última gravação.",
        confirmLabel: "Descartar alterações",
        danger: true,
        onConfirm: () => { discardLayout(); setLayoutEdit(false); },
      });
      return;
    }
    setLayoutEdit(!state.editLayout);
    if (state.editLayout) toast("Modo de layout ativo", {
      text: "Arraste a caixa de cada POP e depois clique em “Salvar posições”.",
      type: "info",
    });
  }

  function discardLayout() {
    state.layout = { ...(NOC.data()?.config?.layout || {}) };
    state.layoutDirty = false;
    layout();
    renderAll();
    renderLayoutBar();
    fit();
  }

  async function saveLayout() {
    const antes = { ...(NOC.data()?.config?.layout || {}) };
    const depois = { ...state.layout };
    const gravar = async (posicoes) => {
      const t = NOC.data();
      t.config = { ...(t.config || {}), layout: posicoes };
      state.layout = { ...posicoes };
      state.layoutDirty = false;
    };
    await gravar(depois);
    const ok = await persist(
      "TOPOLOGY_LAYOUT",
      { titulo: "Layout do mapa salvo", texto: "As posições valem para todos os usuários da topologia." },
      async () => {
        await gravar(antes);
        await persist("TOPOLOGY_LAYOUT", { titulo: "Layout anterior restaurado", tipo: "info" });
      }
    );
    if (!ok) state.layoutDirty = true;
    renderLayoutBar();
  }

  const isNeighbor = (id) => {
    if (!state.selected || state.selected === id) return true;
    return NOC.connectionsOf(state.selected).some((c) => c.origem === id || c.destino === id);
  };

  function toggleSite(id) {
    const abrindo = !state.expanded.has(id);
    abrindo ? state.expanded.add(id) : state.expanded.delete(id);
    layout();
    renderAll();
    if (abrindo) centerOnBox(id); else fit();
  }

  /* ---------------- zoom / pan ---------------- */
  function applyTransform(animate = true) {
    const w = world();
    w.classList.toggle("no-anim", !animate);
    w.style.transform = `translate(${state.tx}px, ${state.ty}px) scale(${state.scale})`;
    $("#zoomLabel").textContent = Math.round(state.scale * 100) + "%";
  }
  function setScale(next, originX, originY) {
    const s = Math.min(2, Math.max(0.25, next));
    const st = stage().getBoundingClientRect();
    const cx = originX ?? st.width / 2, cy = originY ?? st.height / 2;
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
    state.scale = Math.max(0.4, Math.min(0.9, (st.width - 120) / b.w, (st.height - 120) / b.h));
    state.tx = st.width / 2 - (b.x + b.w / 2) * state.scale;
    state.ty = st.height / 2 - (b.y + b.h / 2) * state.scale;
    applyTransform();
  }
  function centerOn(id) {
    const n = state.nodes[id];
    const a = n ? { x: n.x + DEV_W / 2, y: n.y + DEV_H / 2 } : boxCenter(siteOf(device(id) || {}));
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
    const ignore = ".topo-device, .site-head, .topo-hud, [data-edge], [data-ring]";
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

  /* ---------------- gaveta do equipamento ---------------- */
  function openDevice(id) {
    const e = device(id);
    if (!e) return;
    state.selected = id;
    renderSites();
    renderEdges();
    renderList();

    const o = NOC.occupancy(e);
    const s = NOC.statusInfo(e);
    const pop = siteById(siteOf(e));

    drawer({
      labelledBy: "devTitle",
      html: `
        <header class="drawer-head">
          <div class="row-between" style="align-items:flex-start">
            <div>
              <span class="kicker">${esc(pop?.nome || "Sem POP")} • ${esc(e.categoria || "Equipamento")}</span>
              <h2 id="devTitle" style="margin:6px 0 4px">${esc(e.nome)}</h2>
              <p class="muted" style="font-size:var(--fs-13)">${esc(e.modelo || "Modelo não informado")}</p>
            </div>
            <button class="btn btn-ghost btn-icon" data-close type="button" aria-label="Fechar detalhe">${icon("close")}</button>
          </div>
          <div class="row wrap" style="gap:6px;margin-top:var(--s-4)">
            <span class="badge ${s.badge}">${s.dot ? `<i class="dot ${s.dot}"></i>` : ""}${s.label}</span>
            <span class="badge">${e.portas.length} portas</span>
            <span class="badge ${o > 85 ? "badge-danger" : o > 60 ? "badge-warn" : "badge-info"}">${o}% ocupado</span>
            ${NOC.isSuggested(e) ? '<span class="badge badge-warn">vínculo sugerido</span>' : ""}
          </div>
          <div class="tabs" style="margin-top:var(--s-4)" role="tablist" aria-label="Seções do equipamento">
            <button class="tab" role="tab" aria-selected="true" data-tab="portas">Portas</button>
            <button class="tab" role="tab" aria-selected="false" data-tab="conexoes">Conexões <span class="badge">${NOC.connectionsOf(id).length}</span></button>
            ${NOC.can("topology.connection.use") ? '<button class="tab" role="tab" aria-selected="false" data-tab="acesso">Conexão</button>' : ""}
            <button class="tab" role="tab" aria-selected="false" data-tab="ficha">Ficha</button>
          </div>
        </header>
        <div class="drawer-body" id="devBody"></div>
        <footer class="drawer-foot">
          <span class="dim" style="font-size:var(--fs-11)">${podeEditarEquipamento() ? "Alterações são auditadas com usuário, IP e data/hora." : "Seu perfil tem acesso somente de leitura."}</span>
          <span class="row">
            <a class="btn btn-sm" href="/legado.html">Editor clássico</a>
            <button class="btn btn-sm btn-primary" data-edit type="button" ${podeEditarEquipamento() ? "" : "disabled title='Requer as ações topology.edit + topology.equipment.edit'"}>Editar</button>
          </span>
        </footer>`,
      onMount: (host, close) => {
        const body = $("#devBody", host);
        let tab = "portas";
        const paint = () => {
          body.dataset.activeTab = tab;
          $$(".tab", host).forEach((t) => t.setAttribute("aria-selected", String(t.dataset.tab === tab)));
          body.innerHTML = tab === "portas" ? portsTab(e) : tab === "conexoes" ? connTab(e) : tab === "acesso" ? "" : sheetTab(e);
          if (tab === "portas") wirePorts(e, body);
          if (tab === "conexoes") wireConn(e, body, close);
          if (tab === "acesso") loadConnectionTab(e, body);
          if (tab === "ficha") wireSheet(e, body);
        };
        $$(".tab", host).forEach((t) => (t.onclick = () => { tab = t.dataset.tab; paint(); }));
        $("[data-edit]", host).onclick = () => { tab = "ficha"; paint(); setTimeout(() => $("[data-editmode]", body)?.click(), 0); };
        // Editar uma porta muda contagens e enlaces: a gaveta se repinta sozinha.
        repaintDevice = () => { if (document.body.contains(body)) paint(); };
        paint();
      },
    });
  }

  function portsTab(e) {
    const emUso = NOC.usedPorts(e);
    return `
      <div class="kv" style="margin-bottom:var(--s-5)">
        <div><label>Em uso</label><strong>${emUso}<span class="unit"> / ${e.portas.length}</span></strong></div>
        <div><label>Livres</label><strong>${e.portas.length - emUso}</strong></div>
        <div><label>Enlaces</label><strong>${NOC.connectionsOf(e.id).length}</strong></div>
        <div><label>Ocupação</label><strong>${NOC.occupancy(e)}<span class="unit">%</span></strong></div>
      </div>

      <div class="row-between" style="margin-bottom:var(--s-3)">
        <h3 style="font-size:var(--fs-13)">Face do equipamento</h3>
        <span class="dim" style="font-size:var(--fs-11)">Clique numa porta para ver ou editar o enlace</span>
      </div>
      <div class="port-grid" id="portGrid">
        ${e.portas.map((p) => {
          const on = NOC.portaEmUso(e.id, p.numero);
          return `<button class="port ${on ? "is-used" : ""}" type="button" data-port="${p.numero}"
                    aria-label="Porta ${p.numero}, ${on ? "em uso" : "livre"}, ${esc(p.capacidade || "")}">${String(p.numero).padStart(2, "0")}</button>`;
        }).join("")}
      </div>

      <div class="row-between" style="margin:var(--s-5) 0 var(--s-3)">
        <h3 style="font-size:var(--fs-13)">Lista de portas</h3>
        <div class="row" style="gap:6px">
          <button class="chip" type="button" data-pf="todas" aria-pressed="true">Todas</button>
          <button class="chip" type="button" data-pf="uso" aria-pressed="false">Em uso <span class="count">${emUso}</span></button>
          <button class="chip" type="button" data-pf="livres" aria-pressed="false">Livres <span class="count">${e.portas.length - emUso}</span></button>
        </div>
      </div>
      <div class="table-wrap" style="max-height:340px">
        <table class="table">
          <thead><tr><th>Porta</th><th>Capacidade</th><th>Tipo</th><th>Status</th><th>Conexão</th><th></th></tr></thead>
          <tbody id="portRows"></tbody>
        </table>
      </div>
      <p class="dim" style="font-size:var(--fs-11);margin-top:var(--s-3)">
        ${icon("info")} RX, TX e status em tempo real aparecem aqui quando a integração com o Grafana estiver ligada.
        Enquanto isso, o sistema mostra apenas o que está documentado.
      </p>`;
  }

  function wirePorts(e, root) {
    let filter = "todas";
    const rows = () => {
      const list = e.portas.filter((p) => {
        const on = NOC.portaEmUso(e.id, p.numero);
        return filter === "todas" ? true : filter === "uso" ? on : !on;
      });
      $("#portRows", root).innerHTML = list.length ? list.map((p) => {
        const c = NOC.portConnection(e.id, p.numero);
        const remoto = c ? device(c.origem === e.id ? c.destino : c.origem) : null;
        const remotaPorta = c ? (c.origem === e.id ? c.portaDestino : c.portaOrigem) : null;
        return `<tr>
          <td class="mono"><b>${String(p.numero).padStart(2, "0")}</b></td>
          <td>${esc(p.capacidade || "A confirmar")}</td>
          <td class="dim">${esc(p.tipo || "—")}</td>
          <td>${c ? '<span class="badge badge-ok"><i class="dot dot-ok"></i>Em uso</span>' : '<span class="badge">Livre</span>'}</td>
          <td>${remoto ? `<button class="btn btn-ghost btn-sm" data-goto="${esc(remoto.id)}">${esc(remoto.nome)} • porta ${remotaPorta}</button>` : '<span class="dim">—</span>'}</td>
          <td><button class="btn btn-ghost btn-sm btn-icon" data-editport="${p.numero}" type="button"
                aria-label="Editar a porta ${p.numero}" title="Editar porta e conexão"
                ${podeEditarPorta() ? "" : "disabled"}>${icon("edit")}</button></td>
        </tr>`;
      }).join("") : `<tr><td colspan="6"><div class="empty"><b>Nenhuma porta nesse filtro</b></div></td></tr>`;
      $$("#portRows [data-goto]", root).forEach((b) => (b.onclick = () => openDevice(b.dataset.goto)));
      $$("#portRows [data-editport]", root).forEach((b) => (b.onclick = () => openPort(e, +b.dataset.editport, { edit: true })));
    };
    $$("[data-pf]", root).forEach((b) => (b.onclick = () => {
      filter = b.dataset.pf;
      $$("[data-pf]", root).forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
      rows();
    }));
    $$("#portGrid .port", root).forEach((b) => (b.onclick = () => openPort(e, +b.dataset.port)));
    rows();
  }

  /* Portas do equipamento remoto que podem receber o enlace: as livres mais a
     que já está nesta ligação (senão o admin não conseguiria reeditá-la). */
  const portasDisponiveis = (destId, manter) => {
    const d = device(destId);
    if (!d) return [];
    return (d.portas || []).filter((x) => !NOC.portaEmUso(destId, x.numero) || Number(x.numero) === Number(manter));
  };

  const STATUS_PORTA = [["livre", "Livre"], ["conectada", "Conectada"], ["reservada", "Reservada"], ["manutencao", "Manutenção"]];

  function openPort(e, numero, opts = {}) {
    const p = e.portas.find((x) => +x.numero === numero);
    if (!p) return;
    const canEdit = podeEditarPorta();
    const canDelete = podeRemoverEnlace();

    modal({
      labelledBy: "portTitle",
      html: `
        <div class="modal-head">
          <div><span class="kicker">${esc(e.nome)}</span>
            <h2 id="portTitle" style="margin-top:6px">Porta ${String(numero).padStart(2, "0")}</h2>
            <p class="muted" style="font-size:var(--fs-13);margin-top:4px" id="portSub"></p></div>
          <button class="btn btn-ghost btn-icon" data-close type="button" aria-label="Fechar">${icon("close")}</button>
        </div>
        <div class="modal-body stack" id="portBody"></div>
        <div class="modal-foot" id="portFoot"></div>`,
      onMount: (host, close) => {
        let editando = !!opts.edit && canEdit;
        const body = $("#portBody", host);
        const foot = $("#portFoot", host);

        const paint = () => {
          const c = NOC.portConnection(e.id, numero);
          const remoto = c ? device(c.origem === e.id ? c.destino : c.origem) : null;
          const remotaPorta = c ? (c.origem === e.id ? c.portaDestino : c.portaOrigem) : null;
          /* Alterar ou apagar um enlace existente conta como remoção na API;
             documentar um enlace novo exige a ação de criação de enlace. */
          const semRemover = !!c && !canDelete;
          const semCriar = !c && !podeCriarEnlace();
          const travado = semRemover || semCriar;

          $("#portSub", host).textContent = `${p.tipo || "—"} • ${p.capacidade || "A confirmar"}`;

          if (!editando) {
            body.innerHTML = `
              ${remoto ? `
                <div class="card" style="padding:var(--s-4)">
                  <span class="kicker">${icon("link")} Enlace documentado</span>
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
              <div class="kv">
                <div><label>Status</label><strong style="font-size:var(--fs-14)">${esc(p.status || (c ? "conectada" : "livre"))}</strong></div>
                <div><label>Capacidade</label><strong style="font-size:var(--fs-14)">${esc(p.capacidade || "A confirmar")}</strong></div>
              </div>
              ${p.observacao ? `<p class="muted" style="font-size:var(--fs-13)">${esc(p.observacao)}</p>` : ""}`;

            foot.innerHTML = `
              <span class="dim" style="font-size:var(--fs-11)">${canEdit ? "Alterações são auditadas com usuário, IP e data/hora." : "Seu perfil tem acesso somente de leitura."}</span>
              <span class="row">
                <button class="btn" data-close type="button">Fechar</button>
                ${remoto ? `<button class="btn" data-goto="${esc(remoto.id)}" type="button">Abrir ${esc(remoto.nome)}</button>` : ""}
                <button class="btn btn-primary" data-edit type="button" ${canEdit ? "" : "disabled title='Requer a permissão topology.edit'"}>${icon("edit")} Editar porta</button>
              </span>`;
            $$("[data-close]", foot).forEach((b) => (b.onclick = close));
            const g = $("[data-goto]", foot);
            if (g) g.onclick = () => { close(); openDevice(g.dataset.goto); };
            $("[data-edit]", foot).onclick = () => { editando = true; paint(); };
            return;
          }

          /* -------- modo de edição -------- */
          const destinoAtual = remoto?.id || "";
          const outros = (NOC.data()?.equipamentos || []).filter((x) => x.id !== e.id);
          body.innerHTML = `
            <form class="stack" id="portForm">
              <div class="row" style="gap:var(--s-3);align-items:flex-start">
                <div class="field grow"><label for="pCap">Capacidade da porta</label>
                  <input class="input" id="pCap" value="${esc(p.capacidade || "")}" placeholder="Ex.: 10 Gbps"></div>
                <div class="field grow"><label for="pTipo">Tipo da porta</label>
                  <input class="input" id="pTipo" value="${esc(p.tipo || "")}" placeholder="Ex.: GE / 10GE"></div>
                <div class="field" style="width:170px"><label for="pStatus">Status</label>
                  <select class="select" id="pStatus">
                    ${STATUS_PORTA.map(([v, l]) => `<option value="${v}" ${(p.status || "livre") === v ? "selected" : ""}>${l}</option>`).join("")}
                  </select></div>
              </div>
              <div class="field"><label for="pObs">Observação da porta</label>
                <input class="input" id="pObs" value="${esc(p.observacao || "")}" placeholder="Cliente, circuito, ordem de serviço…"></div>

              <hr>
              <div class="row-between">
                <h3 style="font-size:var(--fs-13)">${icon("link")} O que está conectado nesta porta</h3>
                ${c ? `<button class="btn btn-danger btn-sm" type="button" data-unlink ${canDelete ? "" : "disabled title='Requer as ações topology.delete + topology.link.delete'"}>${icon("trash")} Remover enlace</button>` : ""}
              </div>
              ${semRemover ? `<div class="alert alert-warn" style="animation:none">${icon("alert")}
                <span>Esta porta já tem enlace. Alterar ou remover um enlace existente exige as ações <b>topology.delete</b> e <b>topology.link.delete</b>; seu perfil só pode editar os dados da porta.</span></div>` : ""}
              ${semCriar ? `<div class="alert alert-warn" style="animation:none">${icon("alert")}
                <span>Documentar um enlace novo exige as ações <b>topology.edit</b> e <b>topology.link.create</b>; seu perfil só pode editar os dados da porta.</span></div>` : ""}
              <div class="row" style="gap:var(--s-3);align-items:flex-start">
                <div class="field grow"><label for="pDest">Equipamento conectado</label>
                  <select class="select" id="pDest" ${travado ? "disabled" : ""}>
                    <option value="">— Nenhum (porta livre) —</option>
                    ${outros.map((x) => `<option value="${esc(x.id)}" ${destinoAtual === x.id ? "selected" : ""}>${esc(x.nome)}${x.modelo ? ` — ${esc(x.modelo)}` : ""}</option>`).join("")}
                  </select>
                  <span class="field-hint">Só aparecem as portas livres do equipamento escolhido.</span>
                </div>
                <div class="field" style="width:210px"><label for="pDestPorta">Porta do outro lado</label>
                  <select class="select" id="pDestPorta" ${travado ? "disabled" : ""}></select></div>
              </div>
              <div class="row" style="gap:var(--s-3);align-items:flex-start">
                <div class="field grow"><label for="pLinkTipo">Tipo do enlace</label>
                  <input class="input" id="pLinkTipo" value="${esc(c?.tipo || "")}" placeholder="Ex.: Uplink, Transporte" ${travado ? "disabled" : ""}></div>
                <div class="field grow"><label for="pLinkCap">Capacidade do enlace</label>
                  <input class="input" id="pLinkCap" value="${esc(c?.capacidade || "")}" placeholder="Ex.: 10 Gbps" ${travado ? "disabled" : ""}></div>
              </div>
            </form>`;

          foot.innerHTML = `
            <span class="dim" style="font-size:var(--fs-11)">A alteração vai para a auditoria com estado anterior e posterior.</span>
            <span class="row">
              <button class="btn" type="button" data-cancelar>Cancelar</button>
              <button class="btn btn-primary" type="button" data-salvar>Salvar porta</button>
            </span>`;

          const form = $("#portForm", body);
          const selDest = $("#pDest", form);
          const selPorta = $("#pDestPorta", form);

          const pintarPortas = (selecionada) => {
            // a porta do enlace atual só continua ofertada no próprio equipamento remoto
            const manter = selDest.value === (remoto?.id || "") ? remotaPorta : null;
            const lista = portasDisponiveis(selDest.value, manter);
            selPorta.innerHTML = lista.length
              ? lista.map((x) => `<option value="${x.numero}" ${Number(selecionada) === Number(x.numero) ? "selected" : ""}>Porta ${String(x.numero).padStart(2, "0")}${x.capacidade ? ` — ${esc(x.capacidade)}` : ""}</option>`).join("")
              : `<option value="">Sem portas livres</option>`;
            selPorta.disabled = travado || !selDest.value || !lista.length;
          };
          pintarPortas(remotaPorta);
          selDest.onchange = () => pintarPortas(null);

          const desfazer = $("[data-unlink]", form);
          if (desfazer) desfazer.onclick = () => askConfirm({
            title: "Remover este enlace?",
            text: `A ligação entre ${e.nome} (porta ${numero}) e ${remoto?.nome || "o outro equipamento"} deixa de existir na topologia. As duas portas voltam a ficar livres.`,
            confirmLabel: "Remover enlace",
            danger: true,
            onConfirm: async () => { if (await salvar({ remover: true })) { editando = false; paint(); } },
          });

          $("[data-cancelar]", foot).onclick = () => { editando = false; paint(); };
          $("[data-salvar]", foot).onclick = async () => { if (await salvar({})) { editando = false; paint(); } };

          async function salvar({ remover }) {
            const t = NOC.data();
            const destinoId = remover ? "" : selDest.value;
            const destinoPorta = remover ? null : Number(selPorta.value) || null;

            if (destinoId && !destinoPorta) {
              toast("Escolha a porta do outro lado", { text: "O equipamento selecionado não tem porta livre disponível.", type: "warn" });
              return false;
            }
            if (destinoId === e.id) {
              toast("Destino inválido", { text: "Um equipamento não pode ser ligado a si mesmo.", type: "warn" });
              return false;
            }
            const ocupada = destinoId && NOC.portConnection(destinoId, destinoPorta);
            if (ocupada && ocupada !== c) {
              toast("Porta de destino já ocupada", { text: "Escolha outra porta ou remova o enlace existente antes.", type: "warn" });
              return false;
            }

            const antesPorta = { ...p };
            const antesConexoes = (t.conexoes || []).map((x) => ({ ...x }));

            if (!travado) {
              t.conexoes = (t.conexoes || []).filter((x) => x !== c);
              if (destinoId && destinoPorta) {
                t.conexoes.push({
                  origem: e.id,
                  portaOrigem: Number(numero),
                  destino: destinoId,
                  portaDestino: destinoPorta,
                  capacidade: $("#pLinkCap", form).value.trim() || "A confirmar",
                  tipo: $("#pLinkTipo", form).value.trim() || "Enlace",
                });
              }
            }

            p.capacidade = $("#pCap", form).value.trim();
            p.tipo = $("#pTipo", form).value.trim();
            p.observacao = $("#pObs", form).value.trim();
            const escolhido = $("#pStatus", form).value;
            const temEnlace = !!NOC.portConnection(e.id, numero);
            p.status = temEnlace ? "conectada" : (escolhido === "conectada" ? "livre" : escolhido);

            const ok = await persist(
              remover ? "TOPOLOGY_DELETE_CONEXAO" : "TOPOLOGY_UPDATE_PORTA",
              {
                titulo: remover ? "Enlace removido" : `Porta ${String(numero).padStart(2, "0")} atualizada`,
                texto: remover
                  ? "As duas portas voltaram a ficar livres."
                  : destinoId
                    ? `Conectada a ${device(destinoId)?.nome || destinoId}, porta ${destinoPorta}.`
                    : "Dados da porta gravados.",
                tipo: remover ? "warn" : "ok",
              },
              async () => {
                Object.assign(p, antesPorta);
                NOC.data().conexoes = antesConexoes;
                await persist("TOPOLOGY_UPDATE_PORTA", { titulo: "Alteração desfeita", tipo: "info" });
                if (repaintDevice) repaintDevice();
              }
            );
            if (!ok) {
              Object.assign(p, antesPorta);
              NOC.data().conexoes = antesConexoes;
              layout();
              renderAll();
              return false;
            }
            if (repaintDevice) repaintDevice();
            return true;
          }
        };

        paint();
      },
    });
  }

  function connTab(e) {
    const list = NOC.connectionsOf(e.id);
    if (!list.length) {
      return `<div class="empty"><span class="empty-icon">${icon("link")}</span>
        <b>Sem enlaces cadastrados</b><p>Este equipamento ainda não possui conexões documentadas.</p></div>`;
    }
    return `<div class="stack">${list.map((c) => {
      const saida = c.origem === e.id;
      const remoto = device(saida ? c.destino : c.origem);
      return `<div class="card" style="padding:var(--s-4)">
        <div class="row-between">
          <div class="row" style="gap:var(--s-3)">
            <span class="badge badge-info">${esc(c.tipo || "Enlace")}</span>
            <div><b>${esc(remoto?.nome || (saida ? c.destino : c.origem))}</b>
              <br><small class="dim">porta ${saida ? c.portaOrigem : c.portaDestino} → porta ${saida ? c.portaDestino : c.portaOrigem}</small></div>
          </div>
          <div class="row">
            <span class="badge">${esc(c.capacidade || "A confirmar")}</span>
            <button class="btn btn-sm" type="button" data-focus="${esc(remoto?.id || "")}">Ver no mapa</button>
            <button class="btn btn-sm" type="button" data-editlink="${saida ? c.portaOrigem : c.portaDestino}"
              ${podeEditarPorta() ? "" : "disabled title='Requer as ações topology.edit + topology.port.edit'"}>Editar</button>
          </div>
        </div>
      </div>`;
    }).join("")}</div>`;
  }
  function wireConn(e, root, close) {
    $$("[data-editlink]", root).forEach((b) => (b.onclick = () => openPort(e, +b.dataset.editlink, { edit: true })));
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

  function connectionTab(e, data) {
    const connection = data.connection;
    const credentials = data.credentials;
    const canConfigure = NOC.can("topology.connection.configure");
    const protocol = connection?.protocol || "ssh";
    const port = connection?.port || (protocol === "telnet" ? 23 : 22);
    const ready = Boolean(connection && credentials?.username && credentials?.has_password);
    return `
      <form id="connectionForm" class="stack">
        <div class="card" style="padding:var(--s-4)">
          <div class="row-between" style="margin-bottom:var(--s-4)">
            <div><span class="kicker">Aparelho</span><h3 style="font-size:var(--fs-14);margin-top:4px">Acesso de gerência</h3></div>
            ${connection ? `<span class="badge badge-info">${esc(protocol.toUpperCase())} • ${esc(connection.ip)}:${port}</span>` : '<span class="badge badge-warn">Não configurado</span>'}
          </div>
          <div class="row" style="gap:var(--s-3);align-items:flex-start">
            <div class="field grow"><label for="mgmtIp">IP de acesso</label>
              <input class="input mono" id="mgmtIp" inputmode="decimal" placeholder="192.168.0.1" value="${esc(connection?.ip || "")}" ${canConfigure ? "required" : "disabled"}></div>
            <div class="field" style="width:120px"><label for="mgmtProtocol">Protocolo</label>
              <select class="select" id="mgmtProtocol" ${canConfigure ? "" : "disabled"}>
                <option value="ssh" ${protocol === "ssh" ? "selected" : ""}>SSH</option>
                <option value="telnet" ${protocol === "telnet" ? "selected" : ""}>TELNET</option>
              </select></div>
            <div class="field" style="width:105px"><label for="mgmtPort">Porta</label>
              <input class="input mono" id="mgmtPort" type="number" min="1" max="65535" value="${port}" ${canConfigure ? "required" : "disabled"}></div>
          </div>
          <p class="field-hint">${canConfigure ? "O IP, o protocolo e a porta são compartilhados por todos os usuários deste aparelho." : "Somente perfis autorizados podem alterar o IP, o protocolo e a porta."}</p>
        </div>

        <div class="card" style="padding:var(--s-4)">
          <div class="row-between" style="margin-bottom:var(--s-4)">
            <div><span class="kicker">Pessoal</span><h3 style="font-size:var(--fs-14);margin-top:4px">Minhas credenciais</h3></div>
            <span class="badge ${credentials?.has_password ? "badge-ok" : ""}">${credentials?.has_password ? "Senha protegida" : "Não cadastradas"}</span>
          </div>
          <div class="field"><label for="mgmtUser">Usuário no aparelho</label>
            <input class="input" id="mgmtUser" autocomplete="username" maxlength="128" value="${esc(credentials?.username || "")}" required></div>
          <div class="field"><label for="mgmtPassword">Senha no aparelho</label>
            <input class="input" id="mgmtPassword" type="password" autocomplete="new-password" maxlength="512"
              placeholder="${credentials?.has_password ? "Deixe em branco para manter a senha atual" : "Digite sua senha de acesso"}" ${credentials?.has_password ? "" : "required"}>
            <span class="field-hint">A senha é criptografada antes de ser gravada e pertence somente ao seu usuário.</span></div>
        </div>

        <div class="row-between wrap" style="gap:var(--s-3)">
          <span class="row wrap">
            <button class="btn btn-primary" type="submit">Salvar conexão</button>
            <button class="btn" type="button" data-copy-password ${credentials?.has_password ? "" : "disabled"}>${icon("lock")} Copiar senha</button>
            <button class="btn" type="button" data-connect ${ready ? "" : "disabled"}>Conectar via ${esc(protocol.toUpperCase())}</button>
          </span>
          <button class="btn btn-danger btn-sm" type="button" data-remove-credentials ${credentials ? "" : "disabled"}>Remover minhas credenciais</button>
        </div>
        <p class="dim" style="font-size:var(--fs-11)">Ao conectar, o navegador abre o cliente ${esc(protocol.toUpperCase())} instalado neste computador. A senha nunca é incluída no endereço de conexão.</p>
      </form>`;
  }

  async function loadConnectionTab(e, root) {
    NOC.skeleton(root, 4);
    try {
      const data = await NOC.deviceConnection.get(e.id);
      if (root.dataset.activeTab !== "acesso") return;
      root.innerHTML = connectionTab(e, data);
      wireConnectionTab(e, root, data);
    } catch (err) {
      if (root.dataset.activeTab !== "acesso") return;
      NOC.errorState(root, err, () => loadConnectionTab(e, root));
    }
  }

  function wireConnectionTab(e, root, data) {
    const form = $("#connectionForm", root);
    const protocol = $("#mgmtProtocol", form);
    const port = $("#mgmtPort", form);
    protocol?.addEventListener("change", () => {
      const oldDefault = protocol.value === "ssh" ? "23" : "22";
      if (!port.value || port.value === oldDefault) port.value = protocol.value === "ssh" ? "22" : "23";
    });

    form.onsubmit = async (ev) => {
      ev.preventDefault();
      const submit = form.querySelector('[type="submit"]');
      submit.disabled = true;
      try {
        if (NOC.can("topology.connection.configure")) {
          await NOC.deviceConnection.save(e.id, {
            ip: $("#mgmtIp", form).value.trim(),
            protocol: protocol.value,
            port: Number(port.value),
          });
        }
        const credentials = { username: $("#mgmtUser", form).value.trim() };
        const password = $("#mgmtPassword", form).value;
        if (password) credentials.password = password;
        await NOC.deviceConnection.saveCredentials(e.id, credentials);
        toast("Conexão salva", { text: "O acesso do aparelho e suas credenciais estão prontos.", type: "ok" });
        await loadConnectionTab(e, root);
      } catch (err) {
        toast("Não foi possível salvar", { text: err.message, type: "danger" });
        submit.disabled = false;
      }
    };

    const copy = $("[data-copy-password]", form);
    if (copy) copy.onclick = async () => {
      copy.disabled = true;
      try {
        const result = await NOC.deviceConnection.revealPassword(e.id);
        await navigator.clipboard.writeText(result.password);
        toast("Senha copiada", { text: "Cole-a no cliente e evite deixá-la na área de transferência.", type: "ok" });
      } catch (err) {
        toast("Não foi possível copiar", { text: err.message, type: "danger" });
      } finally { copy.disabled = false; }
    };

    const connect = $("[data-connect]", form);
    if (connect) connect.onclick = () => {
      const c = data.connection;
      const username = data.credentials?.username;
      if (!c || !username) return;
      const host = c.ip.includes(":") ? `[${c.ip}]` : c.ip;
      location.href = `${c.protocol}://${encodeURIComponent(username)}@${host}:${c.port}`;
    };

    const remove = $("[data-remove-credentials]", form);
    if (remove) remove.onclick = () => askConfirm({
      title: "Remover suas credenciais?",
      text: `O IP de gerência de ${e.nome} continua cadastrado, mas seu usuário e sua senha serão apagados.`,
      confirmLabel: "Remover credenciais", danger: true,
      onConfirm: async () => {
        await NOC.deviceConnection.removeCredentials(e.id);
        toast("Credenciais removidas", { type: "ok" });
        await loadConnectionTab(e, root);
      },
    });
  }

  function sheetTab(e) {
    const canEdit = podeEditarEquipamento();
    return `
      <form id="sheetForm" class="stack">
        <div class="row-between">
          <h3 style="font-size:var(--fs-13)">Dados cadastrais</h3>
          <button class="btn btn-sm" type="button" data-editmode ${canEdit ? "" : "disabled"}>${icon("edit")} Editar</button>
        </div>
        <div class="field"><label for="fNome">Nome</label><input class="input" id="fNome" value="${esc(e.nome || "")}" disabled></div>
        <div class="field"><label for="fModelo">Modelo</label><input class="input" id="fModelo" value="${esc(e.modelo || "")}" disabled></div>
        <div class="row" style="gap:var(--s-3);align-items:flex-start">
          <div class="field grow"><label for="fCat">Categoria</label><input class="input" id="fCat" value="${esc(e.categoria || "")}" disabled></div>
          <div class="field grow"><label for="fPop">POP vinculado</label>
            <select class="select" id="fPop" disabled>
              <option value="">— Sem POP vinculado —</option>
              ${NOC.pops().map((p) => `<option value="${esc(p.id)}" ${e.popId === p.id ? "selected" : ""}>${esc(p.nome)}</option>`).join("")}
            </select>
            <span class="field-hint">Um equipamento pertence a um único POP. O Dashboard agrupa por este campo.</span>
          </div>
        </div>
        <div class="field"><label for="fLocal">Local (texto livre)</label><input class="input" id="fLocal" value="${esc(e.local || "")}" disabled></div>
        <div class="field"><label for="fObs">Observação operacional</label>
          <textarea class="textarea" id="fObs" disabled>${esc(e.observacao || "")}</textarea></div>

        <div class="row-between" id="sheetActions" hidden>
          <span class="dim" style="font-size:var(--fs-11)">A alteração vai para a auditoria com estado anterior e posterior.</span>
          <span class="row">
            <button class="btn" type="button" data-cancel>Cancelar</button>
            <button class="btn btn-primary" type="submit">Salvar alterações</button>
          </span>
        </div>

        <hr>
        <div class="row-between">
          <div><b style="font-size:var(--fs-13)">Remover equipamento</b>
            <p class="dim" style="font-size:var(--fs-11)">Remove o equipamento, as portas e os enlaces ligados a ele.</p></div>
          <button class="btn btn-danger btn-sm" type="button" data-delete ${podeExcluirEquipamento() ? "" : "disabled title='Requer as ações topology.delete + topology.equipment.delete'"}>${icon("trash")} Remover</button>
        </div>
      </form>`;
  }

  function wireSheet(e, root) {
    const form = $("#sheetForm", root);
    const campos = () => $$("input, textarea, select", form);

    $("[data-editmode]", form).onclick = (ev) => {
      ev.preventDefault();
      campos().forEach((i) => (i.disabled = false));
      $("#sheetActions", form).hidden = false;
      $("[data-editmode]", form).hidden = true;
      $("#fNome", form).focus();
    };
    $("[data-cancel]", form).onclick = () => {
      campos().forEach((i) => (i.disabled = true));
      $("#sheetActions", form).hidden = true;
      $("[data-editmode]", form).hidden = false;
    };

    form.onsubmit = async (ev) => {
      ev.preventDefault();
      const antes = { nome: e.nome, modelo: e.modelo, categoria: e.categoria, local: e.local, observacao: e.observacao, popId: e.popId ?? null };
      e.nome = $("#fNome", form).value.trim() || e.nome;
      e.modelo = $("#fModelo", form).value.trim();
      e.categoria = $("#fCat", form).value.trim();
      e.local = $("#fLocal", form).value.trim();
      e.observacao = $("#fObs", form).value.trim();
      e.popId = $("#fPop", form).value || null;
      campos().forEach((i) => (i.disabled = true));
      $("#sheetActions", form).hidden = true;
      $("[data-editmode]", form).hidden = false;
      await persist("TOPOLOGY_UPDATE",
        { titulo: "Equipamento atualizado", texto: "Alteração registrada na auditoria." },
        async () => { Object.assign(e, antes); await persist("TOPOLOGY_UPDATE", { titulo: "Alteração desfeita", tipo: "info" }); });
    };

    const del = $("[data-delete]", form);
    if (del) del.onclick = () => askConfirm({
      title: `Remover ${e.nome}?`,
      text: `${e.portas.length} portas e ${NOC.connectionsOf(e.id).length} enlaces deixam de existir na topologia. A ação é auditada com o estado anterior completo.`,
      confirmLabel: "Remover equipamento",
      danger: true,
      onConfirm: async () => {
        const t = NOC.data();
        const backupEq = [...t.equipamentos];
        const backupCon = [...t.conexoes];
        t.equipamentos = t.equipamentos.filter((x) => x.id !== e.id);
        t.conexoes = t.conexoes.filter((c) => c.origem !== e.id && c.destino !== e.id);
        state.selected = null;
        await persist("TOPOLOGY_DELETE_EQUIPAMENTO",
          { titulo: `${e.nome} removido`, texto: "Remoção registrada na auditoria.", tipo: "warn" },
          async () => {
            t.equipamentos = backupEq;
            t.conexoes = backupCon;
            await persist("TOPOLOGY_UPDATE", { titulo: "Remoção desfeita", tipo: "info" });
          });
      },
    });
  }

  /* ---------------- enlaces ---------------- */
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
            <p class="muted" style="font-size:var(--fs-13);margin-top:4px">Expanda o POP no mapa para ver cada enlace ligado à porta de origem.</p></div>
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

  function openConnection(c) {
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

  function openRing(r) {
    if (!r) return;
    modal({
      labelledBy: "ringTitle",
      html: `
        <div class="modal-head">
          <div><span class="kicker">Anel óptico</span>
            <h2 id="ringTitle" style="margin-top:6px">${esc(NOC.popById(r.a)?.nome || r.a)} ↔ ${esc(NOC.popById(r.b)?.nome || r.b)}</h2></div>
          <button class="btn btn-ghost btn-icon" data-close type="button" aria-label="Fechar">${icon("close")}</button>
        </div>
        <div class="modal-body stack">
          <div class="row wrap" style="gap:6px">${[...r.tipos].map((t) => `<span class="badge badge-info">Rota ${esc(t)}</span>`).join("")}</div>
          <p class="muted" style="font-size:var(--fs-13)">Rotas registradas no cadastro do POP.</p>
          <a class="btn" href="/pops.html?pop=${encodeURIComponent(r.a)}">Abrir ficha do POP</a>
        </div>`,
    });
  }

  /* ---------------- gerenciar rede ---------------- */
  function openManage() {
    const canEdit = podeVincularPop();
    modal({
      wide: true,
      labelledBy: "mgTitle",
      html: `
        <div class="modal-head">
          <div><span class="kicker">Configuração da topologia</span>
            <h2 id="mgTitle" style="margin-top:6px">Gerenciar rede</h2>
            <p class="muted" style="font-size:var(--fs-13);margin-top:4px">Vínculo com POP, cadastro de equipamentos e de POPs. Tudo passa pela API e vai para a auditoria.</p></div>
          <button class="btn btn-ghost btn-icon" data-close type="button" aria-label="Fechar">${icon("close")}</button>
        </div>
        <div class="modal-body stack">
          <div class="tabs" role="tablist">
            <button class="tab" role="tab" aria-selected="true" data-mt="vinculo">Vínculo com POP</button>
            <button class="tab" role="tab" aria-selected="false" data-mt="novo">Novo equipamento</button>
            <button class="tab" role="tab" aria-selected="false" data-mt="pops">POPs</button>
            <button class="tab" role="tab" aria-selected="false" data-mt="enlaces">Enlaces</button>
          </div>
          <div id="mgBody"></div>
        </div>`,
      onMount: (host, close) => {
        const body = $("#mgBody", host);
        const popOptions = (sel) => `<option value="">— Sem POP vinculado —</option>` +
          NOC.pops().map((p) => `<option value="${esc(p.id)}" ${sel === p.id ? "selected" : ""}>${esc(p.nome)}</option>`).join("");

        const views = {
          vinculo: () => {
            const eqs = NOC.data().equipamentos;
            const sugeridos = eqs.filter((e) => NOC.isSuggested(e));
            const semNada = eqs.filter((e) => !NOC.effectivePop(e));
            return `<div class="stack">
              ${sugeridos.length ? `<div class="alert alert-warn" style="animation:none">${icon("alert")}
                <span><b>${sugeridos.length} equipamento(s) com vínculo apenas sugerido</b> pelo texto do campo “local”.
                Confirme para que o vínculo fique gravado no cadastro.</span>
                <button class="btn btn-sm" type="button" data-apply-sug style="align-self:center" ${canEdit ? "" : "disabled"}>Confirmar sugestões</button>
              </div>` : ""}
              ${semNada.length ? `<div class="alert alert-info" style="animation:none">${icon("info")}
                <span>${semNada.length} equipamento(s) sem POP. Eles aparecem separados no Dashboard e não entram na ocupação de nenhum POP.</span></div>` : ""}
              <div class="table-wrap" style="max-height:420px">
                <table class="table">
                  <thead><tr><th>Equipamento</th><th>Categoria</th><th style="min-width:230px">POP vinculado</th><th class="num">Portas</th><th></th></tr></thead>
                  <tbody>${eqs.map((e) => `<tr>
                    <td><b>${esc(e.nome)}</b><br><small class="dim">${esc(e.modelo || "—")}</small></td>
                    <td>${esc(e.categoria || "—")}</td>
                    <td>
                      <label class="sr-only" for="pop-${esc(e.id)}">POP de ${esc(e.nome)}</label>
                      <select class="select" id="pop-${esc(e.id)}" data-link="${esc(e.id)}" ${canEdit ? "" : "disabled"}>${popOptions(e.popId)}</select>
                      ${NOC.isSuggested(e) ? `<small class="dim">sugerido: ${esc(NOC.popById(NOC.suggestPop(e))?.nome || "")}</small>` : ""}
                    </td>
                    <td class="num">${e.portas.length}</td>
                    <td><button class="btn btn-sm" type="button" data-unlink="${esc(e.id)}" ${e.popId && canEdit ? "" : "disabled"}>Desvincular</button></td>
                  </tr>`).join("")}</tbody>
                </table>
              </div>
            </div>`;
          },
          novo: () => `
            <form class="stack" id="newDevice">
              <div class="row" style="gap:var(--s-3);align-items:flex-start">
                <div class="field grow"><label for="nNome">Nome *</label><input class="input" id="nNome" required></div>
                <div class="field grow"><label for="nModelo">Modelo</label><input class="input" id="nModelo"></div>
              </div>
              <div class="row" style="gap:var(--s-3);align-items:flex-start">
                <div class="field grow"><label for="nCat">Categoria</label><input class="input" id="nCat" placeholder="Ex.: Agregação"></div>
                <div class="field grow"><label for="nPop">POP vinculado</label><select class="select" id="nPop">${popOptions(null)}</select></div>
                <div class="field" style="width:130px"><label for="nPortas">Portas</label><input class="input" id="nPortas" type="number" min="1" max="96" value="24"></div>
              </div>
              <div class="field"><label for="nObs">Observação</label><textarea class="textarea" id="nObs"></textarea></div>
              <div class="row-between">
                <span class="dim" style="font-size:var(--fs-11)">As portas nascem livres, com capacidade “A confirmar”.</span>
                <span class="row"><button class="btn" data-close type="button">Cancelar</button>
                <button class="btn btn-primary" type="submit" ${podeCriarEquipamento() ? "" : "disabled title='Requer as ações topology.edit + topology.equipment.create'"}>Cadastrar equipamento</button></span>
              </div>
            </form>`,
          pops: () => `
            <div class="stack">
              <form class="row" style="gap:var(--s-3);align-items:flex-end" id="newPop">
                <div class="field grow"><label for="pNome">Novo POP</label><input class="input" id="pNome" placeholder="Ex.: POP ASCENTY"></div>
                <div class="field grow"><label for="pRotas">Rotas (separadas por vírgula)</label><input class="input" id="pRotas" placeholder="Aérea → Santos, Subterrânea → Cubatão"></div>
                <button class="btn btn-primary" type="submit" ${podeCriarPop() ? "" : "disabled title='Requer as ações topology.edit + pops.create'"}>Criar POP</button>
              </form>
              <div class="table-wrap"><table class="table">
                <thead><tr><th>POP</th><th>Rotas</th><th class="num">Equipamentos</th><th class="num">Portas</th><th></th></tr></thead>
                <tbody>${NOC.pops().map((p) => {
                  const st = siteStats(p.id);
                  return `<tr>
                    <td><b>${esc(p.nome)}</b><br><small class="dim mono">${esc(p.id)}</small></td>
                    <td class="dim">${p.rotas.map(esc).join(" • ") || "—"}</td>
                    <td class="num">${st.list.length}</td>
                    <td class="num">${st.portas}</td>
                    <td><a class="btn btn-sm" href="/pops.html?pop=${encodeURIComponent(p.id)}">Abrir</a></td>
                  </tr>`;
                }).join("")}</tbody>
              </table></div>
            </div>`,
          enlaces: () => `
            <div class="table-wrap" style="max-height:420px"><table class="table">
              <thead><tr><th>Origem</th><th>Destino</th><th>Tipo</th><th>Capacidade</th><th></th></tr></thead>
              <tbody>${NOC.data().conexoes.map((c, i) => `<tr>
                <td><b>${esc(device(c.origem)?.nome || c.origem)}</b> <span class="dim mono">porta ${c.portaOrigem}</span></td>
                <td><b>${esc(device(c.destino)?.nome || c.destino)}</b> <span class="dim mono">porta ${c.portaDestino}</span></td>
                <td>${esc(c.tipo || "—")}</td><td>${esc(c.capacidade || "A confirmar")}</td>
                <td><button class="btn btn-sm" type="button" data-editconn="${i}" ${podeEditarPorta() && device(c.origem) ? "" : "disabled"}>Editar</button></td></tr>`).join("")}</tbody>
            </table></div>
            <p class="dim" style="font-size:var(--fs-11);margin-top:var(--s-3)">
              ${icon("info")} Um enlace é editado pela porta de origem: escolha o equipamento e a porta do outro lado.
              Para criar um enlace novo, abra o equipamento, clique numa porta livre e use “Editar porta”.</p>`,
        };

        let cur = "vinculo";
        const paint = () => {
          $$("[data-mt]", host).forEach((t) => t.setAttribute("aria-selected", String(t.dataset.mt === cur)));
          body.innerHTML = views[cur]();

          $$("[data-link]", body).forEach((sel) => (sel.onchange = async () => {
            await vincular(sel.dataset.link, sel.value);
            paint();
          }));
          $$("[data-unlink]", body).forEach((b) => (b.onclick = async () => {
            await vincular(b.dataset.unlink, null);
            paint();
          }));
          $$("[data-editconn]", body).forEach((b) => (b.onclick = () => {
            const c = NOC.data().conexoes[+b.dataset.editconn];
            const origem = c && device(c.origem);
            if (!origem) return;
            close();
            openPort(origem, Number(c.portaOrigem), { edit: true });
          }));

          const aplicar = $("[data-apply-sug]", body);
          if (aplicar) aplicar.onclick = async () => {
            const alvo = NOC.data().equipamentos.filter((e) => NOC.isSuggested(e));
            alvo.forEach((e) => { e.popId = NOC.suggestPop(e); });
            const ok = await persist("TOPOLOGY_LINK_POP_BULK", {
              titulo: `${alvo.length} vínculos confirmados`,
              texto: "Os equipamentos passaram a ter POP gravado no cadastro.",
            });
            if (!ok) alvo.forEach((e) => { e.popId = null; });
            paint();
          };

          const form = $("#newDevice", body);
          if (form) form.onsubmit = async (ev) => {
            ev.preventDefault();
            const nome = $("#nNome", form).value.trim();
            if (!nome) return $("#nNome", form).focus();
            const total = Math.max(1, Math.min(96, +$("#nPortas", form).value || 24));
            const popId = $("#nPop", form).value || null;
            const novo = {
              id: "eq-" + Date.now(),
              nome,
              modelo: $("#nModelo", form).value.trim(),
              categoria: $("#nCat", form).value.trim() || "Equipamento",
              popId,
              local: popId ? (NOC.popById(popId)?.nome || "") : "",
              observacao: $("#nObs", form).value.trim(),
              portas: Array.from({ length: total }, (_, i) => ({
                numero: i + 1, capacidade: "A confirmar", tipo: "A confirmar", status: "livre",
              })),
            };
            NOC.data().equipamentos.push(novo);
            if (popId) state.expanded.add(popId);
            const ok = await persist("TOPOLOGY_CREATE_EQUIPAMENTO",
              { titulo: "Equipamento cadastrado", texto: `${nome} entrou na topologia com ${total} portas.` });
            if (ok) close();
            else NOC.data().equipamentos = NOC.data().equipamentos.filter((x) => x.id !== novo.id);
          };

          const popForm = $("#newPop", body);
          if (popForm) popForm.onsubmit = async (ev) => {
            ev.preventDefault();
            const nome = $("#pNome", popForm).value.trim();
            if (!nome) return $("#pNome", popForm).focus();
            const rotas = $("#pRotas", popForm).value.split(",").map((s) => s.trim()).filter(Boolean);
            // "POP ASCENTY" → pop-ascenty (sem duplicar o prefixo)
            const slug = nome.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "")
              .replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").replace(/^pop-?/, "");
            const novo = { id: "pop-" + slug, nome, rotas, equipamentos: [] };
            if (NOC.popById(novo.id)) {
              toast("Este POP já existe", { text: `Já há um POP com o identificador ${novo.id}.`, type: "warn" });
              return;
            }
            NOC.data().pops.push(novo);
            const ok = await persist("TOPOLOGY_CREATE_POP", { titulo: "POP criado", texto: `${nome} já pode receber equipamentos.` });
            if (!ok) NOC.data().pops = NOC.data().pops.filter((p) => p.id !== novo.id);
            paint();
          };
        };
        $$("[data-mt]", host).forEach((t) => (t.onclick = () => { cur = t.dataset.mt; paint(); }));
        paint();
      },
    });
  }

  /* ---------------- render + início ---------------- */
  function renderAll() {
    renderList();
    renderSites();
    renderEdges();
    renderTable();
  }

  async function boot() {
    UI.mountShell({
      active: "topologia",
      search: () => {
        const t = NOC.data();
        if (!t) return [];
        return [
          ...t.equipamentos.map((e) => ({
            group: "Equipamentos", label: e.nome, icon: "port",
            hint: `${e.modelo || ""} • ${e.portas.length} portas • ${NOC.usedPorts(e)} em uso`,
            run: () => { state.expanded.add(siteOf(e)); state.selected = e.id; layout(); renderAll(); centerOn(e.id); openDevice(e.id); },
          })),
          ...NOC.pops().map((p) => ({
            group: "POPs", label: p.nome, icon: "pops", hint: `${devicesOf(p.id).length} equipamentos`,
            run: () => { state.expanded.add(p.id); layout(); renderAll(); centerOnBox(p.id); },
          })),
        ];
      },
    });

    $("#iconSearch").innerHTML = icon("search");
    $("#zoomIn").innerHTML = icon("zoomIn");
    $("#zoomOut").innerHTML = icon("zoomOut");
    $("#zoomFit").innerHTML = icon("fit");
    $("#toggleSide").innerHTML = icon("chevronLeft");
    $("#btnManage").innerHTML = icon("plus") + " Gerenciar rede";

    NOC.skeleton($("#deviceList"), 5);

    try {
      await NOC.load();
    } catch (err) {
      NOC.errorState($("#deviceList"), err, () => location.reload());
      toast("Falha ao carregar a topologia", { text: err.message, type: "danger", timeout: 8000 });
      return;
    }

    const t = NOC.data();
    if (t.config?.coreTitle) $("#topoKicker").textContent = t.config.coreTitle;
    state.layout = { ...(t.config?.layout || {}) };
    // Cada botão declara a ação que exige no HTML (data-action) e o NOC
    // aplica o perfil do usuário de uma vez só.
    NOC.applyActions(document);

    renderFilters();
    layout();
    renderAll();
    bindStage();
    requestAnimationFrame(fit);

    // Abre o primeiro POP com equipamentos, para o mapa não começar "vazio".
    const primeiro = visibleSites().find((s) => devicesOf(s.id).length);
    if (primeiro) { state.expanded.add(primeiro.id); layout(); renderAll(); requestAnimationFrame(fit); }

    let resizeTimer = null;
    addEventListener("resize", () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => { if (state.view === "mapa") fit(); }, 160);
    });

    $("#deviceSearch").addEventListener("input", (e) => { state.query = e.target.value.trim().toLowerCase(); renderAll(); });
    $("#clearFilters").onclick = () => {
      state.query = ""; state.cats.clear();
      $("#deviceSearch").value = "";
      renderFilters(); renderAll();
    };
    $("#toggleSide").onclick = () => {
      const hidden = $("#topoMain").classList.toggle("is-side-hidden");
      $("#toggleSide").innerHTML = icon(hidden ? "chevronRight" : "chevronLeft");
      $("#toggleSide").setAttribute("aria-label", hidden ? "Mostrar lista de equipamentos" : "Ocultar lista de equipamentos");
      setTimeout(fit, 60);
    };
    $("#btnFlow").onclick = () => {
      state.flow = !state.flow;
      $("#btnFlow").setAttribute("aria-pressed", String(state.flow));
      renderEdges();
    };
    $("#expandAll").onclick = () => {
      const comEquip = visibleSites().filter((s) => devicesOf(s.id).length);
      const abrir = state.expanded.size < comEquip.length;
      state.expanded = abrir ? new Set(comEquip.map((s) => s.id)) : new Set();
      $("#expandAll").textContent = abrir ? "Recolher tudo" : "Expandir tudo";
      fit();
      renderList();
    };
    $("#btnManage").onclick = openManage;
    $("#btnLayout").onclick = toggleLayoutEdit;
    $("#layoutSave").onclick = saveLayout;
    $("#layoutDiscard").onclick = discardLayout;
    $("#layoutAuto").onclick = () => askConfirm({
      title: "Voltar ao layout automático?",
      text: "As posições manuais de todos os POPs são descartadas e o mapa volta a se organizar sozinho.",
      confirmLabel: "Usar layout automático",
      onConfirm: () => {
        state.layout = {};
        state.layoutDirty = true;
        layout();
        renderAll();
        renderLayoutBar();
        fit();
      },
    });
    renderLayoutBar();

    $$("[data-view]").forEach((b) => (b.onclick = () => {
      state.view = b.dataset.view;
      $$("[data-view]").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
      const mapa = state.view === "mapa";
      $("#stage").hidden = !mapa;
      $(".topo-side").hidden = !mapa;
      $("#listView").hidden = mapa;
      if (mapa) setTimeout(fit, 30);
    }));

    const params = new URLSearchParams(location.search);
    const wanted = params.get("device");
    const wantedSite = params.get("pop");
    if (wanted && device(wanted)) {
      state.expanded.add(siteOf(device(wanted)));
      state.selected = wanted;
      layout(); renderAll();
      setTimeout(() => { centerOn(wanted); openDevice(wanted); }, 200);
    } else if (wantedSite) {
      state.expanded.add(wantedSite);
      layout(); renderAll();
      setTimeout(() => centerOnBox(wantedSite), 200);
    }
  }

  boot();
})();
