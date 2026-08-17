/* ============================================================
   UPDOWN NOC — Tráfego das interfaces
   Lê o espelho do Zabbix no D1 (/api/zabbix/*). Nada é calculado
   aqui além de utilização e agregados: os números vêm do SNMP.
   ============================================================ */
(() => {
  "use strict";
  const { $, $$, esc, icon, toast } = UI;

  const RECARGA_MS = 60000;

  const state = {
    interfaces: [],
    links: [],
    status: null,
    filtro: { equipamento: "", status: "", busca: "" },
    ordenacao: {
      links: { chave: "utilizacao", direcao: "desc" },
      interfaces: { chave: "utilizacao", direcao: "desc" },
    },
    timer: null,
  };

  const collator = new Intl.Collator("pt-BR", { numeric: true, sensitivity: "base" });

  /* in_bps/out_bps e speed_bps vêm em bits/s. A utilização usa o sentido mais
     carregado, que é como a operação enxerga saturação de enlace. */
  const carga = (i) => Math.max(Number(i.in_bps) || 0, Number(i.out_bps) || 0);

  /* Tráfego acima da capacidade nominal é fisicamente impossível: indica falha
     de coleta, não saturação. As portas GPON da OLT C300 chegam a reportar
     1,8 Tbps numa porta de 2,488 Gbps. Leitura assim fica fora dos totais e é
     marcada na tabela, em vez de inflar os agregados em vários Tbps. */
  const TOLERANCIA = 1.05;

  function leituraValida(i) {
    const cap = Number(i.speed_bps) || 0;
    if (!cap) return true;                 // sem capacidade nominal, nada a checar
    return carga(i) <= cap * TOLERANCIA;
  }

  function utilizacao(i) {
    const cap = Number(i.speed_bps) || 0;
    if (!cap) return null;
    if (!leituraValida(i)) return null;
    return Math.min((carga(i) / cap) * 100, 100);
  }

  const classeUtil = (u) => (u === null ? "" : u > 85 ? "is-danger" : u > 70 ? "is-warn" : "");

  function medidor(u, invalida = false) {
    if (invalida) {
      return `<span class="badge badge-warn" title="Tráfego informado acima da capacidade da porta: falha de coleta no Zabbix.">inconsistente</span>`;
    }
    if (u === null) return '<small class="dim">—</small>';
    return `<span class="row" style="gap:8px;align-items:center">
      <span class="meter meter-sm ${classeUtil(u)}" style="width:70px"><span style="width:${u.toFixed(1)}%"></span></span>
      <small class="mono">${u.toFixed(1)}%</small>
    </span>`;
  }

  const bps = (v) => NOC.formatBps(v);

  function cabecalhoOrdenavel(escopo, chave, rotulo) {
    const ativa = state.ordenacao[escopo];
    const selecionada = ativa.chave === chave;
    const ordem = selecionada ? (ativa.direcao === "asc" ? "ascending" : "descending") : "none";
    const proxima = selecionada && ativa.direcao === "asc" ? "decrescente" : "crescente";
    return `<th aria-sort="${ordem}"><button class="table-sort" type="button"
      data-sort-scope="${escopo}" data-sort-key="${chave}" aria-sort="${ordem}"
      aria-label="Ordenar por ${esc(rotulo)} em ordem ${proxima}">${esc(rotulo)}${icon("sort")}</button></th>`;
  }

  function compararValores(a, b, direcao) {
    const vazioA = a === null || a === undefined || a === "";
    const vazioB = b === null || b === undefined || b === "";
    if (vazioA || vazioB) {
      if (vazioA && vazioB) return 0;
      return vazioA ? 1 : -1;
    }
    const resultado = typeof a === "number" && typeof b === "number"
      ? a - b
      : collator.compare(String(a), String(b));
    return direcao === "asc" ? resultado : -resultado;
  }

  function ordenar(lista, escopo, valor) {
    const { chave, direcao } = state.ordenacao[escopo];
    return lista.slice().sort((a, b) => compararValores(valor(a, chave), valor(b, chave), direcao));
  }

  function alternarOrdenacao(escopo, chave) {
    const atual = state.ordenacao[escopo];
    if (atual.chave === chave) atual.direcao = atual.direcao === "asc" ? "desc" : "asc";
    else state.ordenacao[escopo] = { chave, direcao: "asc" };
    if (escopo === "links") renderLinks();
    else renderTabela();
  }

  const chaveLink = (l) => [
    `${l.a.hostid}:${l.a.interface}`,
    `${l.b.hostid}:${l.b.interface}`,
  ].sort().join("|");

  function pontaNaTopologia(ponta) {
    const equipamento = (NOC.data()?.equipamentos || []).find((e) => e.id === ponta.equipamento_id);
    if (!equipamento) return null;
    const porta = (equipamento.portas || []).find((p) =>
      p.nome === ponta.interface ||
      (String(p.zabbix?.hostid || "") === String(ponta.hostid) && p.descricao === ponta.descricao)
    );
    return porta ? { equipamento, porta } : null;
  }

  function conexaoDoLink(l) {
    const a = pontaNaTopologia(l.a);
    const b = pontaNaTopologia(l.b);
    if (!a || !b) return { a, b, conexao: null };
    const conexao = (NOC.data()?.conexoes || []).find((c) =>
      (c.origem === a.equipamento.id && Number(c.portaOrigem) === Number(a.porta.numero) &&
       c.destino === b.equipamento.id && Number(c.portaDestino) === Number(b.porta.numero)) ||
      (c.origem === b.equipamento.id && Number(c.portaOrigem) === Number(b.porta.numero) &&
       c.destino === a.equipamento.id && Number(c.portaDestino) === Number(a.porta.numero))
    ) || null;
    return { a, b, conexao };
  }

  function dadosEditaveisLink(l) {
    const { conexao } = conexaoDoLink(l);
    return {
      tipo: conexao?.tipo || l.tipo || "Enlace",
      capacidade: conexao?.capacidade || l.capacidade || "A confirmar",
      descricao: conexao?.descricao || l.a.descricao || l.b.descricao || "",
    };
  }

  function capacidadeEmBps(valor) {
    const texto = String(valor || "").replace(",", ".");
    const achou = texto.match(/([\d.]+)\s*([kmgt]?bps)/i);
    if (!achou) return 0;
    const fatores = { bps: 1, kbps: 1e3, mbps: 1e6, gbps: 1e9, tbps: 1e12 };
    return (Number(achou[1]) || 0) * (fatores[achou[2].toLowerCase()] || 1);
  }

  /* ---------------- KPIs ---------------- */
  function renderKpis() {
    const ifs = state.interfaces;
    const up = ifs.filter((i) => i.oper_status === 1);
    const validas = ifs.filter(leituraValida);
    const invalidas = ifs.length - validas.length;

    const entrada = validas.reduce((a, i) => a + (Number(i.in_bps) || 0), 0);
    const saida = validas.reduce((a, i) => a + (Number(i.out_bps) || 0), 0);
    const erros = ifs.reduce((a, i) => a + (Number(i.in_errors) || 0) + (Number(i.out_errors) || 0), 0);
    const saturadas = validas.filter((i) => {
      const u = utilizacao(i);
      return u !== null && u > 70;
    }).length;

    $("#kpis").innerHTML = `
      <div><label>Entrada total</label><strong>${esc(bps(entrada))}</strong></div>
      <div><label>Saída total</label><strong>${esc(bps(saida))}</strong></div>
      <div><label>Interfaces up</label><strong>${up.length}<span class="unit"> / ${ifs.length}</span></strong></div>
      <div><label>Acima de 70%</label><strong>${saturadas}</strong></div>
      <div><label>Erros acumulados</label><strong>${erros.toLocaleString("pt-BR")}</strong></div>
      <div><label>Enlaces confirmados</label><strong>${state.links.length}</strong></div>`;

    const run = state.status?.last_run;
    const quando = run
      ? `Última sincronização: ${new Date((run.finished_at || run.started_at).replace(" ", "T") + "Z").toLocaleString("pt-BR")} • ${run.hosts_count} hosts, ${run.interfaces_count} interfaces.`
      : "Nenhuma sincronização registrada ainda.";
    $("#syncInfo").textContent = invalidas
      ? `${quando} ${invalidas} interface(s) reportaram tráfego acima da capacidade da porta e ficaram fora dos totais.`
      : quando;
  }

  /* ---------------- enlaces ---------------- */
  function renderLinks() {
    const alta = state.links.filter((l) => l.confianca === "alta").length;
    $("#cntAlta").textContent = `${alta} confirmação mútua`;
    $("#cntMedia").textContent = `${state.links.length - alta} um lado só`;

    if (!state.links.length) {
      $("#links").innerHTML = `<div class="empty"><b>Nenhum enlace derivado</b>
        <p>Sincronize o Zabbix para que as descrições de interface sejam lidas.</p></div>`;
      return;
    }

    const linha = (l) => {
      const u = Math.max(utilizacao(l.a) ?? 0, utilizacao(l.b) ?? 0);
      const ambosUp = l.a.oper_status === 1 && l.b.oper_status === 1;
      const rotulo = (p) => esc(p.equipamento_id || p.host || "—");
      const dados = dadosEditaveisLink(l);
      const mapeamento = conexaoDoLink(l);
      const existente = !!mapeamento.conexao;
      const podeMapear = !!mapeamento.a && !!mapeamento.b;
      const acoes = existente
        ? "topology.edit topology.link.create topology.delete topology.link.delete"
        : "topology.edit topology.port.edit topology.link.create";
      return `<tr>
        <td>
          <div class="row" style="gap:8px;align-items:center">
            <span class="dot ${ambosUp ? "dot-ok" : "dot-danger"}"></span>
            <span><strong>${rotulo(l.a)}</strong> <small class="mono dim">${esc(l.a.interface)}</small></span>
          </div>
        </td>
        <td>
          <div><strong>${rotulo(l.b)}</strong> <small class="mono dim">${esc(l.b.interface)}</small></div>
        </td>
        <td><span class="badge">${esc(dados.capacidade)}</span></td>
        <td>${esc(dados.tipo)}</td>
        <td class="mono">${esc(bps(l.a.in_bps))}</td>
        <td class="mono">${esc(bps(l.a.out_bps))}</td>
        <td>${medidor(u || null)}</td>
        <td><span class="badge ${l.confianca === "alta" ? "badge-ok" : "badge-warn"}">${esc(l.confianca)}</span></td>
        <td><button class="btn btn-sm" type="button" data-edit-link="${esc(chaveLink(l))}"
          ${podeMapear ? `data-action="${acoes}"` : "disabled title='Use os enlaces na topologia antes de editar'"}>
          ${icon("edit")} Editar</button></td>
      </tr>`;
    };

    const valorLink = (l, chave) => ({
      pontaA: l.a.equipamento_id || l.a.host || "",
      pontaB: l.b.equipamento_id || l.b.host || "",
      capacidade: capacidadeEmBps(dadosEditaveisLink(l).capacidade),
      tipo: dadosEditaveisLink(l).tipo,
      entrada: Number(l.a.in_bps) || 0,
      saida: Number(l.a.out_bps) || 0,
      utilizacao: Math.max(utilizacao(l.a) ?? 0, utilizacao(l.b) ?? 0),
      confianca: l.confianca || "",
    })[chave];

    const lista = ordenar(state.links, "links", valorLink);

    $("#links").innerHTML = `<div class="table-wrap"><table class="table">
      <thead><tr>
        ${cabecalhoOrdenavel("links", "pontaA", "Ponta A")}
        ${cabecalhoOrdenavel("links", "pontaB", "Ponta B")}
        ${cabecalhoOrdenavel("links", "capacidade", "Capacidade")}
        ${cabecalhoOrdenavel("links", "tipo", "Tipo")}
        ${cabecalhoOrdenavel("links", "entrada", "Entrada (A)")}
        ${cabecalhoOrdenavel("links", "saida", "Saída (A)")}
        ${cabecalhoOrdenavel("links", "utilizacao", "Utilização")}
        ${cabecalhoOrdenavel("links", "confianca", "Confiança")}
        <th>Ações</th>
      </tr></thead>
      <tbody>${lista.map(linha).join("")}</tbody>
    </table></div>`;
    NOC.applyActions($("#links"));
  }

  function editarLink(l) {
    const { a, b, conexao } = conexaoDoLink(l);
    if (!a || !b) {
      toast("Enlace ainda não está disponível para edição", {
        text: "Use “Usar enlaces na topologia” para mapear as interfaces primeiro.", type: "warn",
      });
      return;
    }

    const dados = dadosEditaveisLink(l);
    UI.modal({
      labelledBy: "editLinkTitle",
      html: `
        <div class="modal-head">
          <div><span class="kicker">Enlace do tráfego</span>
            <h2 id="editLinkTitle" style="margin-top:6px">Editar conexão</h2>
            <p class="muted" style="font-size:var(--fs-13);margin-top:4px">
              ${esc(a.equipamento.nome)} • ${esc(l.a.interface)} ↔ ${esc(b.equipamento.nome)} • ${esc(l.b.interface)}
            </p></div>
          <button class="btn btn-ghost btn-icon" data-close type="button" aria-label="Fechar">${icon("close")}</button>
        </div>
        <div class="modal-body">
          <form class="stack" id="trafficLinkForm">
            <div class="row" style="gap:var(--s-3);align-items:flex-start">
              <div class="field grow"><label for="trafficLinkType">Tipo do enlace</label>
                <input class="input" id="trafficLinkType" value="${esc(dados.tipo)}" placeholder="Ex.: Uplink, Transporte"></div>
              <div class="field grow"><label for="trafficLinkCapacity">Capacidade</label>
                <input class="input" id="trafficLinkCapacity" value="${esc(dados.capacidade)}" placeholder="Ex.: 10 Gbps"></div>
            </div>
            <div class="field"><label for="trafficLinkDescription">Observação</label>
              <input class="input" id="trafficLinkDescription" value="${esc(dados.descricao)}" placeholder="Circuito, operadora ou referência operacional"></div>
            <div class="alert alert-info" style="animation:none">${icon("info")}
              <span>As pontas vêm do inventário do Zabbix. Aqui você edita os dados documentais da conexão na topologia.</span></div>
          </form>
        </div>
        <div class="modal-foot">
          <span class="dim" style="font-size:var(--fs-11)">${conexao ? "A alteração" : "O novo enlace"} será registrado na auditoria.</span>
          <span class="row"><button class="btn" data-close type="button">Cancelar</button>
            <button class="btn btn-primary" data-save-link type="button">Salvar conexão</button></span>
        </div>`,
      onMount: (host, close) => {
        $("#trafficLinkForm", host).onsubmit = (e) => { e.preventDefault(); $("[data-save-link]", host).click(); };
        $("[data-save-link]", host).onclick = async () => {
          const botao = $("[data-save-link]", host);
          const topologia = NOC.data();
          const antesConexoes = topologia.conexoes.map((c) => ({ ...c }));
          const statusA = a.porta.status;
          const statusB = b.porta.status;
          const ocupadaA = NOC.portConnection(a.equipamento.id, a.porta.numero);
          const ocupadaB = NOC.portConnection(b.equipamento.id, b.porta.numero);
          if ((!conexao && ocupadaA) || (!conexao && ocupadaB)) {
            toast("Uma das portas já está ocupada", { text: "Revise o enlace na topologia antes de salvá-lo.", type: "warn" });
            return;
          }

          const atualizada = {
            ...(conexao || {}),
            origem: conexao?.origem || a.equipamento.id,
            portaOrigem: conexao?.portaOrigem || Number(a.porta.numero),
            destino: conexao?.destino || b.equipamento.id,
            portaDestino: conexao?.portaDestino || Number(b.porta.numero),
            tipo: $("#trafficLinkType", host).value.trim() || "Enlace",
            capacidade: $("#trafficLinkCapacity", host).value.trim() || "A confirmar",
            descricao: $("#trafficLinkDescription", host).value.trim(),
            fonte: conexao?.fonte || "manual-trafego",
            confianca: conexao?.confianca || l.confianca,
          };

          if (conexao) topologia.conexoes[topologia.conexoes.indexOf(conexao)] = atualizada;
          else {
            topologia.conexoes.push(atualizada);
            a.porta.status = "conectada";
            b.porta.status = "conectada";
          }

          botao.disabled = true;
          botao.textContent = "Salvando…";
          try {
            await NOC.save(conexao ? "TOPOLOGY_UPDATE_CONEXAO_TRAFEGO" : "TOPOLOGY_CREATE_CONEXAO_TRAFEGO");
            close();
            renderLinks();
            toast("Conexão salva", { text: "Os dados do enlace foram atualizados na topologia.", type: "ok" });
          } catch (err) {
            topologia.conexoes = antesConexoes;
            a.porta.status = statusA;
            b.porta.status = statusB;
            botao.disabled = false;
            botao.textContent = "Salvar conexão";
            toast("Não foi possível salvar a conexão", { text: err.message, type: "danger" });
          }
        };
      },
    });
  }

  /* ---------------- tabela de interfaces ---------------- */
  function filtradas() {
    const { equipamento, status, busca } = state.filtro;
    const alvo = busca.trim().toLowerCase();
    const lista = state.interfaces.filter((i) => {
      if (equipamento && i.equipamento_id !== equipamento) return false;
      if (status === "up" && i.oper_status !== 1) return false;
      if (status === "down" && i.oper_status !== 2) return false;
      if (alvo && !`${i.if_name} ${i.if_alias}`.toLowerCase().includes(alvo)) return false;
      return true;
    });
    const valorInterface = (i, chave) => ({
      equipamento: i.equipamento_id || i.host_name || "",
      interface: i.if_name || "",
      descricao: i.if_alias || "",
      status: Number(i.oper_status) || 0,
      capacidade: Number(i.speed_bps) || 0,
      entrada: Number(i.in_bps) || 0,
      saida: Number(i.out_bps) || 0,
      utilizacao: utilizacao(i),
      erros: (Number(i.in_errors) || 0) + (Number(i.out_errors) || 0),
    })[chave];
    return ordenar(lista, "interfaces", valorInterface);
  }

  function renderTabela() {
    const lista = filtradas();
    if (!lista.length) {
      $("#tabela").innerHTML = `<div class="empty"><b>Nenhuma interface</b>
        <p>Ajuste os filtros para ver outras interfaces.</p></div>`;
      return;
    }

    const linha = (i) => {
      const u = utilizacao(i);
      const st = NOC.interfaceStatus(i);
      const erros = (Number(i.in_errors) || 0) + (Number(i.out_errors) || 0);
      const invalida = !leituraValida(i);
      return `<tr>
        <td>${esc(i.equipamento_id || i.host_name || "—")}</td>
        <td class="mono">${esc(i.if_name)}</td>
        <td>${i.if_alias ? esc(i.if_alias) : '<small class="dim">sem descrição</small>'}</td>
        <td><span class="row" style="gap:6px;align-items:center"><span class="dot ${st.dot}"></span>${esc(st.label)}</span></td>
        <td class="mono">${esc(bps(i.speed_bps))}</td>
        <td class="mono${invalida ? " dim" : ""}">${esc(bps(i.in_bps))}</td>
        <td class="mono${invalida ? " dim" : ""}">${esc(bps(i.out_bps))}</td>
        <td>${medidor(u, invalida)}</td>
        <td class="mono ${erros ? "" : "dim"}">${erros.toLocaleString("pt-BR")}</td>
      </tr>`;
    };

    $("#tabela").innerHTML = `
      <div class="table-wrap"><table class="table">
        <thead><tr>
          ${cabecalhoOrdenavel("interfaces", "equipamento", "Equipamento")}
          ${cabecalhoOrdenavel("interfaces", "interface", "Interface")}
          ${cabecalhoOrdenavel("interfaces", "descricao", "Descrição")}
          ${cabecalhoOrdenavel("interfaces", "status", "Status")}
          ${cabecalhoOrdenavel("interfaces", "capacidade", "Capacidade")}
          ${cabecalhoOrdenavel("interfaces", "entrada", "Entrada")}
          ${cabecalhoOrdenavel("interfaces", "saida", "Saída")}
          ${cabecalhoOrdenavel("interfaces", "utilizacao", "Utilização")}
          ${cabecalhoOrdenavel("interfaces", "erros", "Erros")}
        </tr></thead>
        <tbody>${lista.slice(0, 300).map(linha).join("")}</tbody>
      </table></div>
      <p class="dim" style="margin-top:var(--s-3);font-size:var(--fs-11)">
        Exibindo ${Math.min(lista.length, 300)} de ${lista.length} interfaces.</p>`;
  }

  function renderFiltroEquip() {
    const atual = state.filtro.equipamento;
    const ids = [...new Set(state.interfaces.map((i) => i.equipamento_id).filter(Boolean))].sort();
    $("#fEquip").innerHTML = `<option value="">Todos os equipamentos</option>` +
      ids.map((id) => `<option value="${esc(id)}" ${id === atual ? "selected" : ""}>${esc(id)}</option>`).join("");
  }

  function render() {
    renderKpis();
    renderLinks();
    renderTabela();
  }

  /* ---------------- dados ---------------- */
  async function carregar() {
    const [interfaces, links, status] = await Promise.all([
      NOC.zabbix.interfaces({ limit: 2000 }),
      NOC.zabbix.links(),
      NOC.zabbix.status(),
    ]);
    state.interfaces = Array.isArray(interfaces) ? interfaces : [];
    state.links = links?.links || [];
    state.status = status;
  }

  function agendar() {
    clearInterval(state.timer);
    if (!$("#autoRefresh").checked) return;
    state.timer = setInterval(async () => {
      try {
        await carregar();
        render();
      } catch (err) {
        // Falha de recarga não derruba a tela: o próximo ciclo tenta de novo.
        console.error("Recarga do tráfego falhou:", err);
      }
    }, RECARGA_MS);
  }

  async function sincronizar() {
    const btn = $("#btnSync");
    btn.disabled = true;
    btn.textContent = "Sincronizando…";
    try {
      const r = await NOC.zabbix.sync();
      toast(`Zabbix sincronizado: ${r.hosts} hosts e ${r.interfaces} interfaces.`, "ok");
      await carregar();
      renderFiltroEquip();
      render();
    } catch (err) {
      toast(err.message, "danger");
    } finally {
      btn.disabled = false;
      btn.textContent = "Sincronizar agora";
      NOC.applyActions(document);
    }
  }

  /* A projeção substitui as portas genéricas e os enlaces documentados dos
     equipamentos monitorados pelos dados derivados do inventário Zabbix.
     Primeiro fazemos um ensaio para que nenhuma remoção seja aplicada sem o
     operador conhecer o impacto. */
  async function aplicarNaTopologia() {
    const btn = $("#btnApplyTopology");
    btn.disabled = true;
    btn.textContent = "Analisando…";
    try {
      const previa = await NOC.zabbix.aplicarTopologia(false);
      const r = previa.resumo || {};
      const detalhes = [
        `${r.derivadas || 0} enlace(s) confirmado(s) pelo Zabbix`,
        `${r.externas || 0} enlace(s) até equipamento não monitorado`,
        `${r.descartadas || 0} vínculo(s) atual(is) substituído(s)`,
      ].join("; ");

      UI.confirm({
        title: "Usar enlaces do Zabbix?",
        text: `${detalhes}. As portas dos equipamentos monitorados também serão atualizadas.`,
        confirmLabel: "Aplicar na topologia",
        danger: (r.descartadas || 0) > 0,
        onConfirm: async () => {
          btn.disabled = true;
          btn.textContent = "Aplicando…";
          try {
            const aplicado = await NOC.zabbix.aplicarTopologia(true);
            await NOC.load();
            renderLinks();
            toast(`Topologia atualizada: ${aplicado.resumo?.conexoes_depois || 0} enlaces ativos.`, "ok");
          } catch (err) {
            toast(err.message, "danger");
          } finally {
            btn.disabled = false;
            btn.textContent = "Usar enlaces na topologia";
            NOC.applyActions(document);
          }
        },
      });
    } catch (err) {
      toast(err.message, "danger");
    } finally {
      btn.disabled = false;
      btn.textContent = "Usar enlaces na topologia";
      NOC.applyActions(document);
    }
  }

  async function boot() {
    UI.mountShell({ active: "trafego" });
    NOC.skeleton($("#tabela"), 6);

    try {
      await NOC.loadAccess();
      await NOC.load();
      await carregar();
    } catch (err) {
      NOC.errorState($("#tabela"), err, () => location.reload());
      return;
    }

    NOC.applyActions(document);
    renderFiltroEquip();
    render();

    $("#btnSync").onclick = sincronizar;
    $("#btnApplyTopology").onclick = aplicarNaTopologia;
    $("#fEquip").onchange = (e) => { state.filtro.equipamento = e.target.value; renderTabela(); };
    $("#fBusca").oninput = (e) => { state.filtro.busca = e.target.value; renderTabela(); };
    $("#autoRefresh").onchange = agendar;

    document.addEventListener("click", (e) => {
      const botao = e.target.closest("[data-sort-scope][data-sort-key]");
      if (botao) {
        alternarOrdenacao(botao.dataset.sortScope, botao.dataset.sortKey);
        return;
      }
      const editar = e.target.closest("[data-edit-link]");
      if (!editar || editar.disabled) return;
      const link = state.links.find((item) => chaveLink(item) === editar.dataset.editLink);
      if (link) editarLink(link);
    });

    $$("#fStatus .tab").forEach((b) => {
      b.onclick = () => {
        $$("#fStatus .tab").forEach((x) => x.classList.remove("is-active"));
        b.classList.add("is-active");
        state.filtro.status = b.dataset.st;
        renderTabela();
      };
    });

    agendar();
  }

  boot();
})();
