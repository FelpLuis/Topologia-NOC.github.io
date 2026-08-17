/* ============================================================
   UPDOWN NOC — Tráfego das interfaces
   Lê o espelho do Zabbix no D1 (/api/zabbix/*). Nada é calculado
   aqui além de utilização e agregados: os números vêm do SNMP.
   ============================================================ */
(() => {
  "use strict";
  const { $, $$, esc, toast } = UI;

  const RECARGA_MS = 60000;

  const state = {
    interfaces: [],
    links: [],
    status: null,
    filtro: { equipamento: "", status: "", busca: "" },
    timer: null,
  };

  /* in_bps/out_bps e speed_bps vêm em bits/s. A utilização usa o sentido mais
     carregado, que é como a operação enxerga saturação de enlace. */
  const carga = (i) => Math.max(Number(i.in_bps) || 0, Number(i.out_bps) || 0);

  function utilizacao(i) {
    const cap = Number(i.speed_bps) || 0;
    if (!cap) return null;
    return Math.min((carga(i) / cap) * 100, 100);
  }

  const classeUtil = (u) => (u === null ? "" : u > 85 ? "is-danger" : u > 70 ? "is-warn" : "");

  function medidor(u) {
    if (u === null) return '<small class="dim">—</small>';
    return `<span class="row" style="gap:8px;align-items:center">
      <span class="meter meter-sm ${classeUtil(u)}" style="width:70px"><span style="width:${u.toFixed(1)}%"></span></span>
      <small class="mono">${u.toFixed(1)}%</small>
    </span>`;
  }

  const bps = (v) => NOC.formatBps(v);

  /* ---------------- KPIs ---------------- */
  function renderKpis() {
    const ifs = state.interfaces;
    const up = ifs.filter((i) => i.oper_status === 1);
    const entrada = ifs.reduce((a, i) => a + (Number(i.in_bps) || 0), 0);
    const saida = ifs.reduce((a, i) => a + (Number(i.out_bps) || 0), 0);
    const erros = ifs.reduce((a, i) => a + (Number(i.in_errors) || 0) + (Number(i.out_errors) || 0), 0);
    const saturadas = ifs.filter((i) => {
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
    $("#syncInfo").textContent = run
      ? `Última sincronização: ${new Date((run.finished_at || run.started_at).replace(" ", "T") + "Z").toLocaleString("pt-BR")} • ${run.hosts_count} hosts, ${run.interfaces_count} interfaces.`
      : "Nenhuma sincronização registrada ainda.";
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
        <td><span class="badge">${esc(l.capacidade)}</span></td>
        <td>${esc(l.tipo)}</td>
        <td class="mono">${esc(bps(l.a.in_bps))}</td>
        <td class="mono">${esc(bps(l.a.out_bps))}</td>
        <td>${medidor(u || null)}</td>
        <td><span class="badge ${l.confianca === "alta" ? "badge-ok" : "badge-warn"}">${esc(l.confianca)}</span></td>
      </tr>`;
    };

    $("#links").innerHTML = `<div class="table-wrap"><table class="table">
      <thead><tr>
        <th>Ponta A</th><th>Ponta B</th><th>Capacidade</th><th>Tipo</th>
        <th>Entrada (A)</th><th>Saída (A)</th><th>Utilização</th><th>Confiança</th>
      </tr></thead>
      <tbody>${state.links.slice().sort((x, y) => {
        const ux = Math.max(utilizacao(x.a) ?? 0, utilizacao(x.b) ?? 0);
        const uy = Math.max(utilizacao(y.a) ?? 0, utilizacao(y.b) ?? 0);
        return uy - ux;
      }).map(linha).join("")}</tbody>
    </table></div>`;
  }

  /* ---------------- tabela de interfaces ---------------- */
  function filtradas() {
    const { equipamento, status, busca } = state.filtro;
    const alvo = busca.trim().toLowerCase();
    return state.interfaces.filter((i) => {
      if (equipamento && i.equipamento_id !== equipamento) return false;
      if (status === "up" && i.oper_status !== 1) return false;
      if (status === "down" && i.oper_status !== 2) return false;
      if (alvo && !`${i.if_name} ${i.if_alias}`.toLowerCase().includes(alvo)) return false;
      return true;
    }).sort((a, b) => carga(b) - carga(a));
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
      return `<tr>
        <td>${esc(i.equipamento_id || i.host_name || "—")}</td>
        <td class="mono">${esc(i.if_name)}</td>
        <td>${i.if_alias ? esc(i.if_alias) : '<small class="dim">sem descrição</small>'}</td>
        <td><span class="row" style="gap:6px;align-items:center"><span class="dot ${st.dot}"></span>${esc(st.label)}</span></td>
        <td class="mono">${esc(bps(i.speed_bps))}</td>
        <td class="mono">${esc(bps(i.in_bps))}</td>
        <td class="mono">${esc(bps(i.out_bps))}</td>
        <td>${medidor(u)}</td>
        <td class="mono ${erros ? "" : "dim"}">${erros.toLocaleString("pt-BR")}</td>
      </tr>`;
    };

    $("#tabela").innerHTML = `
      <div class="table-wrap"><table class="table">
        <thead><tr>
          <th>Equipamento</th><th>Interface</th><th>Descrição</th><th>Status</th>
          <th>Capacidade</th><th>Entrada</th><th>Saída</th><th>Utilização</th><th>Erros</th>
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
