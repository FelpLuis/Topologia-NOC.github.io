
const state = { equipamentos: [], conexoes: [], pops: [] };

const positions = {
  f1a:       { x: 40,  y: 40 },
  s6730a:    { x: 300, y: 40 },
  s6750a:    { x: 560, y: 40 },
  nokia1:    { x: 820, y: 40 },
  datacom1:  { x: 820, y: 210 },
  nokia2:    { x: 1080,y: 40 },
  datacom2:  { x: 1080,y: 210 },
  s6750b:   { x: 1340,y: 125 },
  s6730b:   { x: 1600,y: 125 },
  santos:   { x: 1860,y: 20 },
  sv:       { x: 1860,y: 230 },
  m8:       { x: 2120,y: 125 }
};

async function loadData() {
  const [equipResp, connResp, popsResp] = await Promise.all([
    fetch("data/equipamentos.json"),
    fetch("data/conexoes.json"),
    fetch("data/pops.json")
  ]);
  if (!equipResp.ok || !connResp.ok || !popsResp.ok) throw new Error("Falha ao carregar os arquivos JSON.");
  state.equipamentos = await equipResp.json();
  state.conexoes = await connResp.json();
  state.pops = await popsResp.json();
  renderSidebar();
  renderTopology();
  renderPops();
}

function getDevice(id) {
  return state.equipamentos.find(d => d.id === id);
}

function connectionFor(deviceId, port) {
  const c = state.conexoes.find(x =>
    (x.origem === deviceId && Number(x.portaOrigem) === Number(port)) ||
    (x.destino === deviceId && Number(x.portaDestino) === Number(port))
  );
  if (!c) return "Livre";
  if (c.origem === deviceId) {
    const remote = getDevice(c.destino);
    return `→ ${remote ? remote.nome : c.destino} • porta ${c.portaDestino}`;
  }
  const remote = getDevice(c.origem);
  return `← ${remote ? remote.nome : c.origem} • porta ${c.portaOrigem}`;
}

function renderSidebar(filter = "") {
  const list = document.getElementById("deviceList");
  const q = filter.toLowerCase();
  list.innerHTML = "";
  state.equipamentos
    .filter(d => JSON.stringify(d).toLowerCase().includes(q))
    .forEach(d => {
      const item = document.createElement("div");
      item.className = "device-link";
      item.innerHTML = `<b>${escapeHtml(d.nome)}</b><small>${escapeHtml(d.modelo)}</small><span class="badge">${d.portas.length} portas</span>`;
      item.addEventListener("click", () => openDetail(d.id));
      list.appendChild(item);
    });
}

function nodeCenter(id) {
  const p = positions[id];
  return { x: p.x + 105, y: p.y + 58 };
}

function renderTopology() {
  const container = document.getElementById("topology");
  container.innerHTML = "";

  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.classList.add("topology-lines");
  svg.setAttribute("viewBox", "0 0 2350 420");
  svg.setAttribute("preserveAspectRatio", "none");

  // Connections are drawn first, so equipment nodes sit above the lines.
  state.conexoes.forEach((c, index) => {
    const a = nodeCenter(c.origem);
    const b = nodeCenter(c.destino);
    if (!a || !b) return;

    const midX = (a.x + b.x) / 2;
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", `M ${a.x} ${a.y} C ${midX} ${a.y}, ${midX} ${b.y}, ${b.x} ${b.y}`);
    path.classList.add("topo-edge");
    path.dataset.connection = index;
    path.addEventListener("click", () => showConnection(c));
    svg.appendChild(path);

    const label = document.createElementNS("http://www.w3.org/2000/svg", "g");
    label.classList.add("edge-label");

    const lx = midX;
    const ly = (a.y + b.y) / 2 - 9;

    const rect = document.createElementNS("http://www.w3.org/2000/svg", "rect");
    rect.setAttribute("x", lx - 62);
    rect.setAttribute("y", ly - 10);
    rect.setAttribute("width", 124);
    rect.setAttribute("height", 20);
    rect.setAttribute("rx", 6);

    const text = document.createElementNS("http://www.w3.org/2000/svg", "text");
    text.setAttribute("x", lx);
    text.setAttribute("y", ly + 4);
    text.setAttribute("text-anchor", "middle");
    text.textContent = `${c.portaOrigem} ↔ ${c.portaDestino}`;

    label.appendChild(rect);
    label.appendChild(text);
    label.addEventListener("click", () => showConnection(c));
    svg.appendChild(label);
  });

  container.appendChild(svg);

  state.equipamentos.forEach(d => {
    const p = positions[d.id];
    if (!p) return;
    const node = document.createElement("article");
    node.className = "node";
    node.style.left = `${p.x}px`;
    node.style.top = `${p.y}px`;
    node.innerHTML = `
      <span class="count">${d.portas.length} portas</span>
      <div class="type">${escapeHtml(d.categoria)}</div>
      <h3>${escapeHtml(d.nome)}</h3>
      <p>${escapeHtml(d.modelo)}</p>
    `;
    node.addEventListener("click", () => openDetail(d.id));
    container.appendChild(node);
  });
}


function renderPops() {
  const grid = document.getElementById("popGrid");
  const details = document.getElementById("popDetails");
  grid.innerHTML = "";
  details.innerHTML = "";

  state.pops.forEach(pop => {
    const card = document.createElement("div");
    card.className = "pop";
    card.innerHTML = `
      <b>${escapeHtml(pop.nome)}</b>
      <small>${pop.equipamentos.length} item(ns) cadastrado(s)</small>
      <span class="pop-click">Clique para ver equipamentos</span>
    `;
    card.addEventListener("click", () => openPop(pop.id));
    grid.appendChild(card);

    const panel = document.createElement("div");
    panel.className = "pop-detail-card";
    panel.innerHTML = `
      <div class="pop-detail-title">
        <div>
          <b>${escapeHtml(pop.nome)}</b>
          <small>${pop.rotas.map(escapeHtml).join(" • ")}</small>
        </div>
        <span>${pop.equipamentos.length} equipamento(s)</span>
      </div>
      <div class="pop-equip-list">
        ${pop.equipamentos.map((eq, i) => `
          <div class="pop-equip">
            <div class="pop-equip-index">${i + 1}</div>
            <div>
              <b>${escapeHtml(eq.nome)}</b>
              <small>${escapeHtml(eq.modelo)}</small>
              <p>${escapeHtml(eq.observacao || "")}</p>
            </div>
          </div>
        `).join("")}
      </div>
    `;
    details.appendChild(panel);
  });
}

function openPop(id) {
  const pop = state.pops.find(p => p.id === id);
  if (!pop) return;
  document.getElementById("popModalName").textContent = pop.nome;
  document.getElementById("popModalRoutes").textContent = pop.rotas.join(" • ");
  const body = document.getElementById("popModalEquipments");
  body.innerHTML = pop.equipamentos.length
    ? pop.equipamentos.map((eq, i) => `
      <div class="pop-modal-eq">
        <span>${i + 1}</span>
        <div><b>${escapeHtml(eq.nome)}</b><small>${escapeHtml(eq.modelo)}</small><p>${escapeHtml(eq.observacao || "")}</p></div>
      </div>
    `).join("")
    : `<div class="pop-modal-eq"><div><b>Nenhum equipamento cadastrado</b><small>Adicione os equipamentos deste POP em data/pops.json.</small></div></div>`;
  document.getElementById("popModal").classList.remove("hidden");
}

function closePop() {
  document.getElementById("popModal").classList.add("hidden");
}


let currentDeviceId = null;






function downloadJson(filename, data) {
  const blob = new Blob([JSON.stringify(data, null, 2)], {
    type: "application/json"
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function exportEditedData() {
  downloadJson("equipamentos.json", state.equipamentos);
  setTimeout(() => downloadJson("conexoes.json", state.conexoes), 150);
}

function showConnection(c) {
  const a = getDevice(c.origem);
  const b = getDevice(c.destino);
  document.getElementById("connectionInfo").innerHTML = `
    <div class="connection-card">
      <div class="connection-side">
        <b>${escapeHtml(a?.nome || c.origem)}</b>
        <span>Porta ${c.portaOrigem}</span>
      </div>
      <div class="connection-arrow">→</div>
      <div class="connection-side">
        <b>${escapeHtml(b?.nome || c.destino)}</b>
        <span>Porta ${c.portaDestino}</span>
      </div>
      <div class="connection-meta">${escapeHtml(c.capacidade)} • ${escapeHtml(c.tipo)}</div>
    </div>
  `;
  document.getElementById("connectionPanel").classList.remove("hidden");
}

function closeConnection() {
  document.getElementById("connectionPanel").classList.add("hidden");
}

let detailEditMode = false;
let detailEditBackup = null;

function openDetail(id, editMode = false) {
  currentDeviceId = id;
  const d = getDevice(id);
  if (!d) return;

  document.getElementById("detailName").textContent = d.nome || "";
  document.getElementById("detailModel").textContent = d.modelo || "";
  document.getElementById("detailType").textContent = d.categoria || "—";
  document.getElementById("detailLocal").textContent = d.local || "—";
  document.getElementById("detailCount").textContent = Array.isArray(d.portas) ? d.portas.length : 0;
  document.getElementById("detailConnected").textContent =
    Array.isArray(d.portas) ? d.portas.filter(p => p.status === "conectada").length : 0;
  document.getElementById("detailNote").textContent = d.observacao || "";

  detailEditMode = false;
  detailEditBackup = null;
  try {
    renderDetailRows(d);
  } catch (error) {
    console.error("Erro ao montar portas do equipamento:", error);
    document.getElementById("detailRows").innerHTML =
      `<tr><td colspan="5">Não foi possível carregar as portas deste equipamento.</td></tr>`;
  }
  document.getElementById("modal").classList.remove("hidden");

  if (editMode) enterInlineEdit();
}

function getPortConnection(eqId, port) {
  const c = state.conexoes.find(c =>
    (c.origem === eqId && Number(c.portaOrigem) === Number(port)) ||
    (c.destino === eqId && Number(c.portaDestino) === Number(port))
  );
  if (!c) return null;
  return {
    c,
    isOrigin: c.origem === eqId && Number(c.portaOrigem) === Number(port)
  };
}

function renderDetailRows(d) {
  const tbody = document.getElementById("detailRows");
  tbody.innerHTML = "";

  const ports = Array.isArray(d.portas) ? d.portas : [];
  ports.forEach(p => {
    const connection = getPortConnection(d.id, p.numero);
    const c = connection ? connection.c : null;
    const isOrigin = connection ? connection.isOrigin : false;
    const remoteId = c ? (isOrigin ? c.destino : c.origem) : "";
    const remote = getDevice(remoteId);
    const remoteText = c
      ? `${remote ? remote.nome : remoteId} • porta ${isOrigin ? c.portaDestino : c.portaOrigem}`
      : "Livre";

    const tr = document.createElement("tr");
    if (c || p.status === "conectada") tr.className = "connected";

    tr.innerHTML = `
      <td><strong>${escapeHtml(String(p.numero))}</strong></td>
      <td>${escapeHtml(p.capacidade || "")}</td>
      <td>${escapeHtml(p.tipo || "")}</td>
      <td>${escapeHtml(p.status || "livre")}</td>
      <td>${escapeHtml(remoteText)}</td>
    `;
    tbody.appendChild(tr);
  });
}

function enterInlineEdit() {
  const d = getDevice(currentDeviceId);
  if (!d) return;

  detailEditBackup = JSON.parse(JSON.stringify({
    equipamento: d,
    conexoes: state.conexoes
  }));
  detailEditMode = true;

  const tbody = document.getElementById("detailRows");
  const ports = Array.isArray(d.portas) ? d.portas : [];

  tbody.innerHTML = ports.map(p => {
    const info = getPortConnection(d.id, p.numero);
    const c = info ? info.c : null;
    const isOrigin = info ? info.isOrigin : false;
    const remoteId = c ? (isOrigin ? c.destino : c.origem) : "";
    const remotePort = c ? (isOrigin ? c.portaDestino : c.portaOrigem) : "";
    const capacity = c?.capacidade || p.capacidade || "";
    const type = c?.tipo || p.tipo || "";
    const status = c ? "conectada" : (p.status || "livre");

    return `
      <tr class="inline-edit-row" data-port="${p.numero}">
        <td><strong>${escapeHtml(String(p.numero))}</strong></td>
        <td><input class="inline-port-capacity" value="${escapeAttr(capacity)}" placeholder="Ex.: 100 Gbps"></td>
        <td><input class="inline-port-type" value="${escapeAttr(type)}" placeholder="Ex.: BGP/MPLS"></td>
        <td>
          <select class="inline-port-status">
            <option value="livre" ${status !== "conectada" ? "selected" : ""}>Livre</option>
            <option value="conectada" ${status === "conectada" ? "selected" : ""}>Conectada</option>
            <option value="reservada" ${status === "reservada" ? "selected" : ""}>Reservada</option>
            <option value="manutencao" ${status === "manutencao" ? "selected" : ""}>Manutenção</option>
          </select>
        </td>
        <td>
          <div class="inline-connection-fields">
            <input class="inline-port-remote" value="${escapeAttr(remoteId)}" placeholder="Equipamento / string">
            <input class="inline-port-remote-port" type="text" value="${escapeAttr(remotePort)}" placeholder="Porta remota">
          </div>
        </td>
      </tr>
    `;
  }).join("");

  document.getElementById("inlineEditActions").classList.remove("hidden");
  document.getElementById("inlineEditStatus").textContent =
    "Edite os campos diretamente nesta tela.";
}

function cancelInlineEdit() {
  if (detailEditBackup) {
    const original = detailEditBackup.equipamento;
    const idx = state.equipamentos.findIndex(e => e.id === original.id);
    if (idx >= 0) state.equipamentos[idx] = original;
    state.conexoes = detailEditBackup.conexoes;
  }

  detailEditMode = false;
  detailEditBackup = null;
  document.getElementById("inlineEditActions").classList.add("hidden");
  const d = getDevice(currentDeviceId);
  if (d) renderDetailRows(d);
}

function saveInlineEdit() {
  const d = getDevice(currentDeviceId);
  if (!d) return;

  const rows = [...document.querySelectorAll("#detailRows .inline-edit-row")];

  rows.forEach(tr => {
    const port = Number(tr.dataset.port);
    const p = Array.isArray(d.portas) ? d.portas.find(x => Number(x.numero) === port) : null;
    if (!p) return;

    const capacity = tr.querySelector(".inline-port-capacity").value.trim();
    const type = tr.querySelector(".inline-port-type").value.trim();
    const status = tr.querySelector(".inline-port-status").value;
    const remote = tr.querySelector(".inline-port-remote").value.trim();
    const remotePortRaw = tr.querySelector(".inline-port-remote-port").value.trim();

    p.capacidade = capacity;
    p.tipo = type;
    p.status = status;

    state.conexoes = state.conexoes.filter(c =>
      !((c.origem === d.id && Number(c.portaOrigem) === port) ||
        (c.destino === d.id && Number(c.portaDestino) === port))
    );

    if (remote && remotePortRaw) {
      const remoteEq = state.equipamentos.find(e =>
        e.id === remote || e.nome.toLowerCase() === remote.toLowerCase()
      );
      const remoteId = remoteEq ? remoteEq.id : remote;

      state.conexoes.push({
        origem: d.id,
        portaOrigem: port,
        destino: remoteId,
        portaDestino: remotePortRaw,
        capacidade: capacity,
        tipo: type
      });
      p.status = "conectada";
    }
  });

  detailEditMode = false;
  detailEditBackup = null;
  document.getElementById("inlineEditActions").classList.add("hidden");
  document.getElementById("inlineEditStatus").textContent = "Alterações salvas nesta sessão.";

  renderDetailRows(d);
  renderTopology();
  renderSidebar();
}


function closeModal() {
  if (detailEditMode) cancelInlineEdit();
  document.getElementById("modal").classList.add("hidden");
}

function exportData() {
  const blob = new Blob(
    [JSON.stringify({ equipamentos: state.equipamentos, conexoes: state.conexoes }, null, 2)],
    { type: "application/json;charset=utf-8" }
  );
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "backup-topologia-updown.json";
  a.click();
  URL.revokeObjectURL(url);
}

function escapeAttr(value) {
  return escapeHtml(value).replace(/`/g, "&#096;");
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

document.getElementById("search").addEventListener("input", e => renderSidebar(e.target.value));
document.getElementById("closeBtn").addEventListener("click", closeModal);
document.getElementById("editCurrentDevice").addEventListener("click", () => {
  if (currentDeviceId && !detailEditMode) enterInlineEdit();
});
document.getElementById("connectionClose")?.addEventListener("click", closeConnection);
document.getElementById("inlineEditSave")?.addEventListener("click", saveInlineEdit);
document.getElementById("inlineEditCancel")?.addEventListener("click", cancelInlineEdit);

document.getElementById("popModalClose")?.addEventListener("click", closePop);
document.getElementById("modal").addEventListener("click", e => {
  if (e.target.id === "modal") closeModal();
});
document.addEventListener("keydown", e => {
  if (e.key === "Escape") {
    closeModal();
    closeConnection();
    closePop();
  }
});
const sidebarToggle = document.getElementById("sidebarToggle");
const appShell = document.getElementById("appShell");

function setSidebarCollapsed(collapsed) {
  if (!appShell || !sidebarToggle) return;
  appShell.classList.toggle("sidebar-collapsed", collapsed);
  sidebarToggle.title = collapsed ? "Expandir equipamentos" : "Recolher equipamentos";
  sidebarToggle.setAttribute(
    "aria-label",
    collapsed ? "Expandir painel de equipamentos" : "Recolher painel de equipamentos"
  );
  try {
    localStorage.setItem("updown-sidebar-collapsed", collapsed ? "1" : "0");
  } catch (_) {}
}

if (sidebarToggle && appShell) {
  let collapsed = false;
  try {
    collapsed = localStorage.getItem("updown-sidebar-collapsed") === "1";
  } catch (_) {}
  setSidebarCollapsed(collapsed);

  sidebarToggle.addEventListener("click", () => {
    setSidebarCollapsed(!appShell.classList.contains("sidebar-collapsed"));
  });
}

loadData().catch(error => {
  console.error(error);
  document.getElementById("topology").innerHTML =
    `<div class="empty">Erro ao carregar a topologia: ${escapeHtml(error.message)}</div>`;
});
