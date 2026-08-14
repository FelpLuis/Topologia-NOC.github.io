/* ============================================================
   UPDOWN NOC — POPs e anel óptico (aplicação real)
   Ficha de cada POP com rotas, ocupação e vínculo de equipamentos.
   ============================================================ */
(() => {
  "use strict";
  const { $, $$, esc, icon, toast, modal } = UI;

  const norm = (s) => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

  function ringLinks() {
    const pops = NOC.pops();
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

  /* ---------------- lista de POPs ---------------- */
  function render() {
    const canEdit = NOC.can("topology.edit");
    const foco = new URLSearchParams(location.search).get("pop");
    const pops = NOC.pops();

    $("#popList").innerHTML = pops.length ? pops.map((pop) => {
      const list = NOC.devicesOfPop(pop.id);
      const s = NOC.statsOf(list);
      return `<article class="card" id="pop-${esc(pop.id)}" ${foco === pop.id ? 'style="border-color:var(--cyan-400)"' : ""}>
        <div class="card-head">
          <div class="row" style="gap:var(--s-4);align-items:flex-start">
            <span class="pop-marker purple" style="height:46px"></span>
            <div>
              <span class="kicker">Ponto de presença</span>
              <h2 style="margin:4px 0 2px">${esc(pop.nome)}</h2>
              <p class="dim mono" style="font-size:var(--fs-11)">${esc(pop.id)}</p>
            </div>
          </div>
          <span class="badge">${list.length} equipamento(s)</span>
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
                    <div class="row" style="gap:6px">
                      <a class="btn btn-sm" href="/?device=${encodeURIComponent(e.id)}">Abrir</a>
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
      <p>Cadastre POPs em Topologia → Gerenciar rede → POPs.</p>
      <a class="btn btn-sm btn-primary" href="/" style="margin-top:var(--s-3)">Ir para a topologia</a></div></div>`;

    $$("[data-unlink]").forEach((b) => (b.onclick = () => vincular(b.dataset.unlink, null)));
    $$("[data-add]").forEach((b) => (b.onclick = () => openLink(b.dataset.add)));

    renderRing();
    renderStats();

    if (foco) $("#pop-" + foco)?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  /* ---------------- vínculo ---------------- */
  async function vincular(deviceId, popId) {
    const e = NOC.data().equipamentos.find((x) => x.id === deviceId);
    if (!e) return;
    try {
      const antes = await NOC.setPop(deviceId, popId);
      render();
      toast(popId ? `${e.nome} vinculado` : `${e.nome} desvinculado`, {
        text: popId ? "Passa a contar na ocupação deste POP no Dashboard." : "Sai da ocupação do POP e vira pendência no Dashboard.",
        type: popId ? "ok" : "warn",
        action: {
          label: "Desfazer",
          run: async () => {
            try { await NOC.setPop(deviceId, antes); render(); toast("Vínculo revertido", { type: "info" }); }
            catch (err) { toast("Não foi possível reverter", { text: err.message, type: "danger" }); }
          },
        },
      });
    } catch (err) {
      render();
      toast("Não foi possível salvar", { text: err.message, type: "danger", timeout: 7000 });
    }
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

  /* ---------------- anel ---------------- */
  function renderRing() {
    const pops = NOC.pops();
    if (!pops.length) { $("#ringMap").innerHTML = '<p class="dim" style="font-size:var(--fs-12)">Sem POPs cadastrados.</p>'; return; }
    const R = 92, cx = 130, cy = 120;
    const ponto = (i) => {
      const ang = (i / pops.length) * Math.PI * 2 - Math.PI / 2;
      return { x: cx + R * Math.cos(ang), y: cy + R * Math.sin(ang) };
    };
    const idx = Object.fromEntries(pops.map((p, i) => [p.id, i]));
    const links = ringLinks();

    $("#ringMap").innerHTML = `
      <svg viewBox="0 0 260 240" style="width:100%;height:auto" role="img" aria-label="Diagrama do anel óptico entre os POPs">
        ${links.map((l) => {
          const a = ponto(idx[l.a]), b = ponto(idx[l.b]);
          const sub = l.tipos.has("Subterrânea");
          return `<line x1="${a.x}" y1="${a.y}" x2="${b.x}" y2="${b.y}"
            stroke="${sub ? "var(--purple-400)" : "var(--cyan-400)"}" stroke-width="1.6"
            stroke-dasharray="${sub ? "6 5" : "0"}" opacity=".7"></line>`;
        }).join("")}
        ${pops.map((p, i) => {
          const q = ponto(i);
          const s = NOC.statsOf(NOC.devicesOfPop(p.id));
          return `<g>
            <circle cx="${q.x}" cy="${q.y}" r="13" fill="var(--surface-1)" stroke="var(--cyan-400)" stroke-width="1.6"/>
            <text x="${q.x}" y="${q.y + 3.5}" text-anchor="middle" style="font:700 9px var(--font-mono);fill:var(--text-1)">${s.ocup}%</text>
            <text x="${q.x}" y="${q.y + (q.y < cy ? -20 : 30)}" text-anchor="middle" style="font:700 9px var(--font-sans);fill:var(--text-3)">${esc(p.nome.replace(/^POP\s*/i, ""))}</text>
          </g>`;
        }).join("")}
      </svg>
      <div class="stack" style="gap:6px;margin-top:var(--s-3);font-size:var(--fs-11)">
        <span class="row" style="gap:var(--s-2)"><i style="width:16px;height:2px;background:var(--cyan-400);display:block"></i> Rota aérea</span>
        <span class="row" style="gap:var(--s-2)"><i style="width:16px;height:2px;background:var(--purple-400);display:block"></i> Rota subterrânea</span>
      </div>`;
  }

  function renderStats() {
    const vinculados = NOC.data().equipamentos.filter((e) => NOC.effectivePop(e));
    const s = NOC.statsOf(vinculados);
    $("#ringStats").innerHTML = `
      <div><label>POPs</label><strong>${NOC.pops().length}</strong></div>
      <div><label>Rotas</label><strong>${ringLinks().length}</strong></div>
      <div><label>Portas</label><strong>${s.portas}</strong></div>
      <div><label>Sem POP</label><strong>${NOC.unlinked().length}</strong></div>`;
  }

  async function boot() {
    UI.mountShell({ active: "pops" });
    NOC.skeleton($("#popList"), 5);
    try {
      await NOC.load();
    } catch (err) {
      NOC.errorState($("#popList"), err, () => location.reload());
      return;
    }
    render();
  }

  boot();
})();
