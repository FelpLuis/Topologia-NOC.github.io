/* ============================================================
   UPDOWN NOC — carga dos enlaces (cor por tráfego)

   Uma fonte só para a cor, a legenda e a dica de todos os mapas e
   esquemas: topologia (esquema e mapa geográfico), anel de POPs,
   mapa da parte ISP e as rotas de rede do mapa GPON. Sem isto cada
   tela inventava a própria escala, e o operador precisava reler a
   legenda ao trocar de tela.

   A carga vem do espelho do Zabbix (/api/zabbix/utilizacao), que o
   cron reescreve a cada 5 minutos. Cada porta da topologia guarda
   `zabbix.hostid` e `zabbix.ifIndex`, e é por esse par que a leitura
   encontra a interface — o mesmo par que a projeção do inventário
   gravou. Porta sem esse par não tem medida, e a linha fica cinza em
   vez de ganhar uma cor inventada.
   ============================================================ */
window.TRAF = (() => {
  "use strict";

  /* Escala de utilização, no mesmo desenho que o NOC já lê em outras
     ferramentas de rede: fria enquanto sobra banda, quente quando o enlace
     começa a encher. Cada faixa vale do seu `min` (inclusive) até o `min` da
     seguinte — 3% cai na faixa de 1%, como em qualquer weathermap. */
  const ESCALA = [
    { min: 0,  rotulo: "0%",  cor: "#2fb8cf" },
    { min: 1,  rotulo: "1%",  cor: "#7fd18b" },
    { min: 5,  rotulo: "5%",  cor: "#46b45c" },
    { min: 15, rotulo: "15%", cor: "#d9c521" },
    { min: 25, rotulo: "25%", cor: "#f0a91e" },
    { min: 50, rotulo: "50%", cor: "#ef8b1c" },
    { min: 70, rotulo: "70%", cor: "#e8671f" },
    { min: 80, rotulo: "80%", cor: "#dc4a3d" },
    { min: 90, rotulo: "90%", cor: "#b3161c" },
  ];
  const OFFLINE = { rotulo: "Offline", cor: "#8b939c" };
  /* Enlace sem interface monitorada não entra na escala: pintá-lo com a cor de
     0% afirmaria "sem uso" sobre algo que ninguém mediu. */
  const SEM_DADO = { rotulo: "Sem dado", cor: "#4d5560" };

  const INTERVALO_MS = 60000;   // o espelho do Zabbix é reescrito a cada 5 min

  const state = {
    medidas: new Map(),   // "hostid|ifIndex" -> { oper, capacidade, entrada, saida }
    coletadoEm: null,
    erro: null,
    buscando: null,
    timer: 0,
    /* Inscrito -> { tempoReal, intervaloMs }. A gaveta do equipamento da
       topologia pede leitura ao vivo (realtime=1) e intervalo curto; os mapas
       continuam no espelho. Cada inscrito diz a própria necessidade, e o
       módulo atende a maior: a requisição usa tempo real se alguém pedir, e o
       intervalo do timer é o menor entre os inscritos. */
    inscritos: new Map(),
  };

  const chave = (hostid, ifIndex) => `${hostid}|${Number(ifIndex)}`;
  const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

  /* ---------------- escala ---------------- */

  /* Faixa de uma utilização já calculada. Percentual acima de 100 (leitura
     esticada pelo contador, ou capacidade desatualizada) fica na faixa mais
     alta em vez de sair da escala. */
  function faixa(pct) {
    const p = Number(pct);
    if (!Number.isFinite(p)) return SEM_DADO;
    let atual = ESCALA[0];
    for (const f of ESCALA) if (p >= f.min) atual = f;
    return atual;
  }

  /* Faixa de uma medida inteira — é aqui que Offline e "sem dado" entram, e
     por isso é esta a função que as telas usam. */
  function faixaDe(m) {
    if (!m || m.estado === "sem-dado") return SEM_DADO;
    if (m.estado === "offline") return OFFLINE;
    return faixa(m.pct);
  }

  const cor = (m) => faixaDe(m).cor;

  /* ---------------- leitura das portas ---------------- */

  const portaDe = (deviceId, numero) => (NOC.data()?.equipamentos || [])
    .find((e) => e.id === deviceId)?.portas
    ?.find((p) => Number(p.numero) === Number(numero));

  /* Medida bruta de uma porta: o que o espelho do Zabbix diz sobre a interface
     correspondente. A capacidade cai para o `speedBps` gravado na topologia
     quando o espelho não traz velocidade — é o mesmo número, só mais velho. */
  function daPorta(porta) {
    const z = porta?.zabbix;
    if (!z || z.hostid === undefined || z.hostid === null) return null;
    const lida = state.medidas.get(chave(z.hostid, z.ifIndex));
    const oper = Number.isFinite(Number(lida?.oper)) ? Number(lida.oper)
      : Number.isFinite(Number(z.operStatus)) ? Number(z.operStatus) : null;
    if (oper === null) return null;
    return {
      oper,
      capacidade: num(lida?.capacidade) || num(z.speedBps),
      entrada: lida ? num(lida.entrada) : 0,
      saida: lida ? num(lida.saida) : 0,
      medido: !!lida,
    };
  }

  /* Medida de uma porta da topologia, já no formato das telas (estado, pct,
     cor, rótulo). É o que a gaveta do equipamento usa para mostrar tráfego em
     cada porta da grade e da lista. */
  function medidaDePorta(deviceId, numero) {
    const porta = portaDe(deviceId, numero);
    if (!porta) return null;
    const m = daPorta(porta);
    if (!m) return null;
    return montar({
      entrada: m.entrada,
      saida: m.saida,
      capacidade: m.capacidade,
      pontas: 1,
      caidas: m.oper !== 1 ? 1 : 0,
      medido: m.medido,
    });
  }

  /* Medida de um enlace documentado.

     O tráfego de um ponto a ponto é simétrico: a entrada de uma ponta é a
     saída da outra. Somar as duas contaria o mesmo pacote duas vezes, então a
     leitura vem de uma ponta só — a de origem quando ela é medida, senão a de
     destino. A capacidade é a menor das duas velocidades conhecidas, porque é
     a ponta mais estreita que limita o enlace. */
  function doEnlace(conexao) {
    if (!conexao) return semDado();
    const a = daPorta(portaDe(conexao.origem, conexao.portaOrigem));
    const b = daPorta(portaDe(conexao.destino, conexao.portaDestino));
    const pontas = [a, b].filter(Boolean);
    if (!pontas.length) return semDado();

    const caidas = pontas.filter((p) => p.oper !== 1).length;
    const capacidades = pontas.map((p) => p.capacidade).filter((c) => c > 0);
    const capacidade = capacidades.length ? Math.min(...capacidades) : 0;
    const ref = (a && a.medido ? a : null) || (b && b.medido ? b : null);

    return montar({
      entrada: ref ? ref.entrada : 0,
      saida: ref ? ref.saida : 0,
      capacidade,
      pontas: pontas.length,
      caidas,
      medido: !!ref,
    });
  }

  /* Medida de um feixe: várias conexões desenhadas como uma linha só (enlaces
     agregados, ou a rota do anel entre dois POPs). Aqui somar é o certo — são
     caminhos físicos diferentes, e a capacidade do feixe é a soma. */
  function doConjunto(conexoes) {
    const medidas = (conexoes || []).map(doEnlace).filter((m) => m.estado !== "sem-dado");
    if (!medidas.length) return semDado();
    return montar({
      entrada: medidas.reduce((a, m) => a + m.entrada, 0),
      saida: medidas.reduce((a, m) => a + m.saida, 0),
      capacidade: medidas.reduce((a, m) => a + m.capacidade, 0),
      pontas: medidas.reduce((a, m) => a + m.pontas, 0),
      caidas: medidas.reduce((a, m) => a + m.caidas, 0),
      medido: medidas.some((m) => m.medido),
      enlaces: medidas.length,
    });
  }

  const semDado = () => ({
    estado: "sem-dado", entrada: 0, saida: 0, capacidade: 0,
    pct: null, pontas: 0, caidas: 0, medido: false, enlaces: 0, parcial: false,
  });

  function montar({ entrada, saida, capacidade, pontas, caidas, medido, enlaces = 1 }) {
    const tudoCaido = pontas > 0 && caidas === pontas;
    /* Sem capacidade conhecida não há percentual: a dica mostra o volume, mas
       a cor não pode afirmar quanto do enlace está ocupado. */
    const pct = !tudoCaido && medido && capacidade > 0
      ? (Math.max(entrada, saida) / capacidade) * 100
      : null;
    return {
      estado: tudoCaido ? "offline" : medido ? "up" : "sem-dado",
      entrada, saida, capacidade, pct, pontas, caidas, medido, enlaces,
      parcial: caidas > 0 && !tudoCaido,
    };
  }

  /* ---------------- textos ---------------- */

  const bps = (v) => NOC.formatBps(v);
  const pctTexto = (p) => (Number.isFinite(p)
    ? `${p >= 10 ? Math.round(p) : p.toFixed(1).replace(".", ",")}%`
    : "—");

  /* Rótulo curto, do tamanho que cabe na etiqueta em cima da linha. */
  function rotulo(m) {
    if (!m || m.estado === "sem-dado") return "sem dado";
    if (m.estado === "offline") return "offline";
    const pico = Math.max(m.entrada, m.saida);
    return Number.isFinite(m.pct) ? `${bps(pico)} · ${pctTexto(m.pct)}` : bps(pico);
  }

  /* Linhas da dica de tráfego. A primeira é o título e sai em negrito. */
  function linhasDica(m, titulo, extra) {
    const linhas = [titulo || "Enlace"];
    if (extra) linhas.push(extra);
    if (!m || m.estado === "sem-dado") {
      linhas.push("Sem interface monitorada no Zabbix");
      return linhas;
    }
    if (m.estado === "offline") {
      linhas.push("Fora do ar — sem tráfego medido");
      if (m.capacidade > 0) linhas.push(`Capacidade ${bps(m.capacidade)}`);
      return linhas;
    }
    linhas.push(`Entrada ${bps(m.entrada)} · Saída ${bps(m.saida)}`);
    linhas.push(m.capacidade > 0
      ? `${pctTexto(m.pct)} de ${bps(m.capacidade)}${m.enlaces > 1 ? ` em ${m.enlaces} enlaces` : ""}`
      : "Capacidade não informada — sem percentual");
    if (m.parcial) linhas.push(`${m.caidas} de ${m.pontas} pontas fora do ar`);
    if (state.coletadoEm) linhas.push(`Medido às ${horaCurta(state.coletadoEm)}`);
    return linhas;
  }

  /* Texto de uma linha só, para o <title> nativo do SVG — é o que continua
     valendo quando a dica flutuante não está ligada na tela. */
  const dica = (m, titulo, extra) => linhasDica(m, titulo, extra).join(" — ");

  /* O espelho grava "2026-08-20 13:45:00" (UTC, sem fuso). Sem o Z o navegador
     leria como hora local e mostraria a coleta no futuro. */
  function horaCurta(iso) {
    const bruto = String(iso);
    const t = bruto.includes("T") ? bruto : `${bruto.replace(" ", "T")}Z`;
    const d = new Date(t);
    return Number.isNaN(d.getTime()) ? bruto
      : d.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
  }

  /* ---------------- legenda ---------------- */

  /* A legenda mostra a escala inteira, sempre nas mesmas posições, com quantos
     enlaces do desenho caíram em cada faixa. Faixa vazia continua visível: é a
     posição fixa que permite ler a cor de uma linha sem contar as caixinhas.
     "Sem dado" só aparece quando existe — é exceção, não parte da escala. */
  function legendaHTML(medidas = []) {
    const conta = new Map();
    let semDados = 0;
    for (const m of medidas) {
      const f = faixaDe(m);
      if (f === SEM_DADO) { semDados++; continue; }
      conta.set(f.rotulo, (conta.get(f.rotulo) || 0) + 1);
    }
    const item = (f, n) => `<span class="traf-faixa" style="--traf-cor:${f.cor}"
      ><i></i><b>${f.rotulo}</b><span>(${n})</span></span>`;
    return `<div class="traf-legenda" role="img"
      aria-label="Legenda de utilização dos enlaces, da menor para a maior">
      ${item(OFFLINE, conta.get(OFFLINE.rotulo) || 0)}
      ${ESCALA.map((f) => item(f, conta.get(f.rotulo) || 0)).join("")}
      ${semDados ? item(SEM_DADO, semDados) : ""}
    </div>`;
  }

  /* ---------------- dica flutuante ---------------- */

  /* O <title> do SVG demora cerca de um segundo para aparecer e some quando o
     ponteiro se move — o operador que passa o mouse pela linha para ler o
     tráfego acaba não lendo nada. Esta dica é imediata e acompanha o cursor.
     A delegação fica no contêiner porque o SVG é reescrito inteiro a cada
     repintura: ouvintes presos às linhas morreriam junto com elas. */
  let balao = null;

  function baloe() {
    if (!balao) {
      balao = document.createElement("div");
      balao.className = "traf-dica";
      balao.hidden = true;
      document.body.appendChild(balao);
    }
    return balao;
  }

  function mostrar(texto, ev) {
    const el = baloe();
    const [titulo, ...resto] = String(texto).split("|");
    el.innerHTML = `<b>${UI.esc(titulo)}</b>${resto.map((l) => `<span>${UI.esc(l)}</span>`).join("")}`;
    el.hidden = false;
    posicionar(ev);
  }

  /* O balão vira para dentro perto das bordas: encostado na direita da tela
     ele sairia do viewport e o operador leria metade do número. */
  function posicionar(ev) {
    const el = baloe();
    const r = el.getBoundingClientRect();
    const x = Math.min(ev.clientX + 14, window.innerWidth - r.width - 8);
    const y = ev.clientY + 18 + r.height > window.innerHeight
      ? ev.clientY - r.height - 14
      : ev.clientY + 18;
    el.style.left = `${Math.max(8, x)}px`;
    el.style.top = `${Math.max(8, y)}px`;
  }

  const esconder = () => { if (balao) { balao.hidden = true; balao.dataset.origem = ""; } };

  function ligarDica(host) {
    if (!host || host.dataset.trafDica === "1") return;
    host.dataset.trafDica = "1";
    host.addEventListener("pointermove", (ev) => {
      const texto = ev.target?.closest?.("[data-traf]")?.getAttribute("data-traf");
      if (!texto) return esconder();
      if (!balao || balao.hidden || balao.dataset.origem !== texto) {
        mostrar(texto, ev);
        balao.dataset.origem = texto;
      } else posicionar(ev);
    });
    host.addEventListener("pointerleave", esconder);
    host.addEventListener("pointerdown", esconder);
    window.addEventListener("scroll", esconder, { passive: true });
  }

  /* Atributos prontos para colar na linha: a dica flutuante e o <title> nativo
     saem do mesmo texto, para as duas nunca divergirem. */
  function atributos(m, titulo, extra) {
    const linhas = linhasDica(m, titulo, extra);
    return { dica: linhas.join("|"), title: linhas.join(" — "), cor: cor(m) };
  }

  /* ---------------- carga do espelho ---------------- */

  function aplicar(resposta) {
    const mapa = new Map();
    for (const i of resposta?.interfaces || []) {
      mapa.set(chave(i.hostid, i.if_index), {
        oper: Number.isFinite(Number(i.oper_status)) ? Number(i.oper_status) : null,
        capacidade: num(i.speed_bps),
        entrada: num(i.in_bps),
        saida: num(i.out_bps),
      });
    }
    state.medidas = mapa;
    state.coletadoEm = resposta?.coletado_em || null;
    state.erro = null;
  }

  function atualizar() {
    if (state.buscando) return state.buscando;
    const tempoReal = [...state.inscritos.values()].some((s) => s.tempoReal);
    state.buscando = NOC.zabbix.utilizacao({ tempoReal })
      .then((r) => { aplicar(r); avisar(); return r; })
      .catch((err) => {
        /* Falha de leitura não apaga a última medida boa: a tela continua
           mostrando o que sabia, e o erro aparece na barra da legenda. */
        state.erro = err?.message || String(err);
        avisar();
      })
      .finally(() => { state.buscando = null; });
    return state.buscando;
  }

  /* O inscrito é a CHAVE do mapa — o valor guarda a necessidade dele
     (tempo real, intervalo). Um inscrito que quebra não pode derrubar os
     outros, mas some do log se o erro for engolido em silêncio. */
  const avisar = () => state.inscritos.forEach((_, cb) => {
    try { cb(); } catch (err) { console.error("Falha ao repintar com a carga do enlace:", err); }
  });

  function agendar() {
    clearInterval(state.timer);
    state.timer = 0;
    if (!state.inscritos.size || document.hidden) return;
    const intervalo = Math.min(...[...state.inscritos.values()].map((s) => s.intervaloMs));
    state.timer = setInterval(atualizar, intervalo);
  }

  document.addEventListener("visibilitychange", () => {
    /* Mapa em aba escondida não precisa de medida nova; ao voltar, a primeira
       leitura é imediata para o operador não olhar para um número velho. */
    if (!document.hidden && state.inscritos.size) atualizar();
    agendar();
  });

  /* Liga a tela na carga: `aoAtualizar` é chamado a cada leitura nova, e a
     função devolvida desliga. Só quem chama isto gera requisição.
     Opções: { tempoReal, intervaloMs } — a gaveta do equipamento usa tempo
     real com intervalo curto, os mapas seguem no espelho de um minuto. */
  function acompanhar(aoAtualizar, { tempoReal = false, intervaloMs = INTERVALO_MS } = {}) {
    if (typeof aoAtualizar === "function") state.inscritos.set(aoAtualizar, { tempoReal, intervaloMs });
    agendar();
    atualizar();
    return () => {
      state.inscritos.delete(aoAtualizar);
      agendar();
    };
  }

  return {
    ESCALA, OFFLINE, SEM_DADO,
    faixa, faixaDe, cor, daPorta, medidaDePorta, doEnlace, doConjunto,
    rotulo, dica, linhasDica, atributos, legendaHTML, ligarDica,
    acompanhar, atualizar,
    pronto: () => state.medidas.size > 0,
    coletadoEm: () => state.coletadoEm,
    erro: () => state.erro,
    formatBps: bps,
    pctTexto,
  };
})();
