/* ============================================================
   UPDOWN NOC — Cadastro de Locais
   CRUD do cadastro único de local (POP, Data Center ou ISP). É a
   mesma tabela que /api/topology lê e grava por baixo do mapa: um
   local criado, editado ou excluído aqui aparece nos mapas, e
   vice-versa.
   ============================================================ */
(() => {
  "use strict";
  const { $, $$, esc, icon, toast, modal, confirm: askConfirm } = UI;

  const corpo = $("#localListBody");
  const ehTela = !!corpo;

  const state = { registros: [], q: "", tipo: "todos" };
  const TIPOS = ["POP", "Data Center", "ISP"];

  let acessoPronto = false;
  const acesso = NOC.loadAccess()
    .then(() => { acessoPronto = true; NOC.applyActions(document); })
    .catch(() => {});
  const aplicarAcoes = (host) => { if (acessoPronto) NOC.applyActions(host); };
  async function pode(codigo) { await acesso; return NOC.can(codigo); }

  async function carregar() {
    if (!ehTela) return;
    try {
      const dados = await NOC.api("/api/locais");
      state.registros = Array.isArray(dados.registros) ? dados.registros : [];
    } catch { state.registros = []; }
    renderTipo();
    renderLista();
  }

  function filtrados() {
    const q = state.q.trim().toLowerCase();
    return state.registros.filter((r) => {
      if (state.tipo !== "todos" && r.tipo !== state.tipo) return false;
      if (!q) return true;
      return [r.nome, r.endereco, r.id].join(" ").toLowerCase().includes(q);
    });
  }

  function renderTipo() {
    const host = $("#localTipo");
    if (!host) return;
    const contar = (tipo) => tipo === "todos" ? state.registros.length : state.registros.filter((r) => r.tipo === tipo).length;
    host.innerHTML = [["todos", "Todos"], ...TIPOS.map((t) => [t, t])]
      .map(([valor, rotulo]) => `
        <button class="chip" type="button" data-tipo="${esc(valor)}" aria-pressed="${state.tipo === valor}">
          ${esc(rotulo)} <b class="count">${contar(valor)}</b>
        </button>`).join("");
    $$("[data-tipo]", host).forEach((el) => el.onclick = () => {
      state.tipo = el.dataset.tipo; renderTipo(); renderLista();
    });
  }

  function renderLista() {
    if (!ehTela) return;
    const linhas = filtrados();
    const count = $("#localCount");
    if (count) count.textContent = `${linhas.length.toLocaleString("pt-BR")} local(is)`;
    if (!linhas.length) {
      corpo.innerHTML = `<tr><td colspan="5" class="dim" style="padding:var(--s-5)">Nenhum local encontrado. Use "Novo local" para cadastrar o primeiro.</td></tr>`;
      return;
    }
    corpo.innerHTML = linhas.map((r) => `
      <tr>
        <td><b>${esc(r.nome || "Local sem nome")}</b><br><span class="mono dim" style="font-size:var(--fs-11)">${esc(r.id)}</span></td>
        <td><span class="badge">${esc(r.tipo)}</span></td>
        <td>${esc(r.endereco || "—")}</td>
        <td class="mono dim" style="font-size:var(--fs-11)">${Number.isFinite(r.lat) && Number.isFinite(r.lon) ? `${r.lat.toFixed(5)}, ${r.lon.toFixed(5)}` : "—"}</td>
        <td class="cell-actions"><div class="table-actions">
          <button class="btn btn-ghost btn-sm" data-editar="${esc(r.id)}" type="button" data-action="locais.edit">Editar</button>
          <button class="btn btn-ghost btn-sm btn-icon" data-excluir="${esc(r.id)}" type="button" title="Excluir local" aria-label="Excluir local" data-action="locais.delete">${icon("trash")}</button>
        </div></td>
      </tr>`).join("");
    aplicarAcoes(corpo);
    $$("[data-editar]", corpo).forEach((b) => b.onclick = () => abrirCadastro(state.registros.find((r) => r.id === b.dataset.editar) || {}, "edit"));
    $$("[data-excluir]", corpo).forEach((b) => b.onclick = () => excluir(b.dataset.excluir));
  }

  async function excluir(id) {
    const ok = await askConfirm({
      title: "Excluir local",
      text: `Tem certeza que deseja excluir "${id}"? Se ele ainda estiver no anel de algum mapa ou tiver produtos instalados, o cadastro é mantido e só sai do anel deste local.`,
      confirmLabel: "Excluir", danger: true,
    });
    if (!ok) return;
    try {
      await NOC.api(`/api/locais/${encodeURIComponent(id)}`, { method: "DELETE" });
      toast("Local excluído", { type: "ok" });
      carregar();
    } catch (error) {
      toast("Não foi possível excluir", { type: "error", text: error.message });
    }
  }

  let formHost = null;
  const camposForm = () => ({
    nome: $("#lNome", formHost)?.value ?? "",
    tipo: $("#lTipo", formHost)?.value ?? "POP",
    endereco: $("#lEndereco", formHost)?.value ?? "",
    lat: $("#lLat", formHost)?.value ?? "",
    lon: $("#lLon", formHost)?.value ?? "",
    observacao: $("#lObservacao", formHost)?.value ?? "",
  });

  async function abrirCadastro(dados = {}, modo = dados?.id ? "edit" : "create") {
    const ehEdicao = modo === "edit";
    const temPermissao = await pode(ehEdicao ? "locais.edit" : "locais.create");
    const valor = (v) => esc(v ?? "");

    modal({
      labelledBy: "localModalTitle",
      html: `
        <div class="modal-head">
          <div>
            <span class="kicker">${icon("pops")} Cadastro de local</span>
            <h2 id="localModalTitle" style="margin-top:8px">${ehEdicao ? `Editar — ${esc(dados.nome || dados.id)}` : "Novo local"}</h2>
            ${!temPermissao ? `<p class="muted" style="font-size:var(--fs-12);margin-top:6px">Seu perfil não permite gravar este cadastro.</p>` : ""}
          </div>
          <button class="btn btn-ghost btn-icon" data-close type="button" aria-label="Fechar">${icon("close")}</button>
        </div>
        <div class="modal-body stack" style="gap:var(--s-4)">
          <div class="row wrap" style="gap:var(--s-3)">
            <div class="field grow"><label for="lNome">Nome</label>
              <input class="input" id="lNome" type="text" value="${valor(dados.nome)}" autocomplete="off">
            </div>
            <div class="field" style="max-width:180px"><label for="lTipo">Tipo</label>
              <select class="select" id="lTipo">${TIPOS.map((t) => `<option value="${t}" ${dados.tipo === t ? "selected" : ""}>${esc(t)}</option>`).join("")}</select>
            </div>
          </div>
          <div class="field"><label for="lEndereco">Endereço</label>
            <input class="input" id="lEndereco" type="text" value="${valor(dados.endereco)}" autocomplete="off">
          </div>
          <div class="row wrap" style="gap:var(--s-3)">
            <div class="field" style="max-width:180px"><label for="lLat">Latitude</label>
              <input class="input" id="lLat" type="number" step="any" value="${valor(dados.lat ?? "")}">
            </div>
            <div class="field" style="max-width:180px"><label for="lLon">Longitude</label>
              <input class="input" id="lLon" type="number" step="any" value="${valor(dados.lon ?? "")}">
            </div>
          </div>
          <div class="field"><label for="lObservacao">Observação</label>
            <textarea class="textarea" id="lObservacao" rows="3">${valor(dados.observacao)}</textarea>
          </div>
          <span class="field-error" id="localFormError" hidden></span>
        </div>
        <div class="modal-foot"><span></span><span class="row">
          <button class="btn" data-close type="button">Cancelar</button>
          <button class="btn btn-primary" data-salvar type="button" ${temPermissao ? "" : "disabled"}>Salvar local</button>
        </span></div>`,
      onMount: (host, close) => {
        formHost = host;
        const erro = $("#localFormError", host);
        $("[data-salvar]", host).onclick = async (event) => {
          if (!temPermissao) return;
          event.currentTarget.disabled = true;
          event.currentTarget.classList.add("is-loading");
          const c = camposForm();
          if (!c.nome.trim()) {
            erro.hidden = false; erro.textContent = "Informe o nome do local.";
            event.currentTarget.disabled = false; event.currentTarget.classList.remove("is-loading");
            return;
          }
          try {
            if (ehEdicao && dados.id) {
              await NOC.api(`/api/locais/${encodeURIComponent(dados.id)}`, { method: "PUT", body: JSON.stringify(c) });
            } else {
              await NOC.api("/api/locais", { method: "POST", body: JSON.stringify(c) });
            }
            close();
            toast(ehEdicao ? "Local atualizado" : "Local criado", { type: "ok" });
            if (ehTela) carregar();
          } catch (error) {
            erro.hidden = false;
            erro.textContent = error.message || "Não foi possível salvar o local.";
            event.currentTarget.disabled = false;
            event.currentTarget.classList.remove("is-loading");
          }
        };
      },
    });
  }

  function mount() {
    if (!ehTela) return;
    UI.mountShell({ search: () => state.registros.slice(0, 200).map((r) => ({
      label: r.nome || r.id, meta: `${r.tipo} • ${r.endereco || "sem endereço"}`,
      icon: "pops", action: () => abrirCadastro(r, "edit"),
    })) });
    if ($("#localSearchIcon")) $("#localSearchIcon").innerHTML = icon("search");
    $("#btnNovoLocal").onclick = () => abrirCadastro({}, "create");
    $("#localBusca").oninput = (e) => { state.q = e.target.value; renderLista(); };
    $("#localLimpar").onclick = () => {
      state.q = ""; state.tipo = "todos"; $("#localBusca").value = ""; renderTipo(); renderLista();
    };
    carregar();
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", mount); else mount();

  window.NOC_LOCAIS = { abrirCadastro };
})();
