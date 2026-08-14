
const state = {
  equipamentos: [],
  conexoes: []
};

const flowOrder = [
  ["f1a", "s6730a", "s6750a", "nokia1", "datacom1"],
  ["nokia2", "datacom2", "s6750b", "s6730b", "m8"],
  ["santos", "sv"]
];

async function loadData() {
  const [equipResp, connResp] = await Promise.all([
    fetch("data/equipamentos.json"),
    fetch("data/conexoes.json")
  ]);

  if (!equipResp.ok || !connResp.ok) {
    throw new Error("Não foi possível carregar os arquivos JSON.");
  }

  state.equipamentos = await equipResp.json();
  state.conexoes = await connResp.json();

  renderSidebar();
  renderTopology();
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
      item.innerHTML = `
        <b>${escapeHtml(d.nome)}</b>
        <small>${escapeHtml(d.modelo)}</small>
        <span class="badge">${d.portas.length} portas</span>
      `;
      item.addEventListener("click", () => openDetail(d.id));
      list.appendChild(item);
    });
}

function renderTopology() {
  const container = document.getElementById("topology");
  container.innerHTML = "";

  flowOrder.flat().forEach(id => {
    const d = getDevice(id);
    if (!d) return;

    const node = document.createElement("article");
    node.className = "node";
    node.innerHTML = `
      <span class="count">${d.portas.length} portas</span>
      <div class="type">${escapeHtml(d.categoria)}</div>
      <h3>${escapeHtml(d.nome)}</h3>
      <p>${escapeHtml(d.modelo)}</p>
    `;
    node.addEventListener("click", () => openDetail(id));
    container.appendChild(node);
  });
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
  const payload = {
    equipamentos: state.equipamentos,
    conexoes: state.conexoes
  };

  const blob = new Blob(
    [JSON.stringify(payload, null, 2)],
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
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

document.getElementById("search").addEventListener("input", e => {
  renderSidebar(e.target.value);
});

document.getElementById("closeBtn").addEventListener("click", closeModal);
document.getElementById("exportBtn").addEventListener("click", exportData);

document.getElementById("modal").addEventListener("click", e => {
  if (e.target.id === "modal") closeModal();
});

document.addEventListener("keydown", e => {
  if (e.key === "Escape") closeModal();
});

loadData().catch(error => {
  console.error(error);
  document.getElementById("topology").innerHTML =
    `<div class="empty">Erro ao carregar os arquivos da topologia.<br>${escapeHtml(error.message)}</div>`;
});
