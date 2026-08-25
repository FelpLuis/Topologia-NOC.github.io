/* ============================================================
   UPDOWN NOC — Home
   A primeira tela de qualquer usuário. Três leituras, na ordem em
   que a operação pergunta: quantos clientes estão de pé, quanto a
   rede está carregando e o que ainda não foi visto por quem entrou.

   Nada é calculado aqui: /api/home/overview devolve os números já
   apurados das mesmas fontes das telas especializadas. Esta tela
   desenha e leva para lá.
   ============================================================ */
(() => {
  "use strict";
  const { $, $$, esc, icon, toast, modal } = UI;

  const RECARGA_MS = 60000;
  const COMENTARIO_MAX = 600; // o mesmo teto que o Worker aplica ao gravar.
  const state = { dados: null, carregando: false, timer: null };

  const inteiro = (v) => Number(v || 0).toLocaleString("pt-BR");
  const bps = (v) => NOC.formatBps(v);

  /* Volume acumulado no período. Bytes, e não bits: é a unidade em que
     franquia e trânsito são cobrados, que é onde esse número é usado. */
  function bytes(valor) {
    const n = Number(valor);
    if (!Number.isFinite(n) || n <= 0) return "0 B";
    const unidades = ["B", "KB", "MB", "GB", "TB", "PB"];
    const i = Math.min(Math.floor(Math.log10(n) / 3), unidades.length - 1);
    const escala = n / 1000 ** i;
    return `${escala >= 100 ? Math.round(escala) : escala.toFixed(escala >= 10 ? 1 : 2)} ${unidades[i]}`;
  }

  const pct = (parte, total) => (total > 0 ? Math.round((parte / total) * 100) : 0);

  /* Ler e escrever data fica em TEMPO (noc-tempo.js): é ele que sabe que o
     "YYYY-MM-DD HH:MM:SS" do SQLite é UTC e que a tela fala São Paulo. */
  const instante = TEMPO.instante;

  function desde(valor) {
    const d = instante(valor);
    if (!d) return "—";
    const minutos = Math.round((Date.now() - d.getTime()) / 60000);
    if (minutos < 1) return "agora";
    if (minutos < 60) return `há ${minutos} min`;
    if (minutos < 60 * 24) return `há ${Math.round(minutos / 60)} h`;
    return TEMPO.fmt(d, { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
  }

  const relogio = (valor) => TEMPO.hora(valor);

  function semPermissao(mensagem) {
    return `<div class="empty" style="padding:var(--s-6) 0">
      <span class="empty-icon">${icon("lock")}</span>
      <b>Sem acesso a este bloco</b>
      <p>${esc(mensagem)}</p>
    </div>`;
  }

  /* ---------------- clientes ---------------- */
  function renderClientes(c) {
    const host = $("#blocoClientes");
    if (!c?.permitido) {
      host.innerHTML = semPermissao("Seu perfil não tem a ação de visualizar a topologia, que é o que libera a base de clientes.");
      $("#kickerClientes").textContent = "Base GPON";
      return;
    }

    $("#kickerClientes").innerHTML = c.configurado
      ? `<i class="dot ${c.indisponivel ? "dot-warn" : "dot-ok"}"></i> ${esc(c.fonte || "Coletor GPON")} • ${esc(relogio(c.sincronizado_em))}`
      : `<i class="dot dot-warn"></i> Integração pendente`;

    if (!c.configurado) {
      host.innerHTML = `<div class="empty" style="padding:var(--s-6) 0">
        <span class="empty-icon">${icon("users")}</span>
        <b>Nenhuma sincronização recebida</b>
        <p>${esc(c.mensagem || "O coletor ainda não enviou a primeira atualização GPON.")}</p>
      </div>`;
      return;
    }

    const online = pct(c.online, c.total);
    host.innerHTML = `
      <div class="home-stats">
        <div class="home-stat is-accent">
          <span>Total</span><strong>${inteiro(c.total)}</strong>
          <small>clientes autenticados</small>
        </div>
        <div class="home-stat is-ok">
          <span>Online</span><strong>${inteiro(c.online)}</strong>
          <small>${online}% da base</small>
        </div>
        <div class="home-stat ${c.offline ? "is-danger" : ""}">
          <span>Offline</span><strong>${inteiro(c.offline)}</strong>
          <small>${c.offline ? "sem serviço agora" : "nenhum sem serviço"}</small>
        </div>
      </div>

      <div>
        <div class="home-split" role="img"
             aria-label="${inteiro(c.online)} clientes online e ${inteiro(c.offline)} offline">
          <i class="on" style="width:${online}%"></i>
          <i class="off" style="width:${100 - online}%"></i>
        </div>
        <div class="home-legend" style="margin-top:var(--s-3)">
          <span><i class="dot dot-ok"></i> Online <b>${inteiro(c.online)}</b></span>
          <span><i class="dot dot-danger"></i> Offline <b>${inteiro(c.offline)}</b></span>
          ${c.parcial ? `<span class="dim">${icon("info")} contagem parcial: a leitura de status ainda não cobre toda a base</span>` : ""}
        </div>
      </div>

      ${c.indisponivel ? `<div class="alert alert-warn" style="animation:none">${icon("alert")}
        <span>${esc(c.mensagem || "A fonte da OLT não respondeu nesta atualização. Os números são da última leitura válida.")}</span></div>` : ""}`;
  }

  /* ---------------- tráfego ---------------- */

  /* Miniatura do período. O mínimo aparece como linha tracejada: é ele que
     mostra o piso da rede, que é o que se compara com o pico. */
  function sparkline(serie, minimo, maximo) {
    if (!Array.isArray(serie) || serie.length < 2) return "";
    const largura = 600;
    const altura = 72;
    const teto = Math.max(maximo, ...serie.map((p) => Number(p.bps) || 0), 1);
    const x = (i) => (i / (serie.length - 1)) * largura;
    const y = (v) => altura - (Math.max(0, Number(v) || 0) / teto) * (altura - 6) - 3;

    const linha = serie.map((p, i) => `${i ? "L" : "M"}${x(i).toFixed(1)} ${y(p.bps).toFixed(1)}`).join(" ");
    const area = `${linha} L${largura} ${altura} L0 ${altura} Z`;
    const piso = y(minimo).toFixed(1);

    return `<svg class="home-spark" viewBox="0 0 ${largura} ${altura}" preserveAspectRatio="none" role="img"
                 aria-label="Variação do tráfego no período">
      <defs>
        <linearGradient id="homeSparkFill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="#1dc9ff" stop-opacity=".35"/>
          <stop offset="100%" stop-color="#1dc9ff" stop-opacity="0"/>
        </linearGradient>
      </defs>
      <path class="home-spark-area" d="${area}"/>
      <path class="home-spark-line" d="${linha}"/>
      <line class="home-spark-min" x1="0" y1="${piso}" x2="${largura}" y2="${piso}"/>
    </svg>`;
  }

  function renderTrafego(t) {
    const host = $("#blocoTrafego");
    if (!t?.permitido) {
      host.innerHTML = semPermissao("Seu perfil não tem a ação de consultar o Zabbix, que é a fonte do painel de tráfego.");
      $("#kickerTrafego").textContent = "Rede";
      return;
    }

    $("#kickerTrafego").innerHTML = t.amostras
      ? `<i class="dot dot-ok dot-live"></i> Últimas ${esc(String(t.horas))} h • ${esc(relogio(t.coletado_em))}`
      : `<i class="dot dot-warn"></i> Sem histórico no período`;

    host.innerHTML = `
      <div class="home-stats">
        <div class="home-stat is-accent">
          <span>Atual</span><strong>${esc(bps(t.atual))}</strong>
          <small>${esc(bps(t.entrada))} entrada • ${esc(bps(t.saida))} saída</small>
        </div>
        <div class="home-stat">
          <span>Mínimo</span><strong>${esc(bps(t.minimo))}</strong>
          <small>piso das últimas ${esc(String(t.horas))} h</small>
        </div>
        <div class="home-stat">
          <span>Total</span><strong>${esc(bytes(t.total_bytes))}</strong>
          <small>volume transportado no período</small>
        </div>
      </div>

      ${sparkline(t.serie, t.minimo, t.maximo)}

      <div class="home-legend">
        <span>Pico <b>${esc(bps(t.maximo))}</b></span>
        <span>Interfaces <b>${inteiro(t.interfaces_up)}/${inteiro(t.interfaces)}</b> no ar</span>
        <span>Amostras <b>${inteiro(t.amostras)}</b></span>
      </div>

      ${t.amostras ? "" : `<div class="alert alert-info" style="animation:none">${icon("info")}
        <span>O histórico é gravado a cada sincronização do Zabbix. Assim que o primeiro ciclo rodar, a curva aparece aqui.</span></div>`}`;
  }

  /* ---------------- alertas ---------------- */
  const GRAU = {
    critico: { um: "crítico", varios: "críticos", badge: "badge-danger", dot: "dot-danger" },
    atencao: { um: "em atenção", varios: "em atenção", badge: "badge-warn", dot: "dot-warn" },
    info: { um: "informativo", varios: "informativos", badge: "badge-info", dot: "dot-info" },
  };

  /* Cada alerta sabe de onde veio: o botão leva à guia do painel de tráfego
     onde ele é tratado — a tela lê a guia do fragmento — em vez de largar a
     pessoa na visão geral dele. */
  const GUIAS_TRAFEGO = new Set(["visao", "enlaces", "interfaces", "grafico", "equipamentos", "alertas"]);
  const destinoDe = (a) => {
    if (a.alvo_tipo !== "trafego") return "/gpon.html";
    const guia = GUIAS_TRAFEGO.has(a.alvo_chave) ? a.alvo_chave : "alertas";
    return `/trafego.html#${guia}`;
  };

  /* O que os colegas apuraram antes de dar baixa neste mesmo alerta. Ele
     continua pendente para quem ainda não viu, mas não precisa ser investigado
     do zero de novo. */
  function comentariosDe(a) {
    const lista = Array.isArray(a.comentarios) ? a.comentarios : [];
    if (!lista.length) return "";
    return `<div class="home-alert-notes">
      ${lista.map((c) => `<p><b>${esc(c.autor || "Alguém")}</b> <span>${esc(desde(c.read_at))}</span>${esc(c.comentario)}</p>`).join("")}
    </div>`;
  }

  /* Marcar como visto é o momento em que a pessoa sabe algo que os outros não
     sabem. A caixa é opcional de propósito: quem só quer limpar a fila fecha
     com um clique, e quem apurou alguma coisa deixa registrado sem trocar de
     tela. */
  function pedirComentario({ ids, alerta, botao }) {
    const varios = !ids.length;
    modal({
      labelledBy: "comentarioVistoTitulo",
      html: `
        <div class="modal-head">
          <div>
            <span class="kicker">${icon("check")} Marcar como visto</span>
            <h2 id="comentarioVistoTitulo" style="margin-top:8px">${
              varios ? "Toda a fila de alertas" : esc(alerta?.titulo || "Alerta")}</h2>
            <p class="muted" style="margin-top:6px;font-size:var(--fs-13)">${
              varios
                ? "O comentário vale para todos os alertas marcados agora."
                : "Registre o que foi apurado. Os colegas que ainda não viram este alerta leem o seu comentário no cartão dele."}</p>
          </div>
          <button class="btn btn-ghost btn-icon" data-close type="button" aria-label="Fechar">${icon("close")}</button>
        </div>
        <div class="modal-body stack">
          <div class="field">
            <label for="comentarioVisto">Comentário de fechamento <span class="dim">(opcional)</span></label>
            <textarea class="textarea" id="comentarioVisto" rows="4" maxlength="${COMENTARIO_MAX}"
              placeholder="Ex.: enlace restabelecido às 14h20, rompimento na rota Santos — chamado 1234 aberto na operadora."></textarea>
            <span class="dim" style="font-size:var(--fs-11)" id="comentarioResto"></span>
          </div>
        </div>
        <div class="modal-foot"><span></span><span class="row">
          <button class="btn" data-close type="button">Cancelar</button>
          <button class="btn btn-primary" data-marcar type="button">Marcar como visto</button>
        </span></div>`,
      onMount: (host, close) => {
        const campo = $("#comentarioVisto", host);
        const resto = $("#comentarioResto", host);
        const confirmar = () => {
          const comentario = campo.value.trim();
          close();
          marcarVistos(ids, botao, comentario);
        };

        const contar = () => {
          const usados = campo.value.length;
          resto.textContent = usados ? `${COMENTARIO_MAX - usados} caracteres restantes` : "";
        };
        campo.oninput = contar;
        contar();

        // Ctrl+Enter fecha o alerta sem tirar a mão do teclado — quem está no
        // plantão marca vários seguidos.
        campo.onkeydown = (e) => {
          if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); confirmar(); }
        };
        $("[data-marcar]", host).onclick = confirmar;
        campo.focus();
      },
    });
  }

  function renderAlertas(al) {
    const host = $("#blocoAlertas");
    const botao = $("#btnVerTudo");
    const lista = al?.lista || [];

    $("#kickerAlertas").innerHTML = al?.total
      ? `<i class="dot ${al.por_grau?.critico ? "dot-danger" : "dot-warn"}"></i> ${inteiro(al.total)} não vistos de ${inteiro(al.abertos)} abertos`
      : `<i class="dot dot-ok"></i> Fila em dia`;

    botao.hidden = !lista.length;

    if (!lista.length) {
      host.innerHTML = `<div class="empty" style="padding:var(--s-8) 0">
        <span class="empty-icon">${icon("check")}</span>
        <b>Nenhum alerta pendente para você</b>
        <p>${al?.abertos
          ? `Os ${inteiro(al.abertos)} alertas abertos já foram vistos por você. Eles continuam no painel de tráfego enquanto durarem.`
          : "A rede não tem enlaces fora do ar, saturação ou leitura inconsistente neste ciclo."}</p>
        <a class="btn btn-sm" href="/trafego.html?guia=alertas" style="margin-top:var(--s-3)">Abrir o painel de tráfego</a>
      </div>`;
      return;
    }

    const contagem = al.por_grau || {};
    host.innerHTML = `
      <div class="home-alert-badges">
        ${["critico", "atencao", "info"].filter((g) => contagem[g]).map((g) => `
          <span class="badge ${GRAU[g].badge}"><i class="dot ${GRAU[g].dot}"></i>${inteiro(contagem[g])} ${esc(contagem[g] === 1 ? GRAU[g].um : GRAU[g].varios)}</span>`).join("")}
      </div>

      <div class="home-alerts">
        ${lista.map((a) => `
          <article class="home-alert is-${esc(a.grau)}">
            <div>
              <b>${esc(a.titulo)}</b>
              ${a.texto ? `<p>${esc(a.texto)}</p>` : ""}
              <time datetime="${esc(a.first_seen_at || "")}">Detectado ${esc(desde(a.first_seen_at))}</time>
              ${comentariosDe(a)}
            </div>
            <div class="row">
              <a class="btn btn-sm" href="${esc(destinoDe(a))}">Ver</a>
              <button class="btn btn-sm btn-ghost" type="button" data-visto="${esc(String(a.id))}">Marcar visto</button>
            </div>
          </article>`).join("")}
      </div>

      ${al.total > lista.length ? `<p class="dim" style="font-size:var(--fs-11)">
        Mostrando os ${inteiro(lista.length)} mais graves de ${inteiro(al.total)} não vistos.</p>` : ""}`;

    const porId = new Map(lista.map((a) => [String(a.id), a]));
    $$("[data-visto]", host).forEach((b) => (b.onclick = () => pedirComentario({
      ids: [Number(b.dataset.visto)], alerta: porId.get(b.dataset.visto), botao: b,
    })));
  }

  async function marcarVistos(ids, botao, comentario = "") {
    if (botao) botao.classList.add("is-loading");
    try {
      const resposta = await NOC.api("/api/home/alerts/read", {
        method: "POST",
        body: JSON.stringify({ ...(ids?.length ? { ids } : {}), ...(comentario ? { comentario } : {}) }),
      });
      state.dados.alertas = { permitido: true, ...resposta };
      renderAlertas(state.dados.alertas);
      toast(ids?.length ? "Alerta marcado como visto" : "Fila zerada", {
        text: comentario
          ? "O comentário fica no cartão para quem ainda não viu."
          : "A fila dos outros usuários não muda.",
        type: "ok", timeout: 2400,
      });
    } catch (err) {
      toast("Não foi possível marcar", { text: err.message, type: "danger" });
    } finally {
      if (botao) botao.classList.remove("is-loading");
    }
  }

  /* ---------------- ciclo de vida ---------------- */
  function renderAll() {
    renderClientes(state.dados.clientes);
    renderTrafego(state.dados.trafego);
    renderAlertas(state.dados.alertas);
    $("#lastUpdate").textContent = TEMPO.horaCompleta(new Date());
  }

  async function carregar({ silencioso = false } = {}) {
    if (state.carregando) return;
    state.carregando = true;
    try {
      state.dados = await NOC.api("/api/home/overview");
      renderAll();
    } catch (err) {
      // Uma falha na atualização automática não pode apagar a última leitura boa.
      if (silencioso && state.dados) return;
      NOC.errorState($("#blocoAlertas"), err, () => carregar());
      NOC.skeleton($("#blocoClientes"), 3);
      NOC.skeleton($("#blocoTrafego"), 3);
    } finally {
      state.carregando = false;
    }
  }

  function saudacao(nome) {
    const h = TEMPO.partes(new Date()).hora;
    const parte = h < 12 ? "Bom dia" : h < 18 ? "Boa tarde" : "Boa noite";
    const primeiro = String(nome || "").trim().split(/\s+/)[0];
    return primeiro ? `${parte}, ${primeiro}` : parte;
  }

  async function boot() {
    UI.mountShell({ active: "home" });
    $("#btnRefresh").innerHTML = icon("refresh") + " Atualizar";
    NOC.skeleton($("#blocoClientes"), 3);
    NOC.skeleton($("#blocoTrafego"), 3);
    NOC.skeleton($("#blocoAlertas"), 4);

    await carregar();

    // O guardião de acesso pode ter trocado a página inteira enquanto os dados
    // vinham. Sem esta parada, o resto do boot escreveria em nós que já saíram
    // do documento e a tela morreria com um erro sem relação com a causa.
    const titulo = $("#saudacao");
    if (!titulo) return;
    if (state.dados?.usuario?.nome) titulo.textContent = saudacao(state.dados.usuario.nome);

    $("#btnRefresh").onclick = async () => {
      const b = $("#btnRefresh");
      b.classList.add("is-loading");
      try { await carregar(); } finally { b.classList.remove("is-loading"); }
    };
    $("#btnVerTudo").onclick = () => pedirComentario({ ids: [], botao: $("#btnVerTudo") });

    // Painel de abertura fica aberto o dia inteiro: ele se atualiza sozinho.
    state.timer = setInterval(() => carregar({ silencioso: true }), RECARGA_MS);
    addEventListener("pagehide", () => clearInterval(state.timer));
  }

  boot();
})();
