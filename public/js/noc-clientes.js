/* ============================================================
   UPDOWN NOC — Cadastro de Cliente
   CRUD dos clientes atendidos pela rede. O cadastro convive com o
   feed da OLT/IXC: nome, endereço e coordenadas informados aqui
   sobrepõem o que a coleta trouxe no mapa GPON. As senhas (PPPoE,
   roteador, WiFi) ficam cifradas no Worker e só abrem na edição.

   A mesma tela roda nas páginas de mapa GPON (somente o modal de
   edição) e na página /clientes.html (lista + CRUD completo).
   ============================================================ */
(() => {
  "use strict";
  const { $, $$, esc, icon, toast } = UI;

  const corpo = $("#clienteListBody");
  const ehTela = !!corpo;

  const state = { registros: [], q: "", status: "todos", page: 0, aparelhos: [], ixcId: "" };
  const PAGE_SIZE = 60;

  const STATUS = ["ativo", "inativo", "cancelado", "bloqueado", "suspenso"];
  const STATUS_LABEL = { ativo: "Ativo", inativo: "Inativo", cancelado: "Cancelado", bloqueado: "Bloqueado", suspenso: "Suspenso" };
  /* Cancelado é mais grave que inativo — sem classe própria os dois badges
     ficavam idênticos e a lista não distinguia quem saiu de vez de quem só
     está pausado. */
  const STATUS_CLASS = { ativo: "badge-ok", inativo: "", cancelado: "badge-danger", bloqueado: "badge-warn", suspenso: "badge-warn" };

  const brl = (v) => {
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0) return "";
    return n.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
  };

  /* ---------------- permissões ----------------
     As ações só podem ser aplicadas depois que /api/access responde: antes
     disso o conjunto de permissões está vazio e todo botão apareceria
     bloqueado. Quando a resposta chega, uma passada no documento alcança o que
     já foi desenhado. */
  let acessoPronto = false;
  const acesso = NOC.loadAccess()
    .then(() => { acessoPronto = true; NOC.applyActions(document); })
    .catch(() => { /* sem acesso: pode() devolve false e o salvar fica travado */ });
  const aplicarAcoes = (host) => { if (acessoPronto) NOC.applyActions(host); };
  async function pode(codigo) {
    await acesso;
    return NOC.can(codigo);
  }

  /* ---------------- página /clientes.html ---------------- */
  async function carregar() {
    if (!ehTela) return;
    try {
      const dados = await NOC.api("/api/clientes");
      state.registros = Array.isArray(dados.registros) ? dados.registros : [];
    } catch { state.registros = []; }
    renderStatus();
    renderLista();
  }

  function filtrados() {
    const q = state.q.trim().toLowerCase();
    return state.registros.filter((r) => {
      if (state.status !== "todos" && r.status_faturamento !== state.status) return false;
      if (!q) return true;
      const alvo = [r.nome, r.client_id, r.telefone, r.documento, r.cidade, r.email].join(" ").toLowerCase();
      return alvo.includes(q);
    });
  }

  function renderStatus() {
    const host = $("#clienteStatus");
    if (!host) return;
    const contar = (status) => status === "todos"
      ? state.registros.length
      : state.registros.filter((r) => r.status_faturamento === status).length;
    host.innerHTML = [["todos", "Todos"], ...STATUS.map((s) => [s, STATUS_LABEL[s]])]
      .map(([valor, rotulo]) => `
        <button class="chip" type="button" data-status="${valor}" aria-pressed="${state.status === valor}">
          ${esc(rotulo)} <b class="count">${contar(valor)}</b>
        </button>`).join("");
    $$("[data-status]", host).forEach((el) => el.onclick = () => {
      state.status = el.dataset.status; state.page = 0;
      renderStatus(); renderLista();
    });
  }

  function renderLista() {
    if (!ehTela) return;
    const linhas = filtrados();
    const paginas = Math.max(1, Math.ceil(linhas.length / PAGE_SIZE));
    state.page = Math.min(state.page, paginas - 1);
    const fatia = linhas.slice(state.page * PAGE_SIZE, (state.page + 1) * PAGE_SIZE);
    const count = $("#clienteCount");
    if (count) count.textContent = `${linhas.length.toLocaleString("pt-BR")} cadastro(s)`;

    const lbl = $("#clientePageLabel");
    if (lbl) lbl.textContent = paginas > 1 ? `Página ${state.page + 1} de ${paginas}` : `${linhas.length} registro(s)`;
    const prev = $("#clientePrevPage"), next = $("#clienteNextPage");
    if (prev) prev.disabled = state.page === 0;
    if (next) next.disabled = state.page >= paginas - 1;

    if (!linhas.length) {
      const semNada = !state.registros.length;
      corpo.innerHTML = `<tr><td colspan="7">
        <div class="empty">
          <span class="empty-icon">${icon("users")}</span>
          <b>Nenhum cadastro encontrado</b>
          <p>${semNada ? `Use "Novo cadastro" para registrar o primeiro cliente.` : "Ajuste a busca ou o filtro de status para ver outros cadastros."}</p>
        </div>
      </td></tr>`;
      return;
    }
    corpo.innerHTML = fatia.map((r) => {
      const nome = r.nome || "Cliente sem nome";
      const selos = [
        r.has_senha_pppoe ? `<span class="badge badge-warn" title="Senha PPPoE cadastrada">PPPoE</span>` : "",
        r.has_senha_roteador ? `<span class="badge" title="Senha do roteador cadastrada">Rot</span>` : "",
        r.has_senha_wifi ? `<span class="badge badge-warn" title="Senha WiFi cadastrada">WiFi</span>` : "",
        r.has_senha_portal ? `<span class="badge badge-ok" title="Acesso ao app liberado">App</span>` : "",
      ].filter(Boolean).join("");
      return `
      <tr>
        <td data-label="Código"><span class="mono">${esc(r.client_id)}</span></td>
        <td data-label="Cliente">
          <b>${esc(nome)}</b>
          ${selos ? `<span class="row wrap" style="gap:4px;margin-top:4px">${selos}</span>` : ""}
        </td>
        <td data-label="Contato">
          ${esc(r.telefone || "—")}<br>
          <span class="dim" style="font-size:var(--fs-11)">${esc(r.email || "")}</span>
        </td>
        <td data-label="Endereço">
          ${esc([r.endereco, r.bairro].filter(Boolean).join(", ") || "—")}<br>
          <span class="dim" style="font-size:var(--fs-11)">${esc([r.cidade, r.uf].filter(Boolean).join(" / ") || "")}</span>
        </td>
        <td data-label="Faturamento">
          ${esc(r.plano || "—")}<br>
          <span class="dim" style="font-size:var(--fs-11)">${brl(r.valor_mensal) ? `${brl(r.valor_mensal)} • venc. ${r.vencimento_dia || "—"}` : r.vencimento_dia ? `Venc. dia ${r.vencimento_dia}` : ""}</span>
        </td>
        <td data-label="Status"><span class="badge ${STATUS_CLASS[r.status_faturamento] || ""}">${esc(STATUS_LABEL[r.status_faturamento] || r.status_faturamento)}</span></td>
        <td data-label="Ações" class="row" style="gap:6px;justify-content:flex-end"></span></td>
        <td  <button class="btn btn-ghost btn-sm" data-editar="${esc(r.client_id)}" type="button" data-action="clientes.edit">Editar</button>
        <button class="btn btn-ghost btn-sm btn-icon" data-excluir="${esc(r.client_id)}" type="button" title="Excluir cadastro" aria-label="Excluir cadastro" data-action="clientes.delete">${icon("trash")}</button>
        </span></td>
      </tr>`;
    }).join("");
    aplicarAcoes(corpo);
    $$("[data-editar]", corpo).forEach((b) => b.onclick = () => abrirCadastro({ client_id: b.dataset.editar }, "edit"));
    $$("[data-excluir]", corpo).forEach((b) => b.onclick = () => excluir(b.dataset.excluir));
  }

  async function excluir(clientId) {
    const ok = await UI.confirm({
      title: "Excluir cadastro",
      text: `Tem certeza que deseja excluir o cadastro de "${clientId}"? O cliente continua na coleta da OLT/IXC; só o cadastro da plataforma é removido.`,
      confirmLabel: "Excluir",
      danger: true,
    });
    if (!ok) return;
    try {
      await NOC.api(`/api/clientes/${encodeURIComponent(clientId)}`, { method: "DELETE" });
      toast("Cadastro excluído", { type: "ok" });
      carregar();
    } catch (error) {
      toast("Não foi possível excluir", { type: "error", text: error.message });
    }
  }

  /* ---------------- formulário (página + telas GPON) ---------------- */
  const camposForm = () => ({
    client_id: $("#clienteFormId", formHost)?.value.trim() ?? "",
    /* O vínculo com o ERP não tem campo na tela: ele vem do cadastro aberto (ou
       do cliente escolhido no feed) e volta intacto no salvamento. */
    ixc_id: state.ixcId,
    nome: $("#fNome", formHost)?.value ?? "",
    documento: $("#fDocumento", formHost)?.value ?? "",
    telefone: $("#fTelefone", formHost)?.value ?? "",
    email: $("#fEmail", formHost)?.value ?? "",
    endereco: $("#fEndereco", formHost)?.value ?? "",
    bairro: $("#fBairro", formHost)?.value ?? "",
    cidade: $("#fCidade", formHost)?.value ?? "",
    uf: $("#fUf", formHost)?.value ?? "",
    cep: $("#fCep", formHost)?.value ?? "",
    lat: $("#fLat", formHost)?.value ?? "",
    lon: $("#fLon", formHost)?.value ?? "",
    plano: $("#fPlano", formHost)?.value ?? "",
    valor_mensal: $("#fValor", formHost)?.value ?? "",
    vencimento_dia: $("#fVencimento", formHost)?.value ?? "",
    status_faturamento: $("#fStatus", formHost)?.value ?? "ativo",
    aparelhos: state.aparelhos.map((a) => ({ nome: a.nome, tipo: a.tipo, serial: a.serial })),
    ont_serial: $("#fOntSerial", formHost)?.value ?? "",
    ont_modelo: $("#fOntModelo", formHost)?.value ?? "",
    ip_gerencia: $("#fIpGerencia", formHost)?.value ?? "",
    login_pppoe: $("#fLoginPppoe", formHost)?.value ?? "",
    senha_pppoe: $("#fSenhaPppoe", formHost)?.value ?? "",
    login_roteador: $("#fLoginRoteador", formHost)?.value ?? "",
    senha_roteador: $("#fSenhaRoteador", formHost)?.value ?? "",
    ssid: $("#fSsid", formHost)?.value ?? "",
    senha_wifi: $("#fSenhaWifi", formHost)?.value ?? "",
    senha_portal: $("#fSenhaPortal", formHost)?.value ?? "",
    observacao: $("#fObservacao", formHost)?.value ?? "",
  });

  const secao = (titulo, detalhe, camposHtml) => `
    <div class="form-section">
      <div class="form-section-head"><b>${esc(titulo)}</b>${detalhe ? `<span class="dim" style="font-size:var(--fs-11)">${esc(detalhe)}</span>` : ""}</div>
      ${camposHtml}
    </div>`;
  const campo = (label, id, type = "text", extra = "") => `
    <div class="field"><label for="${id}">${esc(label)}</label>
      <input class="input" id="${id}" type="${type}" ${extra}>
    </div>`;

  let formHost = null;

  function renderAparelhos() {
    const host = $("#fAparelhos", formHost);
    if (!host) return;
    host.innerHTML = state.aparelhos.map((a, i) => `
      <div class="row" style="gap:6px;align-items:center">
        <input class="input" data-apa-nome="${i}" type="text" placeholder="Aparelho (TV, decodificador…)" value="${esc(a.nome)}">
        <input class="input" data-apa-tipo="${i}" type="text" placeholder="Tipo" style="max-width:130px" value="${esc(a.tipo)}">
        <input class="input" data-apa-serial="${i}" type="text" placeholder="Serial" class="mono" style="max-width:170px" value="${esc(a.serial)}">
        <button class="btn btn-ghost btn-icon btn-sm" data-apa-rem="${i}" type="button" aria-label="Remover aparelho">${icon("trash")}</button>
      </div>`).join("");
    $$("[data-apa-nome]", host).forEach((el) => el.oninput = () => state.aparelhos[Number(el.dataset.apaNome)].nome = el.value);
    $$("[data-apa-tipo]", host).forEach((el) => el.oninput = () => state.aparelhos[Number(el.dataset.apaTipo)].tipo = el.value);
    $$("[data-apa-serial]", host).forEach((el) => el.oninput = () => state.aparelhos[Number(el.dataset.apaSerial)].serial = el.value);
    $$("[data-apa-rem]", host).forEach((el) => el.onclick = () => {
      state.aparelhos.splice(Number(el.dataset.apaRem), 1);
      renderAparelhos();
    });
  }

  async function carregarOpcoesCliente() {
    const data = $("#clienteFeedList", formHost), input = $("#clienteFormId", formHost);
    if (!data || !input) return;
    const termo = input.value.trim();
    try {
      const dados = await NOC.api(`/api/clientes/feed?q=${encodeURIComponent(termo)}&limit=50`);
      const clientes = Array.isArray(dados.clientes) ? dados.clientes : [];
      /* O código proposto é o do IXC — o mesmo do ERP —, com o id da ONU só
         para quem o IXC ainda não reconhece. */
      state.feedPorCodigo = new Map(clientes.map((c) => [String(c.codigo || c.id), c]));
      data.innerHTML = clientes
        .map((c) => `<option value="${esc(c.codigo || c.id)}">${esc(`${c.name} — ${[c.address, c.pon, c.serial].filter(Boolean).join(" • ")}`)}</option>`)
        .join("");
    } catch { /* lista de sugestão é acessória */ }
  }

  /* Escolher um cliente da lista do feed traz nome, endereço e ONU já
     preenchidos — sem sobrescrever o que o operador tenha digitado antes. */
  function aplicarSugestaoFeed(codigo, host) {
    const c = state.feedPorCodigo?.get(codigo);
    if (!c) return;
    state.ixcId = String(c.ixc_id || "").trim();
    const preencher = (id, valor) => {
      const el = $(id, host);
      if (el && !el.value && valor) el.value = valor;
    };
    preencher("#fNome", c.name === "Cliente sem nome" ? "" : c.name);
    preencher("#fEndereco", c.address);
    preencher("#fOntSerial", c.serial);
    preencher("#fLoginPppoe", c.username);
  }

  async function abrirCadastro(dados = {}, modo = dados?.cliente_id ? "edit" : "create", onSalvo = null) {
    const ehEdicao = modo === "edit";
    const temPermissao = await pode(ehEdicao ? "clientes.edit" : "clientes.create");
    const corpoForm = ehEdicao && dados.client_id
      ? await NOC.api(`/api/clientes/${encodeURIComponent(dados.client_id)}`).catch(() => dados)
      : { ...dados };

    state.aparelhos = Array.isArray(corpoForm.aparelhos) ? corpoForm.aparelhos.map((a) => ({ ...a })) : [];
    state.ixcId = String(corpoForm.ixc_id ?? "").trim();
    const valor = (v) => esc(v ?? "");

    UI.modal({
      labelledBy: "clienteModalTitle",
      wide: true,
      html: `
        <div class="modal-head">
          <div>
            <span class="kicker">${icon("users")} Cadastro de cliente</span>
            <h2 id="clienteModalTitle" style="margin-top:8px">${ehEdicao ? `Editar — ${esc(corpoForm.client_id)}` : "Novo cadastro"}</h2>
            ${!temPermissao ? `<p class="muted" style="font-size:var(--fs-12);margin-top:6px">Seu perfil não permite gravar este cadastro.</p>` : ""}
          </div>
          <button class="btn btn-ghost btn-icon" data-close type="button" aria-label="Fechar">${icon("close")}</button>
        </div>
        <div class="modal-body stack" style="gap:var(--s-4)">
          <div class="tabs" role="tablist" aria-label="Seções do cadastro de cliente">
            <button class="tab" type="button" role="tab" id="tabGeraisBtn" aria-controls="tabGerais" aria-selected="true" data-tab="tabGerais">${icon("user")} Dados gerais</button>
            <button class="tab" type="button" role="tab" id="tabFinanceiroBtn" aria-controls="tabFinanceiro" aria-selected="false" data-tab="tabFinanceiro">${icon("finance")} Dados financeiros</button>
            <button class="tab" type="button" role="tab" id="tabTecnicoBtn" aria-controls="tabTecnico" aria-selected="false" data-tab="tabTecnico">${icon("pulse")} Dados técnicos</button>
            <button class="tab" type="button" role="tab" id="tabAcessosBtn" aria-controls="tabAcessos" aria-selected="false" data-tab="tabAcessos">${icon("lock")} Acessos</button>
          </div>

          <div class="tab-panel" id="tabGerais" role="tabpanel" aria-labelledby="tabGeraisBtn">
            ${secao("Dados do cliente", "Informações cadastrais do assinante.", `
              <div class="row wrap" style="gap:var(--s-3)">
                ${corpoForm.client_id ? `
                  <div class="field grow"><label for="clienteFormId">Código do cliente (IXC)</label>
                    <input class="input" id="clienteFormId" type="text" value="${esc(corpoForm.client_id)}" disabled>
                  </div>` : `
                  <div class="field grow"><label for="clienteFormId">Código do cliente (IXC)</label>
                    <input class="input" id="clienteFormId" type="text" list="clienteFeedList" placeholder="Código do cliente no IXC — digite nome, serial ou endereço para buscar"
                           aria-label="Código do cliente no IXC" autocomplete="off">
                    <datalist id="clienteFeedList"></datalist>
                  </div>`}
                <div class="field" style="max-width:180px"><label for="fDocumento">Documento (CPF/CNPJ)</label>
                  <input class="input" id="fDocumento" type="text" value="${valor(corpoForm.cpf_cnpj)}" autocomplete="off">
                </div>
              </div>
              <div class="row wrap" style="gap:var(--s-3)">
                <div class="field grow"><label for="fNome">Nome</label>
                  <input class="input" id="fNome" type="text" value="${valor(corpoForm.nome)}" autocomplete="off">
                </div>
                <div class="field" style="max-width:180px"><label for="fTelefone">Telefone</label>
                  <input class="input" id="fTelefone" type="text" value="${valor(corpoForm.telefone)}" autocomplete="off">
                </div>
              </div>
              <div class="field"><label for="fEmail">E-mail</label>
                <input class="input" id="fEmail" type="email" value="${valor(corpoForm.email)}" autocomplete="off">
              </div>`)}
            ${secao("Endereço", "Onde o cliente está; com lat/lon o mapa GPON posiciona exatamente.", `
              <div class="field"><label for="fEndereco">Endereço</label>
                <input class="input" id="fEndereco" type="text" value="${valor(corpoForm.endereco)}" autocomplete="off">
              </div>
              <div class="row wrap" style="gap:var(--s-3)">
                <div class="field" style="max-width:200px"><label for="fBairro">Bairro</label>
                  <input class="input" id="fBairro" type="text" value="${valor(corpoForm.bairro)}" autocomplete="off">
                </div>
                <div class="field grow"><label for="fCidade">Cidade</label>
                  <input class="input" id="fCidade" type="text" value="${valor(corpoForm.cidade)}" autocomplete="off">
                </div>
                <div class="field" style="max-width:90px"><label for="fUf">UF</label>
                  <input class="input" id="fUf" type="text" maxlength="2" value="${valor(corpoForm.uf)}" autocomplete="off">
                </div>
                <div class="field" style="max-width:150px"><label for="fCep">CEP</label>
                  <input class="input" id="fCep" type="text" value="${valor(corpoForm.cep)}" autocomplete="off">
                </div>
              </div>
              <div class="row wrap" style="gap:var(--s-3)">
                <div class="field" style="max-width:170px"><label for="fLat">Latitude</label>
                  <input class="input" id="fLat" type="number" step="any" value="${valor(corpoForm.lat ?? "")}">
                </div>
                <div class="field" style="max-width:170px"><label for="fLon">Longitude</label>
                  <input class="input" id="fLon" type="number" step="any" value="${valor(corpoForm.lon ?? "")}">
                </div>
              </div>`)}
            ${secao("Observações", "Anotações livres do atendimento.", `
              <textarea class="textarea" id="fObservacao" rows="3">${valor(corpoForm.observacao)}</textarea>`)}
          </div>

          <div class="tab-panel" id="tabFinanceiro" role="tabpanel" aria-labelledby="tabFinanceiroBtn" hidden>
            ${secao("Faturamento", "Plano, valor e situação financeira.", `
              <div class="row wrap" style="gap:var(--s-3)">
                <div class="field grow"><label for="fPlano">Plano</label>
                  <input class="input" id="fPlano" type="text" value="${valor(corpoForm.plano)}" autocomplete="off">
                </div>
                <div class="field" style="max-width:160px"><label for="fValor">Valor mensal</label>
                  <input class="input" id="fValor" type="number" step="0.01" min="0" value="${valor(corpoForm.valor_mensal ?? "")}">
                </div>
                <div class="field" style="max-width:150px"><label for="fVencimento">Vencimento (dia)</label>
                  <input class="input" id="fVencimento" type="number" min="1" max="31" value="${valor(corpoForm.vencimento_dia ?? "")}">
                </div>
                <div class="field" style="max-width:170px"><label for="fStatus">Status</label>
                  <select class="select" id="fStatus">${STATUS.map((s) => `<option value="${s}" ${corpoForm.status_faturamento === s ? "selected" : ""}>${esc(STATUS_LABEL[s])}</option>`).join("")}</select>
                </div>
              </div>`)}
          </div>

          <div class="tab-panel" id="tabTecnico" role="tabpanel" aria-labelledby="tabTecnicoBtn" hidden>
            ${secao("ONT / ONU", "Equipamento óptico na casa do cliente.", `
              <div class="row wrap" style="gap:var(--s-3)">
                <div class="field grow"><label for="fOntSerial">Serial da ONU</label>
                  <input class="input" id="fOntSerial" type="text" value="${valor(corpoForm.ont_serial)}" autocomplete="off">
                </div>
                <div class="field grow"><label for="fOntModelo">Modelo</label>
                  <input class="input" id="fOntModelo" type="text" value="${valor(corpoForm.ont_modelo)}" autocomplete="off">
                </div>
              </div>`)}
            ${secao("Acesso remoto", "Gerência do equipamento na casa do cliente.", `
              <div class="field" style="max-width:260px"><label for="fIpGerencia">IP de gerência</label>
                <input class="input" id="fIpGerencia" type="text" value="${valor(corpoForm.ip_gerencia)}" autocomplete="off">
              </div>`)}
            ${secao("Aparelhos vinculados", "Equipamentos do cliente além da ONU (TV, decodificadores…).", `
              <div class="stack" id="fAparelhos" style="gap:6px"></div>
              <button class="btn btn-ghost btn-sm" id="fAparelhoAdd" type="button">${icon("plus")} Adicionar aparelho</button>`)}
          </div>

          <div class="tab-panel" id="tabAcessos" role="tabpanel" aria-labelledby="tabAcessosBtn" hidden>
            ${secao("PPPoE", "Autenticação da conexão no provedor.", `
              <div class="row wrap" style="gap:var(--s-3)">
                <div class="field grow"><label for="fLoginPppoe">Login</label>
                  <input class="input" id="fLoginPppoe" type="text" value="${valor(corpoForm.login_pppoe)}" autocomplete="off">
                </div>
                <div class="field grow"><label for="fSenhaPppoe">Senha</label>
                  <input class="input" id="fSenhaPppoe" type="text" autocomplete="off">
                </div>
              </div>
              <p class="muted" style="font-size:var(--fs-11)">${corpoForm.has_senha_pppoe ? "Senha armazenada com hash (protegida). Deixe em branco para manter; preencha para alterar." : "Nenhuma senha cadastrada até agora."}</p>`)}
            ${secao("Roteador", "Acesso ao equipamento do cliente.", `
              <div class="row wrap" style="gap:var(--s-3)">
                <div class="field grow"><label for="fLoginRoteador">Usuário</label>
                  <input class="input" id="fLoginRoteador" type="text" value="${valor(corpoForm.login_roteador)}" autocomplete="off">
                </div>
                <div class="field grow"><label for="fSenhaRoteador">Senha</label>
                  <input class="input" id="fSenhaRoteador" type="text" autocomplete="off">
                </div>
              </div>
              <p class="muted" style="font-size:var(--fs-11)">${corpoForm.has_senha_roteador ? "Senha armazenada com hash (protegida). Deixe em branco para manter; preencha para alterar." : "Nenhuma senha cadastrada até agora."}</p>`)}
            ${secao("WiFi", "Rede sem fio do cliente.", `
              <div class="row wrap" style="gap:var(--s-3)">
                <div class="field grow"><label for="fSsid">SSID</label>
                  <input class="input" id="fSsid" type="text" value="${valor(corpoForm.ssid)}" autocomplete="off">
                </div>
                <div class="field grow"><label for="fSenhaWifi">Senha do WiFi</label>
                  <input class="input" id="fSenhaWifi" type="text" autocomplete="off">
                </div>
              </div>
              <p class="muted" style="font-size:var(--fs-11)">${corpoForm.has_senha_wifi ? "Senha armazenada com hash (protegida). Deixe em branco para manter; preencha para alterar." : "Nenhuma senha cadastrada até agora."}</p>`)}
            ${secao("App do cliente", "Acesso do cliente ao app (chat com a central e status do roteador).", `
              <div class="row wrap" style="gap:var(--s-3)">
                <div class="field grow"><label for="fSenhaPortal">Senha inicial do app</label>
                  <input class="input" id="fSenhaPortal" type="text" autocomplete="off">
                </div>
              </div>
              <p class="muted" style="font-size:var(--fs-11)">${corpoForm.has_senha_portal ? "Senha cadastrada. Deixe em branco para manter; preencha para redefinir (o cliente é obrigado a trocá-la no próximo login)." : "Sem senha cadastrada — o cliente ainda não consegue entrar no app. O login é feito com o CPF/CNPJ; defina uma senha inicial aqui."}</p>`)}
          </div>

          <span class="field-error" id="clienteFormError" hidden></span>
        </div>
        <div class="modal-foot"><span></span><span class="row">
          <button class="btn" data-close type="button">Cancelar</button>
          <button class="btn btn-primary" data-salvar type="button" ${temPermissao ? "" : "disabled"}>Salvar cadastro</button>
        </span></div>`,
      onMount: (host, close) => {
        /* onMount roda dentro de UI.modal(), antes de a chamada retornar: o
           host do formulário só pode vir daqui. */
        formHost = host;
        renderAparelhos();
        const feedInput = $("#clienteFormId", host);
        if (feedInput && !feedInput.disabled) {
          let timer = 0;
          feedInput.onfocus = () => carregarOpcoesCliente();
          feedInput.oninput = () => {
            aplicarSugestaoFeed(feedInput.value.trim(), host);
            clearTimeout(timer); timer = setTimeout(carregarOpcoesCliente, 250);
          };
        }
        const add = $("#fAparelhoAdd", host);
        if (add) add.onclick = () => { state.aparelhos.push({ nome: "", tipo: "", serial: "" }); renderAparelhos(); };

        const tabBtns = $$("[role=tab]", host);
        const selecionarAba = (id) => {
          tabBtns.forEach((b) => {
            const sel = b.dataset.tab === id;
            b.setAttribute("aria-selected", sel ? "true" : "false");
            const painel = $("#" + b.getAttribute("aria-controls"), host);
            if (painel) painel.hidden = !sel;
          });
        };
        tabBtns.forEach((b) => { b.onclick = () => selecionarAba(b.dataset.tab); });

        const erro = $("#clienteFormError", host);
         $("[data-salvar]", host).onclick = async (event) => {
           if (!temPermissao) return;
           const btn = event.currentTarget;
           btn.disabled = true;
           btn.classList.add("is-loading");
           const liberar = () => { btn.disabled = false; btn.classList.remove("is-loading"); };
           const corpo = camposForm();
           if (!corpo.client_id) {
             erro.hidden = false; erro.textContent = "Informe o código do cliente (a busca na OLT ajuda a preencher).";
             liberar();
             return;
           }
           if (!corpo.nome) {
             erro.hidden = false; erro.textContent = "Informe o nome do cliente.";
             liberar();
             return;
           }
           try {
             if (ehEdicao && dados.client_id) {
               await NOC.api(`/api/clientes/${encodeURIComponent(dados.client_id)}`, { method: "PUT", body: JSON.stringify(corpo) });
             } else {
               await NOC.api("/api/clientes", { method: "POST", body: JSON.stringify(corpo) });
             }
             close();
             toast(ehEdicao ? "Cadastro atualizado" : "Cadastro criado", { type: "ok" });
             if (onSalvo) onSalvo();
             if (ehTela) carregar();
           } catch (error) {
             erro.hidden = false;
             erro.textContent = (error?.message || "Não foi possível salvar o cadastro.") + (error?.detail ? ` (${error.detail})` : "");
             liberar();
           }
         };
      },
    });
  }

  /* ---------------- montagem ---------------- */
  function mount() {
    /* Fora de /clientes.html este arquivo só empresta o modal de cadastro. Montar
       a casca aqui trocaria o provedor de busca global da tela anfitriã — o mapa
       GPON perdia a própria busca por uma lista de cadastros vazia. */
    if (!ehTela) return;
    UI.mountShell({ search: () => state.registros.slice(0, 200).map((r) => ({
      label: r.nome || r.client_id, meta: `${r.client_id} • ${r.telefone || "sem telefone"}`,
      icon: "users", action: () => abrirCadastro({ client_id: r.client_id }),
    })) });
    if (!$("#clienteSearchIcon")) return;
    $("#clienteSearchIcon").innerHTML = icon("search");
    $("#btnNovoCliente").onclick = () => abrirCadastro({}, "create");
    $("#clienteBusca").oninput = (e) => {
      state.q = e.target.value; state.page = 0; renderLista();
    };
    $("#clienteLimpar").onclick = () => {
      state.q = ""; state.status = "todos"; state.page = 0;
      $("#clienteBusca").value = ""; renderStatus(); renderLista();
    };
    $("#clientePrevPage").onclick = () => { state.page = Math.max(0, state.page - 1); renderLista(); };
    $("#clienteNextPage").onclick = () => { state.page += 1; renderLista(); };
    carregar();
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", mount); else mount();

  window.NOC_CLIENTES = { abrirCadastro };
})();