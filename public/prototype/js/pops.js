/* ============================================================
   UPDOWN NOC — POPs e anel óptico
   Ficha de cada POP, rotas do anel e equipamentos vinculados,
   com vínculo/desvínculo direto da ficha.
   ============================================================ */
(() => {
  "use strict";
  const { $, $$, esc, icon, toast, modal } = UI;
  const D = window.MOCK;

  const role = UI.session().role;
  const perms = new Set(D.rolePermissions[role] || []);
  const canEdit = perms.has(D.permissions.find((p) => p.code === "topology.edit")?.id);

  const used = (e) => e.portas.filter((p) => p.status === "conectada").length;
  const occClass = (v) => (v > 85 ? "is-danger" : v > 60 ? "is-warn" : "");
  const devicesOf = (popId) => D.equipamentos.filter((e) => (e.popId || null) === popId);
  const detalhe = (popId) => D.popsDetalhe.find((p) => p.id === popId || p.id === "pop-" + popId);

  function stats(list) {
    const portas = list.reduce((a, e) => a + e.portas.length, 0);
    const emUso = list.reduce((a, e) => a + used(e), 0);
    return { portas, emUso, livres: portas - emUso, ocup: UI.pct(emUso, portas) };
  }

  function rotasDe(pop) {
    const d = detalhe(pop.id);
    return (d && d.rotas) || pop.rotas || [];
  }

  /* ---------- lista de POPs ---------- */
  function render() {
    const foco = new URLSearchParams(location.search).get("pop");

    $("#popList").innerHTML = D.pops.map((pop) => {
      const list = devicesOf(pop.id);
      const s = stats(list);
      const rotas = rotasDe(pop);
      const alarme = list.filter((e) => e.monitoramento.status !== "online").length;

      return `<article class="card" id="pop-${esc(pop.id)}" ${foco === pop.id ? 'style="border-color:var(--cyan-400)"' : ""}>
        <div class="card-head">
          <div class="row" style="gap:var(--s-4);align-items:flex-start">
            <span class="pop-marker ${pop.id === "ascenty" ? "" : "purple"}" style="height:46px"></span>
            <div>
              <span class="kicker">${pop.id === "ascenty" ? "Núcleo / Data center" : "Ponto de presença"}</span>
              <h2 style="margin:4px 0 2px">${esc(pop.nome)}</h2>
              <p class="dim" style="font-size:var(--fs-12)">${esc(pop.local)}</p>
            </div>
          </div>
          <div class="row wrap" style="gap:6px;justify-content:flex-end">
            <span class="badge ${alarme ? "badge-warn" : "badge-ok"}"><i class="dot ${alarme ? "dot-warn" : "dot-ok"}"></i>${alarme ? alarme + " alerta(s)" : "estável"}</span>
            <span class="badge">${list.length} equipamento(s)</span>
          </div>
        </div>

        <div class="card-body stack">
          <div class="kv">
            <div><label>Portas</label><strong>${s.portas}</strong></div>
            <div><label>Em uso</label><strong>${s.emUso}</strong></div>
            <div><label>Livres</label><strong>${s.livres}</strong></div>
            <div><label>Ocupação</label><strong>${s.ocup}<span class="unit">%</span></strong></div>
          </div>
          <span class="meter ${occClass(s.ocup)}"><span style="width:${s.ocup}%"></span></span>

          <div>
            <h3 style="font-size:var(--fs-12);margin-bottom:var(--s-2)">Rotas do anel</h3>
            <div class="row wrap" style="gap:6px">
              ${rotas.length ? rotas.map((r) => `<span class="badge ${/subterr/i.test(r) ? "badge-info" : ""}">${esc(r)}</span>`).join("")
                : '<span class="dim" style="font-size:var(--fs-12)">Nenhuma rota cadastrada.</span>'}
            </div>
          </div>

          <div>
            <div class="row-between" style="margin-bottom:var(--s-2)">
              <h3 style="font-size:var(--fs-12)">Equipamentos vinculados</h3>
              <button class="btn btn-ghost btn-sm" type="button" data-add="${esc(pop.id)}" ${canEdit ? "" : "disabled"}>
                ${icon("plus")} Vincular equipamento</button>
            </div>
            <div class="stack" style="gap:var(--s-2)">
              ${list.length ? list.map((e) => `
                <div class="device-row">
                  <div class="row-top">
                    <div class="grow" style="min-width:0">
                      <b class="truncate">${esc(e.nome)}</b><br>
                      <small class="truncate">${esc(e.modelo || "")} • ${esc(e.categoria || "")}</small>
                    </div>
                    <div class="row" style="gap:6px">
                      <a class="btn btn-sm" href="topologia.html?device=${encodeURIComponent(e.id)}">Abrir</a>
                      <button class="btn btn-sm" type="button" data-unlink="${esc(e.id)}" ${canEdit ? "" : "disabled"}>Desvincular</button>
                    </div>
                  </div>
                  <div class="row" style="gap:var(--s-3)">
                    <span class="meter meter-sm ${occClass(UI.pct(used(e), e.portas.length))} grow"><span style="width:${UI.pct(used(e), e.portas.length)}%"></span></span>
                    <small class="mono dim">${used(e)}/${e.portas.length} portas</small>
                  </div>
                </div>`).join("")
              : `<div class="empty" style="padding:var(--s-6) 0">
                  <span class="empty-icon">${icon("port")}</span>
                  <b>Nenhum equipamento vinculado</b>
                  <p>Este POP existe no anel, mas ainda não tem equipamento associado.</p>
                </div>`}
            </div>
          </div>
        </div>
      </article>`;
    }).join("");

    $$("[data-unlink]").forEach((b) => (b.onclick = () => setPop(b.dataset.unlink, null)));
    $$("[data-add]").forEach((b) => (b.onclick = () => openLink(b.dataset.add)));

    renderRing();
    renderStats();

    if (foco) {
      const el = $("#pop-" + foco);
      if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }

  /* ---------- vínculo ---------- */
  function setPop(deviceId, popId) {
    const e = D.equipamentos.find((x) => x.id === deviceId);
    if (!e) return;
    const antes = e.popId || null;
    e.popId = popId || null;
    e.local = popId ? (D.pops.find((p) => p.id === popId)?.nome || e.local) : "Sem POP vinculado";
    render();
    toast(popId ? `${e.nome} vinculado` : `${e.nome} desvinculado`, {
      text: popId ? "Passa a contar na ocupação deste POP no Dashboard." : "Sai da ocupação do POP e vira pendência no Dashboard.",
      type: popId ? "ok" : "warn",
      action: { label: "Desfazer", run: () => { e.popId = antes; e.local = antes ? (D.pops.find((p) => p.id === antes)?.nome || e.local) : "Sem POP vinculado"; render(); } },
    });
  }

  function openLink(popId) {
    const pop = D.pops.find((p) => p.id === popId);
    const candidatos = D.equipamentos.filter((e) => (e.popId || null) !== popId);
    modal({
      labelledBy: "linkTitle",
      html: `
        <div class="modal-head">
          <div><span class="kicker">${esc(pop.nome)}</span>
            <h2 id="linkTitle" style="margin-top:6px">Vincular equipamento</h2>
            <p class="muted" style="font-size:var(--fs-13);margin-top:4px">Um equipamento pertence a um POP de cada vez. Ao vincular aqui, ele sai automaticamente do POP anterior.</p></div>
          <button class="btn btn-ghost btn-icon" data-close type="button" aria-label="Fechar">${icon("close")}</button>
        </div>
        <div class="modal-body stack">
          <div class="field">
            <label for="linkSel">Equipamento</label>
            <select class="select" id="linkSel">
              ${candidatos.map((e) => `<option value="${esc(e.id)}">${esc(e.nome)} — ${e.popId ? esc(D.pops.find((p) => p.id === e.popId)?.nome || "") : "sem POP"}</option>`).join("")}
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
          setPop(id, popId);
        };
      },
    });
  }

  /* ---------- anel ---------- */
  function ringLinks() {
    const alvo = (t) => {
      t = t.toLowerCase();
      if (t.includes("praia")) return "praia-grande";
      if (t.includes("santos")) return "santos";
      if (t.includes("vicente")) return "sao-vicente";
      if (t.includes("cubat")) return "cubatao";
      return null;
    };
    const map = new Map();
    D.pops.forEach((p) => rotasDe(p).forEach((r) => {
      const to = alvo(r);
      if (!to || to === p.id) return;
      const key = [p.id, to].sort().join("|");
      const cur = map.get(key) || { a: key.split("|")[0], b: key.split("|")[1], tipos: new Set() };
      cur.tipos.add(/subterr/i.test(r) ? "Subterrânea" : "Aérea");
      map.set(key, cur);
    }));
    return [...map.values()];
  }

  function renderRing() {
    const pops = D.pops.filter((p) => p.id !== "ascenty");
    const R = 92, cx = 130, cy = 120;
    const ponto = (i) => {
      const ang = (i / pops.length) * Math.PI * 2 - Math.PI / 2;
      return { x: cx + R * Math.cos(ang), y: cy + R * Math.sin(ang) };
    };
    const idx = Object.fromEntries(pops.map((p, i) => [p.id, i]));
    const links = ringLinks().filter((l) => idx[l.a] != null && idx[l.b] != null);

    $("#ringMap").innerHTML = `
      <svg viewBox="0 0 260 240" style="width:100%;height:auto" role="img" aria-label="Diagrama do anel óptico entre os POPs">
        ${links.map((l) => {
          const a = ponto(idx[l.a]), b = ponto(idx[l.b]);
          const sub = l.tipos.has("Subterrânea");
          return `<line x1="${a.x}" y1="${a.y}" x2="${b.x}" y2="${b.y}"
            stroke="${sub ? "var(--purple-400)" : "var(--cyan-400)"}" stroke-width="1.6"
            stroke-dasharray="${sub ? "6 5" : "0"}" opacity=".7"><title>${esc(l.a)} ↔ ${esc(l.b)}: ${[...l.tipos].join(" e ")}</title></line>`;
        }).join("")}
        ${pops.map((p, i) => {
          const q = ponto(i);
          const s = stats(devicesOf(p.id));
          return `<g>
            <circle cx="${q.x}" cy="${q.y}" r="13" fill="var(--surface-1)" stroke="var(--cyan-400)" stroke-width="1.6"/>
            <text x="${q.x}" y="${q.y + 3.5}" text-anchor="middle" style="font:700 9px var(--font-mono);fill:var(--text-1)">${s.ocup}%</text>
            <text x="${q.x}" y="${q.y + (q.y < cy ? -20 : 30)}" text-anchor="middle" style="font:700 9px var(--font-sans);fill:var(--text-3)">${esc(p.nome.replace("POP ", ""))}</text>
          </g>`;
        }).join("")}
      </svg>
      <div class="stack" style="gap:6px;margin-top:var(--s-3);font-size:var(--fs-11)">
        <span class="row" style="gap:var(--s-2)"><i style="width:16px;height:2px;background:var(--cyan-400);display:block"></i> Rota aérea</span>
        <span class="row" style="gap:var(--s-2)"><i style="width:16px;height:2px;background:var(--purple-400);display:block"></i> Rota subterrânea</span>
      </div>`;
  }

  function renderStats() {
    const s = stats(D.equipamentos.filter((e) => e.popId));
    const semPop = D.equipamentos.filter((e) => !e.popId).length;
    $("#ringStats").innerHTML = `
      <div><label>POPs</label><strong>${D.pops.length}</strong></div>
      <div><label>Rotas</label><strong>${ringLinks().length}</strong></div>
      <div><label>Portas</label><strong>${s.portas}</strong></div>
      <div><label>Sem POP</label><strong>${semPop}</strong></div>`;
  }

  UI.mountShell({ active: "pops" });
  $("#btnRing").innerHTML = icon("pops") + " Ver anel";
  $("#btnRing").onclick = () => $("#ringMap").scrollIntoView({ behavior: "smooth", block: "center" });
  render();
})();
