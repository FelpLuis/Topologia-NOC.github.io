(() => {
  const state = {
    data: null,
    refreshMs: 30000
  };

  const $ = (s, el=document) => el.querySelector(s);
  const esc = v => String(v ?? "").replace(/[&<>"']/g, c => ({
    "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"
  }[c]));

  function devicePop(e) {
    const s = [e.pop,e.local,e.localizacao,e.site,e.nome,e.id].join(" ").toLowerCase();
    if (s.includes("ascenty") || s.includes("f1a")) return "ascenty";
    if (s.includes("praia grande") || s.includes("praia")) return "praia-grande";
    if (s.includes("santos")) return "santos";
    if (s.includes("são vicente") || s.includes("sao vicente")) return "sao-vicente";
    if (s.includes("cubatão") || s.includes("cubatao")) return "cubatao";
    return null;
  }

  function connectionFor(deviceId, port) {
    const c = (state.data.conexoes || []).find(x =>
      (x.origem === deviceId && Number(x.portaOrigem) === Number(port)) ||
      (x.destino === deviceId && Number(x.portaDestino) === Number(port))
    );
    return c || null;
  }

  // Integration-ready fields:
  // Replace these functions later with the Grafana/API values.
  function getStatus(device) {
    // Example future field: device.monitoramento.status = "online"/"offline"
    return device.monitoramento?.status || "aguardando";
  }

  function getConsumption(device) {
    // Example future field: device.monitoramento.consumo = {value: 73, unit: "%"}
    return device.monitoramento?.consumo || { value: null, unit: "%" };
  }

  function getUsedPorts(device) {
    const ports = Array.isArray(device.portas) ? device.portas : [];
    return ports.filter(p => connectionFor(device.id, p.numero)).length;
  }

  function render() {
    const data = state.data;
    const devices = Array.isArray(data.equipamentos) ? data.equipamentos : [];
    const pops = Array.isArray(data.pops) ? data.pops : [];

    let totalPorts=0,totalUsed=0,online=0;
    const grid = $("#popGrid");

    grid.innerHTML = pops.map(pop => {
      const list = devices.filter(d => devicePop(d) === pop.id);
      let popPorts=0,popUsed=0;

      const cards = list.map(device => {
        const ports = Array.isArray(device.portas) ? device.portas : [];
        const used = getUsedPorts(device);
        const free = Math.max(0, ports.length-used);
        const status = getStatus(device);
        const consumption = getConsumption(device);

        totalPorts += ports.length;
        totalUsed += used;
        popPorts += ports.length;
        popUsed += used;
        if (status === "online") online++;

        const statusLabel = status === "online" ? "ONLINE" :
          status === "offline" ? "OFFLINE" : "AGUARDANDO";

        return `
          <article class="device-card">
            <div class="device-top">
              <div>
                <span class="device-role">${esc(device.categoria || device.tipo || "EQUIPAMENTO")}</span>
                <h3>${esc(device.nome || device.modelo || "Equipamento")}</h3>
                <p>${esc(device.modelo || "Modelo não informado")}</p>
              </div>
              <span class="status ${status}"><i></i>${statusLabel}</span>
            </div>

            <div class="device-metrics">
              <div><small>PORTAS</small><strong>${ports.length}</strong></div>
              <div><small>UTILIZADAS</small><strong>${used}</strong></div>
              <div><small>LIVRES</small><strong>${free}</strong></div>
              <div><small>CONSUMO</small><strong>${consumption.value == null ? "--" : esc(consumption.value)+esc(consumption.unit||"%")}</strong></div>
            </div>

            <div class="capacity-bar">
              <span style="width:${ports.length ? Math.min(100,(used/ports.length)*100) : 0}%"></span>
            </div>
            <div class="device-foot">
              <span>${ports.length ? Math.round((used/ports.length)*100) : 0}% das portas utilizadas</span>
              <span>Grafana: ${consumption.value == null ? "pendente" : "integrado"}</span>
            </div>
          </article>`;
      }).join("");

      const popUsedPct = popPorts ? Math.round(popUsed/popPorts*100) : 0;
      return `
        <section class="pop-column">
          <header class="pop-header">
            <div class="pop-marker ${esc(pop.cor)}"></div>
            <div>
              <span>POP</span>
              <h2>${esc(pop.nome)}</h2>
              <p>${esc(pop.local)}</p>
            </div>
            <div class="pop-summary">
              <strong>${list.length}</strong><small>EQUIP.</small>
            </div>
          </header>

          <div class="pop-overview">
            <div><span>PORTAS</span><strong>${popPorts}</strong></div>
            <div><span>UTILIZADAS</span><strong>${popUsed}</strong></div>
            <div><span>LIVRES</span><strong>${Math.max(0,popPorts-popUsed)}</strong></div>
            <div><span>OCUPAÇÃO</span><strong>${popUsedPct}%</strong></div>
          </div>

          <div class="device-list">
            ${cards || `<div class="empty">Nenhum equipamento cadastrado neste POP.</div>`}
          </div>
        </section>`;
    }).join("");

    $("#kpiPops").textContent = pops.length;
    $("#kpiEquip").textContent = devices.length;
    $("#kpiPorts").textContent = totalPorts;
    $("#kpiUsed").textContent = totalUsed;
    $("#kpiFree").textContent = Math.max(0,totalPorts-totalUsed);
    $("#kpiOnline").textContent = online ? online : "--";
  }

  async function load() {
    try {
      const res = await fetch(`data/dashboard.json?v=${Date.now()}`, {cache:"no-store"});
      state.data = await res.json();
      render();
    } catch (err) {
      console.error("Dashboard:", err);
      $("#popGrid").innerHTML = `<div class="load-error">Não foi possível carregar os dados da topologia.</div>`;
    }
  }

  function clock() {
    const d = new Date();
    $("#clock").textContent = d.toLocaleTimeString("pt-BR");
    $("#date").textContent = d.toLocaleDateString("pt-BR",{weekday:"short",day:"2-digit",month:"2-digit",year:"numeric"});
  }

  clock();
  setInterval(clock,1000);
  load();
  setInterval(load,state.refreshMs);
})();
