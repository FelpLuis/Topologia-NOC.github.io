/* ============================================================
   UPDOWN NOC — Cadastro de Produtos
   CRUD do cadastro único de produto (equipamento). É a mesma tabela
   que /api/topology lê e grava por baixo do mapa: portas, imagem e
   hotspots continuam sendo editados na tela do mapa; aqui é o dado
   cadastral (nome, fabricante, modelo, categoria, serial e local).
   ============================================================ */
(() => {
  "use strict";
  const { $, $$, esc, icon, toast, modal, confirm: askConfirm } = UI;

  const corpo = $("#produtoListBody");
  const ehTela = !!corpo;

  const state = { registros: [], locais: [], q: "" };

  let acessoPronto = false;
  const acesso = NOC.loadAccess()
    .then(() => { acessoPronto = true; NOC.applyActions(document); })
    .catch(() => {});
  const aplicarAcoes = (host) => { if (acessoPronto) NOC.applyActions(host); };
  async function pode(codigo) { await acesso; return NOC.can(codigo); }

  async function carregar() {
    if (!ehTela) return;
    try {
      const [produtos, locais] = await Promise.all([
        NOC.api("/api/produtos"),
        NOC.api("/api/locais").catch(() => ({ registros: [] })),
      ]);
      state.registros = Array.isArray(produtos.registros) ? produtos.registros : [];
      state.locais = Array.isArray(locais.registros) ? locais.registros : [];
    } catch { state.registros = []; }
    renderLista();
  }

  const nomeLocal = (id) => state.locais.find((l) => l.id === id)?.nome || "";

  function filtrados() {
    const q = state.q.trim().toLowerCase();
    if (!q) return state.registros;
    return state.registros.filter((r) =>
      [r.nome, r.modelo, r.serial, r.fabricante].join(" ").toLowerCase().includes(q));
  }

  function renderLista() {
    if (!ehTela) return;
    const linhas = filtrados();
    const count = $("#produtoCount");
    if (count) count.textContent = `${linhas.length.toLocaleString("pt-BR")} produto(s)`;
    if (!linhas.length) {
      corpo.innerHTML = `<tr><td colspan="5" class="dim" style="padding:var(--s-5)">Nenhum produto encontrado. Use "Novo produto" para cadastrar o primeiro.</td></tr>`;
      return;
    }
    corpo.innerHTML = linhas.map((r) => `
      <tr>
        <td><b>${esc(r.nome || "Produto sem nome")}</b>${r.serial ? `<br><span class="mono dim" style="font-size:var(--fs-11)">${esc(r.serial)}</span>` : ""}</td>
        <td>${esc([r.fabricante, r.modelo].filter(Boolean).join(" • ") || "—")}</td>
        <td>${r.categoria ? `<span class="badge">${esc(r.categoria)}</span>` : "—"}</td>
        <td>${esc(nomeLocal(r.local_id) || (r.local_id ? r.local_id : "—"))}</td>
        <td class="cell-actions"><div class="table-actions">
          <button class="btn btn-ghost btn-sm" data-editar="${esc(r.id)}" type="button" data-action="produtos.edit">Editar</button>
          <button class="btn btn-ghost btn-sm btn-icon" data-excluir="${esc(r.id)}" type="button" title="Excluir produto" aria-label="Excluir produto" data-action="produtos.delete">${icon("trash")}</button>
        </div></td>
      </tr>`).join("");
    aplicarAcoes(corpo);
    $$("[data-editar]", corpo).forEach((b) => b.onclick = () => abrirCadastro(state.registros.find((r) => r.id === b.dataset.editar) || {}, "edit"));
    $$("[data-excluir]", corpo).forEach((b) => b.onclick = () => excluir(b.dataset.excluir));
  }

  async function excluir(id) {
    const ok = await askConfirm({
      title: "Excluir produto",
      text: `Tem certeza que deseja excluir "${id}"? Portas, enlaces e credenciais de acesso remoto associados também são removidos.`,
      confirmLabel: "Excluir", danger: true,
    });
    if (!ok) return;
    try {
      await NOC.api(`/api/produtos/${encodeURIComponent(id)}`, { method: "DELETE" });
      toast("Produto excluído", { type: "ok" });
      carregar();
    } catch (error) {
      toast("Não foi possível excluir", { type: "error", text: error.message });
    }
  }

  let formHost = null;
  const camposForm = () => ({
    nome: $("#pNome", formHost)?.value ?? "",
    fabricante: $("#pFabricante", formHost)?.value ?? "",
    modelo: $("#pModelo", formHost)?.value ?? "",
    categoria: $("#pCategoria", formHost)?.value ?? "",
    serial: $("#pSerial", formHost)?.value ?? "",
    local_id: $("#pLocal", formHost)?.value || null,
    observacao: $("#pObservacao", formHost)?.value ?? "",
  });

  async function abrirCadastro(dados = {}, modo = dados?.id ? "edit" : "create") {
    const ehEdicao = modo === "edit";
    const temPermissao = await pode(ehEdicao ? "produtos.edit" : "produtos.create");
    const valor = (v) => esc(v ?? "");
    if (!state.locais.length) {
      try { state.locais = (await NOC.api("/api/locais")).registros || []; } catch { /* opcional */ }
    }

    modal({
      labelledBy: "produtoModalTitle",
      html: `
        <div class="modal-head">
          <div>
            <span class="kicker">${icon("topology")} Cadastro de produto</span>
            <h2 id="produtoModalTitle" style="margin-top:8px">${ehEdicao ? `Editar — ${esc(dados.nome || dados.id)}` : "Novo produto"}</h2>
            ${!temPermissao ? `<p class="muted" style="font-size:var(--fs-12);margin-top:6px">Seu perfil não permite gravar este cadastro.</p>` : ""}
          </div>
          <button class="btn btn-ghost btn-icon" data-close type="button" aria-label="Fechar">${icon("close")}</button>
        </div>
        <div class="modal-body stack" style="gap:var(--s-4)">
          <div class="row wrap" style="gap:var(--s-3)">
            <div class="field grow"><label for="pNome">Nome</label>
              <input class="input" id="pNome" type="text" value="${valor(dados.nome)}" autocomplete="off">
            </div>
            <div class="field" style="max-width:220px"><label for="pCategoria">Categoria</label>
              <input class="input" id="pCategoria" type="text" list="produtoCategorias" placeholder="Ex.: OLT, Switch, Roteador" value="${valor(dados.categoria)}" autocomplete="off">
              <datalist id="produtoCategorias">${[...new Set(state.registros.map((r) => r.categoria).filter(Boolean))].map((c) => `<option value="${esc(c)}">`).join("")}</datalist>
            </div>
          </div>
          <div class="row wrap" style="gap:var(--s-3)">
            <div class="field grow"><label for="pFabricante">Fabricante</label>
              <input class="input" id="pFabricante" type="text" value="${valor(dados.fabricante)}" autocomplete="off">
            </div>
            <div class="field grow"><label for="pModelo">Modelo</label>
              <input class="input" id="pModelo" type="text" value="${valor(dados.modelo)}" autocomplete="off">
            </div>
            <div class="field" style="max-width:200px"><label for="pSerial">Serial / patrimônio</label>
              <input class="input" id="pSerial" type="text" value="${valor(dados.serial)}" autocomplete="off">
            </div>
          </div>
          <div class="field"><label for="pLocal">Local</label>
            <select class="select" id="pLocal">
              <option value="">Sem local vinculado</option>
              ${state.locais.map((l) => `<option value="${esc(l.id)}" ${dados.local_id === l.id ? "selected" : ""}>${esc(l.nome)} (${esc(l.tipo)})</option>`).join("")}
            </select>
          </div>
          <div class="field"><label for="pObservacao">Observação</label>
            <textarea class="textarea" id="pObservacao" rows="3">${valor(dados.observacao)}</textarea>
          </div>
          <span class="field-error" id="produtoFormError" hidden></span>
        </div>
        <div class="modal-foot"><span></span><span class="row">
          <button class="btn" data-close type="button">Cancelar</button>
          <button class="btn btn-primary" data-salvar type="button" ${temPermissao ? "" : "disabled"}>Salvar produto</button>
        </span></div>`,
      onMount: (host, close) => {
        formHost = host;
        const erro = $("#produtoFormError", host);
        $("[data-salvar]", host).onclick = async (event) => {
          if (!temPermissao) return;
          event.currentTarget.disabled = true;
          event.currentTarget.classList.add("is-loading");
          const c = camposForm();
          if (!c.nome.trim()) {
            erro.hidden = false; erro.textContent = "Informe o nome do produto.";
            event.currentTarget.disabled = false; event.currentTarget.classList.remove("is-loading");
            return;
          }
          try {
            if (ehEdicao && dados.id) {
              await NOC.api(`/api/produtos/${encodeURIComponent(dados.id)}`, { method: "PUT", body: JSON.stringify(c) });
            } else {
              await NOC.api("/api/produtos", { method: "POST", body: JSON.stringify(c) });
            }
            close();
            toast(ehEdicao ? "Produto atualizado" : "Produto criado", { type: "ok" });
            if (ehTela) carregar();
          } catch (error) {
            erro.hidden = false;
            erro.textContent = error.message || "Não foi possível salvar o produto.";
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
      label: r.nome || r.id, meta: `${[r.fabricante, r.modelo].filter(Boolean).join(" • ") || "sem modelo"}`,
      icon: "topology", action: () => abrirCadastro(r, "edit"),
    })) });
    if ($("#produtoSearchIcon")) $("#produtoSearchIcon").innerHTML = icon("search");
    $("#btnNovoProduto").onclick = () => abrirCadastro({}, "create");
    $("#produtoBusca").oninput = (e) => { state.q = e.target.value; renderLista(); };
    $("#produtoLimpar").onclick = () => { state.q = ""; $("#produtoBusca").value = ""; renderLista(); };
    carregar();
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", mount); else mount();

  window.NOC_PRODUTOS = { abrirCadastro };
})();
