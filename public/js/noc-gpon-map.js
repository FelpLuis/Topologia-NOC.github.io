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
  const { $, $$, esc, icon, toast, modal } = UI;

  const LIST_CHUNK = 60;      // clientes por página da lista lateral
  const POINT_CHUNK = 40;     // caixas/POPs por página da lista lateral
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
  const DETAIL_KEY = `updown.gpon.detail.${location.pathname}`;

  const state = {
    topology: { equipamentos: [], conexoes: [], pops: [] },
    feed: { clients: [], boxes: [], alerts: [], configured: false },
    rows: [], boxPoints: [], popPoints: [], areas: [], alerts: [],
    idx: { device: new Map(), box: new Map(), pop: new Map(), client: new Map(), popOfDevice: new Map(),
      clientsOfBox: new Map(), clientsOfPop: new Map(), devicesOfPop: new Map() },
    query: "", status: "all", focus: "auto", sideTab: "clients",
    /* Um teto por seção da lista lateral: cada camada ativa mostra a sua fatia
       e tem o seu próprio "carregar mais". */
    limits: { clients: LIST_CHUNK, boxes: POINT_CHUNK, pops: POINT_CHUNK },
    baseCache: null, cache: null, sorted: null, boxCache: null, popCache: null,
    selected: null, layers: { clients: true, boxes: true, pops: true, drops: true },
    map: { k: 2 ** 12, ox: 0, oy: 0 }, basemap: null, dragging: null, fitted: false,
    frame: 0, view: "map", page: 0, searchTimer: 0,
    detailOff: false,
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

  /* ---------------- tráfego e conexão (Radius do IXC) ----------------

     Os campos que o ciclo de 10 s traz junto do estado. A lista existe para
     que o delta saiba o que copiar sem enumerar campo por campo em dois
     lugares. */
  const CONEXAO = ["ip", "down_kbps", "up_kbps", "down_bytes", "up_bytes", "uptime_s", "conn_since", "nas_id"];

  /* O IXC provisiona em kbps; o operador pensa em mega. 300000 vira "300 Mbps",
     e um plano fracionado não perde a fração. */
  function velocidade(kbps) {
    const n = Number(kbps);
    if (!Number.isFinite(n) || n <= 0) return "";
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(".0", "")} Gbps`;
    if (n >= 1000) return `${(n / 1000).toFixed(n % 1000 ? 1 : 0).replace(".0", "")} Mbps`;
    return `${n} kbps`;
  }

  function bytes(valor) {
    const n = Number(valor);
    if (!Number.isFinite(n) || n < 0) return "";
    const unidades = ["B", "KiB", "MiB", "GiB", "TiB"];
    let i = 0, v = n;
    while (v >= 1024 && i < unidades.length - 1) { v /= 1024; i += 1; }
    return `${v.toFixed(v >= 100 || i === 0 ? 0 : 1).replace(".0", "")} ${unidades[i]}`;
  }

  /* Uptime vivo sem tráfego de rede: o coletor manda o instante em que a sessão
     começou, que é estático, e a tela faz a conta. Mandar o contador em si
     obrigaria todo cliente online a ocupar uma linha do delta a cada ciclo. */
  function duracao(c) {
    const inicio = Date.parse(String(c.conn_since || "").replace(" ", "T"));
    const s = Number.isFinite(inicio) ? Math.max(0, Math.round((Date.now() - inicio) / 1000))
      : Number.isFinite(Number(c.uptime_s)) ? Number(c.uptime_s) : null;
    if (s === null) return "";
    const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
    if (d) return `${d}d ${h}h`;
    if (h) return `${h}h ${m}min`;
    if (m) return `${m}min`;
    return `${s}s`;
  }

  /* "300 Mbps ↓ / 150 Mbps ↑" quando o IXC informa as duas pontas; só a que
     existir quando informa uma. */
  function plano(c) {
    const d = velocidade(c.down_kbps), u = velocidade(c.up_kbps);
    if (d && u) return `${d} ↓ / ${u} ↑`;
    return d || u || "";
  }

  function consumo(c) {
    const d = bytes(c.down_bytes), u = bytes(c.up_bytes);
    if (d && u) return `${d} ↓ / ${u} ↑`;
    return d || u || "";
  }

  const devices = () => state.topology.equipamentos || [];
  const clients = () => state.feed.clients || [];
  const boxes = () => state.feed.boxes || [];
  const pops = () => state.topology.pops || [];
  const deviceById = (id) => state.idx.device.get(String(id)) || null;
  const boxById = (id) => state.idx.box.get(String(id)) || null;
  const popById = (id) => state.idx.pop.get(String(id)) || null;
  const rowById = (id) => state.idx.client.get(String(id)) || null;
  const clientById = (id) => rowById(id)?.c || null;

  /* ---------------- cadastro do cliente ----------------

     Mapa, painel de detalhe e Lista abrem o mesmo formulário de Cadastro de
     Cliente. Quando o cliente ainda não tem cadastro, o que a coleta sabe já
     entra preenchido — e o código é o do IXC, o mesmo que o operador procura no
     ERP, e não o id sintético da ONU. */
  const podeCadastrar = () => !!window.NOC_CLIENTES;

  /* As ações só podem ser aplicadas depois que /api/access responde: antes
     disso o conjunto de permissões está vazio e todo botão apareceria
     bloqueado. Quando a resposta chega, uma passada no documento inteiro
     alcança o que já foi desenhado. */
  let acessoPronto = false;
  NOC.loadAccess()
    .then(() => { acessoPronto = true; NOC.applyActions(document); })
    .catch(() => { /* sem acesso o formulário ainda bloqueia o salvar */ });
  const aplicarAcoes = (host) => { if (acessoPronto) NOC.applyActions(host); };

  function editarCadastro(c) {
    if (!c || !podeCadastrar()) return;
    if (c.cadastro) {
      window.NOC_CLIENTES.abrirCadastro(c.cadastro, "edit", () => load(false));
      return;
    }
    window.NOC_CLIENTES.abrirCadastro({
      client_id: String(c.ixc_id || "").trim() || c.id,
      ixc_id: String(c.ixc_id || "").trim(),
      nome: c.name === "Cliente sem nome" ? "" : c.name || "",
      endereco: c.address || "",
      lat: c.lat ?? "", lon: c.lon ?? "",
      ont_serial: c.serial || "", ont_modelo: c.model || "",
      ip_gerencia: c.ip || "", login_pppoe: c.username || "",
    }, "create", () => load(false));
  }

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
    return {
      ref: o, id, name, lat: Number(o.lat), lon: Number(o.lon), px: p.x, py: p.y,
      /* A busca do topo vale para as três camadas listadas; sem este índice,
         cada tecla varreria os objetos crus de caixa e POP. */
      search: [name, id, o.type, o.address, o.endereco, o.local, o.cidade, o.pop_id]
        .filter(Boolean).join(" ").toLowerCase(),
    };
  };

  function indexData() {
    const idx = state.idx;
    idx.device = new Map(devices().map((e) => [String(e.id), e]));
    idx.pop = new Map(pops().map((p) => [String(p.id), p]));
    idx.box = new Map(boxes().map((b) => [String(b.id), b]));
    idx.popOfDevice = new Map();
    cargaPorPar = null;   // a topologia mudou: o agrupamento por par de POPs também
    state.rows = clients().map(toRow);
    idx.client = new Map(state.rows.map((r) => [String(r.id), r]));
    state.popPoints = pops().filter(hasCoord).map((p) => point(p, p.id, p.nome || p.name || p.id));
    state.boxPoints = boxes().filter(hasCoord).map((b) => point(b, b.id, b.name || b.id));
    countByParent();
    state.areas = computeAreas();
    state.alerts = computeAlerts();
    invalidate();
  }

  /* Ocupação de caixa e porte de POP entram em cada linha da lista lateral.
     Contar varrendo state.rows dentro do desenho custava uma passada pela base
     inteira por linha — e a lista é redesenhada a cada clique no mapa. */
  function countByParent() {
    const idx = state.idx;
    idx.clientsOfBox = new Map();
    idx.clientsOfPop = new Map();
    idx.devicesOfPop = new Map();
    const bump = (map, key) => { if (key) map.set(String(key), (map.get(String(key)) || 0) + 1); };
    for (const r of state.rows) {
      bump(idx.clientsOfBox, r.c.box_id);
      bump(idx.clientsOfPop, popOfClient(r.c)?.id);
    }
    for (const e of devices()) bump(idx.devicesOfPop, popOfDevice(e)?.id);
  }
  const countOf = (map, id) => map.get(String(id)) || 0;

  function invalidate() {
    state.baseCache = null; state.cache = null; state.sorted = null;
    state.boxCache = null; state.popCache = null;
  }

  /* Toda mudança de busca, foco ou camada recomeça a paginação de cada seção:
     manter o teto antigo deixava a lista abrindo no meio de um resultado que
     já não existe mais. */
  function resetLimits() {
    state.limits = { clients: LIST_CHUNK, boxes: POINT_CHUNK, pops: POINT_CHUNK };
  }

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

  /* Caixas e POPs seguem a busca e o foco — os mesmos recortes que valem para
     os clientes —, mas não os chips de estado: "offline", "sinal" e "sem GPS"
     descrevem uma ONU, e aplicá-los aqui esvaziaria a seção sem explicação.
     A lista acompanha o que a camada mostra no mapa, então quando o operador
     desliga Caixas ou POPs a seção correspondente sai junto. */
  function filteredPoints(kind) {
    if (!state.layers[kind]) return [];
    const chave = kind === "boxes" ? "boxCache" : "popCache";
    if (state[chave]) return state[chave];
    const q = state.query, area = currentArea();
    let out = kind === "boxes" ? state.boxPoints : state.popPoints;
    if (q) out = out.filter((p) => p.search.includes(q));
    if (area) out = out.filter((p) => inArea(p, area));
    return (state[chave] = out);
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
    if ($("#radiusLogBtn")) $("#radiusLogBtn").innerHTML = `${icon("pulse")} Log RADIUS`;
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
    if ($("#radiusLogBtn")) $("#radiusLogBtn").onclick = () => abrirLogRadius();
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
        state.page = 0; resetLimits();
        invalidate();
        renderFilters(); renderSideList(); renderTable(); scheduleMap();
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
      /* A camada não muda só o mapa: a lista lateral mostra o que está no
         mapa, então ela é refeita no mesmo clique. */
      resetLimits();
      renderFilters(); renderSideList();
      scheduleMap();
    });
    $$("[data-status]").forEach((el) => el.onclick = () => {
      state.status = el.dataset.status;
      resetLimits(); state.page = 0;
      state.cache = null; state.sorted = null;
      renderFilters(); renderSideList(); renderTable(); scheduleMap();
    });
    $$("[data-side-tab]").forEach((el) => el.onclick = () => { state.sideTab = el.dataset.sideTab; renderSideTabs(); });
    if ($("#gponFocus")) $("#gponFocus").onchange = (e) => setFocus(e.target.value);
    if ($("#sideToggle")) $("#sideToggle").onclick = () => toggleSide();
    if ($("#detailToggle")) $("#detailToggle").onclick = () => toggleDetail();

    /* Delegação: com agrupamentos o mapa troca de conteúdo a cada quadro, e
       religar um ouvinte por marcador custava mais que o próprio desenho. */
    $("#gponMarkers").addEventListener("click", (e) => {
      const cluster = e.target.closest("[data-cluster-x]");
      if (cluster) { e.stopPropagation(); zoomTo(Number(cluster.dataset.clusterX), Number(cluster.dataset.clusterY)); return; }
      const marker = e.target.closest(".gpon-marker");
      if (marker) { e.stopPropagation(); select(marker.dataset.type, marker.dataset.id); }
    });
    $("#clientList").addEventListener("click", (e) => {
      const more = e.target.closest("[data-more]");
      if (more) {
        const kind = more.dataset.more;
        state.limits[kind] += (kind === "clients" ? LIST_CHUNK : POINT_CHUNK) * 4;
        renderSideList();
        return;
      }
      const row = e.target.closest("[data-client-row]");
      if (row) { select("client", row.dataset.clientRow, true); return; }
      const ponto = e.target.closest("[data-point-row]");
      if (ponto) select(ponto.dataset.pointRow, ponto.dataset.pointId, true);
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
      if (localStorage.getItem(DETAIL_KEY) === "off") state.detailOff = true;
    } catch { /* modo privado */ }

    /* Sem seleção na tela, o painel de detalhe recolhe e o mapa ocupa a tela toda. */
    if (!state.selected && !state.detailOff) state.detailOff = true;
    $(".gpon-workspace").classList.toggle("no-detail", state.detailOff);
    paintDetailToggle();
    applyView(false);
    load(false);
    setInterval(refreshIfChanged, 10000);

    /* Cor por tráfego nas conexões de rede: a mesma escala e a mesma dica da
       topologia e do anel de POPs. A dica é delegada no palco porque o SVG das
       rotas é reescrito a cada quadro de arrasto. */
    TRAF.ligarDica($("#gponMap"));
    TRAF.acompanhar(() => { cargaPorPar = null; scheduleMap(); });
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

  function toggleDetail(forceOff) {
    const shell = $(".gpon-workspace");
    const off = forceOff === true ? true : forceOff === false ? false : !shell.classList.contains("no-detail");
    shell.classList.toggle("no-detail", off);
    state.detailOff = off;
    paintDetailToggle();
    try { localStorage.setItem(DETAIL_KEY, off ? "off" : "on"); } catch { /* modo privado */ }
    if (off) scheduleMap();
  }

  function paintDetailToggle() {
    const b = $("#detailToggle");
    if (!b) return;
    b.innerHTML = icon(state.detailOff ? "chevronRight" : "chevronLeft");
    b.setAttribute("aria-expanded", String(!state.detailOff));
    b.setAttribute("aria-label", state.detailOff ? "Mostrar painel de detalhe" : "Recolher painel de detalhe");
  }

  function setFocus(value) {
    state.focus = value;
    try { localStorage.setItem(FOCUS_KEY, value); } catch { /* modo privado */ }
    resetLimits(); state.page = 0;
    invalidate();
    renderFocusOptions(); renderFilters(); renderSideList(); renderTable();
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
    let mudou = 0, conexao = 0;
    for (const linha of delta.clients) {
      const row = state.idx.client.get(String(linha.id));
      if (!row) continue;
      const c = row.c;
      /* Tráfego e conexão andam sem que o estado mude — outro IP na
         reconexão, plano reajustado, consumo avançando. Aplicar sempre custa
         uma atribuição; deixar de aplicar deixava a ficha do cliente mostrando
         o IP da sessão anterior. */
      let mexeuConexao = false;
      for (const campo of CONEXAO) {
        if (c[campo] === linha[campo]) continue;
        c[campo] = linha[campo];
        mexeuConexao = true;
      }
      if (mexeuConexao) conexao += 1;
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
    /* Só a conexão mudou: nenhum marcador do mapa muda de cor e nenhum alerta
       nasce, então redesenhar o parque inteiro seria desperdício. A ficha
       aberta, essa sim, precisa mostrar o dado novo. */
    if (!mudou) {
      renderSource();
      if (conexao && state.selected?.type === "client") renderDetail(true);
      return;
    }
    state.alerts = computeAlerts();
    invalidate();
    render();
  }

  async function load(manual) {
    const button = $("#refreshMap");
    button.disabled = true;
    /* Manual é o botão "Atualizar": pede à API uma sincronização forçada — o
       Worker manda o coletor reler a OLT inteira e o IXC — e então relê tudo.
       O ciclo de 10 s, sem passar por aqui, só aplica o delta que já chegou. */
    const [top, feed, revision] = await Promise.allSettled([
      NOC.load(),
      manual ? NOC.api("/api/gpon/refresh", { method: "POST" }) : NOC.api("/api/gpon/clients"),
      NOC.api("/api/gpon/revision")]);
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
    if (manual) toast("Atualização solicitada", { type: feed.status === "fulfilled" ? "ok" : "warn",
      text: feed.status === "fulfilled" ? "A OLT e o IXC foram consultados e o mapa recarregado." : "Não foi possível sincronizar agora; o mapa mostra a última coleta recebida." });
  }

  function render() {
    renderSource(); renderKpis(); renderFocusOptions(); renderFilters();
    renderSideList(); renderAlerts(); renderSideTabs(); renderTable(); renderMap(); renderDetail();
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
    resetLimits();
    state.page = 0;
    if (state.query) {
      state.query = "";
      if ($("#mapSearch")) $("#mapSearch").value = "";
      if ($("#gponListSearch")) $("#gponListSearch").value = "";
      if ($("#mapSearchClear")) $("#mapSearchClear").hidden = true;
      if ($("#listSearchClear")) $("#listSearchClear").hidden = true;
    }
    state.cache = null; state.sorted = null;
    renderFilters(); renderSideList(); renderTable();
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
    paintSideTab(total);
  }

  /* Com Clientes desligado a aba continuaria anunciando "Clientes 0" sobre uma
     lista de caixas: o rótulo passa a dizer o que a lista tem de fato. */
  function paintSideTab(clientes) {
    const btn = $('[data-side-tab="clients"]');
    const contador = $("#sideTabClients");
    if (!btn || !contador) return;
    if (state.layers.clients) {
      /* Clientes é a camada principal: enquanto estiver ligada a aba continua
         contando clientes, e cada seção mostra o seu próprio total. */
      btn.firstChild.textContent = "Clientes ";
      contador.textContent = nb(clientes);
      return;
    }
    const nomes = [];
    if (state.layers.boxes) nomes.push("Caixas");
    if (state.layers.pops) nomes.push("POPs");
    btn.firstChild.textContent = `${nomes.join(" · ") || "Camadas"} `;
    contador.textContent = nb(filteredPoints("boxes").length + filteredPoints("pops").length);
  }

  function renderSideTabs() {
    $$("[data-side-tab]").forEach((el) => el.setAttribute("aria-pressed", String(el.dataset.sideTab === state.sideTab)));
    $("#clientList").hidden = state.sideTab !== "clients";
    $("#alertsList").hidden = state.sideTab !== "alerts";
  }

  const rxLabel = (v) => (v === null || v === undefined || v === "" || !Number.isFinite(Number(v)) ? "" : Number(v).toFixed(1));

  function clientRowHtml(r, selId) {
    const rx = rxLabel(r.c.rx_power);
    const tone = r.off ? "is-off" : r.low ? "is-low" : "";
    const meta = [r.c.serial || r.c.onu_index || "Sem serial", r.c.olt_id, r.c.pon].filter(Boolean).join(" • ");
    return `<button class="gpon-client-row ${tone}" type="button" data-client-row="${esc(r.id)}"${String(r.id) === selId ? ' aria-current="true"' : ""}>
      <i aria-hidden="true"></i>
      <span class="gpon-client-main"><b>${esc(r.name)}</b><small>${esc(meta)}</small></span>
      <span class="gpon-client-meta">${rx ? `<em>${esc(rx)}</em>` : ""}${r.located ? "" : '<u title="Sem coordenadas no cadastro">s/gps</u>'}</span>
    </button>`;
  }

  function boxRowHtml(b, selId) {
    const o = b.ref;
    const fora = !statusOnline(o.status);
    const ligados = countOf(state.idx.clientsOfBox, b.id);
    const capacidade = Number(o.capacity);
    const meta = [o.type || "Caixa", popById(o.pop_id)?.nome || o.pop_id, o.address].filter(Boolean).join(" • ");
    return `<button class="gpon-client-row is-box ${fora ? "is-off" : ""}" type="button" data-point-row="box" data-point-id="${esc(b.id)}"${String(b.id) === selId ? ' aria-current="true"' : ""}>
      <i aria-hidden="true"></i>
      <span class="gpon-client-main"><b>${esc(b.name)}</b><small>${esc(meta)}</small></span>
      <span class="gpon-client-meta"><em>${esc(Number.isFinite(capacidade) && capacidade > 0 ? `${nb(ligados)}/${nb(capacidade)}` : nb(ligados))}</em></span>
    </button>`;
  }

  function popRowHtml(p, selId) {
    const o = p.ref;
    const fora = !statusOnline(NOC.popStatus(p.id));
    const equipamentos = countOf(state.idx.devicesOfPop, p.id);
    const meta = [o.endereco || o.local || o.cidade, `${nb(equipamentos)} equipamentos`].filter(Boolean).join(" • ");
    return `<button class="gpon-client-row is-pop ${fora ? "is-off" : ""}" type="button" data-point-row="pop" data-point-id="${esc(p.id)}"${String(p.id) === selId ? ' aria-current="true"' : ""}>
      <i aria-hidden="true"></i>
      <span class="gpon-client-main"><b>${esc(p.name)}</b><small>${esc(meta)}</small></span>
      <span class="gpon-client-meta"><em>${nb(countOf(state.idx.clientsOfPop, p.id))}</em></span>
    </button>`;
  }

  /* Uma seção por camada ligada. O cabeçalho leva o total filtrado da camada —
     com três listas empilhadas, o número solto da aba não diria mais de onde
     vem cada bloco. */
  function sectionHtml(kind, titulo, total, corpo, chunk) {
    const teto = state.limits[kind];
    const resto = total - Math.min(total, teto);
    return `<section class="gpon-side-section" data-section="${kind}">
      <h3 class="gpon-side-section-head"><span>${esc(titulo)}</span><b>${nb(total)}</b></h3>
      ${corpo}
      ${resto > 0 ? `<button class="gpon-list-more" type="button" data-more="${kind}">Carregar mais ${nb(Math.min(resto, chunk))} · restam ${nb(resto)}</button>` : ""}
    </section>`;
  }

  /* A lista lateral espelha as camadas do mapa: o que está desligado no topo
     some daqui também, e o que está ligado aparece como uma seção própria. */
  function renderSideList() {
    const sel = state.selected;
    const selCliente = sel?.type === "client" ? String(sel.id) : null;
    const selCaixa = sel?.type === "box" ? String(sel.id) : null;
    const selPop = sel?.type === "pop" ? String(sel.id) : null;
    const partes = [];

    if (state.layers.clients) {
      const list = filtered();
      const corpo = list.slice(0, state.limits.clients).map((r) => clientRowHtml(r, selCliente)).join("")
        || `<div class="gpon-list-note">Nenhum cliente neste recorte. Ajuste a busca, o estado ou o foco.</div>`;
      partes.push(sectionHtml("clients", "Clientes", list.length, corpo, LIST_CHUNK * 4));
    }
    if (state.layers.boxes) {
      const list = filteredPoints("boxes");
      const corpo = list.slice(0, state.limits.boxes).map((b) => boxRowHtml(b, selCaixa)).join("")
        || `<div class="gpon-list-note">Nenhuma caixa localizada neste recorte.</div>`;
      partes.push(sectionHtml("boxes", "Caixas / CTOs", list.length, corpo, POINT_CHUNK * 4));
    }
    if (state.layers.pops) {
      const list = filteredPoints("pops");
      const corpo = list.slice(0, state.limits.pops).map((p) => popRowHtml(p, selPop)).join("")
        || `<div class="gpon-list-note">Nenhum POP neste recorte.</div>`;
      partes.push(sectionHtml("pops", "POPs", list.length, corpo, POINT_CHUNK * 4));
    }

    $("#clientList").innerHTML = partes.join("")
      /* Drops não entram aqui: são o traçado entre cliente e caixa, não um
         objeto que se possa abrir numa linha da lista. */
      || `<div class="empty gpon-side-empty"><b>Nada para listar</b><p>Ligue Clientes, Caixas ou POPs no topo. Drops aparecem só como traçado no mapa.</p></div>`;
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
        <td><span class="badge ${r.off ? "badge-danger" : r.low ? "badge-warn" : "badge-ok"}">${esc(status)}</span>${c.state_detail ? `<br><small class="dim">${esc(c.state_detail)}</small>` : ""}</td>
        <td><b>${esc(plano(c) || "—")}</b><br><small class="dim mono">${esc(c.ip || "sem IP")}</small></td>
        <td><b>${esc(deviceById(c.olt_id)?.nome || c.olt_id || "—")}</b><br><small class="dim mono">${esc(c.pon || "PON não informada")}</small></td>
        <td>${esc(boxById(c.box_id)?.name || c.box_id || "—")}</td>
        <td class="mono">${c.rx_power === null || c.rx_power === undefined ? "—" : `${esc(c.rx_power)} dBm`}</td>
        <td>${esc(c.address || "—")}</td>
        <td class="row" style="gap:6px;justify-content:flex-end">
          ${podeCadastrar() ? `<button class="btn btn-sm" type="button" data-client-edit="${esc(r.id)}" data-action="${c.cadastro ? "clientes.edit" : "clientes.create"}">${c.cadastro ? "Editar" : "Cadastrar"}</button>` : ""}
          <button class="btn btn-sm" type="button" data-client-map="${esc(r.id)}"${r.located ? "" : ' disabled title="Cliente sem coordenadas"'}>Ver no mapa</button>
        </td>
      </tr>`;
    }).join("") : `<tr><td colspan="8"><div class="empty"><b>Nenhum cliente encontrado</b><p>Ajuste a busca para consultar a base GPON.</p></div></td></tr>`;
    $$("[data-client-map]", body).forEach((el) => el.onclick = () => {
      setView("map");
      requestAnimationFrame(() => select("client", el.dataset.clientMap, true));
    });
    $$("[data-client-edit]", body).forEach((el) => el.onclick = () => editarCadastro(clientById(el.dataset.clientEdit)));
    aplicarAcoes(body);
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

  function route(points, className, extra = "") {
    let d = "";
    const { k, ox, oy } = state.map;
    for (const p of points) {
      if (!hasCoord(p)) continue;
      const q = GEO.project(p.lat, p.lon);
      d += `${d ? "L" : "M"}${(q.x * k - ox).toFixed(1)},${(q.y * k - oy).toFixed(1)}`;
    }
    if (!d) return "";
    return `<path class="gpon-route ${className}" d="${d}" ${extra}/>${
      extra ? `<path class="traf-alvo" d="${d}" ${extra}/>` : ""}`;
  }

  /* Carga por par de POPs, calculada uma vez por leitura do Zabbix e não a
     cada quadro. O mapa redesenha as rotas em todo passo de arrasto, e varrer
     os enlaces ali dentro custaria mais do que desenhar. `cargaPorPar` é
     descartado quando a topologia ou a medida mudam. */
  let cargaPorPar = null;

  function indexarCarga() {
    const grupos = new Map();
    for (const c of state.topology.conexoes || []) {
      const a = popOfDevice(deviceById(c.origem)), b = popOfDevice(deviceById(c.destino));
      if (!a || !b || a.id === b.id) continue;
      const key = [a.id, b.id].sort().join(":");
      if (!grupos.has(key)) grupos.set(key, []);
      grupos.get(key).push(c);
    }
    cargaPorPar = new Map();
    grupos.forEach((conns, key) => cargaPorPar.set(key, TRAF.doConjunto(conns)));
  }

  function cargaDoPar(a, b) {
    if (!cargaPorPar) indexarCarga();
    return cargaPorPar.get([a, b].sort().join(":")) || null;
  }

  function renderRoutes(vis, view) {
    const pieces = [], seen = new Set(), medidas = [];
    if (state.layers.pops) (state.topology.conexoes || []).forEach((c) => {
      const a = popOfDevice(deviceById(c.origem)), b = popOfDevice(deviceById(c.destino));
      if (!hasCoord(a) || !hasCoord(b) || a.id === b.id) return;
      const key = [a.id, b.id].sort().join(":");
      if (seen.has(key)) return;
      seen.add(key);
      /* A conexão de rede deixou de ser uma linha roxa fixa: a cor é a
         utilização, na mesma escala da topologia e do anel de POPs. */
      const carga = cargaDoPar(a.id, b.id) || TRAF.doConjunto([]);
      medidas.push(carga);
      const t = TRAF.atributos(carga, `${a.nome || a.id} ↔ ${b.nome || b.id}`, "Conexão de rede");
      pieces.push(route([a, b], `gpon-route-network is-traf ${carga.estado === "offline" ? "is-down" : ""}`,
        `style="stroke:${t.cor}" data-traf="${esc(t.dica)}"`));
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
    renderTrafLegend(medidas);
  }

  /* A legenda só aparece quando a camada de POPs está ligada: sem conexão de
     rede desenhada, uma escala de utilização sobre o mapa não explica nada. */
  function renderTrafLegend(medidas) {
    const host = $("#gponTrafLegend");
    if (!host) return;
    host.hidden = !medidas.length;
    if (!medidas.length) return;
    const bruto = TRAF.coletadoEm();
    const d = bruto && new Date(String(bruto).includes("T") ? bruto : `${String(bruto).replace(" ", "T")}Z`);
    const quando = TRAF.erro() ? "sem leitura nova do Zabbix"
      : d && !Number.isNaN(d.getTime()) ? `medido às ${d.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })}`
        : "aguardando o Zabbix";
    host.innerHTML = `
      <div class="traf-legenda-titulo">
        <b>Utilização dos enlaces</b>
        <span class="${TRAF.erro() ? "traf-legenda-aviso" : ""}">${esc(quando)}</span>
      </div>
      ${TRAF.legendaHTML(medidas)}`;
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
    /* Ao selecionar, o painel de detalhe volta à tela se estava recolhido. */
    if (state.detailOff) toggleDetail(false);
    renderSideList();
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

  /* Carga da conexão documentada entre dois saltos do caminho ponta a ponta.
     É o que pinta a linha de ligação com a mesma escala dos enlaces do mapa.
     Sem id numa das pontas — cliente, caixa, ou hop importado sem referência —
     não há enlace para medir e a linha segue na cor neutra. */
  const linkCarga = (a, b) => {
    if (!a?.id || !b?.id) return null;
    for (const cx of state.topology.conexoes || []) {
      if ((cx.origem === a.id && cx.destino === b.id) || (cx.origem === b.id && cx.destino === a.id)) return TRAF.doEnlace(cx);
    }
    return null;
  };

  function derivedPath(c) {
    const hops = [];
    const add = (kind, name, detail, id) => hops.push({ kind, name, detail, id });
    add("client", c.name, `${c.username || c.serial || "ONU"}${c.ip ? ` • ${c.ip}` : ""}`, String(c.id || ""));
    const box = boxById(c.box_id);
    if (box) add("box", box.name, `${box.type}${box.address ? ` • ${box.address}` : ""}`, String(box.id));
    const olt = deviceById(c.olt_id);
    if (olt) add("olt", olt.nome, `${c.pon || "PON não informada"} • ${olt.modelo || olt.categoria || "OLT"}`, String(olt.id));
    else if (c.olt_id) add("olt", c.olt_id, c.pon || "PON não informada", String(c.olt_id));

    if (Array.isArray(c.path) && c.path.length) {
      c.path.forEach((h) => typeof h === "string" ? add("network", h, "", null)
        : add(h.type || h.tipo || "network", h.name || h.nome || h.id || "Elemento de rede",
          h.detail || h.detalhe || h.port || h.porta || "", String(h.id || h.name || h.nome || "")));
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
      add("network", e?.nome || id, `${e?.categoria || "Rede"}${port ? ` • porta ${port}` : ""}`, String(id));
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

  /* `manterHistorico` é o caminho do ciclo de 10 s: o tráfego mudou e a ficha
     precisa mostrar o número novo, mas refazer a busca do histórico a cada
     volta trocaria a linha do tempo já carregada por "Carregando…" seis vezes
     por minuto — e gastaria uma consulta por ciclo para trazer o mesmo
     resultado. */
  function renderDetail(manterHistorico) {
    const host = $("#gponDetail"), sel = state.selected;
    if (!sel) return;
    if (sel.type === "client") {
      const r = rowById(sel.id); if (!r) return;
      const c = r.c;
      const historicoAtual = manterHistorico ? $("#gponHistory")?.innerHTML : null;
      const path = derivedPath(c);
      /* A ligação entre os saltos é a linha de tráfego da conexão: a cor é a
         utilização do enlace que une as duas pontas, na mesma escala dos
         enlaces do mapa. Enlace fora do ar — ou o próprio drop com a ONU
         offline — pinta a linha de vermelho. */
      const pathHtml = path.map((h, i) => {
        const next = path[i + 1];
        let m = null;
        if (next) {
          m = linkCarga(h, next);
          if (!m && h.kind === "client" && next.kind === "box" && r.off) {
            m = { estado: "offline", entrada: 0, saida: 0, capacidade: 0, pct: null, pontas: 1, caidas: 1, medido: false, enlaces: 1, parcial: false };
          }
        }
        const cor = m ? TRAF.cor(m) : "";
        const titulo = m ? TRAF.dica(m, `${h.name} ↔ ${next.name}`, "Conexão ponta a ponta") : "";
        return `<div class="gpon-hop"${cor ? ` style="--conn:${cor}"` : ""}${titulo ? ` title="${esc(titulo)}"` : ""}>
          <i class="gpon-hop-dot"></i><div><b>${esc(h.name)}</b><small>${esc(h.detail || h.kind)}</small></div></div>`;
      }).join("");
      const status = r.off ? "Offline" : r.low ? "Sinal alto" : "Online";
      const cadastro = c.cadastro;
      host.innerHTML = `<div class="gpon-detail-head"><span class="badge ${r.off ? "badge-danger" : r.low ? "badge-warn" : "badge-ok"}">${esc(status)}</span><h2>${esc(c.name)}</h2><p class="muted">${esc(c.address || "Localização textual não informada")}</p>
        ${podeCadastrar() ? `<button class="btn btn-sm" data-editar-cadastro type="button" data-action="${cadastro ? "clientes.edit" : "clientes.create"}">${icon("edit")} ${cadastro ? "Editar cadastro" : "Cadastrar cliente"}</button>` : ""}</div>
        <div class="gpon-detail-grid">
          <div><span>Usuário</span><b>${esc(c.username || "—")}</b></div><div><span>Serial ONU</span><b class="mono">${esc(c.serial || "—")}</b></div>
          <div><span>OLT</span><b>${esc(deviceById(c.olt_id)?.nome || c.olt_id || "—")}</b></div><div><span>PON</span><b class="mono">${esc(c.pon || "—")}</b></div>
          <div><span>RX óptico</span><b>${c.rx_power === null || c.rx_power === undefined ? "—" : `${esc(c.rx_power)} dBm`}</b></div><div><span>VLAN / IP</span><b>${esc([c.vlan, c.ip].filter(Boolean).join(" • ") || "—")}</b></div>
          <div><span>Velocidade</span><b>${esc(plano(c) || "—")}</b></div><div><span>Conectado há</span><b>${esc(duracao(c) || "—")}</b></div>
          ${consumo(c) ? `<div><span>Consumo</span><b>${esc(consumo(c))}</b></div>` : ""}
          <div><span>Caixa / CTO</span><b>${esc([boxById(c.box_id)?.name || c.box_id || "—", c.box_port ? `porta ${c.box_port}` : ""].filter(Boolean).join(" • "))}</b></div><div><span>Drop</span><b>${c.drop_path?.length ? `${c.drop_path.length} pontos` : boxById(c.box_id) ? "Ligação direta cadastrada" : "Sem traçado"}</b></div>
          ${cadastro ? `<div><span>Telefone</span><b>${esc(cadastro.telefone || "—")}</b></div><div><span>Faturamento</span><b>${esc(cadastro.plano || cadastro.status_faturamento || "—")}</b></div>` : ""}
        </div>
        ${cadastro && (cadastro.aparelhos?.length || cadastro.ont_serial) ? `<b style="font-size:var(--fs-12)">Aparelhos / ONU</b><div class="gpon-path">${(cadastro.aparelhos || []).map((a) => `<div class="gpon-hop"><i class="gpon-hop-dot"></i><div><b>${esc(a.nome)}</b><small>${esc([a.tipo, a.serial].filter(Boolean).join(" • "))}</small></div></div>`).join("")}${cadastro.ont_serial ? `<div class="gpon-hop"><i class="gpon-hop-dot"></i><div><b>ONU cadastrada</b><small class="mono">${esc(cadastro.ont_serial)}${cadastro.ont_modelo ? ` • ${esc(cadastro.ont_modelo)}` : ""}</small></div></div>` : ""}</div>` : ""}
        <b style="font-size:var(--fs-12)">Conexão ponta a ponta</b>
        <div class="gpon-path">${pathHtml}</div>
        <b style="font-size:var(--fs-12)">Histórico do estado</b>
        <div class="gpon-history" id="gponHistory">${historicoAtual ?? '<p class="muted">Carregando histórico…</p>'}</div>`;
      if (historicoAtual === null || historicoAtual === undefined) carregarHistorico(c.id);
      const btnEditar = host.querySelector("[data-editar-cadastro]");
      if (btnEditar) { btnEditar.onclick = () => editarCadastro(c); aplicarAcoes(host); }
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

  /* ---------------- log RADIUS (monitoramento da autenticação PPPoE) ----------------

     Botão do cabeçalho: abre um monitor das transições que o coletor grava em
     radius_logs (GET /api/radius/logs, permissão radius.view). Essa tabela
     não tem prazo de retenção — ao contrário do histórico GPON —, então "log
     completo" pede paginação de verdade: a abertura varre a tabela inteira,
     do mais novo ao mais antigo, em lotes de 500 (o teto por requisição do
     servidor) usando before_id como cursor. Só depois de completar essa
     varredura a tela entra em modo de acompanhamento ao vivo, buscando a
     cada 2 s (o ritmo pedido) só o que é mais novo que o último id visto —
     reler a tabela inteira nesse ritmo sobrecarregaria o banco à toa.
     Cliente, usuário, serial e OLT são filtrados no navegador sobre o que já
     foi carregado; status vai para o servidor porque troca de filtro refaz a
     varredura completa. */
  const RADIUS_POLL_MS = 2000;
  const RADIUS_PAGE = 500;
  const RADIUS_PAGE_CAP = 400; // 400 × 500 = 200 mil eventos: só para nunca travar o navegador

  const radiusBadge = (status) => {
    const s = String(status || "").toLowerCase();
    return s === "online" ? "badge-ok" : s === "offline" ? "badge-danger" : "";
  };

  function linhaRadiusLog(ev) {
    const quando = new Date(String(ev.created_at || "").replace(" ", "T"));
    const horario = Number.isFinite(quando.getTime()) ? quando.toLocaleString("pt-BR") : String(ev.created_at || "—");
    const transicao = ev.status_before ? `${esc(ev.status_before)} → ${esc(ev.status_after)}` : esc(ev.status_after || "—");
    return `<tr>
      <td class="mono dim">${esc(horario)}</td>
      <td><b>${esc(ev.client_name || ev.client_id || "—")}</b>${ev.serial ? `<br><small class="dim mono">${esc(ev.serial)}</small>` : ""}</td>
      <td class="mono">${esc(ev.username || "—")}</td>
      <td><span class="badge ${radiusBadge(ev.status_after)}">${transicao}</span></td>
      <td>${esc(ev.detail || "—")}</td>
      <td class="mono dim">${esc([ev.olt_id, ev.onu_index].filter(Boolean).join(" / ") || "—")}</td>
    </tr>`;
  }

  function abrirLogRadius() {
    const rl = {
      query: "", status: "all", map: new Map(), events: [],
      loading: false, full: false, auto: true, checkedAt: null,
      minId: null, maxId: 0, timer: 0,
    };

    function reconstruir() { rl.events = [...rl.map.values()].sort((a, b) => Number(b.id) - Number(a.id)); }

    function acrescentar(lote) {
      let novos = 0;
      for (const ev of lote) {
        const id = Number(ev.id);
        if (!Number.isFinite(id) || rl.map.has(id)) continue;
        rl.map.set(id, ev);
        rl.maxId = Math.max(rl.maxId, id);
        rl.minId = rl.minId === null ? id : Math.min(rl.minId, id);
        novos++;
      }
      if (novos) reconstruir();
      return novos;
    }

    function render(host) {
      const body = $("#radiusLogBody", host);
      const q = rl.query.trim().toLowerCase();
      const rows = q ? rl.events.filter((ev) => [ev.username, ev.client_name, ev.client_id, ev.serial, ev.olt_id, ev.detail]
        .some((v) => String(v || "").toLowerCase().includes(q))) : rl.events;
      body.innerHTML = rows.length ? rows.map(linhaRadiusLog).join("")
        : `<tr><td colspan="6" class="dim">${rl.full ? "Nenhum evento encontrado." : "Carregando histórico completo…"}</td></tr>`;
      $("#radiusLogCount", host).textContent = rl.full
        ? `${nb(rows.length)} de ${nb(rl.events.length)} eventos • log completo de todas as OLTs • atualizado ${relativo(rl.checkedAt)}`
        : `Carregando histórico completo… ${nb(rl.events.length)} eventos até agora`;
    }

    async function pedir(extra) {
      const p = new URLSearchParams({ limit: String(RADIUS_PAGE), ...extra });
      if (rl.status !== "all") p.set("status", rl.status);
      const data = await NOC.api(`/api/radius/logs?${p.toString()}`);
      return Array.isArray(data?.events) ? data.events : [];
    }

    async function carregarCompleto(host) {
      rl.loading = true; rl.full = false;
      rl.map = new Map(); rl.events = []; rl.minId = null; rl.maxId = 0;
      render(host);
      try {
        let cursor = null, pagina = 0;
        for (;;) {
          const lote = await pedir(cursor ? { before_id: String(cursor) } : {});
          acrescentar(lote);
          render(host);
          pagina++;
          if (lote.length < RADIUS_PAGE || pagina >= RADIUS_PAGE_CAP) break;
          cursor = Math.min(...lote.map((ev) => Number(ev.id)));
        }
        rl.full = true;
        rl.checkedAt = new Date().toISOString();
        render(host);
      } catch (err) {
        toast("Não foi possível carregar o log RADIUS", { text: err.message, type: "danger", timeout: 6000 });
        $("#radiusLogBody", host).innerHTML = `<tr><td colspan="6" class="dim">Falha ao carregar: ${esc(err.message)}</td></tr>`;
      } finally {
        rl.loading = false;
      }
    }

    /* Acompanhamento ao vivo: só pede o que é mais novo que o último id
       conhecido. Uma folga de 2 s no `since` evita perder um evento gravado
       no mesmo segundo do corte; o dedupe por id absorve a sobreposição. */
    async function buscarNovos(host) {
      if (rl.loading || !rl.full) return;
      rl.loading = true;
      try {
        const ultimo = rl.map.get(rl.maxId);
        const marca = ultimo?.created_at ? Date.parse(`${String(ultimo.created_at).replace(" ", "T")}Z`) : NaN;
        const extra = Number.isFinite(marca) ? { since: new Date(marca - 2000).toISOString() } : {};
        const lote = await pedir(extra);
        if (acrescentar(lote)) render(host);
        rl.checkedAt = new Date().toISOString();
      } catch { /* silencioso: a próxima rodada de 2 s tenta de novo */ }
      finally { rl.loading = false; }
    }

    modal({
      wide: true,
      labelledBy: "radiusLogTitle",
      html: `
        <div class="modal-head">
          <div><span class="kicker">MONITORAMENTO</span><h2 id="radiusLogTitle">Log RADIUS</h2><p class="dim" style="margin-top:4px">Histórico completo de autenticação PPPoE dos clientes GPON, direto do servidor RADIUS.</p></div>
          <button class="btn btn-ghost btn-icon" data-close type="button" aria-label="Fechar">${icon("close")}</button>
        </div>
        <div class="modal-body stack" style="gap:var(--s-4)">
          <div class="row wrap" style="gap:var(--s-3);align-items:center">
            <div class="input-affix" style="min-width:240px;flex:1 1 240px">
              <span class="affix-icon">${icon("search")}</span>
              <input class="input" id="radiusLogSearch" type="search" placeholder="Cliente, usuário, serial ou OLT…" aria-label="Filtrar eventos do log RADIUS">
            </div>
            <div class="gpon-filters" role="group" aria-label="Estado da autenticação">
              <button class="chip" type="button" data-rstatus="all" aria-pressed="true">Todos</button>
              <button class="chip" type="button" data-rstatus="online" aria-pressed="false">Online</button>
              <button class="chip" type="button" data-rstatus="offline" aria-pressed="false">Offline</button>
            </div>
            <label class="row" style="gap:var(--s-2);align-items:center;font-size:var(--fs-12);white-space:nowrap">
              <input type="checkbox" id="radiusLogAuto" checked> Atualizar a cada 2s
            </label>
            <button class="btn btn-ghost btn-icon btn-sm" id="radiusLogRefresh" type="button" aria-label="Recarregar histórico completo">${icon("refresh")}</button>
          </div>
          <div class="table-wrap">
            <table class="table" aria-label="Eventos de autenticação RADIUS">
              <thead><tr><th>Horário</th><th>Cliente</th><th>Usuário PPPoE</th><th>Transição</th><th>Detalhe</th><th>OLT / PON</th></tr></thead>
              <tbody id="radiusLogBody"><tr><td colspan="6" class="dim">Carregando histórico completo…</td></tr></tbody>
            </table>
          </div>
          <div class="row" style="justify-content:flex-end">
            <span class="dim mono" id="radiusLogCount" style="font-size:var(--fs-11)">—</span>
          </div>
        </div>
        <div class="modal-foot"><span class="dim" style="font-size:var(--fs-11)">Fonte: coletor GPON → RADIUS do IXC.</span><span class="row"><button class="btn btn-primary" data-close type="button">Fechar</button></span></div>`,
      onMount: (mountedHost) => {
        carregarCompleto(mountedHost);
        $("#radiusLogSearch", mountedHost).oninput = (e) => { rl.query = e.target.value; render(mountedHost); };
        $$("[data-rstatus]", mountedHost).forEach((btn) => {
          btn.onclick = () => {
            if (rl.loading) return;
            $$("[data-rstatus]", mountedHost).forEach((b) => b.setAttribute("aria-pressed", String(b === btn)));
            rl.status = btn.dataset.rstatus;
            carregarCompleto(mountedHost);
          };
        });
        $("#radiusLogRefresh", mountedHost).onclick = () => { if (!rl.loading) carregarCompleto(mountedHost); };
        $("#radiusLogAuto", mountedHost).onchange = (e) => { rl.auto = e.target.checked; };
        rl.timer = setInterval(() => {
          if (!document.contains(mountedHost)) { clearInterval(rl.timer); return; }
          if (rl.auto) buscarNovos(mountedHost);
        }, RADIUS_POLL_MS);
      },
    });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", mount); else mount();
})();
