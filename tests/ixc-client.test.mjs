import test from "node:test";
import assert from "node:assert/strict";
import { buildIxcInventory, normalizeSerial } from "../collector/ixc-client.mjs";

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
