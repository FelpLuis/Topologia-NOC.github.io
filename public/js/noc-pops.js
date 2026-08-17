/* ============================================================
   UPDOWN NOC — POPs e anel óptico (aplicação real)
   Ficha de cada POP com rotas, ocupação e vínculo de equipamentos.
   ============================================================ */
(() => {
  "use strict";
  const { $, $$, esc, icon, toast, modal, confirm: askConfirm } = UI;

  const norm = (s) => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
  /* O nome curto é o que aparece no texto da rota: "POP SANTOS" → "santos". */
  const nomeCurto = (p) => norm(p?.nome).replace(/^pop\s*/, "").trim();
  const tipoDaRota = (r) => (/subterr/i.test(r) ? "Subterrânea" : "Aérea");
  const rotaAponta = (rota, alvo) => !!nomeCurto(alvo) && norm(rota).includes(nomeCurto(alvo));

  const state = {
    editOrder: false, orderDirty: false, orderBackup: null,
    editRing: false, ring: {}, ringDirty: false,
  };

  function ringLinks() {
    const pops = NOC.pops();
    const map = new Map();
    pops.forEach((p) => (p.rotas || []).forEach((r) => {
      const destino = pops.find((q) => q.id !== p.id && rotaAponta(r, q));
      if (!destino) return;
      const key = [p.id, destino.id].sort().join("|");
      const cur = map.get(key) || { a: key.split("|")[0], b: key.split("|")[1], tipos: new Set() };
      cur.tipos.add(tipoDaRota(r));
      map.set(key, cur);
    }));
    return [...map.values()];
  }

  /* ---------------- gravação com desfazer ---------------- */
  async function persist(reason, mensagem, undo) {
    try {
      await NOC.save(reason);
      render();
      toast(mensagem.titulo, {
        text: mensagem.texto,
        type: mensagem.tipo || "ok",
        action: undo ? { label: "Desfazer", run: undo } : null,
      });
      return true;
    } catch (err) {
      render();
      toast("Não foi possível salvar", { text: err.message, type: "danger", timeout: 7000 });
      return false;
    }
  }

  /* ---------------- lista de POPs ---------------- */
  function render() {
    // Vincular equipamento a um POP é ação da topologia, não do cadastro do POP.
    const canEdit = NOC.canAll(["topology.edit", "topology.pop.link"]);
    const canEditPop = NOC.canAll(["topology.edit", "pops.edit"]);
    const foco = new URLSearchParams(location.search).get("pop");
    const pops = NOC.pops();

    $("#popList").innerHTML = pops.length ? pops.map((pop, i) => {
      const list = NOC.devicesOfPop(pop.id);
      const s = NOC.statsOf(list);
      return `<article class="card" id="pop-${esc(pop.id)}" ${foco === pop.id ? 'style="border-color:var(--cyan-400)"' : ""}>
        <div class="card-head">
          <div class="row" style="gap:var(--s-4);align-items:flex-start">
            ${state.editOrder ? `<span class="badge badge-brand mono" style="align-self:center">${i + 1}º</span>` : ""}
            <span class="pop-marker purple" style="height:46px"></span>
            <div>
              <span class="kicker">Ponto de presença</span>
              <h2 style="margin:4px 0 2px">${esc(pop.nome)}</h2>
              <p class="dim mono" style="font-size:var(--fs-11)">${esc(pop.id)}</p>
            </div>
          </div>
          ${state.editOrder ? `<span class="row" style="gap:6px">
            <button class="btn btn-sm btn-icon" type="button" data-up="${esc(pop.id)}" ${i === 0 ? "disabled" : ""}
              aria-label="Mover ${esc(pop.nome)} para cima" title="Mover para cima">↑</button>
            <button class="btn btn-sm btn-icon" type="button" data-down="${esc(pop.id)}" ${i === pops.length - 1 ? "disabled" : ""}
              aria-label="Mover ${esc(pop.nome)} para baixo" title="Mover para baixo">↓</button>
          </span>` : `<span class="row" style="gap:6px">
            <span class="badge">${list.length} equipamento(s)</span>
            <button class="btn btn-sm" type="button" data-edit-pop="${esc(pop.id)}"
              ${canEditPop ? "" : "disabled title='Requer as ações topology.edit + pops.edit'"}>${icon("edit")} Editar informações</button>
          </span>`}
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
    $$("[data-edit-pop]").forEach((b) => (b.onclick = () => openEditPop(b.dataset.editPop)));
    $$("[data-up]").forEach((b) => (b.onclick = () => moverPop(b.dataset.up, -1)));
    $$("[data-down]").forEach((b) => (b.onclick = () => moverPop(b.dataset.down, 1)));

    renderOrderBar();
    renderRing();
    renderStats();

    if (foco && !state.editOrder) $("#pop-" + foco)?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  /* ---------------- informações do POP ----------------
     O identificador não muda porque é usado pelos vínculos dos equipamentos.
     Como as rotas apontam para o nome em texto, uma renomeação também ajusta
     as referências dos demais POPs para manter o anel íntegro. */
  function openEditPop(popId) {
    const pop = NOC.popById(popId);
    if (!pop) return;
    const canRename = NOC.canAll(["topology.edit", "pops.edit", "pops.routes"]);

    const noteRow = (e = {}) => `<div class="device-row pop-note">
      <div class="row" style="gap:var(--s-3);align-items:flex-start">
        <div class="field grow"><label>Nome / identificação</label><input class="input" data-note-name value="${esc(e.nome || "")}" placeholder="Ex.: Rack principal"></div>
        <div class="field grow"><label>Modelo / detalhe</label><input class="input" data-note-model value="${esc(e.modelo || "")}" placeholder="Ex.: Huawei S6730"></div>
        <button class="btn btn-sm btn-icon" data-remove-note type="button" aria-label="Remover anotação" title="Remover anotação">${icon("close")}</button>
      </div>
      <div class="field"><label>Observação</label><textarea class="textarea" data-note-observation rows="2" placeholder="Informações úteis para a equipe de campo">${esc(e.observacao || "")}</textarea></div>
    </div>`;

    modal({
      wide: true,
      labelledBy: "editPopTitle",
      html: `
        <form id="editPopForm">
          <div class="modal-head">
            <div><span class="kicker">Ponto de presença</span>
              <h2 id="editPopTitle" style="margin-top:6px">Editar informações do POP</h2>
              <p class="muted mono" style="font-size:var(--fs-12);margin-top:4px">${esc(pop.id)} · identificador permanente</p></div>
            <button class="btn btn-ghost btn-icon" data-close type="button" aria-label="Fechar">${icon("close")}</button>
          </div>
          <div class="modal-body stack">
            <div class="field">
              <label for="editPopName">Nome do POP *</label>
              <input class="input" id="editPopName" required value="${esc(pop.nome || "")}" ${canRename ? "" : "readonly"}>
              ${canRename ? '<small class="dim">Ao renomear, as referências existentes no anel também serão atualizadas.</small>'
                : '<small class="dim">Para renomear também é necessária a permissão de editar rotas.</small>'}
            </div>
            <div class="row-between">
              <div><h3 style="font-size:var(--fs-13)">Anotações de campo</h3><small class="dim">Dados descritivos do local; não alteram os equipamentos vinculados.</small></div>
              <button class="btn btn-sm" id="addPopNote" type="button">${icon("plus")} Adicionar anotação</button>
            </div>
            <div class="stack" id="popNotes" style="gap:var(--s-2)">
              ${(pop.equipamentos || []).map(noteRow).join("") || '<p class="dim" data-no-notes>Nenhuma anotação cadastrada.</p>'}
            </div>
          </div>
          <div class="modal-foot">
            <span class="dim" style="font-size:var(--fs-11)">A alteração será registrada na auditoria.</span>
            <span class="row"><button class="btn" data-close type="button">Cancelar</button>
            <button class="btn btn-primary" type="submit">Salvar informações</button></span>
          </div>
        </form>`,
      onMount: (host, close) => {
        const form = $("#editPopForm", host);
        const notes = $("#popNotes", host);
        const bindRemove = () => $$("[data-remove-note]", notes).forEach((b) => (b.onclick = () => {
          b.closest(".pop-note")?.remove();
          if (!$(".pop-note", notes)) notes.innerHTML = '<p class="dim" data-no-notes>Nenhuma anotação cadastrada.</p>';
        }));
        bindRemove();
        $("#addPopNote", host).onclick = () => {
          $("[data-no-notes]", notes)?.remove();
          notes.insertAdjacentHTML("beforeend", noteRow());
          bindRemove();
          const fields = $$("[data-note-name]", notes);
          fields[fields.length - 1]?.focus();
        };

        form.onsubmit = async (ev) => {
          ev.preventDefault();
          const nome = $("#editPopName", form).value.trim();
          if (!nome) return $("#editPopName", form).focus();
          const antes = JSON.parse(JSON.stringify(NOC.data().pops || []));
          const nomeAnterior = pop.nome;
          const mudouNome = nome !== nomeAnterior;

          if (mudouNome) {
            for (const outro of NOC.data().pops) {
              if (outro.id === pop.id || !Array.isArray(outro.rotas)) continue;
              outro.rotas = outro.rotas.map((rota) => rotaAponta(rota, pop)
                ? `${tipoDaRota(rota)} → ${nomeExibicao({ nome })}`
                : rota);
            }
          }
          pop.nome = nome;
          pop.equipamentos = $$(".pop-note", notes).map((row) => ({
            nome: $("[data-note-name]", row).value.trim(),
            modelo: $("[data-note-model]", row).value.trim(),
            observacao: $("[data-note-observation]", row).value.trim(),
          })).filter((e) => e.nome || e.modelo || e.observacao);

          const ok = await persist(
            "TOPOLOGY_UPDATE_POP",
            { titulo: "Informações do POP salvas", texto: mudouNome ? `${nomeAnterior} passou a se chamar ${nome}.` : `${nome} foi atualizado.` },
            async () => {
              NOC.data().pops = JSON.parse(JSON.stringify(antes));
              await persist("TOPOLOGY_UPDATE_POP", { titulo: "Alteração do POP desfeita", tipo: "info" });
            }
          );
          if (ok) close();
          else {
            NOC.data().pops = antes;
            render();
          }
        };
      },
    });
  }

  /* ---------------- sequência dos POPs ----------------
     A ordem do array pops manda na lista desta tela, no desenho do anel e na
     ordem em que a topologia distribui as caixas dos POPs no mapa. */
  function moverPop(id, passo) {
    const lista = NOC.data()?.pops || [];
    const i = lista.findIndex((p) => p.id === id);
    const j = i + passo;
    if (i < 0 || j < 0 || j >= lista.length) return;
    [lista[i], lista[j]] = [lista[j], lista[i]];
    state.orderDirty = true;
    render();
    $("#pop-" + id)?.scrollIntoView({ behavior: "smooth", block: "center" });
  }

  function renderOrderBar() {
    const bar = $("#orderBar");
    if (!bar) return;
    bar.hidden = !state.editOrder;
    $("#orderStatus").textContent = state.orderDirty
      ? "sequência alterada e ainda não salva"
      : "use as setas ↑ ↓ de cada POP para reordenar";
    $("#orderSave").disabled = !state.orderDirty;
    $("#orderDiscard").disabled = !state.orderDirty;
    const b = $("#btnOrder");
    b.setAttribute("aria-pressed", String(state.editOrder));
    b.textContent = state.editOrder ? "Sair da sequência" : "Editar sequência";
  }

  function toggleOrder() {
    if (state.editOrder && state.orderDirty) {
      askConfirm({
        title: "Sair sem salvar a sequência?",
        text: "Os POPs voltam para a ordem da última gravação.",
        confirmLabel: "Descartar alterações",
        danger: true,
        onConfirm: () => { discardOrder(); state.editOrder = false; render(); },
      });
      return;
    }
    state.editOrder = !state.editOrder;
    state.orderBackup = state.editOrder ? (NOC.data()?.pops || []).slice() : null;
    render();
  }

  function discardOrder() {
    if (state.orderBackup) NOC.data().pops = state.orderBackup.slice();
    state.orderDirty = false;
    render();
  }

  async function saveOrder() {
    const antes = state.orderBackup ? state.orderBackup.slice() : (NOC.data().pops || []).slice();
    const depois = (NOC.data().pops || []).slice();
    state.orderDirty = false;
    const ok = await persist(
      "TOPOLOGY_REORDER_POPS",
      { titulo: "Sequência dos POPs salva", texto: "Vale para esta tela, para o anel e para a ordem do mapa da topologia." },
      async () => {
        NOC.data().pops = antes;
        state.orderBackup = antes.slice();
        await persist("TOPOLOGY_REORDER_POPS", { titulo: "Sequência anterior restaurada", tipo: "info" });
      }
    );
    if (ok) state.orderBackup = depois;
    else state.orderDirty = true;
    renderOrderBar();
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
  const RING = { w: 260, h: 240, cx: 130, cy: 120, r: 92, minX: 30, maxX: 230, minY: 26, maxY: 210 };
  /* O cadastro guarda o POP em caixa alta ("POP SÃO VICENTE"), mas a rota é
     texto de leitura ("Subterrânea → São Vicente"). Só ajusta a caixa quando o
     nome está todo em maiúsculas; nomes já formatados ficam como estão. */
  const nomeExibicao = (p) => {
    const base = String(p?.nome || "").replace(/^POP\s*/i, "").trim();
    if (/\p{Ll}/u.test(base)) return base;
    return base.toLowerCase().replace(/(^|[\s\-/])(\p{L})/gu, (m, sep, c) => sep + c.toUpperCase());
  };
  const preso = (v, min, max) => Math.max(min, Math.min(max, Math.round(v)));

  /* Posição do POP no diagrama: a gravada pelo admin ou, sem ela, o ponto
     correspondente na circunferência, seguindo a sequência dos POPs. */
  function ringPos(p, i, total) {
    const m = state.ring[p.id];
    if (m && Number.isFinite(+m.x) && Number.isFinite(+m.y)) return { x: +m.x, y: +m.y };
    const ang = (i / total) * Math.PI * 2 - Math.PI / 2;
    return { x: RING.cx + RING.r * Math.cos(ang), y: RING.cy + RING.r * Math.sin(ang) };
  }

  function renderRing() {
    const host = $("#ringMap");
    const pops = NOC.pops();
    if (!pops.length) {
      host.innerHTML = '<p class="dim" style="font-size:var(--fs-12)">Sem POPs cadastrados.</p>';
      renderRingBar();
      return;
    }
    const pos = {};
    pops.forEach((p, i) => (pos[p.id] = ringPos(p, i, pops.length)));
    const links = ringLinks();

    host.innerHTML = `
      <svg class="ring-svg ${state.editRing ? "is-editing" : ""}" viewBox="0 0 ${RING.w} ${RING.h}"
           style="width:100%;height:auto;touch-action:none" role="img"
           aria-label="Diagrama do anel óptico entre os POPs">
        ${links.map((l) => {
          const a = pos[l.a], b = pos[l.b];
          if (!a || !b) return "";
          const sub = l.tipos.has("Subterrânea");
          return `<line x1="${a.x}" y1="${a.y}" x2="${b.x}" y2="${b.y}"
            stroke="${sub ? "var(--purple-400)" : "var(--cyan-400)"}" stroke-width="1.6"
            stroke-dasharray="${sub ? "6 5" : "0"}" opacity=".7"></line>`;
        }).join("")}
        ${pops.map((p) => {
          const q = pos[p.id];
          const s = NOC.statsOf(NOC.devicesOfPop(p.id));
          const manual = !!state.ring[p.id];
          return `<g class="ring-node" data-pop="${esc(p.id)}">
            <circle cx="${q.x}" cy="${q.y}" r="13" fill="var(--surface-1)"
              stroke="${manual && state.editRing ? "var(--purple-400)" : "var(--cyan-400)"}" stroke-width="1.6"/>
            <text x="${q.x}" y="${q.y + 3.5}" text-anchor="middle" style="font:700 9px var(--font-mono);fill:var(--text-1);pointer-events:none">${s.ocup}%</text>
            <text x="${q.x}" y="${q.y + (q.y < RING.cy ? -20 : 30)}" text-anchor="middle" style="font:700 9px var(--font-sans);fill:var(--text-3);pointer-events:none">${esc(nomeExibicao(p))}</text>
            <title>${esc(p.nome)}${state.editRing ? " — arraste para posicionar" : ""}</title>
          </g>`;
        }).join("")}
      </svg>
      <div class="stack" style="gap:6px;margin-top:var(--s-3);font-size:var(--fs-11)">
        <span class="row" style="gap:var(--s-2)"><i style="width:16px;height:2px;background:var(--cyan-400);display:block"></i> Rota aérea</span>
        <span class="row" style="gap:var(--s-2)"><i style="width:16px;height:2px;background:var(--purple-400);display:block"></i> Rota subterrânea</span>
      </div>`;
    renderRingBar();
  }

  function renderRingBar() {
    const bar = $("#ringBar");
    if (!bar) return;
    bar.hidden = !state.editRing;
    const n = Object.keys(state.ring).length;
    $("#ringStatus").textContent = state.ringDirty
      ? "posições não salvas"
      : n ? `${n} POP(s) posicionado(s)` : "arraste os POPs no diagrama";
    $("#ringSave").disabled = !state.ringDirty;
    $("#ringDiscard").disabled = !state.ringDirty;
    $("#ringAuto").disabled = !n;
    const b = $("#btnRing");
    b.setAttribute("aria-pressed", String(state.editRing));
    b.textContent = state.editRing ? "Sair do mapa" : "Editar mapa";
  }

  /* Arrasto dos nós: o SVG é redesenhado a cada quadro, então os ouvintes de
     movimento ficam na janela e não no nó, que deixa de existir no caminho. */
  function bindRingDrag() {
    const host = $("#ringMap");
    if (!host) return;
    host.addEventListener("pointerdown", (ev) => {
      if (!state.editRing) return;
      const no = ev.target.closest(".ring-node");
      const svg = host.querySelector("svg");
      if (!no || !svg) return;
      ev.preventDefault();
      const id = no.dataset.pop;
      const pops = NOC.pops();
      const atual = ringPos(pops.find((p) => p.id === id), pops.findIndex((p) => p.id === id), pops.length);
      const rect = svg.getBoundingClientRect();
      const escala = RING.w / (rect.width || RING.w);
      // guarda a distância entre o ponteiro e o centro do nó: ele não "pula"
      const dx = atual.x - (ev.clientX - rect.left) * escala;
      const dy = atual.y - (ev.clientY - rect.top) * escala;
      const sx = ev.clientX, sy = ev.clientY;
      let quadro = null, ativo = false;

      const mover = (e) => {
        if (!ativo && Math.abs(e.clientX - sx) + Math.abs(e.clientY - sy) < 3) return;
        ativo = true;
        state.ring[id] = {
          x: preso((e.clientX - rect.left) * escala + dx, RING.minX, RING.maxX),
          y: preso((e.clientY - rect.top) * escala + dy, RING.minY, RING.maxY),
        };
        state.ringDirty = true;
        if (!quadro) quadro = requestAnimationFrame(() => { quadro = null; renderRing(); });
      };
      const soltar = () => {
        removeEventListener("pointermove", mover);
        removeEventListener("pointerup", soltar);
        removeEventListener("pointercancel", soltar);
        renderRing();
      };
      addEventListener("pointermove", mover);
      addEventListener("pointerup", soltar);
      addEventListener("pointercancel", soltar);
    });
  }

  function toggleRing() {
    if (state.editRing && state.ringDirty) {
      askConfirm({
        title: "Sair sem salvar o mapa do anel?",
        text: "Os POPs voltam para as posições da última gravação.",
        confirmLabel: "Descartar alterações",
        danger: true,
        onConfirm: () => { discardRing(); state.editRing = false; renderRing(); },
      });
      return;
    }
    state.editRing = !state.editRing;
    renderRing();
  }

  function discardRing() {
    state.ring = { ...(NOC.data()?.config?.ringLayout || {}) };
    state.ringDirty = false;
    renderRing();
  }

  async function saveRing() {
    const antes = { ...(NOC.data()?.config?.ringLayout || {}) };
    const gravar = (posicoes) => {
      const t = NOC.data();
      t.config = { ...(t.config || {}), ringLayout: posicoes };
      state.ring = { ...posicoes };
      state.ringDirty = false;
    };
    const depois = { ...state.ring };
    gravar(depois);
    const ok = await persist(
      "TOPOLOGY_RING_LAYOUT",
      { titulo: "Mapa do anel salvo", texto: "O desenho vale para todos os usuários." },
      async () => {
        gravar(antes);
        await persist("TOPOLOGY_RING_LAYOUT", { titulo: "Desenho anterior restaurado", tipo: "info" });
      }
    );
    if (!ok) state.ringDirty = true;
    renderRingBar();
  }

  /* ---------------- rotas do anel ----------------
     A rota mora no cadastro do POP, como texto ("Aérea → Santos"), e é lida
     dos dois lados. Aqui ela é escrita nesse mesmo formato, para a topologia
     e esta tela continuarem enxergando o mesmo anel. */
  function setRota(aId, bId, tipo, ativo) {
    const pops = NOC.data()?.pops || [];
    const a = pops.find((p) => p.id === aId);
    const b = pops.find((p) => p.id === bId);
    if (!a || !b || a === b) return;
    [[a, b], [b, a]].forEach(([origem, alvo]) => {
      if (!Array.isArray(origem.rotas)) origem.rotas = [];
      const igual = (r) => rotaAponta(r, alvo) && tipoDaRota(r) === tipo;
      if (ativo) {
        if (!origem.rotas.some(igual)) origem.rotas.push(`${tipo} → ${nomeExibicao(alvo)}`);
      } else {
        origem.rotas = origem.rotas.filter((r) => !igual(r));
      }
    });
  }

  function openRoutes() {
    const canEdit = NOC.canAll(["topology.edit", "pops.routes"]);
    modal({
      wide: true,
      labelledBy: "rotasTitle",
      html: `
        <div class="modal-head">
          <div><span class="kicker">Anel óptico</span>
            <h2 id="rotasTitle" style="margin-top:6px">Rotas entre POPs</h2>
            <p class="muted" style="font-size:var(--fs-13);margin-top:4px">A rota é gravada nos dois POPs e é o que desenha o anel aqui e no mapa da topologia.</p></div>
          <button class="btn btn-ghost btn-icon" data-close type="button" aria-label="Fechar">${icon("close")}</button>
        </div>
        <div class="modal-body stack" id="rotasBody"></div>`,
      onMount: (host) => {
        const body = $("#rotasBody", host);
        const paint = () => {
          const pops = NOC.pops();
          const links = ringLinks();
          const opcoes = (sel) => pops.map((p) => `<option value="${esc(p.id)}" ${sel === p.id ? "selected" : ""}>${esc(p.nome)}</option>`).join("");
          body.innerHTML = `
            <form class="row wrap" style="gap:var(--s-3);align-items:flex-end" id="novaRota">
              <div class="field grow" style="min-width:170px"><label for="rA">De</label><select class="select" id="rA">${opcoes(pops[0]?.id)}</select></div>
              <div class="field grow" style="min-width:170px"><label for="rB">Para</label><select class="select" id="rB">${opcoes(pops[1]?.id)}</select></div>
              <div class="field" style="width:180px"><label for="rTipo">Tipo</label>
                <select class="select" id="rTipo"><option>Aérea</option><option>Subterrânea</option></select></div>
              <button class="btn btn-primary" type="submit" ${canEdit ? "" : "disabled title='Requer as ações topology.edit + pops.routes'"}>Adicionar rota</button>
            </form>
            <div class="table-wrap" style="max-height:360px"><table class="table">
              <thead><tr><th>POP</th><th>POP</th><th>Aérea</th><th>Subterrânea</th></tr></thead>
              <tbody>${links.length ? links.map((l, i) => {
                const a = NOC.popById(l.a), b = NOC.popById(l.b);
                return `<tr>
                  <td><b>${esc(a?.nome || l.a)}</b></td>
                  <td><b>${esc(b?.nome || l.b)}</b></td>
                  ${["Aérea", "Subterrânea"].map((tipo) => `<td>
                    <button class="chip" type="button" data-toggle="${i}" data-tipo="${tipo}"
                      aria-pressed="${l.tipos.has(tipo)}" ${canEdit ? "" : "disabled"}>${l.tipos.has(tipo) ? "Sim" : "—"}</button>
                  </td>`).join("")}
                </tr>`;
              }).join("") : `<tr><td colspan="4"><div class="empty"><b>Nenhuma rota cadastrada</b>
                  <p>Use o formulário acima para ligar dois POPs.</p></div></td></tr>`}</tbody>
            </table></div>
            <p class="dim" style="font-size:var(--fs-11)">${icon("info")} Desligar os dois tipos remove a rota entre os POPs.</p>`;

          $$("[data-toggle]", body).forEach((b) => (b.onclick = async () => {
            const l = links[+b.dataset.toggle];
            const tipo = b.dataset.tipo;
            const ativo = b.getAttribute("aria-pressed") === "true";
            setRota(l.a, l.b, tipo, !ativo);
            const ok = await persist(
              "TOPOLOGY_UPDATE_ROTAS",
              {
                titulo: ativo ? `Rota ${tipo.toLowerCase()} removida` : `Rota ${tipo.toLowerCase()} criada`,
                texto: `${NOC.popById(l.a)?.nome || l.a} ↔ ${NOC.popById(l.b)?.nome || l.b}`,
                tipo: ativo ? "warn" : "ok",
              },
              async () => {
                setRota(l.a, l.b, tipo, ativo);
                await persist("TOPOLOGY_UPDATE_ROTAS", { titulo: "Rota restaurada", tipo: "info" });
                paint();
              }
            );
            if (!ok) setRota(l.a, l.b, tipo, ativo);
            paint();
          }));

          const form = $("#novaRota", body);
          if (form) form.onsubmit = async (ev) => {
            ev.preventDefault();
            const aId = $("#rA", form).value, bId = $("#rB", form).value, tipo = $("#rTipo", form).value;
            if (aId === bId) {
              toast("Escolha dois POPs diferentes", { text: "Uma rota liga dois pontos de presença distintos.", type: "warn" });
              return;
            }
            setRota(aId, bId, tipo, true);
            const ok = await persist(
              "TOPOLOGY_UPDATE_ROTAS",
              { titulo: "Rota criada", texto: `${NOC.popById(aId)?.nome} ↔ ${NOC.popById(bId)?.nome} • ${tipo}` },
              async () => {
                setRota(aId, bId, tipo, false);
                await persist("TOPOLOGY_UPDATE_ROTAS", { titulo: "Rota removida", tipo: "info" });
                paint();
              }
            );
            if (!ok) setRota(aId, bId, tipo, false);
            paint();
          };
        };
        paint();
      },
    });
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

    state.ring = { ...(NOC.data()?.config?.ringLayout || {}) };

    // As ações exigidas por cada botão estão declaradas no HTML (data-action).
    NOC.applyActions(document);
    $("#btnOrder").onclick = toggleOrder;
    $("#orderSave").onclick = saveOrder;
    $("#orderDiscard").onclick = discardOrder;
    $("#btnRing").onclick = toggleRing;
    $("#btnRoutes").onclick = openRoutes;
    $("#ringSave").onclick = saveRing;
    $("#ringDiscard").onclick = discardRing;
    $("#ringAuto").onclick = () => askConfirm({
      title: "Voltar ao desenho automático?",
      text: "As posições manuais são descartadas e os POPs voltam a se distribuir em círculo, na sequência cadastrada.",
      confirmLabel: "Usar desenho automático",
      onConfirm: () => {
        state.ring = {};
        state.ringDirty = true;
        renderRing();
      },
    });
    bindRingDrag();

    render();
  }

  boot();
})();
