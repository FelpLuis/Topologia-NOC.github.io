/* ============================================================
   UPDOWN NOC — Dashboard operacional
   Agrupa por POP usando o vínculo equipamento → POP (campo popId).
   Equipamento sem vínculo não some: vira pendência visível.
   ============================================================ */
(() => {
  "use strict";
  const { $, $$, esc, icon, toast } = UI;
  const D = window.MOCK;
  const state = { sort: "nome" };

  const used = (e) => e.portas.filter((p) => p.status === "conectada").length;
  const occClass = (v) => (v > 85 ? "is-danger" : v > 60 ? "is-warn" : "");
  const statusInfo = (e) => {
    const s = e.monitoramento.status;
    return s === "online" ? { dot: "dot-ok", label: "Online", badge: "badge-ok" }
      : s === "degradado" ? { dot: "dot-warn", label: "Degradado", badge: "badge-warn" }
      : { dot: "dot-danger", label: "Offline", badge: "badge-danger" };
  };
  const devicesOf = (popId) => D.equipamentos.filter((e) => (e.popId || null) === popId);
  const semPop = () => D.equipamentos.filter((e) => !e.popId);

  function stats(list) {
    const portas = list.reduce((a, e) => a + e.portas.length, 0);
    const emUso = list.reduce((a, e) => a + used(e), 0);
    return { portas, emUso, livres: portas - emUso, ocup: UI.pct(emUso, portas) };
  }

  /* ---------- indicadores ---------- */
  function renderKpis() {
    const vinculados = D.equipamentos.filter((e) => e.popId);
    const s = stats(D.equipamentos);
    const online = D.equipamentos.filter((e) => e.monitoramento.status === "online").length;
    const pendentes = semPop().length;

    const cards = [
      { label: "POPs ativos", value: D.pops.length, foot: `${vinculados.length} equipamentos vinculados`, accent: true },
      { label: "Equipamentos", value: D.equipamentos.length, foot: `${online} online • ${D.equipamentos.length - online} em alerta` },
      { label: "Portas mapeadas", value: s.portas, foot: `${s.emUso} em uso • ${s.livres} livres` },
      { label: "Ocupação geral", value: s.ocup + "%", foot: s.ocup > 60 ? "Planejar expansão" : "Dentro da folga prevista" },
      { label: "Enlaces", value: D.conexoes.length, foot: "Documentados na topologia" },
      { label: "Sem POP", value: pendentes, foot: pendentes ? "Vincule na gerência de rede" : "Nenhuma pendência" },
    ];

    $("#kpis").innerHTML = cards.map((c) => `
      <article class="kpi ${c.accent ? "is-accent" : ""}">
        <label>${esc(c.label)}</label>
        <strong>${esc(String(c.value))}</strong>
        <span class="kpi-foot">${esc(c.foot)}</span>
      </article>`).join("");
  }

  /* ---------- tráfego ---------- */
  function renderSpark() {
    const serie = D.trafego;
    const w = 720, h = 130, max = Math.max(...serie) * 1.12;
    const pt = (v, i) => [(i / (serie.length - 1)) * w, h - (v / max) * h];
    const linha = serie.map((v, i) => pt(v, i).map((n) => n.toFixed(1)).join(",")).join(" L ");
    const area = `M 0,${h} L ${linha} L ${w},${h} Z`;

    $("#spark").innerHTML = `
      <svg class="spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" role="img"
           aria-label="Tráfego agregado das últimas 24 horas, variando entre ${Math.min(...serie)} e ${Math.max(...serie)} gigabits por segundo">
        <defs>
          <linearGradient id="sparkFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stop-color="var(--cyan-400)" stop-opacity=".35"/>
            <stop offset="100%" stop-color="var(--cyan-400)" stop-opacity="0"/>
          </linearGradient>
        </defs>
        <path class="spark-area" d="${area}"/>
        <path class="spark-line" d="M ${linha}"/>
      </svg>
      <div class="row-between dim" style="font-size:var(--fs-11);margin-top:var(--s-2)">
        <span>24 h atrás</span><span>pico ${Math.max(...serie)} Gb/s</span><span>agora</span>
      </div>`;
    $("#trafficNow").textContent = serie[serie.length - 1] + " Gb/s";
  }

  /* ---------- alertas ---------- */
  function renderAlerts() {
    const ordem = { critico: 0, atencao: 1, info: 2 };
    const list = [...D.alertas].sort((a, b) => ordem[a.nivel] - ordem[b.nivel]);
    $("#alertCount").textContent = list.length;
    $("#alerts").innerHTML = list.length ? list.map((a) => `
      <article class="alert-item is-${esc(a.nivel)}">
        <span class="alert-mark"></span>
        <div class="grow">
          <div class="row-between"><b>${esc(a.titulo)}</b><time>${esc(a.tempo)}</time></div>
          <p>${esc(a.detalhe)}</p>
          <a class="btn btn-ghost btn-sm" style="margin-top:8px" href="topologia.html?device=${encodeURIComponent(a.equipamento)}">Abrir equipamento</a>
        </div>
      </article>`).join("") : `<div class="empty"><span class="empty-icon">${icon("check")}</span><b>Nenhum alerta aberto</b><p>Toda a infraestrutura está dentro dos limites.</p></div>`;
  }

  /* ---------- POPs ---------- */
  function renderPops() {
    const pops = [...D.pops].map((p) => ({ pop: p, list: devicesOf(p.id) }));
    if (state.sort === "ocupacao") pops.sort((a, b) => stats(b.list).ocup - stats(a.list).ocup);

    $("#popGrid").innerHTML = pops.map(({ pop, list }) => {
      const s = stats(list);
      const alarme = list.filter((e) => e.monitoramento.status !== "online").length;
      return `<article class="card pop-card">
        <header class="pop-card-head">
          <span class="pop-marker ${pop.id === "ascenty" ? "" : "purple"}"></span>
          <div class="grow">
            <span class="kicker">${pop.id === "ascenty" ? "Núcleo" : "POP"}</span>
            <h3 style="margin:4px 0 2px">${esc(pop.nome)}</h3>
            <small class="dim">${esc(pop.local)}</small>
          </div>
          <span class="badge ${alarme ? "badge-warn" : "badge-ok"}">
            <i class="dot ${alarme ? "dot-warn" : "dot-ok"}"></i>${alarme ? alarme + " alerta(s)" : "estável"}</span>
        </header>

        <div class="pop-stats">
          <div><span>Equip.</span><strong>${list.length}</strong></div>
          <div><span>Portas</span><strong>${s.portas}</strong></div>
          <div><span>Em uso</span><strong>${s.emUso}</strong></div>
          <div><span>Livres</span><strong>${s.livres}</strong></div>
        </div>

        <div>
          <div class="row-between" style="font-size:var(--fs-11);margin-bottom:6px">
            <span class="muted">Ocupação de portas</span><span class="mono">${s.ocup}%</span>
          </div>
          <span class="meter ${occClass(s.ocup)}"><span style="width:${s.ocup}%"></span></span>
        </div>

        <div class="stack" style="gap:var(--s-2)">
          ${list.length ? list.map((e) => {
            const st = statusInfo(e);
            const o = UI.pct(used(e), e.portas.length);
            return `<div class="device-row">
              <div class="row-top">
                <div class="grow" style="min-width:0">
                  <b class="truncate">${esc(e.nome)}</b>
                  <br><small class="truncate">${esc(e.modelo || "")}</small>
                </div>
                <span class="badge ${st.badge}"><i class="dot ${st.dot}"></i>${st.label}</span>
              </div>
              <div class="row" style="gap:var(--s-3)">
                <span class="meter meter-sm ${occClass(o)} grow"><span style="width:${o}%"></span></span>
                <small class="mono dim">${used(e)}/${e.portas.length}</small>
              </div>
            </div>`;
          }).join("") : `<div class="empty" style="padding:var(--s-5) 0">
              <b>Nenhum equipamento vinculado</b>
              <p>Vincule equipamentos a este POP em Topologia → Gerenciar rede.</p>
              <a class="btn btn-sm" href="topologia.html?site=${encodeURIComponent(pop.id)}" style="margin-top:8px">Abrir gerência</a>
            </div>`}
        </div>

        <a class="btn btn-sm btn-block" href="pops.html?pop=${encodeURIComponent(pop.id)}">Ver ficha do POP</a>
      </article>`;
    }).join("");
  }

  /* ---------- pendências de vínculo ---------- */
  function renderPendentes() {
    const list = semPop();
    const host = $("#pendentes");
    host.hidden = !list.length;
    if (!list.length) return;
    host.innerHTML = `
      <div class="card">
        <div class="card-head">
          <div>
            <h2>Equipamentos sem POP vinculado</h2>
            <p>Não entram na ocupação de nenhum POP até serem vinculados na gerência de rede.</p>
          </div>
          <span class="badge badge-warn"><i class="dot dot-warn"></i>${list.length} pendente(s)</span>
        </div>
        <div class="card-body">
          <div class="table-wrap"><table class="table">
            <thead><tr><th>Equipamento</th><th>Categoria</th><th class="num">Portas</th><th class="num">Em uso</th><th></th></tr></thead>
            <tbody>${list.map((e) => `<tr>
              <td><b>${esc(e.nome)}</b><br><small class="dim">${esc(e.modelo || "")}</small></td>
              <td>${esc(e.categoria || "—")}</td>
              <td class="num">${e.portas.length}</td>
              <td class="num">${used(e)}</td>
              <td><a class="btn btn-sm btn-primary" href="topologia.html?device=${encodeURIComponent(e.id)}">Vincular a um POP</a></td>
            </tr>`).join("")}</tbody>
          </table></div>
        </div>
      </div>`;
  }

  /* ---------- ciclo de atualização ---------- */
  function renderAll() {
    renderKpis();
    renderSpark();
    renderAlerts();
    renderPops();
    renderPendentes();
    $("#lastUpdate").textContent = new Date().toLocaleTimeString("pt-BR");
  }

  UI.mountShell({ active: "dashboard" });
  $("#btnRefresh").innerHTML = icon("refresh") + " Atualizar";
  $("#btnTv").innerHTML = icon("tv") + " Modo TV";
  renderAll();
  UI.clock("#tvClock", "#tvDate");

  $("#btnRefresh").onclick = () => {
    renderAll();
    toast("Dados atualizados", { text: "No sistema real a coleta vem do Worker e do Grafana.", type: "ok", timeout: 2400 });
  };

  $$("[data-sort]").forEach((b) => (b.onclick = () => {
    state.sort = b.dataset.sort;
    $$("[data-sort]").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
    renderPops();
  }));

  // Modo TV: sem barra, sem menu, tipografia ampliada — feito para telão.
  function setTv(on) {
    document.body.classList.toggle("tv-mode", on);
    $("#btnTv").innerHTML = icon("tv") + (on ? " Sair do modo TV" : " Modo TV");
    if (on && document.documentElement.requestFullscreen) {
      document.documentElement.requestFullscreen().catch(() => {});
    } else if (!on && document.fullscreenElement) {
      document.exitFullscreen().catch(() => {});
    }
  }
  $("#btnTv").onclick = () => setTv(!document.body.classList.contains("tv-mode"));
  if (new URLSearchParams(location.search).has("tv")) setTv(true);
  addEventListener("keydown", (e) => { if (e.key === "Escape" && document.body.classList.contains("tv-mode")) setTv(false); });

  // Atualização automática, como um painel de NOC de verdade.
  setInterval(renderAll, 30000);
})();
