
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

function openDetail(id) {
  const d = getDevice(id);
  if (!d) return;
  document.getElementById("detailName").textContent = d.nome;
  document.getElementById("detailModel").textContent = d.modelo;
  document.getElementById("detailType").textContent = d.categoria;
  document.getElementById("detailLocal").textContent = d.local || "—";
  document.getElementById("detailCount").textContent = d.portas.length;
  document.getElementById("detailConnected").textContent =
    d.portas.filter(p => p.status === "conectada").length;
  document.getElementById("detailNote").textContent = d.observacao || "";

  const tbody = document.getElementById("detailRows");
  tbody.innerHTML = "";
  d.portas.forEach(p => {
    const tr = document.createElement("tr");
    const connection = connectionFor(d.id, p.numero);
    const connected = p.status === "conectada" || connection !== "Livre";
    if (connected) tr.className = "connected";
    tr.innerHTML = `
      <td>${escapeHtml(String(p.numero))}</td>
      <td>${escapeHtml(p.capacidade)}</td>
      <td>${escapeHtml(p.tipo)}</td>
      <td>${escapeHtml(p.status)}</td>
      <td>${escapeHtml(connection)}</td>
    `;
    tbody.appendChild(tr);
  });
  document.getElementById("modal").classList.remove("hidden");
}

function closeModal() {
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
document.getElementById("connectionClose").addEventListener("click", closeConnection);
document.getElementById("popModalClose").addEventListener("click", closePop);
document.getElementById("exportBtn").addEventListener("click", exportData);
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

loadData().catch(error => {
  console.error(error);
  document.getElementById("topology").innerHTML =
    `<div class="empty">Erro ao carregar a topologia: ${escapeHtml(error.message)}</div>`;
});
