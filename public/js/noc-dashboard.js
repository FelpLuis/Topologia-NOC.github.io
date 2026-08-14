/* ============================================================
   UPDOWN NOC — Dashboard operacional (aplicação real)
   Agrupa por POP pelo vínculo do cadastro (popId). Equipamento
   sem vínculo não some do painel: vira pendência visível.
   ============================================================ */
(() => {
  "use strict";
  const { $, $$, esc, icon, toast } = UI;
  const state = { sort: "nome", grafana: null };

  const devicesOfPop = (id) => NOC.devicesOfPop(id);

  /* ---------------- indicadores ---------------- */
  function renderKpis() {
    const t = NOC.data();
    const s = NOC.statsOf(t.equipamentos);
    const vinculados = t.equipamentos.filter((e) => NOC.effectivePop(e)).length;
    const pendentes = NOC.unlinked().length;
    const sugeridos = t.equipamentos.filter((e) => NOC.isSuggested(e)).length;

    const cards = [
      { label: "POPs cadastrados", value: NOC.pops().length, foot: `${vinculados} equipamentos vinculados`, accent: true },
      { label: "Equipamentos", value: t.equipamentos.length, foot: sugeridos ? `${sugeridos} com vínculo apenas sugerido` : "Todos com vínculo confirmado" },
      { label: "Portas mapeadas", value: s.portas, foot: `${s.emUso} em uso • ${s.livres} livres` },
      { label: "Ocupação geral", value: s.ocup + "%", foot: s.ocup > 60 ? "Planejar expansão" : "Dentro da folga prevista" },
      { label: "Enlaces", value: t.conexoes.length, foot: "Documentados na topologia" },
      { label: "Sem POP", value: pendentes, foot: pendentes ? "Vincule na gerência de rede" : "Nenhuma pendência" },
    ];

    $("#kpis").innerHTML = cards.map((c) => `
      <article class="kpi ${c.accent ? "is-accent" : ""}">
        <label>${esc(c.label)}</label>
        <strong>${esc(String(c.value))}</strong>
        <span class="kpi-foot">${esc(c.foot)}</span>
      </article>`).join("");
  }

  /* ---------------- ocupação por POP ---------------- */
  function renderChart() {
    const linhas = NOC.pops().map((p) => ({ nome: p.nome, ...NOC.statsOf(devicesOfPop(p.id)) }));
    const semPop = NOC.unlinked();
    if (semPop.length) linhas.push({ nome: "SEM POP", ...NOC.statsOf(semPop) });

    $("#chart").innerHTML = linhas.length ? `<div class="stack" style="gap:var(--s-4)">
      ${linhas.map((l) => `
        <div>
          <div class="row-between" style="font-size:var(--fs-12);margin-bottom:6px">
            <b>${esc(l.nome)}</b>
            <span class="mono dim">${l.emUso}/${l.portas} portas • ${l.ocup}%</span>
          </div>
          <span class="meter ${NOC.occClass(l.ocup)}"><span style="width:${l.ocup}%"></span></span>
        </div>`).join("")}
    </div>` : `<div class="empty"><b>Nenhum POP cadastrado</b><p>Cadastre POPs em Topologia → Gerenciar rede.</p></div>`;
  }

  /* ---------------- origem dos dados ---------------- */
  function renderIntegration() {
    const g = state.grafana;
    const ok = g && g.ok;
    $("#integration").innerHTML = `
      <div class="row-between">
        <div><b style="font-size:var(--fs-13)">Topologia (D1)</b>
          <p class="dim" style="font-size:var(--fs-11)">Versão ${esc(String(NOC.data().version ?? "—"))} • ${esc(NOC.data().updated_at || "—")}</p></div>
        <span class="badge badge-ok"><i class="dot dot-ok"></i>ativa</span>
      </div>
      <hr>
      <div class="row-between">
        <div><b style="font-size:var(--fs-13)">Grafana</b>
          <p class="dim" style="font-size:var(--fs-11)">${ok ? "Conectado — status e tráfego por interface" : "Não configurado — status e tráfego ficam em branco"}</p></div>
        <span class="badge ${ok ? "badge-ok" : "badge-warn"}"><i class="dot ${ok ? "dot-ok" : "dot-warn"}"></i>${ok ? "conectado" : "pendente"}</span>
      </div>
      <p class="dim" style="font-size:var(--fs-11)">
        ${icon("info")} Enquanto a consulta do Grafana não estiver definida, o painel mostra somente o que está documentado
        na topologia — sem inventar status nem consumo.
      </p>`;
  }

  /* ---------------- POPs ---------------- */
  function renderPops() {
    const pops = NOC.pops().map((p) => ({ pop: p, list: devicesOfPop(p.id) }));
    if (state.sort === "ocupacao") pops.sort((a, b) => NOC.statsOf(b.list).ocup - NOC.statsOf(a.list).ocup);

    $("#popGrid").innerHTML = pops.length ? pops.map(({ pop, list }) => {
      const s = NOC.statsOf(list);
      const sugeridos = list.filter((e) => NOC.isSuggested(e)).length;
      return `<article class="card pop-card">
        <header class="pop-card-head">
          <span class="pop-marker purple"></span>
          <div class="grow">
            <span class="kicker">POP</span>
            <h3 style="margin:4px 0 2px">${esc(pop.nome)}</h3>
            <small class="dim">${(pop.rotas || []).length} rota(s) no anel</small>
          </div>
          ${sugeridos ? `<span class="badge badge-warn">${sugeridos} sugerido(s)</span>` : ""}
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
          <span class="meter ${NOC.occClass(s.ocup)}"><span style="width:${s.ocup}%"></span></span>
        </div>

        <div class="stack" style="gap:var(--s-2)">
          ${list.length ? list.map((e) => {
            const o = NOC.occupancy(e);
            return `<a class="device-row" href="/?device=${encodeURIComponent(e.id)}" style="text-decoration:none;color:inherit">
              <div class="row-top">
                <div class="grow" style="min-width:0">
                  <b class="truncate">${esc(e.nome)}</b><br>
                  <small class="truncate">${esc(e.modelo || "")}</small>
                </div>
                ${NOC.isSuggested(e) ? '<span class="badge badge-warn">sugerido</span>' : ""}
              </div>
              <div class="row" style="gap:var(--s-3)">
                <span class="meter meter-sm ${NOC.occClass(o)} grow"><span style="width:${o}%"></span></span>
                <small class="mono dim">${NOC.usedPorts(e)}/${e.portas.length}</small>
              </div>
            </a>`;
          }).join("") : `<div class="empty" style="padding:var(--s-5) 0">
              <b>Nenhum equipamento vinculado</b>
              <p>Vincule equipamentos a este POP em Topologia → Gerenciar rede.</p>
              <a class="btn btn-sm" href="/?pop=${encodeURIComponent(pop.id)}" style="margin-top:8px">Abrir POP na topologia</a>
            </div>`}
        </div>

        <a class="btn btn-sm btn-block" href="/pops.html?pop=${encodeURIComponent(pop.id)}">Ver ficha do POP</a>
      </article>`;
    }).join("") : `<div class="card"><div class="empty">
        <span class="empty-icon">${icon("pops")}</span><b>Nenhum POP cadastrado</b>
        <p>Cadastre os POPs para organizar os equipamentos por localidade.</p>
        <a class="btn btn-sm btn-primary" href="/" style="margin-top:var(--s-3)">Ir para a topologia</a></div></div>`;
  }

  /* ---------------- pendências ---------------- */
  function renderPendentes() {
    const list = NOC.unlinked();
    const host = $("#pendentes");
    host.hidden = !list.length;
    if (!list.length) return;
    host.innerHTML = `
      <div class="card">
        <div class="card-head">
          <div><h2>Equipamentos sem POP vinculado</h2>
            <p>Não entram na ocupação de nenhum POP até serem vinculados na gerência de rede.</p></div>
          <span class="badge badge-warn"><i class="dot dot-warn"></i>${list.length} pendente(s)</span>
        </div>
        <div class="card-body">
          <div class="table-wrap"><table class="table">
            <thead><tr><th>Equipamento</th><th>Categoria</th><th class="num">Portas</th><th class="num">Em uso</th><th></th></tr></thead>
            <tbody>${list.map((e) => `<tr>
              <td><b>${esc(e.nome)}</b><br><small class="dim">${esc(e.modelo || "")}</small></td>
              <td>${esc(e.categoria || "—")}</td>
              <td class="num">${e.portas.length}</td>
              <td class="num">${NOC.usedPorts(e)}</td>
              <td><a class="btn btn-sm btn-primary" href="/?device=${encodeURIComponent(e.id)}">Vincular a um POP</a></td>
            </tr>`).join("")}</tbody>
          </table></div>
        </div>
      </div>`;
  }

  function renderAll() {
    renderKpis();
    renderChart();
    renderIntegration();
    renderPops();
    renderPendentes();
    $("#lastUpdate").textContent = new Date().toLocaleTimeString("pt-BR");
  }

  /* ---------------- início ---------------- */
  async function boot() {
    UI.mountShell({ active: "dashboard" });
    $("#btnRefresh").innerHTML = icon("refresh") + " Atualizar";
    $("#btnTv").innerHTML = icon("tv") + " Modo TV";
    UI.clock("#tvClock", "#tvDate");
    NOC.skeleton($("#popGrid"), 6);

    try {
      await NOC.load();
      state.grafana = await NOC.grafanaHealth();
    } catch (err) {
      NOC.errorState($("#popGrid"), err, () => location.reload());
      return;
    }
    renderAll();

    $("#btnRefresh").onclick = async () => {
      const b = $("#btnRefresh");
      b.classList.add("is-loading");
      try {
        await NOC.load();
        state.grafana = await NOC.grafanaHealth();
        renderAll();
        toast("Dados atualizados", { type: "ok", timeout: 2200 });
      } catch (err) {
        toast("Falha ao atualizar", { text: err.message, type: "danger" });
      } finally {
        b.classList.remove("is-loading");
      }
    };

    $$("[data-sort]").forEach((b) => (b.onclick = () => {
      state.sort = b.dataset.sort;
      $$("[data-sort]").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
      renderPops();
    }));

    // Modo TV: sem cromo de navegação, tipografia ampliada — feito para telão.
    function setTv(on) {
      document.body.classList.toggle("tv-mode", on);
      $("#btnTv").innerHTML = icon("tv") + (on ? " Sair do modo TV" : " Modo TV");
      if (on && document.documentElement.requestFullscreen) document.documentElement.requestFullscreen().catch(() => {});
      else if (!on && document.fullscreenElement) document.exitFullscreen().catch(() => {});
    }
    $("#btnTv").onclick = () => setTv(!document.body.classList.contains("tv-mode"));
    if (new URLSearchParams(location.search).has("tv")) setTv(true);
    addEventListener("keydown", (e) => { if (e.key === "Escape" && document.body.classList.contains("tv-mode")) setTv(false); });

    // Atualização automática, como um painel de NOC de verdade.
    setInterval(async () => {
      try {
        await NOC.load();
        state.grafana = await NOC.grafanaHealth();
        renderAll();
      } catch (e) { /* mantém a última leitura boa na tela */ }
    }, 60000);
  }

  boot();
})();
