/* ============================================================
   UPDOWN NOC — Mapa GPON operacional (somente leitura)
   Une topologia documentada + estado monitorado + clientes da OLT.

   A base pode passar de dezenas de milhares de ONUs. Três decisões
   sustentam a fluidez da tela nesse volume:

   1. Índices (Map) e linhas pré-calculadas no carregamento — nenhum
      `find` linear dentro de laço de desenho.
   2. Recorte por viewport + agrupamento em tela: o DOM nunca recebe
      mais do que algumas centenas de nós, independente da base.
   3. Um desenho por quadro (requestAnimationFrame): arrastar o mapa
      dispara centenas de eventos por segundo, e antes cada um deles
      repintava o mapa inteiro de forma síncrona.
   ============================================================ */
(() => {
  "use strict";
  const { $, $$, esc, icon, toast } = UI;

  const LIST_CHUNK = 60;      // clientes por página da lista lateral
  const PAGE_SIZE = 250;      // linhas por página da tabela
  const SOLO_MAX = 280;       // acima disso os clientes viram agrupamentos
  const CLUSTER_PX = 58;      // lado da célula de agrupamento, em px de tela
  const ROUTE_MAX = 600;      // teto de drops desenhados
  const BOX_MAX = 400;        // teto de caixas desenhadas
  const CULL_MAX = 60000;     // teto de clientes lidos por quadro
  const LABEL_Z = 17;         // zoom a partir do qual o cliente ganha rótulo
  const BOX_LABEL_Z = 16;
  const DROP_Z = 14;          // abaixo disso o traçado do drop é sujeira visual
  const AREA_CELL = 0.02;     // ~2 km: célula da detecção de concentração

  const VIEW_KEY = `updown.gpon.view.${location.pathname}`;
  const FOCUS_KEY = `updown.gpon.focus.${location.pathname}`;
  const SIDE_KEY = `updown.gpon.side.${location.pathname}`;

  const state = {
    topology: { equipamentos: [], conexoes: [], pops: [] },
    feed: { clients: [], boxes: [], alerts: [], configured: false },
    rows: [], boxPoints: [], popPoints: [], areas: [], alerts: [],
    idx: { device: new Map(), box: new Map(), pop: new Map(), client: new Map(), popOfDevice: new Map() },
    query: "", status: "all", focus: "auto", sideTab: "clients", listLimit: LIST_CHUNK,
    baseCache: null, cache: null, sorted: null,
    selected: null, layers: { clients: true, boxes: true, pops: true, drops: true },
    map: { k: 2 ** 12, ox: 0, oy: 0 }, basemap: null, dragging: null, fitted: false,
    frame: 0, view: "map", page: 0, searchTimer: 0,
    revision: null, checkedAt: null, historyToken: 0,
  };

  const nb = (v) => Number(v || 0).toLocaleString("pt-BR");

  /* "há 8 s" diz na hora se a coleta está no ritmo prometido; um carimbo de
     data completo obriga o operador a fazer a conta de cabeça. */
  function relativo(iso) {
    const instante = Date.parse(String(iso || ""));
    if (!Number.isFinite(instante)) return "—";
    const s = Math.max(0, Math.round((Date.now() - instante) / 1000));
    if (s < 60) return `há ${s}s`;
    if (s < 3600) return `há ${Math.round(s / 60)}min`;
    if (s < 86400) return `há ${Math.round(s / 3600)}h`;
    return new Date(instante).toLocaleString("pt-BR");
  }
  const short = (n) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1).replace(".0", "")}k` : String(n));

  /* 0°,0° é o "sem GPS" de todo cadastro que grava zero em vez de vazio.
     Aceitar a ilha nula colocava um punhado de clientes no Atlântico, e o
     enquadramento — que precisa conter todos os pontos — abria o mapa no
     oceano em vez da concentração real de clientes. */
  const NULL_ISLAND = 0.4;
  const hasCoord = (o) => !!o && GEO.isCoord(o.lat, o.lon) &&
    !(Math.abs(Number(o.lat)) < NULL_ISLAND && Math.abs(Number(o.lon)) < NULL_ISLAND);

  const statusOnline = (s) => !/offline|down|los|inativo|critical|critico|falha/i.test(String(s || "online"));
  const signalCritical = (c) => Number.isFinite(Number(c.rx_power)) && Number(c.rx_power) <= -27;

  const devices = () => state.topology.equipamentos || [];
  const clients = () => state.feed.clients || [];
  const boxes = () => state.feed.boxes || [];
  const pops = () => state.topology.pops || [];
  const deviceById = (id) => state.idx.device.get(String(id)) || null;
  const boxById = (id) => state.idx.box.get(String(id)) || null;
  const popById = (id) => state.idx.pop.get(String(id)) || null;
  const rowById = (id) => state.idx.client.get(String(id)) || null;
  const clientById = (id) => rowById(id)?.c || null;

  /* NOC.suggestPop normaliza nomes de POP a cada chamada; com um equipamento
     por cliente isso reaparecia dezenas de milhares de vezes por desenho. */
  function popOfDevice(e) {
    if (!e) return null;
    const key = String(e.id);
    if (state.idx.popOfDevice.has(key)) return state.idx.popOfDevice.get(key);
    const pop = popById(e.popId || NOC.suggestPop(e));
    state.idx.popOfDevice.set(key, pop);
    return pop;
  }
  const popOfClient = (c) => popOfDevice(deviceById(c.olt_id));

  /* ---------------- índice e linhas pré-calculadas ---------------- */

  function toRow(c) {
    const off = !statusOnline(c.status);
    const low = signalCritical(c);
    const located = hasCoord(c);
    const p = located ? GEO.project(c.lat, c.lon) : null;
    return {
      c, id: c.id, name: c.name || "Cliente sem nome",
      off, low, alert: off || low, located,
      lat: Number(c.lat), lon: Number(c.lon),
      px: p ? p.x : 0, py: p ? p.y : 0,
      search: [c.name, c.username, c.serial, c.onu_index, c.olt_id, c.pon, c.address, c.ip]
        .filter(Boolean).join(" ").toLowerCase(),
    };
  }

  const point = (o, id, name) => {
    const p = GEO.project(o.lat, o.lon);
    return { ref: o, id, name, lat: Number(o.lat), lon: Number(o.lon), px: p.x, py: p.y };
  };

  function indexData() {
    const idx = state.idx;
    idx.device = new Map(devices().map((e) => [String(e.id), e]));
    idx.pop = new Map(pops().map((p) => [String(p.id), p]));
    idx.box = new Map(boxes().map((b) => [String(b.id), b]));
    idx.popOfDevice = new Map();
    state.rows = clients().map(toRow);
    idx.client = new Map(state.rows.map((r) => [String(r.id), r]));
    state.popPoints = pops().filter(hasCoord).map((p) => point(p, p.id, p.nome || p.name || p.id));
    state.boxPoints = boxes().filter(hasCoord).map((b) => point(b, b.id, b.name || b.id));
    state.areas = computeAreas();
    state.alerts = computeAlerts();
    invalidate();
  }

  function invalidate() { state.baseCache = null; state.cache = null; state.sorted = null; }

  /* ---------------- concentrações de clientes ----------------
     O enquadramento "tudo na tela" só serve quando a base é homogênea. Numa
     operação real a massa fica concentrada em torno de um POP e alguns
     cadastros isolados (ou errados) ficam a centenas de quilômetros: a caixa
     que contém todo mundo abre o mapa em escala estadual, com a região que
     interessa reduzida a um borrão de dois pixels.

     Aqui os clientes localizados são jogados numa grade de ~2 km, as células
     vizinhas são unidas em componentes conexos e cada componente vira uma
     área de foco nomeada pelo POP mais próximo (ou pelo bairro que mais
     aparece nos endereços). A maior delas é o enquadramento padrão. */
  function computeAreas() {
    const located = state.rows.filter((r) => r.located);
    if (located.length < 4) return [];
    const grid = new Map();
    for (const r of located) {
      const key = `${Math.floor(r.lon / AREA_CELL)}:${Math.floor(r.lat / AREA_CELL)}`;
      let cell = grid.get(key);
      if (!cell) grid.set(key, cell = []);
      cell.push(r);
    }
    const seen = new Set(), groups = [];
    for (const key of grid.keys()) {
      if (seen.has(key)) continue;
      seen.add(key);
      const queue = [key], items = [];
      while (queue.length) {
        const cur = queue.pop();
        for (const r of grid.get(cur)) items.push(r);
        const [gx, gy] = cur.split(":").map(Number);
        for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
          const nk = `${gx + dx}:${gy + dy}`;
          if (grid.has(nk) && !seen.has(nk)) { seen.add(nk); queue.push(nk); }
        }
      }
      groups.push(items);
    }
    groups.sort((a, b) => b.length - a.length);
    const minimo = Math.max(4, Math.round(located.length * 0.01));
    return groups.filter((g) => g.length >= minimo).slice(0, 12).map(makeArea);
  }

  function makeArea(items, i) {
    let minLat = Infinity, maxLat = -Infinity, minLon = Infinity, maxLon = -Infinity, alerts = 0;
    for (const r of items) {
      if (r.lat < minLat) minLat = r.lat;
      if (r.lat > maxLat) maxLat = r.lat;
      if (r.lon < minLon) minLon = r.lon;
      if (r.lon > maxLon) maxLon = r.lon;
      if (r.alert) alerts++;
    }
    const area = {
      id: `area-${i}`, count: items.length, alerts,
      minLat, maxLat, minLon, maxLon,
      lat: (minLat + maxLat) / 2, lon: (minLon + maxLon) / 2,
    };
    const pop = nearestPop(area.lat, area.lon);
    area.name = (pop && pop.km <= 7 ? pop.name : null) || frequentLabel(items) || `Concentração ${i + 1}`;
    return area;
  }

  /* Distância suficiente para "qual POP fica perto": equirretangular, sem
     trigonometria por ponto. */
  function km(aLat, aLon, bLat, bLon) {
    const x = (aLon - bLon) * Math.cos((aLat + bLat) * Math.PI / 360) * 111.32;
    return Math.hypot(x, (aLat - bLat) * 110.57);
  }
  function nearestPop(lat, lon) {
    let best = null;
    for (const p of state.popPoints) {
      const d = km(lat, lon, p.lat, p.lon);
      if (!best || d < best.km) best = { name: p.name, km: d };
    }
    return best;
  }

  const STOP = new Set(("rua,r,av,avenida,alameda,al,travessa,tv,praca,estrada,rod,rodovia,via,num,numero," +
    "casa,apto,ap,bloco,bl,qd,quadra,lote,sem,cep,brasil,com,fundos,null,undefined").split(","));
  const semAcento = (v) => String(v || "").normalize("NFD").replace(/[̀-ͯ]/g, "");
  const titulo = (v) => v.toLowerCase().replace(/(^|\s)\S/g, (m) => m.toUpperCase());

  /* Nome do bairro a partir dos endereços: o bigrama mais repetido ganha de um
     token solto, para "Vila Natal" não virar só "Natal". */
  function frequentLabel(items) {
    const uni = new Map(), bi = new Map();
    const step = Math.max(1, Math.floor(items.length / 400));
    let amostras = 0;
    for (let i = 0; i < items.length; i += step) {
      const raw = items[i].c.address || "";
      if (!raw) continue;
      amostras++;
      const toks = semAcento(raw).toUpperCase().split(/[^A-Z0-9]+/)
        .filter((t) => t.length > 2 && !/^\d/.test(t) && !STOP.has(t.toLowerCase()));
      const vistos = new Set();
      toks.forEach((t, j) => {
        if (!vistos.has(t)) { vistos.add(t); uni.set(t, (uni.get(t) || 0) + 1); }
        if (j + 1 < toks.length) {
          const b = `${t} ${toks[j + 1]}`;
          bi.set(b, (bi.get(b) || 0) + 1);
        }
      });
    }
    if (!amostras) return null;
    const topo = (m) => [...m.entries()].sort((a, b) => b[1] - a[1])[0];
    const tb = topo(bi), tu = topo(uni);
    if (tb && tb[1] >= amostras * 0.3) return titulo(tb[0]);
    if (tu && tu[1] >= amostras * 0.3) return titulo(tu[0]);
    return null;
  }

  const areaById = (id) => state.areas.find((a) => a.id === id) || null;
  function currentArea() {
    if (state.focus === "all" || !state.areas.length) return null;
    if (state.focus === "auto") return state.areas[0];
    return areaById(state.focus) || state.areas[0];
  }
  const inArea = (r, a) => r.lat >= a.minLat && r.lat <= a.maxLat && r.lon >= a.minLon && r.lon <= a.maxLon;

  /* ---------------- filtros ---------------- */

  /* Busca e foco: a base dos contadores dos chips de estado. Um cliente sem
     coordenada não pertence a área nenhuma; ele fica sempre na lista, que é o
     único lugar onde pode ser consultado. */
  function baseRows() {
    if (state.baseCache) return state.baseCache;
    const q = state.query, area = currentArea();
    let out = state.rows;
    if (q) out = out.filter((r) => r.search.includes(q));
    if (area) out = out.filter((r) => !r.located || inArea(r, area));
    return (state.baseCache = out);
  }

  function filtered() {
    if (state.cache) return state.cache;
    const st = state.status;
    const base = baseRows();
    const out = st === "all" ? base
      : st === "online" ? base.filter((r) => !r.alert)
      : st === "offline" ? base.filter((r) => r.off)
      : st === "signal" ? base.filter((r) => r.low)
      : base.filter((r) => !r.located);
    return (state.cache = out);
  }

  /* Ordenado por X do mundo: o recorte por viewport vira busca binária. */
  function sortedVisible() {
    if (!state.sorted) state.sorted = filtered().filter((r) => r.located).slice().sort((a, b) => a.px - b.px);
    return state.sorted;
  }

  function lowerBound(arr, v) {
    let lo = 0, hi = arr.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (arr[m].px < v) lo = m + 1; else hi = m; }
    return lo;
  }

  function cull(wx0, wx1, wy0, wy1) {
    const arr = sortedVisible(), out = [];
    for (let i = lowerBound(arr, wx0); i < arr.length && arr[i].px <= wx1; i++) {
      const r = arr[i];
      if (r.py >= wy0 && r.py <= wy1) { out.push(r); if (out.length >= CULL_MAX) break; }
    }
    return out;
  }

  /* ---------------- montagem ---------------- */

  function mount() {
    UI.mountShell({ search: () => state.rows.slice(0, 2000).map((r) => ({
      label: r.name, meta: `${r.c.serial || "Sem serial"} • ${r.c.olt_id || "OLT não informada"}`,
      icon: "user", action: () => { setView("map"); requestAnimationFrame(() => select("client", r.id, true)); },
    })) });

    if ($("#tabIcon")) $("#tabIcon").innerHTML = icon("pops");
    $("#searchIcon").innerHTML = icon("search");
    if ($("#listSearchIcon")) $("#listSearchIcon").innerHTML = icon("search");
    if ($("#detailIcon")) $("#detailIcon").innerHTML = icon("topology");
    $("#refreshMap").innerHTML = `${icon("refresh")} Atualizar`;
    if ($("#dashRefresh")) $("#dashRefresh").innerHTML = `${icon("refresh")} Atualizar`;
    $("#mapZoomOut").innerHTML = icon("zoomOut");
    $("#mapZoomIn").innerHTML = icon("zoomIn");
    $("#mapFit").innerHTML = icon("fit");
    if ($("#mapSearchClear")) $("#mapSearchClear").innerHTML = icon("close");
    if ($("#listSearchClear")) $("#listSearchClear").innerHTML = icon("close");
    if ($("#sideToggle")) $("#sideToggle").innerHTML = icon("chevronLeft");
    $$("[data-layer]").forEach((el) => {
      el.innerHTML = `${icon(el.dataset.layerIcon || "circle")}<span>${esc(el.dataset.layerLabel || el.dataset.layer)}</span>`;
    });

    $("#refreshMap").onclick = () => load(true);
    if ($("#dashRefresh")) $("#dashRefresh").onclick = () => load(true);
    $("#mapZoomIn").onclick = () => zoom(2);
    $("#mapZoomOut").onclick = () => zoom(.5);
    $("#mapFit").onclick = () => { state.fitted = false; fit(); };

    const updateQuery = (value, imediato) => {
      if ($("#mapSearch") && $("#mapSearch").value !== value) $("#mapSearch").value = value;
      if ($("#gponListSearch") && $("#gponListSearch").value !== value) $("#gponListSearch").value = value;
      if ($("#mapSearchClear")) $("#mapSearchClear").hidden = !value;
      if ($("#listSearchClear")) $("#listSearchClear").hidden = !value;
      clearTimeout(state.searchTimer);
      /* A base pode ter dezenas de milhares de linhas: filtrar a cada tecla
         travava a digitação. */
      const aplicar = () => {
        state.query = value.trim().toLowerCase();
        state.page = 0; state.listLimit = LIST_CHUNK;
        invalidate();
        renderFilters(); renderClientList(); renderTable(); scheduleMap();
      };
      if (imediato) aplicar(); else state.searchTimer = setTimeout(aplicar, 180);
    };
    $("#mapSearch").oninput = (e) => updateQuery(e.target.value);
    if ($("#gponListSearch")) $("#gponListSearch").oninput = (e) => updateQuery(e.target.value);
    if ($("#mapSearchClear")) $("#mapSearchClear").onclick = () => { updateQuery("", true); $("#mapSearch").focus(); };
    if ($("#listSearchClear")) $("#listSearchClear").onclick = () => { updateQuery("", true); $("#gponListSearch").focus(); };

    $$("[data-gpon-view]").forEach((el) => el.onclick = () => setView(el.dataset.gponView));
    if ($("#gponPrevPage")) $("#gponPrevPage").onclick = () => { state.page = Math.max(0, state.page - 1); renderTable(); };
    if ($("#gponNextPage")) $("#gponNextPage").onclick = () => { state.page += 1; renderTable(); };

    $$("[data-layer]").forEach((el) => el.onclick = () => {
      const on = el.getAttribute("aria-pressed") !== "true";
      el.setAttribute("aria-pressed", String(on));
      state.layers[el.dataset.layer] = on;
      scheduleMap();
    });
    $$("[data-status]").forEach((el) => el.onclick = () => {
      state.status = el.dataset.status;
      state.listLimit = LIST_CHUNK; state.page = 0;
      state.cache = null; state.sorted = null;
      renderFilters(); renderClientList(); renderTable(); scheduleMap();
    });
    $$("[data-side-tab]").forEach((el) => el.onclick = () => { state.sideTab = el.dataset.sideTab; renderSideTabs(); });
    if ($("#gponFocus")) $("#gponFocus").onchange = (e) => setFocus(e.target.value);
    if ($("#sideToggle")) $("#sideToggle").onclick = () => toggleSide();

    /* Delegação: com agrupamentos o mapa troca de conteúdo a cada quadro, e
       religar um ouvinte por marcador custava mais que o próprio desenho. */
    $("#gponMarkers").addEventListener("click", (e) => {
      const cluster = e.target.closest("[data-cluster-x]");
      if (cluster) { e.stopPropagation(); zoomTo(Number(cluster.dataset.clusterX), Number(cluster.dataset.clusterY)); return; }
      const marker = e.target.closest(".gpon-marker");
      if (marker) { e.stopPropagation(); select(marker.dataset.type, marker.dataset.id); }
    });
    $("#clientList").addEventListener("click", (e) => {
      const row = e.target.closest("[data-client-row]");
      if (row) select("client", row.dataset.clientRow, true);
    });
    $("#alertsList").addEventListener("click", (e) => {
      const row = e.target.closest("[data-alert]");
      if (!row) return;
      const a = state.alerts[Number(row.dataset.alert)];
      if (a && a.client_id) select("client", a.client_id, true);
    });

    bindMap();
    /* O primeiro enquadramento não pode depender de requestAnimationFrame: no
       carregamento a aba pode nem estar sendo pintada, e o quadro nunca vem —
       o mapa ficava parado no canto do mundo, sem nenhum cliente à vista. O
       ResizeObserver é o sinal confiável de que a área já tem tamanho. */
    let resizeFrame = 0;
    new ResizeObserver(() => {
      if (!state.fitted) { fit(); return; }
      if (resizeFrame) return;
      resizeFrame = requestAnimationFrame(() => { resizeFrame = 0; renderMap(); });
    }).observe($("#gponMap"));

    try {
      const saved = localStorage.getItem(VIEW_KEY);
      if (saved === "map" || saved === "list" || saved === "dash") state.view = saved;
      const focus = localStorage.getItem(FOCUS_KEY);
      if (focus) state.focus = focus;
      if (localStorage.getItem(SIDE_KEY) === "off") toggleSide(true);
    } catch { /* modo privado */ }

    applyView(false);
    load(false);
    setInterval(refreshIfChanged, 10000);
  }

  function toggleSide(forceOff) {
    const shell = $(".gpon-workspace");
    const off = forceOff === true ? true : !shell.classList.contains("side-off");
    shell.classList.toggle("side-off", off);
    try { localStorage.setItem(SIDE_KEY, off ? "off" : "on"); } catch { /* modo privado */ }
    const b = $("#sideToggle");
    if (b) {
      b.innerHTML = icon(off ? "chevronRight" : "chevronLeft");
      b.setAttribute("aria-label", off ? "Mostrar painel lateral" : "Recolher painel lateral");
      b.setAttribute("aria-expanded", String(!off));
    }
    scheduleMap();
  }

  function setFocus(value) {
    state.focus = value;
    try { localStorage.setItem(FOCUS_KEY, value); } catch { /* modo privado */ }
    state.listLimit = LIST_CHUNK; state.page = 0;
    invalidate();
    renderFocusOptions(); renderFilters(); renderClientList(); renderTable();
    state.fitted = false;
    fit();
  }

  /* ---------------- carga ---------------- */

  async function refreshIfChanged() {
    if (document.visibilityState === "hidden") return;   // aba de fundo não consulta
    if (!state.feed.configured) return load(false);
    try {
      const revision = await NOC.api("/api/gpon/revision");
      state.checkedAt = revision.updated_at || state.checkedAt;
      /* Versão nova é cadastro novo — cliente que entrou, caixa que mudou de
         lugar — e daí não tem como escapar de reler o snapshot inteiro. Só o
         synced_at ter andado significa que mudou estado, e estado cabe numa
         fração do peso: essa é a resposta comum do ciclo de 10 s, e baixar
         megabytes de nome e endereço para descobrir que três ONUs caíram era o
         que impedia a tela de acompanhar a coleta nesse ritmo. */
      if (revision.version && state.revision && revision.version !== state.revision) return load(false);
      if (revision.synced_at && revision.synced_at !== state.feed.synced_at) return patchStatus();
      renderSource();
    } catch { /* a próxima volta tenta de novo */ }
  }

  /* Aplica o estado novo sobre os clientes já indexados. Nenhuma coordenada é
     reprojetada e nenhum índice é refeito: só os campos que a coleta observa e
     as marcas derivadas deles. */
  async function patchStatus() {
    let delta;
    try { delta = await NOC.api("/api/gpon/status"); }
    catch { return; }
    if (!Array.isArray(delta.clients)) return;
    let mudou = 0;
    for (const linha of delta.clients) {
      const row = state.idx.client.get(String(linha.id));
      if (!row) continue;
      const c = row.c;
      if (c.status === linha.status && c.state_detail === linha.state_detail &&
          c.rx_power === linha.rx_power && c.tx_power === linha.tx_power) continue;
      c.status = linha.status; c.state_detail = linha.state_detail;
      c.rx_power = linha.rx_power; c.tx_power = linha.tx_power;
      row.off = !statusOnline(c.status);
      row.low = signalCritical(c);
      row.alert = row.off || row.low;
      mudou += 1;
    }
    state.feed.synced_at = delta.synced_at || state.feed.synced_at;
    if (delta.version) state.revision = delta.version;
    if (!mudou) return renderSource();
    state.alerts = computeAlerts();
    invalidate();
    render();
  }

  async function load(manual) {
    const button = $("#refreshMap");
    button.disabled = true;
    const [top, feed, revision] = await Promise.allSettled([
      NOC.load(), NOC.api("/api/gpon/clients"), NOC.api("/api/gpon/revision")]);
    if (top.status === "fulfilled") state.topology = top.value;
    else NOC.errorState($("#gponDetail"), top.reason, () => load(true));
    /* A versão que acompanha este snapshot é o que permite ao ciclo de 10 s
       decidir entre reler tudo e aplicar só o delta de estado. */
    if (revision.status === "fulfilled") {
      state.revision = revision.value?.version || state.revision;
      state.checkedAt = revision.value?.updated_at || state.checkedAt;
    }
    state.feed = feed.status === "fulfilled" ? feed.value : {
      configured: true, unavailable: true, clients: [], boxes: [], alerts: [],
      message: "A fonte da OLT não respondeu nesta atualização.",
    };
    button.disabled = false;
    indexData();
    render();
    /* Só o primeiro carregamento enquadra. A atualização de 10 s recolocava a
       câmera na origem a cada ciclo: quem estava investigando um cliente
       perdia o zoom sozinho, sem ter tocado em nada. */
    if (state.view === "map" && !state.fitted) fit();
    if (manual) toast("Mapa atualizado", { type: feed.status === "fulfilled" ? "ok" : "warn",
      text: feed.status === "fulfilled" ? "Topologia e clientes foram recarregados." : "A topologia abriu, mas a fonte da OLT não respondeu." });
  }

  function render() {
    renderSource(); renderKpis(); renderFocusOptions(); renderFilters();
    renderClientList(); renderAlerts(); renderSideTabs(); renderTable(); renderMap(); renderDetail();
  }

  function setView(view) {
    if (!["map", "list", "dash"].includes(view)) return;
    state.view = view;
    try { localStorage.setItem(VIEW_KEY, view); } catch { /* modo privado */ }
    applyView(true);
  }

  function applyView(focus) {
    const mapView = $("#gponMapView"), listView = $("#gponListView"), dashView = $("#gponDashView");
    if (!listView) return;
    mapView.hidden = state.view !== "map";
    listView.hidden = state.view !== "list";
    if (dashView) dashView.hidden = state.view !== "dash";
    $$("[data-gpon-view]").forEach((el) => el.setAttribute("aria-pressed", String(el.dataset.gponView === state.view)));
    if (state.view === "map") { if (state.fitted) renderMap(); else fit(); }
    else if (state.view === "list" && focus) $("#gponListSearch")?.focus();
  }

  /* ---------------- cabeçalho e indicadores ---------------- */

  function renderSource() {
    const f = state.feed;
    const badge = $("#sourceBadge");
    badge.className = `badge ${f.unavailable ? "badge-danger" : f.configured ? "badge-ok" : "badge-warn"}`;
    badge.textContent = f.unavailable ? "Fonte OLT indisponível" : f.configured ? `Fonte: ${f.source || "OLT"}` : "Fonte OLT não configurada";
    /* Dois instantes diferentes, e a diferença importa numa madrugada calma:
       "atualizado" é quando o estado mudou pela última vez, "verificado" é
       quando a coleta passou por aqui pela última vez. Só o primeiro deixava
       o telão parecer travado depois de meia hora de rede estável. */
    const sync = $("#syncTime");
    sync.textContent = f.synced_at ? `Alteração ${relativo(f.synced_at)}` : "Sem sincronização da OLT";
    sync.title = [f.synced_at ? `Última alteração de estado: ${new Date(f.synced_at).toLocaleString("pt-BR")}` : "",
      state.checkedAt ? `Última verificação da coleta: ${new Date(state.checkedAt).toLocaleString("pt-BR")}` : ""]
      .filter(Boolean).join(" • ");
    const message = $("#mapMessage");
    const semLocal = state.rows.length - state.rows.filter((r) => r.located).length;
    message.hidden = false;
    if (f.message) {
      message.className = "gpon-map-message";
      message.textContent = f.message;
    } else if (semLocal) {
      message.className = "gpon-map-message is-action";
      message.innerHTML = `<span class="gpon-map-msg-icon">${icon("alert")}</span>
        <span class="gpon-map-msg-text"><b>${nb(semLocal)} clientes sem coordenadas</b><small>Faltam latitude/longitude no cadastro para posicioná-los no mapa.</small></span>
        <button class="btn btn-sm btn-primary" id="showNoCoord" type="button">${icon("edit")} Listar para editar</button>`;
      $("#showNoCoord").onclick = () => showNoCoord();
    } else {
      message.hidden = true;
      message.textContent = "";
    }
  }

  /* "Listar para editar": ativa o filtro de clientes sem coordenada e abre a
     aba Lista — a tabela é onde o operador tem serial, OLT, PON e endereço à
     vista para conferir o cadastro que precisa de latitude/longitude. */
  function showNoCoord() {
    state.status = "nocoord";
    state.listLimit = LIST_CHUNK;
    state.page = 0;
    if (state.query) {
      state.query = "";
      if ($("#mapSearch")) $("#mapSearch").value = "";
      if ($("#gponListSearch")) $("#gponListSearch").value = "";
      if ($("#mapSearchClear")) $("#mapSearchClear").hidden = true;
      if ($("#listSearchClear")) $("#listSearchClear").hidden = true;
    }
    state.cache = null; state.sorted = null;
    renderFilters(); renderClientList(); renderTable();
    setView("list");
  }

  function renderKpis() {
    const host = $("#gponKpis");
    if (!host) return;
    const total = state.rows.length;
    const online = state.rows.filter((r) => !r.off).length;
    const located = state.rows.filter((r) => r.located).length;
    const alertas = state.alerts.length;
    const oltIds = new Set(clients().map((c) => c.olt_id).filter(Boolean));
    const items = [
      ["Clientes autenticados", nb(total), `${nb(online)} online`],
      ["ONUs online", nb(online), total ? `${Math.round(online / total * 100)}% da base` : "Aguardando OLT"],
      ["Com localização", nb(located), total ? `${nb(total - located)} sem coordenadas` : "—"],
      ["OLTs em atendimento", nb(oltIds.size), oltIds.size ? [...oltIds].slice(0, 2).join(", ") : "Não informadas"],
      ["Alertas", nb(alertas), alertas ? "Requer atenção" : "Operação normal"],
    ];
    host.innerHTML = items.map(([label, value, small]) =>
      `<div class="gpon-kpi"><span>${esc(label)}</span><strong>${esc(value)}</strong><small>${esc(small)}</small></div>`).join("");
  }

  function computeAlerts() {
    const generated = state.rows.filter((r) => r.alert).map((r) => ({
      id: `client:${r.id}`, client_id: r.id, level: r.off ? "critical" : "warning",
      title: r.off ? `${r.name} offline` : `${r.name} com sinal crítico`,
      detail: r.off ? `${r.c.olt_id || "OLT"} • ${r.c.pon || "PON não informada"}` : `RX ${r.c.rx_power} dBm`,
    }));
    const links = (state.topology.conexoes || []).filter((c) => NOC.linkStatus(c) === "down").map((c, i) => ({
      id: `link:${i}`, level: "critical", title: "Enlace documentado fora do ar",
      detail: `${deviceById(c.origem)?.nome || c.origem} ↔ ${deviceById(c.destino)?.nome || c.destino}`,
    }));
    return [...links, ...generated, ...(state.feed.alerts || [])];
  }

  /* ---------------- painel lateral ---------------- */

  function renderFocusOptions() {
    const select = $("#gponFocus");
    if (!select) return;
    if (state.areas.length && !["all", "auto"].includes(state.focus) && !areaById(state.focus)) state.focus = "auto";
    const maior = state.areas[0];
    select.innerHTML = [
      `<option value="auto">${esc(maior ? `Maior concentração — ${maior.name}` : "Automático")}</option>`,
      ...state.areas.map((a) => `<option value="${esc(a.id)}">${esc(a.name)} — ${nb(a.count)} clientes</option>`),
      `<option value="all">Toda a rede — ${nb(state.rows.filter((r) => r.located).length)} localizados</option>`,
    ].join("");
    select.value = state.focus;
    const hint = $("#focusHint");
    if (hint) {
      const area = currentArea();
      hint.textContent = area
        ? `${area.name} • ${nb(area.count)} clientes • ${nb(area.alerts)} em alerta`
        : "Sem recorte geográfico — o mapa abre com toda a base localizada.";
    }
  }

  function renderFilters() {
    const base = baseRows();
    const counts = { all: base.length, online: 0, offline: 0, signal: 0, nocoord: 0 };
    for (const r of base) {
      if (!r.located) counts.nocoord++;
      if (r.off) counts.offline++;
      else if (r.low) counts.signal++;
      else counts.online++;
    }
    $$("[data-status]").forEach((el) => {
      el.setAttribute("aria-pressed", String(el.dataset.status === state.status));
      const c = el.querySelector(".count");
      if (c) c.textContent = nb(counts[el.dataset.status] ?? 0);
    });
    const total = filtered().length;
    if ($("#clientListCount")) $("#clientListCount").textContent = nb(total);
    if ($("#sideTabClients")) $("#sideTabClients").textContent = nb(total);
  }

  function renderSideTabs() {
    $$("[data-side-tab]").forEach((el) => el.setAttribute("aria-pressed", String(el.dataset.sideTab === state.sideTab)));
    $("#clientList").hidden = state.sideTab !== "clients";
    $("#alertsList").hidden = state.sideTab !== "alerts";
  }

  const rxLabel = (v) => (v === null || v === undefined || v === "" || !Number.isFinite(Number(v)) ? "" : Number(v).toFixed(1));

  function renderClientList() {
    const list = filtered();
    const shown = list.slice(0, state.listLimit);
    const selId = state.selected?.type === "client" ? String(state.selected.id) : null;
    const rows = shown.map((r) => {
      const rx = rxLabel(r.c.rx_power);
      const tone = r.off ? "is-off" : r.low ? "is-low" : "";
      const meta = [r.c.serial || r.c.onu_index || "Sem serial", r.c.olt_id, r.c.pon].filter(Boolean).join(" • ");
      return `<button class="gpon-client-row ${tone}" type="button" data-client-row="${esc(r.id)}"${String(r.id) === selId ? ' aria-current="true"' : ""}>
        <i aria-hidden="true"></i>
        <span class="gpon-client-main"><b>${esc(r.name)}</b><small>${esc(meta)}</small></span>
        <span class="gpon-client-meta">${rx ? `<em>${esc(rx)}</em>` : ""}${r.located ? "" : '<u title="Sem coordenadas no cadastro">s/gps</u>'}</span>
      </button>`;
    }).join("");
    const rest = list.length - shown.length;
    $("#clientList").innerHTML = (rows || `<div class="empty gpon-side-empty"><b>Nenhum cliente</b><p>Ajuste a busca, o estado ou o foco do mapa.</p></div>`)
      + (rest > 0 ? `<button class="gpon-list-more" id="clientMore" type="button">Carregar mais ${nb(Math.min(rest, LIST_CHUNK * 4))} · restam ${nb(rest)}</button>` : "");
    const more = $("#clientMore");
    if (more) more.onclick = () => { state.listLimit += LIST_CHUNK * 4; renderClientList(); };
  }

  function renderAlerts() {
    const alerts = state.alerts;
    if ($("#alertCount")) $("#alertCount").textContent = nb(alerts.length);
    if ($("#sideTabAlerts")) $("#sideTabAlerts").textContent = nb(alerts.length);
    $("#alertsList").innerHTML = alerts.length
      ? alerts.slice(0, 60).map((a, i) => `<button class="gpon-alert ${/critical|critico/i.test(a.level || a.nivel) ? "is-critical" : ""}" type="button" data-alert="${i}">
        <b>${esc(a.title || a.titulo || "Alerta GPON")}</b><small>${esc(a.detail || a.detalhe || "Verifique a rede óptica.")}</small></button>`).join("")
        + (alerts.length > 60 ? `<div class="gpon-list-note">Mostrando 60 de ${nb(alerts.length)}.</div>` : "")
      : `<div class="empty gpon-side-empty"><b>Sem alertas</b><p>Nenhuma falha derivada dos dados atuais.</p></div>`;
  }

  /* ---------------- tabela ---------------- */

  function renderTable() {
    const body = $("#gponListBody");
    if (!body) return;
    const list = filtered();
    const pages = Math.max(1, Math.ceil(list.length / PAGE_SIZE));
    state.page = Math.min(state.page, pages - 1);
    const start = state.page * PAGE_SIZE;
    const rows = list.slice(start, start + PAGE_SIZE);
    $("#gponTableCount").textContent = `${nb(list.length)} de ${nb(state.rows.length)} clientes`;
    body.innerHTML = rows.length ? rows.map((r) => {
      const c = r.c;
      const status = r.off ? "Offline" : r.low ? "Sinal alto" : "Online";
      return `<tr>
        <td><b>${esc(r.name)}</b><br><small class="dim mono">${esc(c.serial || c.onu_index || "Sem serial")}</small></td>
        <td><span class="badge ${r.off ? "badge-danger" : r.low ? "badge-warn" : "badge-ok"}">${esc(status)}</span></td>
        <td><b>${esc(deviceById(c.olt_id)?.nome || c.olt_id || "—")}</b><br><small class="dim mono">${esc(c.pon || "PON não informada")}</small></td>
        <td>${esc(boxById(c.box_id)?.name || c.box_id || "—")}</td>
        <td class="mono">${c.rx_power === null || c.rx_power === undefined ? "—" : `${esc(c.rx_power)} dBm`}</td>
        <td>${esc(c.address || "—")}</td>
        <td><button class="btn btn-sm" type="button" data-client-map="${esc(r.id)}"${r.located ? "" : ' disabled title="Cliente sem coordenadas"'}>Ver no mapa</button></td>
      </tr>`;
    }).join("") : `<tr><td colspan="7"><div class="empty"><b>Nenhum cliente encontrado</b><p>Ajuste a busca para consultar a base GPON.</p></div></td></tr>`;
    $$("[data-client-map]", body).forEach((el) => el.onclick = () => {
      setView("map");
      requestAnimationFrame(() => select("client", el.dataset.clientMap, true));
    });
    const pagination = $("#gponPagination");
    pagination.hidden = pages <= 1;
    $("#gponPageLabel").textContent = `Página ${state.page + 1} de ${pages}`;
    $("#gponPrevPage").disabled = state.page === 0;
    $("#gponNextPage").disabled = state.page >= pages - 1;
  }

  /* ---------------- mapa ---------------- */

  function scheduleMap() {
    if (state.frame) return;
    state.frame = requestAnimationFrame(() => { state.frame = 0; renderMap(); });
  }

  function renderMap() {
    const stage = $("#gponMap"), rect = stage.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    if (!state.basemap) state.basemap = GEO.basemap($("#gponBasemap"));
    const { k, ox, oy } = state.map;
    state.basemap.render({ k, ox, oy, escala: 1, x0: 0, y0: 0, x1: rect.width, y1: rect.height });
    const z = GEO.tileZoom(k, 1);
    $("#mapZoomLabel").textContent = `z${z}`;

    /* Um recorte por quadro: rotas e marcadores partem da mesma lista. */
    const m = 90;
    const view = {
      wx0: (-m + ox) / k, wx1: (rect.width + m + ox) / k,
      wy0: (-m + oy) / k, wy1: (rect.height + m + oy) / k, z, rect,
    };
    const vis = (state.layers.clients || state.layers.drops) ? cull(view.wx0, view.wx1, view.wy0, view.wy1) : [];
    renderRoutes(vis, view);
    renderMarkers(vis, view);
    renderMapBadge(vis.length);
  }

  const sx = (p) => p.px * state.map.k - state.map.ox;
  const sy = (p) => p.py * state.map.k - state.map.oy;
  const inView = (p, v) => p.px >= v.wx0 && p.px <= v.wx1 && p.py >= v.wy0 && p.py <= v.wy1;

  function renderMapBadge(n) {
    const el = $("#mapCount");
    if (!el) return;
    const total = sortedVisible().length;   // já é a lista filtrada e localizada, em cache
    el.textContent = `${nb(n)} de ${nb(total)} clientes no enquadramento`;
  }

  function route(points, className) {
    let d = "";
    const { k, ox, oy } = state.map;
    for (const p of points) {
      if (!hasCoord(p)) continue;
      const q = GEO.project(p.lat, p.lon);
      d += `${d ? "L" : "M"}${(q.x * k - ox).toFixed(1)},${(q.y * k - oy).toFixed(1)}`;
    }
    return d ? `<path class="gpon-route ${className}" d="${d}"/>` : "";
  }

  function renderRoutes(vis, view) {
    const pieces = [], seen = new Set();
    if (state.layers.pops) (state.topology.conexoes || []).forEach((c) => {
      const a = popOfDevice(deviceById(c.origem)), b = popOfDevice(deviceById(c.destino));
      if (!hasCoord(a) || !hasCoord(b) || a.id === b.id) return;
      const key = [a.id, b.id].sort().join(":");
      if (seen.has(key)) return;
      seen.add(key);
      pieces.push(route([a, b], "gpon-route-network"));
    });
    /* O drop só significa alguma coisa a partir do zoom de rua, e desenhar
       milhares de polilinhas de 3 px é o item mais caro do quadro. */
    if (state.layers.drops && view.z >= DROP_Z && vis.length <= ROUTE_MAX) {
      for (const r of vis) {
        const c = r.c, box = boxById(c.box_id);
        const points = Array.isArray(c.drop_path) ? [...c.drop_path] : [];
        if (!points.length && hasCoord(box)) points.push(box, c);
        else if (points.length) {
          if (hasCoord(box) && (points[0].lat !== box.lat || points[0].lon !== box.lon)) points.unshift(box);
          const last = points[points.length - 1];
          if (last.lat !== c.lat || last.lon !== c.lon) points.push(c);
        }
        if (points.length > 1) pieces.push(route(points, `gpon-route-drop ${r.alert ? "is-alert" : ""}`));
      }
    }
    $("#gponRoutes").innerHTML = pieces.join("");
  }

  /* A propriedade `translate` (e não `left/top`) posiciona o marcador: a
     composição fica na GPU e o quadro de arrasto deixa de recalcular o layout
     da página. `transform` continua livre para a centralização do CSS. */
  function markerHtml(type, id, x, y, iconName, label, extra, showLabel) {
    return `<button class="gpon-marker is-${type} ${extra} ${showLabel ? "has-label" : ""}" type="button"
      style="translate:${x.toFixed(1)}px ${y.toFixed(1)}px" data-type="${type}" data-id="${esc(id)}" aria-label="${esc(label)}">
      ${icon(iconName)}<span class="gpon-marker-label">${esc(label)}</span></button>`;
  }

  function clientMarker(r, showLabel) {
    const selected = state.selected?.type === "client" && String(state.selected.id) === String(r.id);
    const cls = `${r.off ? "is-critical" : r.low ? "is-warn" : ""} ${selected ? "is-selected" : ""}`;
    return markerHtml("client", r.id, sx(r), sy(r), "user", r.name, cls, showLabel || selected);
  }

  function renderMarkers(vis, view) {
    const out = [];
    const sel = state.selected;
    const selClient = sel?.type === "client" ? String(sel.id) : null;

    if (state.layers.pops) for (const p of state.popPoints) {
      if (!inView(p, view)) continue;
      const selected = sel?.type === "pop" && String(sel.id) === String(p.id);
      const critico = !statusOnline(NOC.popStatus(p.id));
      out.push(markerHtml("pop", p.id, sx(p), sy(p), "topology", p.name,
        `${critico ? "is-critical" : ""} ${selected ? "is-selected" : ""}`, true));
    }

    if (state.layers.boxes) {
      let n = 0;
      for (const b of state.boxPoints) {
        if (!inView(b, view)) continue;
        if (++n > BOX_MAX) break;
        const selected = sel?.type === "box" && String(sel.id) === String(b.id);
        out.push(markerHtml("box", b.id, sx(b), sy(b), "port", b.name,
          `${statusOnline(b.ref.status) ? "" : "is-offline"} ${selected ? "is-selected" : ""}`,
          view.z >= BOX_LABEL_Z || selected));
      }
    }

    if (state.layers.clients) {
      if (vis.length <= SOLO_MAX) {
        const label = view.z >= LABEL_Z;
        for (const r of vis) out.push(clientMarker(r, label));
      } else {
        /* Agrupamento em coordenadas de tela: o custo é O(clientes visíveis),
           mas o DOM recebe no máximo uma bolha por célula de 58 px — algumas
           centenas de nós, mesmo com a base inteira dentro do enquadramento. */
        const cells = new Map();
        const { k, ox, oy } = state.map;
        for (const r of vis) {
          if (String(r.id) === selClient) { out.push(clientMarker(r, true)); continue; }
          const x = r.px * k - ox, y = r.py * k - oy;
          const key = `${Math.floor(x / CLUSTER_PX)}:${Math.floor(y / CLUSTER_PX)}`;
          let cell = cells.get(key);
          if (!cell) cells.set(key, cell = { n: 0, x: 0, y: 0, off: 0, low: 0, one: null });
          cell.n++; cell.x += x; cell.y += y;
          if (r.off) cell.off++; else if (r.low) cell.low++;
          if (cell.n === 1) cell.one = r;
        }
        cells.forEach((cell) => {
          if (cell.n === 1) { out.push(clientMarker(cell.one, false)); return; }
          const x = cell.x / cell.n, y = cell.y / cell.n;
          const size = Math.round(Math.min(58, 28 + Math.log10(cell.n) * 14));
          const tone = cell.off ? "is-critical" : cell.low ? "is-warn" : "";
          out.push(`<button class="gpon-cluster ${tone}" type="button" data-cluster-x="${x.toFixed(1)}" data-cluster-y="${y.toFixed(1)}"
            style="translate:${x.toFixed(1)}px ${y.toFixed(1)}px;width:${size}px;height:${size}px"
            aria-label="${nb(cell.n)} clientes nesta área${cell.off ? `, ${nb(cell.off)} offline` : ""}. Aproximar.">
            <b>${esc(short(cell.n))}</b>${cell.off ? '<i aria-hidden="true"></i>' : ""}</button>`);
        });
      }
    }
    $("#gponMarkers").innerHTML = out.join("");
  }

  /* ---------------- câmera ---------------- */

  /* Enquadramento por percentil: uma dúzia de cadastros com coordenada errada
     não pode decidir o zoom de toda a operação. Descartando as caudas, o mapa
     abre onde estão os clientes de verdade.

     O min/max anterior também usava `Math.min(...array)`: com mais de ~65 mil
     coordenadas o espalhamento estoura a pilha de argumentos e o mapa não
     abria — travava com RangeError antes do primeiro desenho. */
  function quantile(sorted, q) {
    if (!sorted.length) return 0;
    const i = Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * q)));
    return sorted[i];
  }

  function frame(points, trim) {
    const rect = $("#gponMap").getBoundingClientRect();
    if (!rect.width || !points.length) return;
    const xs = points.map((p) => p.px).sort((a, b) => a - b);
    const ys = points.map((p) => p.py).sort((a, b) => a - b);
    const t = points.length >= 50 ? trim : 0;
    const minX = quantile(xs, t), maxX = quantile(xs, 1 - t);
    const minY = quantile(ys, t), maxY = quantile(ys, 1 - t);
    const dx = maxX - minX, dy = maxY - minY, pad = 90;
    let k = dx || dy
      ? Math.min((rect.width - pad * 2) / Math.max(dx, 1e-9), (rect.height - pad * 2) / Math.max(dy, 1e-9))
      : 2 ** 16;
    k = GEO.clamp(k, 2 ** 4, 2 ** 18);
    state.map = { k, ox: (minX + maxX) / 2 * k - rect.width / 2, oy: (minY + maxY) / 2 * k - rect.height / 2 };
    state.fitted = true;
    renderMap();
  }

  function fit() {
    const area = currentArea();
    let points = filtered().filter((r) => r.located);
    /* Se o filtro atual não sobrou nada, cai para a base inteira e depois para
       os POPs: o mapa nunca abre vazio nem no meio do oceano. */
    if (!points.length) points = state.rows.filter((r) => r.located);
    if (!points.length) points = state.popPoints;
    if (!points.length) {
      /* Ainda sem dado nenhum: desenha a Baixada e mantém o enquadramento
         pendente, para a primeira carga real reposicionar a câmera. */
      const p = GEO.project(-23.96, -46.33);
      frame([{ px: p.x, py: p.y }], 0);
      state.fitted = false;
      return;
    }
    frame(points, area ? 0.01 : 0.03);
  }

  function zoom(factor, cx, cy) {
    const rect = $("#gponMap").getBoundingClientRect();
    const x = cx ?? rect.width / 2, y = cy ?? rect.height / 2;
    const old = state.map.k, k = GEO.clamp(old * factor, 2 ** 3, 2 ** 19);
    if (old === k) return;
    const mx = (x + state.map.ox) / old, my = (y + state.map.oy) / old;
    state.map = { k, ox: mx * k - x, oy: my * k - y };
    scheduleMap();
  }

  /* Clique num agrupamento: aproxima e traz a bolha para o centro da tela. */
  function zoomTo(x, y) {
    const rect = $("#gponMap").getBoundingClientRect();
    zoom(2.8, x, y);
    state.map.ox += x - rect.width / 2;
    state.map.oy += y - rect.height / 2;
    scheduleMap();
  }

  function bindMap() {
    const stage = $("#gponMap");
    stage.addEventListener("wheel", (e) => {
      e.preventDefault();
      const r = stage.getBoundingClientRect();
      zoom(e.deltaY < 0 ? 1.35 : 1 / 1.35, e.clientX - r.left, e.clientY - r.top);
    }, { passive: false });
    stage.addEventListener("pointerdown", (e) => {
      if (e.button !== 0 || e.target.closest("button")) return;
      state.dragging = { x: e.clientX, y: e.clientY, ox: state.map.ox, oy: state.map.oy };
      stage.setPointerCapture(e.pointerId);
      stage.classList.add("is-panning");
    });
    /* Um desenho por quadro. O ponteiro dispara centenas de eventos por
       segundo e cada um provocava, antes, um redesenho síncrono do mapa
       inteiro — a origem do travamento ao arrastar. */
    stage.addEventListener("pointermove", (e) => {
      if (!state.dragging) return;
      state.map.ox = state.dragging.ox - (e.clientX - state.dragging.x);
      state.map.oy = state.dragging.oy - (e.clientY - state.dragging.y);
      scheduleMap();
    });
    const end = () => { state.dragging = null; stage.classList.remove("is-panning"); };
    stage.addEventListener("pointerup", end);
    stage.addEventListener("pointercancel", end);
    stage.addEventListener("keydown", (e) => {
      const step = 80;
      if (e.key === "+" || e.key === "=") zoom(2);
      else if (e.key === "-") zoom(.5);
      else if (e.key === "0") { state.fitted = false; fit(); }
      else if (e.key.startsWith("Arrow")) {
        e.preventDefault();
        state.map.ox += e.key === "ArrowRight" ? step : e.key === "ArrowLeft" ? -step : 0;
        state.map.oy += e.key === "ArrowDown" ? step : e.key === "ArrowUp" ? -step : 0;
        scheduleMap();
      }
    });
  }

  function select(type, id, focus = false) {
    state.selected = { type, id };
    renderClientList();
    renderDetail();
    if (focus) {
      const item = type === "client" ? rowById(id)
        : type === "box" ? state.boxPoints.find((b) => String(b.id) === String(id))
        : state.popPoints.find((p) => String(p.id) === String(id));
      if (item && item.located !== false) {
        const rect = $("#gponMap").getBoundingClientRect();
        /* Centralizar sem aproximar deixava o cliente escolhido escondido
           dentro de um agrupamento; o zoom de rua é o mínimo útil. */
        if (state.map.k < 2 ** 16) state.map.k = 2 ** 16;
        state.map.ox = item.px * state.map.k - rect.width / 2;
        state.map.oy = item.py * state.map.k - rect.height / 2;
      } else if (type === "client") {
        toast("Cliente sem coordenadas", { type: "warn",
          text: "Este cliente não tem latitude/longitude no cadastro e não pode ser posicionado no mapa." });
      }
    }
    scheduleMap();
  }

  function derivedPath(c) {
    const hops = [];
    const add = (kind, name, detail) => hops.push({ kind, name, detail });
    add("client", c.name, `${c.username || c.serial || "ONU"}${c.ip ? ` • ${c.ip}` : ""}`);
    const box = boxById(c.box_id); if (box) add("box", box.name, `${box.type}${box.address ? ` • ${box.address}` : ""}`);
    const olt = deviceById(c.olt_id);
    if (olt) add("olt", olt.nome, `${c.pon || "PON não informada"} • ${olt.modelo || olt.categoria || "OLT"}`);
    else if (c.olt_id) add("olt", c.olt_id, c.pon || "PON não informada");

    if (Array.isArray(c.path) && c.path.length) {
      c.path.forEach((h) => typeof h === "string" ? add("network", h, "")
        : add(h.type || h.tipo || "network", h.name || h.nome || h.id || "Elemento de rede", h.detail || h.detalhe || h.port || h.porta || ""));
      return hops;
    }
    if (!olt) return hops;
    const graph = new Map();
    const join = (a, b, cx) => { if (!graph.has(a)) graph.set(a, []); graph.get(a).push({ id: b, cx }); };
    (state.topology.conexoes || []).forEach((cx) => { join(cx.origem, cx.destino, cx); join(cx.destino, cx.origem, cx); });
    const target = (e) => e && e.id !== olt.id && (/núcleo|bgp|core/i.test(`${e.categoria} ${e.nome}`) || e.id === "f1a");
    const queue = [{ id: olt.id, route: [] }], seen = new Set([olt.id]);
    let found = [];
    while (queue.length) {
      const cur = queue.shift();
      const e = deviceById(cur.id);
      if (target(e)) { found = cur.route; break; }
      for (const edge of graph.get(cur.id) || []) if (!seen.has(edge.id)) { seen.add(edge.id); queue.push({ id: edge.id, route: [...cur.route, edge] }); }
    }
    found.forEach(({ id, cx }) => {
      const e = deviceById(id);
      const port = cx.origem === id ? cx.portaOrigem : cx.portaDestino;
      add("network", e?.nome || id, `${e?.categoria || "Rede"}${port ? ` • porta ${port}` : ""}`);
    });
    return hops;
  }

  /* ---------------- linha de cliente dentro da caixa ---------------- */

  /* O nome completo do cadastro não cabe na coluna do painel de detalhe e
     vazava para fora do cartão. O operador precisa reconhecer o cliente, não
     ler a certidão: primeiro e último nome bastam, e o nome inteiro continua
     acessível no title do botão. */
  const CONECTIVO = /^(d[aeiou]s?|e|del|von|van)$/i;
  function shortName(full) {
    const parts = String(full || "").trim().split(/\s+/).filter(Boolean);
    if (!parts.length) return "Sem nome";
    if (parts.length <= 2) return parts.join(" ");
    const ultimo = [...parts].reverse().find((p) => !CONECTIVO.test(p)) || parts[parts.length - 1];
    return ultimo === parts[0] ? parts[0] : `${parts[0]} ${ultimo}`;
  }

  /* Código do cliente no ERP quando o coletor casou a ONU com o IXC; sem isso,
     o id da própria ONU — que é o que existe para identificar a linha. */
  const clientCode = (c) => String(c.ixc_id || c.id || "").trim();

  /* Ordem do painel físico da caixa: porta 2 vem antes da porta 10, e quem não
     tem porta cadastrada fica no fim. */
  const numeroPorta = (r) => {
    const m = String(r.c.box_port || "").match(/\d+/);
    return m ? Number(m[0]) : Number.POSITIVE_INFINITY;
  };
  const porPorta = (a, b) => numeroPorta(a) - numeroPorta(b) || a.name.localeCompare(b.name, "pt-BR");

  function linhaDaCaixa(r) {
    const tone = r.off ? "is-off" : r.low ? "is-low" : "";
    const estado = r.off ? "Offline" : r.low ? "Sinal alto" : "Online";
    const porta = String(r.c.box_port || "").trim();
    return `<button class="gpon-box-client ${tone}" type="button" data-client="${esc(r.id)}" title="${esc(`${r.name} — ${estado}${porta ? ` — porta ${porta}` : ""}`)}">
      <i class="gpon-dot" aria-hidden="true"></i>
      <span class="gpon-box-code mono">${esc(clientCode(r.c) || "—")}</span>
      <span class="gpon-box-name">${esc(shortName(r.name))}</span>
      <span class="gpon-box-port mono">${porta ? esc(porta) : "—"}</span>
      <span class="sr-only">${esc(estado)}</span>
    </button>`;
  }

  /* Linha do tempo da ONU selecionada. O snapshot responde "está fora agora";
     só o histórico responde "caiu às 3h12, voltou às 3h14 e já é a quarta vez
     hoje" — que é a diferença entre trocar um drop e abrir um chamado de
     rota. A busca é por cliente e sob demanda: carregar a linha do tempo do
     parque inteiro junto do mapa seria pagar caro por um dado que só interessa
     depois do clique. */
  const EVENTO_ROTULO = { status: "Estado", signal: "Sinal", baseline: "Primeira leitura" };
  const ORIGEM_ROTULO = { ont: "OLT", ixc: "IXC Radius", "ont+ixc": "OLT + IXC", snapshot: "Sincronização completa" };

  async function carregarHistorico(clientId) {
    const token = ++state.historyToken;
    let dados;
    try { dados = await NOC.api(`/api/gpon/history?limit=25&client_id=${encodeURIComponent(clientId)}`); }
    catch { dados = null; }
    /* O operador pode ter clicado noutro cliente enquanto isto voltava. */
    if (token !== state.historyToken) return;
    const host = $("#gponHistory");
    if (!host) return;
    const eventos = dados?.events || [];
    if (!eventos.length) {
      host.innerHTML = `<p class="muted">${dados ? "Nenhuma mudança registrada no período retido." : "Não foi possível ler o histórico."}</p>`;
      return;
    }
    host.innerHTML = eventos.map((e) => {
      const caiu = String(e.status_after || "").toLowerCase() !== "online";
      const de = e.status_before ? `${esc(e.status_before)} → ` : "";
      /* Repetir o mesmo número entre parênteses ("RX −24 dBm (era −24)") só
         ocupa espaço: o valor anterior interessa quando ele mudou. */
      const mudouRx = e.rx_power_before !== null && e.rx_power_before !== undefined && e.rx_power_before !== e.rx_power;
      const sinal = e.rx_power === null || e.rx_power === undefined ? ""
        : ` • RX ${esc(e.rx_power)} dBm${mudouRx ? ` (era ${esc(e.rx_power_before)})` : ""}`;
      return `<div class="gpon-hist ${caiu ? "is-off" : "is-on"}">
        <i class="gpon-dot ${caiu ? "is-off" : ""}" aria-hidden="true"></i>
        <div>
          <b>${de}${esc(e.status_after)}</b>
          <small>${esc(e.detail_after || EVENTO_ROTULO[e.event] || e.event)}${sinal}</small>
          <small class="mono">${esc(new Date(e.created_at.replace(" ", "T") + (e.created_at.endsWith("Z") ? "" : "Z")).toLocaleString("pt-BR"))} • ${esc(ORIGEM_ROTULO[e.origin] || e.origin)}</small>
        </div>
      </div>`;
    }).join("");
  }

  function renderDetail() {
    const host = $("#gponDetail"), sel = state.selected;
    if (!sel) return;
    if (sel.type === "client") {
      const r = rowById(sel.id); if (!r) return;
      const c = r.c;
      const path = derivedPath(c);
      const status = r.off ? "Offline" : r.low ? "Sinal alto" : "Online";
      host.innerHTML = `<div class="gpon-detail-head"><span class="badge ${r.off ? "badge-danger" : r.low ? "badge-warn" : "badge-ok"}">${esc(status)}</span><h2>${esc(c.name)}</h2><p class="muted">${esc(c.address || "Localização textual não informada")}</p></div>
        <div class="gpon-detail-grid">
          <div><span>Usuário</span><b>${esc(c.username || "—")}</b></div><div><span>Serial ONU</span><b class="mono">${esc(c.serial || "—")}</b></div>
          <div><span>OLT</span><b>${esc(deviceById(c.olt_id)?.nome || c.olt_id || "—")}</b></div><div><span>PON</span><b class="mono">${esc(c.pon || "—")}</b></div>
          <div><span>RX óptico</span><b>${c.rx_power === null || c.rx_power === undefined ? "—" : `${esc(c.rx_power)} dBm`}</b></div><div><span>VLAN / IP</span><b>${esc([c.vlan, c.ip].filter(Boolean).join(" • ") || "—")}</b></div>
          <div><span>Caixa / CTO</span><b>${esc([boxById(c.box_id)?.name || c.box_id || "—", c.box_port ? `porta ${c.box_port}` : ""].filter(Boolean).join(" • "))}</b></div><div><span>Drop</span><b>${c.drop_path?.length ? `${c.drop_path.length} pontos` : boxById(c.box_id) ? "Ligação direta cadastrada" : "Sem traçado"}</b></div>
        </div>
        <b style="font-size:var(--fs-12)">Conexão ponta a ponta</b>
        <div class="gpon-path">${path.map((h) => `<div class="gpon-hop"><i class="gpon-hop-dot"></i><div><b>${esc(h.name)}</b><small>${esc(h.detail || h.kind)}</small></div></div>`).join("")}</div>
        <b style="font-size:var(--fs-12)">Histórico do estado</b>
        <div class="gpon-history" id="gponHistory"><p class="muted">Carregando histórico…</p></div>`;
      carregarHistorico(c.id);
    } else if (sel.type === "box") {
      const b = boxById(sel.id); if (!b) return;
      const linked = state.rows.filter((r) => String(r.c.box_id) === String(b.id)).sort(porPorta);
      const fora = linked.filter((r) => r.off).length, altos = linked.filter((r) => r.low).length;
      const ocupacao = Number.isFinite(Number(b.capacity)) && Number(b.capacity) > 0
        ? `${nb(linked.length)} / ${nb(b.capacity)}` : nb(linked.length);
      host.innerHTML = `<div class="gpon-detail-head"><span class="badge">${esc(b.type)}</span><h2>${esc(b.name)}</h2><p class="muted">${esc(b.address || "Endereço não informado")}</p></div>
        <div class="gpon-detail-grid"><div><span>Estado</span><b>${esc(b.status)}</b></div><div><span>Portas usadas</span><b>${esc(ocupacao)}</b></div><div><span>POP</span><b>${esc(popById(b.pop_id)?.nome || b.pop_id || "—")}</b></div><div><span>Coordenadas</span><b class="mono">${hasCoord(b) ? esc(GEO.label(b.lat, b.lon)) : "—"}</b></div></div>
        <div class="gpon-box-head">
          <b>Clientes atendidos</b>
          <span>${fora ? `<i class="gpon-dot is-off"></i>${nb(fora)} offline` : ""}${altos ? `<i class="gpon-dot is-low"></i>${nb(altos)} sinal alto` : ""}${!fora && !altos && linked.length ? `<i class="gpon-dot"></i>todos online` : ""}</span>
        </div>
        <div class="gpon-box-clients">${linked.slice(0, 64).map(linhaDaCaixa).join("") || '<p class="muted">Nenhum cliente vinculado.</p>'}</div>
        ${linked.length > 64 ? `<div class="gpon-list-note">Mostrando 64 de ${nb(linked.length)}.</div>` : ""}`;
      $$("[data-client]", host).forEach((el) => el.onclick = () => select("client", el.dataset.client, true));
    } else {
      const p = popById(sel.id); if (!p) return;
      const list = devices().filter((e) => popOfDevice(e)?.id === p.id);
      host.innerHTML = `<div class="gpon-detail-head"><span class="badge badge-ok">POP</span><h2>${esc(p.nome || p.id)}</h2><p class="muted">${esc(p.endereco || p.local || "Endereço não informado")}</p></div>
        <div class="gpon-detail-grid"><div><span>Estado</span><b>${esc(NOC.popStatus(p.id))}</b></div><div><span>Equipamentos</span><b>${nb(list.length)}</b></div><div><span>Clientes GPON</span><b>${nb(state.rows.filter((r) => popOfClient(r.c)?.id === p.id).length)}</b></div><div><span>Coordenadas</span><b class="mono">${esc(GEO.label(p.lat, p.lon) || "—")}</b></div></div>
        <b style="font-size:var(--fs-12)">SW, OLT e demais aparelhos</b><div class="gpon-path">${list.map((e) => `<div class="gpon-hop"><i class="gpon-hop-dot"></i><div><b>${esc(e.nome)}</b><small>${esc(`${e.categoria || "Equipamento"} • ${NOC.statusInfo(e).label}`)}</small></div></div>`).join("") || '<p class="muted">Nenhum equipamento vinculado a este POP.</p>'}</div>`;
    }
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", mount); else mount();
})();
