/* ============================================================
   UPDOWN NOC — Cadastro de ISP (PARTE ISP)
   A tela de cadastro do recorte ISP: criar, editar e excluir o
   cliente, e criar, vincular, desvincular e excluir os
   equipamentos dele.

   É o que a tela de POPs não faz: lá o POP só é editado e o
   equipamento só é vinculado — criar e excluir mora em outro
   lugar (ou não existe). Aqui o ciclo inteiro está em um lugar só.

   Grava por /api/topology?scope=isp, com a mesma auditoria e as
   mesmas ações de perfil do resto do sistema.
   ============================================================ */
(() => {
  "use strict";
  const { $, $$, esc, icon, toast, modal, confirm: askConfirm } = UI;

  const TIPOS = ["Cliente ISP", "POP", "Parceiro", "Operadora", "Cliente corporativo"];

  const state = { busca: "", tipo: "", foco: null };

  /* Cada operação exige a sua ação, do mesmo jeito que o Worker confere na
     gravação. topology.edit/delete continuam sendo a base de qualquer escrita. */
  const podeCriar = () => NOC.canAll(["topology.edit", "pops.create"]);
  const podeEditar = () => NOC.canAll(["topology.edit", "pops.edit"]);
  const podeExcluir = () => NOC.canAll(["topology.delete", "pops.delete"]);
  const podeVincular = () => NOC.canAll(["topology.edit", "topology.pop.link"]);
  const podeCriarEquip = () => NOC.canAll(["topology.edit", "topology.equipment.create"]);
  const podeEditarEquip = () => NOC.canAll(["topology.edit", "topology.equipment.edit"]);
  const podeExcluirEquip = () => NOC.canAll(["topology.delete", "topology.equipment.delete"]);

  const dados = () => NOC.data() || {};
  const registros = () => dados().pops || [];
  const registro = (id) => registros().find((p) => p.id === id) || null;
  const equipamentos = () => dados().equipamentos || [];
  const semVinculo = () => equipamentos().filter((e) => !NOC.effectivePop(e));

  const semAcento = (s) => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
  const tipoDe = (p) => p.tipo || "Cliente ISP";

  function visiveis() {
    const q = semAcento(state.busca);
    return NOC.pops().filter((p) => {
      if (state.tipo && tipoDe(p) !== state.tipo) return false;
      if (!q) return true;
      return semAcento(`${p.nome} ${p.id} ${p.endereco || ""} ${tipoDe(p)}`).includes(q);
    });
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

  /* ---------------- lista ---------------- */
  function render() {
    const lista = visiveis();
    const todos = NOC.pops();

    $("#ispCount").textContent = `${lista.length} de ${todos.length}`;
    const tipos = [...new Set(todos.map(tipoDe))].sort();
    $("#ispTipos").innerHTML = tipos.map((t) => `
      <button class="chip" type="button" data-tipo="${esc(t)}" aria-pressed="${state.tipo === t}">
        ${esc(t)} <span class="count">${todos.filter((p) => tipoDe(p) === t).length}</span></button>`).join("");
    $$("#ispTipos .chip").forEach((b) => (b.onclick = () => {
      state.tipo = state.tipo === b.dataset.tipo ? "" : b.dataset.tipo;
      render();
    }));

    $("#ispList").innerHTML = lista.length ? lista.map((p) => cartao(p)).join("")
      : `<div class="card"><div class="empty">
          <span class="empty-icon">${icon("pops")}</span>
          <b>${todos.length ? "Nenhum ISP encontrado" : "Nenhum ISP cadastrado"}</b>
          <p>${todos.length
            ? "Ajuste a busca ou remova o filtro de tipo."
            : "Use “Novo ISP” para cadastrar o primeiro cliente da PARTE ISP."}</p>
        </div></div>`;

    $$("[data-editar]").forEach((b) => (b.onclick = () => formIsp(registro(b.dataset.editar))));
    $$("[data-excluir]").forEach((b) => (b.onclick = () => excluirIsp(registro(b.dataset.excluir))));
    $$("[data-novo-equip]").forEach((b) => (b.onclick = () => formEquipamento(null, b.dataset.novoEquip)));
    $$("[data-vincular]").forEach((b) => (b.onclick = () => abrirVinculo(b.dataset.vincular)));
    $$("[data-editar-equip]").forEach((b) => (b.onclick = () => formEquipamento(b.dataset.editarEquip)));
    $$("[data-desvincular]").forEach((b) => (b.onclick = () => vincular(b.dataset.desvincular, null)));
    $$("[data-excluir-equip]").forEach((b) => (b.onclick = () => excluirEquipamento(b.dataset.excluirEquip)));
    $$("[data-abrir-equip]").forEach((b) => (b.onclick = () => window.TOPO?.abrirEquipamento(b.dataset.abrirEquip)));

    renderResumo();
    if (state.foco) {
      $("#isp-" + state.foco)?.scrollIntoView({ behavior: "smooth", block: "start" });
      state.foco = null;
    }
  }

  /* A observação importada do KMZ pode ter mil caracteres (documentação de DIO,
     link do Street View). Curta, aparece direto; longa, fica recolhida, para um
     cartão não empurrar a lista inteira para baixo. */
  const OBS_CURTA = 220;
  function observacaoHtml(texto) {
    const obs = String(texto || "").trim();
    if (!obs) return "";
    const corpo = `<p class="dim texto-livre" style="font-size:var(--fs-12)">${esc(obs)}</p>`;
    if (obs.length <= OBS_CURTA) {
      return `<div><h3 style="font-size:var(--fs-12);margin-bottom:var(--s-2)">Observação</h3>${corpo}</div>`;
    }
    return `<details class="texto-longo">
      <summary>Observação — ${obs.length} caracteres</summary>${corpo}</details>`;
  }

  function cartao(p) {
    const list = NOC.devicesOfPop(p.id);
    const s = NOC.statsOf(list);
    const c = NOC.popCoords(p);
    const proprio = tipoDe(p) === "POP";

    return `<article class="card" id="isp-${esc(p.id)}">
      <div class="card-head">
        <div class="row" style="gap:var(--s-4);align-items:flex-start">
          <span class="pop-marker ${proprio ? "" : "purple"}" style="height:52px"></span>
          <div style="min-width:0">
            <span class="kicker">${esc(tipoDe(p))}</span>
            <h2 style="margin:4px 0 2px">${esc(p.nome)}</h2>
            <p class="dim mono texto-livre" style="font-size:var(--fs-11)">${esc(p.id)}</p>
            ${p.endereco ? `<p class="dim texto-livre" style="font-size:var(--fs-12);margin-top:4px">${icon("pops")} ${esc(p.endereco)}</p>` : ""}
            <p class="dim mono" style="font-size:var(--fs-11);margin-top:4px">
              ${c ? esc(GEO.label(c.lat, c.lon)) : '<span class="badge badge-warn">sem localização</span>'}</p>
          </div>
        </div>
        <span class="row wrap" style="gap:6px;justify-content:flex-end">
          <span class="badge">${list.length} equipamento(s)</span>
          ${c ? `<a class="btn btn-sm" href="/isp-mapa.html?pop=${encodeURIComponent(p.id)}">Ver no mapa</a>` : ""}
          <button class="btn btn-sm" type="button" data-editar="${esc(p.id)}"
            ${podeEditar() ? "" : "disabled title='Requer as ações topology.edit + pops.edit'"}>${icon("edit")} Editar</button>
          <button class="btn btn-sm btn-danger" type="button" data-excluir="${esc(p.id)}"
            ${podeExcluir() ? "" : "disabled title='Requer as ações topology.delete + pops.delete'"}>${icon("trash")} Excluir</button>
        </span>
      </div>

      <div class="card-body stack">
        <div class="kv">
          <div><label>Portas</label><strong>${s.portas}</strong></div>
          <div><label>Em uso</label><strong>${s.emUso}</strong></div>
          <div><label>Livres</label><strong>${s.livres}</strong></div>
          <div><label>Ocupação</label><strong>${s.ocup}<span class="unit">%</span></strong></div>
        </div>
        <span class="meter ${NOC.occClass(s.ocup)}"><span style="width:${s.ocup}%"></span></span>

        ${(p.rotas || []).length ? `<div>
          <h3 style="font-size:var(--fs-12);margin-bottom:var(--s-2)">Rotas</h3>
          <div class="row wrap" style="gap:6px">
            ${p.rotas.map((r) => `<span class="badge ${/subterr/i.test(r) ? "badge-info" : ""}">${esc(r)}</span>`).join("")}
          </div></div>` : ""}

        ${observacaoHtml(p.observacao)}

        <div>
          <div class="row-between wrap" style="margin-bottom:var(--s-2);gap:6px">
            <h3 style="font-size:var(--fs-12)">Equipamentos</h3>
            <span class="row" style="gap:6px">
              <button class="btn btn-ghost btn-sm" type="button" data-vincular="${esc(p.id)}"
                ${podeVincular() ? "" : "disabled title='Requer as ações topology.edit + topology.pop.link'"}
                >${icon("link")} Vincular existente</button>
              <button class="btn btn-sm" type="button" data-novo-equip="${esc(p.id)}"
                ${podeCriarEquip() ? "" : "disabled title='Requer as ações topology.edit + topology.equipment.create'"}
                >${icon("plus")} Novo equipamento</button>
            </span>
          </div>
          <div class="stack" style="gap:var(--s-2)">
            ${list.length ? list.map((e) => linhaEquipamento(e)).join("") : `
              <div class="empty" style="padding:var(--s-6) 0">
                <span class="empty-icon">${icon("port")}</span>
                <b>Nenhum equipamento neste ISP</b>
                <p>Cadastre um equipamento novo ou vincule um que já existe na PARTE ISP.</p>
              </div>`}
          </div>
        </div>
      </div>
    </article>`;
  }

  function linhaEquipamento(e) {
    const o = NOC.occupancy(e);
    const st = NOC.statusInfo(e);
    const enlaces = NOC.connectionsOf(e.id).length;
    return `<div class="device-row">
      <div class="row-top">
        <div class="grow" style="min-width:0">
          <b class="truncate">${esc(e.nome)}</b>
          ${st.dot ? `<span class="badge ${st.badge}"><i class="dot ${st.dot}"></i>${st.label}</span>` : ""}
          ${NOC.isSuggested(e) ? '<span class="badge badge-warn">vínculo sugerido</span>' : ""}
          <br><small class="truncate">${esc(e.modelo || "Modelo não informado")} • ${esc(e.categoria || "Equipamento")}</small>
        </div>
        <div class="row wrap" style="gap:6px;justify-content:flex-end">
          <button class="btn btn-sm" type="button" data-abrir-equip="${esc(e.id)}">${icon("port")} Abrir</button>
          <button class="btn btn-sm" type="button" data-desvincular="${esc(e.id)}"
            ${podeVincular() ? "" : "disabled title='Requer as ações topology.edit + topology.pop.link'"}>Desvincular</button>
        </div>
      </div>
      <div class="row" style="gap:var(--s-3)">
        <span class="meter meter-sm ${NOC.occClass(o)} grow"><span style="width:${o}%"></span></span>
        <small class="mono dim">${NOC.usedPorts(e)}/${e.portas.length} portas${enlaces ? ` • ${enlaces} enlace(s)` : ""}</small>
      </div>
    </div>`;
  }

  function renderResumo() {
    const todos = NOC.pops();
    const clientes = todos.filter((p) => tipoDe(p) !== "POP");
    const eqs = equipamentos();
    const s = NOC.statsOf(eqs);
    const soltos = semVinculo();
    const semCoord = todos.filter((p) => !NOC.popCoords(p));

    $("#ispStats").innerHTML = `
      <div><label>ISPs</label><strong>${todos.length}</strong></div>
      <div><label>Clientes</label><strong>${clientes.length}</strong></div>
      <div><label>Equipamentos</label><strong>${eqs.length}</strong></div>
      <div><label>Portas</label><strong>${s.portas}</strong></div>
      <div><label>Em uso</label><strong>${s.emUso}</strong></div>
      <div><label>Ocupação</label><strong>${s.ocup}<span class="unit">%</span></strong></div>`;

    const avisos = [];
    if (soltos.length) avisos.push(`<div class="alert alert-info" style="animation:none">${icon("info")}
      <span><b>${soltos.length} equipamento(s) sem ISP.</b> Eles não entram na ocupação de nenhum cliente.</span>
      <button class="btn btn-sm" type="button" id="verSoltos" style="align-self:center">Ver</button></div>`);
    if (semCoord.length) avisos.push(`<div class="alert alert-warn" style="animation:none">${icon("alert")}
      <span><b>${semCoord.length} ISP(s) sem localização.</b> Sem latitude e longitude eles não aparecem no mapa de fibra.</span></div>`);
    $("#ispAvisos").innerHTML = avisos.join("");

    const ver = $("#verSoltos");
    if (ver) ver.onclick = () => listarSoltos();
  }

  function listarSoltos() {
    const soltos = semVinculo();
    modal({
      wide: true,
      labelledBy: "soltosTitulo",
      html: `
        <div class="modal-head">
          <div><span class="kicker">PARTE ISP</span>
            <h2 id="soltosTitulo" style="margin-top:6px">Equipamentos sem ISP</h2>
            <p class="muted" style="font-size:var(--fs-13);margin-top:6px">Escolha o cliente de cada um, ou exclua o que não existe mais.</p></div>
          <button class="btn btn-ghost btn-icon" data-close type="button" aria-label="Fechar">${icon("close")}</button>
        </div>
        <div class="modal-body">
          <div class="table-wrap" style="max-height:420px"><table class="table">
            <thead><tr><th>Equipamento</th><th style="min-width:220px">ISP</th><th class="num">Portas</th><th></th></tr></thead>
            <tbody>${soltos.map((e) => `<tr>
              <td><b>${esc(e.nome)}</b><br><small class="dim">${esc(e.modelo || "—")}</small></td>
              <td>
                <label class="sr-only" for="solto-${esc(e.id)}">ISP de ${esc(e.nome)}</label>
                <select class="select" id="solto-${esc(e.id)}" data-link="${esc(e.id)}"
                  ${podeVincular() ? "" : "disabled"}>${opcoesIsp(null)}</select>
              </td>
              <td class="num">${e.portas.length}</td>
              <td><button class="btn btn-sm btn-danger" type="button" data-del="${esc(e.id)}"
                ${podeExcluirEquip() ? "" : "disabled"}>Excluir</button></td>
            </tr>`).join("")}</tbody>
          </table></div>
        </div>
        <div class="modal-foot">
          <span class="dim" style="font-size:var(--fs-11)">Cada alteração é gravada e auditada na hora.</span>
          <button class="btn" data-close type="button">Fechar</button>
        </div>`,
      onMount: (host, close) => {
        $$("[data-link]", host).forEach((sel) => (sel.onchange = async () => {
          await vincular(sel.dataset.link, sel.value);
          close();
        }));
        $$("[data-del]", host).forEach((b) => (b.onclick = () => { close(); excluirEquipamento(b.dataset.del); }));
      },
    });
  }

  const opcoesIsp = (atual) =>
    `<option value="">— sem ISP —</option>` +
    NOC.pops().map((p) => `<option value="${esc(p.id)}" ${p.id === atual ? "selected" : ""}>${esc(p.nome)}</option>`).join("");

  /* ---------------- ISP: criar e editar ---------------- */
  function formIsp(alvo) {
    const novo = !alvo;
    if (!novo && !alvo) return;
    const p = alvo || { nome: "", tipo: "Cliente ISP", endereco: "", observacao: "", rotas: [] };
    const c = novo ? null : NOC.popCoords(p);
    const permitido = novo ? podeCriar() : podeEditar();

    modal({
      labelledBy: "formIspTitulo",
      html: `
        <div class="modal-head">
          <div><span class="kicker">Cadastro da PARTE ISP</span>
            <h2 id="formIspTitulo" style="margin-top:6px">${novo ? "Novo ISP" : esc(p.nome)}</h2>
            ${novo ? "" : `<p class="muted mono" style="font-size:var(--fs-12);margin-top:4px">${esc(p.id)}</p>`}</div>
          <button class="btn btn-ghost btn-icon" data-close type="button" aria-label="Fechar">${icon("close")}</button>
        </div>
        <div class="modal-body">
          <form class="stack" id="formIsp">
            <div class="row" style="gap:var(--s-3);align-items:flex-start">
              <div class="field grow"><label for="fiNome">Nome *</label>
                <input class="input" id="fiNome" value="${esc(p.nome)}" placeholder="Ex.: ISPNET" required ${permitido ? "" : "disabled"}></div>
              <div class="field" style="width:190px"><label for="fiTipo">Tipo</label>
                <select class="select" id="fiTipo" ${permitido ? "" : "disabled"}>
                  ${[...new Set([...TIPOS, tipoDe(p)])].map((t) =>
                    `<option value="${esc(t)}" ${t === tipoDe(p) ? "selected" : ""}>${esc(t)}</option>`).join("")}
                </select></div>
            </div>

            <div class="field"><label for="fiEndereco">Endereço ou referência</label>
              <input class="input" id="fiEndereco" value="${esc(p.endereco || "")}"
                placeholder="Rua, número, bairro — aparece no cabeçalho do ISP" ${permitido ? "" : "disabled"}></div>

            <hr>
            <div class="row-between">
              <h3 style="font-size:var(--fs-13)">${icon("pops")} Localização no mapa</h3>
              ${c ? `<a class="btn btn-ghost btn-sm" target="_blank" rel="noopener noreferrer"
                href="https://www.openstreetmap.org/?mlat=${encodeURIComponent(c.lat)}&mlon=${encodeURIComponent(c.lon)}#map=17/${encodeURIComponent(c.lat)}/${encodeURIComponent(c.lon)}">Ver no OpenStreetMap</a>` : ""}
            </div>
            <div class="row" style="gap:var(--s-3);align-items:flex-start">
              <div class="field grow"><label for="fiLat">Latitude</label>
                <input class="input mono" id="fiLat" inputmode="decimal" placeholder="-23.960833"
                  value="${c ? esc(GEO.fmt(c.lat)) : ""}" ${permitido ? "" : "disabled"}></div>
              <div class="field grow"><label for="fiLon">Longitude</label>
                <input class="input mono" id="fiLon" inputmode="decimal" placeholder="-46.333611"
                  value="${c ? esc(GEO.fmt(c.lon)) : ""}" ${permitido ? "" : "disabled"}></div>
            </div>
            <div class="field"><label for="fiColar">Colar coordenadas</label>
              <input class="input mono" id="fiColar" placeholder="-23.960833, -46.333611" ${permitido ? "" : "disabled"}>
              <span class="field-hint">Cole o par copiado de um mapa. Sem localização, o ISP não aparece no mapa de fibra.</span></div>

            <hr>
            <div class="field"><label for="fiRotas">Rotas (separadas por vírgula)</label>
              <input class="input" id="fiRotas" value="${esc((p.rotas || []).join(", "))}"
                placeholder="Aérea → POP PG, Subterrânea → Santos" ${permitido ? "" : "disabled"}></div>
            <div class="field"><label for="fiObs">Observação</label>
              <textarea class="textarea" id="fiObs" rows="3" ${permitido ? "" : "disabled"}>${esc(p.observacao || "")}</textarea></div>
          </form>
        </div>
        <div class="modal-foot">
          <span class="dim" style="font-size:var(--fs-11)">${permitido
            ? "A alteração vai para a auditoria com estado anterior e posterior."
            : `Seu perfil não tem a ação ${novo ? "pops.create" : "pops.edit"}.`}</span>
          <span class="row">
            <button class="btn" data-close type="button">Cancelar</button>
            <button class="btn btn-primary" type="button" data-save ${permitido ? "" : "disabled"}
              >${novo ? "Cadastrar ISP" : "Salvar"}</button>
          </span>
        </div>`,
      onMount: (host, close) => {
        const lat = $("#fiLat", host), lon = $("#fiLon", host), colar = $("#fiColar", host);
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
          const nome = $("#fiNome", host).value.trim();
          if (!nome) return $("#fiNome", host).focus();

          const temLat = lat.value.trim() !== "", temLon = lon.value.trim() !== "";
          let coords = null;
          if (temLat || temLon) {
            const n = (v) => Number(String(v).trim().replace(",", "."));
            if (!temLat || !temLon || !GEO.isCoord(n(lat.value), n(lon.value))) {
              toast("Localização inválida", {
                text: "Informe latitude (−90 a 90) e longitude (−180 a 180), ou deixe os dois campos vazios.",
                type: "warn",
              });
              return;
            }
            coords = { lat: Number(n(lat.value).toFixed(6)), lon: Number(n(lon.value).toFixed(6)) };
          }

          const valores = {
            nome,
            tipo: $("#fiTipo", host).value,
            endereco: $("#fiEndereco", host).value.trim(),
            observacao: $("#fiObs", host).value.trim(),
            rotas: $("#fiRotas", host).value.split(",").map((s) => s.trim()).filter(Boolean),
            lat: coords ? coords.lat : null,
            lon: coords ? coords.lon : null,
          };

          const t = NOC.data();
          if (novo) {
            const id = NOC.novoId("isp", nome, t.pops);
            const criado = { id, ...valores, equipamentos: [] };
            if (!criado.lat) { delete criado.lat; delete criado.lon; }
            t.pops.push(criado);
            close();
            state.foco = id;
            const ok = await persist("TOPOLOGY_CREATE_POP", {
              titulo: `${nome} cadastrado`,
              texto: coords
                ? `Já aparece no mapa de fibra em ${GEO.label(coords.lat, coords.lon)}.`
                : "Cadastre a localização para vê-lo no mapa de fibra.",
            }, async () => {
              t.pops = t.pops.filter((x) => x.id !== id);
              await persist("TOPOLOGY_DELETE_POP", { titulo: "Cadastro desfeito", tipo: "info" });
            });
            if (!ok) t.pops = t.pops.filter((x) => x.id !== id);
            return;
          }

          const antes = {
            nome: p.nome, tipo: p.tipo, endereco: p.endereco ?? "", observacao: p.observacao ?? "",
            rotas: [...(p.rotas || [])], lat: p.lat ?? null, lon: p.lon ?? null,
          };
          const aplicar = (v) => {
            Object.assign(p, v);
            // Coordenada ausente não fica gravada como null no cadastro.
            if (p.lat === null || p.lat === undefined) { delete p.lat; delete p.lon; }
            if (!p.endereco) delete p.endereco;
            if (!p.observacao) delete p.observacao;
          };
          aplicar(valores);
          close();
          const ok = await persist("TOPOLOGY_UPDATE_POP", { titulo: `${nome} atualizado` },
            async () => {
              aplicar(antes);
              await persist("TOPOLOGY_UPDATE_POP", { titulo: "Cadastro anterior restaurado", tipo: "info" });
            });
          if (!ok) aplicar(antes);
        };
      },
    });
  }

  /* ---------------- ISP: excluir ----------------
     Excluir um ISP com equipamento dentro tem duas saídas possíveis, e escolher
     por conta própria seria decidir no lugar do operador: ou os equipamentos
     ficam na PARTE ISP sem vínculo, ou vão junto. As duas ficam no diálogo. */
  function excluirIsp(p) {
    if (!p) return;
    const list = NOC.devicesOfPop(p.id);
    const remover = async (comEquipamentos) => {
      const t = NOC.data();
      const posicao = t.pops.findIndex((x) => x.id === p.id);
      if (posicao < 0) return;

      const equipAntes = list.map((e) => ({ e, popId: e.popId ?? null, local: e.local ?? "" }));
      const conexoesAntes = [...t.conexoes];
      const equipamentosAntes = [...t.equipamentos];

      t.pops.splice(posicao, 1);
      if (comEquipamentos) {
        const ids = new Set(list.map((e) => e.id));
        t.equipamentos = t.equipamentos.filter((e) => !ids.has(e.id));
        t.conexoes = t.conexoes.filter((c) => !ids.has(c.origem) && !ids.has(c.destino));
      } else {
        // Sem o `local` antigo, nada devolve o equipamento a um ISP que não existe mais.
        list.forEach((e) => { e.popId = null; e.local = ""; });
      }

      const restaurar = () => {
        t.pops.splice(posicao, 0, p);
        t.equipamentos = equipamentosAntes;
        t.conexoes = conexoesAntes;
        equipAntes.forEach(({ e, popId, local }) => { e.popId = popId; e.local = local; });
      };

      const ok = await persist("TOPOLOGY_DELETE_POP", {
        titulo: `${p.nome} removido`,
        texto: comEquipamentos
          ? `${list.length} equipamento(s) e os enlaces deles saíram junto.`
          : list.length ? `${list.length} equipamento(s) ficaram sem ISP.` : "",
        tipo: "warn",
      }, async () => {
        restaurar();
        await persist("TOPOLOGY_CREATE_POP", { titulo: "Cadastro restaurado", tipo: "info" });
      });
      if (!ok) restaurar();
    };

    if (!list.length) {
      askConfirm({
        title: `Excluir ${p.nome}?`,
        text: "O cadastro sai da PARTE ISP para todos os usuários. A ação fica na auditoria e pode ser desfeita pelo aviso.",
        confirmLabel: "Excluir ISP",
        danger: true,
        onConfirm: () => remover(false),
      });
      return;
    }

    /* Conjunto, e não soma: um enlace entre dois equipamentos do mesmo ISP
       aparece nas duas pontas e seria contado duas vezes. */
    const enlaces = new Set(list.flatMap((e) => NOC.connectionsOf(e.id))).size;
    modal({
      labelledBy: "delIspTitulo",
      html: `
        <div class="modal-head">
          <div><span class="kicker">Exclusão na PARTE ISP</span>
            <h2 id="delIspTitulo" style="margin-top:6px">Excluir ${esc(p.nome)}?</h2>
            <p class="muted" style="font-size:var(--fs-13);margin-top:6px">
              Este ISP tem <b>${list.length} equipamento(s)</b>${enlaces ? ` e <b>${enlaces} enlace(s)</b> documentado(s)` : ""}.
              Escolha o que fazer com eles.</p></div>
          <button class="btn btn-ghost btn-icon" data-close type="button" aria-label="Fechar">${icon("close")}</button>
        </div>
        <div class="modal-body stack">
          <div class="card" style="padding:var(--s-3)">
            <b style="font-size:var(--fs-13)">Manter os equipamentos</b>
            <p class="dim" style="font-size:var(--fs-12);margin-top:4px">
              Eles continuam na PARTE ISP, sem ISP vinculado, e podem ser ligados a outro cliente depois.
              Os enlaces são preservados.</p>
          </div>
          <div class="card" style="padding:var(--s-3);border-color:var(--danger-500)">
            <b style="font-size:var(--fs-13)">Excluir tudo junto</b>
            <p class="dim" style="font-size:var(--fs-12);margin-top:4px">
              Os ${list.length} equipamento(s)${enlaces ? ` e os ${enlaces} enlace(s) deles` : ""} saem da topologia
              junto com o ISP. Exige a ação topology.equipment.delete.</p>
          </div>
        </div>
        <div class="modal-foot">
          <button class="btn" data-close type="button">Cancelar</button>
          <span class="row">
            <button class="btn btn-danger" type="button" data-so-isp>Excluir só o ISP</button>
            <button class="btn btn-danger" type="button" data-tudo
              ${podeExcluirEquip() ? "" : "disabled title='Requer as ações topology.delete + topology.equipment.delete'"}
              >Excluir ISP e equipamentos</button>
          </span>
        </div>`,
      onMount: (host, close) => {
        $("[data-so-isp]", host).onclick = () => { close(); remover(false); };
        $("[data-tudo]", host).onclick = () => { close(); remover(true); };
      },
    });
  }

  /* ---------------- equipamentos ---------------- */
  /* O campo `local` é o cadastro antigo de onde sai a sugestão automática de
     ISP. Desvincular sem limpá-lo devolveria o equipamento ao mesmo ISP pela
     sugestão, e a tela pareceria não ter feito nada; vincular sem preenchê-lo
     deixaria as duas informações se contradizendo. */
  async function vincular(deviceId, popId) {
    const e = equipamentos().find((x) => x.id === deviceId);
    if (!e) return;
    const antes = { popId: e.popId ?? null, local: e.local ?? "" };
    e.popId = popId || null;
    e.local = popId ? (registro(popId)?.nome || "") : "";
    if (popId) state.foco = popId;
    await persist(
      popId ? "TOPOLOGY_LINK_POP" : "TOPOLOGY_UNLINK_POP",
      {
        titulo: popId ? `${e.nome} vinculado a ${registro(popId)?.nome || ""}` : `${e.nome} desvinculado`,
        texto: popId ? "Ele passa a contar na ocupação desse ISP." : "Ele sai da ocupação do ISP e fica sem vínculo.",
        tipo: popId ? "ok" : "warn",
      },
      async () => {
        Object.assign(e, antes);
        await persist("TOPOLOGY_LINK_POP", { titulo: "Vínculo revertido", tipo: "info" });
      }
    );
  }

  function abrirVinculo(popId) {
    const p = registro(popId);
    const soltos = semVinculo();
    if (!p) return;
    if (!soltos.length) {
      toast("Nenhum equipamento livre", {
        text: "Todo equipamento da PARTE ISP já está vinculado. Use “Novo equipamento” para cadastrar outro.",
        type: "info",
      });
      return;
    }
    modal({
      labelledBy: "vincTitulo",
      html: `
        <div class="modal-head">
          <div><span class="kicker">${esc(p.nome)}</span>
            <h2 id="vincTitulo" style="margin-top:6px">Vincular equipamento</h2>
            <p class="muted" style="font-size:var(--fs-13);margin-top:6px">Equipamentos da PARTE ISP que ainda não têm cliente.</p></div>
          <button class="btn btn-ghost btn-icon" data-close type="button" aria-label="Fechar">${icon("close")}</button>
        </div>
        <div class="modal-body">
          <div class="stack" style="gap:var(--s-2)">
            ${soltos.map((e) => `<button class="device-item" type="button" data-pick="${esc(e.id)}">
              <span class="row-between"><b>${esc(e.nome)}</b><span class="badge">${e.portas.length} portas</span></span>
              <small>${esc(e.modelo || "Modelo não informado")} • ${esc(e.categoria || "Equipamento")}</small>
            </button>`).join("")}
          </div>
        </div>
        <div class="modal-foot">
          <span class="dim" style="font-size:var(--fs-11)">O vínculo é gravado na hora.</span>
          <button class="btn" data-close type="button">Cancelar</button>
        </div>`,
      onMount: (host, close) => {
        $$("[data-pick]", host).forEach((b) => (b.onclick = () => { close(); vincular(b.dataset.pick, popId); }));
      },
    });
  }

  /* ---------- OLT: detecção e estrutura de portas ---------- */
  function isOLT(equipamento) {
    const cat = String(equipamento?.categoria || "").toLowerCase();
    return cat.includes("olt") || cat === "olts" || cat === "gpon";
  }

  function gerarPortasOLT() {
    const portas = [];
    let numero = 1;

    // 17 placas de tráfego GBIC/GPON com 16 portas cada (slots 1-17)
    for (let slot = 1; slot <= 17; slot++) {
      for (let porta = 1; porta <= 16; porta++) {
        portas.push({
          numero: numero++,
          slot,
          subslot: porta,
          tipoPlaca: "Linha",
          tecnologia: "GBIC/GPON",
          capacidade: "1.25 / 2.5 Gbps",
          tipo: "SFP",
          status: "livre",
        });
      }
    }

    // 2 placas de gerência com 4 portas ópticas + 3 portas RJ45 cada (slots 18-19)
    for (let slot = 18; slot <= 19; slot++) {
      // 4 portas ópticas de gerência
      for (let porta = 1; porta <= 4; porta++) {
        portas.push({
          numero: numero++,
          slot,
          subslot: porta,
          tipoPlaca: "Gerência",
          tecnologia: "Óptica",
          capacidade: "1 Gbps",
          tipo: "SFP",
          status: "livre",
        });
      }
      // 3 portas RJ45 de gerência
      for (let porta = 5; porta <= 7; porta++) {
        portas.push({
          numero: numero++,
          slot,
          subslot: porta,
          tipoPlaca: "Gerência",
          tecnologia: "Elétrica",
          capacidade: "1 Gbps",
          tipo: "RJ45",
          status: "livre",
        });
      }
    }

    // 1 placa uplink com 2 portas ópticas XG + 2 portas ópticas G2 (slot 20)
    const slot = 20;
    for (let porta = 1; porta <= 2; porta++) {
      portas.push({
        numero: numero++,
        slot,
        subslot: porta,
        tipoPlaca: "Uplink",
        tecnologia: "10G",
        capacidade: "10 Gbps",
        tipo: "SFP+",
        status: "livre",
      });
    }
    for (let porta = 3; porta <= 4; porta++) {
      portas.push({
        numero: numero++,
        slot,
        subslot: porta,
        tipoPlaca: "Uplink",
        tecnologia: "2.5G",
        capacidade: "2.5 Gbps",
        tipo: "SFP",
        status: "livre",
      });
    }

    return portas;
  }

  function formEquipamento(deviceId, popId = null) {
    const e = deviceId ? equipamentos().find((x) => x.id === deviceId) : null;
    const novo = !e;
    const permitido = novo ? podeCriarEquip() : podeEditarEquip();
    const portasAtuais = e ? e.portas.length : 24;
    const isOltEquip = e ? isOLT(e) : false;

    modal({
      labelledBy: "formEqTitulo",
      html: `
        <div class="modal-head">
          <div><span class="kicker">Equipamento da PARTE ISP</span>
            <h2 id="formEqTitulo" style="margin-top:6px">${novo ? "Novo equipamento" : esc(e.nome)}</h2>
            ${novo ? "" : `<p class="muted mono" style="font-size:var(--fs-12);margin-top:4px">${esc(e.id)}</p>`}</div>
          <button class="btn btn-ghost btn-icon" data-close type="button" aria-label="Fechar">${icon("close")}</button>
        </div>
        <div class="modal-body">
          <form class="stack" id="formEq">
            <div class="row" style="gap:var(--s-3);align-items:flex-start">
              <div class="field grow"><label for="feNome">Nome *</label>
                <input class="input" id="feNome" value="${esc(e?.nome || "")}" required ${permitido ? "" : "disabled"}></div>
              <div class="field grow"><label for="feModelo">Modelo</label>
                <input class="input" id="feModelo" value="${esc(e?.modelo || "")}" ${permitido ? "" : "disabled"}></div>
            </div>
            <div class="row" style="gap:var(--s-3);align-items:flex-start">
              <div class="field grow"><label for="feCat">Categoria</label>
                <input class="input" id="feCat" value="${esc(e?.categoria || "")}" placeholder="Ex.: Acesso, OLT" ${permitido ? "" : "disabled"}></div>
              <div class="field grow"><label for="feIsp">ISP vinculado</label>
                <select class="select" id="feIsp" ${permitido ? "" : "disabled"}>${opcoesIsp(e ? NOC.effectivePop(e) : popId)}</select></div>
              <div class="field" style="width:130px"><label for="fePortas">Portas</label>
                <input class="input" id="fePortas" type="number" min="1" max="512" value="${portasAtuais}" ${permitido ? "" : "disabled"}></div>
            </div>
            <div class="field"><label for="feObs">Observação</label>
              <textarea class="textarea" id="feObs" rows="3" ${permitido ? "" : "disabled"}>${esc(e?.observacao || "")}</textarea></div>
            ${novo ? '<span class="field-hint">As portas nascem livres, com capacidade “A confirmar”.</span>' : ""}
            ${!novo && isOltEquip ? `
              <div class="card" style="margin-top:var(--s-3);padding:var(--s-3)">
                <div class="row-between" style="margin-bottom:var(--s-2)">
                  <h3 style="font-size:var(--fs-13)">${icon("port")} Gerenciamento de portas OLT</h3>
                  <span class="dim mono" style="font-size:var(--fs-11)">${e.portas.length} portas em ${Math.max(...e.portas.map(p => p.slot || 1))} slots</span>
                </div>
                <button class="btn btn-primary btn-sm" type="button" id="btnGerenciarPortasOLT">
                  ${icon("edit")} Gerenciar portas OLT
                </button>
              </div>
            ` : ""}
          </form>
        </div>
        <div class="modal-foot">
          <span class="dim" style="font-size:var(--fs-11)">${permitido
            ? "A alteração é auditada com usuário, IP e data/hora."
            : `Seu perfil não tem a ação topology.equipment.${novo ? "create" : "edit"}.`}</span>
          <span class="row">
            <button class="btn" data-close type="button">Cancelar</button>
            <button class="btn btn-primary" type="button" data-save ${permitido ? "" : "disabled"}
              >${novo ? "Cadastrar equipamento" : "Salvar"}</button>
          </span>
        </div>`,
      onMount: (host, close) => {
        $("[data-save]", host).onclick = async () => {
          const nome = $("#feNome", host).value.trim();
          if (!nome) return $("#feNome", host).focus();
          const total = Math.max(1, Math.min(512, Number($("#fePortas", host).value) || portasAtuais));
          const destino = $("#feIsp", host).value || null;
          const valores = {
            nome,
            modelo: $("#feModelo", host).value.trim(),
            categoria: $("#feCat", host).value.trim() || "Equipamento",
            observacao: $("#feObs", host).value.trim(),
            popId: destino,
            local: destino ? (registro(destino)?.nome || "") : "",
          };

          const t = NOC.data();
          if (novo) {
            let portasIniciais;
            const cat = valores.categoria.toLowerCase();
            if (cat.includes("olt") || cat === "olts" || cat === "gpon") {
              portasIniciais = gerarPortasOLT();
            } else {
              portasIniciais = Array.from({ length: total }, (_, i) => ({
                numero: i + 1, capacidade: "A confirmar", tipo: "A confirmar", status: "livre",
              }));
            }
            const criado = {
              id: NOC.novoId("eq", nome, t.equipamentos),
              ...valores,
              portas: portasIniciais,
            };
            t.equipamentos.push(criado);
            close();
            state.foco = destino;
            const ok = await persist("TOPOLOGY_CREATE_EQUIPAMENTO", {
              titulo: "Equipamento cadastrado",
              texto: `${nome} entrou na PARTE ISP com ${portasIniciais.length} portas.`,
            }, async () => {
              t.equipamentos = t.equipamentos.filter((x) => x.id !== criado.id);
              await persist("TOPOLOGY_DELETE_EQUIPAMENTO", { titulo: "Cadastro desfeito", tipo: "info" });
            });
            if (!ok) t.equipamentos = t.equipamentos.filter((x) => x.id !== criado.id);
            return;
          }

          /* Reduzir a quantidade de portas apagaria as que estão em uso: as
             ocupadas ficam, e o aviso diz o que não coube. */
          const emUso = e.portas.filter((porta) => NOC.portaEmUso(e.id, porta.numero));
          const maiorEmUso = emUso.length ? Math.max(...emUso.map((porta) => Number(porta.numero))) : 0;
          const alvo = Math.max(total, maiorEmUso);

          const antes = {
            nome: e.nome, modelo: e.modelo ?? "", categoria: e.categoria ?? "",
            observacao: e.observacao ?? "", popId: e.popId ?? null, local: e.local ?? "",
            portas: e.portas.map((porta) => ({ ...porta })),
          };
          const aplicar = (v) => {
            Object.assign(e, v);
            if (!Array.isArray(e.portas)) e.portas = [];
          };
          const portas = [];
          for (let i = 1; i <= alvo; i++) {
            portas.push(e.portas.find((porta) => Number(porta.numero) === i)
              || { numero: i, capacidade: "A confirmar", tipo: "A confirmar", status: "livre" });
          }
          aplicar({ ...valores, portas });
          close();
          if (alvo > total) {
            toast("Portas em uso preservadas", {
              text: `O equipamento ficou com ${alvo} portas: a porta ${maiorEmUso} tem enlace documentado.`,
              type: "warn",
            });
          }
          const ok = await persist("TOPOLOGY_UPDATE_EQUIPAMENTO", { titulo: `${nome} atualizado` },
            async () => {
              aplicar(antes);
              await persist("TOPOLOGY_UPDATE_EQUIPAMENTO", { titulo: "Cadastro anterior restaurado", tipo: "info" });
            });
          if (!ok) aplicar(antes);
        };

        // Botão para gerenciar portas OLT
        const btnOlt = $("#btnGerenciarPortasOLT", host);
        if (btnOlt) {
          btnOlt.onclick = () => {
            close();
            formGerenciarPortasOLT(e);
          };
        }
      },
    });
  }

  /* ---------- OLT: Gerenciamento modular de portas ---------- */
  function formGerenciarPortasOLT(equipamento) {
    const permitido = podeEditarEquip();
    let portas = [...equipamento.portas].sort((a, b) => Number(a.numero) - Number(b.numero));

    // Agrupar por slot/placa
    const porSlot = {};
    for (const porta of portas) {
      const slot = porta.slot || 1;
      if (!porSlot[slot]) porSlot[slot] = { portas: [], tipoPlaca: porta.tipoPlaca || "Desconhecido", tecnologia: porta.tecnologia || "" };
      porSlot[slot].portas.push(porta);
    }

    const slotsOrdenados = Object.keys(porSlot).map(Number).sort((a, b) => a - b);

    function renderPortasOLT() {
      const container = $("#oltPortasContainer");
      if (!container) return;

      container.innerHTML = slotsOrdenados.map(slot => {
        const slotData = porSlot[slot];
        const portaHtml = slotData.portas.map(p => {
          const emUso = NOC.portaEmUso(equipamento.id, p.numero);
          const statusClass = emUso ? "status-em-uso" : (p.status === "livre" ? "status-livre" : "status-" + (p.status || "livre"));
          return `
            <div class="olt-porta ${statusClass}" data-numero="${p.numero}" data-slot="${slot}" data-subslot="${p.subslot}">
              <span class="porta-numero">P${p.subslot}</span>
              <span class="porta-tipo">${p.tipo}</span>
              <span class="porta-capacidade">${p.capacidade}</span>
              <span class="porta-status">${emUso ? "Em uso" : (p.status || "livre")}</span>
              <input type="hidden" name="porta_${p.numero}_capacidade" value="${esc(p.capacidade)}">
              <input type="hidden" name="porta_${p.numero}_tipo" value="${esc(p.tipo)}">
              <input type="hidden" name="porta_${p.numero}_status" value="${esc(p.status || "livre")}">
            </div>
          `;
        }).join("");

        return `
          <div class="olt-slot" data-slot="${slot}">
            <div class="olt-slot-header">
              <span class="slot-numero">Slot ${slot}</span>
              <span class="slot-tipo">${esc(slotData.tipoPlaca)}</span>
              <span class="slot-tecnologia">${esc(slotData.tecnologia)}</span>
              <span class="slot-qtd">${slotData.portas.length} portas</span>
            </div>
            <div class="olt-slot-portas">${portaHtml}</div>
          </div>
        `;
      }).join("");

      // Bind click events for port editing
      $$(".olt-porta", container).forEach(el => {
        el.onclick = (ev) => {
          if (ev.target.tagName === "INPUT") return;
          editarPortaOLT(equipamento, Number(el.dataset.numero), el);
        };
      });
    }

    modal({
      labelledBy: "oltPortasTitulo",
      wide: true,
      html: `
        <div class="modal-head">
          <div><span class="kicker">${icon("port")} OLT Modular</span>
            <h2 id="oltPortasTitulo" style="margin-top:6px">${esc(equipamento.nome)} — Gerenciamento de Portas</h2>
            <p class="muted mono" style="font-size:var(--fs-12);margin-top:4px">${esc(equipamento.id)} • ${portas.length} portas em ${slotsOrdenados.length} slots</p></div>
          <button class="btn btn-ghost btn-icon" data-close type="button" aria-label="Fechar">${icon("close")}</button>
        </div>
        <div class="modal-body" style="max-height:60vh;overflow:auto">
          <div class="olt-portas-toolbar">
            <div class="row wrap" style="gap:var(--s-2);flex:1">
              <div class="input-affix" style="min-width:200px">
                <span class="affix-icon">${icon("search")}</span>
                <input class="input" id="oltPortaBusca" type="search" placeholder="Buscar porta, slot, tipo…" aria-label="Buscar porta">
              </div>
              <select class="select" id="oltFiltroSlot" style="width:160px">
                <option value="">Todos os slots</option>
                ${slotsOrdenados.map(s => `<option value="${s}">Slot ${s} — ${esc(porSlot[s].tipoPlaca)}</option>`).join("")}
              </select>
              <select class="select" id="oltFiltroStatus" style="width:140px">
                <option value="">Todos os status</option>
                <option value="livre">Livre</option>
                <option value="em_uso">Em uso</option>
              </select>
            </div>
            <div class="olt-portas-legenda">
              <span class="legenda-item"><i class="dot dot-ok"></i>Livre</span>
              <span class="legenda-item"><i class="dot" style="background:var(--yellow-400)"></i>Em uso</span>
            </div>
          </div>
          <div class="olt-portas-grid" id="oltPortasContainer"></div>
        </div>
        <div class="modal-foot">
          <span class="dim" style="font-size:var(--fs-11)">Clique em uma porta para editar capacidade, tipo ou status. Portas em uso não podem ter tipo/capacidade alterados.</span>
          <span class="row">
            <button class="btn btn-primary" type="button" id="oltSalvarPortas">${icon("check")} Salvar alterações</button>
            <button class="btn" data-close type="button">Fechar</button>
          </span>
        </div>`,
      onMount: (host, close) => {
        renderPortasOLT();

        // Filtros
        const busca = $("#oltPortaBusca", host);
        const filtroSlot = $("#oltFiltroSlot", host);
        const filtroStatus = $("#oltFiltroStatus", host);

        function aplicarFiltros() {
          const termo = busca.value.toLowerCase().trim();
          const slotSel = filtroSlot.value;
          const statusSel = filtroStatus.value;

          $$(".olt-porta", host).forEach(el => {
            const porta = portas.find(p => p.numero === Number(el.dataset.numero));
            if (!porta) return;

            let mostrar = true;
            if (termo) {
              const texto = `${porta.slot} ${porta.subslot} ${porta.tipo} ${porta.capacidade} ${porta.tipoPlaca} ${porta.tecnologia}`.toLowerCase();
              mostrar = texto.includes(termo);
            }
            if (mostrar && slotSel) mostrar = String(porta.slot) === slotSel;
            if (mostrar && statusSel) {
              const emUso = NOC.portaEmUso(equipamento.id, porta.numero);
              if (statusSel === "livre") mostrar = !emUso;
              if (statusSel === "em_uso") mostrar = emUso;
            }
            el.style.display = mostrar ? "" : "none";
          });

          // Esconder slots vazios
          $$(".olt-slot", host).forEach(slotEl => {
            const visiveis = $$(".olt-porta", slotEl).filter(el => el.style.display !== "none").length;
            slotEl.style.display = visiveis > 0 ? "" : "none";
          });
        }

        busca.addEventListener("input", aplicarFiltros);
        filtroSlot.addEventListener("change", aplicarFiltros);
        filtroStatus.addEventListener("change", aplicarFiltros);

        // Salvar
        $("#oltSalvarPortas", host).onclick = async () => {
          // Atualizar portas do equipamento com valores dos inputs hidden
          const novasPortas = portas.map(p => {
            const capInput = $(`input[name="porta_${p.numero}_capacidade"]`, host);
            const tipoInput = $(`input[name="porta_${p.numero}_tipo"]`, host);
            const statusInput = $(`input[name="porta_${p.numero}_status"]`, host);
            return {
              ...p,
              capacidade: capInput?.value || p.capacidade,
              tipo: tipoInput?.value || p.tipo,
              status: statusInput?.value || p.status,
            };
          });

          const antes = { ...equipamento, portas: equipamento.portas.map(p => ({ ...p })) };
          equipamento.portas = novasPortas;

          const ok = await persist("TOPOLOGY_UPDATE_EQUIPAMENTO", {
            titulo: `Portas OLT atualizadas: ${equipamento.nome}`,
            texto: `${novasPortas.length} portas organizadas em ${slotsOrdenados.length} slots.`,
          }, async () => {
            Object.assign(equipamento, antes);
            await persist("TOPOLOGY_UPDATE_EQUIPAMENTO", { titulo: "Alterações revertidas", tipo: "info" });
          });

          if (ok) close();
        };
      },
    });
  }

  function editarPortaOLT(equipamento, numeroPorta, elemento) {
    const porta = equipamento.portas.find(p => p.numero === numeroPorta);
    if (!porta) return;

    const emUso = NOC.portaEmUso(equipamento.id, numeroPorta);

    // Os inputs hidden estão dentro do próprio elemento .olt-porta
    const hiddenCap = elemento.querySelector(`input[name="porta_${numeroPorta}_capacidade"]`);
    const hiddenTipo = elemento.querySelector(`input[name="porta_${numeroPorta}_tipo"]`);
    const hiddenStatus = elemento.querySelector(`input[name="porta_${numeroPorta}_status"]`);

    modal({
      labelledBy: "oltPortaEditarTitulo",
      html: `
        <div class="modal-head">
          <div><span class="kicker">${icon("port")} Porta OLT</span>
            <h2 id="oltPortaEditarTitulo" style="margin-top:6px">${esc(equipamento.nome)} — Slot ${porta.slot} / Porta ${porta.subslot} (Nº ${porta.numero})</h2>
            ${emUso ? '<span class="badge badge-warn" style="margin-top:6px">Porta em uso — capacidade e tipo bloqueados</span>' : ""}</div>
          <button class="btn btn-ghost btn-icon" data-close type="button" aria-label="Fechar">${icon("close")}</button>
        </div>
        <div class="modal-body">
          <form class="stack" id="formOltPorta">
            <div class="row" style="gap:var(--s-3)">
              <div class="field grow"><label>Tipo da placa</label>
                <input class="input" value="${esc(porta.tipoPlaca)}" readonly></div>
              <div class="field grow"><label>Tecnologia</label>
                <input class="input" value="${esc(porta.tecnologia)}" readonly></div>
            </div>
            <div class="row" style="gap:var(--s-3)">
              <div class="field grow"><label for="oltPortaCapacidade">Capacidade</label>
                <input class="input" id="oltPortaCapacidade" value="${esc(porta.capacidade)}" ${emUso ? "readonly" : ""}></div>
              <div class="field grow"><label for="oltPortaTipo">Tipo de conector</label>
                <select class="select" id="oltPortaTipo" ${emUso ? "disabled" : ""}>
                  <option value="SFP" ${porta.tipo === "SFP" ? "selected" : ""}>SFP</option>
                  <option value="SFP+" ${porta.tipo === "SFP+" ? "selected" : ""}>SFP+</option>
                  <option value="QSFP28" ${porta.tipo === "QSFP28" ? "selected" : ""}>QSFP28</option>
                  <option value="RJ45" ${porta.tipo === "RJ45" ? "selected" : ""}>RJ45</option>
                  <option value="XFP" ${porta.tipo === "XFP" ? "selected" : ""}>XFP</option>
                </select></div>
            </div>
            <div class="field"><label for="oltPortaStatus">Status administrativo</label>
              <select class="select" id="oltPortaStatus">
                <option value="livre" ${porta.status === "livre" ? "selected" : ""}>Livre</option>
                <option value="reservada" ${porta.status === "reservada" ? "selected" : ""}>Reservada</option>
                <option value="manutencao" ${porta.status === "manutencao" ? "selected" : ""}>Em manutenção</option>
                <option value="bloqueada" ${porta.status === "bloqueada" ? "selected" : ""}>Bloqueada</option>
              </select></div>
            ${emUso ? '<div class="alert alert-info" style="margin-top:var(--s-2)"><small>Esta porta possui enlace documentado. Capacidade e tipo não podem ser alterados para preservar a integridade da topologia.</small></div>' : ""}
          </form>
        </div>
        <div class="modal-foot">
          <span class="row">
            <button class="btn" data-close type="button">Cancelar</button>
            <button class="btn btn-primary" type="button" id="oltPortaSalvar" ${emUso ? "" : ""}>Salvar</button>
          </span>
        </div>`,
      onMount: (host, close) => {
        $("#oltPortaSalvar", host).onclick = () => {
          const capInput = $("#oltPortaCapacidade", host);
          const tipoInput = $("#oltPortaTipo", host);
          const statusInput = $("#oltPortaStatus", host);

          // Atualizar inputs hidden na grid principal (estão no elemento .olt-porta)
          if (hiddenCap) hiddenCap.value = capInput.value;
          if (hiddenTipo) hiddenTipo.value = tipoInput.value;
          if (hiddenStatus) hiddenStatus.value = statusInput.value;

          // Atualizar display visual
          const capEl = elemento.querySelector(".porta-capacidade");
          const tipoEl = elemento.querySelector(".porta-tipo");
          const statusEl = elemento.querySelector(".porta-status");
          if (capEl) capEl.textContent = capInput.value;
          if (tipoEl) tipoEl.textContent = tipoInput.value;
          if (statusEl) statusEl.textContent = statusInput.value === "livre" ? "Livre" : statusInput.value;

          close();
        };
      },
    });
  }

  /* Excluir o equipamento leva junto os enlaces documentados nele: deixá-los
     para trás criaria conexão apontando para equipamento que não existe mais. */
  function excluirEquipamento(deviceId) {
    const t = NOC.data();
    const e = t.equipamentos.find((x) => x.id === deviceId);
    if (!e) return;
    const enlaces = NOC.connectionsOf(e.id).length;

    askConfirm({
      title: `Excluir ${e.nome}?`,
      text: enlaces
        ? `O equipamento e os ${enlaces} enlace(s) documentados nele saem da PARTE ISP. A ação pode ser desfeita pelo aviso.`
        : "O equipamento sai da PARTE ISP. A ação pode ser desfeita pelo aviso.",
      confirmLabel: "Excluir equipamento",
      danger: true,
      onConfirm: async () => {
        const posicao = t.equipamentos.findIndex((x) => x.id === deviceId);
        const conexoesAntes = [...t.conexoes];
        t.equipamentos.splice(posicao, 1);
        t.conexoes = t.conexoes.filter((c) => c.origem !== deviceId && c.destino !== deviceId);

        const restaurar = () => {
          t.equipamentos.splice(posicao, 0, e);
          t.conexoes = conexoesAntes;
        };
        const ok = await persist("TOPOLOGY_DELETE_EQUIPAMENTO", {
          titulo: `${e.nome} removido`,
          texto: enlaces ? `${enlaces} enlace(s) saíram junto.` : "",
          tipo: "warn",
        }, async () => {
          restaurar();
          await persist("TOPOLOGY_CREATE_EQUIPAMENTO", { titulo: "Equipamento restaurado", tipo: "info" });
        });
        if (!ok) restaurar();
      },
    });
  }

  /* ---------------- abertura ---------------- */
  /* Modo embutido: quando esta tela roda dentro da Topologia ISP (a aba
     "Lista" de isp.html), o shell e o carregamento já foram feitos pelo
     noc-topology.js. Este arquivo então só liga os controles do cadastro e
     expõe a renderização para a topologia chamar ao trocar de modo — sem
     montar um segundo shell nem buscar a topologia duas vezes. */
  const embutido = () => !!document.querySelector("#listView") && !!document.querySelector("#ispList");

  function ligarControles() {
    NOC.applyActions(document);
    const iconEl = $("#ispIconSearch") || $("#iconSearch");
    if (iconEl) iconEl.innerHTML = icon("search");
    const novo = $("#btnNovoIsp");
    if (novo) {
      novo.innerHTML = icon("plus") + " Novo ISP";
      novo.onclick = () => formIsp(null);
    }
    const busca = $("#ispBusca");
    if (busca) busca.addEventListener("input", (ev) => {
      state.busca = ev.target.value.trim();
      render();
    });
    const limpar = $("#ispLimpar");
    if (limpar) limpar.onclick = () => {
      state.busca = ""; state.tipo = "";
      busca.value = "";
      render();
    };
  }

  async function boot() {
    if (embutido()) {
      /* A topologia já carregou (ou está carregando) os dados e chama
         ISP_CADASTRO.render() assim que termina — renderizar aqui com a
         topologia ainda no ar mostraria um vazio que some em seguida. */
      ligarControles();
      state.foco = new URLSearchParams(location.search).get("pop");
      window.ISP_CADASTRO = { render };
      if (NOC.data()) render();
      return;
    }

    UI.mountShell({
      search: () => {
        if (!NOC.data()) return [];
        return [
          ...NOC.pops().map((p) => ({
            group: "ISPs", label: p.nome, icon: "pops",
            hint: `${tipoDe(p)} • ${NOC.devicesOfPop(p.id).length} equipamento(s)`,
            run: () => { state.foco = p.id; render(); },
          })),
          ...equipamentos().map((e) => ({
            group: "Equipamentos", label: e.nome, icon: "port",
            hint: `${e.modelo || ""} • ${e.portas.length} portas`,
            run: () => formEquipamento(e.id),
          })),
        ];
      },
    });

    NOC.skeleton($("#ispList"), 4);

    try {
      await NOC.load();
    } catch (err) {
      NOC.errorState($("#ispList"), err, () => location.reload());
      toast("Falha ao carregar o cadastro", { text: err.message, type: "danger", timeout: 8000 });
      return;
    }

    ligarControles();
    state.foco = new URLSearchParams(location.search).get("pop");
    render();
  }

  boot();
})();
