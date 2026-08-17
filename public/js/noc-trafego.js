/* ============================================================
   UPDOWN NOC — Painel de tráfego
   Lê o espelho do Zabbix no D1 (/api/zabbix/overview). Nada é
   inventado aqui: os números vêm do SNMP, e o que esta tela
   calcula é só utilização, agregados e a série do período.

   Organização: seis guias sobre um mesmo estado. Cada bloco do
   painel é uma função que devolve HTML, e tanto as guias quanto o
   modo telão compõem a partir dos mesmos blocos — o telão nunca
   mostra um número diferente do que a tela de trabalho mostra.
   ============================================================ */
(() => {
  "use strict";
  const { $, $$, esc, icon, toast } = UI;

  const bps = (v) => NOC.formatBps(v);
  const collator = new Intl.Collator("pt-BR", { numeric: true, sensitivity: "base" });
  const inteiro = (v) => Number(v || 0).toLocaleString("pt-BR");
  const AUTO_REFRESH_SECONDS = 1;

  const GUIAS = [
    { id: "visao", label: "Visão geral", icon: "dashboard" },
    { id: "enlaces", label: "Enlaces", icon: "link" },
    { id: "interfaces", label: "Interfaces", icon: "port" },
    { id: "equipamentos", label: "Equipamentos", icon: "topology" },
    { id: "alertas", label: "Alertas", icon: "alert" },
    { id: "ajustes", label: "Ajustes", icon: "platform" },
  ];

  const PAINEIS_TV = {
    kpis: "Indicadores",
    fluxo: "Fluxo do período",
    top: "Maiores consumidores",
    alertas: "Alertas",
    enlaces: "Enlaces confirmados",
    equipamentos: "Equipamentos",
  };

  const AJUSTES_PADRAO = {
    titulo: "Tráfego da rede",
    limiteAtencao: 70,
    limiteCritico: 85,
    intervaloSegundos: 60,
    toleranciaLeitura: 1.05,
    topN: 10,
    historicoHoras: 6,
    tvPaineis: ["kpis", "fluxo", "top", "alertas"],
    tvRotacaoSegundos: 20,
    tvZoom: 100,
    interfaces: {},
  };

  const state = {
    settings: { ...AJUSTES_PADRAO },
    podeEditarSettings: false,
    interfaces: [],
    links: [],
    hosts: [],
    status: null,
    historico: [],
    guia: "visao",
    densidade: "confortavel",
    /* Janela do gráfico em uso agora. Começa no valor salvo, mas os botões de
       período a mudam só para esta sessão — sem isto, a recarga automática
       devolvia a janela salva 60 s depois de a pessoa escolher outra. Salvar
       nos Ajustes é o que torna a escolha o padrão de todos. */
    horas: AJUSTES_PADRAO.historicoHoras,
    filtro: { equipamento: "", status: "", busca: "", somenteAlerta: false },
    ordenacao: {
      links: { chave: "utilizacao", direcao: "desc" },
      interfaces: { chave: "utilizacao", direcao: "desc" },
    },
    /* Série curta por interface, só na memória desta aba. O D1 guarda o total
       da rede (uma amostra por sincronização); a miniatura de cada interface
       vive aqui porque gravar 2 000 séries por ciclo custaria mais do que vale
       uma linha de 30 pixels. */
    serie: new Map(),
    totaisAnteriores: null,
    ultimaLeitura: null,
    timer: null,
    recarregando: false,
    relogio: null,
    tv: { ativo: false, indice: 0, timer: null, pausado: false, inicio: 0 },
  };

  /* ============================================================
     Regras de leitura
     ============================================================ */

  /* in_bps/out_bps e speed_bps vêm em bits/s. A utilização usa o sentido mais
     carregado, que é como a operação enxerga saturação de enlace. */
  const carga = (i) => Math.max(Number(i.in_bps) || 0, Number(i.out_bps) || 0);

  const chaveDe = (i) => `${i.hostid}:${i.if_index}`;
  const ajusteDe = (i) => state.settings.interfaces[chaveDe(i)] || null;
  const ignorada = (i) => !!ajusteDe(i)?.ignorar;
  const critica = (i) => !!ajusteDe(i)?.critica;

  const rotuloInterface = (i) => ajusteDe(i)?.interface || ajusteDe(i)?.apelido || i.if_name || "—";
  const descricaoInterface = (i) => {
    const ajuste = ajusteDe(i);
    return ajuste && Object.prototype.hasOwnProperty.call(ajuste, "descricao")
      ? ajuste.descricao
      : (i.if_alias || "");
  };
  const rotuloEquipamento = (i) => i.equipamento_id || i.host_name || "—";

  /* Tráfego acima da capacidade nominal é fisicamente impossível: indica falha
     de coleta, não saturação. As portas GPON da OLT C300 chegam a reportar
     1,8 Tbps numa porta de 2,488 Gbps. Leitura assim fica fora dos totais e é
     marcada na tabela, em vez de inflar os agregados em vários Tbps. */
  function leituraValida(i) {
    const cap = Number(i.speed_bps) || 0;
    if (!cap) return true;                 // sem capacidade nominal, nada a checar
    return carga(i) <= cap * (state.settings.toleranciaLeitura || 1.05);
  }

  function utilizacao(i) {
    const cap = Number(i.speed_bps) || 0;
    if (!cap) return null;
    if (!leituraValida(i)) return null;
    return Math.min((carga(i) / cap) * 100, 100);
  }

  const nivel = (u) => {
    if (u === null || u === undefined) return "";
    if (u > state.settings.limiteCritico) return "is-danger";
    if (u > state.settings.limiteAtencao) return "is-warn";
    return "";
  };

  const erroDe = (i) => (Number(i.in_errors) || 0) + (Number(i.out_errors) || 0);

  /* Interfaces que entram nos totais: leitura consistente e não marcada para
     ficar de fora pelo operador. */
  const contabilizadas = () => state.interfaces.filter((i) => leituraValida(i) && !ignorada(i));

  function totais() {
    const validas = contabilizadas();
    const entrada = validas.reduce((a, i) => a + (Number(i.in_bps) || 0), 0);
    const saida = validas.reduce((a, i) => a + (Number(i.out_bps) || 0), 0);
    const utils = validas.map(utilizacao).filter((u) => u !== null);
    const up = state.interfaces.filter((i) => i.oper_status === 1).length;
    const atencao = utils.filter((u) => u > state.settings.limiteAtencao).length;
    const criticas = utils.filter((u) => u > state.settings.limiteCritico).length;
    return {
      entrada, saida,
      total: entrada + saida,
      pico: utils.length ? Math.max(...utils) : null,
      media: utils.length ? utils.reduce((a, u) => a + u, 0) / utils.length : null,
      up, totalIfs: state.interfaces.length,
      down: state.interfaces.filter((i) => i.oper_status === 2).length,
      atencao, criticas,
      erros: state.interfaces.reduce((a, i) => a + erroDe(i), 0),
      inconsistentes: state.interfaces.filter((i) => !leituraValida(i)).length,
      ignoradas: state.interfaces.filter(ignorada).length,
      enlacesCaidos: state.links.filter((l) => l.a.oper_status !== 1 || l.b.oper_status !== 1).length,
    };
  }

  /* ============================================================
     Desenho: medidores, miniaturas e gráficos (SVG, sem biblioteca)
     ============================================================ */

  function medidor(u, invalida = false, largura = 70) {
    if (invalida) {
      return `<span class="badge badge-warn" title="Tráfego informado acima da capacidade da porta: falha de coleta no Zabbix.">inconsistente</span>`;
    }
    if (u === null) return '<small class="dim">—</small>';
    return `<span class="row" style="gap:8px;align-items:center">
      <span class="meter meter-sm ${nivel(u)}" style="width:${largura}px"><span style="width:${u.toFixed(1)}%"></span></span>
      <small class="mono">${u.toFixed(1)}%</small>
    </span>`;
  }

  const caminho = (pontos) =>
    pontos.map((p, i) => `${i ? "L" : "M"}${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(" ");

  /* Miniatura de uma série curta. Sem dois pontos não há tendência para
     mostrar, e desenhar uma linha reta sugeriria estabilidade que não foi
     medida — nesse caso a função não devolve nada. */
  function miniatura(valores, classe = "") {
    if (!Array.isArray(valores) || valores.length < 2) return "";
    const W = 120, H = 34;
    const max = Math.max(...valores, 1);
    const passo = W / (valores.length - 1);
    const pontos = valores.map((v, i) => ({ x: i * passo, y: H - (v / max) * (H - 4) - 2 }));
    return `<svg class="traf-spark ${classe}" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true">
      <path class="spark-fill" d="${caminho(pontos)} L${W} ${H} L0 ${H} Z"></path>
      <path class="spark-path" d="${caminho(pontos)}"></path>
    </svg>`;
  }

  /* Gráfico de área do período: entrada e saída da rede inteira.
     A escala é linear e começa em zero — escala truncada faria uma variação de
     2% parecer um pico, que é justamente o erro que um telão não pode cometer. */
  function graficoFluxo(amostras, altura = 260) {
    if (!Array.isArray(amostras) || amostras.length < 2) {
      return `<div class="empty" style="padding:var(--s-8) 0">
        <span class="empty-icon">${icon("clock")}</span>
        <b>Histórico ainda em formação</b>
        <p>Cada sincronização grava uma amostra do total da rede. A curva aparece a partir da segunda.</p>
      </div>`;
    }

    const W = 1000, H = altura, PL = 70, PR = 14, PT = 16, PB = 28;
    const larg = W - PL - PR, alt = H - PT - PB;
    const quando = (a) => new Date(String(a.taken_at).replace(" ", "T") + "Z");

    const maximo = Math.max(...amostras.map((a) => Math.max(a.in_bps || 0, a.out_bps || 0)), 1);
    const escalaY = (v) => PT + alt - (v / maximo) * alt;
    const escalaX = (i) => PL + (i / (amostras.length - 1)) * larg;

    const serie = (campo) => amostras.map((a, i) => ({ x: escalaX(i), y: escalaY(Number(a[campo]) || 0) }));
    const entrada = serie("in_bps");
    const saida = serie("out_bps");
    const area = (pts) => `${caminho(pts)} L${PL + larg} ${PT + alt} L${PL} ${PT + alt} Z`;

    const linhas = [0, 0.25, 0.5, 0.75, 1].map((f) => {
      const y = PT + alt - f * alt;
      return `<line class="chart-grid" x1="${PL}" y1="${y.toFixed(1)}" x2="${PL + larg}" y2="${y.toFixed(1)}"></line>
        <text class="chart-axis" x="${PL - 8}" y="${(y + 3.5).toFixed(1)}" text-anchor="end">${esc(bps(maximo * f))}</text>`;
    }).join("");

    const marcas = Math.min(6, amostras.length);
    const rotulosX = Array.from({ length: marcas }, (_, k) => {
      const i = Math.round((k / (marcas - 1)) * (amostras.length - 1));
      const hora = quando(amostras[i]).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
      const ancora = k === 0 ? "start" : k === marcas - 1 ? "end" : "middle";
      return `<text class="chart-axis" x="${escalaX(i).toFixed(1)}" y="${H - 8}" text-anchor="${ancora}">${esc(hora)}</text>`;
    }).join("");

    const ultima = amostras[amostras.length - 1];

    return `<svg class="traf-chart" viewBox="0 0 ${W} ${H}" role="img"
      aria-label="Tráfego de entrada e saída da rede no período, de ${esc(bps(0))} a ${esc(bps(maximo))}">
      <defs>
        <linearGradient id="trafIn" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="#1dc9ff" stop-opacity=".34"></stop>
          <stop offset="100%" stop-color="#1dc9ff" stop-opacity="0"></stop>
        </linearGradient>
        <linearGradient id="trafOut" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="#a56bff" stop-opacity=".30"></stop>
          <stop offset="100%" stop-color="#a56bff" stop-opacity="0"></stop>
        </linearGradient>
      </defs>
      ${linhas}
      <path class="chart-out-area" d="${area(saida)}"></path>
      <path class="chart-in-area" d="${area(entrada)}"></path>
      <path class="chart-out" d="${caminho(saida)}"></path>
      <path class="chart-in" d="${caminho(entrada)}"></path>
      <circle class="chart-dot" cx="${entrada[entrada.length - 1].x.toFixed(1)}" cy="${entrada[entrada.length - 1].y.toFixed(1)}" r="4" stroke="#1dc9ff"></circle>
      <circle class="chart-dot" cx="${saida[saida.length - 1].x.toFixed(1)}" cy="${saida[saida.length - 1].y.toFixed(1)}" r="4" stroke="#a56bff"></circle>
      ${rotulosX}
    </svg>
    <div class="chart-legend" style="margin-top:var(--s-3)">
      <span><i class="in"></i>Entrada — agora ${esc(bps(ultima.in_bps))}</span>
      <span><i class="out"></i>Saída — agora ${esc(bps(ultima.out_bps))}</span>
      <span class="dim">${amostras.length} amostra(s) • pico ${esc(bps(maximo))}</span>
    </div>`;
  }

  /* Medidor circular do pico de utilização. O número fica dentro do arco e o
     rótulo abaixo: em telão, cor sozinha não informa. */
  function medidorCircular(valor, rotulo) {
    const u = valor === null || valor === undefined ? 0 : Math.max(0, Math.min(100, valor));
    const raio = 70, circ = 2 * Math.PI * raio, arco = 0.75 * circ;
    const preenchido = (u / 100) * arco;
    const classe = nivel(valor);
    return `<div class="gauge-wrap">
      <svg class="gauge" viewBox="0 0 180 180" role="img"
        aria-label="${esc(rotulo)}: ${valor === null ? "sem dado" : `${u.toFixed(1)} por cento`}">
        <g transform="rotate(135 90 90)">
          <circle class="gauge-track" cx="90" cy="90" r="${raio}" stroke-width="14"
            stroke-dasharray="${arco.toFixed(1)} ${circ.toFixed(1)}"></circle>
          <circle class="gauge-value ${classe}" cx="90" cy="90" r="${raio}" stroke-width="14"
            stroke-dasharray="${circ.toFixed(1)}" stroke-dashoffset="${(circ - preenchido).toFixed(1)}"></circle>
        </g>
        <text class="gauge-label" x="90" y="92">${valor === null ? "—" : `${u.toFixed(0)}%`}</text>
        <text class="gauge-sub" x="90" y="112">${esc(rotulo)}</text>
      </svg>
    </div>`;
  }

  /* ============================================================
     Ordenação de tabelas
     ============================================================ */

  function cabecalhoOrdenavel(escopo, chave, rotulo) {
    const ativa = state.ordenacao[escopo];
    const selecionada = ativa.chave === chave;
    const ordem = selecionada ? (ativa.direcao === "asc" ? "ascending" : "descending") : "none";
    const proxima = selecionada && ativa.direcao === "asc" ? "decrescente" : "crescente";
    return `<th aria-sort="${ordem}"><button class="table-sort" type="button"
      data-sort-scope="${escopo}" data-sort-key="${chave}" aria-sort="${ordem}"
      aria-label="Ordenar por ${esc(rotulo)} em ordem ${proxima}">${esc(rotulo)}${icon("sort")}</button></th>`;
  }

  function compararValores(a, b, direcao) {
    const vazioA = a === null || a === undefined || a === "";
    const vazioB = b === null || b === undefined || b === "";
    if (vazioA || vazioB) {
      if (vazioA && vazioB) return 0;
      return vazioA ? 1 : -1;
    }
    const resultado = typeof a === "number" && typeof b === "number"
      ? a - b
      : collator.compare(String(a), String(b));
    return direcao === "asc" ? resultado : -resultado;
  }

  function ordenar(lista, escopo, valor) {
    const { chave, direcao } = state.ordenacao[escopo];
    return lista.slice().sort((a, b) => compararValores(valor(a, chave), valor(b, chave), direcao));
  }

  function alternarOrdenacao(escopo, chave) {
    const atual = state.ordenacao[escopo];
    if (atual.chave === chave) atual.direcao = atual.direcao === "asc" ? "desc" : "asc";
    else state.ordenacao[escopo] = { chave, direcao: "asc" };
    renderGuia();
  }

  /* ============================================================
     Enlaces × topologia
     ============================================================ */

  const chaveLink = (l) => [
    `${l.a.hostid}:${l.a.interface}`,
    `${l.b.hostid}:${l.b.interface}`,
  ].sort().join("|");

  function pontaNaTopologia(ponta) {
    const equipamento = (NOC.data()?.equipamentos || []).find((e) => e.id === ponta.equipamento_id);
    if (!equipamento) return null;
    const porta = (equipamento.portas || []).find((p) =>
      p.nome === ponta.interface ||
      (String(p.zabbix?.hostid || "") === String(ponta.hostid) && p.descricao === ponta.descricao)
    );
    return porta ? { equipamento, porta } : null;
  }

  function conexaoDoLink(l) {
    const a = pontaNaTopologia(l.a);
    const b = pontaNaTopologia(l.b);
    if (!a || !b) return { a, b, conexao: null };
    const conexao = (NOC.data()?.conexoes || []).find((c) =>
      (c.origem === a.equipamento.id && Number(c.portaOrigem) === Number(a.porta.numero) &&
       c.destino === b.equipamento.id && Number(c.portaDestino) === Number(b.porta.numero)) ||
      (c.origem === b.equipamento.id && Number(c.portaOrigem) === Number(b.porta.numero) &&
       c.destino === a.equipamento.id && Number(c.portaDestino) === Number(a.porta.numero))
    ) || null;
    return { a, b, conexao };
  }

  function dadosEditaveisLink(l) {
    const { conexao } = conexaoDoLink(l);
    return {
      tipo: conexao?.tipo || l.tipo || "Enlace",
      capacidade: conexao?.capacidade || l.capacidade || "A confirmar",
      descricao: conexao?.descricao || l.a.descricao || l.b.descricao || "",
    };
  }

  function capacidadeEmBps(valor) {
    const texto = String(valor || "").replace(",", ".");
    const achou = texto.match(/([\d.]+)\s*([kmgt]?bps)/i);
    if (!achou) return 0;
    const fatores = { bps: 1, kbps: 1e3, mbps: 1e6, gbps: 1e9, tbps: 1e12 };
    return (Number(achou[1]) || 0) * (fatores[achou[2].toLowerCase()] || 1);
  }

  const utilLink = (l) => {
    const a = utilizacao(l.a), b = utilizacao(l.b);
    if (a === null && b === null) return null;
    return Math.max(a ?? 0, b ?? 0);
  };

  /* ============================================================
     Alertas
     ============================================================ */

  /* A ordem é a da sala de operação: primeiro o que está fora do ar, depois o
     que vai sair, depois o que atrapalha a leitura. */
  function alertas() {
    const lista = [];

    for (const l of state.links) {
      if (l.a.oper_status === 1 && l.b.oper_status === 1) continue;
      const lado = l.a.oper_status !== 1 ? l.a : l.b;
      lista.push({
        grau: "critico",
        titulo: `Enlace fora do ar — ${lado.equipamento_id || lado.host || "?"} ${lado.interface}`,
        texto: `${l.a.equipamento_id || l.a.host || "?"} ${l.a.interface} ↔ ${l.b.equipamento_id || l.b.host || "?"} ${l.b.interface} • ${l.capacidade || "capacidade não informada"}`,
        figura: "down",
        alvo: { tipo: "link", chave: chaveLink(l) },
      });
    }

    for (const i of contabilizadas()) {
      const u = utilizacao(i);
      if (u === null || u <= state.settings.limiteAtencao) continue;
      const grave = u > state.settings.limiteCritico;
      lista.push({
        grau: grave ? "critico" : "atencao",
        titulo: `${grave ? "Saturação" : "Utilização alta"} — ${rotuloEquipamento(i)} ${rotuloInterface(i)}`,
        texto: `${descricaoInterface(i) || "sem descrição"} • ${bps(carga(i))} de ${bps(i.speed_bps)}${critica(i) ? " • marcada como crítica" : ""}`,
        figura: `${u.toFixed(1)}%`,
        alvo: { tipo: "interface", chave: chaveDe(i) },
      });
    }

    for (const i of state.interfaces) {
      if (i.oper_status !== 2 || !descricaoInterface(i)) continue;
      // Interface descrita é interface que deveria estar servindo algo.
      if (state.links.some((l) => chaveDe(l.a) === chaveDe(i) || chaveDe(l.b) === chaveDe(i))) continue;
      lista.push({
        grau: "atencao",
        titulo: `Interface descrita e fora do ar — ${rotuloEquipamento(i)} ${rotuloInterface(i)}`,
        texto: `Descrição: ${descricaoInterface(i)}`,
        figura: "down",
        alvo: { tipo: "interface", chave: chaveDe(i) },
      });
    }

    for (const i of state.interfaces) {
      if (leituraValida(i)) continue;
      lista.push({
        grau: "info",
        titulo: `Leitura inconsistente — ${rotuloEquipamento(i)} ${rotuloInterface(i)}`,
        texto: `O Zabbix informou ${bps(carga(i))} numa porta de ${bps(i.speed_bps)}. Fora dos totais até a coleta se corrigir.`,
        figura: "coleta",
        alvo: { tipo: "interface", chave: chaveDe(i) },
      });
    }

    const semVinculo = state.hosts.filter((h) => !h.equipamento_id).length;
    if (semVinculo) {
      lista.push({
        grau: "info",
        titulo: `${semVinculo} host monitorado sem equipamento vinculado`,
        texto: "O tráfego é contado, mas não aparece agrupado por equipamento. Vincule na guia Equipamentos.",
        figura: `${semVinculo}`,
        alvo: { tipo: "guia", chave: "equipamentos" },
      });
    }

    const peso = { critico: 0, atencao: 1, info: 2 };
    return lista.sort((a, b) => peso[a.grau] - peso[b.grau]);
  }

  /* ============================================================
     Blocos do painel — usados pelas guias e pelo modo telão
     ============================================================ */

  function serieDe(chave) {
    return state.serie.get(chave) || [];
  }

  const setaTendencia = (atual, anterior) => {
    if (anterior === null || anterior === undefined || !anterior) return "";
    const variacao = ((atual - anterior) / anterior) * 100;
    if (Math.abs(variacao) < 1) return `<span class="dim">estável</span>`;
    const subiu = variacao > 0;
    return `<span class="${subiu ? "" : "dim"}">${subiu ? "▲" : "▼"} ${Math.abs(variacao).toFixed(1)}% no ciclo</span>`;
  };

  const blocos = {
    kpis() {
      const t = totais();
      const ant = state.totaisAnteriores;
      const serieRede = state.historico.map((a) => (Number(a.in_bps) || 0) + (Number(a.out_bps) || 0));

      const cartoes = [
        {
          label: "Entrada total", valor: bps(t.entrada), classe: "",
          pe: setaTendencia(t.entrada, ant?.entrada), serie: state.historico.map((a) => Number(a.in_bps) || 0),
        },
        {
          label: "Saída total", valor: bps(t.saida), classe: "",
          pe: setaTendencia(t.saida, ant?.saida), serie: state.historico.map((a) => Number(a.out_bps) || 0),
        },
        {
          label: "Tráfego somado", valor: bps(t.total), classe: "",
          pe: `${inteiro(contabilizadas().length)} interface(s) no total`, serie: serieRede,
        },
        {
          label: "Pico de utilização",
          valor: t.pico === null ? "—" : `${t.pico.toFixed(1)}<span class="unit">%</span>`,
          classe: nivel(t.pico) === "is-danger" ? "is-danger" : nivel(t.pico) === "is-warn" ? "is-warn" : "is-ok",
          pe: `média ${t.media === null ? "—" : `${t.media.toFixed(1)}%`} • limite ${state.settings.limiteAtencao}%`,
          serie: state.historico.map((a) => Number(a.interfaces_saturadas) || 0),
        },
        {
          label: "Interfaces no ar",
          valor: `${inteiro(t.up)}<span class="unit">de ${inteiro(t.totalIfs)}</span>`,
          classe: t.down ? "is-warn" : "is-ok",
          pe: t.down ? `${inteiro(t.down)} fora do ar` : "nenhuma fora do ar",
          serie: state.historico.map((a) => Number(a.interfaces_up) || 0),
        },
        {
          label: "Enlaces confirmados",
          valor: inteiro(state.links.length),
          classe: t.enlacesCaidos ? "is-danger" : "",
          pe: t.enlacesCaidos ? `${inteiro(t.enlacesCaidos)} com ponta fora do ar` : "todos com as duas pontas no ar",
          serie: [],
        },
      ];

      return `<div class="traf-kpis">${cartoes.map((c) => `
        <article class="traf-kpi ${c.classe}">
          <label>${esc(c.label)}</label>
          <strong class="traf-value">${c.valor}</strong>
          <span class="traf-foot">${c.pe}</span>
          ${miniatura(c.serie)}
        </article>`).join("")}</div>`;
    },

    fluxo(altura) {
      return graficoFluxo(state.historico, altura);
    },

    top() {
      const lista = contabilizadas()
        .filter((i) => carga(i) > 0)
        .sort((a, b) => carga(b) - carga(a))
        .slice(0, state.settings.topN);

      if (!lista.length) {
        return `<div class="empty"><b>Nenhum tráfego medido</b>
          <p>Sincronize o Zabbix para que as interfaces reportem entrada e saída.</p></div>`;
      }

      const maior = carga(lista[0]) || 1;
      return `<div class="top-list">${lista.map((i) => {
        const u = utilizacao(i);
        const largura = (carga(i) / maior) * 100;
        return `<div class="top-row">
          <span class="top-name">
            ${esc(rotuloInterface(i))}${critica(i) ? ' <span class="if-tag">crítica</span>' : ""}
            <small>${esc(rotuloEquipamento(i))}${descricaoInterface(i) ? ` • ${esc(descricaoInterface(i))}` : ""}</small>
          </span>
          <span class="top-figure">${esc(bps(carga(i)))}
            <small>${u === null ? "capacidade não informada" : `${u.toFixed(1)}% de ${esc(bps(i.speed_bps))}`}</small>
          </span>
          <span class="top-track"><i class="${nivel(u)}" style="width:${largura.toFixed(1)}%"></i></span>
        </div>`;
      }).join("")}</div>`;
    },

    alertas(limite) {
      const lista = alertas();
      if (!lista.length) {
        return `<div class="empty">
          <span class="empty-icon">${icon("check")}</span>
          <b>Nada exigindo atenção</b>
          <p>Nenhum enlace fora do ar e nenhuma interface acima de ${state.settings.limiteAtencao}%.</p>
        </div>`;
      }
      const recorte = limite ? lista.slice(0, limite) : lista;
      const rotulo = { critico: "Crítico", atencao: "Atenção", info: "Informação" };
      return `<div class="traf-alerts">${recorte.map((a) => `
        <article class="traf-alert is-${a.grau}"${a.alvo ? ` data-alerta-alvo="${esc(a.alvo.tipo)}" data-alerta-chave="${esc(a.alvo.chave)}"` : ""}>
          <i class="mark"></i>
          <span class="badge ${a.grau === "critico" ? "badge-danger" : a.grau === "atencao" ? "badge-warn" : "badge-info"}">${rotulo[a.grau]}</span>
          <div style="min-width:0"><b>${esc(a.titulo)}</b><p>${esc(a.texto)}</p></div>
          <span class="alert-figure">${esc(a.figura)}</span>
        </article>`).join("")}
        ${limite && lista.length > limite
          ? `<button class="btn btn-sm btn-block" type="button" data-ir-guia="alertas">Ver os ${lista.length} alertas</button>`
          : ""}
      </div>`;
    },

    enlaces(limite) {
      if (!state.links.length) {
        return `<div class="empty"><b>Nenhum enlace derivado</b>
          <p>Sincronize o Zabbix para que as descrições de interface sejam lidas.</p></div>`;
      }

      const topologiaPronta = !!NOC.data();
      const valorLink = (l, chave) => ({
        pontaA: l.a.equipamento_id || l.a.host || "",
        pontaB: l.b.equipamento_id || l.b.host || "",
        capacidade: capacidadeEmBps(dadosEditaveisLink(l).capacidade),
        tipo: dadosEditaveisLink(l).tipo,
        entrada: Number(l.a.in_bps) || 0,
        saida: Number(l.a.out_bps) || 0,
        utilizacao: utilLink(l) ?? 0,
        confianca: l.confianca || "",
      })[chave];

      const lista = ordenar(state.links, "links", valorLink).slice(0, limite || state.links.length);

      const linha = (l) => {
        const u = utilLink(l);
        const ambosUp = l.a.oper_status === 1 && l.b.oper_status === 1;
        const dados = dadosEditaveisLink(l);
        const mapeamento = topologiaPronta ? conexaoDoLink(l) : { a: null, b: null, conexao: null };
        const podeMapear = !!mapeamento.a && !!mapeamento.b;
        const acoes = mapeamento.conexao
          ? "topology.edit topology.link.create topology.delete topology.link.delete"
          : "topology.edit topology.port.edit topology.link.create";
        const motivo = topologiaPronta
          ? "Use “Usar enlaces na topologia” para mapear as interfaces primeiro"
          : "Carregando a topologia…";
        return `<tr>
          <td>
            <div class="row" style="gap:8px;align-items:center">
              <span class="dot ${ambosUp ? "dot-ok" : "dot-danger"}"></span>
              <span><strong>${esc(l.a.equipamento_id || l.a.host || "—")}</strong>
                <small class="mono dim">${esc(l.a.interface)}</small></span>
            </div>
          </td>
          <td><strong>${esc(l.b.equipamento_id || l.b.host || "—")}</strong>
            <small class="mono dim">${esc(l.b.interface)}</small></td>
          <td><span class="badge">${esc(dados.capacidade)}</span></td>
          <td>${esc(dados.tipo)}</td>
          <td class="mono">${esc(bps(l.a.in_bps))}</td>
          <td class="mono">${esc(bps(l.a.out_bps))}</td>
          <td>${medidor(u)}</td>
          <td><span class="badge ${l.confianca === "alta" ? "badge-ok" : "badge-warn"}">${esc(l.confianca)}</span></td>
          <td class="row-actions" data-tv-hide>
            <button class="btn btn-sm" type="button" data-edit-link="${esc(chaveLink(l))}"
              ${podeMapear ? `data-action="${acoes}"` : `disabled title="${esc(motivo)}"`}>
              ${icon("edit")} Editar</button>
          </td>
        </tr>`;
      };

      return `<div class="table-wrap"><table class="table">
        <thead><tr>
          ${cabecalhoOrdenavel("links", "pontaA", "Ponta A")}
          ${cabecalhoOrdenavel("links", "pontaB", "Ponta B")}
          ${cabecalhoOrdenavel("links", "capacidade", "Capacidade")}
          ${cabecalhoOrdenavel("links", "tipo", "Tipo")}
          ${cabecalhoOrdenavel("links", "entrada", "Entrada (A)")}
          ${cabecalhoOrdenavel("links", "saida", "Saída (A)")}
          ${cabecalhoOrdenavel("links", "utilizacao", "Utilização")}
          ${cabecalhoOrdenavel("links", "confianca", "Confiança")}
          <th data-tv-hide>Ações</th>
        </tr></thead>
        <tbody>${lista.map(linha).join("")}</tbody>
      </table></div>`;
    },

    equipamentos() {
      const grupos = new Map();
      for (const i of state.interfaces) {
        const chave = i.equipamento_id || i.host_name || "sem-identificacao";
        if (!grupos.has(chave)) {
          grupos.set(chave, {
            id: i.equipamento_id, nome: i.equipamento_id || i.host_name || "Sem identificação",
            hostid: i.hostid, lista: [],
          });
        }
        grupos.get(chave).lista.push(i);
      }

      if (!grupos.size) {
        return `<div class="empty"><b>Nenhum host sincronizado</b>
          <p>Rode a sincronização do Zabbix para popular o inventário.</p></div>`;
      }

      const cartoes = [...grupos.values()].map((g) => {
        const validas = g.lista.filter((i) => leituraValida(i) && !ignorada(i));
        const entrada = validas.reduce((a, i) => a + (Number(i.in_bps) || 0), 0);
        const saida = validas.reduce((a, i) => a + (Number(i.out_bps) || 0), 0);
        const utils = validas.map(utilizacao).filter((u) => u !== null);
        const pico = utils.length ? Math.max(...utils) : null;
        const up = g.lista.filter((i) => i.oper_status === 1).length;
        const host = state.hosts.find((h) => String(h.hostid) === String(g.hostid));
        const vinculado = !!host?.equipamento_id;
        return { g, entrada, saida, pico, up, host, vinculado, total: entrada + saida };
      }).sort((a, b) => b.total - a.total);

      return `<div class="eq-grid">${cartoes.map(({ g, entrada, saida, pico, up, host, vinculado }) => `
        <article class="card eq-card">
          <div class="eq-head">
            <div style="min-width:0">
              <h3 class="truncate">${esc(g.nome)}</h3>
              <p class="eq-sub">${esc(host?.name || "host não identificado")}</p>
            </div>
            <span class="badge ${vinculado ? "badge-ok" : "badge-warn"}">
              <i class="dot ${vinculado ? "dot-ok" : "dot-warn"}"></i>${vinculado ? "vinculado" : "sem vínculo"}
            </span>
          </div>
          <div class="eq-figures">
            <div><span>Entrada</span><strong>${esc(bps(entrada))}</strong></div>
            <div><span>Saída</span><strong>${esc(bps(saida))}</strong></div>
            <div><span>No ar</span><strong>${up}/${g.lista.length}</strong></div>
          </div>
          <div>
            <div class="row-between" style="font-size:var(--fs-11);margin-bottom:6px">
              <span class="muted">Pico de utilização</span>
              <span class="mono">${pico === null ? "—" : `${pico.toFixed(1)}%`}</span>
            </div>
            <span class="meter ${nivel(pico)}"><span style="width:${pico === null ? 0 : pico.toFixed(1)}%"></span></span>
          </div>
          <div class="row" style="gap:var(--s-2)" data-tv-hide>
            <button class="btn btn-sm grow" type="button" data-ver-equipamento="${esc(g.id || g.nome)}">
              ${icon("port")} Ver interfaces</button>
            <button class="btn btn-sm" type="button" data-vincular-host="${esc(String(g.hostid))}" data-action="zabbix.link">
              ${icon("link")} Vínculo</button>
          </div>
        </article>`).join("")}</div>`;
    },

    interfaces() {
      const lista = filtradas();
      if (!lista.length) {
        return `<div class="empty"><b>Nenhuma interface</b>
          <p>Ajuste os filtros para ver outras interfaces.</p></div>`;
      }

      const linha = (i) => {
        const u = utilizacao(i);
        const st = NOC.interfaceStatus(i);
        const erros = erroDe(i);
        const invalida = !leituraValida(i);
        const ajuste = ajusteDe(i);
        return `<tr>
          <td>${esc(rotuloEquipamento(i))}</td>
          <td>
            <span class="if-name">
              <span class="mono">${esc(rotuloInterface(i))}</span>
              ${critica(i) ? '<span class="if-tag">crítica</span>' : ""}
              ${ignorada(i) ? '<span class="if-tag is-muted">fora dos totais</span>' : ""}
            </span>
            ${rotuloInterface(i) !== i.if_name ? `<small class="dim mono">Original: ${esc(i.if_name)}</small>` : ""}
          </td>
          <td>${descricaoInterface(i) ? esc(descricaoInterface(i)) : '<small class="dim">sem descrição</small>'}
            ${descricaoInterface(i) !== (i.if_alias || "") ? `<small class="dim">Original: ${esc(i.if_alias || "sem descrição")}</small>` : ""}</td>
          <td><span class="row" style="gap:6px;align-items:center"><span class="dot ${st.dot}"></span>${esc(st.label)}</span></td>
          <td class="mono">${esc(bps(i.speed_bps))}</td>
          <td class="mono${invalida ? " dim" : ""}">${esc(bps(i.in_bps))}</td>
          <td class="mono${invalida ? " dim" : ""}">${esc(bps(i.out_bps))}</td>
          <td>${medidor(u, invalida)}</td>
          <td style="width:110px">${miniatura(serieDe(chaveDe(i))) || '<small class="dim">—</small>'}</td>
          <td class="mono ${erros ? "" : "dim"}">${inteiro(erros)}</td>
          <td class="row-actions" data-tv-hide>
            <button class="btn btn-sm btn-ghost btn-icon" type="button" data-edit-if="${esc(chaveDe(i))}"
              data-action="trafego.settings" data-action-title="Interface, descrição, criticidade e observação"
              aria-label="Editar ${esc(rotuloInterface(i))}">${icon("edit")}</button>
          </td>
        </tr>`;
      };

      const teto = 300;
      return `<div class="table-wrap"><table class="table">
        <thead><tr>
          ${cabecalhoOrdenavel("interfaces", "equipamento", "Equipamento")}
          ${cabecalhoOrdenavel("interfaces", "interface", "Interface")}
          ${cabecalhoOrdenavel("interfaces", "descricao", "Descrição")}
          ${cabecalhoOrdenavel("interfaces", "status", "Status")}
          ${cabecalhoOrdenavel("interfaces", "capacidade", "Capacidade")}
          ${cabecalhoOrdenavel("interfaces", "entrada", "Entrada")}
          ${cabecalhoOrdenavel("interfaces", "saida", "Saída")}
          ${cabecalhoOrdenavel("interfaces", "utilizacao", "Utilização")}
          <th>Tendência</th>
          ${cabecalhoOrdenavel("interfaces", "erros", "Erros")}
          <th data-tv-hide></th>
        </tr></thead>
        <tbody>${lista.slice(0, teto).map(linha).join("")}</tbody>
      </table></div>
      <p class="dim" style="margin-top:var(--s-3);font-size:var(--fs-11)">
        Exibindo ${Math.min(lista.length, teto)} de ${inteiro(lista.length)} interfaces${lista.length > teto ? " — refine os filtros para alcançar as demais" : ""}.</p>`;
    },
  };

  function filtradas() {
    const { equipamento, status, busca, somenteAlerta } = state.filtro;
    const alvo = busca.trim().toLowerCase();
    const lista = state.interfaces.filter((i) => {
      if (equipamento && (i.equipamento_id || i.host_name) !== equipamento) return false;
      if (status === "up" && i.oper_status !== 1) return false;
      if (status === "down" && i.oper_status !== 2) return false;
      if (somenteAlerta) {
        const u = utilizacao(i);
        const emAlerta = (u !== null && u > state.settings.limiteAtencao) || i.oper_status === 2 || !leituraValida(i);
        if (!emAlerta) return false;
      }
      if (alvo && !`${i.if_name} ${i.if_alias} ${rotuloInterface(i)} ${descricaoInterface(i)} ${ajusteDe(i)?.nota || ""}`.toLowerCase().includes(alvo)) return false;
      return true;
    });

    const valorInterface = (i, chave) => ({
      equipamento: i.equipamento_id || i.host_name || "",
      interface: rotuloInterface(i),
      descricao: descricaoInterface(i),
      status: Number(i.oper_status) || 0,
      capacidade: Number(i.speed_bps) || 0,
      entrada: Number(i.in_bps) || 0,
      saida: Number(i.out_bps) || 0,
      utilizacao: utilizacao(i),
      erros: erroDe(i),
    })[chave];

    return ordenar(lista, "interfaces", valorInterface);
  }

  /* ============================================================
     Faixa de estado — sempre visível, fora das guias
     ============================================================ */

  function renderPulse() {
    const t = totais();
    const grau = (n, aviso, perigo) => (n >= perigo ? "is-danger" : n >= aviso ? "is-warn" : "");

    $("#pulse").innerHTML = `
      <div class="pulse-item">
        <span><i class="live-dot" id="pulseLive"></i>Leitura</span>
        <strong id="pulseFresh">—</strong>
        <small>${state.status?.last_run?.ok ? "última sincronização concluída" : "sincronização pendente"}</small>
      </div>
      <div class="pulse-item">
        <span>Entrada · Saída</span>
        <strong>${esc(bps(t.entrada))} <span style="color:var(--text-3)">·</span> ${esc(bps(t.saida))}</strong>
        <small>${inteiro(contabilizadas().length)} interface(s) no total${t.ignoradas ? ` • ${t.ignoradas} fora por decisão do operador` : ""}</small>
      </div>
      <div class="pulse-item ${grau(t.pico ?? 0, state.settings.limiteAtencao, state.settings.limiteCritico)}">
        <span>Pico de utilização</span>
        <strong>${t.pico === null ? "—" : `${t.pico.toFixed(1)}%`}</strong>
        <small>${t.criticas} acima de ${state.settings.limiteCritico}% • ${t.atencao} acima de ${state.settings.limiteAtencao}%</small>
      </div>
      <div class="pulse-item ${t.down ? "is-warn" : "is-ok"}">
        <span>Interfaces no ar</span>
        <strong>${inteiro(t.up)} / ${inteiro(t.totalIfs)}</strong>
        <small>${t.down ? `${inteiro(t.down)} fora do ar` : "nenhuma fora do ar"}</small>
      </div>
      <div class="pulse-item ${t.enlacesCaidos ? "is-danger" : "is-ok"}">
        <span>Enlaces</span>
        <strong>${inteiro(state.links.length)}</strong>
        <small>${t.enlacesCaidos ? `${inteiro(t.enlacesCaidos)} com ponta fora do ar` : "todas as pontas no ar"}</small>
      </div>
      <div class="pulse-item ${t.erros ? "is-warn" : ""}">
        <span>Erros acumulados</span>
        <strong>${inteiro(t.erros)}</strong>
        <small>${t.inconsistentes ? `${t.inconsistentes} leitura(s) inconsistente(s)` : "contadores desde a última limpeza"}</small>
      </div>`;
    atualizarFrescor();
  }

  /* O tempo desde a última leitura anda sozinho, sem repintar a tela toda:
     em um telão parado, é ele que diz se o painel está vivo. */
  function atualizarFrescor() {
    const run = state.status?.last_run;
    const quando = run ? new Date(String(run.finished_at || run.started_at).replace(" ", "T") + "Z") : null;
    const segundos = quando ? Math.max(0, Math.round((Date.now() - quando.getTime()) / 1000)) : null;
    const texto = segundos === null
      ? "nunca sincronizado"
      : segundos < 60 ? `há ${segundos}s`
        : segundos < 3600 ? `há ${Math.floor(segundos / 60)} min`
          : `há ${Math.floor(segundos / 3600)} h`;

    // Duas vezes o intervalo esperado já é atraso: o ponto para de pulsar.
    const atrasado = segundos === null || segundos > state.settings.intervaloSegundos * 3;
    for (const alvo of [$("#pulseFresh"), $("#tvFreshness")]) if (alvo) alvo.textContent = texto;
    for (const ponto of [$("#pulseLive"), $("#tvLive")]) if (ponto) ponto.classList.toggle("is-stale", atrasado);

    const run2 = state.status?.last_run;
    const t = totais();
    $("#syncInfo").textContent = [
      run2
        ? `Última sincronização: ${quando.toLocaleString("pt-BR")} • ${run2.hosts_count} hosts, ${run2.interfaces_count} interfaces (${run2.source === "cron" ? "automática" : "manual"}).`
        : "Nenhuma sincronização registrada ainda.",
      t.inconsistentes
        ? `${t.inconsistentes} interface(s) reportaram tráfego acima da capacidade da porta e ficaram fora dos totais.`
        : "",
    ].filter(Boolean).join(" ");
  }

  /* ============================================================
     Guias
     ============================================================ */

  function renderTabs() {
    // A lista de alertas percorre as 700+ interfaces: uma vez por repintura,
    // não uma por contador.
    const lista = alertas();
    const contadores = {
      enlaces: { valor: state.links.length, perigo: false },
      interfaces: { valor: state.interfaces.length, perigo: false },
      alertas: { valor: lista.length, perigo: lista.some((a) => a.grau === "critico") },
    };

    $("#tabs").innerHTML = GUIAS.map((g) => {
      const c = contadores[g.id];
      const ativa = state.guia === g.id;
      return `<button class="traf-tab" type="button" role="tab" id="tab-${g.id}"
        aria-selected="${ativa}" aria-controls="painel-${g.id}" tabindex="${ativa ? 0 : -1}"
        data-guia="${g.id}">${icon(g.icon)}<span>${esc(g.label)}</span>
        ${c ? `<span class="traf-tab-count ${c.perigo ? "is-danger" : ""}">${inteiro(c.valor)}</span>` : ""}
      </button>`;
    }).join("");
  }

  const painel = (id) => $(`#painel-${id}`);

  function renderGuia() {
    for (const g of GUIAS) painel(g.id).hidden = g.id !== state.guia;

    if (state.guia === "visao") {
      painel("visao").innerHTML = `
        <div class="stack" style="gap:var(--s-4)">
          ${blocos.kpis()}
          <div class="traf-grid cols-2">
            <section class="card traf-span-2">
              <div class="card-head">
                <div><h2>Fluxo das últimas ${state.horas} h</h2>
                  <p>Uma amostra por sincronização, somando todas as interfaces com leitura consistente.</p></div>
                <div class="row" style="gap:6px" data-tv-hide>
                  ${[1, 6, 24, 72].map((h) => `<button class="chip" type="button" data-periodo="${h}"
                    aria-pressed="${state.horas === h}">${h}h</button>`).join("")}
                </div>
              </div>
              <div class="card-body">${blocos.fluxo()}</div>
            </section>

            <section class="card">
              <div class="card-head"><div><h2>Maiores consumidores</h2>
                <p>As ${state.settings.topN} interfaces com mais tráfego agora.</p></div></div>
              <div class="card-body">${blocos.top()}</div>
            </section>

            <section class="card">
              <div class="card-head"><div><h2>Precisa de atenção</h2>
                <p>Enlace fora do ar primeiro, depois saturação e leitura duvidosa.</p></div></div>
              <div class="card-body">${blocos.alertas(6)}</div>
            </section>
          </div>
        </div>`;
    }

    if (state.guia === "enlaces") {
      const alta = state.links.filter((l) => l.confianca === "alta").length;
      painel("enlaces").innerHTML = `
        <section class="card">
          <div class="card-head">
            <div><h2>Enlaces confirmados</h2>
              <p>Pares reconhecidos pela descrição das interfaces. Clique nas colunas para ordenar ou use Editar na conexão.</p></div>
            <div class="row wrap" style="gap:6px">
              <span class="badge badge-ok">${alta} confirmação mútua</span>
              <span class="badge badge-warn">${state.links.length - alta} um lado só</span>
              <button class="btn btn-sm" id="btnApplyTopology" type="button"
                      data-action="topology.link.create topology.port.edit">Usar enlaces na topologia</button>
            </div>
          </div>
          <div class="card-body">${blocos.enlaces()}</div>
        </section>`;
    }

    if (state.guia === "interfaces") {
      const ids = [...new Set(state.interfaces.map((i) => i.equipamento_id || i.host_name).filter(Boolean))].sort(collator.compare);
      painel("interfaces").innerHTML = `
        <section class="card ${state.densidade === "compacta" ? "is-compact" : ""}">
          <div class="card-head">
            <div><h2>Interfaces</h2>
              <p>Clique nas colunas para ordenar. Acima de ${state.settings.limiteAtencao}% acende alerta.</p></div>
            <div class="row wrap" style="gap:6px">
              <select class="select" id="fEquip" style="min-width:170px" aria-label="Filtrar por equipamento">
                <option value="">Todos os equipamentos</option>
                ${ids.map((id) => `<option value="${esc(id)}" ${id === state.filtro.equipamento ? "selected" : ""}>${esc(id)}</option>`).join("")}
              </select>
              <div class="segmented" id="fStatus" role="group" aria-label="Filtrar por status">
                ${[["", "Todas"], ["up", "Up"], ["down", "Down"]].map(([v, r]) => `
                  <button class="tab ${state.filtro.status === v ? "is-active" : ""}" type="button" data-st="${v}">${r}</button>`).join("")}
              </div>
              <button class="chip" type="button" id="fAlerta" aria-pressed="${state.filtro.somenteAlerta}">Só em alerta</button>
              <span class="input-affix">
                <span class="affix-icon">${icon("search")}</span>
                <input class="input" id="fBusca" type="search" value="${esc(state.filtro.busca)}"
                       placeholder="Interface ou descrição" aria-label="Buscar interface">
              </span>
              <button class="btn btn-sm btn-ghost btn-icon" type="button" id="btnDensidade"
                      title="Alternar densidade da tabela" aria-label="Alternar densidade da tabela">${icon("filter")}</button>
              <button class="btn btn-sm" type="button" id="btnCsv">${icon("download")} CSV</button>
            </div>
          </div>
          <div class="card-body">${blocos.interfaces()}</div>
        </section>`;
    }

    if (state.guia === "equipamentos") {
      painel("equipamentos").innerHTML = `
        <section class="card">
          <div class="card-head">
            <div><h2>Tráfego por equipamento</h2>
              <p>Soma das interfaces de cada host monitorado. O vínculo host ↔ equipamento é o que agrupa os números.</p></div>
          </div>
          <div class="card-body">${blocos.equipamentos()}</div>
        </section>`;
    }

    if (state.guia === "alertas") {
      painel("alertas").innerHTML = `
        <section class="card">
          <div class="card-head">
            <div><h2>Alertas</h2>
              <p>Derivados da última leitura, na ordem em que a operação trata: fora do ar, saturação, leitura duvidosa.</p></div>
          </div>
          <div class="card-body">${blocos.alertas()}</div>
        </section>`;
    }

    if (state.guia === "ajustes") renderAjustes();

    NOC.applyActions(painel(state.guia));
    ligarEventosDaGuia();
  }

  /* ============================================================
     Ajustes — o que o painel mostra é configurável por quem tem permissão
     ============================================================ */

  function renderAjustes() {
    const s = state.settings;
    const pode = state.podeEditarSettings;
    const trava = pode ? "" : "disabled";
    const overrides = Object.entries(s.interfaces);

    const campo = (id, rotulo, valor, dica, extra = "") => `
      <div class="field">
        <label for="${id}">${esc(rotulo)}</label>
        <input class="input" id="${id}" type="number" value="${valor}" ${extra} ${trava}>
        <span class="field-hint">${esc(dica)}</span>
      </div>`;

    painel("ajustes").innerHTML = `
      <section class="card">
        <div class="card-head">
          <div><h2>Ajustes do painel</h2>
            <p>Valem para todos que abrem esta tela. Cada alteração fica registrada na auditoria.</p></div>
          <span class="badge ${pode ? "badge-ok" : "badge-warn"}">
            <i class="dot ${pode ? "dot-ok" : "dot-warn"}"></i>${pode ? "você pode editar" : "somente leitura"}
          </span>
        </div>
        <div class="card-body stack" style="gap:var(--s-5)">
          ${pode ? "" : `<div class="alert alert-warn" style="animation:none">${icon("lock")}
            <span>Seu perfil não tem a ação <b>trafego.settings</b>. Os valores aparecem para conferência, mas não podem ser gravados.</span></div>`}

          <div class="set-grid">
            <div class="set-group">
              <h3>Limites de utilização</h3>
              ${campo("setAtencao", "Atenção (%)", s.limiteAtencao, "Acima disto a interface acende amarelo.", 'min="1" max="99"')}
              ${campo("setCritico", "Crítico (%)", s.limiteCritico, "Acima disto acende vermelho e vira alerta crítico.", 'min="2" max="100"')}
              ${campo("setTolerancia", "Tolerância de leitura", s.toleranciaLeitura, "Múltiplo da capacidade acima do qual a leitura é tratada como falha de coleta.", 'min="1" max="5" step="0.05"')}
            </div>

            <div class="set-group">
              <h3>Atualização e período</h3>
              <div class="field">
                <label>Atualização automática</label>
                <div class="input" aria-readonly="true">A cada ${AUTO_REFRESH_SECONDS} segundos</div>
                <span class="field-hint">Usada quando “Atualizar sozinho” está ativado.</span>
              </div>
              ${campo("setHistorico", "Janela do gráfico (h)", s.historicoHoras, "Quantas horas a curva do fluxo mostra.", 'min="1" max="168"')}
              ${campo("setTopN", "Maiores consumidores", s.topN, "Quantas interfaces entram na lista do topo.", 'min="3" max="50"')}
            </div>

            <div class="set-group">
              <h3>Modo telão (55")</h3>
              <div class="field">
                <label for="setTitulo">Título no telão</label>
                <input class="input" id="setTitulo" value="${esc(s.titulo)}" maxlength="60" ${trava}>
                <span class="field-hint">Aparece no alto da tela em modo TV.</span>
              </div>
              ${campo("setZoom", "Escala da tipografia (%)", s.tvZoom, "100 é calibrado para 55\" a ~4 m. Aumente para telas maiores ou mais distantes.", 'min="60" max="220" step="5"')}
              ${campo("setRotacao", "Trocar de painel a cada (s)", s.tvRotacaoSegundos, "Zero mantém um painel fixo na tela.", 'min="0" max="300"')}
            </div>

            <div class="set-group">
              <h3>Painéis que entram na rotação</h3>
              <div class="set-panels">
                ${Object.entries(PAINEIS_TV).map(([id, rotulo]) => `
                  <label class="checkbox">
                    <input type="checkbox" data-painel-tv="${id}" ${s.tvPaineis.includes(id) ? "checked" : ""} ${trava}>
                    <span><b>${esc(rotulo)}</b></span>
                  </label>`).join("")}
              </div>
            </div>
          </div>

          <div>
            <div class="row-between" style="margin-bottom:var(--s-3)">
              <h3 style="font-size:var(--fs-13)">Interfaces com ajuste próprio</h3>
              <span class="dim" style="font-size:var(--fs-11)">${overrides.length} configurada(s)</span>
            </div>
            ${overrides.length ? `<div class="table-wrap"><table class="table">
              <thead><tr><th>Interface original</th><th>Interface exibida</th><th>Descrição</th><th>Observação</th><th>Marcas</th><th></th></tr></thead>
              <tbody>${overrides.map(([chave, v]) => {
                const alvo = state.interfaces.find((i) => chaveDe(i) === chave);
                return `<tr>
                  <td class="mono">${esc(alvo ? `${rotuloEquipamento(alvo)} ${alvo.if_name}` : chave)}</td>
                  <td>${v.interface || v.apelido ? esc(v.interface || v.apelido) : '<small class="dim">—</small>'}</td>
                  <td>${Object.prototype.hasOwnProperty.call(v, "descricao") ? (v.descricao ? esc(v.descricao) : '<small class="dim">sem descrição</small>') : '<small class="dim">original</small>'}</td>
                  <td>${v.nota ? esc(v.nota) : '<small class="dim">—</small>'}</td>
                  <td>${[v.critica ? '<span class="if-tag">crítica</span>' : "", v.ignorar ? '<span class="if-tag is-muted">fora dos totais</span>' : ""].join(" ") || '<small class="dim">—</small>'}</td>
                  <td class="row-actions"><button class="btn btn-sm btn-ghost btn-icon" type="button"
                    data-remover-ajuste="${esc(chave)}" data-action="trafego.settings"
                    aria-label="Remover ajuste de ${esc(chave)}">${icon("trash")}</button></td>
                </tr>`;
              }).join("")}</tbody>
            </table></div>` : `<div class="empty" style="padding:var(--s-6) 0">
              <b>Nenhuma interface com ajuste próprio</b>
              <p>Use o lápis na guia Interfaces para alterar interface, descrição, criticidade ou participação nos totais.</p></div>`}
          </div>
        </div>
        <div class="card-foot">
          <span class="dim" style="font-size:var(--fs-11)">Os limites e o período também mudam o que o modo telão mostra.</span>
          <span class="row" style="gap:var(--s-2)">
            <button class="btn" type="button" id="btnRestaurar" data-action="trafego.settings">Restaurar padrão</button>
            <button class="btn btn-primary" type="button" id="btnSalvarAjustes" data-action="trafego.settings">Salvar ajustes</button>
          </span>
        </div>
      </section>`;
  }

  function lerAjustesDoFormulario() {
    const num = (sel, padrao) => {
      const v = Number($(sel)?.value);
      return Number.isFinite(v) ? v : padrao;
    };
    return {
      ...state.settings,
      titulo: $("#setTitulo").value.trim() || AJUSTES_PADRAO.titulo,
      limiteAtencao: num("#setAtencao", state.settings.limiteAtencao),
      limiteCritico: num("#setCritico", state.settings.limiteCritico),
      toleranciaLeitura: num("#setTolerancia", state.settings.toleranciaLeitura),
      historicoHoras: num("#setHistorico", state.settings.historicoHoras),
      topN: num("#setTopN", state.settings.topN),
      tvZoom: num("#setZoom", state.settings.tvZoom),
      tvRotacaoSegundos: num("#setRotacao", state.settings.tvRotacaoSegundos),
      tvPaineis: $$("[data-painel-tv]").filter((c) => c.checked).map((c) => c.dataset.painelTv),
    };
  }

  /* Gravação com reversão: se a API recusar, o estado local volta ao anterior.
     A tela nunca mostra um ajuste que não foi gravado. */
  async function salvarAjustes(novos, motivo = "Ajustes salvos") {
    const anterior = state.settings;
    state.settings = { ...state.settings, ...novos };
    try {
      const r = await NOC.trafego.saveSettings(state.settings);
      state.settings = r.settings;
      // Salvar a janela do gráfico é o que a torna o padrão desta sessão também.
      if (state.horas !== state.settings.historicoHoras) {
        state.horas = state.settings.historicoHoras;
        state.historico = (await NOC.zabbix.history(state.horas).catch(() => null))?.amostras || state.historico;
      }
      aplicarAjustes();
      renderTudo();
      toast(motivo, { text: "Vale para todos que abrirem esta tela.", type: "ok" });
      return true;
    } catch (err) {
      state.settings = anterior;
      renderTudo();
      toast("Não foi possível salvar os ajustes", { text: err.message, type: "danger" });
      return false;
    }
  }

  /* Efeitos dos ajustes que vivem fora do HTML: escala do telão, ritmo da
     recarga e o título do painel. */
  function aplicarAjustes() {
    document.body.style.setProperty("--traf-zoom", String((state.settings.tvZoom || 100) / 100));
    $("#tvTitle").textContent = state.settings.titulo;
    $("#pageTitle").textContent = state.settings.titulo === AJUSTES_PADRAO.titulo
      ? "Tráfego das interfaces" : state.settings.titulo;
    agendar();
  }

  /* ============================================================
     Edições
     ============================================================ */

  function editarInterface(chave) {
    const alvo = state.interfaces.find((i) => chaveDe(i) === chave);
    if (!alvo) return;
    if (!state.podeEditarSettings) return;
    const atual = ajusteDe(alvo) || { interface: "", nota: "", critica: false, ignorar: false };

    UI.modal({
      labelledBy: "ifTitle",
      html: `
        <div class="modal-head">
          <div><span class="kicker">Interface monitorada</span>
            <h2 id="ifTitle" style="margin-top:6px">${esc(alvo.if_name)}</h2>
            <p class="muted" style="font-size:var(--fs-13);margin-top:4px">
              ${esc(rotuloEquipamento(alvo))} • ${esc(alvo.if_alias || "sem descrição")} • ${esc(bps(alvo.speed_bps))}
            </p></div>
          <button class="btn btn-ghost btn-icon" data-close type="button" aria-label="Fechar">${icon("close")}</button>
        </div>
        <div class="modal-body">
          <form class="stack" id="ifForm">
            <div class="field"><label for="ifNome">Interface</label>
              <input class="input" id="ifNome" maxlength="80" value="${esc(rotuloInterface(alvo))}"
                     placeholder="Ex.: 100GE1/0/1" required>
              <span class="field-hint">Nome exibido no painel. O valor original do Zabbix continua visível na tabela.</span></div>
            <div class="field"><label for="ifDescricao">Descrição</label>
              <input class="input" id="ifDescricao" maxlength="200" value="${esc(descricaoInterface(alvo))}"
                     placeholder="Ex.: Uplink Ascenty A">
              <span class="field-hint">Descrição operacional exibida no tráfego; o ifAlias original do Zabbix não é sobrescrito.</span></div>
            <div class="field"><label for="ifNota">Observação</label>
              <input class="input" id="ifNota" maxlength="200" value="${esc(atual.nota || "")}"
                     placeholder="Circuito, operadora ou referência operacional"></div>
            <label class="checkbox"><input type="checkbox" id="ifCritica" ${atual.critica ? "checked" : ""}>
              <span><b>Interface crítica</b><small>Aparece marcada nas listas e nos alertas.</small></span></label>
            <label class="checkbox"><input type="checkbox" id="ifIgnorar" ${atual.ignorar ? "checked" : ""}>
              <span><b>Deixar fora dos totais</b><small>Continua na tabela, mas não soma nos indicadores nem no gráfico. Use para porta de teste ou espelhamento.</small></span></label>
          </form>
        </div>
        <div class="modal-foot">
          <span class="dim" style="font-size:var(--fs-11)">A alteração é registrada na auditoria.</span>
          <span class="row"><button class="btn" data-close type="button">Cancelar</button>
            <button class="btn btn-primary" data-salvar type="button">Salvar</button></span>
        </div>`,
      onMount: (host, close) => {
        $("#ifForm", host).onsubmit = (e) => { e.preventDefault(); $("[data-salvar]", host).click(); };
        $("[data-salvar]", host).onclick = async () => {
          const botao = $("[data-salvar]", host);
          const nome = $("#ifNome", host).value.trim();
          if (!nome) {
            $("#ifNome", host).focus();
            toast("Informe a interface", { text: "O nome exibido da interface não pode ficar vazio.", type: "warn" });
            return;
          }
          botao.disabled = true;
          botao.textContent = "Salvando…";
          const interfaces = { ...state.settings.interfaces };
          const novo = {
            interface: nome,
            descricao: $("#ifDescricao", host).value.trim(),
            nota: $("#ifNota", host).value.trim(),
            critica: $("#ifCritica", host).checked,
            ignorar: $("#ifIgnorar", host).checked,
          };
          interfaces[chave] = novo;

          const ok = await salvarAjustes({ interfaces }, "Interface atualizada");
          if (ok) close();
          else { botao.disabled = false; botao.textContent = "Salvar"; }
        };
      },
    });
  }

  function vincularHost(hostid) {
    const host = state.hosts.find((h) => String(h.hostid) === String(hostid));
    if (!host) return;
    const equipamentos = (NOC.data()?.equipamentos || []);

    UI.modal({
      labelledBy: "hostTitle",
      html: `
        <div class="modal-head">
          <div><span class="kicker">Host do Zabbix</span>
            <h2 id="hostTitle" style="margin-top:6px">${esc(host.name)}</h2>
            <p class="muted" style="font-size:var(--fs-13);margin-top:4px">
              Vincular ao equipamento da topologia agrupa o tráfego deste host por equipamento.
            </p></div>
          <button class="btn btn-ghost btn-icon" data-close type="button" aria-label="Fechar">${icon("close")}</button>
        </div>
        <div class="modal-body">
          <div class="field"><label for="hostEquip">Equipamento</label>
            <select class="select" id="hostEquip">
              <option value="">Sem vínculo (volta ao reconhecimento automático)</option>
              ${equipamentos.map((e) => `<option value="${esc(e.id)}" ${e.id === host.equipamento_id ? "selected" : ""}>${esc(e.nome)}</option>`).join("")}
            </select>
            <span class="field-hint">${equipamentos.length ? "" : "A topologia ainda está carregando."}</span></div>
        </div>
        <div class="modal-foot">
          <span class="dim" style="font-size:var(--fs-11)">O vínculo manual não é desfeito pela sincronização automática.</span>
          <span class="row"><button class="btn" data-close type="button">Cancelar</button>
            <button class="btn btn-primary" data-salvar type="button">Salvar vínculo</button></span>
        </div>`,
      onMount: (host_, close) => {
        $("[data-salvar]", host_).onclick = async () => {
          const botao = $("[data-salvar]", host_);
          botao.disabled = true;
          botao.textContent = "Salvando…";
          try {
            await NOC.zabbix.vincular(hostid, $("#hostEquip", host_).value || null);
            await carregar();
            close();
            renderTudo();
            toast("Vínculo atualizado", { text: "O tráfego deste host passa a somar no equipamento escolhido.", type: "ok" });
          } catch (err) {
            botao.disabled = false;
            botao.textContent = "Salvar vínculo";
            toast("Não foi possível salvar o vínculo", { text: err.message, type: "danger" });
          }
        };
      },
    });
  }

  function editarLink(l) {
    const { a, b, conexao } = conexaoDoLink(l);
    if (!a || !b) {
      toast("Enlace ainda não está disponível para edição", {
        text: "Use “Usar enlaces na topologia” para mapear as interfaces primeiro.", type: "warn",
      });
      return;
    }

    const dados = dadosEditaveisLink(l);
    UI.modal({
      labelledBy: "editLinkTitle",
      html: `
        <div class="modal-head">
          <div><span class="kicker">Enlace do tráfego</span>
            <h2 id="editLinkTitle" style="margin-top:6px">Editar conexão</h2>
            <p class="muted" style="font-size:var(--fs-13);margin-top:4px">
              ${esc(a.equipamento.nome)} • ${esc(l.a.interface)} ↔ ${esc(b.equipamento.nome)} • ${esc(l.b.interface)}
            </p></div>
          <button class="btn btn-ghost btn-icon" data-close type="button" aria-label="Fechar">${icon("close")}</button>
        </div>
        <div class="modal-body">
          <form class="stack" id="trafficLinkForm">
            <div class="row" style="gap:var(--s-3);align-items:flex-start">
              <div class="field grow"><label for="trafficLinkType">Tipo do enlace</label>
                <input class="input" id="trafficLinkType" value="${esc(dados.tipo)}" placeholder="Ex.: Uplink, Transporte"></div>
              <div class="field grow"><label for="trafficLinkCapacity">Capacidade</label>
                <input class="input" id="trafficLinkCapacity" value="${esc(dados.capacidade)}" placeholder="Ex.: 10 Gbps"></div>
            </div>
            <div class="field"><label for="trafficLinkDescription">Observação</label>
              <input class="input" id="trafficLinkDescription" value="${esc(dados.descricao)}" placeholder="Circuito, operadora ou referência operacional"></div>
            <div class="alert alert-info" style="animation:none">${icon("info")}
              <span>As pontas vêm do inventário do Zabbix. Aqui você edita os dados documentais da conexão na topologia.</span></div>
          </form>
        </div>
        <div class="modal-foot">
          <span class="dim" style="font-size:var(--fs-11)">${conexao ? "A alteração" : "O novo enlace"} será registrado na auditoria.</span>
          <span class="row"><button class="btn" data-close type="button">Cancelar</button>
            <button class="btn btn-primary" data-save-link type="button">Salvar conexão</button></span>
        </div>`,
      onMount: (host, close) => {
        $("#trafficLinkForm", host).onsubmit = (e) => { e.preventDefault(); $("[data-save-link]", host).click(); };
        $("[data-save-link]", host).onclick = async () => {
          const botao = $("[data-save-link]", host);
          const topologia = NOC.data();
          const antesConexoes = topologia.conexoes.map((c) => ({ ...c }));
          const statusA = a.porta.status;
          const statusB = b.porta.status;
          const ocupadaA = NOC.portConnection(a.equipamento.id, a.porta.numero);
          const ocupadaB = NOC.portConnection(b.equipamento.id, b.porta.numero);
          if ((!conexao && ocupadaA) || (!conexao && ocupadaB)) {
            toast("Uma das portas já está ocupada", { text: "Revise o enlace na topologia antes de salvá-lo.", type: "warn" });
            return;
          }

          const atualizada = {
            ...(conexao || {}),
            origem: conexao?.origem || a.equipamento.id,
            portaOrigem: conexao?.portaOrigem || Number(a.porta.numero),
            destino: conexao?.destino || b.equipamento.id,
            portaDestino: conexao?.portaDestino || Number(b.porta.numero),
            tipo: $("#trafficLinkType", host).value.trim() || "Enlace",
            capacidade: $("#trafficLinkCapacity", host).value.trim() || "A confirmar",
            descricao: $("#trafficLinkDescription", host).value.trim(),
            fonte: conexao?.fonte || "manual-trafego",
            confianca: conexao?.confianca || l.confianca,
          };

          if (conexao) topologia.conexoes[topologia.conexoes.indexOf(conexao)] = atualizada;
          else {
            topologia.conexoes.push(atualizada);
            a.porta.status = "conectada";
            b.porta.status = "conectada";
          }

          botao.disabled = true;
          botao.textContent = "Salvando…";
          try {
            await NOC.save(conexao ? "TOPOLOGY_UPDATE_CONEXAO_TRAFEGO" : "TOPOLOGY_CREATE_CONEXAO_TRAFEGO");
            close();
            renderGuia();
            toast("Conexão salva", { text: "Os dados do enlace foram atualizados na topologia.", type: "ok" });
          } catch (err) {
            topologia.conexoes = antesConexoes;
            a.porta.status = statusA;
            b.porta.status = statusB;
            botao.disabled = false;
            botao.textContent = "Salvar conexão";
            toast("Não foi possível salvar a conexão", { text: err.message, type: "danger" });
          }
        };
      },
    });
  }

  /* A projeção substitui as portas genéricas e os enlaces documentados dos
     equipamentos monitorados pelos dados derivados do inventário Zabbix.
     Primeiro fazemos um ensaio para que nenhuma remoção seja aplicada sem o
     operador conhecer o impacto. */
  async function aplicarNaTopologia() {
    const btn = $("#btnApplyTopology");
    btn.disabled = true;
    btn.textContent = "Analisando…";
    try {
      const previa = await NOC.zabbix.aplicarTopologia(false);
      const r = previa.resumo || {};
      const detalhes = [
        `${r.derivadas || 0} enlace(s) confirmado(s) pelo Zabbix`,
        `${r.externas || 0} enlace(s) até equipamento não monitorado`,
        `${r.descartadas || 0} vínculo(s) atual(is) substituído(s)`,
      ].join("; ");

      UI.confirm({
        title: "Usar enlaces do Zabbix?",
        text: `${detalhes}. As portas dos equipamentos monitorados também serão atualizadas.`,
        confirmLabel: "Aplicar na topologia",
        danger: (r.descartadas || 0) > 0,
        onConfirm: async () => {
          btn.disabled = true;
          btn.textContent = "Aplicando…";
          try {
            const aplicado = await NOC.zabbix.aplicarTopologia(true);
            await NOC.load();
            renderGuia();
            toast(`Topologia atualizada: ${aplicado.resumo?.conexoes_depois || 0} enlaces ativos.`, "ok");
          } catch (err) {
            toast(err.message, "danger");
          } finally {
            btn.disabled = false;
            btn.textContent = "Usar enlaces na topologia";
            NOC.applyActions(document);
          }
        },
      });
    } catch (err) {
      toast(err.message, "danger");
    } finally {
      btn.disabled = false;
      btn.textContent = "Usar enlaces na topologia";
      NOC.applyActions(document);
    }
  }

  function exportarCsv() {
    const linhas = [["Equipamento", "Interface", "Apelido", "Descrição", "Status", "Capacidade bps", "Entrada bps", "Saída bps", "Utilização %", "Erros"]];
    for (const i of filtradas()) {
      const u = utilizacao(i);
      linhas.push([
        rotuloEquipamento(i), i.if_name, rotuloInterface(i) === i.if_name ? "" : rotuloInterface(i), descricaoInterface(i),
        NOC.interfaceStatus(i).label, i.speed_bps ?? "", i.in_bps ?? "", i.out_bps ?? "",
        u === null ? "" : u.toFixed(2), erroDe(i),
      ]);
    }
    const csv = linhas.map((l) => l.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(";")).join("\r\n");
    const url = URL.createObjectURL(new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `trafego-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-")}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    toast("CSV gerado", { text: `${linhas.length - 1} interface(s) exportada(s) com os filtros atuais.`, type: "ok" });
  }

  /* ============================================================
     Modo telão
     ============================================================ */

  const paineisTv = () => state.settings.tvPaineis.filter((p) => PAINEIS_TV[p]);

  function renderTv() {
    const lista = paineisTv();
    if (!lista.length) return;
    const atual = lista[state.tv.indice % lista.length];
    const alvo = painel("visao");

    for (const g of GUIAS) painel(g.id).hidden = true;
    alvo.hidden = false;

    const corpo = atual === "kpis"
      ? `${blocos.kpis()}
         <div class="traf-grid cols-2" style="margin-top:var(--s-4)">
           <section class="card"><div class="card-body">${medidorCircular(totais().pico, "pico de utilização")}</div></section>
           <section class="card"><div class="card-body">${blocos.top()}</div></section>
         </div>`
      : atual === "fluxo" ? blocos.fluxo(320)
        : atual === "top" ? blocos.top()
          : atual === "alertas" ? blocos.alertas(8)
            : atual === "enlaces" ? blocos.enlaces(12)
              : blocos.equipamentos();

    alvo.innerHTML = `<section class="card"><div class="card-body">${corpo}</div></section>`;
    $("#tvPanelName").textContent = PAINEIS_TV[atual];

    $("#tvRail").innerHTML = lista.map((_, i) =>
      `<i class="${i === state.tv.indice % lista.length ? "is-now" : i < state.tv.indice % lista.length ? "is-done" : ""}"></i>`).join("");
  }

  function agendarTv() {
    clearInterval(state.tv.timer);
    const segundos = state.settings.tvRotacaoSegundos;
    if (!state.tv.ativo || !segundos || paineisTv().length < 2) return;
    state.tv.timer = setInterval(() => {
      if (state.tv.pausado) return;
      state.tv.indice += 1;
      renderTv();
    }, segundos * 1000);
  }

  function modoTv(ligar) {
    state.tv.ativo = ligar;
    document.body.classList.toggle("tv-mode", ligar);
    $("#btnTv").textContent = ligar ? "Sair do modo TV" : "Modo TV";

    if (ligar) {
      if (document.documentElement.requestFullscreen) document.documentElement.requestFullscreen().catch(() => {});
      renderTv();
      agendarTv();
    } else {
      clearInterval(state.tv.timer);
      if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
      renderGuia();
    }
  }

  /* ============================================================
     Dados
     ============================================================ */

  function guardarSerie() {
    // Ring buffer curto: a miniatura só precisa da forma recente, não do dia.
    const TETO = 40;
    for (const i of state.interfaces) {
      const chave = chaveDe(i);
      const atual = state.serie.get(chave) || [];
      atual.push(carga(i));
      if (atual.length > TETO) atual.shift();
      state.serie.set(chave, atual);
    }
    // Interface que sumiu do inventário não deve manter série órfã na memória.
    if (state.serie.size > state.interfaces.length * 2) {
      const vivas = new Set(state.interfaces.map(chaveDe));
      for (const chave of state.serie.keys()) if (!vivas.has(chave)) state.serie.delete(chave);
    }
  }

  let primeiraLeitura = true;

  async function carregar() {
    /* A primeira leitura vem do pedido disparado no <head>, antes de este
       arquivo terminar de baixar. As seguintes são pedidos normais. */
    const resposta = primeiraLeitura && window.__TRAFEGO_PREFETCH
      ? await window.__TRAFEGO_PREFETCH.catch(() => NOC.zabbix.overview(state.horas))
      : await NOC.zabbix.overview(state.horas);

    if (state.interfaces.length) state.totaisAnteriores = totais();
    state.settings = { ...AJUSTES_PADRAO, ...(resposta.settings || {}) };
    // A janela salva só manda na primeira leitura; depois vale a escolhida aqui.
    if (primeiraLeitura) state.horas = state.settings.historicoHoras;
    primeiraLeitura = false;
    state.podeEditarSettings = !!resposta.podeEditarSettings;
    state.interfaces = Array.isArray(resposta.interfaces) ? resposta.interfaces : [];
    state.hosts = Array.isArray(resposta.hosts) ? resposta.hosts : [];
    state.links = resposta.enlaces?.links || [];
    state.status = resposta.status || null;
    state.historico = resposta.historico?.amostras || [];
    state.ultimaLeitura = Date.now();
    guardarSerie();
  }

  function renderTudo() {
    renderPulse();
    renderTabs();
    if (state.tv.ativo) renderTv();
    else renderGuia();
  }

  function agendar() {
    clearInterval(state.timer);
    if (!$("#autoRefresh").checked) return;
    state.timer = setInterval(async () => {
      if (state.recarregando) return;
      state.recarregando = true;
      try {
        await carregar();
        renderTudo();
      } catch (err) {
        // Falha de recarga não derruba a tela: o próximo ciclo tenta de novo.
        console.error("Recarga do tráfego falhou:", err);
      } finally {
        state.recarregando = false;
      }
    }, AUTO_REFRESH_SECONDS * 1000);
  }

  async function sincronizar() {
    const btn = $("#btnSync");
    btn.disabled = true;
    btn.textContent = "Sincronizando…";
    try {
      const r = await NOC.zabbix.sync();
      toast(`Zabbix sincronizado: ${r.hosts} hosts e ${r.interfaces} interfaces.`, { type: "ok" });
      await carregar();
      renderTudo();
    } catch (err) {
      toast("Falha na sincronização", { text: err.message, type: "danger" });
    } finally {
      btn.disabled = false;
      btn.textContent = "Sincronizar agora";
      NOC.applyActions(document);
    }
  }

  /* ============================================================
     Navegação entre guias
     ============================================================ */

  /* Sobe a topologia e repinta a guia que depende dela. Chamada tanto pelo
     carregamento em segundo plano quanto ao abrir a guia de Enlaces — assim a
     edição fica disponível mesmo que o segundo plano tenha falhado. */
  let topologiaTentada = false;
  function garantirTopologia() {
    if (NOC.data() || topologiaTentada) return;
    topologiaTentada = true;
    NOC.loadTopologyOnce()
      .then(() => { if (state.guia === "enlaces" && !state.tv.ativo) renderGuia(); })
      .catch(() => {
        // A tela funciona sem ela; a próxima abertura da guia tenta de novo.
        topologiaTentada = false;
      });
  }

  function irPara(id, { foco = false } = {}) {
    if (!GUIAS.some((g) => g.id === id)) id = "visao";
    state.guia = id;
    if (location.hash.slice(1) !== id) history.replaceState(null, "", `#${id}`);
    renderTabs();
    renderGuia();
    if (foco) $(`#tab-${id}`)?.focus();
  }

  function ligarEventosDoCabecalho() {
    $("#btnSync").onclick = sincronizar;
    $("#autoRefresh").onchange = agendar;
    $("#btnTv").onclick = () => modoTv(!state.tv.ativo);

    $("#tabs").addEventListener("click", (e) => {
      const b = e.target.closest("[data-guia]");
      if (b) irPara(b.dataset.guia);
    });

    // Setas percorrem as guias, como manda o padrão de tablist.
    $("#tabs").addEventListener("keydown", (e) => {
      const indice = GUIAS.findIndex((g) => g.id === state.guia);
      const mapa = { ArrowRight: indice + 1, ArrowLeft: indice - 1, Home: 0, End: GUIAS.length - 1 };
      if (!(e.key in mapa)) return;
      e.preventDefault();
      const proxima = (mapa[e.key] + GUIAS.length) % GUIAS.length;
      irPara(GUIAS[proxima].id, { foco: true });
    });

    addEventListener("hashchange", () => irPara(location.hash.slice(1) || "visao"));

    addEventListener("keydown", (e) => {
      const digitando = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName);
      if (digitando || e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key === "Escape" && state.tv.ativo) { modoTv(false); return; }
      if (e.key.toLowerCase() === "v") { modoTv(!state.tv.ativo); return; }
      if (!state.tv.ativo) return;
      if (e.key === "ArrowRight") { state.tv.indice += 1; renderTv(); }
      if (e.key === "ArrowLeft") { state.tv.indice = Math.max(0, state.tv.indice - 1); renderTv(); }
      if (e.key === " ") {
        e.preventDefault();
        state.tv.pausado = !state.tv.pausado;
        toast(state.tv.pausado ? "Rotação pausada" : "Rotação retomada", { type: "info", timeout: 1800 });
      }
    });

    // Ordenação e ações que vivem dentro do HTML repintado.
    document.addEventListener("click", (e) => {
      const ordenacao = e.target.closest("[data-sort-scope][data-sort-key]");
      if (ordenacao) { alternarOrdenacao(ordenacao.dataset.sortScope, ordenacao.dataset.sortKey); return; }

      const link = e.target.closest("[data-edit-link]");
      if (link && !link.disabled) {
        const alvo = state.links.find((item) => chaveLink(item) === link.dataset.editLink);
        if (alvo) editarLink(alvo);
        return;
      }

      const iface = e.target.closest("[data-edit-if]");
      if (iface && !iface.disabled) { editarInterface(iface.dataset.editIf); return; }

      const host = e.target.closest("[data-vincular-host]");
      if (host && !host.disabled) { vincularHost(host.dataset.vincularHost); return; }

      const guia = e.target.closest("[data-ir-guia]");
      if (guia) { irPara(guia.dataset.irGuia); return; }

      const equipamento = e.target.closest("[data-ver-equipamento]");
      if (equipamento) {
        state.filtro.equipamento = equipamento.dataset.verEquipamento;
        irPara("interfaces");
        return;
      }

      const alerta = e.target.closest("[data-alerta-alvo]");
      if (alerta) {
        const { alertaAlvo, alertaChave } = alerta.dataset;
        if (alertaAlvo === "guia") irPara(alertaChave);
        else if (alertaAlvo === "link") irPara("enlaces");
        else {
          const alvo = state.interfaces.find((i) => chaveDe(i) === alertaChave);
          state.filtro.busca = alvo ? alvo.if_name : "";
          irPara("interfaces");
        }
      }
    });
  }

  /* Eventos dos controles que só existem enquanto a guia está montada. */
  function ligarEventosDaGuia() {
    if (state.guia === "visao") {
      $$("[data-periodo]").forEach((b) => (b.onclick = async () => {
        const horas = Number(b.dataset.periodo);
        try {
          const r = await NOC.zabbix.history(horas);
          state.historico = r.amostras || [];
          state.horas = horas;
        } catch (err) {
          toast("Não foi possível carregar o período", { text: err.message, type: "danger" });
        }
        renderGuia();
      }));
    }

    if (state.guia === "enlaces") {
      const b = $("#btnApplyTopology");
      if (b) b.onclick = aplicarNaTopologia;
      // Abrir a guia é o gatilho garantido: aqui a topologia é indispensável.
      garantirTopologia();
    }

    if (state.guia === "interfaces") {
      $("#fEquip").onchange = (e) => { state.filtro.equipamento = e.target.value; renderGuia(); };
      $("#fBusca").oninput = (e) => {
        state.filtro.busca = e.target.value;
        const foco = document.activeElement === $("#fBusca");
        const posicao = $("#fBusca").selectionStart;
        renderGuia();
        if (foco) { $("#fBusca").focus(); $("#fBusca").setSelectionRange(posicao, posicao); }
      };
      $("#fAlerta").onclick = () => { state.filtro.somenteAlerta = !state.filtro.somenteAlerta; renderGuia(); };
      $("#btnCsv").onclick = exportarCsv;
      $("#btnDensidade").onclick = () => {
        state.densidade = state.densidade === "compacta" ? "confortavel" : "compacta";
        renderGuia();
      };
      $$("#fStatus .tab").forEach((b) => (b.onclick = () => {
        state.filtro.status = b.dataset.st;
        renderGuia();
      }));
    }

    if (state.guia === "ajustes") {
      const salvar = $("#btnSalvarAjustes");
      if (salvar) salvar.onclick = async () => {
        salvar.disabled = true;
        salvar.textContent = "Salvando…";
        const ok = await salvarAjustes(lerAjustesDoFormulario());
        if (!ok) { salvar.disabled = false; salvar.textContent = "Salvar ajustes"; }
      };

      const restaurar = $("#btnRestaurar");
      if (restaurar) restaurar.onclick = () => UI.confirm({
        title: "Restaurar os ajustes padrão?",
        text: "Limites, período, rotação do telão e os apelidos das interfaces voltam ao estado inicial.",
        confirmLabel: "Restaurar",
        danger: true,
        onConfirm: () => salvarAjustes({ ...AJUSTES_PADRAO }, "Ajustes restaurados"),
      });

      $$("[data-remover-ajuste]").forEach((b) => (b.onclick = () => {
        const interfaces = { ...state.settings.interfaces };
        delete interfaces[b.dataset.removerAjuste];
        salvarAjustes({ interfaces }, "Ajuste removido");
      }));
    }
  }

  /* ============================================================
     Início
     ============================================================ */

  async function boot() {
    UI.mountShell();
    UI.clock("#tvClock", "#tvDate");
    NOC.skeleton(painel("visao"), 6);

    try {
      /* Acesso e dados sobem juntos: o acesso já foi pedido pelo guardião e o
         inventário, pelo script do <head>. Nenhum dos dois espera pelo outro. */
      await Promise.all([
        NOC.loadAccess().catch(() => null),
        carregar(),
      ]);
    } catch (err) {
      NOC.errorState(painel("visao"), err, () => location.reload());
      return;
    }

    aplicarAjustes();
    state.guia = GUIAS.some((g) => g.id === location.hash.slice(1)) ? location.hash.slice(1) : "visao";

    NOC.applyActions(document);
    renderTudo();
    ligarEventosDoCabecalho();
    agendar();

    state.relogio = setInterval(atualizarFrescor, 1000);

    if (new URLSearchParams(location.search).has("tv")) modoTv(true);

    /* A topologia só serve para editar a documentação dos enlaces e vincular
       host a equipamento. Ela sobe depois do primeiro desenho, em segundo
       plano: assim a tela já está útil quando ela chega, e quem só monitora
       nunca paga por ela.

       O `timeout` não é enfeite: aba em segundo plano — que é o caso de um
       telão deixado em outro monitor — nunca chega a ficar ociosa, e sem ele o
       carregamento não acontecia nunca. O botão de editar ficava para sempre
       em "Carregando a topologia…", um rótulo mentiroso. */
    if (window.requestIdleCallback) requestIdleCallback(garantirTopologia, { timeout: 2000 });
    else setTimeout(garantirTopologia, 400);
  }

  boot();
})();
