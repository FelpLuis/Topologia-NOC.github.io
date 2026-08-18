const PAGE_SIZE = 1000;

const text = (value) => String(value ?? "").trim();
const validId = (value) => text(value) && text(value) !== "0" ? text(value) : "";
const number = (value) => {
  const parsed = Number(String(value ?? "").replace(",", "."));
  return Number.isFinite(parsed) ? parsed : null;
};
const coordinates = (...records) => {
  for (const record of records) {
    const lat = number(record?.latitude), lon = number(record?.longitude);
    if (lat !== null && lon !== null && lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180 && (lat !== 0 || lon !== 0)) return { lat, lon };
  }
  return {};
};
const address = (...records) => {
  for (const record of records) {
    if (!record) continue;
    const street = text(record.endereco), house = text(record.numero), district = text(record.bairro), city = text(record.cidade);
    const result = [street && [street, house].filter(Boolean).join(", "), district, city].filter(Boolean).join(" — ");
    if (result) return result;
  }
  return "";
};

export const normalizeSerial = (value) => text(value).toUpperCase().replace(/[^A-Z0-9]/g, "");

async function requestPage(config, resource, page) {
  const response = await fetch(`${config.baseUrl}/${resource}`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(config.token).toString("base64")}`,
      "Content-Type": "application/json",
      ixcsoft: "listar",
    },
    body: JSON.stringify({
      qtype: `${resource}.id`, query: "0", oper: ">=", page: String(page), rp: String(PAGE_SIZE),
      sortname: `${resource}.id`, sortorder: "asc",
    }),
    signal: AbortSignal.timeout(30000),
  });
  if (!response.ok) throw new Error(`IXC ${resource}: HTTP ${response.status}`);
  const data = await response.json();
  if (!Array.isArray(data?.registros)) throw new Error(`IXC ${resource}: ${data?.message || "resposta inválida"}`);
  return data;
}

async function fetchAll(config, resource) {
  const records = [];
  for (let page = 1; ; page += 1) {
    const data = await requestPage(config, resource, page);
    records.push(...data.registros);
    if (!data.registros.length || records.length >= Number(data.total || 0)) return records;
  }
}

const select = (record, fields) => Object.fromEntries(fields.map((field) => [field, record?.[field]]));
const indexSelected = (records, fields) => new Map(records.map((record) => [text(record.id), select(record, ["id", ...fields])]));

export function buildIxcInventory({ customers, contracts, logins, fiberClients, boxes, transmitters }) {
  // A API também devolve documentos e senhas. Retemos somente o mínimo necessário ao mapa.
  const locationFields = ["endereco", "numero", "bairro", "cidade", "latitude", "longitude"];
  const customerById = indexSelected(customers, ["razao", "fantasia", ...locationFields]);
  const contractById = indexSelected(contracts, ["id_cliente", "status", ...locationFields]);
  const loginById = indexSelected(logins, ["id_cliente", "id_contrato", "login", "ip", "online", "id_caixa_ftth", "ftth_porta", ...locationFields]);
  const transmitterById = indexSelected(transmitters, ["id_pop"]);
  const fiberBySerial = new Map();
  for (const fiber of fiberClients) {
    for (const candidate of [fiber.mac, fiber.onu_numero, fiber.login_onu_cliente]) {
      const serial = normalizeSerial(candidate);
      if (serial && !fiberBySerial.has(serial)) fiberBySerial.set(serial, select(fiber, [
        "id", "id_login", "id_contrato", "id_caixa_ftth", "porta_ftth", "id_transmissor", "nome",
        "sinal_rx", "sinal_tx", ...locationFields,
      ]));
    }
  }

  const normalizedBoxes = boxes.map((box) => {
    const transmitter = transmitterById.get(text(box.id_transmissor));
    return {
      id: text(box.id), name: text(box.descricao) || `CTO ${box.id}`, type: text(box.tipo) || "CTO",
      status: text(box.status).toLowerCase() || "unknown", capacity: number(box.capacidade),
      address: address(box), pop_id: validId(transmitter?.id_pop), ...coordinates(box),
    };
  });

  return {
    boxes: normalizedBoxes,
    match(client) {
      const fiber = fiberBySerial.get(normalizeSerial(client.serial));
      if (!fiber) return null;
      const login = loginById.get(text(fiber.id_login));
      const contract = contractById.get(text(fiber.id_contrato || login?.id_contrato));
      const customer = customerById.get(text(login?.id_cliente || contract?.id_cliente));
      const transmitter = transmitterById.get(text(fiber.id_transmissor));
      return {
        ixc_id: text(customer?.id), fiber_id: text(fiber.id), contract_id: text(contract?.id),
        ixc_login_id: text(login?.id),
        contract_status: text(contract?.status),
        name: text(customer?.razao) || text(customer?.fantasia) || text(fiber.nome) || client.name,
        username: text(login?.login), ip: text(login?.ip),
        address: address(fiber, login, contract, customer),
        box_id: validId(fiber.id_caixa_ftth || login?.id_caixa_ftth),
        box_port: text(fiber.porta_ftth || login?.ftth_porta),
        pop_id: validId(transmitter?.id_pop),
        ixc_online: text(login?.online).toLowerCase(),
        rx_power: number(fiber.sinal_rx), tx_power: number(fiber.sinal_tx),
        ...coordinates(fiber, login, contract, customer),
      };
    },
    stats: { customers: customers.length, contracts: contracts.length, logins: logins.length, fiberClients: fiberClients.length, boxes: boxes.length },
  };
}

export async function collectIxc(config) {
  const [customers, contracts, logins, fiberClients, boxes, transmitters] = await Promise.all([
    fetchAll(config, "cliente"), fetchAll(config, "cliente_contrato"), fetchAll(config, "radusuarios"),
    fetchAll(config, "radpop_radio_cliente_fibra"), fetchAll(config, "rad_caixa_ftth"), fetchAll(config, "radpop_radio"),
  ]);
  return buildIxcInventory({ customers, contracts, logins, fiberClients, boxes, transmitters });
}

export async function collectIxcLoginStatuses(config) {
  const logins = await fetchAll(config, "radusuarios");
  return new Map(logins.map((login) => [text(login.id), text(login.online).toLowerCase()]));
}
