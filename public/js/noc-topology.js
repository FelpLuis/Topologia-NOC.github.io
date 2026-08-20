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
  /* Cada tela que usa este runtime (rede NOC, GPON, PARTE ISP) lembra o próprio
     modo de visualização: quem trabalha no mapa de fibra não quer que a
     topologia principal também abra em modo geográfico. */
  const VIEW_KEY = `updown.topo.view.${document.body.dataset.scope || "noc"}.${location.pathname}`;
  /* A tela pode abrir direto no modo que faz sentido para ela. O atributo não
     pode ser data-view: os botões do seletor de modo usam esse nome e o <body>
     entraria na mesma varredura, virando um quarto botão invisível que desfaz
     a troca de modo no borbulhar do clique. */
  const VIEW_INICIAL = document.body.dataset.vista || "";
  const state = {
    query: "", cats: new Set(), selected: null,
    expanded: new Set(),
    scale: 1, tx: 0, ty: 0, flow: true, view: "mapa",
    boxes: {}, nodes: {}, world: { w: 1, h: 1, fit: 1 },
    /* layout: posições manuais dos POPs, gravadas em config.layout e válidas
       para todos os usuários. Vazio = posicionamento automático. */
    editLayout: false, layout: {}, layoutDirty: false, dragEndAt: 0,
    /* Modo geográfico: as caixas saem da coordenada cadastrada em cada POP e o
       fundo vem dos tiles do OpenStreetMap. `k` é o fator de escala do mapa
       (2^zoom, podendo ser fracionário) e ox/oy a origem do mundo em px.
       geoDraft guarda as coordenadas arrastadas e ainda não gravadas. */
    geo: { k: 0, ox: 0, oy: 0 }, geoDraft: {}, geoDirty: false,
    /* No mapa geográfico o POP começa como um alfinete e só vira card quando
       clicado — num mapa, cinco cards abertos tapam a cidade inteira. */
    geoOpen: new Set(),
    /* Anel óptico (aba POPs): posições manuais dos POPs no diagrama do anel. */
    ringLayout: {}, ringDirty: false, ringDraft: {},
  };
  let basemap = null; // camada de tiles, criada na primeira vez que o mapa OSM abre
  const isGeo = () => state.view === "geo";
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
  /* Nome, endereço e localização são cadastro do POP; as rotas têm ação
     própria, a mesma exigida pela tela POPs. */
  const podeEditarPop = () => NOC.canAll(["topology.edit", "pops.edit"]);
  const podeEditarRotas = () => NOC.canAll(["topology.edit", "pops.routes"]);

  /* ---------- OLT: detecção e estrutura de portas (compartilhada com ISP) ---------- */
  function isOLT(equipamento) {
    const cat = String(equipamento?.categoria || "").toLowerCase();
    return cat.includes("olt") || cat === "olts" || cat === "gpon";
  }

  function gerarPortasOLT() {
    const portas = [];
    let numero = 1;

    // 17 placas de tráfego GBIC/GPON com 16 portas cada (slots 1-17)
    for (let slot = 1; slot <= 17; slot++) {
      for (let porta = 1; porta <= 16; porta++) {
        portas.push({
          numero: numero++,
          slot,
          subslot: porta,
          tipoPlaca: "Linha",
          tecnologia: "GBIC/GPON",
          capacidade: "1.25 / 2.5 Gbps",
          tipo: "SFP",
          status: "livre",
        });
      }
    }

    // 2 placas de gerência com 4 portas ópticas + 3 portas RJ45 cada (slots 18-19)
    for (let slot = 18; slot <= 19; slot++) {
      for (let porta = 1; porta <= 4; porta++) {
        portas.push({
          numero: numero++,
          slot,
          subslot: porta,
          tipoPlaca: "Gerência",
          tecnologia: "Óptica",
          capacidade: "1 Gbps",
          tipo: "SFP",
          status: "livre",
        });
      }
      for (let porta = 5; porta <= 7; porta++) {
        portas.push({
          numero: numero++,
          slot,
          subslot: porta,
          tipoPlaca: "Gerência",
          tecnologia: "Elétrica",
          capacidade: "1 Gbps",
          tipo: "RJ45",
          status: "livre",
        });
      }
    }

    // 1 placa uplink com 2 portas ópticas XG + 2 portas ópticas G2 (slot 20)
    const slot = 20;
    for (let porta = 1; porta <= 2; porta++) {
      portas.push({
        numero: numero++,
        slot,
        subslot: porta,
        tipoPlaca: "Uplink",
        tecnologia: "10G",
        capacidade: "10 Gbps",
        tipo: "SFP+",
        status: "livre",
      });
    }
    for (let porta = 3; porta <= 4; porta++) {
      portas.push({
        numero: numero++,
        slot,
        subslot: porta,
        tipoPlaca: "Uplink",
        tecnologia: "2.5G",
        capacidade: "2.5 Gbps",
        tipo: "SFP",
        status: "livre",
      });
    }

    return portas;
  }

  const device = (id) => (NOC.data()?.equipamentos || []).find((e) => e.id === id);
  const sites = () => [
    ...NOC.pops().map((p) => ({
      id: p.id, nome: p.nome, tipo: "POP",
      local: p.endereco || (p.rotas || []).length + " rota(s)",
      coords: NOC.popCoords(p),
    })),
    { id: SEM_POP, nome: "SEM POP VINCULADO", local: "Equipamentos aguardando vínculo", tipo: "Pendente", coords: null },
  ];
  const siteById = (id) => sites().find((s) => s.id === id);
  const siteOf = (e) => NOC.effectivePop(e) || SEM_POP;
  const devicesOf = (siteId) => (NOC.data()?.equipamentos || []).filter((e) => siteOf(e) === siteId);
  const visibleSites = () => sites().filter((s) => s.id !== SEM_POP || devicesOf(SEM_POP).length);

  /* Coordenada em vigor: a arrastada e ainda não gravada tem prioridade sobre
     a do cadastro, para o arrasto responder na hora. */
  const coordsOf = (siteId) => state.geoDraft[siteId] || NOC.popCoords(NOC.popById(siteId));
  const geoSites = () => visibleSites().filter((s) => coordsOf(s.id));
  const semLocal = () => visibleSites().filter((s) => !coordsOf(s.id));
  // Sites desenhados no mapa: no modo geográfico, só os que têm onde ser postos.
  const mapSites = () => (isGeo() ? geoSites() : visibleSites());

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
    syncFilterButton();
  }

  function syncFilterButton() {
    const button = $("#toggleFilters");
    if (!button) return;
    const count = state.cats.size + (state.query ? 1 : 0);
    const badge = $("#activeFilterCount");
    badge.textContent = String(count);
    badge.hidden = count === 0;
    button.classList.toggle("has-active", count > 0);
    button.title = count
      ? `${count} filtro${count === 1 ? " ativo" : "s ativos"}`
      : "Mostrar filtros de equipamentos";
  }

  function renderList() {
    const eqs = NOC.data()?.equipamentos || [];
    $("#listCount").textContent = `${eqs.filter(matches).length} de ${eqs.length} equipamentos`;
    const deviceList = $("#deviceList");
    if (!deviceList) return;

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

    deviceList.innerHTML = html || `<div class="empty">
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

  /* ---------------- anel óptico (aba POPs) ---------------- */
  const norm = (s) => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
  const nomeCurto = (p) => norm(p?.nome).replace(/^pop\s*/, "").trim();
  const tipoDaRota = (r) => (/subterr/i.test(r) ? "Subterrânea" : "Aérea");
  const rotaAponta = (rota, alvo) => !!nomeCurto(alvo) && norm(rota).includes(nomeCurto(alvo));

  function renderPopsView() {
    const popsList = $("#popsList");
    if (!popsList) return;
    const canEdit = NOC.canAll(["topology.edit", "topology.pop.link"]);
    const canEditPop = NOC.canAll(["topology.edit", "pops.edit"]);
    const canCreatePop = NOC.canAll(["topology.edit", "pops.create"]);
    const canRingLayout = NOC.canAll(["topology.edit", "pops.ring.layout"]);

    const pops = NOC.pops();
    popsList.innerHTML = pops.length ? pops.map((pop, i) => {
      const list = NOC.devicesOfPop(pop.id);
      const s = NOC.statsOf(list);
      return `<article class="card" id="pop-${esc(pop.id)}">
        <div class="card-head">
          <div class="row" style="gap:var(--s-4);align-items:flex-start">
            <span class="pop-marker purple" style="height:46px"></span>
            <div>
              <span class="kicker">Ponto de presença</span>
              <h2 style="margin:4px 0 2px">${esc(pop.nome)}</h2>
              <p class="dim mono" style="font-size:var(--fs-11)">${esc(pop.id)}</p>
              ${pop.endereco ? `<p class="dim" style="font-size:var(--fs-12);margin-top:4px">${icon("pops")} ${esc(pop.endereco)}</p>` : ""}
            </div>
          </div>
          <span class="row" style="gap:6px">
            <span class="badge">${list.length} equipamento(s)</span>
            <button class="btn btn-sm" type="button" data-edit-pop="${esc(pop.id)}"
              ${canEditPop ? "" : "disabled title='Requer as ações topology.edit + pops.edit'"}>${icon("edit")} Editar informações</button>
            <button class="btn btn-danger btn-sm" type="button" data-delete-pop="${esc(pop.id)}"
              ${NOC.canAll(["topology.edit", "topology.delete", "pops.delete"]) ? "" : "disabled title='Requer as ações topology.edit + topology.delete + pops.delete'"}>${icon("trash")} Excluir</button>
          </span>
        </div>

        <div class="card-body stack">
          <div class="kv">
            <div><label>Portas</label><strong>${s.portas}</strong></div>
            <div><label>Em uso</label><strong>${s.emUso}</strong></div>
            <div><label>Livres</label><strong>${s.livres}</strong></div>
            <div><label>Ocupação</label><strong>${s.ocup}<span class="unit">%</span></strong></div>
          </div>
          <span class="meter ${NOC.occClass(s.ocup)}"><span style="width:${s.ocup}%"></span></span>

          <div>
            <h3 style="font-size:var(--fs-12);margin-bottom:var(--s-2)">Rotas do anel</h3>
            <div class="row wrap" style="gap:6px">
              ${(pop.rotas || []).length ? pop.rotas.map((r) => `<span class="badge ${/subterr/i.test(r) ? "badge-info" : ""}">${esc(r)}</span>`).join("")
                : '<span class="dim" style="font-size:var(--fs-12)">Nenhuma rota cadastrada.</span>'}
            </div>
          </div>

          ${(pop.equipamentos || []).length ? `<div>
            <h3 style="font-size:var(--fs-12);margin-bottom:var(--s-2)">Anotações de campo</h3>
            <div class="stack" style="gap:var(--s-2)">
              ${pop.equipamentos.map((e) => `<div class="device-row">
                <b>${esc(e.nome || "—")}</b>
                <small>${esc(e.modelo || "")}</small>
                ${e.observacao ? `<small class="dim">${esc(e.observacao)}</small>` : ""}
              </div>`).join("")}
            </div>
          </div>` : ""}

          <div>
            <div class="row-between" style="margin-bottom:var(--s-2)">
              <h3 style="font-size:var(--fs-12)">Equipamentos vinculados</h3>
              <button class="btn btn-ghost btn-sm" type="button" data-add="${esc(pop.id)}" ${canEdit ? "" : "disabled"}>
                ${icon("plus")} Vincular equipamento</button>
            </div>
            <div class="stack" style="gap:var(--s-2)">
              ${list.length ? list.map((e) => {
                const o = NOC.occupancy(e);
                return `<div class="device-row">
                  <div class="row-top">
                    <div class="grow" style="min-width:0">
                      <b class="truncate">${esc(e.nome)}</b>
                      ${NOC.isSuggested(e) ? '<span class="badge badge-warn">sugerido</span>' : ""}
                      <br><small class="truncate">${esc(e.modelo || "")} • ${esc(e.categoria || "")}</small>
                    </div>
                    <div class="row wrap" style="gap:6px;justify-content:flex-end">
                      <a class="btn btn-sm" href="/topologia.html?device=${encodeURIComponent(e.id)}">Abrir</a>
                      <button class="btn btn-sm" type="button" data-unlink="${esc(e.id)}" ${canEdit ? "" : "disabled"}>Desvincular</button>
                    </div>
                  </div>
                  <div class="row" style="gap:var(--s-3)">
                    <span class="meter meter-sm ${NOC.occClass(o)} grow"><span style="width:${o}%"></span></span>
                    <small class="mono dim">${NOC.usedPorts(e)}/${e.portas.length} portas</small>
                  </div>
                </div>`;
              }).join("") : `<div class="empty" style="padding:var(--s-6) 0">
                  <span class="empty-icon">${icon("port")}</span>
                  <b>Nenhum equipamento vinculado</b>
                  <p>Este POP existe no anel, mas ainda não tem equipamento associado.</p>
                </div>`}
            </div>
          </div>
        </div>
      </article>`;
    }).join("") : `<div class="card"><div class="empty">
      <span class="empty-icon">${icon("pops")}</span><b>Nenhum POP cadastrado</b>
      <p>Adicione o primeiro POP para começar a montar o anel óptico.</p>
      <button class="btn btn-sm btn-primary" type="button" data-new-pop style="margin-top:var(--s-3)" ${canCreatePop ? "" : "disabled"}>Adicionar POP</button></div></div>`;

    $$("#popsList [data-unlink]").forEach((b) => (b.onclick = () => vincular(b.dataset.unlink, null)));
    $$("#popsList [data-add]").forEach((b) => (b.onclick = () => openLink(b.dataset.add)));
    $$("#popsList [data-edit-pop]").forEach((b) => (b.onclick = () => openEditPop(b.dataset.editPop)));
    $$("#popsList [data-delete-pop]").forEach((b) => (b.onclick = () => deletePop(b.dataset.deletePop)));
    $$("#popsList [data-new-pop]").forEach((b) => (b.onclick = openNewPop));

    renderRingTopo();
    renderStatsTopo();
  }

  /* ---------------- anel óptico (aba POPs) - renderização ---------------- */
  const RING = { w: 260, h: 240, cx: 130, cy: 120, r: 92, minX: 30, maxX: 230, minY: 26, maxY: 210 };
  const nomeExibicao = (p) => {
    const base = String(p?.nome || "").replace(/^POP\s*/i, "").trim();
    if (/\p{Ll}/u.test(base)) return base;
    return base.toLowerCase().replace(/(^|[\s\-/])(\p{L})/gu, (m, sep, c) => sep + c.toUpperCase());
  };
  const preso = (v, min, max) => Math.max(min, Math.min(max, Math.round(v)));

  function ringPos(p, i, total) {
    const m = state.ringLayout[p.id];
    if (m && Number.isFinite(+m.x) && Number.isFinite(+m.y)) return { x: +m.x, y: +m.y };
    const ang = (i / total) * Math.PI * 2 - Math.PI / 2;
    return { x: RING.cx + RING.r * Math.cos(ang), y: RING.cy + RING.r * Math.sin(ang) };
  }

  function renderRingTopo() {
    const host = $("#ringMapTopo");
    const bar = $("#ringBarTopo");
    const pops = NOC.pops();
    if (!host) return;
    if (!pops.length) {
      host.innerHTML = '<p class="dim" style="font-size:var(--fs-12)">Sem POPs cadastrados.</p>';
      if (bar) bar.hidden = true;
      return;
    }
    const pos = {};
    pops.forEach((p, i) => (pos[p.id] = ringPos(p, i, pops.length)));
    const links = ringLinks();

    host.innerHTML = `
      <svg class="ring-svg ${state.ringDirty ? "is-editing" : ""}" viewBox="0 0 ${RING.w} ${RING.h}"
           style="width:100%;height:auto;touch-action:none" role="img"
           aria-label="Diagrama do anel óptico entre os POPs">
        ${links.map((l) => {
          const a = pos[l.a], b = pos[l.b];
          if (!a || !b) return "";
          const sub = l.tipos.has("Subterrânea");
          return `<line x1="${a.x}" y1="${a.y}" x2="${b.x}" y2="${b.y}"
            stroke="${sub ? "var(--purple-400)" : "var(--cyan-400)"}" stroke-width="1.6"
            stroke-dasharray="${sub ? "6 5" : "0"}" opacity=".7"></line>`;
        }).join("")}
        ${pops.map((p) => {
          const q = pos[p.id];
          const s = NOC.statsOf(NOC.devicesOfPop(p.id));
          const manual = !!state.ringLayout[p.id];
          return `<g class="ring-node" data-pop="${esc(p.id)}">
            <circle cx="${q.x}" cy="${q.y}" r="13" fill="var(--surface-1)"
              stroke="${manual && state.ringDirty ? "var(--purple-400)" : "var(--cyan-400)"}" stroke-width="1.6"/>
            <text x="${q.x}" y="${q.y + 3.5}" text-anchor="middle" style="font:700 9px var(--font-mono);fill:var(--text-1);pointer-events:none">${s.ocup}%</text>
            <text x="${q.x}" y="${q.y + (q.y < RING.cy ? -20 : 30)}" text-anchor="middle" style="font:700 9px var(--font-sans);fill:var(--text-3);pointer-events:none">${esc(nomeExibicao(p))}</text>
            <title>${esc(p.nome)}${state.ringDirty ? " — arraste para posicionar" : ""}</title>
          </g>`;
        }).join("")}
      </svg>
      <div class="stack" style="gap:6px;margin-top:var(--s-3);font-size:var(--fs-11)">
        <span class="row" style="gap:var(--s-2)"><i style="width:16px;height:2px;background:var(--cyan-400);display:block"></i> Rota aérea</span>
        <span class="row" style="gap:var(--s-2)"><i style="width:16px;height:2px;background:var(--purple-400);display:block"></i> Rota subterrânea</span>
      </div>`;
    renderRingBarTopo();
    bindRingDragTopo();
  }

  function renderRingBarTopo() {
    const bar = $("#ringBarTopo");
    if (!bar) return;
    bar.hidden = !state.ringDirty;
    const n = Object.keys(state.ringLayout).length;
    const status = $("#ringStatusTopo");
    if (status) status.textContent = state.ringDirty
      ? "posições não salvas"
      : n ? `${n} POP(s) posicionado(s)` : "arraste os POPs no diagrama";
    const save = $("#ringSaveTopo");
    const discard = $("#ringDiscardTopo");
    const auto = $("#ringAutoTopo");
    if (save) save.disabled = !state.ringDirty;
    if (discard) discard.disabled = !state.ringDirty;
    if (auto) auto.disabled = !n;
    const btn = $("#btnRingTopo");
    if (btn) {
      btn.setAttribute("aria-pressed", String(state.ringDirty));
      btn.textContent = state.ringDirty ? "Sair do mapa" : "Editar mapa";
    }
  }

  function bindRingDragTopo() {
    const host = $("#ringMapTopo");
    if (!host || !state.ringDirty) return;
    host.addEventListener("pointerdown", (ev) => {
      const no = ev.target.closest(".ring-node");
      const svg = host.querySelector("svg");
      if (!no || !svg) return;
      ev.preventDefault();
      const id = no.dataset.pop;
      const pops = NOC.pops();
      const atual = ringPos(pops.find((p) => p.id === id), pops.findIndex((p) => p.id === id), pops.length);
      const rect = svg.getBoundingClientRect();
      const escala = RING.w / (rect.width || RING.w);
      const dx = atual.x - (ev.clientX - rect.left) * escala;
      const dy = atual.y - (ev.clientY - rect.top) * escala;
      const sx = ev.clientX, sy = ev.clientY;
      let quadro = null, ativo = false;

      const mover = (e) => {
        if (!ativo && Math.abs(e.clientX - sx) + Math.abs(e.clientY - sy) < 3) return;
        ativo = true;
        state.ringLayout[id] = {
          x: preso((e.clientX - rect.left) * escala + dx, RING.minX, RING.maxX),
          y: preso((e.clientY - rect.top) * escala + dy, RING.minY, RING.maxY),
        };
        state.ringDirty = true;
        if (!quadro) quadro = requestAnimationFrame(() => { quadro = null; renderRingTopo(); });
      };
      const soltar = () => {
        removeEventListener("pointermove", mover);
        removeEventListener("pointerup", soltar);
        removeEventListener("pointercancel", soltar);
        renderRingTopo();
      };
      addEventListener("pointermove", mover);
      addEventListener("pointerup", soltar);
      addEventListener("pointercancel", soltar);
    });
  }

  function renderStatsTopo() {
    const vinculados = NOC.data().equipamentos.filter((e) => NOC.effectivePop(e));
    const s = NOC.statsOf(vinculados);
    const stats = $("#ringStatsTopo");
    if (stats) stats.innerHTML = `
      <div><label>POPs</label><strong>${NOC.pops().length}</strong></div>
      <div><label>Rotas</label><strong>${ringLinks().length}</strong></div>
      <div><label>Portas</label><strong>${s.portas}</strong></div>
      <div><label>Sem POP</label><strong>${NOC.unlinked().length}</strong></div>`;
  }

  /* ---------------- gestão de POPs (aba POPs) ---------------- */
  async function persistPop(reason, mensagem, undo) {
    try {
      await NOC.save(reason);
      renderPopsView();
      toast(mensagem.titulo, {
        text: mensagem.texto,
        type: mensagem.tipo || "ok",
        action: undo ? { label: "Desfazer", run: undo } : null,
      });
      return true;
    } catch (err) {
      renderPopsView();
      toast("Não foi possível salvar", { text: err.message, type: "danger", timeout: 7000 });
      return false;
    }
  }

  function openNewPop() {
    modal({
      labelledBy: "newPopTitle",
      html: `
        <form id="newPopForm">
          <div class="modal-head">
            <div><span class="kicker">Ponto de presença</span>
              <h2 id="newPopTitle" style="margin-top:6px">Adicionar POP</h2>
              <p class="muted" style="font-size:var(--fs-13);margin-top:4px">O novo POP entra no fim da sequência do anel.</p></div>
            <button class="btn btn-ghost btn-icon" data-close type="button" aria-label="Fechar">${icon("close")}</button>
          </div>
          <div class="modal-body stack">
            <div class="field">
              <label for="newPopName">Nome do POP *</label>
              <input class="input" id="newPopName" required placeholder="Ex.: POP ASCENTY" autocomplete="off">
            </div>
            <div class="field">
              <label for="newPopAddress">Endereço</label>
              <input class="input" id="newPopAddress" placeholder="Rua, número, bairro, cidade e CEP">
            </div>
            <div class="alert alert-info" style="animation:none">${icon("info")}
              <span>Depois do cadastro, use <b>Rotas</b> para ligá-lo ao anel óptico e <b>Vincular equipamento</b> para associar o inventário.</span>
            </div>
          </div>
          <div class="modal-foot">
            <span class="dim" style="font-size:var(--fs-11)">O identificador é criado automaticamente.</span>
            <span class="row"><button class="btn" data-close type="button">Cancelar</button>
            <button class="btn btn-primary" type="submit">Adicionar POP</button></span>
          </div>
        </form>`,
      onMount: (host, close) => {
        const form = $("#newPopForm", host);
        const name = $("#newPopName", form);
        name.focus();
        form.onsubmit = async (ev) => {
          ev.preventDefault();
          const nome = name.value.trim();
          if (!nome) return name.focus();
          const t = NOC.data();
          const base = nome.replace(/^pop\s+/i, "").trim() || nome;
          const novo = {
            id: NOC.novoId("pop", base, t.pops),
            nome,
            endereco: $("#newPopAddress", form).value.trim(),
            rotas: [],
            equipamentos: [],
          };
          if (!novo.endereco) delete novo.endereco;
          t.pops.push(novo);

          const ok = await persistPop("TOPOLOGY_CREATE_POP", {
            titulo: `${nome} adicionado`,
            texto: "Agora você pode criar as rotas do anel e vincular equipamentos.",
          }, async () => {
            t.pops = t.pops.filter((p) => p.id !== novo.id);
            await persistPop("TOPOLOGY_DELETE_POP", { titulo: "Cadastro desfeito", tipo: "info" });
          });
          if (ok) close();
          else t.pops = t.pops.filter((p) => p.id !== novo.id);
        };
      },
    });
  }

  function deleteRequirements(pop) {
    const t = NOC.data();
    const codes = ["topology.edit", "topology.delete", "pops.delete"];
    if (t.equipamentos.some((e) => e.popId === pop.id)) codes.push("topology.pop.link");
    if (t.pops.some((p) => p.id !== pop.id && (p.rotas || []).some((r) => rotaAponta(r, pop)))) codes.push("pops.routes");
    if (t.config?.ringLayout?.[pop.id]) codes.push("pops.ring.layout");
    return codes;
  }

  function deletePop(popId) {
    const pop = NOC.popRecord(popId);
    if (!pop) return;
    const required = deleteRequirements(pop);
    if (!NOC.canAll(required)) {
      toast("Seu perfil não pode excluir este POP", {
        text: `A exclusão e a limpeza dos vínculos exigem: ${required.join(" + ")}.`,
        type: "warn",
      });
      return;
    }

    const vinculados = NOC.data().equipamentos.filter((e) => e.popId === pop.id).length;
    const referencias = NOC.data().pops.reduce((n, p) => n + (p.id === pop.id ? 0 : (p.rotas || []).filter((r) => rotaAponta(r, pop)).length), 0);
    askConfirm({
      title: `Excluir ${pop.nome}?`,
      text: [
        "O POP será removido do cadastro e do anel óptico.",
        vinculados ? `${vinculados} equipamento(s) ficarão sem POP.` : "",
        referencias ? `${referencias} referência(s) de rota serão removidas.` : "",
      ].filter(Boolean).join(" "),
      confirmLabel: "Excluir POP",
      danger: true,
      onConfirm: () => removePop(pop),
    });
  }

  async function removePop(pop) {
    const t = NOC.data();
    const popsAntes = JSON.parse(JSON.stringify(t.pops));
    const vinculosAntes = t.equipamentos.map((e) => ({ id: e.id, popId: e.popId ?? null }));
    const ringAntes = { ...(t.config?.ringLayout || {}) };
    const stateRingAntes = { ...state.ringLayout };

    t.pops = t.pops
      .filter((p) => p.id !== pop.id)
      .map((p) => ({ ...p, rotas: (p.rotas || []).filter((r) => !rotaAponta(r, pop)) }));
    t.equipamentos.forEach((e) => { if (e.popId === pop.id) e.popId = null; });
    if (t.config?.ringLayout) delete t.config.ringLayout[pop.id];
    delete state.ringLayout[pop.id];

    const restore = () => {
      t.pops = JSON.parse(JSON.stringify(popsAntes));
      const porId = new Map(vinculosAntes.map((v) => [v.id, v.popId]));
      t.equipamentos.forEach((e) => { if (porId.has(e.id)) e.popId = porId.get(e.id); });
      t.config = t.config || {};
      t.config.ringLayout = { ...ringAntes };
      state.ringLayout = { ...stateRingAntes };
    };

    const ok = await persistPop("TOPOLOGY_DELETE_POP", {
      titulo: `${pop.nome} excluído`,
      texto: "Os vínculos ficaram pendentes e as referências do anel foram limpas.",
      tipo: "warn",
    }, async () => {
      restore();
      await persistPop("TOPOLOGY_CREATE_POP", { titulo: "POP restaurado", tipo: "info" });
    });
    if (!ok) { restore(); renderPopsView(); }
  }

  function openEditPop(popId) {
    const pop = (NOC.data()?.pops || []).find((item) => item.id === popId);
    if (!pop) return;
    const canEditRoutes = NOC.canAll(["topology.edit", "pops.routes"]);
    const canRename = NOC.canAll(["topology.edit", "pops.edit", "pops.routes"]);

    const noteRow = (e = {}) => `<div class="device-row pop-note">
      <div class="row" style="gap:var(--s-3);align-items:flex-start">
        <div class="field grow"><label>Nome / identificação</label><input class="input" data-note-name value="${esc(e.nome || "")}" placeholder="Ex.: Rack principal"></div>
        <div class="field grow"><label>Modelo / detalhe</label><input class="input" data-note-model value="${esc(e.modelo || "")}" placeholder="Ex.: Huawei S6730"></div>
        <button class="btn btn-sm btn-icon" data-remove-note type="button" aria-label="Remover anotação" title="Remover anotação">${icon("close")}</button>
      </div>
      <div class="field"><label>Observação</label><textarea class="textarea" data-note-observation rows="2" placeholder="Informações úteis para a equipe de campo">${esc(e.observacao || "")}</textarea></div>
    </div>`;

    modal({
      wide: true,
      labelledBy: "editPopTitle",
      html: `
        <form id="editPopForm">
          <div class="modal-head">
            <div><span class="kicker">Ponto de presença</span>
              <h2 id="editPopTitle" style="margin-top:6px">Editar informações do POP</h2>
              <p class="muted mono" style="font-size:var(--fs-12);margin-top:4px">${esc(pop.id)} · identificador permanente</p></div>
            <button class="btn btn-ghost btn-icon" data-close type="button" aria-label="Fechar">${icon("close")}</button>
          </div>
          <div class="modal-body stack">
            <div class="field">
              <label for="editPopName">Nome do POP *</label>
              <input class="input" id="editPopName" required value="${esc(pop.nome || "")}" ${canRename ? "" : "readonly"}>
              ${canRename ? '<small class="dim">Ao renomear, as referências existentes no anel também serão atualizadas.</small>'
                : '<small class="dim">Para renomear também é necessária a permissão de editar rotas.</small>'}
            </div>
            <div class="field">
              <label for="editPopAddress">Endereço</label>
              <input class="input" id="editPopAddress" value="${esc(pop.endereco || "")}" placeholder="Rua, número, bairro, cidade e CEP">
              <small class="dim">Informe o endereço físico onde o POP está instalado.</small>
            </div>
            <div class="field">
              <label for="editPopRoutes">Rotas do anel</label>
              <textarea class="textarea mono" id="editPopRoutes" rows="5" ${canEditRoutes ? "" : "readonly"}
                placeholder="Aérea → Santos&#10;Subterrânea → Cubatão">${esc((pop.rotas || []).join("\n"))}</textarea>
              <small class="dim">Digite uma rota por linha, no formato “Aérea → Destino” ou “Subterrânea → Destino”.${canEditRoutes ? "" : " Seu perfil não permite editar rotas."}</small>
            </div>
            <div class="row-between">
              <div><h3 style="font-size:var(--fs-13)">Anotações de campo</h3><small class="dim">Dados descritivos do local; não alteram os equipamentos vinculados.</small></div>
              <button class="btn btn-sm" id="addPopNote" type="button">${icon("plus")} Adicionar anotação</button>
            </div>
            <div class="stack" id="popNotes" style="gap:var(--s-2)">
              ${(pop.equipamentos || []).map(noteRow).join("") || '<p class="dim" data-no-notes>Nenhuma anotação cadastrada.</p>'}
            </div>
          </div>
          <div class="modal-foot">
            <span class="dim" style="font-size:var(--fs-11)">A alteração será registrada na auditoria.</span>
            <span class="row"><button class="btn" data-close type="button">Cancelar</button>
            <button class="btn btn-primary" type="submit">Salvar informações</button></span>
          </div>
        </form>`,
      onMount: (host, close) => {
        const form = $("#editPopForm", host);
        const notes = $("#popNotes", host);
        const bindRemove = () => $$("[data-remove-note]", notes).forEach((b) => (b.onclick = () => {
          b.closest(".pop-note")?.remove();
          if (!$(".pop-note", notes)) notes.innerHTML = '<p class="dim" data-no-notes>Nenhuma anotação cadastrada.</p>';
        }));
        bindRemove();
        $("#addPopNote", host).onclick = () => {
          $("[data-no-notes]", notes)?.remove();
          notes.insertAdjacentHTML("beforeend", noteRow());
          bindRemove();
          const fields = $$("[data-note-name]", notes);
          fields[fields.length - 1]?.focus();
        };

        form.onsubmit = async (ev) => {
          ev.preventDefault();
          const nome = $("#editPopName", form).value.trim();
          if (!nome) return $("#editPopName", form).focus();
          const antes = JSON.parse(JSON.stringify(NOC.data().pops || []));
          const nomeAnterior = pop.nome;
          const mudouNome = nome !== nomeAnterior;
          const rotas = $("#editPopRoutes", form).value.split(/\r?\n/).map((rota) => rota.trim()).filter(Boolean);

          if (mudouNome) {
            for (const outro of NOC.data().pops) {
              if (outro.id === pop.id || !Array.isArray(outro.rotas)) continue;
              outro.rotas = outro.rotas.map((rota) => rotaAponta(rota, pop)
                ? `${tipoDaRota(rota)} → ${nomeExibicao({ nome })}`
                : rota);
            }
          }
          pop.nome = nome;
          pop.endereco = $("#editPopAddress", form).value.trim();
          if (canEditRoutes) pop.rotas = rotas;
          pop.equipamentos = $$(".pop-note", notes).map((row) => ({
            nome: $("[data-note-name]", row).value.trim(),
            modelo: $("[data-note-model]", row).value.trim(),
            observacao: $("[data-note-observation]", row).value.trim(),
          })).filter((e) => e.nome || e.modelo || e.observacao);

          const ok = await persistPop(
            "TOPOLOGY_UPDATE_POP",
            { titulo: "Informações do POP salvas", texto: mudouNome ? `${nomeAnterior} passou a se chamar ${nome}.` : `${nome} foi atualizado.` },
            async () => {
              NOC.data().pops = JSON.parse(JSON.stringify(antes));
              await persistPop("TOPOLOGY_UPDATE_POP", { titulo: "Alteração do POP desfeita", tipo: "info" });
            }
          );
          if (ok) close();
          else {
            NOC.data().pops = antes;
            renderPopsView();
          }
        };
      },
    });
  }

  function openLink(popId) {
    const pop = NOC.popById(popId);
    const candidatos = NOC.data().equipamentos.filter((e) => e.popId !== popId);
    modal({
      labelledBy: "linkTitle",
      html: `
        <div class="modal-head">
          <div><span class="kicker">${esc(pop.nome)}</span>
            <h2 id="linkTitle" style="margin-top:6px">Vincular equipamento</h2>
            <p class="muted" style="font-size:var(--fs-13);margin-top:4px">Um equipamento pertence a um POP de cada vez. Ao vincular aqui, ele sai do POP anterior.</p></div>
          <button class="btn btn-ghost btn-icon" data-close type="button" aria-label="Fechar">${icon("close")}</button>
        </div>
        <div class="modal-body stack">
          <div class="field">
            <label for="linkSel">Equipamento</label>
            <select class="select" id="linkSel">
              ${candidatos.map((e) => {
                const atual = NOC.popById(e.popId);
                return `<option value="${esc(e.id)}">${esc(e.nome)} — ${atual ? esc(atual.nome) : "sem POP"}</option>`;
              }).join("")}
            </select>
          </div>
        </div>
        <div class="modal-foot">
          <span class="dim" style="font-size:var(--fs-11)">A troca é registrada na auditoria.</span>
          <span class="row"><button class="btn" data-close type="button">Cancelar</button>
          <button class="btn btn-primary" data-go type="button">Vincular</button></span>
        </div>`,
      onMount: (host, close) => {
        $("[data-go]", host).onclick = () => {
          const id = $("#linkSel", host).value;
          close();
          vincular(id, popId);
        };
      },
    });
  }

  /* ================= MAPA ================= */
  const SITE_W = 268, SITE_H = 156, DEV_W = 190, DEV_H = 118;
  const PAD = 18, HEAD = 92, GAP = 16, SITE_GAP = 92;
  /* Modo geográfico: folga ao redor dos POPs ao enquadrar e limites do zoom
     do mapa (nível 3 ≈ continente, nível 18 ≈ rua). MARKER é o alfinete que
     representa o POP fechado. */
  const GEO_PAD = 190, GEO_Z_MIN = 3, GEO_Z_MAX = 18, MARKER = 46;
  /* Vista padrão do mapa geográfico: a Baixada Santista a partir de Cubatão,
     no nível 12. É com ela que a tela abre — a rede inteira cabe e as ruas
     ainda são legíveis — e é o ponto de apoio para posicionar um POP que ainda
     não tem coordenada. */
  const VISTA_PADRAO = { lat: -23.896750, lon: -46.433127, zoom: 12 };
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

  /* ---------------- posicionamento geográfico ----------------
     O mundo do mapa é o Web Mercator: px = mercator(nível 0) × k − origem.
     Zoom no modo geográfico muda `k` (o mapa aproxima e os POPs se afastam
     entre si), e não a escala do transform — assim as caixas dos POPs mantêm
     o mesmo tamanho na tela, como marcadores de mapa. */
  const K_MIN = 2 ** GEO_Z_MIN, K_MAX = 2 ** GEO_Z_MAX;

  const geoPoint = (siteId) => {
    const c = coordsOf(siteId);
    if (!c) return null;
    const p = GEO.project(c.lat, c.lon);
    return { x: p.x * state.geo.k - state.geo.ox, y: p.y * state.geo.k - state.geo.oy };
  };
  const geoCoordsAt = (x, y) => GEO.unproject((x + state.geo.ox) / state.geo.k, (y + state.geo.oy) / state.geo.k);

  /* Escolhe a escala e a origem que colocam um retângulo do mundo real no
     centro da tela. Serve tanto para os POPs quanto para a região padrão. */
  function enquadrar(min, max, folga) {
    const st = stage().getBoundingClientRect();
    const dx = max.x - min.x, dy = max.y - min.y;
    const util = { w: Math.max(320, st.width - folga * 2), h: Math.max(240, st.height - folga * 2) };
    /* Escala exata da região, sem arredondar para o nível de tile de baixo:
       arredondar custava até metade da área e a região ficava pequena no meio
       da tela. O tile mais próximo é redimensionado no máximo ~40%, o que num
       fundo de mapa não se nota. Os botões de zoom continuam andando de um
       nível inteiro por vez, e aí o tile volta ao tamanho nativo.
       Sem extensão (um POP só, ou POPs no mesmo ponto): zoom de bairro. */
    const bruto = dx > 1e-9 || dy > 1e-9
      ? Math.min(dx > 1e-9 ? util.w / dx : Infinity, dy > 1e-9 ? util.h / dy : Infinity)
      : 2 ** 14;
    const k = GEO.clamp(bruto, K_MIN, K_MAX);
    // A origem é escolhida para o centro da região cair no centro do palco.
    state.geo = {
      k,
      ox: ((min.x + max.x) / 2) * k - st.width / 2,
      oy: ((min.y + max.y) / 2) * k - st.height / 2,
    };
    state.scale = 1;
    state.tx = 0;
    state.ty = 0;
  }

  /* Vista de abertura: o ponto de referência no centro, no nível padrão. */
  function geoPadrao() {
    const st = stage().getBoundingClientRect();
    const p = GEO.project(VISTA_PADRAO.lat, VISTA_PADRAO.lon);
    const k = 2 ** VISTA_PADRAO.zoom;
    state.geo = { k, ox: p.x * k - st.width / 2, oy: p.y * k - st.height / 2 };
    state.scale = 1;
    state.tx = 0;
    state.ty = 0;
    layout();
    renderAll();
    applyTransform();
  }

  /* "Ajustar à tela" do modo geográfico: enquadra os POPs já localizados, sem
     nunca aproximar mais que o nível padrão — dois POPs vizinhos jogariam o
     mapa para a escala de quarteirão, longe da vista de trabalho. Sem nenhum
     POP localizado, volta à vista de abertura. */
  function geoFit() {
    const pontos = geoSites().map((s) => {
      const c = coordsOf(s.id);
      return GEO.project(c.lat, c.lon);
    });
    // Onde há camada de fibra, "ajustar à tela" também precisa mostrar os cabos.
    const merc = window.FIBRA?.limites?.();
    if (merc) pontos.push({ x: merc.x0, y: merc.y0 }, { x: merc.x1, y: merc.y1 });
    if (!pontos.length) return geoPadrao();
    enquadrar(
      { x: Math.min(...pontos.map((p) => p.x)), y: Math.min(...pontos.map((p) => p.y)) },
      { x: Math.max(...pontos.map((p) => p.x)), y: Math.max(...pontos.map((p) => p.y)) },
      90
    );
    if (state.geo.k > 2 ** VISTA_PADRAO.zoom) {
      // Reaproveita o centro já calculado e apenas afrouxa a escala.
      const st = stage().getBoundingClientRect();
      const centro = {
        x: (state.geo.ox + st.width / 2) / state.geo.k,
        y: (state.geo.oy + st.height / 2) / state.geo.k,
      };
      const k = 2 ** VISTA_PADRAO.zoom;
      state.geo = { k, ox: centro.x * k - st.width / 2, oy: centro.y * k - st.height / 2 };
    }
    layout();
    renderAll();
    applyTransform();
  }

  /* Enquadramento de abertura do mapa geográfico. Na topologia é sempre a
     mesma vista de trabalho; no mapa de fibra, cujo conteúdo é a malha inteira,
     abrir enquadrando tudo é o que se espera (<body data-geo="fit">). */
  const aberturaGeo = () => (document.body.dataset.enquadrar === "tudo" ? geoFit() : geoPadrao());

  /* Aproxima/afasta o mapa mantendo fixo o ponto sob o cursor (ou o centro). */
  function geoZoom(fator, originX, originY) {
    const st = stage().getBoundingClientRect();
    const cx = originX ?? st.width / 2, cy = originY ?? st.height / 2;
    const k = GEO.clamp(state.geo.k * fator, K_MIN, K_MAX);
    if (k === state.geo.k) return;
    // ponto do mundo sob o cursor → coordenada mercator → nova origem
    const wx = (cx - state.tx) / state.scale, wy = (cy - state.ty) / state.scale;
    const mx = (wx + state.geo.ox) / state.geo.k, my = (wy + state.geo.oy) / state.geo.k;
    state.geo = { k, ox: mx * k - wx, oy: my * k - wy };
    layout();
    renderAll();
    applyTransform(false);
  }

  // POP fechado no mapa é um alfinete; aberto, é o card de sempre.
  const geoAberto = (siteId) => state.geoOpen.has(siteId) || state.expanded.has(siteId);
  const geoSize = (s) => (geoAberto(s.id) ? siteSize(s) : { w: MARKER, h: MARKER });

  function layoutGeo() {
    const st = stage().getBoundingClientRect();
    if (!state.geo.k) state.geo.k = 2 ** 12;

    const medidas = geoSites().map((s) => ({ site: s, ...geoSize(s) }));
    const pontos = {};
    medidas.forEach(({ site }) => (pontos[site.id] = geoPoint(site.id)));

    /* Rede de proteção do tamanho do mundo. Assim que a primeira coordenada é
       cadastrada, o POP cai a centenas de milhares de pixels da origem em uso
       — o div do mapa ia junto e a tela inteira saía do lugar. Quando isso
       acontece, a origem é trazida de volta para perto do conteúdo; o
       deslocamento entra na origem e sai do pan na mesma medida, então a vista
       não se mexe. Dentro do limite nada é tocado: reancorar a cada layout
       brigaria com o enquadramento. */
    /* A camada de fibra desenha neste mesmo mundo. Os limites dela vêm em
       coordenadas do Mercator no nível 0, independentes da origem em uso, e
       entram tanto na reancoragem quanto no tamanho do mundo — sem isso um cabo
       que passa fora da área dos POPs seria cortado. */
    const merc = window.FIBRA?.limites?.() || null;
    const fibraEm = () => (merc ? {
      x0: merc.x0 * state.geo.k - state.geo.ox, y0: merc.y0 * state.geo.k - state.geo.oy,
      x1: merc.x1 * state.geo.k - state.geo.ox, y1: merc.y1 * state.geo.k - state.geo.oy,
    } : null);

    const LIMITE = 20000;
    if (medidas.length || merc) {
      const canto = (m, eixo) => pontos[m.site.id][eixo] - (eixo === "x" ? m.w : (geoAberto(m.site.id) ? HEAD : m.h)) / 2;
      const f = fibraEm();
      const cantoX = Math.min(...medidas.map((m) => canto(m, "x")), ...(f ? [f.x0] : []));
      const cantoY = Math.min(...medidas.map((m) => canto(m, "y")), ...(f ? [f.y0] : []));
      if (Math.abs(cantoX) > LIMITE || Math.abs(cantoY) > LIMITE) {
        const sx = Math.round(cantoX - GEO_PAD), sy = Math.round(cantoY - GEO_PAD);
        state.geo.ox += sx;
        state.geo.oy += sy;
        state.tx += sx * state.scale;
        state.ty += sy * state.scale;
        medidas.forEach(({ site }) => { pontos[site.id].x -= sx; pontos[site.id].y -= sy; });
      }
    }

    const boxes = {};
    medidas.forEach(({ site, w, h }) => {
      const p = pontos[site.id];
      /* O alfinete fica centrado no ponto. Já o card é centrado só na
         horizontal e ancorado pelo cabeçalho na vertical: ao expandir os
         equipamentos ele cresce para baixo, sem escorregar do lugar. */
      const aberto = geoAberto(site.id);
      boxes[site.id] = {
        x: Math.round(p.x - w / 2),
        y: Math.round(p.y - (aberto ? HEAD : h) / 2),
        w, h, px: p.x, py: p.y, geo: true, marcador: !aberto,
      };
    });

    state.boxes = boxes;
    state.nodes = {};
    geoSites().forEach((s) => placeNodes(s.id));

    const cantos = Object.values(boxes);
    const f = fibraEm();
    const bordas = [
      ...cantos.map((b) => ({ x: b.x + b.w, y: b.y + b.h })),
      ...(f ? [{ x: f.x1, y: f.y1 }] : []),
    ];
    const maxW = bordas.length ? Math.max(...bordas.map((b) => b.x)) + GEO_PAD : Math.max(900, st.width);
    const maxH = bordas.length ? Math.max(...bordas.map((b) => b.y)) + GEO_PAD : Math.max(600, st.height);
    state.world = { w: Math.max(maxW, st.width), h: Math.max(maxH, st.height), fit: 1 };

    const w = world();
    w.style.width = state.world.w + "px";
    w.style.height = state.world.h + "px";
    $("#edges").setAttribute("viewBox", `0 0 ${state.world.w} ${state.world.h}`);
  }

  /* Tiles do OpenStreetMap para a janela visível. Só o que está na tela é
     pedido — o mundo inteiro em px seria grande demais para desenhar.
     Um quadro por vez: o arrasto do mapa dispara isto a cada movimento. */
  let tilesAgendado = false;
  function renderBasemap() {
    if (tilesAgendado) return;
    tilesAgendado = true;
    // Vale o primeiro dos dois que chegar; o segundo vira operação vazia.
    const executar = () => {
      if (!tilesAgendado) return;
      tilesAgendado = false;
      pintarTiles();
    };
    /* requestAnimationFrame não dispara em aba oculta (o telão do NOC ao fundo,
       um preview embutido): o temporizador garante que os tiles sejam montados
       assim mesmo. */
    requestAnimationFrame(executar);
    setTimeout(executar, 120);
  }

  function pintarTiles() {
    const host = $("#basemap");
    if (!host) return;
    if (!isGeo()) { host.hidden = true; if (basemap) basemap.clear(); return; }
    // Antes do primeiro enquadramento não há escala de mapa: sem ela o cálculo
    // do tile não tem sentido.
    if (!Number.isFinite(state.geo.k) || state.geo.k <= 0) return;
    host.hidden = false;
    if (!basemap) basemap = GEO.basemap(host);
    const st = stage().getBoundingClientRect();
    const margem = 256; // uma faixa de tiles além da borda, para o pan não abrir buraco
    basemap.render({
      k: state.geo.k, ox: state.geo.ox, oy: state.geo.oy, escala: state.scale,
      x0: (-state.tx) / state.scale - margem,
      y0: (-state.ty) / state.scale - margem,
      x1: (st.width - state.tx) / state.scale + margem,
      y1: (st.height - state.ty) / state.scale + margem,
    });
  }

  function layout() {
    if (isGeo()) return layoutGeo();
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

  /* No modo geográfico a linha sai do ponto da coordenada, não do centro da
     caixa: expandir um POP não deve deslocar a rota que chega até ele. */
  const boxCenter = (id) => {
    const b = state.boxes[id];
    if (!b) return null;
    return b.geo ? { x: b.px, y: b.py } : { x: b.x + b.w / 2, y: b.y + b.h / 2 };
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

  /* Cor da linha: verde quando o Zabbix vê as duas pontas no ar, vermelho
     quando alguma caiu, âmbar quando só parte do feixe caiu. Enlace sem
     interface monitorada continua cinza — a linha não afirma o que não foi
     medido. */
  function edgeStatus(conns) {
    const estados = conns.map(NOC.linkStatus).filter((s) => s !== "sem-dado");
    if (!estados.length) return { classe: "", titulo: "sem dado do Zabbix" };
    const caidos = estados.filter((s) => s === "down").length;
    if (!caidos) return { classe: "is-up", titulo: "no ar" };
    if (caidos === estados.length) return { classe: "is-down", titulo: "fora do ar" };
    return { classe: "is-partial", titulo: `${caidos} de ${estados.length} enlaces fora do ar` };
  }

  /* Enlaces documentados que ligam dois POPs. É o que dá tráfego à rota do
     anel: a rota vem do campo `rotas` do cadastro e não conhece porta nenhuma,
     então a carga dela é a soma dos enlaces que atravessam aquele par. */
  function conexoesEntreSites(a, b) {
    return (NOC.data()?.conexoes || []).filter((c) => {
      const da = device(c.origem), db = device(c.destino);
      if (!da || !db) return false;
      const sa = siteOf(da), sb = siteOf(db);
      return (sa === a && sb === b) || (sa === b && sb === a);
    });
  }

  function renderEdges() {
    const parts = [];
    const medidas = [];   // alimenta a legenda de utilização
    const rings = ringLinks();
    rings.forEach((r, i) => {
      const a = boxCenter(r.a), b = boxCenter(r.b);
      if (!a || !b) return;
      const d = curve(a, b);
      const carga = TRAF.doConjunto(conexoesEntreSites(r.a, r.b));
      medidas.push(carga);
      const nome = `${nomeDoSite(r.a)} ↔ ${nomeDoSite(r.b)}`;
      const t = TRAF.atributos(carga, nome, `Anel óptico — ${[...r.tipos].join(" e ")}`);
      /* A rota do anel é tracejada e mantém a espessura menor: ela é o caminho
         físico, não o enlace. A cor, porém, é a mesma escala — senão o mapa
         teria dois vocabulários de cor. */
      parts.push(`
        <path class="topo-edge is-ring is-traf" d="${d}" data-ring="${i}"
              style="stroke:${t.cor};stroke-width:2;opacity:.85"
              data-traf="${esc(t.dica)}"><title>${esc(t.title)}</title></path>
        <path class="traf-alvo" d="${d}" data-ring="${i}" data-traf="${esc(t.dica)}"/>`);
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
      const est = edgeStatus(e.conns);
      /* A linha só anima o fluxo quando o enlace está no ar: um enlace caído
         com tráfego correndo por cima seria a informação errada. */
      const fluxo = state.flow && !dim && est.classe !== "is-down";

      /* Cor por utilização, na mesma escala da legenda. O status continua na
         classe porque ele decide o tracejado e o texto da dica — só a cor
         deixou de sair dele. */
      const carga = TRAF.doConjunto(e.conns);
      medidas.push(carga);
      const t = TRAF.atributos(carga, nomeDoEnlace(e), `${label} — ${est.titulo}`);
      const trafego = TRAF.rotulo(carga);
      const alto = carga.estado === "up" ? 30 : 19;

      parts.push(`
        <path class="topo-edge is-traf ${est.classe} ${active ? "is-active" : ""} ${dim ? "is-dim" : ""}"
              d="${d}" data-edge="${i}" style="stroke:${t.cor}"
              data-traf="${esc(t.dica)}"><title>${esc(t.title)}</title></path>
        ${fluxo ? `<path class="topo-flow" d="${d}" style="stroke:${t.cor}"/>` : ""}
        <path class="traf-alvo" d="${d}" data-edge="${i}" data-traf="${esc(t.dica)}"/>
        <g data-edge="${i}" data-traf="${esc(t.dica)}" style="${dim ? "opacity:.22" : ""}">
          <rect class="topo-edge-chip ${est.classe}" x="${mx - 46}" y="${my - 8 - alto}" width="92" height="${alto}" rx="6"/>
          <text class="topo-edge-label" x="${mx}" y="${my - 12 - (alto - 19)}" text-anchor="middle">${esc(label)}</text>
          ${carga.estado === "up"
            ? `<text class="topo-edge-traf" x="${mx}" y="${my - 12}" text-anchor="middle" style="fill:${t.cor}">${esc(trafego)}</text>`
            : ""}
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
    renderTrafLegend(medidas);
  }

  const nomeDoSite = (id) => (id === SEM_POP ? "Sem POP" : NOC.popById(id)?.nome || id);
  const nomeDoEnlace = (e) => {
    const nome = (k) => (k.startsWith("d:")
      ? device(k.slice(2))?.nome || k.slice(2)
      : nomeDoSite(k.slice(2)));
    return `${nome(e.ka)} ↔ ${nome(e.kb)}`;
  };

  /* A legenda vive no mesmo painel da legenda de símbolos: são as duas coisas
     que o operador consulta com o olho, e separá-las obrigaria a procurar em
     dois cantos da tela. */
  function renderTrafLegend(medidas) {
    const host = $("#trafLegend");
    if (!host) return;
    const erro = TRAF.erro();
    const quando = TRAF.coletadoEm();
    host.innerHTML = `
      <div class="traf-legenda-titulo">
        <b>Utilização dos enlaces</b>
        <span class="${erro ? "traf-legenda-aviso" : ""}">${erro
          ? "sem leitura nova do Zabbix"
          : quando ? `medido às ${esc(horaLegenda(quando))}` : "aguardando o Zabbix"}</span>
      </div>
      ${TRAF.legendaHTML(medidas)}`;
  }

  const horaLegenda = (iso) => {
    const bruto = String(iso);
    const d = new Date(bruto.includes("T") ? bruto : `${bruto.replace(" ", "T")}Z`);
    return Number.isNaN(d.getTime()) ? bruto : d.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
  };

  /* Estado operacional do POP, do jeito que a caixa e o alfinete precisam.
     POP com todos os equipamentos fora do ar pisca em vermelho: é a única
     situação que exige alguém agora. */
  const ESTADOS = {
    offline: { classe: "is-offline", titulo: "todos os equipamentos fora do ar", badge: "badge-danger", dot: "dot-danger", rotulo: "Offline" },
    degradado: { classe: "is-degradado", titulo: "parte dos equipamentos fora do ar", badge: "badge-warn", dot: "dot-warn", rotulo: "Degradado" },
    online: { classe: "is-online", titulo: "no ar", badge: "badge-ok", dot: "dot-ok", rotulo: "Online" },
    "sem-dado": { classe: "", titulo: "sem dado do Zabbix", badge: "", dot: "", rotulo: "" },
  };
  const siteEstado = (siteId) => ESTADOS[siteId === SEM_POP ? "sem-dado" : NOC.popStatus(siteId)] || ESTADOS["sem-dado"];

  function renderSites() {
    const host = $("#nodes");
    host.innerHTML = mapSites().map((s) => {
      const b = state.boxes[s.id];
      if (!b) return "";
      const st = siteStats(s.id);
      const aberto = state.expanded.has(s.id);
      const temEquip = st.list.length > 0;
      const dim = state.query && !st.list.some(matches);
      const pendente = s.id === SEM_POP;
      const estado = siteEstado(s.id);

      /* No mapa geográfico, POP fechado é um alfinete: o card inteiro sobre
         cada cidade tapava o mapa. A cor é o estado operacional vindo do
         Zabbix e o número é a quantidade de equipamentos, então o alfinete já
         diz o essencial — e pisca em vermelho quando o POP inteiro cai. */
      if (b.marcador) {
        const posicionadoM = !!state.geoDraft[s.id];
        return `<button class="topo-marker ${estado.classe} ${dim ? "is-dim" : ""} ${state.editLayout && posicionadoM ? "is-locating" : ""}"
                  type="button" data-box="${esc(s.id)}" data-marker="${esc(s.id)}"
                  style="left:${b.x}px;top:${b.y}px;width:${b.w}px;height:${b.h}px"
                  title="${esc(s.nome)} — ${esc(estado.titulo)}, ${st.list.length} equipamento(s), ${st.ocup}% de ocupação"
                  aria-label="${esc(s.nome)}, ${esc(estado.titulo)}, ${st.list.length} equipamentos, ${st.ocup}% de ocupação. ${state.editLayout ? "Arraste para posicionar." : "Abrir o card."}">
          <span class="marker-icon">${icon("pops")}</span>
          ${st.list.length ? `<span class="marker-count">${st.list.length}</span>` : ""}
          <span class="marker-label">${esc(s.nome)}</span>
        </button>`;
      }

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

      const posicionado = isGeo() ? !!state.geoDraft[s.id] : !!state.layout[s.id];
      return `<section class="topo-site ${estado.classe} ${aberto ? "is-expanded" : ""} ${pendente ? "" : "is-core"} ${dim ? "is-dim" : ""} ${state.editLayout && posicionado ? "is-placed" : ""} ${state.editLayout && posicionado && isGeo() ? "is-locating" : ""}"
                data-box="${esc(s.id)}" style="left:${b.x}px;top:${b.y}px;width:${b.w}px;height:${b.h}px">
        ${b.geo ? '<span class="site-pin"></span>' : ""}
        ${b.geo ? `<button class="site-close" type="button" data-collapse="${esc(s.id)}"
          title="Fechar o card e voltar ao alfinete" aria-label="Fechar o card de ${esc(s.nome)}">${icon("close")}</button>` : ""}
        ${state.editLayout ? `<span class="site-grip">${icon("sort")} ${isGeo() ? "arraste até o local" : "arraste"}</span>` : ""}
        <button class="site-head" type="button" data-site="${esc(s.id)}" aria-expanded="${aberto}"
                ${temEquip ? "" : 'data-empty="1"'}
                ${temEquip || state.editLayout ? "" : 'disabled title="Nenhum equipamento vinculado a este POP"'}>
          <span class="site-chevron">${icon(aberto ? "chevronDown" : "chevronRight")}</span>
          <span class="grow" style="min-width:0">
            <span class="row" style="gap:6px">
              <span class="badge ${pendente ? "badge-warn" : "badge-brand"}">${esc(s.tipo)}</span>
              ${estado.rotulo ? `<span class="badge ${estado.badge}"><i class="dot ${estado.dot}"></i>${estado.rotulo}</span>` : ""}
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
    // Alfinete → card. No modo de localização o clique é do arrasto, não abre.
    $$("[data-marker]", host).forEach((b) => (b.onclick = () => {
      if (performance.now() - state.dragEndAt < 300) return;
      if (state.editLayout) return;
      abrirCard(b.dataset.marker);
    }));
    $$("[data-collapse]", host).forEach((b) => (b.onclick = (ev) => {
      ev.stopPropagation();
      fecharCard(b.dataset.collapse);
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
      const livre = isGeo(); // no mapa geográfico não há malha nem canto de origem
      b.x = livre ? Math.round(ox + (ev.clientX - sx) / state.scale)
        : Math.max(0, Math.round((ox + (ev.clientX - sx) / state.scale) / GRID) * GRID);
      b.y = livre ? Math.round(oy + (ev.clientY - sy) / state.scale)
        : Math.max(0, Math.round((oy + (ev.clientY - sy) / state.scale) / GRID) * GRID);
      // O ponto da coordenada é o centro do alfinete, ou o cabeçalho do card.
      if (livre) { b.px = b.x + b.w / 2; b.py = b.y + (b.marcador ? b.h : HEAD) / 2; }
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
      if (isGeo()) {
        /* Arrastar no mapa geográfico é cadastrar a localização: a posição da
           caixa volta a ser latitude e longitude. */
        const c = geoCoordsAt(b.px, b.py);
        state.geoDraft[siteId] = { lat: c.lat, lon: c.lon };
      } else {
        state.layout[siteId] = { x: b.x, y: b.y };
      }
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
    const geo = isGeo();
    const n = geo ? Object.keys(state.geoDraft).length : Object.keys(state.layout).length;
    $("#layoutTitle").textContent = geo ? "Definindo a localização" : "Editando o layout";
    $("#layoutStatus").textContent = state.layoutDirty
      ? "alterações ainda não salvas"
      : geo
        ? "arraste o POP até o local dele no mapa"
        : n ? `${n} POP(s) com posição própria` : "arraste os POPs para posicionar";
    $("#layoutSave").disabled = !state.layoutDirty;
    $("#layoutSave").textContent = geo ? "Salvar localizações" : "Salvar posições";
    $("#layoutDiscard").disabled = !state.layoutDirty;
    // "Layout automático" só faz sentido no mapa esquemático.
    $("#layoutAuto").hidden = geo;
    $("#layoutAuto").disabled = !Object.keys(state.layout).length;
    const b = $("#btnLayout");
    b.setAttribute("aria-pressed", String(state.editLayout));
    b.textContent = state.editLayout
      ? (geo ? "Sair da localização" : "Sair do layout")
      : (geo ? "Definir localização" : "Editar layout");
    stage().classList.toggle("is-editing-layout", state.editLayout);
  }

  /* O botão exige ações diferentes conforme o modo: no mapa esquemático ele
     grava config.layout; no geográfico, o cadastro do POP. */
  function syncLayoutButton() {
    const b = $("#btnLayout");
    if (!b) return;
    const liberado = isGeo() ? podeEditarPop() : NOC.canAll(["topology.edit", "topology.layout"]);
    b.disabled = !liberado;
    b.classList.toggle("is-denied", !liberado);
    b.title = liberado
      ? (isGeo() ? "Arraste cada POP até o local dele no mapa" : "Posicione as caixas dos POPs no mapa")
      : `Requer a ação ${isGeo() ? "topology.edit + pops.edit" : "topology.edit + topology.layout"} no seu perfil.`;
    renderLayoutBar();
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
        title: isGeo() ? "Sair sem salvar as localizações?" : "Sair sem salvar as posições?",
        text: "Os POPs voltam para onde estavam na última gravação.",
        confirmLabel: "Descartar alterações",
        danger: true,
        onConfirm: () => { discardLayout(); setLayoutEdit(false); },
      });
      return;
    }
    setLayoutEdit(!state.editLayout);
    if (state.editLayout) toast(isGeo() ? "Definindo a localização dos POPs" : "Modo de layout ativo", {
      text: isGeo()
        ? "Arraste cada POP até o ponto dele no mapa e clique em “Salvar localizações”. Para digitar as coordenadas, use Gerenciar rede → POPs."
        : "Arraste a caixa de cada POP e depois clique em “Salvar posições”.",
      type: "info",
      timeout: 8000,
    });
  }

  function discardLayout() {
    state.layout = { ...(NOC.data()?.config?.layout || {}) };
    state.geoDraft = {};
    state.layoutDirty = false;
    layout();
    renderAll();
    renderLayoutBar();
    fit();
  }

  /* Grava as coordenadas arrastadas no cadastro dos POPs. Vai para a mesma
     auditoria de sempre e exige pops.edit, como qualquer alteração de POP. */
  async function saveGeoLayout() {
    const alvos = Object.entries(state.geoDraft)
      .map(([id, c]) => ({ pop: NOC.popRecord(id), c }))
      .filter((x) => x.pop);
    if (!alvos.length) { state.layoutDirty = false; renderLayoutBar(); return; }

    const antes = alvos.map(({ pop }) => ({ pop, lat: pop.lat ?? null, lon: pop.lon ?? null }));
    const rascunho = { ...state.geoDraft };
    alvos.forEach(({ pop, c }) => { pop.lat = Number(c.lat.toFixed(6)); pop.lon = Number(c.lon.toFixed(6)); });
    state.geoDraft = {};
    state.layoutDirty = false;

    const ok = await persist(
      "TOPOLOGY_POP_LOCATION",
      {
        titulo: alvos.length === 1 ? "Localização gravada" : `${alvos.length} localizações gravadas`,
        texto: "Os POPs passam a aparecer nesse ponto do mapa para todos os usuários.",
      },
      async () => {
        antes.forEach(({ pop, lat, lon }) => { pop.lat = lat; pop.lon = lon; });
        await persist("TOPOLOGY_POP_LOCATION", { titulo: "Localização anterior restaurada", tipo: "info" });
      }
    );
    if (!ok) {
      // O que o usuário arrastou não se perde: volta a ser rascunho na tela.
      antes.forEach(({ pop, lat, lon }) => { pop.lat = lat; pop.lon = lon; });
      state.geoDraft = rascunho;
      state.layoutDirty = true;
      layout();
      renderAll();
    }
    renderLayoutBar();
  }

  async function saveLayout() {
    if (isGeo()) return saveGeoLayout();
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

  /* Card do POP no mapa geográfico. Um de cada vez, como o balão de qualquer
     mapa: dois cards abertos já cobrem duas cidades vizinhas. */
  function abrirCard(id) {
    state.geoOpen = new Set([id]);
    layout();
    renderAll();
    centerOnBox(id);
  }

  function fecharCard(id) {
    state.geoOpen.delete(id);
    state.expanded.delete(id); // volta ao alfinete, sem os equipamentos abertos
    layout();
    renderAll();
    applyTransform();
  }

  function fecharCards() {
    if (!state.geoOpen.size && !state.expanded.size) return false;
    state.geoOpen.clear();
    state.expanded.clear();
    layout();
    renderAll();
    applyTransform();
    return true;
  }

  function toggleSite(id) {
    const abrindo = !state.expanded.has(id);
    abrindo ? state.expanded.add(id) : state.expanded.delete(id);
    layout();
    renderAll();
    // No mapa geográfico o enquadramento é do usuário: recolher um POP não
    // pode reposicionar o mapa inteiro embaixo dele.
    if (abrindo) centerOnBox(id);
    else if (isGeo()) applyTransform();
    else fit();
  }

  /* ---------------- zoom / pan ---------------- */
  function applyTransform(animate = true) {
    const w = world();
    w.classList.toggle("no-anim", !animate);
    w.style.transform = `translate(${state.tx}px, ${state.ty}px) scale(${state.scale})`;
    if (isGeo()) {
      renderBasemap();
      $("#zoomLabel").textContent = "z" + GEO.tileZoom(state.geo.k, state.scale);
    } else {
      $("#zoomLabel").textContent = Math.round(state.scale * 100) + "%";
    }
  }
  function setScale(next, originX, originY) {
    /* No mapa geográfico o zoom é do mapa: muda a escala do Mercator, e as
       caixas dos POPs continuam do mesmo tamanho na tela. O passo é de um
       nível inteiro, como em qualquer mapa — assim o tile é sempre desenhado
       no tamanho nativo, sem borrar. */
    if (isGeo()) return geoZoom(next > state.scale ? 2 : 0.5, originX, originY);
    const s = Math.min(2, Math.max(0.25, next));
    const st = stage().getBoundingClientRect();
    const cx = originX ?? st.width / 2, cy = originY ?? st.height / 2;
    state.tx = cx - ((cx - state.tx) * s) / state.scale;
    state.ty = cy - ((cy - state.ty) * s) / state.scale;
    state.scale = s;
    applyTransform(false);
  }
  function fit() {
    if (isGeo()) return geoFit();
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
    if (!isGeo()) state.scale = Math.max(0.4, Math.min(0.9, (st.width - 120) / b.w, (st.height - 120) / b.h));
    state.tx = st.width / 2 - (b.x + b.w / 2) * state.scale;
    state.ty = st.height / 2 - (b.y + b.h / 2) * state.scale;
    applyTransform();
  }
  function centerOn(id) {
    const n = state.nodes[id];
    const a = n ? { x: n.x + DEV_W / 2, y: n.y + DEV_H / 2 } : boxCenter(siteOf(device(id) || {}));
    if (!a) return;
    const st = stage().getBoundingClientRect();
    if (!isGeo()) state.scale = Math.max(state.scale, 0.65);
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
    /* A camada de fibra desenha elementos clicáveis dentro do mesmo palco: eles
       não podem ser confundidos com o fundo do mapa, senão clicar num cabo
       arrastaria a tela. */
    const ignore = ".topo-device, .site-head, .topo-marker, .site-close, .topo-hud,"
      + " [data-edge], [data-ring], [data-fibra], [data-caixa], [data-vertice], [data-inserir]";
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
      if (moved || e.target.closest(ignore)) return;
      // Clique no mapa vazio fecha o card aberto, como em qualquer mapa.
      if (isGeo() && !state.editLayout && fecharCards()) return;
      if (state.selected) { state.selected = null; renderAll(); }
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
  /* Cabeçalho da gaveta em pedaços: depois de editar o cadastro ou as portas,
     ele é repintado sem fechar e reabrir a gaveta. */
  const kickerDevice = (e) => `${esc(siteById(siteOf(e))?.nome || "Sem POP")} • ${esc(e.categoria || "Equipamento")}`;
  function badgesDevice(e) {
    const o = NOC.occupancy(e);
    const s = NOC.statusInfo(e);
    return `
      <span class="badge ${s.badge}">${s.dot ? `<i class="dot ${s.dot}"></i>` : ""}${s.label}</span>
      <span class="badge">${(e.portas || []).length} portas</span>
      <span class="badge ${o > 85 ? "badge-danger" : o > 60 ? "badge-warn" : "badge-info"}">${o}% ocupado</span>
      ${NOC.isSuggested(e) ? '<span class="badge badge-warn">vínculo sugerido</span>' : ""}`;
  }

  function openDevice(id) {
    const e = device(id);
    if (!e) return;
    state.selected = id;
    renderSites();
    renderEdges();
    renderList();

    drawer({
      labelledBy: "devTitle",
      html: `
        <header class="drawer-head">
          <div class="row-between" style="align-items:flex-start">
            <div>
              <span class="kicker" id="devKicker">${kickerDevice(e)}</span>
              <h2 id="devTitle" style="margin:6px 0 4px">${esc(e.nome)}</h2>
              <p class="muted" id="devModelo" style="font-size:var(--fs-13)">${esc(e.modelo || "Modelo não informado")}</p>
            </div>
            <button class="btn btn-ghost btn-icon" data-close type="button" aria-label="Fechar detalhe">${icon("close")}</button>
          </div>
          <div class="row wrap" id="devBadges" style="gap:6px;margin-top:var(--s-4)">${badgesDevice(e)}</div>
          <div class="tabs" style="margin-top:var(--s-4)" role="tablist" aria-label="Seções do equipamento">
            <button class="tab" role="tab" aria-selected="true" data-tab="portas">Portas</button>
            <button class="tab" role="tab" aria-selected="false" data-tab="conexoes">Conexões <span class="badge" id="devConnCount">${NOC.connectionsOf(id).length}</span></button>
            ${NOC.can("topology.connection.use") ? '<button class="tab" role="tab" aria-selected="false" data-tab="acesso">Acesso</button>' : ""}
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
        /* Editar o cadastro, uma porta ou um enlace muda o cabeçalho e as
           contagens: a gaveta inteira se repinta sozinha. */
        repaintDevice = () => {
          if (!document.body.contains(body)) return;
          $("#devKicker", host).innerHTML = kickerDevice(e);
          $("#devTitle", host).textContent = e.nome;
          $("#devModelo", host).textContent = e.modelo || "Modelo não informado";
          $("#devBadges", host).innerHTML = badgesDevice(e);
          $("#devConnCount", host).textContent = NOC.connectionsOf(e.id).length;
          paint();
        };
        paint();
        /* Tráfego ao vivo: enquanto a gaveta está aberta, a leitura sai do
           Zabbix em tempo real (realtime=1) e a gaveta repinta as portas a
           cada leitura. O inscrito se remove sozinho quando o host — e com ele
           o body — sai do documento ao fechar a gaveta. */
        let pararTraf = null;
        pararTraf = TRAF.acompanhar(() => {
          if (!document.body.contains(body)) { pararTraf?.(); return; }
          paint();
        }, { tempoReal: true, intervaloMs: 15000 });
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

      <div class="row-between wrap" style="margin-bottom:var(--s-3);gap:var(--s-3)">
        <div><h3 style="font-size:var(--fs-13)">Face do equipamento</h3>
          <span class="dim" style="font-size:var(--fs-11)">Clique numa porta para ver ou editar o enlace</span></div>
        <button class="btn btn-sm" type="button" data-managerports
          ${podeEditarPorta() ? "" : "disabled title='Requer as ações topology.edit + topology.port.edit'"}>${icon("port")} Gerenciar portas</button>
      </div>
      <div class="port-grid" id="portGrid">
        ${e.portas.map((p) => {
          const on = NOC.portaEmUso(e.id, p.numero);
          /* Portas vindas do Zabbix trazem o nome real da interface (p.nome) e a
             descrição do enlace. Vão no title/aria-label: é o identificador que
             o operador usa no equipamento, e o número é só o índice do cadastro. */
          const identidade = [p.nome, p.capacidade, p.descricao].filter(Boolean).join(" • ");
          const rotulo = `Porta ${p.numero}${p.nome ? ` (${p.nome})` : ""}, ${on ? "em uso" : "livre"}${identidade ? `, ${identidade}` : ""}`;
          /* Cor por utilização, na mesma escala dos enlaces: a borda da porta
             acompanha o tráfego lido do Zabbix. Porta sem interface monitorada
             mantém a aparência de sempre — nenhuma cor é inventada. */
          const m = TRAF.medidaDePorta(e.id, p.numero);
          const trafCor = m && m.estado !== "sem-dado" ? TRAF.cor(m) : null;
          const trafTitulo = m && m.estado !== "sem-dado"
            ? `${identidade ? identidade + " • " : ""}${TRAF.rotulo(m)}`
            : (identidade || `Porta ${p.numero}`);
          return `<button class="port ${on ? "is-used" : ""} ${trafCor ? "is-traf" : ""}" type="button" data-port="${p.numero}"
                    style="${trafCor ? `--port-traf:${trafCor}` : ""}"
                    title="${esc(trafTitulo)}"
                    aria-label="${esc(rotulo)}">${String(p.numero).padStart(2, "0")}</button>`;
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
          <thead><tr><th>Porta</th><th>Capacidade</th><th>Tipo</th><th>Status</th><th>Tráfego</th><th>Conexão</th><th></th></tr></thead>
          <tbody id="portRows"></tbody>
        </table>
      </div>
      <p class="dim" style="font-size:var(--fs-11);margin-top:var(--s-3)">
        ${icon("info")} Status, capacidade e descrição vêm do inventário do Zabbix aplicado à topologia.
        O tráfego de cada porta é lido em tempo real enquanto esta gaveta está aberta.
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
        const m = TRAF.medidaDePorta(e.id, p.numero);
        const trafCell = m && m.estado !== "sem-dado"
          ? `<span class="port-traf" style="--port-traf:${TRAF.cor(m)}"
                title="${esc(TRAF.linhasDica(m, `Porta ${p.numero}`).join(" — "))}">${esc(TRAF.rotulo(m))}</span>`
          : '<span class="dim">—</span>';
        return `<tr>
          <td class="mono"><b>${String(p.numero).padStart(2, "0")}</b></td>
          <td>${esc(p.capacidade || "A confirmar")}</td>
          <td class="dim">${esc(p.tipo || "—")}</td>
          <td>${c ? '<span class="badge badge-ok"><i class="dot dot-ok"></i>Em uso</span>' : '<span class="badge">Livre</span>'}</td>
          <td>${trafCell}</td>
          <td>${remoto ? `<button class="btn btn-ghost btn-sm" data-goto="${esc(remoto.id)}">${esc(remoto.nome)} • porta ${remotaPorta}</button>` : '<span class="dim">—</span>'}</td>
          <td><button class="btn btn-ghost btn-sm btn-icon" data-editport="${p.numero}" type="button"
                aria-label="Editar a porta ${p.numero}" title="Editar porta e conexão"
                ${podeEditarPorta() ? "" : "disabled"}>${icon("edit")}</button></td>
        </tr>`;
      }).join("") : `<tr><td colspan="7"><div class="empty"><b>Nenhuma porta nesse filtro</b></div></td></tr>`;
      $$("#portRows [data-goto]", root).forEach((b) => (b.onclick = () => openDevice(b.dataset.goto)));
      $$("#portRows [data-editport]", root).forEach((b) => (b.onclick = () => openPort(e, +b.dataset.editport, { edit: true })));
    };
    $$("[data-pf]", root).forEach((b) => (b.onclick = () => {
      filter = b.dataset.pf;
      $$("[data-pf]", root).forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
      rows();
    }));
    $$("#portGrid .port", root).forEach((b) => (b.onclick = () => openPort(e, +b.dataset.port)));
    const gerenciar = $("[data-managerports]", root);
    if (gerenciar) gerenciar.onclick = () => openPortsManager(e);
    rows();
  }

  /* Portas do equipamento remoto que podem receber o enlace: as livres mais a
     que já está nesta ligação (senão o admin não conseguiria reeditá-la). 
     Busca primeiro no recorte atual, depois nos demais recortes. */
  async function findDeviceCrossScope(destId) {
    // Primeiro tenta no recorte atual (BACKBONE/noc)
    let d = device(destId);
    if (d) return d;
    
    // Se não encontrou, busca nos outros recortes
    try {
      const allScopes = await NOC.loadAllScopesEquipment();
      for (const scopeEquip of Object.values(allScopes)) {
        d = scopeEquip.find((x) => x.id === destId);
        if (d) return d;
      }
    } catch (err) {
      // Ignora erro e retorna null
    }
    return null;
  }

  const portasDisponiveis = async (destId, manter) => {
    const d = await findDeviceCrossScope(destId);
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

        const paint = async () => {
          const c = NOC.portConnection(e.id, numero);
          const remoto = c ? device(c.origem === e.id ? c.destino : c.origem) : null;
          const remotaPorta = c ? (c.origem === e.id ? c.portaDestino : c.portaOrigem) : null;
          /* Alterar ou apagar um enlace existente conta como remoção na API;
             documentar um enlace novo exige a ação de criação de enlace. */
          const semRemover = !!c && !canDelete;
          const semCriar = !c && !podeCriarEnlace();
          const travado = semRemover || semCriar;

          $("#portSub", host).textContent = `${p.tipo || "—"} • ${p.capacidade || "A confirmar"}`;
          const m = TRAF.medidaDePorta(e.id, numero);

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
              ${m && m.estado === "up" ? `
                <div class="card" style="padding:var(--s-4);border-left:3px solid ${TRAF.cor(m)}">
                  <span class="kicker">${icon("trafego")} Tráfego agora</span>
                  <div class="row wrap" style="gap:var(--s-5);margin-top:var(--s-3)">
                    <span class="mono"><small class="dim">Entrada</small><br><b style="font-size:var(--fs-14)">${esc(NOC.formatBps(m.entrada))}</b></span>
                    <span class="mono"><small class="dim">Saída</small><br><b style="font-size:var(--fs-14)">${esc(NOC.formatBps(m.saida))}</b></span>
                    ${m.capacidade > 0 ? `<span class="mono"><small class="dim">Utilização</small><br><b style="font-size:var(--fs-14)">${esc(TRAF.pctTexto(m.pct))}</b></span>` : ""}
                  </div>
                </div>` : ""}
              <div class="kv">
                <div><label>Status</label><strong style="font-size:var(--fs-14)">${esc(p.status || (c ? "conectada" : "livre"))}</strong></div>
                <div><label>Capacidade</label><strong style="font-size:var(--fs-14)">${esc(p.capacidade || "A confirmar")}</strong></div>
                ${p.nome ? `<div><label>Interface</label><strong class="mono" style="font-size:var(--fs-13)">${esc(p.nome)}</strong></div>` : ""}
              </div>
              ${p.descricao ? `<p class="muted mono" style="font-size:var(--fs-12)">
                Descrição no equipamento: ${esc(p.descricao)}</p>` : ""}
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
          
          // Carregar equipamentos de todos os recortes (BACKBONE, ISP, etc.)
          let todosEquipamentos = [];
          try {
            const allScopes = await NOC.loadAllScopesEquipment();
            for (const scopeEquip of Object.values(allScopes)) {
              todosEquipamentos.push(...scopeEquip);
            }
          } catch (err) {
            // Fallback: apenas equipamentos do recorte atual
            todosEquipamentos = (NOC.data()?.equipamentos || []);
          }
          const outros = todosEquipamentos.filter((x) => x.id !== e.id);
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

          const pintarPortas = async (selecionada) => {
            // a porta do enlace atual só continua ofertada no próprio equipamento remoto
            const manter = selDest.value === (remoto?.id || "") ? remotaPorta : null;
            const lista = await portasDisponiveis(selDest.value, manter);
            selPorta.innerHTML = lista.length
              ? lista.map((x) => `<option value="${x.numero}" ${Number(selecionada) === Number(x.numero) ? "selected" : ""}>Porta ${String(x.numero).padStart(2, "0")}${x.capacidade ? ` — ${esc(x.capacidade)}` : ""}</option>`).join("")
              : `<option value="">Sem portas livres</option>`;
            selPorta.disabled = travado || !selDest.value || !lista.length;
          };
          await pintarPortas(remotaPorta);
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

            // Buscar nome do equipamento destino (pode ser de outro recorte)
            const destinoEquip = await findDeviceCrossScope(destinoId);
            
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
                    ? `Conectada a ${destinoEquip?.nome || destinoId}, porta ${destinoPorta}.`
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
    const livres = (e.portas || []).filter((p) => !NOC.portaEmUso(e.id, p.numero));
    const cabeca = `
      <div class="row-between wrap" style="gap:var(--s-3);margin-bottom:var(--s-4)">
        <div><span class="kicker">Vínculos deste equipamento</span>
          <p class="dim" style="font-size:var(--fs-11);margin-top:4px">${list.length} enlace(s) documentado(s) •
            ${livres.length} porta(s) livre(s) para novos vínculos.</p></div>
        <button class="btn btn-sm btn-primary" type="button" data-newlink
          ${podeCriarEnlace() && livres.length ? "" : `disabled title='${podeCriarEnlace() ? "Nenhuma porta livre neste equipamento" : "Requer as ações topology.edit + topology.link.create"}'`}>${icon("plus")} Documentar enlace</button>
      </div>`;

    if (!list.length) {
      return `${cabeca}<div class="empty"><span class="empty-icon">${icon("link")}</span>
        <b>Sem enlaces cadastrados</b><p>Este equipamento ainda não possui conexões documentadas.</p></div>`;
    }
    return `${cabeca}<div class="stack">${list.map((c, i) => {
      const saida = c.origem === e.id;
      const remoto = device(saida ? c.destino : c.origem);
      return `<div class="card" style="padding:var(--s-4)">
        <div class="row-between wrap" style="gap:var(--s-3)">
          <div class="row" style="gap:var(--s-3)">
            <span class="badge badge-info">${esc(c.tipo || "Enlace")}</span>
            <div><b>${esc(remoto?.nome || (saida ? c.destino : c.origem))}</b>
              <br><small class="dim">porta ${saida ? c.portaOrigem : c.portaDestino} → porta ${saida ? c.portaDestino : c.portaOrigem}</small></div>
          </div>
          <div class="row wrap">
            <span class="badge">${esc(c.capacidade || "A confirmar")}</span>
            <button class="btn btn-sm" type="button" data-focus="${esc(remoto?.id || "")}">Ver no mapa</button>
            <button class="btn btn-sm" type="button" data-editlink="${saida ? c.portaOrigem : c.portaDestino}"
              ${podeEditarPorta() ? "" : "disabled title='Requer as ações topology.edit + topology.port.edit'"}>${icon("edit")} Editar</button>
            <button class="btn btn-danger btn-sm" type="button" data-dellink="${i}"
              ${podeRemoverEnlace() ? "" : "disabled title='Requer as ações topology.delete + topology.link.delete'"}>${icon("trash")} Remover</button>
          </div>
        </div>
      </div>`;
    }).join("")}</div>`;
  }
  function wireConn(e, root, close) {
    const list = NOC.connectionsOf(e.id);
    $$("[data-editlink]", root).forEach((b) => (b.onclick = () => openPort(e, +b.dataset.editlink, { edit: true })));
    $$("[data-dellink]", root).forEach((b) => (b.onclick = () => removerEnlace(e, list[+b.dataset.dellink])));

    const novo = $("[data-newlink]", root);
    if (novo) novo.onclick = () => {
      /* Documentar um enlace é preencher uma porta livre: a primeira delas já
         abre em modo de edição, com o seletor do outro lado pronto. */
      const livre = (e.portas || []).find((p) => !NOC.portaEmUso(e.id, p.numero));
      if (!livre) return toast("Sem porta livre", { text: "Cadastre ou libere uma porta antes de documentar o enlace.", type: "warn" });
      openPort(e, Number(livre.numero), { edit: true });
    };

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

  /* Desfaz um enlace pelos dois lados: some da lista de conexões e as duas
     portas voltam ao status livre. */
  function removerEnlace(e, c) {
    if (!c || !podeRemoverEnlace()) return;
    const remoto = device(c.origem === e.id ? c.destino : c.origem);
    askConfirm({
      title: "Remover este enlace?",
      text: `A ligação com ${remoto?.nome || "o outro equipamento"} deixa de existir na topologia. As duas portas voltam a ficar livres.`,
      confirmLabel: "Remover enlace",
      danger: true,
      onConfirm: async () => {
        const t = NOC.data();
        const backupConexoes = (t.conexoes || []).map((x) => ({ ...x }));
        const pontas = [[c.origem, c.portaOrigem], [c.destino, c.portaDestino]]
          .map(([id, numero]) => device(id)?.portas?.find((p) => Number(p.numero) === Number(numero)))
          .filter(Boolean);
        const antesPontas = pontas.map((p) => ({ ...p }));

        t.conexoes = (t.conexoes || []).filter((x) => x !== c);
        pontas.forEach((p) => { if (p.status === "conectada") p.status = "livre"; });

        const restaurar = () => {
          t.conexoes = backupConexoes;
          pontas.forEach((p, i) => Object.assign(p, antesPontas[i]));
        };
        const ok = await persist("TOPOLOGY_DELETE_CONEXAO",
          { titulo: "Enlace removido", texto: "As duas portas voltaram a ficar livres.", tipo: "warn" },
          async () => {
            restaurar();
            await persist("TOPOLOGY_UPDATE", { titulo: "Remoção desfeita", tipo: "info" });
            if (repaintDevice) repaintDevice();
          });
        if (!ok) { restaurar(); layout(); renderAll(); return; }
        if (repaintDevice) repaintDevice();
      },
    });
  }

  function targetAccessFields(data, target = {}) {
    const connect = new Set(target.connect_role_ids || []);
    const manage = new Set(target.manage_role_ids || []);
    return `<div class="row" style="gap:var(--s-5);align-items:flex-start">
      <div class="field grow"><label>Pode conectar</label>
        <div class="stack" style="gap:6px">${data.roles.map((r) => `<label class="row" style="gap:8px"><input type="checkbox" name="connect_role" value="${r.id}" ${connect.has(r.id) ? "checked" : ""}> ${esc(r.name)}</label>`).join("")}</div></div>
      <div class="field grow"><label>Pode administrar</label>
        <div class="stack" style="gap:6px">${data.roles.map((r) => `<label class="row" style="gap:8px"><input type="checkbox" name="manage_role" value="${r.id}" ${manage.has(r.id) ? "checked" : ""}> ${esc(r.name)}</label>`).join("")}</div></div>
    </div>`;
  }

  function targetForm(data, target = null) {
    const protocol = target?.protocol || "ssh";
    const vendor = target?.vendor || "outro";
    const vendors = { zte:"ZTE (OLT ZXAN/ROS)", huawei:"Huawei (VRP)", cisco:"Cisco (IOS/IOS-XE)",
      mikrotik:"MikroTik (RouterOS)", datacom:"Datacom (DMOS)", nokia:"Nokia (SR OS/TiMOS)",
      linux:"Linux (servidor)", outro:"Outro / manual" };
    return `<form class="stack" data-target-form data-target-id="${esc(target?.id || "")}">
      <div class="row" style="gap:var(--s-3);align-items:flex-start">
        <div class="field grow"><label>Nome do destino</label><input class="input" name="name" maxlength="100" placeholder="Ex.: Acesso pela matriz" value="${esc(target?.name || "")}" required></div>
        <div class="field grow"><label>IP de acesso</label><input class="input mono" name="ip" placeholder="192.168.0.1" value="${esc(target?.ip || "")}" required></div>
      </div>
      <div class="row" style="gap:var(--s-3);align-items:flex-start">
        <div class="field" style="width:130px"><label>Protocolo</label><select class="select" name="protocol">
          <option value="ssh" ${protocol === "ssh" ? "selected" : ""}>SSH</option>
          <option value="telnet" ${protocol === "telnet" ? "selected" : ""}>TELNET</option>
        </select></div>
        <div class="field" style="width:110px"><label>Porta</label><input class="input mono" name="port" type="number" min="1" max="65535" value="${target?.port || (protocol === "telnet" ? 23 : 22)}" required></div>
        <div class="field grow"><label>Fabricante</label><select class="select" name="vendor">
          ${Object.entries(vendors).map(([value,label]) => `<option value="${value}" ${vendor === value ? "selected" : ""}>${esc(label)}</option>`).join("")}
        </select>
          <span class="field-hint">O coletor usa o fabricante para criar as contas dos usuários no aparelho.</span></div>
      </div>
      <div class="row" style="gap:var(--s-3);align-items:flex-start">
        <div class="field grow"><label>URL do terminal web</label><input class="input" name="browser_url" type="url" placeholder="https://ssh-aparelho.seudominio.com" value="${esc(target?.browser_url || "")}">
          <span class="field-hint">Endereço HTTPS publicado pelo túnel para abrir o terminal no navegador.</span></div>
      </div>
      <details ${target?.provisioning || !target ? "" : "open"}>
        <summary class="btn btn-sm" style="display:inline-flex;cursor:pointer">Credencial de provisionamento</summary>
        <div class="stack" style="margin-top:var(--s-3)">
          <div class="alert alert-info" style="animation:none">${icon("info")}
            <span>Usuário e senha de administração deste aparelho. Com eles o coletor cria, via SSH, a conta de cada usuário que você definir no cadastro dele. A senha fica criptografada e só sai do servidor para o coletor autorizado.</span></div>
          <div class="row" style="gap:var(--s-3);align-items:flex-start">
            <div class="field grow"><label>Usuário administrador</label><input class="input" name="provision_username" autocomplete="off" maxlength="128" value="${esc(target?.provisioning_username || "")}" placeholder="Ex.: admin"></div>
            <div class="field grow"><label>Senha de administração</label><input class="input" name="provision_password" type="password" autocomplete="new-password" maxlength="512" placeholder="${target?.provisioning ? "Em branco mantém a senha atual" : "Senha do administrador"}" ${target?.provisioning ? "" : ""}></div>
          </div>
        </div>
      </details>
      ${targetAccessFields(data,target || {})}
      <div class="row-between"><button class="btn btn-primary" type="submit">${target ? "Salvar destino" : "Adicionar destino"}</button>
        ${target ? '<button class="btn btn-danger btn-sm" type="button" data-delete-target>Excluir destino</button>' : ""}</div>
    </form>`;
  }

  function connectionTab(e, data) {
    return `<div class="stack">
      <div class="row-between wrap" style="gap:var(--s-3)">
        <div><span class="kicker">Aparelho</span><h3 style="font-size:var(--fs-14);margin-top:4px">Destinos de acesso</h3>
          <p class="dim" style="font-size:var(--fs-11)">Cada destino possui endereço, terminal, perfis autorizados e credenciais pessoais.</p></div>
        <span class="badge badge-info">${data.targets.length} destino${data.targets.length === 1 ? "" : "s"}</span>
      </div>
      ${data.can_create ? `<details class="card" style="padding:var(--s-4)"><summary class="btn btn-primary" style="display:inline-flex;cursor:pointer">Adicionar destino</summary><div style="margin-top:var(--s-4)">${targetForm(data)}</div></details>` : ""}
      ${data.targets.length ? data.targets.map((target) => {
        const credentials = target.credentials;
        const ready = Boolean(credentials?.username && credentials?.has_password);
        const profiles = target.access_profiles?.map((p) => `<span class="badge ${p.manage ? "badge-info" : ""}">${esc(p.name)}${p.manage ? " • administra" : ""}</span>`).join(" ") || '<span class="badge badge-warn">Somente administradores globais</span>';
        return `<section class="card stack" style="padding:var(--s-4)" data-target-card="${esc(target.id)}">
          <div class="row-between wrap" style="gap:var(--s-3)">
            <div><h3 style="font-size:var(--fs-14)">${esc(target.name)}</h3><div class="row wrap" style="margin-top:6px">${profiles}</div></div>
            <div class="row wrap"><span class="badge badge-info">${esc(target.protocol.toUpperCase())} • ${esc(target.ip)}:${target.port}</span>
              <span class="badge">${esc(target.vendor_label || "Outro")}</span>
              <span class="badge ${target.provisioning ? "badge-ok" : "badge-warn"}">${target.provisioning ? "Provisionamento ativo" : "Sem provisionamento"}</span>
              <span class="badge ${target.browser_url ? "badge-ok" : "badge-warn"}">${target.browser_url ? "Terminal web pronto" : "Sem terminal web"}</span></div>
          </div>
          <form class="stack" data-credential-form data-target-id="${esc(target.id)}">
            <div class="row" style="gap:var(--s-3);align-items:flex-start">
              <div class="field grow"><label>Meu usuário neste destino</label><input class="input" name="username" autocomplete="username" maxlength="128" value="${esc(credentials?.username || "")}" required></div>
              <div class="field grow"><label>Minha senha</label><input class="input" name="password" type="password" autocomplete="new-password" maxlength="512" placeholder="${credentials?.has_password ? "Em branco mantém a senha atual" : "Digite sua senha"}" ${credentials?.has_password ? "" : "required"}></div>
            </div>
            <div class="row-between wrap" style="gap:var(--s-3)"><span class="row wrap">
              <button class="btn btn-primary" type="submit">Salvar minhas credenciais</button>
              <button class="btn" type="button" data-copy-password ${credentials?.has_password ? "" : "disabled"}>${icon("lock")} Copiar senha</button>
              <button class="btn" type="button" data-connect ${ready ? "" : "disabled"}>Conectar via ${esc(target.protocol.toUpperCase())}</button>
            </span><button class="btn btn-danger btn-sm" type="button" data-remove-credentials ${credentials ? "" : "disabled"}>Remover credenciais</button></div>
          </form>
          ${target.can_manage ? `<details><summary class="btn btn-sm" style="display:inline-flex;cursor:pointer">Editar destino e permissões</summary><div style="margin-top:var(--s-4)">${targetForm(data,target)}</div></details>` : ""}
        </section>`;
      }).join("") : '<div class="empty"><b>Nenhum destino disponível</b><span>Peça a um administrador para cadastrar um destino e liberar seu perfil.</span></div>'}
    </div>`;
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
    $$('[data-target-form]',root).forEach((form) => {
      const protocol = $('[name="protocol"]',form), port = $('[name="port"]',form);
      protocol.onchange = () => {
        const oldDefault = protocol.value === "ssh" ? "23" : "22";
        if (!port.value || port.value === oldDefault) port.value = protocol.value === "ssh" ? "22" : "23";
      };
      form.onsubmit = async (ev) => {
        ev.preventDefault(); const submit=$('[type="submit"]',form); submit.disabled=true;
        const payload={
          name:form.elements.name.value.trim(),ip:form.elements.ip.value.trim(),protocol:protocol.value,
          port:Number(port.value),browser_url:form.elements.browser_url.value.trim(),
          vendor:form.elements.vendor.value,
          provision_username:form.elements.provision_username.value.trim(),
          connect_role_ids:new FormData(form).getAll("connect_role").map(Number),
          manage_role_ids:new FormData(form).getAll("manage_role").map(Number)
        };
        const provisionPassword=form.elements.provision_password.value;
        if(provisionPassword)payload.provision_password=provisionPassword;
        try {
          if(form.dataset.targetId) await NOC.deviceConnection.save(e.id,form.dataset.targetId,payload);
          else await NOC.deviceConnection.create(e.id,payload);
          toast("Destino salvo",{type:"ok"}); await loadConnectionTab(e,root);
        } catch(err){toast("Não foi possível salvar",{text:err.message,type:"danger"});submit.disabled=false;}
      };
      const del=$('[data-delete-target]',form);
      if(del) del.onclick=()=>askConfirm({title:"Excluir este destino?",text:"As credenciais pessoais vinculadas a este destino também serão removidas.",confirmLabel:"Excluir destino",danger:true,onConfirm:async()=>{
        await NOC.deviceConnection.remove(e.id,form.dataset.targetId);toast("Destino excluído",{type:"ok"});await loadConnectionTab(e,root);
      }});
    });

    $$('[data-credential-form]',root).forEach((form) => {
      const target=data.targets.find(t=>t.id===form.dataset.targetId); if(!target)return;
      form.onsubmit=async(ev)=>{ev.preventDefault();const submit=$('[type="submit"]',form);submit.disabled=true;
        const credentials={username:form.elements.username.value.trim()};
        if(form.elements.password.value)credentials.password=form.elements.password.value;
        try{await NOC.deviceConnection.saveCredentials(e.id,target.id,credentials);toast("Credenciais salvas",{type:"ok"});await loadConnectionTab(e,root);}
        catch(err){toast("Não foi possível salvar",{text:err.message,type:"danger"});submit.disabled=false;}
      };
      $('[data-copy-password]',form).onclick=async(ev)=>{const button=ev.currentTarget;button.disabled=true;try{
        const result=await NOC.deviceConnection.revealPassword(e.id,target.id);await navigator.clipboard.writeText(result.password);toast("Senha copiada",{type:"ok"});
      }catch(err){toast("Não foi possível copiar",{text:err.message,type:"danger"});}finally{button.disabled=false;}};
      $('[data-connect]',form).onclick=async()=>{
        if(target.browser_url){window.open(target.browser_url,"_blank","noopener");return;}
        const username=target.credentials?.username;const host=target.ip.includes(":")?`[${target.ip}]`:target.ip;
        const command=target.protocol==="ssh"?`ssh -p ${target.port} ${username}@${host}`:`telnet ${host} ${target.port}`;
        try{await navigator.clipboard.writeText(command);}catch{}
        toast("Terminal web não configurado",{text:`O comando foi copiado: ${command}`,type:"warn"});
      };
      $('[data-remove-credentials]',form).onclick=()=>askConfirm({title:"Remover suas credenciais?",text:`Seu usuário e sua senha de ${target.name} serão apagados.`,confirmLabel:"Remover credenciais",danger:true,onConfirm:async()=>{
        await NOC.deviceConnection.removeCredentials(e.id,target.id);toast("Credenciais removidas",{type:"ok"});await loadConnectionTab(e,root);
      }});
    });
  }

  /* As categorias já cadastradas viram sugestão do campo: ele continua livre,
     mas quem edita não inventa um sinônimo para uma que já existe. */
  const categoriasCadastradas = () => [...new Set((NOC.data()?.equipamentos || [])
    .map((x) => String(x.categoria || "").trim()).filter(Boolean))]
    .sort((a, b) => a.localeCompare(b, "pt-BR"));

  /* Enlaces documentados numa porta deste equipamento. A gestão de portas usa
     a lista inteira (e não só o primeiro enlace) para renumerar junto e para
     nunca apagar uma ligação sem avisar. */
  const enlacesDaPorta = (deviceId, numero) => (NOC.data()?.conexoes || [])
    .filter((c) => (c.origem === deviceId && Number(c.portaOrigem) === Number(numero))
      || (c.destino === deviceId && Number(c.portaDestino) === Number(numero)));

  /* Campos de texto vazios saem do documento: um "" gravado vira ruído no diff
     da auditoria e nas telas que testam `campo || "—"`. */
  function limparVazios(obj, chaves) {
    for (const k of chaves) {
      const v = String(obj[k] ?? "").trim();
      if (v) obj[k] = v; else delete obj[k];
    }
    return obj;
  }

  function sheetTab(e) {
    const canEdit = podeEditarEquipamento();
    const canPop = podeVincularPop();
    const pop = NOC.popById(e.popId || "");
    const coords = pop ? NOC.popCoords(pop) : null;
    const emUso = NOC.usedPorts(e);
    return `
      <form id="sheetForm" class="stack">
        <div class="row-between">
          <h3 style="font-size:var(--fs-13)">Dados cadastrais</h3>
          <button class="btn btn-sm" type="button" data-editmode
            ${canEdit ? "" : "disabled title='Requer as ações topology.edit + topology.equipment.edit'"}>${icon("edit")} Editar tudo</button>
        </div>

        <div class="row" style="gap:var(--s-3);align-items:flex-start">
          <div class="field grow"><label for="fNome">Nome *</label>
            <input class="input" id="fNome" data-f="nome" data-edt value="${esc(e.nome || "")}" disabled></div>
          <div class="field" style="width:190px"><label for="fId">Identificador</label>
            <input class="input mono" id="fId" value="${esc(e.id)}" readonly disabled>
            <span class="field-hint">Chave usada pelos enlaces e pelo Zabbix.</span></div>
        </div>

        <div class="row" style="gap:var(--s-3);align-items:flex-start">
          <div class="field grow"><label for="fFabricante">Fabricante</label>
            <input class="input" id="fFabricante" data-f="fabricante" data-edt
              value="${esc(e.fabricante || "")}" placeholder="Ex.: Huawei" disabled></div>
          <div class="field grow"><label for="fModelo">Modelo</label>
            <input class="input" id="fModelo" data-f="modelo" data-edt
              value="${esc(e.modelo || "")}" placeholder="Ex.: NetEngine 8000 F1A" disabled></div>
        </div>

        <div class="row" style="gap:var(--s-3);align-items:flex-start">
          <div class="field grow"><label for="fCat">Categoria</label>
            <input class="input" id="fCat" data-f="categoria" data-edt list="fCatSugestoes"
              value="${esc(e.categoria || "")}" placeholder="Ex.: Agregação" disabled>
            <datalist id="fCatSugestoes">${categoriasCadastradas().map((c) => `<option value="${esc(c)}"></option>`).join("")}</datalist>
            <span class="field-hint">Define o agrupamento e o filtro de categorias do mapa.</span></div>
          <div class="field grow"><label for="fSerial">Número de série / patrimônio</label>
            <input class="input mono" id="fSerial" data-f="serial" data-edt
              value="${esc(e.serial || "")}" placeholder="Ex.: 2102351BTL10J3000123" disabled></div>
        </div>

        <hr>
        <h3 style="font-size:var(--fs-13)">${icon("pops")} Localização e vínculos</h3>
        <div class="row" style="gap:var(--s-3);align-items:flex-start">
          <div class="field grow"><label for="fPop">POP vinculado</label>
            <select class="select" id="fPop" data-f="popId" ${canPop ? "data-edt" : ""} disabled>
              <option value="">— Sem POP vinculado —</option>
              ${NOC.pops().map((p) => `<option value="${esc(p.id)}" ${e.popId === p.id ? "selected" : ""}>${esc(p.nome)}</option>`).join("")}
            </select>
            <span class="field-hint">${canPop
              ? "Um equipamento pertence a um único POP. O Dashboard agrupa por este campo."
              : "Alterar o vínculo exige as ações topology.edit + topology.pop.link."}</span>
          </div>
          <div class="field grow"><label for="fLocal">Local dentro do POP</label>
            <input class="input" id="fLocal" data-f="local" data-edt
              value="${esc(e.local || "")}" placeholder="Ex.: Sala 2, rack A3, U12" disabled>
            <span class="field-hint">Texto livre. Sem POP gravado, é ele que sugere o vínculo.</span></div>
        </div>

        <div class="card row-between wrap" style="padding:var(--s-4);gap:var(--s-3)">
          <div><span class="kicker">Endereço no mapa</span>
            <div style="margin-top:6px;font-size:var(--fs-13)">${pop
              ? `<b>${esc(pop.nome)}</b>${pop.endereco ? `<br><small class="dim">${esc(pop.endereco)}</small>` : ""}
                 ${coords
                   ? `<br><small class="dim mono">${esc(GEO.label(coords.lat, coords.lon))}</small>`
                   : '<br><span class="badge badge-warn">POP sem latitude e longitude</span>'}`
              : '<span class="dim">Sem POP vinculado — o equipamento não aparece no mapa geográfico.</span>'}</div>
          </div>
          ${pop ? `<button class="btn btn-sm" type="button" data-editpop
            ${podeEditarPop() ? "" : "disabled title='Requer as ações topology.edit + pops.edit'"}>${icon("edit")} Editar localização do POP</button>` : ""}
        </div>

        <div class="field"><label for="fObs">Observação operacional</label>
          <textarea class="textarea" id="fObs" data-f="observacao" data-edt disabled>${esc(e.observacao || "")}</textarea></div>

        <div class="row-between" id="sheetActions" hidden>
          <span class="dim" style="font-size:var(--fs-11)">A alteração vai para a auditoria com estado anterior e posterior.</span>
          <span class="row">
            <button class="btn" type="button" data-cancel>Cancelar</button>
            <button class="btn btn-primary" type="submit">Salvar alterações</button>
          </span>
        </div>

        <hr>
        <div class="row-between wrap" style="gap:var(--s-3)">
          <div><b style="font-size:var(--fs-13)">Portas e enlaces</b>
            <p class="dim" style="font-size:var(--fs-11)">${e.portas.length} portas cadastradas • ${emUso} em uso •
              ${NOC.connectionsOf(e.id).length} enlaces documentados.</p></div>
          <button class="btn btn-sm" type="button" data-ports
            ${podeEditarPorta() ? "" : "disabled title='Requer as ações topology.edit + topology.port.edit'"}>${icon("port")} Gerenciar portas</button>
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
    /* Só os campos marcados entram no modo de edição: o identificador é leitura
       e o POP depende de uma ação própria. */
    const campos = () => $$("[data-edt]", form);
    const sair = () => {
      campos().forEach((i) => (i.disabled = true));
      $("#sheetActions", form).hidden = true;
      $("[data-editmode]", form).hidden = false;
    };

    $("[data-editmode]", form).onclick = (ev) => {
      ev.preventDefault();
      campos().forEach((i) => (i.disabled = false));
      $("#sheetActions", form).hidden = false;
      $("[data-editmode]", form).hidden = true;
      $("#fNome", form).focus();
    };
    /* Cancelar repinta a ficha a partir do que está gravado: sair do modo de
       edição mantendo o texto digitado dava a impressão de ter salvo. */
    $("[data-cancel]", form).onclick = () => (repaintDevice ? repaintDevice() : sair());

    const editarPop = $("[data-editpop]", form);
    if (editarPop) editarPop.onclick = () => openPopForm(e.popId, () => repaintDevice && repaintDevice());

    const portas = $("[data-ports]", form);
    if (portas) portas.onclick = () => openPortsManager(e);

    form.onsubmit = async (ev) => {
      ev.preventDefault();
      const nome = $("#fNome", form).value.trim();
      if (!nome) {
        toast("Informe o nome do equipamento", { text: "O nome é o rótulo do card no mapa e não pode ficar vazio.", type: "warn" });
        $("#fNome", form).focus();
        return;
      }

      const antes = { ...e };
      const restaurar = () => {
        for (const k of Object.keys(e)) if (!Object.hasOwn(antes, k)) delete e[k];
        Object.assign(e, antes);
      };

      const texto = campos().filter((i) => i.dataset.f && i.dataset.f !== "popId");
      texto.forEach((i) => { e[i.dataset.f] = i.value.trim(); });
      e.nome = nome;
      limparVazios(e, texto.map((i) => i.dataset.f).filter((k) => k !== "nome"));
      if (podeVincularPop()) e.popId = $("#fPop", form).value || null;
      if (e.popId) state.expanded.add(e.popId);

      sair();
      const ok = await persist("TOPOLOGY_UPDATE",
        { titulo: "Equipamento atualizado", texto: "Alteração registrada na auditoria." },
        async () => {
          restaurar();
          await persist("TOPOLOGY_UPDATE", { titulo: "Alteração desfeita", tipo: "info" });
          if (repaintDevice) repaintDevice();
        });
      if (!ok) { restaurar(); layout(); renderAll(); }
      if (repaintDevice) repaintDevice();
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

/* ---------- OLT: Gerenciamento modular de portas (BACKBONE) ---------- */
  function openOltPortsManager(equipamento) {
    if (!podeEditarPorta()) return;
    let portas = [...equipamento.portas].sort((a, b) => Number(a.numero) - Number(b.numero));
    let nextPortNumber = portas.length > 0 ? Math.max(...portas.map(p => p.numero)) + 1 : 1;

    // Agrupar por slot/placa
    function rebuildPorSlot() {
      const porSlot = {};
      for (const porta of portas) {
        const slot = porta.slot || 1;
        if (!porSlot[slot]) porSlot[slot] = { portas: [], tipoPlaca: porta.tipoPlaca || "Desconhecido", tecnologia: porta.tecnologia || "" };
        porSlot[slot].portas.push(porta);
      }
      // Ordenar portas dentro do slot por subslot
      Object.values(porSlot).forEach(s => s.portas.sort((a, b) => Number(a.subslot) - Number(b.subslot)));
      return porSlot;
    }

    let porSlot = rebuildPorSlot();
    let slotsOrdenados = Object.keys(porSlot).map(Number).sort((a, b) => a - b);

    // Configuração padrão de tipos de slot
    const SLOT_TYPES = {
      linha: { tipoPlaca: "Linha", tecnologia: "GBIC/GPON", tipo: "SFP", capacidade: "1.25 / 2.5 Gbps" },
      gerencia: { tipoPlaca: "Gerência", tecnologia: "Óptica", tipo: "SFP", capacidade: "1 Gbps" },
      gerencia_rj45: { tipoPlaca: "Gerência", tecnologia: "Elétrica", tipo: "RJ45", capacidade: "1 Gbps" },
      uplink_10g: { tipoPlaca: "Uplink", tecnologia: "10G", tipo: "SFP+", capacidade: "10 Gbps" },
      uplink_2_5g: { tipoPlaca: "Uplink", tecnologia: "2.5G", tipo: "SFP", capacidade: "2.5 Gbps" },
    };

    function getNextSubslot(slot) {
      const slotData = porSlot[slot];
      if (!slotData || !slotData.portas.length) return 1;
      return Math.max(...slotData.portas.map(p => p.subslot)) + 1;
    }

    function addPortToSlot(slot, slotType = "linha") {
      const config = SLOT_TYPES[slotType] || SLOT_TYPES.linha;
      const subslot = getNextSubslot(slot);
      const novaPorta = {
        numero: nextPortNumber++,
        slot,
        subslot,
        tipoPlaca: config.tipoPlaca,
        tecnologia: config.tecnologia,
        capacidade: config.capacidade,
        tipo: config.tipo,
        status: "livre",
      };
      portas.push(novaPorta);
      porSlot = rebuildPorSlot();
      slotsOrdenados = Object.keys(porSlot).map(Number).sort((a, b) => a - b);
      return novaPorta;
    }

    function removePortFromSlot(slot, subslot) {
      const idx = portas.findIndex(p => p.slot === slot && p.subslot === subslot);
      if (idx === -1) return false;
      const porta = portas[idx];
      if (NOC.portaEmUso(equipamento.id, porta.numero)) {
        toast("Porta em uso", { text: "Não é possível remover uma porta com enlace documentado.", type: "warn" });
        return false;
      }
      portas.splice(idx, 1);
      porSlot = rebuildPorSlot();
      slotsOrdenados = Object.keys(porSlot).map(Number).sort((a, b) => a - b);
      return true;
    }

    function addSlot(slotType = "linha") {
      const newSlot = slotsOrdenados.length > 0 ? Math.max(...slotsOrdenados) + 1 : 1;
      // Adicionar primeira porta para criar o slot
      addPortToSlot(newSlot, slotType);
      return newSlot;
    }

    function removeSlot(slot, force = false) {
      const slotData = porSlot[slot];
      if (!slotData) return false;
      const emUso = slotData.portas.some(p => NOC.portaEmUso(equipamento.id, p.numero));
      if (emUso && !force) {
        toast("Slot em uso", { text: "Este slot tem portas com enlaces documentados. Use 'Forçar remoção' para apagar mesmo assim.", type: "warn" });
        return false;
      }
      // Se forçar, remover os enlaces das portas deste slot
      if (force && emUso) {
        const t = NOC.data();
        t.conexoes = (t.conexoes || []).filter(c => {
          const port = c.origem === equipamento.id ? c.portaOrigem : c.portaDestino;
          return !(c.origem === equipamento.id || c.destino === equipamento.id) || 
                 !slotData.portas.some(p => p.numero === port);
        });
      }
      portas = portas.filter(p => p.slot !== slot);
      porSlot = rebuildPorSlot();
      slotsOrdenados = Object.keys(porSlot).map(Number).sort((a, b) => a - b);
      return true;
    }

    function renderPortasOLT() {
      const container = $("#oltPortasContainer");
      if (!container) return;

      container.innerHTML = slotsOrdenados.map(slot => {
        const slotData = porSlot[slot];
        const portaHtml = slotData.portas.map(p => {
          const emUso = NOC.portaEmUso(equipamento.id, p.numero);
          const statusClass = emUso ? "status-em-uso" : (p.status === "livre" ? "status-livre" : "status-" + (p.status || "livre"));
          return `
            <div class="olt-porta ${statusClass}" data-numero="${p.numero}" data-slot="${slot}" data-subslot="${p.subslot}">
              <span class="porta-numero">P${p.subslot}</span>
              <span class="porta-tipo">${p.tipo}</span>
              <span class="porta-capacidade">${p.capacidade}</span>
              <span class="porta-status">${emUso ? "Em uso" : (p.status || "livre")}</span>
              ${!emUso ? `<button class="btn btn-ghost btn-icon btn-xs porta-remove" data-slot="${slot}" data-subslot="${p.subslot}" title="Remover porta" aria-label="Remover porta">${icon("trash")}</button>` : ""}
              <input type="hidden" name="porta_${p.numero}_capacidade" value="${esc(p.capacidade)}">
              <input type="hidden" name="porta_${p.numero}_tipo" value="${esc(p.tipo)}">
              <input type="hidden" name="porta_${p.numero}_status" value="${esc(p.status || "livre")}">
            </div>
          `;
        }).join("");

        return `
          <div class="olt-slot" data-slot="${slot}">
            <div class="olt-slot-header" data-slot="${slot}">
              <span class="slot-numero">Slot ${slot}</span>
              <span class="slot-tipo">${esc(slotData.tipoPlaca)}</span>
              <span class="slot-tecnologia">${esc(slotData.tecnologia)}</span>
              <span class="slot-qtd">${slotData.portas.length} portas</span>
              <div class="slot-actions">
                <button class="btn btn-ghost btn-sm btn-icon" data-add-port="${slot}" title="Adicionar porta" aria-label="Adicionar porta">${icon("plus")}</button>
                <button class="btn btn-ghost btn-sm btn-icon" data-edit-slot="${slot}" title="Editar slot" aria-label="Editar slot">${icon("edit")}</button>
                <button class="btn btn-ghost btn-sm btn-icon" data-remove-slot="${slot}" title="Remover slot" aria-label="Remover slot" ${slotData.portas.length === 0 ? "disabled" : ""}>${icon("trash")}</button>
              </div>
            </div>
            <div class="olt-slot-portas">${portaHtml}</div>
          </div>
        `;
      }).join("");

      // Bind click events
      $$(".olt-porta", container).forEach(el => {
        el.onclick = (ev) => {
          if (ev.target.closest(".porta-remove")) return;
          if (ev.target.tagName === "INPUT") return;
          editarPortaOLT(equipamento, Number(el.dataset.numero), el);
        };
      });

      $$(".porta-remove", container).forEach(btn => {
        btn.onclick = (ev) => {
          ev.stopPropagation();
          const slot = Number(btn.dataset.slot);
          const subslot = Number(btn.dataset.subslot);
          if (removePortFromSlot(slot, subslot)) {
            renderPortasOLT();
            updateToolbar();
          }
        };
      });

      $$("[data-add-port]", container).forEach(btn => {
        btn.onclick = () => {
          const slot = Number(btn.dataset.addPort);
          // Determinar tipo de slot baseado no número
          let slotType = "linha";
          if (slot >= 18 && slot <= 19) slotType = "gerencia";
          if (slot === 20) slotType = "uplink_10g";
          addPortToSlot(slot, slotType);
          renderPortasOLT();
          updateToolbar();
        };
      });

      $$("[data-remove-slot]", container).forEach(btn => {
        btn.onclick = () => {
          const slot = Number(btn.dataset.removeSlot);
          askConfirm({
            title: `Remover Slot ${slot}?`,
            text: `Todas as ${porSlot[slot]?.portas.length || 0} portas deste slot serão removidas.`,
            confirmLabel: "Remover slot",
            danger: true,
            onConfirm: () => {
              if (removeSlot(slot)) {
                renderPortasOLT();
                updateToolbar();
              }
            },
          });
        };
      });

      $$("[data-edit-slot]", container).forEach(btn => {
        btn.onclick = (ev) => {
          ev.stopPropagation();
          const slot = Number(btn.dataset.editSlot);
          editarSlotOLT(equipamento, slot);
        };
      });
    }

    function updateToolbar() {
      const filtroSlot = $("#oltFiltroSlot", host);
      if (filtroSlot) {
        filtroSlot.innerHTML = `<option value="">Todos os slots</option>` +
          slotsOrdenados.map(s => `<option value="${s}">Slot ${s} — ${esc(porSlot[s].tipoPlaca)}</option>`).join("");
      }
      const totalPortas = portas.length;
      const totalSlots = slotsOrdenados.length;
      const infoEl = host.querySelector(".olt-info-count");
      if (infoEl) infoEl.textContent = `${totalPortas} portas em ${totalSlots} slots`;
    }

    modal({
      labelledBy: "oltPortasTitulo",
      wide: true,
      html: `
        <div class="modal-head">
          <div><span class="kicker">${icon("port")} OLT Modular</span>
            <h2 id="oltPortasTitulo" style="margin-top:6px">${esc(equipamento.nome)} — Gerenciamento de Portas</h2>
            <p class="muted mono" style="font-size:var(--fs-12);margin-top:4px">${esc(equipamento.id)} • <span class="olt-info-count">${portas.length} portas em ${slotsOrdenados.length} slots</span></p></div>
          <button class="btn btn-ghost btn-icon" data-close type="button" aria-label="Fechar">${icon("close")}</button>
        </div>
        <div class="modal-body" style="max-height:60vh;overflow:auto">
          <div class="olt-portas-toolbar">
            <div class="row wrap" style="gap:var(--s-2);flex:1">
              <div class="input-affix" style="min-width:200px">
                <span class="affix-icon">${icon("search")}</span>
                <input class="input" id="oltPortaBusca" type="search" placeholder="Buscar porta, slot, tipo…" aria-label="Buscar porta">
              </div>
              <select class="select" id="oltFiltroSlot" style="width:160px">
                <option value="">Todos os slots</option>
                ${slotsOrdenados.map(s => `<option value="${s}">Slot ${s} — ${esc(porSlot[s].tipoPlaca)}</option>`).join("")}
              </select>
              <select class="select" id="oltFiltroStatus" style="width:140px">
                <option value="">Todos os status</option>
                <option value="livre">Livre</option>
                <option value="em_uso">Em uso</option>
              </select>
            </div>
            <div class="row wrap" style="gap:var(--s-2);margin-top:var(--s-2)">
              <button class="btn btn-sm" type="button" id="oltAddSlotLinha">${icon("plus")} Slot Linha (GBIC/GPON)</button>
              <button class="btn btn-sm" type="button" id="oltAddSlotGerencia">${icon("plus")} Slot Gerência (Óptica)</button>
              <button class="btn btn-sm" type="button" id="oltAddSlotGerenciaRj45">${icon("plus")} Slot Gerência (RJ45)</button>
              <button class="btn btn-sm" type="button" id="oltAddSlotUplink10g">${icon("plus")} Slot Uplink (10G)</button>
              <button class="btn btn-sm" type="button" id="oltAddSlotUplink2_5g">${icon("plus")} Slot Uplink (2.5G)</button>
            </div>
            <div class="olt-portas-legenda">
              <span class="legenda-item"><i class="dot dot-ok"></i>Livre</span>
              <span class="legenda-item"><i class="dot" style="background:var(--yellow-400)"></i>Em uso</span>
            </div>
          </div>
          <div class="olt-portas-grid" id="oltPortasContainer"></div>
        </div>
        <div class="modal-foot">
          <span class="dim" style="font-size:var(--fs-11)">Clique em uma porta para editar. Use os botões acima para adicionar slots/portas. Portas em uso não podem ser removidas.</span>
          <span class="row">
            <button class="btn btn-primary" type="button" id="oltSalvarPortas">${icon("check")} Salvar alterações</button>
            <button class="btn" data-close type="button">Fechar</button>
          </span>
        </div>`,
      onMount: (host, close) => {
        renderPortasOLT();

        // Filtros
        const busca = $("#oltPortaBusca", host);
        const filtroSlot = $("#oltFiltroSlot", host);
        const filtroStatus = $("#oltFiltroStatus", host);

        function aplicarFiltros() {
          const termo = busca.value.toLowerCase().trim();
          const slotSel = filtroSlot.value;
          const statusSel = filtroStatus.value;

          $$(".olt-porta", host).forEach(el => {
            const porta = portas.find(p => p.numero === Number(el.dataset.numero));
            if (!porta) return;

            let mostrar = true;
            if (termo) {
              const texto = `${porta.slot} ${porta.subslot} ${porta.tipo} ${porta.capacidade} ${porta.tipoPlaca} ${porta.tecnologia}`.toLowerCase();
              mostrar = texto.includes(termo);
            }
            if (mostrar && slotSel) mostrar = String(porta.slot) === slotSel;
            if (mostrar && statusSel) {
              const emUso = NOC.portaEmUso(equipamento.id, porta.numero);
              if (statusSel === "livre") mostrar = !emUso;
              if (statusSel === "em_uso") mostrar = emUso;
            }
            el.style.display = mostrar ? "" : "none";
          });

          $$(".olt-slot", host).forEach(slotEl => {
            const visiveis = $$(".olt-porta", slotEl).filter(el => el.style.display !== "none").length;
            slotEl.style.display = visiveis > 0 ? "" : "none";
          });
        }

        busca.addEventListener("input", aplicarFiltros);
        filtroSlot.addEventListener("change", aplicarFiltros);
        filtroStatus.addEventListener("change", aplicarFiltros);

        // Botões de adicionar slots
        $("#oltAddSlotLinha", host).onclick = () => { addSlot("linha"); renderPortasOLT(); updateToolbar(); };
        $("#oltAddSlotGerencia", host).onclick = () => { addSlot("gerencia"); renderPortasOLT(); updateToolbar(); };
        $("#oltAddSlotGerenciaRj45", host).onclick = () => { addSlot("gerencia_rj45"); renderPortasOLT(); updateToolbar(); };
        $("#oltAddSlotUplink10g", host).onclick = () => { addSlot("uplink_10g"); renderPortasOLT(); updateToolbar(); };
        $("#oltAddSlotUplink2_5g", host).onclick = () => { addSlot("uplink_2_5g"); renderPortasOLT(); updateToolbar(); };

        // Salvar
        $("#oltSalvarPortas", host).onclick = async () => {
          const novasPortas = portas.map(p => {
            const capInput = $(`input[name="porta_${p.numero}_capacidade"]`, host);
            const tipoInput = $(`input[name="porta_${p.numero}_tipo"]`, host);
            const statusInput = $(`input[name="porta_${p.numero}_status"]`, host);
            return {
              ...p,
              capacidade: capInput?.value || p.capacidade,
              tipo: tipoInput?.value || p.tipo,
              status: statusInput?.value || p.status,
            };
          });

          const t = NOC.data();
          const backupPortas = (equipamento.portas || []).map(p => ({ ...p }));
          equipamento.portas = novasPortas;

          const ok = await persist("TOPOLOGY_UPDATE_PORTA", {
            titulo: `Portas OLT atualizadas: ${equipamento.nome}`,
            texto: `${novasPortas.length} portas organizadas em ${slotsOrdenados.length} slots.`,
          }, async () => {
            equipamento.portas = backupPortas;
            await persist("TOPOLOGY_UPDATE_PORTA", { titulo: "Alterações revertidas", tipo: "info" });
            if (repaintDevice) repaintDevice();
          });

          if (ok) {
            if (repaintDevice) repaintDevice();
            close();
          }
        };
      },
    });
  }

  function editarPortaOLT(equipamento, numeroPorta, elemento) {
    const porta = equipamento.portas.find(p => p.numero === numeroPorta);
    if (!porta) return;

    const emUso = NOC.portaEmUso(equipamento.id, numeroPorta);

    const hiddenCap = elemento.querySelector(`input[name="porta_${numeroPorta}_capacidade"]`);
    const hiddenTipo = elemento.querySelector(`input[name="porta_${numeroPorta}_tipo"]`);
    const hiddenStatus = elemento.querySelector(`input[name="porta_${numeroPorta}_status"]`);

    modal({
      labelledBy: "oltPortaEditarTitulo",
      html: `
        <div class="modal-head">
          <div><span class="kicker">${icon("port")} Porta OLT</span>
            <h2 id="oltPortaEditarTitulo" style="margin-top:6px">${esc(equipamento.nome)} — Slot ${porta.slot} / Porta ${porta.subslot} (Nº ${porta.numero})</h2>
            ${emUso ? '<span class="badge badge-warn" style="margin-top:6px">Porta em uso — capacidade e tipo bloqueados</span>' : ""}</div>
          <button class="btn btn-ghost btn-icon" data-close type="button" aria-label="Fechar">${icon("close")}</button>
        </div>
        <div class="modal-body">
          <form class="stack" id="formOltPorta">
            <div class="row" style="gap:var(--s-3)">
              <div class="field grow"><label>Tipo da placa</label>
                <input class="input" value="${esc(porta.tipoPlaca)}" readonly></div>
              <div class="field grow"><label>Tecnologia</label>
                <input class="input" value="${esc(porta.tecnologia)}" readonly></div>
            </div>
            <div class="row" style="gap:var(--s-3)">
              <div class="field grow"><label for="oltPortaCapacidade">Capacidade</label>
                <input class="input" id="oltPortaCapacidade" value="${esc(porta.capacidade)}" ${emUso ? "readonly" : ""}></div>
              <div class="field grow"><label for="oltPortaTipo">Tipo de conector</label>
                <select class="select" id="oltPortaTipo" ${emUso ? "disabled" : ""}>
                  <option value="SFP" ${porta.tipo === "SFP" ? "selected" : ""}>SFP</option>
                  <option value="SFP+" ${porta.tipo === "SFP+" ? "selected" : ""}>SFP+</option>
                  <option value="QSFP28" ${porta.tipo === "QSFP28" ? "selected" : ""}>QSFP28</option>
                  <option value="RJ45" ${porta.tipo === "RJ45" ? "selected" : ""}>RJ45</option>
                  <option value="XFP" ${porta.tipo === "XFP" ? "selected" : ""}>XFP</option>
                </select></div>
            </div>
            <div class="field"><label for="oltPortaStatus">Status administrativo</label>
              <select class="select" id="oltPortaStatus">
                <option value="livre" ${porta.status === "livre" ? "selected" : ""}>Livre</option>
                <option value="reservada" ${porta.status === "reservada" ? "selected" : ""}>Reservada</option>
                <option value="manutencao" ${porta.status === "manutencao" ? "selected" : ""}>Em manutenção</option>
                <option value="bloqueada" ${porta.status === "bloqueada" ? "selected" : ""}>Bloqueada</option>
              </select></div>
            ${emUso ? '<div class="alert alert-info" style="margin-top:var(--s-2)"><small>Esta porta possui enlace documentado. Capacidade e tipo não podem ser alterados para preservar a integridade da topologia.</small></div>' : ""}
          </form>
        </div>
        <div class="modal-foot">
          <span class="row">
            <button class="btn" data-close type="button">Cancelar</button>
            <button class="btn btn-primary" type="button" id="oltPortaSalvar" ${emUso ? "" : ""}>Salvar</button>
          </span>
        </div>`,
      onMount: (host, close) => {
        $("#oltPortaSalvar", host).onclick = () => {
          const capInput = $("#oltPortaCapacidade", host);
          const tipoInput = $("#oltPortaTipo", host);
          const statusInput = $("#oltPortaStatus", host);

          if (hiddenCap) hiddenCap.value = capInput.value;
          if (hiddenTipo) hiddenTipo.value = tipoInput.value;
          if (hiddenStatus) hiddenStatus.value = statusInput.value;

          const capEl = elemento.querySelector(".porta-capacidade");
          const tipoEl = elemento.querySelector(".porta-tipo");
          const statusEl = elemento.querySelector(".porta-status");
          if (capEl) capEl.textContent = capInput.value;
          if (tipoEl) tipoEl.textContent = tipoInput.value;
          if (statusEl) statusEl.textContent = statusInput.value === "livre" ? "Livre" : statusInput.value;

          close();
        };
      },
    });
  }

  /* ---------- OLT: Edição de slot ---------- */
  function editarSlotOLT(equipamento, slot) {
    const slotData = porSlot[slot];
    if (!slotData) return;

    modal({
      labelledBy: "oltSlotEditarTitulo",
      html: `
        <div class="modal-head">
          <div><span class="kicker">${icon("port")} Slot OLT</span>
            <h2 id="oltSlotEditarTitulo" style="margin-top:6px">${esc(equipamento.nome)} — Slot ${slot}</h2>
            <p class="muted mono" style="font-size:var(--fs-12);margin-top:4px">${slotData.portas.length} portas</p></div>
          <button class="btn btn-ghost btn-icon" data-close type="button" aria-label="Fechar">${icon("close")}</button>
        </div>
        <div class="modal-body">
          <form class="stack" id="formOltSlot">
            <div class="row" style="gap:var(--s-3)">
              <div class="field grow"><label for="oltSlotNome">Nome do Slot</label>
                <input class="input" id="oltSlotNome" value="${esc(slotData.tipoPlaca || "")}" placeholder="Ex.: Linha, Gerência, Uplink"></div>
              <div class="field grow"><label for="oltSlotTecnologia">Tecnologia</label>
                <input class="input" id="oltSlotTecnologia" value="${esc(slotData.tecnologia || "")}" placeholder="Ex.: GBIC/GPON, Óptica, 10G"></div>
            </div>
            <div class="field"><label for="oltSlotObs">Observação</label>
              <textarea class="textarea" id="oltSlotObs" rows="3" placeholder="Observações sobre este slot...">${esc(slotData.observacao || "")}</textarea></div>
          </form>
        </div>
        <div class="modal-foot">
          <span class="row">
            <button class="btn" data-close type="button">Cancelar</button>
            <button class="btn btn-primary" type="button" id="oltSlotSalvar">Salvar</button>
          </span>
        </div>`,
      onMount: (host, close) => {
        $("#oltSlotSalvar", host).onclick = () => {
          const nomeInput = $("#oltSlotNome", host);
          const techInput = $("#oltSlotTecnologia", host);
          const obsInput = $("#oltSlotObs", host);

          slotData.tipoPlaca = nomeInput.value.trim();
          slotData.tecnologia = techInput.value.trim();
          slotData.observacao = obsInput.value.trim();

          // Atualizar header do slot na grid
          const slotHeader = host.closest(".modal")?.querySelector(`.olt-slot-header[data-slot="${slot}"]`);
          if (slotHeader) {
            const tipoEl = slotHeader.querySelector(".slot-tipo");
            const techEl = slotHeader.querySelector(".slot-tecnologia");
            if (tipoEl) tipoEl.textContent = slotData.tipoPlaca;
            if (techEl) techEl.textContent = slotData.tecnologia;
          }

          // Atualizar também as portas do slot (herdam tipoPlaca/tecnologia)
          slotData.portas.forEach(p => {
            p.tipoPlaca = slotData.tipoPlaca;
            p.tecnologia = slotData.tecnologia;
          });

          close();
        };
      },
    });
  }

  /* ---------------- gestão das portas (padrão) ---------------- */
  /* Criar, remover, renumerar e editar os dados de todas as portas de uma vez.
     Editar uma porta isolada — e o enlace ligado a ela — continua no openPort.
     Nada toca a topologia antes de "Salvar portas": o rascunho é uma cópia. */
  function openPortsManager(e) {
    if (!podeEditarPorta()) return;
    
    // Se for OLT, usar o gerenciador modular
    if (isOLT(e)) {
      return openOltPortsManager(e);
    }

    const canDelete = podeRemoverEnlace();
    let seq = 0;
    const nova = (numero) => ({ numero, capacidade: "A confirmar", tipo: "A confirmar", status: "livre", _row: ++seq, _orig: null });
    const draft = (e.portas || []).map((p) => ({ ...p, _row: ++seq, _orig: Number(p.numero) }));

    modal({
      wide: true,
      labelledBy: "pmTitle",
      html: `
        <div class="modal-head">
          <div><span class="kicker">${esc(e.nome)}</span>
            <h2 id="pmTitle" style="margin-top:6px">Gerenciar portas</h2>
            <p class="muted" style="font-size:var(--fs-13);margin-top:4px">Número, interface, tipo, capacidade, status, descrição e observação de cada porta.</p></div>
          <button class="btn btn-ghost btn-icon" data-close type="button" aria-label="Fechar">${icon("close")}</button>
        </div>
        <div class="modal-body stack">
          <div class="row-between wrap" style="gap:var(--s-3)">
            <span class="row wrap" style="gap:6px">
              <button class="btn btn-sm" type="button" data-add>${icon("plus")} Adicionar porta</button>
              <input class="input mono" id="pmQtd" type="number" min="1" max="96" value="4" style="width:78px"
                aria-label="Quantidade de portas a adicionar em lote">
              <button class="btn btn-sm" type="button" data-addn>Adicionar em lote</button>
            </span>
            <span class="dim" style="font-size:var(--fs-11)" id="pmResumo"></span>
          </div>
          <div class="alert alert-info" style="animation:none">${icon("info")}
            <span>Renumerar uma porta leva o enlace dela junto. Interface e descrição são reescritas na próxima sincronização do Zabbix.</span></div>
          <div class="table-wrap" style="max-height:52vh">
            <table class="table">
              <thead><tr>
                <th style="width:86px">Porta</th><th>Interface</th><th>Tipo</th><th>Capacidade</th>
                <th style="width:140px">Status</th><th>Descrição</th><th>Observação</th><th>Enlace</th><th></th>
              </tr></thead>
              <tbody id="pmRows"></tbody>
            </table>
          </div>
        </div>
        <div class="modal-foot">
          <span class="dim" style="font-size:var(--fs-11)">A alteração vai para a auditoria com estado anterior e posterior.</span>
          <span class="row">
            <button class="btn" data-close type="button">Cancelar</button>
            <button class="btn btn-primary" type="button" data-save>Salvar portas</button>
          </span>
        </div>`,
      onMount: (host, close) => {
        const rows = $("#pmRows", host);
        const linha = (p) => {
          const enlaces = p._orig == null ? [] : enlacesDaPorta(e.id, p._orig);
          const c = enlaces[0];
          const remoto = c ? device(c.origem === e.id ? c.destino : c.origem) : null;
          const remotaPorta = c ? (c.origem === e.id ? c.portaDestino : c.portaOrigem) : null;
          return `<tr data-row="${p._row}">
            <td><input class="input mono" data-c="numero" type="number" min="1" max="9999" style="width:76px"
                  value="${esc(String(p.numero ?? ""))}" aria-label="Número da porta"></td>
            <td><input class="input mono" data-c="nome" value="${esc(p.nome || "")}" placeholder="10GE0/1/1" aria-label="Nome da interface"></td>
            <td><input class="input" data-c="tipo" value="${esc(p.tipo || "")}" placeholder="GE / 10GE" aria-label="Tipo da porta"></td>
            <td><input class="input" data-c="capacidade" value="${esc(p.capacidade || "")}" placeholder="10 Gbps" aria-label="Capacidade da porta"></td>
            <td><select class="select" data-c="status" aria-label="Status da porta" ${c ? "disabled" : ""}>
              ${STATUS_PORTA.map(([v, l]) => `<option value="${v}" ${(p.status || "livre") === v ? "selected" : ""}>${l}</option>`).join("")}
            </select></td>
            <td><input class="input" data-c="descricao" value="${esc(p.descricao || "")}" placeholder="Descrição no equipamento" aria-label="Descrição da porta"></td>
            <td><input class="input" data-c="observacao" value="${esc(p.observacao || "")}" placeholder="Cliente, circuito, OS…" aria-label="Observação da porta"></td>
            <td>${remoto
              ? `<button class="btn btn-ghost btn-sm" type="button" data-link="${p._row}" title="Editar este enlace">${esc(remoto.nome)} • p${remotaPorta}</button>`
              : '<span class="dim">livre</span>'}</td>
            <td><button class="btn btn-ghost btn-sm btn-icon" type="button" data-del="${p._row}"
                  aria-label="Remover a porta ${esc(String(p.numero ?? ""))}" title="Remover porta">${icon("trash")}</button></td>
          </tr>`;
        };

        const achar = (rowId) => draft.find((x) => x._row === Number(rowId));
        const pintar = () => {
          rows.innerHTML = draft.length
            ? draft.map(linha).join("")
            : `<tr><td colspan="9"><div class="empty"><b>Nenhuma porta cadastrada</b><p>Use “Adicionar porta” para começar.</p></div></td></tr>`;
          const comEnlace = draft.filter((p) => p._orig != null && enlacesDaPorta(e.id, p._orig).length).length;
          $("#pmResumo", host).textContent = `${draft.length} portas no rascunho • ${comEnlace} com enlace documentado`;

          $$("[data-del]", rows).forEach((b) => (b.onclick = () => {
            const p = achar(b.dataset.del);
            if (!p) return;
            const enlaces = p._orig == null ? [] : enlacesDaPorta(e.id, p._orig);
            if (enlaces.length && !canDelete) {
              toast("Porta com enlace documentado", {
                text: "Remover uma porta ligada desfaz o enlace, e isso exige as ações topology.delete + topology.link.delete.",
                type: "warn",
              });
              return;
            }
            const remover = () => { draft.splice(draft.indexOf(p), 1); pintar(); };
            if (!enlaces.length) return remover();
            const remoto = device(enlaces[0].origem === e.id ? enlaces[0].destino : enlaces[0].origem);
            askConfirm({
              title: `Remover a porta ${p.numero}?`,
              text: `O enlace com ${remoto?.nome || "o outro equipamento"} também deixa de existir quando as portas forem salvas.`,
              confirmLabel: "Remover porta e enlace",
              danger: true,
              onConfirm: remover,
            });
          }));

          $$("[data-link]", rows).forEach((b) => (b.onclick = () => {
            const p = achar(b.dataset.link);
            if (!p || p._orig == null) return;
            /* O enlace é editado sobre o que está gravado: o rascunho de portas
               ainda não existe na topologia. */
            close();
            openPort(e, p._orig, { edit: true });
          }));
        };

        rows.addEventListener("input", (ev) => {
          const el = ev.target.closest("[data-c]");
          if (!el) return;
          const p = achar(el.closest("tr")?.dataset.row);
          if (p) p[el.dataset.c] = el.value;
        });
        rows.addEventListener("change", (ev) => {
          const el = ev.target.closest('[data-c="status"]');
          if (!el) return;
          const p = achar(el.closest("tr")?.dataset.row);
          if (p) p.status = el.value;
        });

        const proximo = () => draft.reduce((m, p) => Math.max(m, Number(p.numero) || 0), 0) + 1;
        $("[data-add]", host).onclick = () => { draft.push(nova(proximo())); pintar(); };
        $("[data-addn]", host).onclick = () => {
          const qtd = Math.max(1, Math.min(96, Number($("#pmQtd", host).value) || 1));
          let n = proximo();
          for (let i = 0; i < qtd; i++) draft.push(nova(n++));
          pintar();
        };

        $("[data-save]", host).onclick = async () => {
          const numeros = draft.map((p) => Number(p.numero));
          if (numeros.some((n) => !Number.isInteger(n) || n < 1)) {
            toast("Número de porta inválido", { text: "Use números inteiros a partir de 1.", type: "warn" });
            return;
          }
          if (new Set(numeros).size !== numeros.length) {
            toast("Números repetidos", { text: "Duas portas do mesmo equipamento não podem ter o mesmo número.", type: "warn" });
            return;
          }

          const t = NOC.data();
          const backupPortas = (e.portas || []).map((p) => ({ ...p }));
          const backupConexoes = (t.conexoes || []).map((c) => ({ ...c }));

          const mantidas = new Set(draft.filter((p) => p._orig != null).map((p) => p._orig));
          const removidas = backupPortas.map((p) => Number(p.numero)).filter((n) => !mantidas.has(n));
          const perdidos = removidas.flatMap((n) => enlacesDaPorta(e.id, n));
          if (perdidos.length && !canDelete) {
            toast("Sem permissão para desfazer enlaces", {
              text: "As portas removidas têm enlace documentado. São necessárias as ações topology.delete + topology.link.delete.",
              type: "warn",
            });
            return;
          }

          /* Renumeração: a conexão guarda o número da porta, então ela é
             reescrita junto — senão o enlace apontaria para uma porta que
             deixou de existir. */
          const renumerar = new Map(draft
            .filter((p) => p._orig != null && Number(p.numero) !== p._orig)
            .map((p) => [p._orig, Number(p.numero)]));

          t.conexoes = (t.conexoes || []).filter((c) => !perdidos.includes(c)).map((c) => {
            const copia = { ...c };
            if (c.origem === e.id && renumerar.has(Number(c.portaOrigem))) copia.portaOrigem = renumerar.get(Number(c.portaOrigem));
            if (c.destino === e.id && renumerar.has(Number(c.portaDestino))) copia.portaDestino = renumerar.get(Number(c.portaDestino));
            return copia;
          });

          e.portas = draft
            .map(({ _row, _orig, ...p }) => ({ ...p, numero: Number(p.numero) }))
            .sort((a, b) => a.numero - b.numero);
          e.portas.forEach((p) => {
            limparVazios(p, ["nome", "tipo", "capacidade", "descricao", "observacao"]);
            // “conectada” é consequência do enlace, nunca uma escolha solta.
            const ligada = (t.conexoes || []).some((c) =>
              (c.origem === e.id && Number(c.portaOrigem) === p.numero)
              || (c.destino === e.id && Number(c.portaDestino) === p.numero));
            p.status = ligada ? "conectada" : (p.status === "conectada" ? "livre" : (p.status || "livre"));
          });

          const restaurar = () => { e.portas = backupPortas; t.conexoes = backupConexoes; };
          const ok = await persist(
            perdidos.length ? "TOPOLOGY_DELETE_CONEXAO" : "TOPOLOGY_UPDATE_PORTA",
            {
              titulo: "Portas atualizadas",
              texto: `${e.portas.length} portas gravadas${perdidos.length ? ` • ${perdidos.length} enlace(s) desfeito(s)` : ""}.`,
              tipo: perdidos.length ? "warn" : "ok",
            },
            async () => {
              restaurar();
              await persist("TOPOLOGY_UPDATE_PORTA", { titulo: "Alteração desfeita", tipo: "info" });
              if (repaintDevice) repaintDevice();
            });
          if (!ok) { restaurar(); layout(); renderAll(); return; }
          if (repaintDevice) repaintDevice();
          close();
        };

        pintar();
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
        </div>`,
    });
  }

  /* ---------------- cadastro do POP ----------------
     Nome, endereço, rotas e localização em um lugar só. A localização é o que
     coloca o POP no ponto certo do mapa com fundo do OpenStreetMap. */
  function openPopForm(popId, onSaved) {
    const pop = NOC.popRecord(popId);
    if (!pop) return;
    const canEdit = podeEditarPop();
    const canRotas = podeEditarRotas();
    const c = NOC.popCoords(pop);

    modal({
      labelledBy: "popFormTitle",
      html: `
        <div class="modal-head">
          <div><span class="kicker">Cadastro do ponto de presença</span>
            <h2 id="popFormTitle" style="margin-top:6px">${esc(pop.nome || popId)}</h2>
            <p class="muted mono" style="font-size:var(--fs-12);margin-top:4px">${esc(popId)}</p></div>
          <button class="btn btn-ghost btn-icon" data-close type="button" aria-label="Fechar">${icon("close")}</button>
        </div>
        <div class="modal-body stack">
          <form class="stack" id="popForm">
            <div class="field"><label for="epNome">Nome</label>
              <input class="input" id="epNome" value="${esc(pop.nome || "")}" ${canEdit ? "required" : "disabled"}></div>
            <div class="field"><label for="epEndereco">Endereço ou referência</label>
              <input class="input" id="epEndereco" value="${esc(pop.endereco || "")}"
                placeholder="Rua, número, bairro — aparece no cabeçalho do POP" ${canEdit ? "" : "disabled"}></div>

            <hr>
            <div class="row-between">
              <h3 style="font-size:var(--fs-13)">${icon("pops")} Localização no mapa</h3>
              ${c ? `<a class="btn btn-ghost btn-sm" target="_blank" rel="noopener noreferrer"
                href="https://www.openstreetmap.org/?mlat=${encodeURIComponent(c.lat)}&mlon=${encodeURIComponent(c.lon)}#map=17/${encodeURIComponent(c.lat)}/${encodeURIComponent(c.lon)}">Ver no OpenStreetMap</a>` : ""}
            </div>
            <div class="row" style="gap:var(--s-3);align-items:flex-start">
              <div class="field grow"><label for="epLat">Latitude</label>
                <input class="input mono" id="epLat" inputmode="decimal" placeholder="-23.960833"
                  value="${c ? esc(GEO.fmt(c.lat)) : ""}" ${canEdit ? "" : "disabled"}></div>
              <div class="field grow"><label for="epLon">Longitude</label>
                <input class="input mono" id="epLon" inputmode="decimal" placeholder="-46.333611"
                  value="${c ? esc(GEO.fmt(c.lon)) : ""}" ${canEdit ? "" : "disabled"}></div>
            </div>
            <div class="field"><label for="epColar">Colar coordenadas</label>
              <input class="input mono" id="epColar" placeholder="-23.960833, -46.333611" ${canEdit ? "" : "disabled"}>
              <span class="field-hint">Cole o par copiado de um mapa; latitude e longitude acima são preenchidas sozinhas.
                Deixe os dois campos vazios para remover a localização.</span></div>

            <hr>
            <div class="field"><label for="epRotas">Rotas do anel (separadas por vírgula)</label>
              <input class="input" id="epRotas" value="${esc((pop.rotas || []).join(", "))}"
                placeholder="Aérea → Santos, Subterrânea → Cubatão" ${canEdit && canRotas ? "" : "disabled"}>
              ${canRotas ? "" : '<span class="field-hint">Alterar rotas exige as ações topology.edit + pops.routes.</span>'}</div>
          </form>
        </div>
        <div class="modal-foot">
          <span class="dim" style="font-size:var(--fs-11)">${canEdit
            ? "A alteração vai para a auditoria com estado anterior e posterior."
            : "Seu perfil tem acesso somente de leitura ao cadastro de POPs."}</span>
          <span class="row">
            <button class="btn" data-close type="button">Cancelar</button>
            <button class="btn btn-primary" type="button" data-save
              ${canEdit ? "" : "disabled title='Requer as ações topology.edit + pops.edit'"}>Salvar POP</button>
          </span>
        </div>`,
      onMount: (host, close) => {
        const form = $("#popForm", host);
        const lat = $("#epLat", form), lon = $("#epLon", form), colar = $("#epColar", form);

        const espalhar = () => {
          const par = GEO.parseCoords(colar.value);
          if (!par) return;
          lat.value = GEO.fmt(par.lat);
          lon.value = GEO.fmt(par.lon);
          colar.value = "";
        };
        colar.addEventListener("paste", () => setTimeout(espalhar, 0));
        colar.addEventListener("change", espalhar);
        // Colar no campo de latitude o par inteiro também resolve.
        lat.addEventListener("paste", () => setTimeout(() => {
          const par = GEO.parseCoords(lat.value);
          if (par && /[,;\s]/.test(lat.value)) { lat.value = GEO.fmt(par.lat); lon.value = GEO.fmt(par.lon); }
        }, 0));

        $("[data-save]", host).onclick = async () => {
          espalhar();
          const nome = $("#epNome", form).value.trim();
          if (!nome) { $("#epNome", form).focus(); return; }

          const temLat = lat.value.trim() !== "", temLon = lon.value.trim() !== "";
          let coords = null;
          if (temLat || temLon) {
            const n = (v) => Number(String(v).trim().replace(",", "."));
            if (!temLat || !temLon || !GEO.isCoord(n(lat.value), n(lon.value))) {
              toast("Localização inválida", {
                text: "Informe latitude (−90 a 90) e longitude (−180 a 180), ou deixe os dois campos vazios.",
                type: "warn",
              });
              return;
            }
            coords = { lat: Number(n(lat.value).toFixed(6)), lon: Number(n(lon.value).toFixed(6)) };
          }

          const antes = {
            nome: pop.nome, endereco: pop.endereco ?? "",
            lat: pop.lat ?? null, lon: pop.lon ?? null, rotas: [...(pop.rotas || [])],
          };
          const aplicar = (v) => {
            pop.nome = v.nome;
            pop.endereco = v.endereco;
            pop.lat = v.lat;
            pop.lon = v.lon;
            pop.rotas = v.rotas;
            // Coordenada ausente não fica gravada como null no cadastro.
            if (pop.lat === null) { delete pop.lat; delete pop.lon; }
            if (!pop.endereco) delete pop.endereco;
          };
          const depois = {
            nome,
            endereco: $("#epEndereco", form).value.trim(),
            lat: coords ? coords.lat : null,
            lon: coords ? coords.lon : null,
            rotas: canRotas
              ? $("#epRotas", form).value.split(",").map((s) => s.trim()).filter(Boolean)
              : [...(pop.rotas || [])],
          };

          aplicar(depois);
          // O rascunho de arrasto deste POP perde a validade: quem manda agora
          // é o que acabou de ser digitado.
          delete state.geoDraft[popId];
          if (isGeo() && !Object.keys(state.geoDraft).length) state.layoutDirty = false;

          const ok = await persist(
            "TOPOLOGY_UPDATE_POP",
            {
              titulo: `${nome} atualizado`,
              texto: coords
                ? `Localização gravada em ${GEO.label(coords.lat, coords.lon)}.`
                : "Cadastro gravado. Este POP ainda não tem localização no mapa.",
            },
            async () => {
              aplicar(antes);
              await persist("TOPOLOGY_UPDATE_POP", { titulo: "Cadastro anterior restaurado", tipo: "info" });
              if (onSaved) onSaved();
            }
          );
          if (!ok) { aplicar(antes); return; }
          close();
          renderLayoutBar();
          /* O POP recém-localizado pode ter caído fora da vista atual: o mapa
             vai até ele em vez de deixar o operador procurando. */
          if (isGeo() && coords) {
            layout();
            renderAll();
            if (state.boxes[popId]) centerOnBox(popId); else geoFit();
          }
          if (onSaved) onSaved();
        };
      },
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
          pops: () => {
            const semCoord = NOC.pops().filter((p) => !NOC.popCoords(p)).length;
            return `
            <div class="stack">
              <form class="row wrap" style="gap:var(--s-3);align-items:flex-end" id="newPop">
                <div class="field grow" style="min-width:180px"><label for="pNome">Novo POP</label><input class="input" id="pNome" placeholder="Ex.: POP ASCENTY"></div>
                <div class="field grow" style="min-width:200px"><label for="pRotas">Rotas (separadas por vírgula)</label><input class="input" id="pRotas" placeholder="Aérea → Santos, Subterrânea → Cubatão"></div>
                <div class="field" style="width:210px"><label for="pCoord">Localização (lat, lon)</label>
                  <input class="input mono" id="pCoord" placeholder="-23.9608, -46.3336"></div>
                <button class="btn btn-primary" type="submit" ${podeCriarPop() ? "" : "disabled title='Requer as ações topology.edit + pops.create'"}>Criar POP</button>
              </form>
              ${semCoord ? `<div class="alert alert-info" style="animation:none">${icon("info")}
                <span><b>${semCoord} POP(s) sem localização.</b> Sem latitude e longitude eles não aparecem no modo “Mapa” —
                use <b>Editar</b> abaixo para cadastrar, ou arraste o POP no mapa com “Definir localização”.</span></div>` : ""}
              <div class="table-wrap"><table class="table">
                <thead><tr><th>POP</th><th>Localização</th><th>Rotas</th><th class="num">Equip.</th><th class="num">Portas</th><th></th></tr></thead>
                <tbody>${NOC.pops().map((p) => {
                  const st = siteStats(p.id);
                  const c = NOC.popCoords(p);
                  return `<tr>
                    <td><b>${esc(p.nome)}</b><br><small class="dim mono">${esc(p.id)}</small></td>
                    <td>${c
                      ? `<span class="mono" style="font-size:var(--fs-11)">${esc(GEO.label(c.lat, c.lon))}</span>${p.endereco ? `<br><small class="dim">${esc(p.endereco)}</small>` : ""}`
                      : '<span class="badge badge-warn">sem localização</span>'}</td>
                    <td class="dim">${p.rotas.map(esc).join(" • ") || "—"}</td>
                    <td class="num">${st.list.length}</td>
                    <td class="num">${st.portas}</td>
                    <td><span class="row" style="gap:6px">
                      <button class="btn btn-sm" type="button" data-editpop="${esc(p.id)}"
                        ${podeEditarPop() ? "" : "disabled title='Requer as ações topology.edit + pops.edit'"}>${icon("edit")} Editar</button>
                    </span></td>
                  </tr>`;
                }).join("")}</tbody>
              </table></div>
            </div>`;
          },
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
          $$("[data-editpop]", body).forEach((b) => (b.onclick = () => openPopForm(b.dataset.editpop, paint)));
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
            const bruto = $("#pCoord", popForm).value.trim();
            const coords = bruto ? GEO.parseCoords(bruto) : null;
            if (bruto && !coords) {
              toast("Localização inválida", {
                text: "Informe o par no formato “-23.9608, -46.3336”, ou deixe o campo vazio.",
                type: "warn",
              });
              return;
            }
            // "POP ASCENTY" → pop-ascenty (sem duplicar o prefixo)
            const slug = nome.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "")
              .replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").replace(/^pop-?/, "");
            const novo = { id: "pop-" + slug, nome, rotas, equipamentos: [] };
            if (coords) { novo.lat = Number(coords.lat.toFixed(6)); novo.lon = Number(coords.lon.toFixed(6)); }
            if (NOC.popById(novo.id)) {
              toast("Este POP já existe", { text: `Já há um POP com o identificador ${novo.id}.`, type: "warn" });
              return;
            }
            NOC.data().pops.push(novo);
            const ok = await persist("TOPOLOGY_CREATE_POP", {
              titulo: "POP criado",
              texto: coords
                ? `${nome} já pode receber equipamentos e aparece no mapa em ${GEO.label(coords.lat, coords.lon)}.`
                : `${nome} já pode receber equipamentos. Cadastre a localização para vê-lo no mapa.`,
            });
            if (!ok) NOC.data().pops = NOC.data().pops.filter((p) => p.id !== novo.id);
            paint();
          };
        };
        $$("[data-mt]", host).forEach((t) => (t.onclick = () => { cur = t.dataset.mt; paint(); }));
        paint();
      },
    });
  }

  /* POPs sem coordenada não têm onde ser desenhados no mapa geográfico: em vez
     de sumirem sem explicação, viram uma lista com atalho para o cadastro. */
  function renderMissing() {
    const box = $("#geoMissing");
    if (!box) return;
    const faltando = isGeo() ? semLocal() : [];
    box.hidden = !faltando.length;
    if (!faltando.length) { box.innerHTML = ""; return; }

    const pendente = faltando.find((s) => s.id === SEM_POP);
    const pops = faltando.filter((s) => s.id !== SEM_POP);
    /* Em modo de localização o POP não tem como ser arrastado — ele nem está
       desenhado. O botão então o solta no centro da vista, e daí em diante é
       arrasto normal até o ponto certo. */
    const soltando = state.editLayout && podeEditarPop();
    box.innerHTML = `
      <b style="font-size:var(--fs-12)">${faltando.length} fora do mapa</b>
      ${pops.map((s) => `<div class="row-between">
        <span class="truncate" title="${esc(s.nome)}">${esc(s.nome)}</span>
        <button class="btn btn-ghost btn-sm" type="button" data-${soltando ? "drop" : "locate"}="${esc(s.id)}"
          ${podeEditarPop() ? "" : "disabled title='Requer as ações topology.edit + pops.edit'"}
        >${soltando ? "Colocar aqui" : "Localizar"}</button>
      </div>`).join("")}
      ${pendente ? `<div class="dim" style="font-size:var(--fs-10)">
        ${devicesOf(SEM_POP).length} equipamento(s) sem POP vinculado só aparecem no modo Esquema.</div>` : ""}`;

    $$("[data-locate]", box).forEach((b) => (b.onclick = () => openPopForm(b.dataset.locate, () => {
      layout(); renderAll();
      if (state.boxes[b.dataset.locate]) centerOnBox(b.dataset.locate); else applyTransform();
    })));

    $$("[data-drop]", box).forEach((b) => (b.onclick = () => {
      const st = stage().getBoundingClientRect();
      const c = geoCoordsAt((st.width / 2 - state.tx) / state.scale, (st.height / 2 - state.ty) / state.scale);
      state.geoDraft[b.dataset.drop] = { lat: c.lat, lon: c.lon };
      state.layoutDirty = true;
      layout();
      renderAll();
      renderLayoutBar();
      applyTransform();
      toast(`${siteById(b.dataset.drop)?.nome || "POP"} colocado no mapa`, {
        text: "Arraste o alfinete até o ponto exato e clique em “Salvar localizações”.",
        type: "info",
      });
    }));
  }

  /* ---------------- render + início ---------------- */
  function renderAll() {
    renderList();
    renderSites();
    renderEdges();
    renderMissing();
    renderPopsView();
    // Camada de fibra da PARTE ISP: só existe nas telas que carregam noc-fibra.js.
    window.FIBRA?.render();
  }

  /* ---------------- ponte para a camada de fibra ----------------
     O mapa geográfico é desta tela: escala, origem e transform do mundo vivem
     aqui. A camada de fibra desenha no mesmo mundo, então em vez de duplicar a
     projeção ela pede a conversão por esta ponte. Fora do mapa geográfico
     `geo()` devolve null e a camada simplesmente não desenha. */
  window.TOPO = {
    geo: () => (isGeo() ? { ...state.geo, escala: state.scale, tx: state.tx, ty: state.ty } : null),
    mundo: () => world(),
    palco: () => stage(),
    /* lat/lon → pixel do mundo, o mesmo sistema das caixas dos POPs. */
    paraMundo(lat, lon) {
      if (!isGeo()) return null;
      const p = GEO.project(lat, lon);
      return { x: p.x * state.geo.k - state.geo.ox, y: p.y * state.geo.k - state.geo.oy };
    },
    paraCoords: (x, y) => geoCoordsAt(x, y),
    /* Evento do ponteiro → pixel do mundo, descontando pan e zoom do palco. */
    pontoDoEvento(ev) {
      const st = stage().getBoundingClientRect();
      return {
        x: (ev.clientX - st.left - state.tx) / state.scale,
        y: (ev.clientY - st.top - state.ty) / state.scale,
      };
    },
    escala: () => state.scale,
    dimensoes: () => ({ ...state.world }),
    repintar() { layout(); renderAll(); applyTransform(false); },
    /* Leva o mapa até um ponto geográfico — usado ao localizar uma fibra. */
    irPara(lat, lon) {
      const p = this.paraMundo(lat, lon);
      if (!p) return;
      const st = stage().getBoundingClientRect();
      state.tx = st.width / 2 - p.x * state.scale;
      state.ty = st.height / 2 - p.y * state.scale;
      applyTransform();
    },
    enquadrarPontos(pontos) {
      const alvos = pontos.map(([lat, lon]) => GEO.project(lat, lon)).filter(Boolean);
      if (!alvos.length) return;
      enquadrar(
        { x: Math.min(...alvos.map((p) => p.x)), y: Math.min(...alvos.map((p) => p.y)) },
        { x: Math.max(...alvos.map((p) => p.x)), y: Math.max(...alvos.map((p) => p.y)) },
        90
      );
      layout();
      renderAll();
      applyTransform();
    },
    persistir: (motivo, mensagem, undo) => persist(motivo, mensagem, undo),
    abrirEquipamento: (id) => openDevice(id),
  };

  /* O modo escolhido é lembrado por navegador: quem trabalha com o mapa
     geográfico não precisa selecioná-lo a cada abertura. */
  function modoPreferido() {
    try { return localStorage.getItem(VIEW_KEY) || VIEW_INICIAL || "mapa"; }
    catch (e) { return VIEW_INICIAL || "mapa"; /* modo privado */ }
  }

  function setView(view) {
    const antes = state.view;
    if (antes === view) return;
    // Sair do modo geográfico com localizações arrastadas e não salvas seria
    // perdê-las em silêncio.
    if (antes === "geo" && state.editLayout && state.layoutDirty) {
      askConfirm({
        title: "Sair sem salvar as localizações?",
        text: "Os POPs voltam para as coordenadas da última gravação.",
        confirmLabel: "Descartar alterações",
        danger: true,
        onConfirm: () => { state.geoDraft = {}; state.layoutDirty = false; setLayoutEdit(false); setView(view); },
      });
      return;
    }
    // Sair da aba POPs com alterações no anel não salvas
    if (antes === "pops" && state.ringDirty) {
      askConfirm({
        title: "Sair sem salvar o mapa do anel?",
        text: "Os POPs voltam para as posições da última gravação.",
        confirmLabel: "Descartar alterações",
        danger: true,
        onConfirm: () => { state.ringLayout = { ...(NOC.data()?.config?.ringLayout || {}) }; state.ringDirty = false; setView(view); },
      });
      return;
    }

    state.view = view;
    /* Entrando no mapa geográfico, todo POP volta a ser alfinete: o card é do
       clique. Cards herdados do esquema cobririam o mapa logo na abertura. */
    if (view === "geo") { state.geoOpen.clear(); state.expanded.clear(); }
    // Inicializar o layout do anel ao entrar na aba POPs
    if (view === "pops") {
      state.ringLayout = { ...(NOC.data()?.config?.ringLayout || {}) };
      state.ringDirty = false;
    }
    try { localStorage.setItem(VIEW_KEY, view); } catch (e) { /* modo privado */ }
    $$("[data-view]").forEach((x) => x.setAttribute("aria-pressed", String(x.dataset.view === view)));

    /* A aba "Lista" da Topologia ISP é o cadastro embutido (isp-cadastro).
       Ela substitui o palco quando presente; nas demais telas não existe
       `#listView`, então nada muda. */
    const mapa = view === "mapa" || view === "geo";
    $("#stage").hidden = !mapa;
    const listView = $("#listView");
    if (listView) {
      listView.hidden = view !== "lista";
      if (view === "lista") window.ISP_CADASTRO?.render();
    }
    const side = $(".topo-side");
    if (side) side.hidden = !mapa;
    /* A aba POPs só existe na Topologia da rede; as telas ISP não a têm. Sem
       a guarda, `setView` estourava ali e nunca chegava às linhas abaixo — a
       legenda, o fundo do mapa e o enquadramento ficavam sem aplicar nas duas
       telas ISP toda vez que elas abriam fora do modo "mapa". */
    const popsView = $("#popsView");
    if (popsView) popsView.hidden = view !== "pops";
    const legend = $("#legend");
    if (legend) {
      const views = (legend.dataset.views || "mapa").split(/\s+/);
      legend.hidden = !views.includes(view);
    }
    $("#geoAttrib").hidden = view !== "geo";
    // A atribuição do OpenStreetMap ocupa a base do palco só no modo geográfico.
    stage().classList.toggle("is-geo", view === "geo");
    if (state.editLayout) setLayoutEdit(false);
    syncLayoutButton();
    renderBasemap();
    if (!mapa) return;
    /* Cada modo tem o seu enquadramento: trocar de modo reenquadra. O mapa
       geográfico sempre abre na vista padrão, e não no ajuste aos POPs — é o
       enquadramento de trabalho, o mesmo toda vez. */
    setTimeout(() => { layout(); renderAll(); if (isGeo()) aberturaGeo(); else fit(); }, 30);
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
          // Nas telas com camada de fibra, os cabos também entram na busca.
          ...(window.FIBRA?.itensDeBusca?.() || []),
        ];
      },
    });

    $("#iconSearch").innerHTML = icon("search");
    $("#zoomIn").innerHTML = icon("zoomIn");
    $("#zoomOut").innerHTML = icon("zoomOut");
    $("#zoomFit").innerHTML = icon("fit");
    if ($("#toggleSide")) $("#toggleSide").innerHTML = icon("chevronLeft");
    if ($("#filterButtonIcon")) $("#filterButtonIcon").innerHTML = icon("filter");
    $("#btnManage").innerHTML = icon("plus") + " Gerenciar rede";

    if ($("#deviceList")) NOC.skeleton($("#deviceList"), 5);

    try {
      await NOC.load();
    } catch (err) {
      if ($("#deviceList")) NOC.errorState($("#deviceList"), err, () => location.reload());
      toast("Falha ao carregar a topologia", { text: err.message, type: "danger", timeout: 8000 });
      return;
    }

    const t = NOC.data();
    if (t.config?.coreTitle) $("#topoKicker").textContent = t.config.coreTitle;
    state.layout = { ...(t.config?.layout || {}) };
    state.ringLayout = { ...(t.config?.ringLayout || {}) };
    // Cada botão declara a ação que exige no HTML (data-action) e o NOC
    // aplica o perfil do usuário de uma vez só.
    NOC.applyActions(document);

    renderFilters();
    layout();
    renderAll();
    bindStage();
    requestAnimationFrame(fit);

    /* A carga dos enlaces chega depois do primeiro desenho e volta de minuto
       em minuto: cada leitura nova só repinta as linhas e a legenda, sem
       refazer o layout nem perder o enquadramento do operador. */
    TRAF.ligarDica(stage());
    TRAF.acompanhar(renderEdges);

    /* Abre o primeiro POP com equipamentos, para o mapa não começar "vazio".
       No mapa geográfico não: lá o POP nasce como alfinete e o card é do
       clique — abrir um sozinho já tapa a cidade dele. */
    const primeiro = modoPreferido() !== "geo" && visibleSites().find((s) => devicesOf(s.id).length);
    if (primeiro) { state.expanded.add(primeiro.id); layout(); renderAll(); requestAnimationFrame(fit); }

    let resizeTimer = null;
    addEventListener("resize", () => {
      clearTimeout(resizeTimer);
      // No mapa geográfico o enquadramento é do usuário: redimensionar a janela
      // só precisa repintar os tiles da nova área visível.
      resizeTimer = setTimeout(() => {
        if (state.view === "mapa") fit();
        else if (isGeo()) { layout(); renderAll(); applyTransform(false); }
      }, 160);
    });

    $("#deviceSearch").addEventListener("input", (e) => {
      state.query = e.target.value.trim().toLowerCase();
      syncFilterButton();
      renderAll();
    });
    $("#clearFilters").onclick = () => {
      state.query = ""; state.cats.clear();
      $("#deviceSearch").value = "";
      renderFilters(); renderAll();
    };
    const filterButton = $("#toggleFilters");
    const filterPanel = $("#filterPanel");
    if (filterButton && filterPanel) {
      filterButton.onclick = () => {
        const open = filterButton.getAttribute("aria-expanded") !== "true";
        filterButton.setAttribute("aria-expanded", String(open));
        filterPanel.classList.toggle("is-open", open);
        filterPanel.setAttribute("aria-hidden", String(!open));
        filterPanel.inert = !open;
        if (open) setTimeout(() => $("#deviceSearch").focus(), 180);
      };
    }
    /* Algumas variações da topologia ainda exibem a lista lateral. Na tela
       principal ela foi removida, então o controle é montado somente quando
       essa variação oferece o botão. */
    const sideButton = $("#toggleSide");
    if (sideButton) {
      const sincronizaBotaoLista = (hidden) => {
        sideButton.innerHTML = icon(hidden ? "chevronRight" : "chevronLeft");
        sideButton.setAttribute("aria-label", hidden ? "Mostrar lista de equipamentos" : "Ocultar lista de equipamentos");
        sideButton.setAttribute("aria-expanded", String(!hidden));
      };
      if (matchMedia("(max-width: 1100px)").matches) {
        $("#topoMain").classList.add("is-side-hidden");
        sincronizaBotaoLista(true);
      }
      sideButton.onclick = () => {
        const hidden = $("#topoMain").classList.toggle("is-side-hidden");
        sincronizaBotaoLista(hidden);
        setTimeout(() => { if (isGeo()) { layout(); renderAll(); applyTransform(false); } else fit(); }, 60);
      };
    }
    // O botão de animação do tráfego é opcional na barra: sem ele, o fluxo
    // fica no padrão e o resto da tela continua funcionando.
    const btnFlow = $("#btnFlow");
    if (btnFlow) btnFlow.onclick = () => {
      state.flow = !state.flow;
      btnFlow.setAttribute("aria-pressed", String(state.flow));
      renderEdges();
    };
    $("#expandAll").onclick = () => {
      const comEquip = mapSites().filter((s) => devicesOf(s.id).length);
      const abrir = state.expanded.size < comEquip.length;
      state.expanded = abrir ? new Set(comEquip.map((s) => s.id)) : new Set();
      // No mapa geográfico, expandir tudo também abre os cards dos alfinetes.
      if (isGeo()) state.geoOpen = abrir ? new Set(mapSites().map((s) => s.id)) : new Set();
      $("#expandAll").textContent = abrir ? "Recolher tudo" : "Expandir tudo";
      if (isGeo()) { layout(); renderAll(); applyTransform(); } else fit();
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

    // Anel óptico (aba POPs)
    const btnRingTopo = $("#btnRingTopo");
    if (btnRingTopo) btnRingTopo.onclick = () => {
      state.ringDirty = !state.ringDirty;
      btnRingTopo.setAttribute("aria-pressed", String(state.ringDirty));
      btnRingTopo.textContent = state.ringDirty ? "Sair do mapa" : "Editar mapa";
      renderRingTopo();
    };
    const ringSaveTopo = $("#ringSaveTopo");
    if (ringSaveTopo) ringSaveTopo.onclick = async () => {
      const antes = { ...(NOC.data()?.config?.ringLayout || {}) };
      const gravar = (posicoes) => {
        const t = NOC.data();
        t.config = { ...(t.config || {}), ringLayout: posicoes };
        state.ringLayout = { ...posicoes };
        state.ringDirty = false;
      };
      const depois = { ...state.ringLayout };
      gravar(depois);
      const ok = await persistPop(
        "TOPOLOGY_RING_LAYOUT",
        { titulo: "Mapa do anel salvo", texto: "O desenho vale para todos os usuários." },
        async () => {
          gravar(antes);
          await persistPop("TOPOLOGY_RING_LAYOUT", { titulo: "Desenho anterior restaurado", tipo: "info" });
        }
      );
      if (!ok) state.ringDirty = true;
      renderRingTopo();
    };
    const ringDiscardTopo = $("#ringDiscardTopo");
    if (ringDiscardTopo) ringDiscardTopo.onclick = () => {
      state.ringLayout = { ...(NOC.data()?.config?.ringLayout || {}) };
      state.ringDirty = false;
      renderRingTopo();
    };
    const ringAutoTopo = $("#ringAutoTopo");
    if (ringAutoTopo) ringAutoTopo.onclick = () => askConfirm({
      title: "Voltar ao desenho automático?",
      text: "As posições manuais são descartadas e os POPs voltam a se distribuir em círculo, na sequência cadastrada.",
      confirmLabel: "Usar desenho automático",
      onConfirm: () => {
        state.ringLayout = {};
        state.ringDirty = true;
        renderRingTopo();
      },
    });

    $$("[data-view]").forEach((b) => (b.onclick = () => setView(b.dataset.view)));

    const inicial = modoPreferido();
    if (inicial === "geo" || inicial === "pops" || inicial === "lista") setView(inicial);
    else syncLayoutButton();

    // Cadastro embutido na aba "Lista": renderiza assim que a topologia
    // termina de carregar, mesmo quando a tela abre direto nesse modo.
    if ($("#listView")) window.ISP_CADASTRO?.render();

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
