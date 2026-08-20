import test from "node:test";
import assert from "node:assert/strict";
import { buildIxcInventory, normalizeSerial, radiusConnection } from "../collector/ixc-client.mjs";

test("normaliza serial para cruzamento IXC/OLT", () => {
  assert.equal(normalizeSerial("zteg-00:01"), "ZTEG0001");
});

test("enriquece ONU com cliente, login, contrato, coordenadas e CTO", () => {
  const inventory = buildIxcInventory({
    customers: [{ id: "7", razao: "Cliente Teste", endereco: "Rua A", numero: "10", cidade: "Santos" }],
    contracts: [{ id: "8", id_cliente: "7", status: "A" }],
    logins: [{ id: "9", id_cliente: "7", id_contrato: "8", login: "cliente.teste", ip: "10.0.0.1" }],
    fiberClients: [{ id: "10", id_login: "9", id_contrato: "8", id_caixa_ftth: "11", porta_ftth: "3", id_transmissor: "12", mac: "ZTEG0001", latitude: "-23,95", longitude: "-46.33" }],
    boxes: [{ id: "11", descricao: "CTO-11", status: "A", latitude: "-23.94", longitude: "-46.32", id_transmissor: "12" }],
    transmitters: [{ id: "12", id_pop: "13" }],
  });
  const match = inventory.match({ serial: "ZTEG-00:01", name: "ONU" });
  assert.equal(match.name, "Cliente Teste");
  assert.equal(match.username, "cliente.teste");
  assert.equal(match.box_id, "11");
  assert.equal(match.pop_id, "13");
  assert.equal(match.lat, -23.95);
  assert.equal(inventory.boxes[0].name, "CTO-11");
});

/* ---- tráfego e conexão do Radius ---- */

test("normaliza velocidade do IXC em kbps a partir das várias grafias", () => {
  const kbps = (login) => radiusConnection(login).down_kbps;
  assert.equal(kbps({ velocidade_download: "300000" }), 300000, "kbps puro");
  assert.equal(kbps({ velocidade_download: "300M" }), 300000, "sufixo mega");
  assert.equal(kbps({ velocidade_download: "1,5G" }), 1500000, "giga com vírgula decimal");
  assert.equal(kbps({ velocidade_down: "50 Mbps" }), 50000, "coluna alternativa com unidade escrita");
  assert.equal(kbps({ download: "300000000" }), 300000, "bits por segundo viram kbps");
  assert.equal(kbps({}), null, "campo ausente não vira zero");
});

test("aceita uptime como segundos ou como relógio com dias", () => {
  const s = (valor) => radiusConnection({ tempo_conectado: valor }).uptime_s;
  assert.equal(s("274353"), 274353);
  assert.equal(s("3d 04:12:33"), 274353);
  assert.equal(s("02:30"), 9000);
  assert.equal(s(""), null, "sem leitura é null, não zero");
});

test("distingue consumo ausente de consumo zerado", () => {
  assert.equal(radiusConnection({ consumo_download: "0" }).down_bytes, 0);
  assert.equal(radiusConnection({}).down_bytes, null);
});

test("ciclo rápido do Radius devolve a conexão inteira, não só o online", () => {
  const conexao = radiusConnection({ online: "S", ip: "10.0.0.5", login: "joao",
    velocidade_download: "300M", velocidade_upload: "150M", ultima_conexao_inicial: "2026-08-20 08:00:00" });
  assert.equal(conexao.online, "s");
  assert.equal(conexao.ip, "10.0.0.5");
  assert.equal(conexao.up_kbps, 150000);
  assert.equal(conexao.since, "2026-08-20 08:00:00");
});

test("ciclo completo já entrega tráfego e conexão junto do cadastro", () => {
  const inventory = buildIxcInventory({
    customers: [{ id: "7", razao: "Cliente Teste" }],
    contracts: [{ id: "8", id_cliente: "7", status: "A" }],
    logins: [{ id: "9", id_cliente: "7", id_contrato: "8", login: "cliente.teste", ip: "10.0.0.1",
      velocidade_download: "600M", velocidade_upload: "300M", tempo_conectado: "3600",
      ultima_conexao_inicial: "2026-08-20 07:00:00", id_concentrador: "4" }],
    fiberClients: [{ id: "10", id_login: "9", id_contrato: "8", mac: "ZTEG0001" }],
    boxes: [], transmitters: [],
  });
  const match = inventory.match({ serial: "ZTEG0001", name: "ONU" });
  assert.equal(match.down_kbps, 600000);
  assert.equal(match.up_kbps, 300000);
  assert.equal(match.uptime_s, 3600);
  assert.equal(match.conn_since, "2026-08-20 07:00:00");
  assert.equal(match.nas_id, "4");
  assert.equal(match.ip, "10.0.0.1", "o IP continua vindo do login");
});
