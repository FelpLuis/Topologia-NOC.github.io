/* ============================================================
   UPDOWN NOC — Painel de Tickets

   Registro de chamado de atendimento em duas naturezas, e a diferença
   entre elas é o vínculo que cada uma exige:

     · EXTERNO — o atendimento é no cliente, então o chamado só é aberto
       com um cliente do cadastro (/api/tickets/clientes);
     · INTERNO — o atendimento é na estrutura da operadora, então o
       chamado só é aberto com um local do cadastro único (POP, Data
       Center ou local ISP), que vem junto no bootstrap.

   O formulário mostra só o campo da natureza escolhida e trava o botão
   sem ele, mas quem garante a regra é o Worker: esta tela é o caminho
   confortável, não a fechadura.
   ============================================================ */
(() => {
  "use strict";
  const { $, $$, esc, icon, toast, modal, confirm: askConfirm } = UI;

  const SITUACOES = {
    aberto: { rotulo: "Aberto", cor: "#2563eb" },
    andamento: { rotulo: "Em andamento", cor: "#06b6d4" },
    pausado: { rotulo: "Pausado", cor: "#f59e0b" },
    resolvido: { rotulo: "Resolvido", cor: "#22c55e" },
    cancelado: { rotulo: "Cancelado", cor: "#64748b" },
  };
  const SITUACOES_ABERTAS = ["aberto", "andamento", "pausado"];
  const SITUACOES_FECHADAS = ["resolvido", "cancelado"];
  const PRIORIDADES = { baixa: "Baixa", normal: "Normal", alta: "Alta", critica: "Crítica" };
  const TIPOS = {
    externo: { rotulo: "Externo", cor: "#06b6d4", icone: "user" },
    interno: { rotulo: "Interno", cor: "#f59e0b", icone: "pops" },
  };
  const EVENTOS = {
    nota: "Nota", ligacao: "Ligação", visita: "Visita técnica",
    status: "Mudança de situação", sistema: "Sistema",
  };

  const state = { dados: null, tipo: "todos", situacao: "abertos", setor: "", responsavel: "", busca: "" };

  /* O agendamento é combinado com o cliente em horário de Brasília: é nele que
     a hora aparece na tela, que o campo é preenchido e que o que foi digitado
     vira UTC para o banco (ver noc-tempo.js). */
  const dataHora = (valor) => TEMPO.fmt(valor, { dateStyle: "short", timeStyle: "short" }, "Não agendado");
  const paraInput = (valor) => TEMPO.paraInput(valor);
  // Carimbo ilegível não vira atraso: sem data confiável, o cartão fica neutro.
  const atrasado = (t) => {
    if (SITUACOES_FECHADAS.includes(t.status)) return false;
    const quando = TEMPO.instante(t.agendado_para);
    return Boolean(quando) && quando < new Date();
  };

  const setores = () => state.dados?.sectors || [];
  const usuariosDoSetor = (id) => (state.dados?.users || []).filter((u) => String(u.sector_id) === String(id));
  const estruturas = () => state.dados?.estruturas || [];
  const podeFazer = (acao) => Boolean(state.dados?.can?.[acao]);
  const alvoDe = (t) => t.tipo === "externo"
    ? (t.cliente_nome || t.alvo_nome || "Cliente removido do cadastro")
    : (t.estrutura_nome || t.alvo_nome || "Estrutura removida do cadastro");

  /* ---------------- carga ---------------- */

  async function carregar(abrirDepois = null) {
    const host = $("#tkConteudo");
    NOC.skeleton(host, 5);
    try {
      state.dados = await NOC.api("/api/tickets");
      render();
      if (abrirDepois) await abrirDetalhe(abrirDepois);
    } catch (erro) {
      NOC.errorState(host, erro, () => carregar());
    }
  }

  function filtrados() {
    const termo = state.busca.trim().toLocaleLowerCase("pt-BR");
    return (state.dados?.tickets || []).filter((t) => {
      if (state.tipo !== "todos" && t.tipo !== state.tipo) return false;
      if (state.situacao === "abertos" && !SITUACOES_ABERTAS.includes(t.status)) return false;
      if (state.situacao === "fechados" && !SITUACOES_FECHADAS.includes(t.status)) return false;
      if (state.setor && String(t.sector_id) !== state.setor) return false;
      if (state.responsavel === "sem" && t.assigned_user_id != null) return false;
      if (state.responsavel && state.responsavel !== "sem"
        && String(t.assigned_user_id || "") !== state.responsavel) return false;
      if (termo && ![t.codigo, t.titulo, t.categoria, alvoDe(t), t.contato_nome, t.contato_telefone, t.endereco]
        .join(" ").toLocaleLowerCase("pt-BR").includes(termo)) return false;
      return true;
    });
  }

  /* ---------------- cabeçalho e filtros ---------------- */

  function renderKpis() {
    const todos = state.dados?.tickets || [];
    const abertos = todos.filter((t) => SITUACOES_ABERTAS.includes(t.status));
    const cartoes = [
      ["guide", abertos.length, "Chamados em aberto"],
      ["user", abertos.filter((t) => t.tipo === "externo").length, "Externos (no cliente)"],
      ["pops", abertos.filter((t) => t.tipo === "interno").length, "Internos (na estrutura)"],
      ["alert", abertos.filter(atrasado).length, "Agendamentos atrasados"],
    ];
    $("#tkKpis").innerHTML = cartoes.map(([ico, valor, rotulo]) => `
      <article class="card tk-kpi">
        <span class="tk-kpi-icon">${icon(ico)}</span>
        <div><strong>${esc(valor)}</strong><span>${esc(rotulo)}</span></div>
      </article>`).join("");
  }

  function renderTipoTabs() {
    const todos = state.dados?.tickets || [];
    const contar = (tipo) => todos.filter((t) => (tipo === "todos" || t.tipo === tipo)
      && SITUACOES_ABERTAS.includes(t.status)).length;
    const abas = [["todos", "Todos os chamados", "#64748b"],
      ["externo", "Externo — no cliente", TIPOS.externo.cor],
      ["interno", "Interno — na estrutura", TIPOS.interno.cor]];
    $("#tkTipoTabs").innerHTML = abas.map(([valor, rotulo, cor]) => `
      <button class="tk-tipo-tab" type="button" data-tipo="${esc(valor)}" style="--tipo:${esc(cor)}"
              aria-pressed="${state.tipo === valor}"><i></i>${esc(rotulo)} <b>${contar(valor)}</b></button>`).join("");
    $$("[data-tipo]", $("#tkTipoTabs")).forEach((botao) => botao.onclick = () => {
      state.tipo = botao.dataset.tipo;
      render();
    });
  }

  function renderFiltrosDeLista() {
    const setor = $("#tkSetor");
    setor.innerHTML = '<option value="">Todos os setores</option>'
      + setores().map((s) => `<option value="${s.id}" ${state.setor === String(s.id) ? "selected" : ""}>${esc(s.name)}</option>`).join("");
    const usuarios = state.setor ? usuariosDoSetor(state.setor) : (state.dados?.users || []);
    const unicos = [...new Map(usuarios.map((u) => [u.id, u])).values()];
    $("#tkResponsavel").innerHTML = '<option value="">Todos os responsáveis</option><option value="sem">Sem responsável</option>'
      + unicos.map((u) => `<option value="${u.id}" ${state.responsavel === String(u.id) ? "selected" : ""}>${esc(u.display_name)}</option>`).join("");
    if (state.responsavel === "sem") $("#tkResponsavel").value = "sem";
  }

  /* ---------------- quadro ---------------- */

  function cartao(t) {
    const tipo = TIPOS[t.tipo] || TIPOS.externo;
    return `<button class="tk-card" type="button" data-ticket="${t.id}">
      <span class="tk-card-top">
        <span class="tk-tipo ${esc(t.tipo)}">${icon(tipo.icone)}${esc(tipo.rotulo)}</span>
        <span class="tk-card-codigo">${esc(t.codigo)}</span>
      </span>
      <h3>${esc(t.titulo)}</h3>
      <p class="tk-card-alvo">${icon(tipo.icone)}${esc(alvoDe(t))}</p>
      <span class="tk-card-meta">
        <span class="tk-prioridade ${esc(t.prioridade)}">${esc(PRIORIDADES[t.prioridade] || t.prioridade)}</span>
        <span>${esc(t.assigned_name || "Sem responsável")}</span>
        <span class="tk-agenda ${atrasado(t) ? "is-atrasado" : ""}">${t.agendado_para ? icon("clock") + esc(dataHora(t.agendado_para)) : ""}</span>
      </span>
    </button>`;
  }

  const vazio = () => `<div class="card empty"><span class="empty-icon">${icon("filter")}</span>
    <b>Nenhum chamado encontrado</b><p>Ajuste os filtros ou registre um novo atendimento.</p></div>`;

  function renderQuadro() {
    const host = $("#tkConteudo");
    if (!setores().length) {
      host.innerHTML = `<div class="card empty"><span class="empty-icon">${icon("users")}</span>
        <b>Nenhum setor disponível</b>
        <p>Vincule seu usuário a um setor em Gerenciar plataforma para abrir e acompanhar chamados.</p></div>`;
      return;
    }
    const chamados = filtrados();
    const colunas = state.situacao === "abertos" ? SITUACOES_ABERTAS
      : state.situacao === "fechados" ? SITUACOES_FECHADAS
        : [...SITUACOES_ABERTAS, ...SITUACOES_FECHADAS];
    if (!chamados.length) { host.innerHTML = vazio(); return; }
    host.innerHTML = `<div class="tk-quadro">${colunas.map((codigo) => {
      const itens = chamados.filter((t) => t.status === codigo);
      const situacao = SITUACOES[codigo];
      return `<section class="tk-coluna">
        <div class="tk-coluna-head" style="--situacao:${esc(situacao.cor)}">
          <h2>${esc(situacao.rotulo)}</h2><span class="badge">${itens.length}</span>
        </div>
        <div class="tk-coluna-body">${itens.length ? itens.map(cartao).join("")
        : '<p class="tk-coluna-vazia">Nenhum chamado nesta situação</p>'}</div>
      </section>`;
    }).join("")}</div>`;
    $$("[data-ticket]", host).forEach((c) => c.onclick = () => abrirDetalhe(Number(c.dataset.ticket)));
  }

  function render() {
    renderTipoTabs();
    renderFiltrosDeLista();
    renderKpis();
    renderQuadro();
    if (state.dados?.can) $("#novoTicketBtn").disabled = !podeFazer("create");
  }

  /* ---------------- formulário ----------------
     A natureza é a primeira escolha porque é ela que decide qual vínculo
     obrigatório aparece: cliente (externo) ou estrutura (interno). */

  function formulario(ticket = null) {
    const edicao = Boolean(ticket);
    const setorInicial = String(ticket?.sector_id || state.setor || setores()[0]?.id || "");
    // O que já está escolhido: no modo edição vem do próprio chamado.
    const escolha = {
      tipo: ticket?.tipo || (state.tipo === "interno" ? "interno" : "externo"),
      cliente: ticket?.client_id
        ? { client_id: ticket.client_id, nome: ticket.cliente_nome || ticket.alvo_nome, endereco: ticket.endereco, telefone: ticket.cliente_telefone }
        : null,
      estrutura: ticket?.local_id || "",
    };

    modal({
      wide: true,
      labelledBy: "tkFormTitulo",
      html: `
        <div class="modal-head">
          <div>
            <span class="kicker">${edicao ? "Atualizar chamado" : "Novo chamado"}</span>
            <h2 id="tkFormTitulo">${edicao ? esc(ticket.codigo) + " — " + esc(ticket.titulo) : "Registrar atendimento"}</h2>
          </div>
          <button class="btn btn-ghost btn-icon" data-close type="button" aria-label="Fechar">${icon("close")}</button>
        </div>
        <div class="modal-body stack" style="gap:var(--s-4)">
          <div class="field">
            <label id="tkNaturezaLabel">Natureza do atendimento</label>
            <div class="tk-natureza" role="group" aria-labelledby="tkNaturezaLabel">
              ${Object.entries(TIPOS).map(([valor, meta]) => `
                <button class="tk-natureza-opcao" type="button" data-natureza="${valor}" style="--tipo:${meta.cor}">
                  ${icon(meta.icone)}
                  <span><b>${meta.rotulo}</b><span>${valor === "externo"
        ? "No cliente — exige o cadastro do cliente"
        : "Na estrutura — exige um POP, Data Center ou local ISP"}</span></span>
                </button>`).join("")}
            </div>
          </div>

          <div class="field" id="tkVinculoCampo"></div>

          <div class="tk-form-grid">
            <div class="field span-2">
              <label for="tkTitulo">Assunto</label>
              <input class="input" id="tkTitulo" maxlength="300" value="${esc(ticket?.titulo || "")}"
                     placeholder="Ex.: Sem conexão após queda de energia">
            </div>
            <div class="field">
              <label for="tkSetorForm">Setor responsável</label>
              <select class="select" id="tkSetorForm">${setores().map((s) => `<option value="${s.id}" ${String(s.id) === setorInicial ? "selected" : ""}>${esc(s.name)}</option>`).join("")}</select>
            </div>
            <div class="field">
              <label for="tkResponsavelForm">Responsável</label>
              <select class="select" id="tkResponsavelForm"></select>
            </div>
            <div class="field">
              <label for="tkPrioridade">Prioridade</label>
              <select class="select" id="tkPrioridade">${Object.entries(PRIORIDADES).map(([v, r]) => `<option value="${v}" ${v === (ticket?.prioridade || "normal") ? "selected" : ""}>${r}</option>`).join("")}</select>
            </div>
            <div class="field">
              <label for="tkSituacaoForm">Situação</label>
              <select class="select" id="tkSituacaoForm">${Object.entries(SITUACOES).map(([v, s]) => `<option value="${v}" ${v === (ticket?.status || "aberto") ? "selected" : ""}>${esc(s.rotulo)}</option>`).join("")}</select>
            </div>
            <div class="field">
              <label for="tkCategoria">Categoria</label>
              <input class="input" id="tkCategoria" maxlength="120" value="${esc(ticket?.categoria || "")}"
                     placeholder="Rompimento, manutenção, instalação…">
            </div>
            <div class="field">
              <label for="tkAgendado">Agendado para</label>
              <input class="input" id="tkAgendado" type="datetime-local" value="${paraInput(ticket?.agendado_para)}">
            </div>
            <div class="field">
              <label for="tkContatoNome">Contato no local</label>
              <input class="input" id="tkContatoNome" maxlength="200" value="${esc(ticket?.contato_nome || "")}">
            </div>
            <div class="field">
              <label for="tkContatoTelefone">Telefone do contato</label>
              <input class="input" id="tkContatoTelefone" maxlength="60" value="${esc(ticket?.contato_telefone || "")}">
            </div>
            <div class="field span-2">
              <label for="tkEndereco">Endereço do atendimento</label>
              <input class="input" id="tkEndereco" maxlength="500" value="${esc(ticket?.endereco || "")}"
                     placeholder="Preenchido pelo cadastro do cliente ou da estrutura, se ficar vazio">
            </div>
            <div class="field span-2">
              <label for="tkDescricao">Descrição</label>
              <textarea class="textarea" id="tkDescricao" rows="4">${esc(ticket?.descricao || "")}</textarea>
            </div>
            <span class="field-error span-2" id="tkFormErro" hidden></span>
          </div>
        </div>
        <div class="modal-foot"><span></span><span class="row">
          <button class="btn" data-close type="button">Cancelar</button>
          <button class="btn btn-primary" data-salvar type="button">${edicao ? "Salvar alterações" : "Abrir chamado"}</button>
        </span></div>`,
      onMount: (host, fechar) => {
        const erro = $("#tkFormErro", host);
        const campoSetor = $("#tkSetorForm", host);
        const campoResponsavel = $("#tkResponsavelForm", host);

        const preencherResponsaveis = () => {
          campoResponsavel.innerHTML = '<option value="">Sem responsável</option>'
            + usuariosDoSetor(campoSetor.value).map((u) => `<option value="${u.id}" ${String(u.id) === String(ticket?.assigned_user_id) ? "selected" : ""}>${esc(u.display_name)}</option>`).join("");
        };
        preencherResponsaveis();
        campoSetor.onchange = preencherResponsaveis;

        /* ---- vínculo obrigatório, redesenhado a cada troca de natureza ---- */
        const campoVinculo = $("#tkVinculoCampo", host);
        let buscaTimer = null;

        const clienteEscolhido = () => `
          <label>Cliente do atendimento</label>
          <div class="tk-escolhido">
            <span><b>${esc(escolha.cliente.nome || escolha.cliente.client_id)}</b>
              <small>${esc(escolha.cliente.endereco || "Sem endereço no cadastro")}</small></span>
            <button class="btn btn-ghost btn-sm" type="button" data-trocar-cliente>Trocar</button>
          </div>`;

        const clienteBusca = () => `
          <label for="tkClienteBusca">Cliente do atendimento</label>
          <div class="tk-cliente-busca">
            <input class="input" id="tkClienteBusca" type="search" autocomplete="off"
                   placeholder="Buscar por nome, CPF/CNPJ, telefone ou código do cliente">
            <div class="tk-cliente-lista" id="tkClienteLista"></div>
          </div>
          <small class="dim">Obrigatório: o atendimento externo acontece no endereço do cliente.</small>`;

        const estruturaCampo = () => `
          <label for="tkEstrutura">Estrutura do atendimento</label>
          <select class="select" id="tkEstrutura">
            <option value="">Selecione a estrutura…</option>
            ${estruturas().map((e) => `<option value="${esc(e.id)}" ${String(e.id) === String(escolha.estrutura) ? "selected" : ""}>${esc(e.nome || e.id)} — ${esc(e.tipo)}</option>`).join("")}
          </select>
          <small class="dim">Obrigatório: POP, Data Center ou local ISP do cadastro de locais.</small>`;

        async function buscarClientes(termo) {
          const lista = $("#tkClienteLista", host);
          if (!lista) return;
          try {
            const { clientes } = await NOC.api(`/api/tickets/clientes?q=${encodeURIComponent(termo)}`);
            lista.innerHTML = clientes.length
              ? clientes.map((c) => `<button class="tk-cliente-opcao" type="button" data-cliente="${esc(c.client_id)}">
                  <b>${esc(c.nome || c.client_id)}</b>
                  <small>${esc([c.cpf_cnpj, c.telefone, c.endereco].filter(Boolean).join(" • ") || "Sem dados de contato")}</small>
                </button>`).join("")
              : '<p class="dim" style="padding:8px 10px">Nenhum cliente encontrado nesta busca.</p>';
            $$("[data-cliente]", lista).forEach((botao) => botao.onclick = () => {
              escolha.cliente = clientes.find((c) => String(c.client_id) === botao.dataset.cliente) || null;
              // O endereço do cadastro é sugestão: fica editável no formulário.
              const campoEndereco = $("#tkEndereco", host);
              if (escolha.cliente && !campoEndereco.value.trim()) campoEndereco.value = escolha.cliente.endereco || "";
              renderVinculo();
            });
          } catch (falha) {
            lista.innerHTML = `<p class="dim" style="padding:8px 10px">${esc(falha.message)}</p>`;
          }
        }

        function renderVinculo() {
          if (escolha.tipo === "interno") {
            campoVinculo.innerHTML = estruturaCampo();
            $("#tkEstrutura", host).onchange = (evento) => {
              escolha.estrutura = evento.target.value;
              const estrutura = estruturas().find((e) => String(e.id) === escolha.estrutura);
              const campoEndereco = $("#tkEndereco", host);
              if (estrutura && !campoEndereco.value.trim()) campoEndereco.value = estrutura.endereco || "";
            };
            return;
          }
          campoVinculo.innerHTML = escolha.cliente ? clienteEscolhido() : clienteBusca();
          $("[data-trocar-cliente]", host)?.addEventListener("click", () => {
            escolha.cliente = null;
            renderVinculo();
            $("#tkClienteBusca", host)?.focus();
          });
          const busca = $("#tkClienteBusca", host);
          if (!busca) return;
          busca.oninput = (evento) => {
            clearTimeout(buscaTimer);
            const termo = evento.target.value;
            buscaTimer = setTimeout(() => buscarClientes(termo), 220);
          };
          // Sem busca ainda: já mostra os primeiros cadastros, para o caso comum
          // de o operador estar com o cliente na frente e não saber o código.
          buscarClientes("");
        }

        const marcarNatureza = () => $$("[data-natureza]", host).forEach((botao) =>
          botao.setAttribute("aria-pressed", String(botao.dataset.natureza === escolha.tipo)));
        $$("[data-natureza]", host).forEach((botao) => botao.onclick = () => {
          escolha.tipo = botao.dataset.natureza;
          marcarNatureza();
          renderVinculo();
        });
        marcarNatureza();
        renderVinculo();

        $("[data-salvar]", host).onclick = async (evento) => {
          const agendado = $("#tkAgendado", host).value;
          const corpo = {
            tipo: escolha.tipo,
            client_id: escolha.tipo === "externo" ? (escolha.cliente?.client_id || "") : null,
            local_id: escolha.tipo === "interno" ? escolha.estrutura : null,
            sector_id: Number(campoSetor.value),
            assigned_user_id: campoResponsavel.value ? Number(campoResponsavel.value) : null,
            titulo: $("#tkTitulo", host).value.trim(),
            categoria: $("#tkCategoria", host).value.trim(),
            prioridade: $("#tkPrioridade", host).value,
            status: $("#tkSituacaoForm", host).value,
            contato_nome: $("#tkContatoNome", host).value.trim(),
            contato_telefone: $("#tkContatoTelefone", host).value.trim(),
            endereco: $("#tkEndereco", host).value.trim(),
            descricao: $("#tkDescricao", host).value.trim(),
            agendado_para: agendado ? TEMPO.deInput(agendado)?.toISOString() ?? null : null,
          };
          const falta = !corpo.titulo ? "Informe o assunto do chamado."
            : corpo.tipo === "externo" && !corpo.client_id ? "Atendimento externo: escolha o cliente."
              : corpo.tipo === "interno" && !corpo.local_id ? "Atendimento interno: escolha a estrutura."
                : "";
          if (falta) { erro.hidden = false; erro.textContent = falta; return; }
          evento.currentTarget.disabled = true;
          try {
            const salvo = await NOC.api(edicao ? `/api/tickets/${ticket.id}` : "/api/tickets",
              { method: edicao ? "PATCH" : "POST", body: JSON.stringify(corpo) });
            fechar();
            /* Um chamado que nasce fora do filtro atual não pode sumir da tela: o
               filtro cede ao registro que acabou de ser salvo, não o contrário. */
            if (state.setor && String(salvo.sector_id) !== state.setor) state.setor = String(salvo.sector_id);
            if (state.tipo !== "todos" && state.tipo !== salvo.tipo) state.tipo = "todos";
            await carregar(salvo.id);
            toast(edicao ? "Chamado atualizado" : `Chamado ${salvo.codigo} aberto`, { type: "ok" });
          } catch (falha) {
            erro.hidden = false;
            erro.textContent = falha.message;
            evento.currentTarget.disabled = false;
          }
        };
      },
    });
  }

  /* ---------------- detalhe ---------------- */

  async function abrirDetalhe(id) {
    let detalhe;
    try {
      detalhe = await NOC.api(`/api/tickets/${id}`);
    } catch (falha) {
      toast("Não foi possível abrir o chamado", { text: falha.message, type: "danger" });
      return;
    }
    const t = detalhe.ticket, eventos = detalhe.eventos || [];
    const tipo = TIPOS[t.tipo] || TIPOS.externo;
    const situacao = SITUACOES[t.status] || SITUACOES.aberto;

    modal({
      wide: true,
      labelledBy: "tkDetalheTitulo",
      html: `
        <div class="modal-head">
          <div>
            <span class="kicker">${esc(t.codigo)} · ${esc(t.sector_name)}</span>
            <h2 id="tkDetalheTitulo">${esc(t.titulo)}</h2>
            <p class="dim">${esc(tipo.rotulo === "Externo" ? "Atendimento no cliente" : "Atendimento na estrutura")} — ${esc(alvoDe(t))}</p>
          </div>
          <button class="btn btn-ghost btn-icon" data-close type="button" aria-label="Fechar">${icon("close")}</button>
        </div>
        <div class="modal-body tk-modal-layout">
          <div class="stack">
            <div class="row wrap" style="gap:var(--s-2)">
              <span class="tk-tipo ${esc(t.tipo)}">${icon(tipo.icone)}${esc(tipo.rotulo)}</span>
              <span class="badge" style="border-color:${esc(situacao.cor)}">${esc(situacao.rotulo)}</span>
              <span class="tk-prioridade ${esc(t.prioridade)}">Prioridade ${esc(PRIORIDADES[t.prioridade] || t.prioridade)}</span>
              ${t.categoria ? `<span class="badge">${esc(t.categoria)}</span>` : ""}
            </div>
            <div class="tk-detalhe-grid">
              <div class="tk-detalhe-item"><small>${t.tipo === "externo" ? "Cliente" : "Estrutura"}</small><b>${esc(alvoDe(t))}</b></div>
              <div class="tk-detalhe-item"><small>Responsável</small><b>${esc(t.assigned_name || "Sem responsável")}</b></div>
              <div class="tk-detalhe-item"><small>Agendado para</small><b class="${atrasado(t) ? "tk-agenda is-atrasado" : ""}">${esc(dataHora(t.agendado_para))}</b></div>
              <div class="tk-detalhe-item"><small>Contato</small><b>${esc(t.contato_nome || "Não informado")}</b></div>
              <div class="tk-detalhe-item"><small>Telefone</small><b>${esc(t.contato_telefone || t.cliente_telefone || "Não informado")}</b></div>
              <div class="tk-detalhe-item"><small>Aberto por</small><b>${esc(t.creator_name)}</b></div>
            </div>
            ${t.endereco ? `<div><small class="dim">Endereço do atendimento</small><p>${esc(t.endereco)}</p></div>` : ""}
            ${t.descricao ? `<div><small class="dim">Descrição</small><p style="white-space:pre-wrap">${esc(t.descricao)}</p></div>` : ""}
            ${podeFazer("edit") ? `<div class="field"><label for="tkSituacaoRapida">Mudar a situação</label>
              <select class="select" id="tkSituacaoRapida">${Object.entries(SITUACOES).map(([v, s]) => `<option value="${v}" ${v === t.status ? "selected" : ""}>${esc(s.rotulo)}</option>`).join("")}</select></div>` : ""}
          </div>
          <aside class="stack">
            <div><h3>Andamento</h3><p class="dim">Tudo que já foi feito neste chamado.</p></div>
            ${podeFazer("interact") ? `<div class="field">
              <label for="tkEventoTipo">Registrar andamento</label>
              <select class="select" id="tkEventoTipo">
                <option value="nota">Nota</option><option value="ligacao">Ligação</option><option value="visita">Visita técnica</option>
              </select>
              <textarea class="textarea" id="tkEventoTexto" rows="3" placeholder="O que foi feito ou o que ficou combinado"></textarea>
              <button class="btn" data-novo-evento type="button">${icon("plus")} Adicionar ao andamento</button>
            </div>` : ""}
            <div class="tk-linha-tempo">${eventos.length
        ? eventos.map((e) => `<article class="tk-evento">
            <small>${esc(EVENTOS[e.tipo] || e.tipo)} · ${esc(e.user_name)} · ${esc(dataHora(e.created_at))}</small>
            <p>${esc(e.body)}</p></article>`).join("")
        : '<p class="dim">Nenhum andamento registrado.</p>'}</div>
          </aside>
        </div>
        <div class="modal-foot">
          <span>${podeFazer("delete") ? '<button class="btn btn-danger" data-excluir type="button">Excluir</button>' : ""}</span>
          <span class="row">${podeFazer("edit") ? '<button class="btn" data-editar type="button">Editar dados</button>' : ""}
            <button class="btn btn-primary" data-close type="button">Fechar</button></span>
        </div>`,
      onMount: (host, fechar) => {
        $("[data-editar]", host)?.addEventListener("click", () => { fechar(); formulario(t); });

        $("#tkSituacaoRapida", host)?.addEventListener("change", async (evento) => {
          try {
            await NOC.api(`/api/tickets/${id}`, { method: "PATCH", body: JSON.stringify({ status: evento.target.value }) });
            fechar();
            await carregar(id);
            toast("Situação atualizada", { type: "ok" });
          } catch (falha) {
            toast("Não foi possível mudar a situação", { text: falha.message, type: "danger" });
          }
        });

        $("[data-novo-evento]", host)?.addEventListener("click", async () => {
          const texto = $("#tkEventoTexto", host).value.trim();
          if (!texto) { toast("Descreva o andamento", { type: "info" }); return; }
          try {
            await NOC.api(`/api/tickets/${id}/eventos`, {
              method: "POST",
              body: JSON.stringify({ tipo: $("#tkEventoTipo", host).value, body: texto }),
            });
            fechar();
            await carregar(id);
            toast("Andamento registrado", { type: "ok" });
          } catch (falha) {
            toast("Não foi possível registrar", { text: falha.message, type: "danger" });
          }
        });

        $("[data-excluir]", host)?.addEventListener("click", () => askConfirm({
          title: "Excluir este chamado?",
          text: `${t.codigo} e todo o histórico de andamento serão removidos permanentemente.`,
          confirmLabel: "Excluir",
          danger: true,
          onConfirm: async () => {
            try {
              await NOC.api(`/api/tickets/${id}`, { method: "DELETE" });
              fechar();
              await carregar();
              toast("Chamado excluído", { type: "ok" });
            } catch (falha) {
              toast("Não foi possível excluir", { text: falha.message, type: "danger" });
            }
          },
        }));
      },
    });
  }

  /* ---------------- partida ---------------- */

  async function boot() {
    UI.mountShell({
      search: () => (state.dados?.tickets || []).slice(0, 200).map((t) => ({
        label: `${t.codigo} — ${t.titulo}`,
        meta: `${TIPOS[t.tipo]?.rotulo || t.tipo} • ${alvoDe(t)}`,
        icon: "guide",
        action: () => abrirDetalhe(t.id),
      })),
    });
    $("#novoTicketBtn").innerHTML = icon("plus") + " Novo chamado";
    $("#tkBuscaIcon").innerHTML = icon("search");
    $("#tkAtualizar").innerHTML = icon("refresh");

    $("#novoTicketBtn").onclick = () => formulario();
    $("#tkAtualizar").onclick = () => carregar();
    $("#tkSituacao").onchange = (e) => { state.situacao = e.target.value; renderQuadro(); };
    $("#tkSetor").onchange = (e) => { state.setor = e.target.value; state.responsavel = ""; render(); };
    $("#tkResponsavel").onchange = (e) => { state.responsavel = e.target.value; renderQuadro(); };
    let timer;
    $("#tkBusca").oninput = (e) => {
      clearTimeout(timer);
      const valor = e.target.value;
      timer = setTimeout(() => { state.busca = valor; renderQuadro(); }, 180);
    };

    try {
      await NOC.loadAccess();
      NOC.applyActions();
      await carregar();
    } catch (erro) {
      NOC.errorState($("#tkConteudo"), erro, () => boot());
    }
  }

  boot();
})();
