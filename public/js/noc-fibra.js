/* ============================================================
   UPDOWN NOC — camada de caminhos de fibra (PARTE ISP)
   Desenha e edita os dois cadastros do mapa de fibra:

     fibras — polilinhas do cabo (traçado, cordoalha, backbone…)
     caixas — pontos do caminho (CEO, reserva técnica, poste…)

   O mundo do mapa (escala, origem, pan) é da topologia: esta camada
   pede a projeção pela ponte window.TOPO e desenha no mesmo espaço,
   logo abaixo dos enlaces e das caixas dos POPs.

   Gravação: os dois cadastros vão no mesmo documento da topologia,
   por /api/topology?scope=isp, com as ações fibra.edit e fibra.delete.
   ============================================================ */
window.FIBRA = (() => {
  "use strict";
  const { $, $$, esc, icon, toast, modal, drawer, confirm: askConfirm } = UI;

  /* Tipos oferecidos no formulário. A lista é sugestão: o campo aceita
     qualquer texto, porque cada rede nomeia o seu traçado de um jeito. */
  const TIPOS_FIBRA = [
    "Cabo", "Aéreo", "Subterrâneo", "Cabo autossustentado", "Cordoalha",
    "Rota", "Traçado", "Backbone", "Drop de cliente",
  ];
  const TIPOS_CAIXA = [
    "CEO", "Reserva técnica", "Subterrâneo", "Travessia", "Caixa",
    "Poste", "CTO", "DIO", "Ponto de referência",
  ];
  const CORES = [
    ["#22c55e", "Verde"], ["#38bdf8", "Azul"], ["#f59e0b", "Âmbar"],
    ["#ef4444", "Vermelho"], ["#a855f7", "Roxo"], ["#eab308", "Amarelo"],
    ["#06b6d4", "Ciano"], ["#f97316", "Laranja"], ["#94a3b8", "Cinza"],
  ];
  const COR_PADRAO = "#38bdf8";
  const MIN_PONTOS = 2;

  const state = {
    verFibras: true,
    verCaixas: true,
    tipos: new Set(),      // filtro por tipo de fibra
    busca: "",
    selecionada: null,     // fibra em destaque
    /* Edição do traçado: os vértices ficam num rascunho até serem gravados,
       do mesmo jeito que o arrasto dos POPs no mapa geográfico. */
    editando: null,        // { id, pontos: [[lat,lon], …] }
    desenhando: null,      // { pontos: [[lat,lon], …] } — fibra nova
    marcandoCaixa: false,  // próximo clique no mapa vira uma caixa
    sujo: false,
  };

  const dados = () => NOC.data() || {};
  const fibras = () => dados().fibras || [];
  const caixas = () => dados().caixas || [];
  const podeEditar = () => NOC.podeEditarFibra();
  const podeExcluir = () => NOC.podeExcluirFibra();
  const emEdicao = () => Boolean(state.editando || state.desenhando || state.marcandoCaixa);

  /* Pontos em vigor de uma fibra: o rascunho em edição tem prioridade sobre o
     que está gravado, para o traçado responder ao arrasto na hora. */
  const pontosDe = (f) =>
    (state.editando && state.editando.id === f.id ? state.editando.pontos : NOC.pontosDe(f));

  const corDe = (f) => f?.cor || COR_PADRAO;
  const extensao = (f) => NOC.formatarExtensao(NOC.extensaoDe({ pontos: pontosDe(f) }));

  /* ---------------- filtros ---------------- */
  function visiveis() {
    const q = state.busca;
    return fibras().filter((f) => {
      if (state.tipos.size && !state.tipos.has(f.tipo || "Cabo")) return false;
      if (!q) return true;
      return `${f.nome} ${f.tipo} ${f.observacao || ""}`.toLowerCase().includes(q);
    });
  }
  const caixasVisiveis = () => (state.verCaixas ? caixas() : []);

  /* ---------------- limites em coordenadas do Mercator ----------------
     A topologia usa isto para dimensionar o mundo e para "ajustar à tela".
     O resultado é independente da origem e da escala em uso, então continua
     valendo depois de o mapa se reancorar. */
  function limites() {
    if (!window.GEO) return null;
    const pts = [];
    if (state.verFibras) visiveis().forEach((f) => pts.push(...pontosDe(f)));
    caixasVisiveis().forEach((c) => pts.push([c.lat, c.lon]));
    if (state.desenhando) pts.push(...state.desenhando.pontos);
    const proj = pts
      .filter(([lat, lon]) => GEO.isCoord(lat, lon))
      .map(([lat, lon]) => GEO.project(lat, lon));
    if (!proj.length) return null;
    return {
      x0: Math.min(...proj.map((p) => p.x)), y0: Math.min(...proj.map((p) => p.y)),
      x1: Math.max(...proj.map((p) => p.x)), y1: Math.max(...proj.map((p) => p.y)),
    };
  }

  /* ---------------- desenho ---------------- */
  const svg = () => $("#fibras");

  const caminho = (pts) => pts
    .map((p, i) => `${i ? "L" : "M"} ${p.x.toFixed(1)} ${p.y.toFixed(1)}`)
    .join(" ");

  function projetar(pontos) {
    return pontos
      .map(([lat, lon]) => window.TOPO.paraMundo(lat, lon))
      .filter(Boolean);
  }

  /* `desenhar` mexe só no mapa e é o que roda a cada quadro de arrasto;
     `render` também atualiza o painel lateral e é o que a topologia chama
     quando os dados mudam. Separar os dois evita refazer a lista (e perder o
     foco do campo de busca) a cada movimento do ponteiro. */
  function render() {
    desenhar();
    atualizarPainel();
  }

  function desenhar() {
    const host = svg();
    if (!host) return;
    // Fora do mapa geográfico não há onde projetar: a camada some inteira.
    const geo = window.TOPO?.geo?.();
    host.hidden = !geo;
    if (!geo) { host.innerHTML = ""; renderBarra(); return; }

    // O mundo é o mesmo dos enlaces: a área de desenho acompanha a deles.
    const edges = $("#edges");
    if (edges) host.setAttribute("viewBox", edges.getAttribute("viewBox") || "0 0 1000 600");

    const partes = [];
    if (state.verFibras) {
      visiveis().forEach((f) => {
        const pts = projetar(pontosDe(f));
        if (pts.length < 2) return;
        const d = caminho(pts);
        const sel = state.selecionada === f.id;
        const editando = state.editando?.id === f.id;
        const titulo = `${f.nome} — ${f.tipo || "Cabo"}${f.fibras ? ` • ${f.fibras} FO` : ""} • ${extensao(f)}`;
        partes.push(`
          <path class="fibra-linha ${sel ? "is-sel" : ""} ${editando ? "is-editando" : ""}"
                d="${d}" stroke="${esc(corDe(f))}" data-fibra="${esc(f.id)}"><title>${esc(titulo)}</title></path>
          <path class="fibra-hit" d="${d}" data-fibra="${esc(f.id)}"><title>${esc(titulo)}</title></path>`);
      });
    }

    // Caixas ópticas: pontos do caminho, sempre acima das linhas.
    caixasVisiveis().forEach((c) => {
      const p = window.TOPO.paraMundo(c.lat, c.lon);
      if (!p) return;
      partes.push(`
        <g class="fibra-caixa" data-caixa="${esc(c.id)}" transform="translate(${p.x.toFixed(1)} ${p.y.toFixed(1)})">
          <circle class="fibra-caixa-alvo" r="9"/>
          <circle class="fibra-caixa-ponto" r="3.5"/>
          <title>${esc(`${c.nome} — ${c.tipo || "Caixa"}`)}</title>
        </g>`);
    });

    // Vértices do traçado em edição e o desenho em andamento.
    if (state.editando) partes.push(vertices(state.editando.pontos, true));
    if (state.desenhando) partes.push(vertices(state.desenhando.pontos, false, true));

    host.innerHTML = partes.join("");
    ligarEventos(host);
    renderBarra();
  }

  /* Alças de arrasto e pontos de inserção. O marcador "+" fica no meio de cada
     segmento: clicar nele acrescenta um vértice ali, que é como se corrige um
     traçado que passou longe do poste. */
  function vertices(pontos, comInsercao, comLinha = false) {
    const pts = projetar(pontos);
    if (!pts.length) return "";
    const partes = [];
    if (comLinha && pts.length > 1) {
      partes.push(`<path class="fibra-linha is-rascunho" d="${caminho(pts)}" stroke="${COR_PADRAO}"/>`);
    }
    if (comInsercao) {
      for (let i = 1; i < pts.length; i++) {
        const mx = (pts[i - 1].x + pts[i].x) / 2, my = (pts[i - 1].y + pts[i].y) / 2;
        partes.push(`
          <g class="fibra-inserir" data-inserir="${i}" transform="translate(${mx.toFixed(1)} ${my.toFixed(1)})">
            <circle r="6"/><path d="M-3 0h6M0 -3v6"/>
            <title>Inserir um ponto aqui</title>
          </g>`);
      }
    }
    pts.forEach((p, i) => partes.push(`
      <circle class="fibra-vertice" data-vertice="${i}" r="5"
              cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}">
        <title>Ponto ${i + 1} de ${pts.length}${comInsercao ? " — arraste para mover, botão direito remove" : ""}</title>
      </circle>`));
    return partes.join("");
  }

  /* ---------------- eventos do mapa ---------------- */
  function ligarEventos(host) {
    $$("[data-fibra]", host).forEach((el) => {
      el.addEventListener("click", (ev) => {
        ev.stopPropagation();
        // Durante a edição do traçado, clicar na própria linha não reabre nada.
        if (emEdicao()) return;
        abrirFibra(el.dataset.fibra);
      });
    });
    $$("[data-caixa]", host).forEach((el) => {
      el.addEventListener("click", (ev) => {
        ev.stopPropagation();
        if (emEdicao()) return;
        abrirCaixa(el.dataset.caixa);
      });
    });
    $$("[data-inserir]", host).forEach((el) => {
      el.addEventListener("click", (ev) => {
        ev.stopPropagation();
        const i = Number(el.dataset.inserir);
        const pts = state.editando.pontos;
        const meio = [
          (pts[i - 1][0] + pts[i][0]) / 2,
          (pts[i - 1][1] + pts[i][1]) / 2,
        ];
        pts.splice(i, 0, meio);
        state.sujo = true;
        render();
      });
    });
    $$("[data-vertice]", host).forEach((el) => arrastarVertice(el));
  }

  /* Arrasto de um vértice: converte o ponteiro em coordenada geográfica a cada
     quadro, como o arrasto de POP no mapa faz com a localização. */
  function arrastarVertice(el) {
    const lista = () => (state.editando ? state.editando.pontos : state.desenhando?.pontos);
    const i = Number(el.dataset.vertice);
    let arrastando = false, quadro = null;

    el.addEventListener("pointerdown", (ev) => {
      if (ev.button !== 0 || !lista()) return;
      ev.preventDefault();
      ev.stopPropagation();
      arrastando = true;
      try { el.setPointerCapture(ev.pointerId); } catch (e) { /* navegador antigo */ }
      el.classList.add("is-dragging");
    });
    el.addEventListener("pointermove", (ev) => {
      if (!arrastando) return;
      const p = window.TOPO.pontoDoEvento(ev);
      const c = window.TOPO.paraCoords(p.x, p.y);
      const pts = lista();
      if (!pts || !pts[i]) return;
      pts[i] = [Number(c.lat.toFixed(6)), Number(c.lon.toFixed(6))];
      state.sujo = true;
      // A cada quadro só o mapa é redesenhado; o painel espera o ponteiro soltar.
      if (!quadro) quadro = requestAnimationFrame(() => { quadro = null; desenhar(); });
    });
    const soltar = () => {
      if (!arrastando) return;
      arrastando = false;
      el.classList.remove("is-dragging");
      render();
    };
    el.addEventListener("pointerup", soltar);
    el.addEventListener("pointercancel", soltar);

    // Botão direito remove o vértice, desde que o traçado continue sendo linha.
    el.addEventListener("contextmenu", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      const pts = lista();
      if (!pts) return;
      if (pts.length <= MIN_PONTOS) {
        toast("O traçado precisa de pelo menos dois pontos", { type: "warn" });
        return;
      }
      pts.splice(i, 1);
      state.sujo = true;
      render();
    });
  }

  /* Cliques no palco durante o desenho: cada clique acrescenta um ponto. O
     ouvinte é de captura, porque o arrasto do mapa também escuta o palco e sem
     isso o primeiro clique viraria um pan. */
  function ligarPalco() {
    const palco = window.TOPO?.palco?.();
    if (!palco) return;
    palco.addEventListener("pointerdown", (ev) => {
      if (!state.desenhando && !state.marcandoCaixa) return;
      if (ev.button !== 0 || ev.target.closest("[data-vertice], [data-inserir], .topo-hud")) return;
      ev.stopPropagation();
    }, true);

    palco.addEventListener("click", (ev) => {
      if (!state.desenhando && !state.marcandoCaixa) return;
      if (ev.target.closest("[data-vertice], [data-inserir], .topo-hud")) return;
      ev.stopPropagation();
      const p = window.TOPO.pontoDoEvento(ev);
      const c = window.TOPO.paraCoords(p.x, p.y);
      const par = [Number(c.lat.toFixed(6)), Number(c.lon.toFixed(6))];
      if (state.marcandoCaixa) { state.marcandoCaixa = false; novaCaixaEm(par); return; }
      state.desenhando.pontos.push(par);
      state.sujo = true;
      desenhar();
    }, true);

    // Enter fecha o desenho; Esc desiste dele — o mesmo par de qualquer editor.
    palco.addEventListener("keydown", (ev) => {
      if (!emEdicao()) return;
      if (ev.key === "Enter") { ev.preventDefault(); ev.stopPropagation(); concluir(); }
      if (ev.key === "Escape") { ev.preventDefault(); ev.stopPropagation(); descartar(); }
    });
    // Duplo clique encerra a linha, como no Google Earth.
    palco.addEventListener("dblclick", (ev) => {
      if (!state.desenhando) return;
      ev.preventDefault();
      ev.stopPropagation();
      concluir();
    }, true);
  }

  /* ---------------- barra de edição ---------------- */
  function renderBarra() {
    const bar = $("#fibraBar");
    if (!bar) return;
    bar.hidden = !emEdicao();
    if (!emEdicao()) return;
    const titulo = $("#fibraBarTitulo"), status = $("#fibraBarStatus");
    if (state.marcandoCaixa) {
      titulo.textContent = "Marcando uma caixa";
      status.textContent = "clique no ponto do mapa onde ela fica";
    } else if (state.desenhando) {
      const n = state.desenhando.pontos.length;
      titulo.textContent = "Desenhando o caminho de fibra";
      status.textContent = n < MIN_PONTOS
        ? "clique no mapa para marcar o primeiro ponto"
        : `${n} pontos • ${NOC.formatarExtensao(NOC.extensaoDe({ pontos: state.desenhando.pontos }))} — duplo clique ou Enter conclui`;
    } else {
      const f = NOC.fibraById(state.editando.id);
      titulo.textContent = `Editando o traçado de ${f?.nome || "—"}`;
      status.textContent = `${state.editando.pontos.length} pontos • ${NOC.formatarExtensao(NOC.extensaoDe({ pontos: state.editando.pontos }))}`
        + " — arraste os pontos, use + para inserir e o botão direito para remover";
    }
    $("#fibraBarSalvar").disabled = state.desenhando
      ? state.desenhando.pontos.length < MIN_PONTOS
      : !state.sujo;
    $("#fibraBarSalvar").hidden = state.marcandoCaixa;
  }

  /* ---------------- painel lateral ----------------
     O esqueleto é montado uma vez; só a lista, os filtros e os contadores são
     refeitos. Assim o campo de busca é sempre o mesmo elemento e não perde o
     foco a cada tecla digitada. */
  function montarPainel() {
    const host = $("#fibraPanel");
    if (!host || host.dataset.pronto) return;
    host.dataset.pronto = "1";
    host.innerHTML = `
      <div class="row-between">
        <span class="kicker">Caminhos de fibra</span>
        <span class="dim" style="font-size:var(--fs-11)" data-contagem>—</span>
      </div>

      <div class="input-affix">
        <span class="affix-icon">${icon("search")}</span>
        <input class="input" id="fibraBusca" type="search" placeholder="Filtrar cabo ou traçado…"
               aria-label="Filtrar caminhos de fibra">
      </div>

      <div class="row wrap" style="gap:6px" role="group" aria-label="Camadas do mapa" data-camadas></div>
      <div class="row wrap" style="gap:6px" role="group" aria-label="Filtrar por tipo de traçado" data-tipos></div>

      <div class="row-between" style="font-size:var(--fs-11)">
        <span class="dim" data-total>—</span>
        <button class="btn btn-ghost btn-sm" type="button" id="fibraLimpar">Limpar</button>
      </div>

      <div class="topo-side-scroll grow"><div class="device-list" data-lista></div></div>`;

    $("#fibraBusca", host).addEventListener("input", (e) => {
      state.busca = e.target.value.trim().toLowerCase();
      render();
    });
    $("#fibraLimpar", host).onclick = () => {
      state.busca = "";
      state.tipos.clear();
      $("#fibraBusca", host).value = "";
      render();
    };
  }

  function atualizarPainel() {
    const host = $("#fibraPanel");
    if (!host) return;
    montarPainel();
    const todas = fibras();
    const lista = visiveis();
    const tipos = [...new Set(todas.map((f) => f.tipo || "Cabo"))].sort();

    $("[data-contagem]", host).textContent = `${lista.length} de ${todas.length}`;
    $("[data-total]", host).textContent =
      `${NOC.formatarExtensao(lista.reduce((a, f) => a + NOC.extensaoDe({ pontos: pontosDe(f) }), 0))} em exibição`;

    $("[data-camadas]", host).innerHTML = `
      <button class="chip" type="button" data-camada="fibras" aria-pressed="${state.verFibras}">Fibras <span class="count">${todas.length}</span></button>
      <button class="chip" type="button" data-camada="caixas" aria-pressed="${state.verCaixas}">Caixas <span class="count">${caixas().length}</span></button>`;
    $$("[data-camada]", host).forEach((b) => (b.onclick = () => {
      if (b.dataset.camada === "fibras") state.verFibras = !state.verFibras;
      else state.verCaixas = !state.verCaixas;
      // O tamanho do mundo depende das camadas visíveis: repintar é da topologia.
      window.TOPO.repintar();
    }));

    $("[data-tipos]", host).innerHTML = tipos.map((t) => {
      const n = todas.filter((f) => (f.tipo || "Cabo") === t).length;
      return `<button class="chip" type="button" data-tipo="${esc(t)}" aria-pressed="${state.tipos.has(t)}">${esc(t)} <span class="count">${n}</span></button>`;
    }).join("");
    $$("[data-tipo]", host).forEach((b) => (b.onclick = () => {
      const t = b.dataset.tipo;
      state.tipos.has(t) ? state.tipos.delete(t) : state.tipos.add(t);
      render();
    }));

    $("[data-lista]", host).innerHTML = lista.length
      ? lista.map((f) => `
          <button class="device-item fibra-item" type="button" data-abrir="${esc(f.id)}"
                  aria-current="${state.selecionada === f.id}">
            <span class="row-between">
              <b>${esc(f.nome)}</b>
              <i class="fibra-amostra" style="background:${esc(corDe(f))}" aria-hidden="true"></i>
            </span>
            <small>${esc(f.tipo || "Cabo")}${f.fibras ? ` • ${f.fibras} FO` : ""} • ${esc(extensao(f))}</small>
          </button>`).join("")
      : `<div class="empty"><span class="empty-icon">${icon("search")}</span><b>Nenhum caminho encontrado</b>
           <p>Ajuste a busca ou remova os filtros de tipo.</p></div>`;
    $$("[data-abrir]", host).forEach((b) => (b.onclick = () => abrirFibra(b.dataset.abrir)));
  }

  /* ---------------- gravação ---------------- */
  async function gravar(motivo, mensagem, undo) {
    return window.TOPO.persistir(motivo, mensagem, undo);
  }

  /* Garante as listas no documento antes de alterá-las: um recorte que ainda
     não tem fibra cadastrada chega sem os campos. */
  function listas() {
    const t = NOC.data();
    if (!Array.isArray(t.fibras)) t.fibras = [];
    if (!Array.isArray(t.caixas)) t.caixas = [];
    return t;
  }

  /* ---------------- fibra: detalhe e formulário ---------------- */
  function abrirFibra(id) {
    const f = NOC.fibraById(id);
    if (!f) return;
    state.selecionada = id;
    render();

    const pts = pontosDe(f);
    drawer({
      labelledBy: "fibraTitulo",
      html: `
        <header class="drawer-head">
          <div class="row-between" style="align-items:flex-start">
            <div>
              <span class="kicker">Caminho de fibra${f.origem ? ` • ${esc(f.origem)}` : ""}</span>
              <h2 id="fibraTitulo" style="margin:6px 0 4px">${esc(f.nome)}</h2>
              <p class="muted mono" style="font-size:var(--fs-12)">${esc(f.id)}</p>
            </div>
            <button class="btn btn-ghost btn-icon" data-close type="button" aria-label="Fechar detalhe">${icon("close")}</button>
          </div>
          <div class="row wrap" style="gap:6px;margin-top:var(--s-4)">
            <span class="badge"><i class="fibra-amostra" style="background:${esc(corDe(f))}"></i>${esc(f.tipo || "Cabo")}</span>
            ${f.fibras ? `<span class="badge badge-info">${Number(f.fibras)} fibras</span>` : ""}
            <span class="badge">${esc(extensao(f))}</span>
            <span class="badge">${pts.length} pontos</span>
          </div>
        </header>
        <div class="drawer-body stack">
          ${f.observacao ? `<div class="card" style="padding:var(--s-3)"><p class="texto-livre" style="font-size:var(--fs-13)">${esc(f.observacao)}</p></div>` : ""}
          <div class="table-wrap">
            <table class="table">
              <tbody>
                <tr><td>Início</td><td class="mono">${pts.length ? esc(GEO.label(pts[0][0], pts[0][1])) : "—"}</td></tr>
                <tr><td>Fim</td><td class="mono">${pts.length ? esc(GEO.label(pts[pts.length - 1][0], pts[pts.length - 1][1])) : "—"}</td></tr>
                <tr><td>Extensão</td><td class="mono">${esc(extensao(f))}</td></tr>
              </tbody>
            </table>
          </div>
          <div class="row wrap" style="gap:var(--s-2)">
            <button class="btn btn-sm" type="button" data-localizar>${icon("fit")} Enquadrar no mapa</button>
            <button class="btn btn-sm" type="button" data-tracado ${podeEditar() ? "" : "disabled title='Requer topology.edit + fibra.edit'"}>${icon("edit")} Editar traçado</button>
          </div>
        </div>
        <footer class="drawer-foot">
          <span class="dim" style="font-size:var(--fs-11)">${podeEditar()
            ? "Alterações são auditadas com usuário, IP e data/hora."
            : "Seu perfil tem acesso somente de leitura aos caminhos de fibra."}</span>
          <span class="row">
            <button class="btn btn-sm btn-danger" type="button" data-excluir
              ${podeExcluir() ? "" : "disabled title='Requer topology.delete + fibra.delete'"}>Excluir</button>
            <button class="btn btn-sm btn-primary" type="button" data-editar
              ${podeEditar() ? "" : "disabled title='Requer topology.edit + fibra.edit'"}>Editar cadastro</button>
          </span>
        </footer>`,
      onMount: (host, close) => {
        $("[data-localizar]", host).onclick = () => {
          close();
          if (pts.length) window.TOPO.enquadrarPontos(pts);
        };
        $("[data-tracado]", host).onclick = () => { close(); editarTracado(f.id); };
        $("[data-editar]", host).onclick = () => { close(); formFibra(f); };
        $("[data-excluir]", host).onclick = () => { close(); excluirFibra(f); };
      },
    });
  }

  const opcoes = (lista, atual) => lista
    .map((t) => `<option value="${esc(t)}" ${t === atual ? "selected" : ""}>${esc(t)}</option>`)
    .join("");

  /* Cadastro da fibra. `pontos` só é informado quando o formulário fecha o
     desenho de uma fibra nova — nesse caso o registro ainda não existe. */
  function formFibra(fibra, pontosNovos = null) {
    const novo = !fibra;
    const f = fibra || { nome: "", tipo: "Cabo", cor: COR_PADRAO, fibras: null, observacao: "" };
    const extensaoPrevia = NOC.formatarExtensao(NOC.extensaoDe({ pontos: pontosNovos || pontosDe(f) }));

    modal({
      labelledBy: "formFibraTitulo",
      html: `
        <div class="modal-head">
          <div>
            <span class="kicker">Caminho de fibra</span>
            <h2 id="formFibraTitulo" style="margin-top:6px">${novo ? "Nova fibra" : esc(f.nome)}</h2>
            <p class="muted" style="font-size:var(--fs-12);margin-top:4px">${esc(extensaoPrevia)} • ${(pontosNovos || pontosDe(f)).length} pontos</p>
          </div>
          <button class="btn btn-ghost btn-icon" data-close type="button" aria-label="Fechar">${icon("close")}</button>
        </div>
        <div class="modal-body">
          <form class="stack" id="formFibra">
            <div class="field"><label for="ffNome">Nome</label>
              <input class="input" id="ffNome" value="${esc(f.nome || "")}" placeholder="CABO 12 FO — POP PG × Casqueiro" required></div>
            <div class="row" style="gap:var(--s-3);align-items:flex-start">
              <div class="field grow"><label for="ffTipo">Tipo</label>
                <select class="input" id="ffTipo">${opcoes(
                  [...new Set([...TIPOS_FIBRA, f.tipo].filter(Boolean))], f.tipo || "Cabo")}</select></div>
              <div class="field grow"><label for="ffFibras">Quantidade de fibras</label>
                <input class="input mono" id="ffFibras" inputmode="numeric" placeholder="12"
                       value="${f.fibras ? Number(f.fibras) : ""}"></div>
            </div>
            <div class="field"><label for="ffCor">Cor no mapa</label>
              <select class="input" id="ffCor">${CORES
                .map(([hex, nome]) => `<option value="${hex}" ${hex === corDe(f) ? "selected" : ""}>${nome}</option>`)
                .join("")}</select>
              <span class="field-hint">A cor separa os feixes no mapa; não altera o cadastro do cabo.</span></div>
            <div class="field"><label for="ffObs">Observação</label>
              <textarea class="input" id="ffObs" rows="3" placeholder="Lote, fusões, referência em campo…">${esc(f.observacao || "")}</textarea></div>
          </form>
        </div>
        <div class="modal-foot">
          <span class="dim" style="font-size:var(--fs-11)">O traçado é editado no mapa, ponto a ponto.</span>
          <span class="row">
            <button class="btn" data-close type="button">Cancelar</button>
            <button class="btn btn-primary" type="button" data-save>${novo ? "Cadastrar fibra" : "Salvar"}</button>
          </span>
        </div>`,
      onMount: (host, close) => {
        $("[data-save]", host).onclick = async () => {
          const nome = $("#ffNome", host).value.trim();
          if (!nome) { $("#ffNome", host).focus(); return; }
          const qtd = Number($("#ffFibras", host).value.trim());
          const valores = {
            nome,
            tipo: $("#ffTipo", host).value,
            cor: $("#ffCor", host).value,
            fibras: Number.isFinite(qtd) && qtd > 0 ? Math.round(qtd) : null,
            observacao: $("#ffObs", host).value.trim(),
          };

          const t = listas();
          if (novo) {
            const registro = {
              id: NOC.novoId("fib", nome, t.fibras),
              ...valores,
              origem: "Cadastro na tela",
              extensao: NOC.extensaoDe({ pontos: pontosNovos }),
              pontos: pontosNovos,
            };
            t.fibras.push(registro);
            close();
            const ok = await gravar("TOPOLOGY_FIBRA_CREATE", {
              titulo: `${nome} cadastrada`,
              texto: `${NOC.formatarExtensao(registro.extensao)} em ${pontosNovos.length} pontos.`,
            }, async () => {
              t.fibras = t.fibras.filter((x) => x.id !== registro.id);
              await gravar("TOPOLOGY_FIBRA_DELETE", { titulo: "Cadastro desfeito", tipo: "info" });
            });
            if (!ok) t.fibras = t.fibras.filter((x) => x.id !== registro.id);
            else { state.selecionada = registro.id; render(); }
            return;
          }

          const antes = { nome: f.nome, tipo: f.tipo, cor: f.cor, fibras: f.fibras ?? null, observacao: f.observacao || "" };
          const aplicar = (v) => Object.assign(f, v);
          aplicar(valores);
          close();
          const ok = await gravar("TOPOLOGY_FIBRA_UPDATE", { titulo: `${nome} atualizada` },
            async () => {
              aplicar(antes);
              await gravar("TOPOLOGY_FIBRA_UPDATE", { titulo: "Cadastro anterior restaurado", tipo: "info" });
            });
          if (!ok) aplicar(antes);
        };
      },
    });
  }

  function excluirFibra(f) {
    askConfirm({
      title: `Excluir ${f.nome}?`,
      text: "O traçado sai do mapa para todos os usuários. A ação fica registrada na auditoria e pode ser desfeita pelo aviso.",
      confirmLabel: "Excluir caminho",
      danger: true,
      onConfirm: async () => {
        const t = listas();
        const posicao = t.fibras.findIndex((x) => x.id === f.id);
        if (posicao < 0) return;
        t.fibras.splice(posicao, 1);
        if (state.selecionada === f.id) state.selecionada = null;
        const ok = await gravar("TOPOLOGY_FIBRA_DELETE",
          { titulo: `${f.nome} removida`, tipo: "warn" },
          async () => {
            t.fibras.splice(posicao, 0, f);
            await gravar("TOPOLOGY_FIBRA_CREATE", { titulo: "Caminho restaurado", tipo: "info" });
          });
        if (!ok) t.fibras.splice(posicao, 0, f);
      },
    });
  }

  /* ---------------- edição do traçado ---------------- */
  function editarTracado(id) {
    const f = NOC.fibraById(id);
    if (!f || !podeEditar()) return;
    if (!window.TOPO.geo()) {
      toast("Mude para o mapa geográfico", { text: "O traçado só pode ser ajustado sobre o mapa.", type: "warn" });
      return;
    }
    state.editando = { id, pontos: NOC.pontosDe(f).map((p) => [...p]) };
    state.selecionada = id;
    state.sujo = false;
    if (state.editando.pontos.length) window.TOPO.enquadrarPontos(state.editando.pontos);
    else render();
  }

  function novaFibra() {
    if (!podeEditar()) return;
    if (!window.TOPO.geo()) {
      toast("Mude para o mapa geográfico", { text: "O caminho é desenhado sobre o mapa.", type: "warn" });
      return;
    }
    state.desenhando = { pontos: [] };
    state.editando = null;
    state.sujo = false;
    window.TOPO.palco()?.focus({ preventScroll: true });
    render();
  }

  function novaCaixa() {
    if (!podeEditar()) return;
    if (!window.TOPO.geo()) {
      toast("Mude para o mapa geográfico", { text: "A caixa é marcada sobre o mapa.", type: "warn" });
      return;
    }
    state.marcandoCaixa = true;
    window.TOPO.palco()?.focus({ preventScroll: true });
    render();
  }

  /* Conclui o que estiver em edição: grava o traçado ajustado ou abre o
     cadastro da fibra recém-desenhada. */
  async function concluir() {
    if (state.marcandoCaixa) { state.marcandoCaixa = false; render(); return; }

    if (state.desenhando) {
      const pontos = state.desenhando.pontos;
      if (pontos.length < MIN_PONTOS) {
        toast("Marque pelo menos dois pontos", { text: "Um caminho de fibra é uma linha entre dois pontos.", type: "warn" });
        return;
      }
      const copia = pontos.map((p) => [...p]);
      state.desenhando = null;
      state.sujo = false;
      render();
      formFibra(null, copia);
      return;
    }

    if (!state.editando) return;
    const f = NOC.fibraById(state.editando.id);
    if (!f) { state.editando = null; render(); return; }
    if (state.editando.pontos.length < MIN_PONTOS) {
      toast("O traçado precisa de pelo menos dois pontos", { type: "warn" });
      return;
    }
    const antes = { pontos: NOC.pontosDe(f).map((p) => [...p]), extensao: f.extensao };
    const depois = { pontos: state.editando.pontos.map((p) => [...p]) };
    depois.extensao = NOC.extensaoDe(depois);
    state.editando = null;
    state.sujo = false;
    Object.assign(f, depois);

    const ok = await gravar("TOPOLOGY_FIBRA_TRACADO", {
      titulo: `Traçado de ${f.nome} atualizado`,
      texto: `${depois.pontos.length} pontos • ${NOC.formatarExtensao(depois.extensao)}.`,
    }, async () => {
      Object.assign(f, antes);
      await gravar("TOPOLOGY_FIBRA_TRACADO", { titulo: "Traçado anterior restaurado", tipo: "info" });
    });
    if (!ok) Object.assign(f, antes);
    render();
  }

  function descartar() {
    if (!emEdicao()) return;
    const perder = state.sujo && (state.editando || state.desenhando);
    const sair = () => {
      state.editando = null;
      state.desenhando = null;
      state.marcandoCaixa = false;
      state.sujo = false;
      window.TOPO.repintar();
    };
    if (!perder) return sair();
    askConfirm({
      title: "Descartar o que foi desenhado?",
      text: "Os pontos marcados agora são perdidos; o traçado gravado continua como está.",
      confirmLabel: "Descartar",
      danger: true,
      onConfirm: sair,
    });
  }

  /* ---------------- caixas ópticas ---------------- */
  function novaCaixaEm(par) {
    formCaixa(null, par);
  }

  function abrirCaixa(id) {
    const c = NOC.caixaById(id);
    if (!c) return;
    modal({
      labelledBy: "caixaTitulo",
      html: `
        <div class="modal-head">
          <div>
            <span class="kicker">Ponto do caminho de fibra${c.origem ? ` • ${esc(c.origem)}` : ""}</span>
            <h2 id="caixaTitulo" style="margin-top:6px">${esc(c.nome)}</h2>
            <p class="muted mono" style="font-size:var(--fs-12);margin-top:4px">${esc(GEO.label(c.lat, c.lon))}</p>
          </div>
          <button class="btn btn-ghost btn-icon" data-close type="button" aria-label="Fechar">${icon("close")}</button>
        </div>
        <div class="modal-body stack">
          <div class="row wrap" style="gap:6px">
            <span class="badge">${esc(c.tipo || "Caixa")}</span>
            <a class="btn btn-ghost btn-sm" target="_blank" rel="noopener noreferrer"
               href="https://www.openstreetmap.org/?mlat=${encodeURIComponent(c.lat)}&mlon=${encodeURIComponent(c.lon)}#map=18/${encodeURIComponent(c.lat)}/${encodeURIComponent(c.lon)}">Ver no OpenStreetMap</a>
          </div>
          ${c.observacao ? `<div class="card" style="padding:var(--s-3)"><p class="texto-livre" style="font-size:var(--fs-13)">${esc(c.observacao)}</p></div>` : ""}
        </div>
        <div class="modal-foot">
          <span class="row">
            <button class="btn btn-sm btn-danger" type="button" data-excluir
              ${podeExcluir() ? "" : "disabled title='Requer topology.delete + fibra.delete'"}>Excluir</button>
          </span>
          <span class="row">
            <button class="btn" data-close type="button">Fechar</button>
            <button class="btn btn-primary" type="button" data-editar
              ${podeEditar() ? "" : "disabled title='Requer topology.edit + fibra.edit'"}>Editar</button>
          </span>
        </div>`,
      onMount: (host, close) => {
        $("[data-editar]", host).onclick = () => { close(); formCaixa(c); };
        $("[data-excluir]", host).onclick = () => { close(); excluirCaixa(c); };
      },
    });
  }

  function formCaixa(caixa, parNovo = null) {
    const novo = !caixa;
    const c = caixa || { nome: "", tipo: "CEO", observacao: "", lat: parNovo?.[0], lon: parNovo?.[1] };

    modal({
      labelledBy: "formCaixaTitulo",
      html: `
        <div class="modal-head">
          <div>
            <span class="kicker">Ponto do caminho de fibra</span>
            <h2 id="formCaixaTitulo" style="margin-top:6px">${novo ? "Nova caixa" : esc(c.nome)}</h2>
          </div>
          <button class="btn btn-ghost btn-icon" data-close type="button" aria-label="Fechar">${icon("close")}</button>
        </div>
        <div class="modal-body">
          <form class="stack" id="formCaixa">
            <div class="field"><label for="fcNome">Nome</label>
              <input class="input" id="fcNome" value="${esc(c.nome || "")}" placeholder="CEO 1645M" required></div>
            <div class="field"><label for="fcTipo">Tipo</label>
              <select class="input" id="fcTipo">${opcoes(
                [...new Set([...TIPOS_CAIXA, c.tipo].filter(Boolean))], c.tipo || "CEO")}</select></div>
            <div class="row" style="gap:var(--s-3);align-items:flex-start">
              <div class="field grow"><label for="fcLat">Latitude</label>
                <input class="input mono" id="fcLat" inputmode="decimal" value="${esc(GEO.fmt(c.lat))}" required></div>
              <div class="field grow"><label for="fcLon">Longitude</label>
                <input class="input mono" id="fcLon" inputmode="decimal" value="${esc(GEO.fmt(c.lon))}" required></div>
            </div>
            <div class="field"><label for="fcColar">Colar coordenadas</label>
              <input class="input mono" id="fcColar" placeholder="-23.960833, -46.333611"></div>
            <div class="field"><label for="fcObs">Observação</label>
              <textarea class="input" id="fcObs" rows="3" placeholder="Fusões, reserva, referência em campo…">${esc(c.observacao || "")}</textarea></div>
          </form>
        </div>
        <div class="modal-foot">
          <span class="dim" style="font-size:var(--fs-11)">A alteração vai para a auditoria.</span>
          <span class="row">
            <button class="btn" data-close type="button">Cancelar</button>
            <button class="btn btn-primary" type="button" data-save>${novo ? "Cadastrar caixa" : "Salvar"}</button>
          </span>
        </div>`,
      onMount: (host, close) => {
        const lat = $("#fcLat", host), lon = $("#fcLon", host), colar = $("#fcColar", host);
        const espalhar = () => {
          const par = GEO.parseCoords(colar.value);
          if (!par) return;
          lat.value = GEO.fmt(par.lat);
          lon.value = GEO.fmt(par.lon);
          colar.value = "";
        };
        colar.addEventListener("paste", () => setTimeout(espalhar, 0));
        colar.addEventListener("change", espalhar);

        $("[data-save]", host).onclick = async () => {
          espalhar();
          const nome = $("#fcNome", host).value.trim();
          if (!nome) { $("#fcNome", host).focus(); return; }
          const n = (v) => Number(String(v).trim().replace(",", "."));
          if (!GEO.isCoord(n(lat.value), n(lon.value))) {
            toast("Localização inválida", { text: "Informe latitude (−90 a 90) e longitude (−180 a 180).", type: "warn" });
            return;
          }
          const valores = {
            nome,
            tipo: $("#fcTipo", host).value,
            observacao: $("#fcObs", host).value.trim(),
            lat: Number(n(lat.value).toFixed(6)),
            lon: Number(n(lon.value).toFixed(6)),
          };

          const t = listas();
          if (novo) {
            const registro = { id: NOC.novoId("cx", nome, t.caixas), ...valores, origem: "Cadastro na tela" };
            t.caixas.push(registro);
            close();
            const ok = await gravar("TOPOLOGY_CAIXA_CREATE",
              { titulo: `${nome} cadastrada`, texto: `Marcada em ${GEO.label(registro.lat, registro.lon)}.` },
              async () => {
                t.caixas = t.caixas.filter((x) => x.id !== registro.id);
                await gravar("TOPOLOGY_CAIXA_DELETE", { titulo: "Cadastro desfeito", tipo: "info" });
              });
            if (!ok) t.caixas = t.caixas.filter((x) => x.id !== registro.id);
            return;
          }

          const antes = { nome: c.nome, tipo: c.tipo, observacao: c.observacao || "", lat: c.lat, lon: c.lon };
          Object.assign(c, valores);
          close();
          const ok = await gravar("TOPOLOGY_CAIXA_UPDATE", { titulo: `${nome} atualizada` },
            async () => {
              Object.assign(c, antes);
              await gravar("TOPOLOGY_CAIXA_UPDATE", { titulo: "Cadastro anterior restaurado", tipo: "info" });
            });
          if (!ok) Object.assign(c, antes);
        };
      },
    });
  }

  function excluirCaixa(c) {
    askConfirm({
      title: `Excluir ${c.nome}?`,
      text: "O ponto sai do mapa para todos os usuários.",
      confirmLabel: "Excluir ponto",
      danger: true,
      onConfirm: async () => {
        const t = listas();
        const posicao = t.caixas.findIndex((x) => x.id === c.id);
        if (posicao < 0) return;
        t.caixas.splice(posicao, 1);
        const ok = await gravar("TOPOLOGY_CAIXA_DELETE",
          { titulo: `${c.nome} removida`, tipo: "warn" },
          async () => {
            t.caixas.splice(posicao, 0, c);
            await gravar("TOPOLOGY_CAIXA_CREATE", { titulo: "Ponto restaurado", tipo: "info" });
          });
        if (!ok) t.caixas.splice(posicao, 0, c);
      },
    });
  }

  /* ---------------- barra de ferramentas ---------------- */
  function ligarBotoes() {
    const nova = $("#btnFibraNova");
    if (nova) nova.onclick = novaFibra;
    const caixa = $("#btnCaixaNova");
    if (caixa) caixa.onclick = novaCaixa;
    const salvar = $("#fibraBarSalvar");
    if (salvar) salvar.onclick = concluir;
    const cancelar = $("#fibraBarCancelar");
    if (cancelar) cancelar.onclick = descartar;
  }

  /* Sai da tela com traçado pendente é perder o desenho em silêncio. */
  addEventListener("beforeunload", (e) => {
    if (!state.sujo || !emEdicao()) return;
    e.preventDefault();
    e.returnValue = "";
  });

  /* A topologia carrega os dados e chama render() na primeira repintura; aqui
     só é preciso preparar os ouvintes do palco e da barra. */
  function iniciar() {
    ligarPalco();
    ligarBotoes();
    render();
  }
  if (document.readyState === "loading") addEventListener("DOMContentLoaded", iniciar);
  else queueMicrotask(iniciar);

  return {
    render, limites, novaFibra, novaCaixa, editarTracado, abrirFibra, abrirCaixa,
    /* A paleta de comandos da tela usa isto para oferecer as fibras na busca. */
    itensDeBusca: () => fibras().map((f) => ({
      group: "Caminhos de fibra", label: f.nome, icon: "link",
      hint: `${f.tipo || "Cabo"}${f.fibras ? ` • ${f.fibras} FO` : ""} • ${extensao(f)}`,
      run: () => abrirFibra(f.id),
    })),
  };
})();
