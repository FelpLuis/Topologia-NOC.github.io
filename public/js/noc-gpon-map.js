/* ============================================================
   UPDOWN NOC — Mapa GPON operacional (somente leitura)
   Une topologia documentada + estado monitorado + clientes da OLT.
   ============================================================ */
(() => {
  "use strict";
  const { $, $$, esc, icon, toast } = UI;
  const state = {
    topology: { equipamentos: [], conexoes: [], pops: [] },
    feed: { clients: [], boxes: [], alerts: [], configured: false },
    selected: null, query: "", layers: { clients: true, boxes: true, pops: true, drops: true },
    map: { k: 2 ** 12, ox: 0, oy: 0 }, basemap: null, dragging: null, fitted: false,
    view: "map", page: 0,
  };
  const PAGE_SIZE = 250;
  const VIEW_KEY = `updown.gpon.view.${location.pathname}`;

  const coord = (o) => o && GEO.isCoord(o.lat, o.lon);
  const statusOnline = (s) => !/offline|down|los|inativo|critical|critico|falha/i.test(String(s || "online"));
  const signalCritical = (c) => Number.isFinite(Number(c.rx_power)) && Number(c.rx_power) <= -27;
  const clientAlert = (c) => !statusOnline(c.status) || signalCritical(c);
  const devices = () => state.topology.equipamentos || [];
  const clients = () => state.feed.clients || [];
  const boxes = () => state.feed.boxes || [];
  const pops = () => state.topology.pops || [];
  const deviceById = (id) => devices().find((e) => String(e.id) === String(id));
  const boxById = (id) => boxes().find((b) => String(b.id) === String(id));
  const popById = (id) => pops().find((p) => String(p.id) === String(id));
  const popOfDevice = (e) => e ? popById(e.popId || NOC.suggestPop(e)) : null;
  const popOfClient = (c) => popOfDevice(deviceById(c.olt_id));
  const validClients = () => clients().filter(coord);
  const searchText = (c) => `${c.name} ${c.username} ${c.serial} ${c.olt_id} ${c.pon} ${c.address} ${c.ip}`.toLowerCase();
  const visibleClients = () => clients().filter((c) => !state.query || searchText(c).includes(state.query));

  function mount() {
    UI.mountShell({ search: () => clients().map((c) => ({
      label: c.name, meta: `${c.serial || "Sem serial"} • ${c.olt_id || "OLT não informada"}`,
      icon: "user", action: () => {
        setView("map");
        requestAnimationFrame(() => select("client", c.id, true));
      },
    })) });
    if ($("#tabIcon")) $("#tabIcon").innerHTML = icon("pops");
    $("#searchIcon").innerHTML = icon("search");
    if ($("#listSearchIcon")) $("#listSearchIcon").innerHTML = icon("search");
    $("#detailIcon").innerHTML = icon("topology");
    $("#refreshMap").innerHTML = `${icon("refresh")} Atualizar`;
    $("#mapZoomOut").innerHTML = icon("zoomOut");
    $("#mapZoomIn").innerHTML = icon("zoomIn");
    $("#mapFit").innerHTML = icon("fit");
    $("#refreshMap").onclick = () => load(true);
    const updateQuery = (value) => {
      state.query = value.trim().toLowerCase();
      state.page = 0;
      if ($("#mapSearch")) $("#mapSearch").value = value;
      if ($("#gponListSearch")) $("#gponListSearch").value = value;
      render();
    };
    $("#mapSearch").oninput = (e) => updateQuery(e.target.value);
    if ($("#gponListSearch")) $("#gponListSearch").oninput = (e) => updateQuery(e.target.value);
    $$('[data-gpon-view]').forEach((el) => el.onclick = () => setView(el.dataset.gponView));
    if ($("#gponPrevPage")) $("#gponPrevPage").onclick = () => { state.page = Math.max(0, state.page - 1); renderTable(); };
    if ($("#gponNextPage")) $("#gponNextPage").onclick = () => { state.page += 1; renderTable(); };
    $$('[data-layer]').forEach((el) => el.onchange = () => { state.layers[el.dataset.layer] = el.checked; renderMap(); });
    $("#mapZoomIn").onclick = () => zoom(2);
    $("#mapZoomOut").onclick = () => zoom(.5);
    $("#mapFit").onclick = fit;
    bindMap();
    new ResizeObserver(() => renderMap()).observe($("#gponMap"));
    try {
      const saved = localStorage.getItem(VIEW_KEY);
      if (saved === "map" || saved === "list") state.view = saved;
    } catch {}
    applyView(false);
    load(false);
    setInterval(refreshIfChanged, 10000);
  }

  async function refreshIfChanged() {
    if (!state.feed.configured) return load(false);
    try {
      const revision = await NOC.api("/api/gpon/revision");
      if (revision.synced_at && revision.synced_at !== state.feed.synced_at) await load(false);
    } catch {}
  }

  async function load(manual) {
    const button = $("#refreshMap");
    button.disabled = true;
    const [top, feed] = await Promise.allSettled([NOC.load(), NOC.api("/api/gpon/clients")]);
    if (top.status === "fulfilled") state.topology = top.value;
    else NOC.errorState($("#gponDetail"), top.reason, () => load(true));
    state.feed = feed.status === "fulfilled" ? feed.value : {
      configured: true, unavailable: true, clients: [], boxes: [], alerts: [],
      message: "A fonte da OLT não respondeu nesta atualização.",
    };
    button.disabled = false;
    render();
    if (state.view === "map") requestAnimationFrame(fit);
    if (manual) toast("Mapa atualizado", { type: feed.status === "fulfilled" ? "ok" : "warn",
      text: feed.status === "fulfilled" ? "Topologia e clientes foram recarregados." : "A topologia abriu, mas a fonte da OLT não respondeu." });
  }

  function render() {
    renderSource(); renderKpis(); renderClientList(); renderAlerts(); renderTable(); renderMap(); renderDetail();
  }

  function setView(view) {
    if (view !== "map" && view !== "list") return;
    state.view = view;
    try { localStorage.setItem(VIEW_KEY, view); } catch {}
    applyView(true);
  }

  function applyView(focus) {
    const mapView = $("#gponMapView"), listView = $("#gponListView");
    if (!listView) return;
    const showMap = state.view === "map";
    mapView.hidden = !showMap;
    listView.hidden = showMap;
    $$('[data-gpon-view]').forEach((el) => el.setAttribute("aria-pressed", String(el.dataset.gponView === state.view)));
    if (showMap) requestAnimationFrame(() => state.fitted ? renderMap() : fit());
    else if (focus) $("#gponListSearch")?.focus();
  }

  function renderSource() {
    const f = state.feed;
    const badge = $("#sourceBadge");
    badge.className = `badge ${f.unavailable ? "badge-danger" : f.configured ? "badge-ok" : "badge-warn"}`;
    badge.textContent = f.unavailable ? "Fonte OLT indisponível" : f.configured ? `Fonte: ${f.source || "OLT"}` : "Fonte OLT não configurada";
    $("#syncTime").textContent = f.synced_at ? `Atualizado ${new Date(f.synced_at).toLocaleString("pt-BR")}` : "Sem sincronização da OLT";
    const message = $("#mapMessage");
    const semLocal = clients().length - validClients().length;
    const info = f.message || (semLocal ? `${semLocal.toLocaleString("pt-BR")} clientes foram importados sem coordenadas. Use a lista lateral para consultá-los e relacione serial/ONU ao cadastro de clientes para posicioná-los.` : "");
    message.hidden = !info;
    message.textContent = info;
  }

  function renderKpis() {
    const total = clients().length;
    const online = clients().filter((c) => statusOnline(c.status)).length;
    const located = validClients().length;
    const alertas = allAlerts().length;
    const oltIds = new Set(clients().map((c) => c.olt_id).filter(Boolean));
    const items = [
      ["Clientes autenticados", total, `${online} online`],
      ["ONUs online", online, total ? `${Math.round(online / total * 100)}% da base` : "Aguardando OLT"],
      ["Com localização", located, total ? `${total - located} sem coordenadas` : "—"],
      ["OLTs em atendimento", oltIds.size, oltIds.size ? [...oltIds].slice(0, 2).join(", ") : "Não informadas"],
      ["Alertas", alertas, alertas ? "Requer atenção" : "Operação normal"],
    ];
    $("#gponKpis").innerHTML = items.map(([label, value, small]) => `<div class="gpon-kpi"><span>${esc(label)}</span><strong>${esc(value)}</strong><small>${esc(small)}</small></div>`).join("");
  }

  function allAlerts() {
    const generated = clients().filter(clientAlert).map((c) => ({
      id: `client:${c.id}`, client_id: c.id, level: !statusOnline(c.status) ? "critical" : "warning",
      title: !statusOnline(c.status) ? `${c.name} offline` : `${c.name} com sinal crítico`,
      detail: !statusOnline(c.status) ? `${c.olt_id || "OLT"} • ${c.pon || "PON não informada"}` : `RX ${c.rx_power} dBm`,
    }));
    const links = (state.topology.conexoes || []).filter((c) => NOC.linkStatus(c) === "down").map((c, i) => ({
      id: `link:${i}`, level: "critical", title: "Enlace documentado fora do ar",
      detail: `${deviceById(c.origem)?.nome || c.origem} ↔ ${deviceById(c.destino)?.nome || c.destino}`,
    }));
    return [...generated, ...links, ...(state.feed.alerts || [])];
  }

  function renderClientList() {
    const list = visibleClients(), shown = list.slice(0, 60);
    $("#clientListCount").textContent = list.length.toLocaleString("pt-BR");
    $("#clientList").innerHTML = shown.map((c) => `<button class="gpon-client-row ${clientAlert(c) ? "is-alert" : ""}" type="button" data-client-row="${esc(c.id)}" ${state.selected?.type === "client" && String(state.selected.id) === String(c.id) ? 'aria-current="true"' : ""}>
      <i></i><span><b>${esc(c.name)}</b><small>${esc(`${c.serial || c.onu_index || "Sem serial"} • ${c.olt_id}${c.pon ? ` • ${c.pon}` : ""}`)}</small></span></button>`).join("")
      + (list.length > shown.length ? `<div class="gpon-list-more">Mostrando 60 de ${list.length.toLocaleString("pt-BR")}. Refine a busca.</div>` : "");
    $$('[data-client-row]', $("#clientList")).forEach((el) => el.onclick = () => select("client", el.dataset.clientRow, false));
  }

  function renderTable() {
    const body = $("#gponListBody");
    if (!body) return;
    const list = visibleClients();
    const pages = Math.max(1, Math.ceil(list.length / PAGE_SIZE));
    state.page = Math.min(state.page, pages - 1);
    const start = state.page * PAGE_SIZE;
    const rows = list.slice(start, start + PAGE_SIZE);
    $("#gponTableCount").textContent = `${list.length.toLocaleString("pt-BR")} de ${clients().length.toLocaleString("pt-BR")} clientes`;
    body.innerHTML = rows.length ? rows.map((c) => {
      const alert = clientAlert(c);
      const status = alert ? (!statusOnline(c.status) ? "Offline" : "Sinal crítico") : "Online";
      return `<tr>
        <td><b>${esc(c.name)}</b><br><small class="dim mono">${esc(c.serial || c.onu_index || "Sem serial")}</small></td>
        <td><span class="badge ${alert ? "badge-danger" : "badge-ok"}">${esc(status)}</span></td>
        <td><b>${esc(deviceById(c.olt_id)?.nome || c.olt_id || "—")}</b><br><small class="dim mono">${esc(c.pon || "PON não informada")}</small></td>
        <td>${esc(boxById(c.box_id)?.name || c.box_id || "—")}</td>
        <td class="mono">${c.rx_power === null || c.rx_power === undefined ? "—" : `${esc(c.rx_power)} dBm`}</td>
        <td>${esc(c.address || "—")}</td>
        <td><button class="btn btn-sm" type="button" data-client-map="${esc(c.id)}">Ver no mapa</button></td>
      </tr>`;
    }).join("") : `<tr><td colspan="7"><div class="empty"><b>Nenhum cliente encontrado</b><p>Ajuste a busca para consultar a base GPON.</p></div></td></tr>`;
    $$('[data-client-map]', body).forEach((el) => el.onclick = () => {
      setView("map");
      requestAnimationFrame(() => select("client", el.dataset.clientMap, true));
    });
    const pagination = $("#gponPagination");
    pagination.hidden = pages <= 1;
    $("#gponPageLabel").textContent = `Página ${state.page + 1} de ${pages}`;
    $("#gponPrevPage").disabled = state.page === 0;
    $("#gponNextPage").disabled = state.page >= pages - 1;
  }

  function renderAlerts() {
    const alerts = allAlerts();
    $("#alertCount").textContent = alerts.length;
    $("#alertsList").innerHTML = alerts.length ? alerts.slice(0, 20).map((a, i) => `<button class="gpon-alert ${/critical|critico/i.test(a.level || a.nivel) ? "is-critical" : ""}" type="button" data-alert="${i}">
      <b>${esc(a.title || a.titulo || "Alerta GPON")}</b><small>${esc(a.detail || a.detalhe || "Verifique a rede óptica.")}</small></button>`).join("")
      : `<div class="empty" style="padding:16px 4px"><b>Sem alertas</b><p>Nenhuma falha derivada dos dados atuais.</p></div>`;
    $$('[data-alert]', $("#alertsList")).forEach((el) => el.onclick = () => {
      const a = alerts[Number(el.dataset.alert)]; if (a?.client_id) select("client", a.client_id, true);
    });
  }

  function xy(o) { const p = GEO.project(o.lat, o.lon); return { x: p.x * state.map.k - state.map.ox, y: p.y * state.map.k - state.map.oy }; }
  function renderMap() {
    const stage = $("#gponMap"), rect = stage.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    if (!state.basemap) state.basemap = GEO.basemap($("#gponBasemap"));
    state.basemap.render({ k: state.map.k, ox: state.map.ox, oy: state.map.oy, escala: 1, x0: 0, y0: 0, x1: rect.width, y1: rect.height });
    $("#mapZoomLabel").textContent = `z${GEO.tileZoom(state.map.k, 1)}`;
    renderRoutes(); renderMarkers();
  }

  function route(points, className) {
    const d = points.filter(coord).map((p, i) => { const q = xy(p); return `${i ? "L" : "M"}${q.x.toFixed(1)},${q.y.toFixed(1)}`; }).join(" ");
    return d ? `<path class="gpon-route ${className}" d="${d}"/>` : "";
  }

  function renderRoutes() {
    const svg = $("#gponRoutes"), pieces = [], seen = new Set();
    if (state.layers.pops) (state.topology.conexoes || []).forEach((c) => {
      const a = popOfDevice(deviceById(c.origem)), b = popOfDevice(deviceById(c.destino));
      if (!coord(a) || !coord(b) || a.id === b.id) return;
      const key = [a.id, b.id].sort().join(":"); if (seen.has(key)) return; seen.add(key);
      pieces.push(route([a, b], "gpon-route-network"));
    });
    if (state.layers.drops) visibleClients().forEach((c) => {
      if (!coord(c)) return;
      const box = boxById(c.box_id), points = [...(c.drop_path || [])];
      if (!points.length && coord(box)) points.push(box, c);
      else if (points.length) {
        if (coord(box) && (points[0].lat !== box.lat || points[0].lon !== box.lon)) points.unshift(box);
        const last = points[points.length - 1]; if (last.lat !== c.lat || last.lon !== c.lon) points.push(c);
      }
      pieces.push(route(points, `gpon-route-drop ${clientAlert(c) ? "is-alert" : ""}`));
    });
    svg.innerHTML = pieces.join("");
  }

  function marker(type, item, label, iconName, extra = "") {
    const p = xy(item), selected = state.selected?.type === type && String(state.selected.id) === String(item.id);
    return `<button class="gpon-marker is-${type} ${extra} ${selected ? "is-selected" : ""}" type="button" style="left:${p.x}px;top:${p.y}px" data-type="${type}" data-id="${esc(item.id)}" aria-label="${esc(label)}">
      ${icon(iconName)}<span class="gpon-marker-label">${esc(label)}</span></button>`;
  }

  function renderMarkers() {
    const out = [];
    if (state.layers.pops) pops().filter(coord).forEach((p) => out.push(marker("pop", p, p.nome || p.name || p.id, "topology", statusOnline(NOC.popStatus(p.id)) ? "" : "is-critical")));
    if (state.layers.boxes) boxes().filter(coord).forEach((b) => out.push(marker("box", b, b.name, "port", statusOnline(b.status) ? "" : "is-offline")));
    if (state.layers.clients) visibleClients().filter(coord).forEach((c) => out.push(marker("client", c, c.name, "user", clientAlert(c) ? "is-critical" : "")));
    $("#gponMarkers").innerHTML = out.join("");
    $$('.gpon-marker', $("#gponMarkers")).forEach((el) => el.onclick = (e) => { e.stopPropagation(); select(el.dataset.type, el.dataset.id); });
  }

  function fit() {
    const points = [
      ...(state.layers.clients ? visibleClients().filter(coord) : []),
      ...(state.layers.boxes ? boxes().filter(coord) : []),
      ...(state.layers.pops ? pops().filter(coord) : []),
    ].map((p) => GEO.project(p.lat, p.lon));
    const rect = $("#gponMap").getBoundingClientRect(); if (!rect.width) return;
    if (!points.length) points.push(GEO.project(-23.96, -46.33));
    const minX = Math.min(...points.map((p) => p.x)), maxX = Math.max(...points.map((p) => p.x));
    const minY = Math.min(...points.map((p) => p.y)), maxY = Math.max(...points.map((p) => p.y));
    const dx = maxX - minX, dy = maxY - minY, pad = 90;
    let k = dx || dy ? Math.min((rect.width - pad * 2) / Math.max(dx, 1e-9), (rect.height - pad * 2) / Math.max(dy, 1e-9)) : 2 ** 15;
    k = GEO.clamp(k, 2 ** 4, 2 ** 18);
    state.map = { k, ox: (minX + maxX) / 2 * k - rect.width / 2, oy: (minY + maxY) / 2 * k - rect.height / 2 };
    state.fitted = true;
    renderMap();
  }

  function zoom(factor, cx, cy) {
    const rect = $("#gponMap").getBoundingClientRect(), x = cx ?? rect.width / 2, y = cy ?? rect.height / 2;
    const old = state.map.k, k = GEO.clamp(old * factor, 2 ** 3, 2 ** 19); if (old === k) return;
    const mx = (x + state.map.ox) / old, my = (y + state.map.oy) / old;
    state.map = { k, ox: mx * k - x, oy: my * k - y }; renderMap();
  }

  function bindMap() {
    const stage = $("#gponMap");
    stage.addEventListener("wheel", (e) => { e.preventDefault(); const r = stage.getBoundingClientRect(); zoom(e.deltaY < 0 ? 1.35 : 1 / 1.35, e.clientX - r.left, e.clientY - r.top); }, { passive: false });
    stage.addEventListener("pointerdown", (e) => { if (e.button !== 0 || e.target.closest("button")) return; state.dragging = { x: e.clientX, y: e.clientY, ox: state.map.ox, oy: state.map.oy }; stage.setPointerCapture(e.pointerId); stage.classList.add("is-panning"); });
    stage.addEventListener("pointermove", (e) => { if (!state.dragging) return; state.map.ox = state.dragging.ox - (e.clientX - state.dragging.x); state.map.oy = state.dragging.oy - (e.clientY - state.dragging.y); renderMap(); });
    const end = () => { state.dragging = null; stage.classList.remove("is-panning"); };
    stage.addEventListener("pointerup", end); stage.addEventListener("pointercancel", end);
    stage.addEventListener("keydown", (e) => { const step = 80; if (e.key === "+" || e.key === "=") zoom(2); else if (e.key === "-") zoom(.5); else if (e.key === "0") fit(); else if (e.key.startsWith("Arrow")) { e.preventDefault(); state.map.ox += e.key === "ArrowRight" ? step : e.key === "ArrowLeft" ? -step : 0; state.map.oy += e.key === "ArrowDown" ? step : e.key === "ArrowUp" ? -step : 0; renderMap(); } });
  }

  function select(type, id, focus = false) {
    state.selected = { type, id };
    renderMap(); renderDetail();
    if (focus) {
      const item = type === "client" ? clients().find((c) => String(c.id) === String(id)) : type === "box" ? boxById(id) : popById(id);
      if (coord(item)) { const p = GEO.project(item.lat, item.lon), r = $("#gponMap").getBoundingClientRect(); state.map.ox = p.x * state.map.k - r.width / 2; state.map.oy = p.y * state.map.k - r.height / 2; renderMap(); }
    }
  }

  function derivedPath(c) {
    const hops = [];
    const add = (kind, name, detail) => hops.push({ kind, name, detail });
    add("client", c.name, `${c.username || c.serial || "ONU"}${c.ip ? ` • ${c.ip}` : ""}`);
    const box = boxById(c.box_id); if (box) add("box", box.name, `${box.type}${box.address ? ` • ${box.address}` : ""}`);
    const olt = deviceById(c.olt_id); if (olt) add("olt", olt.nome, `${c.pon || "PON não informada"} • ${olt.modelo || olt.categoria || "OLT"}`);
    else if (c.olt_id) add("olt", c.olt_id, c.pon || "PON não informada");

    if (Array.isArray(c.path) && c.path.length) {
      c.path.forEach((h) => typeof h === "string" ? add("network", h, "") : add(h.type || h.tipo || "network", h.name || h.nome || h.id || "Elemento de rede", h.detail || h.detalhe || h.port || h.porta || ""));
      return hops;
    }
    if (!olt) return hops;
    const graph = new Map();
    const join = (a, b, cx) => { if (!graph.has(a)) graph.set(a, []); graph.get(a).push({ id: b, cx }); };
    (state.topology.conexoes || []).forEach((cx) => { join(cx.origem, cx.destino, cx); join(cx.destino, cx.origem, cx); });
    const target = (e) => e && e.id !== olt.id && (/núcleo|bgp|core/i.test(`${e.categoria} ${e.nome}`) || e.id === "f1a");
    const queue = [{ id: olt.id, route: [] }], seen = new Set([olt.id]); let found = [];
    while (queue.length) { const cur = queue.shift(); const e = deviceById(cur.id); if (target(e)) { found = cur.route; break; } for (const edge of graph.get(cur.id) || []) if (!seen.has(edge.id)) { seen.add(edge.id); queue.push({ id: edge.id, route: [...cur.route, edge] }); } }
    found.forEach(({ id, cx }) => { const e = deviceById(id); const port = cx.origem === id ? cx.portaOrigem : cx.portaDestino; add("network", e?.nome || id, `${e?.categoria || "Rede"}${port ? ` • porta ${port}` : ""}`); });
    return hops;
  }

  function renderDetail() {
    const host = $("#gponDetail"), sel = state.selected;
    if (!sel) return;
    if (sel.type === "client") {
      const c = clients().find((x) => String(x.id) === String(sel.id)); if (!c) return;
      const path = derivedPath(c), status = clientAlert(c) ? (!statusOnline(c.status) ? "Offline" : "Sinal crítico") : "Online";
      host.innerHTML = `<div class="gpon-detail-head"><span class="badge ${clientAlert(c) ? "badge-danger" : "badge-ok"}">${esc(status)}</span><h2>${esc(c.name)}</h2><p class="muted">${esc(c.address || "Localização textual não informada")}</p></div>
        <div class="gpon-detail-grid">
          <div><span>Usuário</span><b>${esc(c.username || "—")}</b></div><div><span>Serial ONU</span><b class="mono">${esc(c.serial || "—")}</b></div>
          <div><span>OLT</span><b>${esc(deviceById(c.olt_id)?.nome || c.olt_id || "—")}</b></div><div><span>PON</span><b class="mono">${esc(c.pon || "—")}</b></div>
          <div><span>RX óptico</span><b>${c.rx_power === null ? "—" : `${esc(c.rx_power)} dBm`}</b></div><div><span>VLAN / IP</span><b>${esc([c.vlan, c.ip].filter(Boolean).join(" • ") || "—")}</b></div>
          <div><span>Caixa / CTO</span><b>${esc(boxById(c.box_id)?.name || c.box_id || "—")}</b></div><div><span>Drop</span><b>${c.drop_path?.length ? `${c.drop_path.length} pontos` : boxById(c.box_id) ? "Ligação direta cadastrada" : "Sem traçado"}</b></div>
        </div>
        <b style="font-size:var(--fs-12)">Conexão ponta a ponta</b>
        <div class="gpon-path">${path.map((h) => `<div class="gpon-hop"><i class="gpon-hop-dot"></i><div><b>${esc(h.name)}</b><small>${esc(h.detail || h.kind)}</small></div></div>`).join("")}</div>`;
    } else if (sel.type === "box") {
      const b = boxById(sel.id); if (!b) return; const linked = clients().filter((c) => String(c.box_id) === String(b.id));
      host.innerHTML = `<div class="gpon-detail-head"><span class="badge">${esc(b.type)}</span><h2>${esc(b.name)}</h2><p class="muted">${esc(b.address || "Endereço não informado")}</p></div>
        <div class="gpon-detail-grid"><div><span>Estado</span><b>${esc(b.status)}</b></div><div><span>Clientes</span><b>${linked.length}</b></div><div><span>POP</span><b>${esc(popById(b.pop_id)?.nome || b.pop_id || "—")}</b></div><div><span>Coordenadas</span><b class="mono">${coord(b) ? esc(GEO.label(b.lat,b.lon)) : "—"}</b></div></div>
        <b style="font-size:var(--fs-12)">Clientes atendidos</b><div class="stack" style="margin-top:8px">${linked.map((c) => `<button class="btn btn-sm btn-block" data-client="${esc(c.id)}" type="button">${esc(c.name)}</button>`).join("") || '<p class="muted">Nenhum cliente vinculado.</p>'}</div>`;
      $$('[data-client]', host).forEach((el) => el.onclick = () => select("client", el.dataset.client, true));
    } else {
      const p = popById(sel.id); if (!p) return; const list = devices().filter((e) => popOfDevice(e)?.id === p.id);
      host.innerHTML = `<div class="gpon-detail-head"><span class="badge badge-ok">POP</span><h2>${esc(p.nome || p.id)}</h2><p class="muted">${esc(p.endereco || p.local || "Endereço não informado")}</p></div>
        <div class="gpon-detail-grid"><div><span>Estado</span><b>${esc(NOC.popStatus(p.id))}</b></div><div><span>Equipamentos</span><b>${list.length}</b></div><div><span>Clientes GPON</span><b>${clients().filter((c) => popOfClient(c)?.id === p.id).length}</b></div><div><span>Coordenadas</span><b class="mono">${esc(GEO.label(p.lat,p.lon) || "—")}</b></div></div>
        <b style="font-size:var(--fs-12)">SW, OLT e demais aparelhos</b><div class="gpon-path">${list.map((e) => `<div class="gpon-hop"><i class="gpon-hop-dot"></i><div><b>${esc(e.nome)}</b><small>${esc(`${e.categoria || "Equipamento"} • ${NOC.statusInfo(e).label}`)}</small></div></div>`).join("") || '<p class="muted">Nenhum equipamento vinculado a este POP.</p>'}</div>`;
    }
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", mount); else mount();
})();
