// Derivação dos enlaces físicos da rede a partir das descrições de interface
// (ifAlias) coletadas do Zabbix.
//
// A equipe de rede documenta a ponta remota no alias da interface. O padrão não
// é uniforme — conviverem "SWITCH_HW-S6750-ASCENTY-100GE-1/0/1",
// "NE8000_F1A-100GE0/1/48" e "DWDM-DATACOM-PRAIAGRANDE-PORT1" — então a
// derivação é conservadora: prefere não afirmar um enlace a inventar um errado.
//
// Dois níveis de confiança:
//   alta  — as duas pontas citam a interface da outra (confirmação mútua);
//   media — só um lado cita a interface remota, e ela é única e compatível.
// Referência ambígua, ou que aponta para uma localidade onde nenhum candidato
// existe, é descartada: a ponta remota provavelmente não é monitorada.

/* Nomenclaturas: Huawei (100GE1/0/1, XGigabitEthernet0/0/2) e
   Datacom (hundred-gigabit-ethernet-1/2/1, four-hundred-g-ethernet-1/2/1). */
const TYPE_ALTERNATION =
  "100GE|40GE|25GE|10GE|XGigabitEthernet|XGEI|XGE|GigabitEthernet|GE|" +
  "four-hundred-g-ethernet|hundred-gigabit-ethernet|forty-gigabit-ethernet|" +
  "ten-gigabit-ethernet|gigabit-ethernet|FHGE400|FHGE|HGE";

export function isPhysicalInterface(name) {
  const n = String(name);
  if (n.includes(".")) return false; // subinterface
  return /^(100GE|40GE|25GE|10GE|XGigabitEthernet|GigabitEthernet|XGE|GE)\d/.test(n)
    || /^(four-hundred-g|hundred-gigabit|forty-gigabit|ten-gigabit|gigabit)-ethernet-\d/.test(n);
}

/** Família de velocidade da interface, usada para impedir pares incompatíveis. */
export function interfaceFamily(name) {
  const n = String(name);
  if (/^100GE/.test(n) || /^hundred-gigabit-ethernet/.test(n)) return "100G";
  if (/^four-hundred-g-ethernet/.test(n)) return "400G";
  if (/^40GE/.test(n) || /^forty-gigabit-ethernet/.test(n)) return "40G";
  if (/^25GE/.test(n)) return "25G";
  if (/^(10GE|XGigabitEthernet|XGE)/.test(n) || /^ten-gigabit-ethernet/.test(n)) return "10G";
  if (/^(GigabitEthernet|GE)/.test(n) || /^gigabit-ethernet/.test(n)) return "1G";
  return null;
}

function familyFromToken(token) {
  if (!token) return null;
  const t = String(token).toLowerCase();
  if (t === "100ge" || t === "hundred-gigabit-ethernet" || t === "hge") return "100G";
  if (t === "four-hundred-g-ethernet" || t === "fhge400" || t === "fhge") return "400G";
  if (t === "40ge" || t === "forty-gigabit-ethernet") return "40G";
  if (t === "25ge") return "25G";
  if (["10ge", "xge", "xgei", "xgigabitethernet", "ten-gigabit-ethernet"].includes(t)) return "10G";
  return null; // GE/gigabit-ethernet são ambíguos demais para restringir
}

/** Posição física "slot/subslot/porta" — a chave de comparação entre pontas. */
export const slotOf = (name) => String(name).match(/(\d+\/\d+\/\d+)/)?.[1] || null;

/**
 * Referências a interfaces dentro de um alias.
 * A alternância de tipos é explícita e do mais longo para o mais curto: sem
 * isso "100GE0/0/3" seria lido como "GE" + "0/0/3", perdendo a velocidade.
 */
export function interfaceRefs(alias) {
  const re = new RegExp(`(${TYPE_ALTERNATION})?[-_ ]?(\\d+\\/\\d+\\/\\d+)`, "gi");
  return [...String(alias).matchAll(re)].map(m => ({
    slot: m[2],
    family: familyFromToken(m[1])
  }));
}

/* Localidades. Comparadas sem separadores, porque o mesmo POP aparece como
   PRAIA_GRANDE, PRAIA-GRANDE e PRAIAGRANDE. */
const LOCALS = [
  ["ASCENTY", "ASCENTY"],
  ["PRAIAGRANDE", "PRAIA_GRANDE"],
  ["SANTOS", "SANTOS"],
  ["RIOBRANCO", "RIO_BRANCO"],
  ["CUBATAO", "CUBATAO"],
  ["VILANATAL", "VILA_NATAL"],
  ["CASQUEIRO", "CASQUEIRO"]
];

const squash = (text) => String(text).toUpperCase().replace(/[^A-Z0-9]/g, "");

/** Localidade do host. Os NE8000 "BASE" não trazem a cidade no nome, mas todas
    as rotas descritas neles dizem CUBATAO. */
export function hostLocal(host) {
  const n = squash(host?.name);
  for (const [needle, local] of LOCALS) if (n.includes(needle)) return local;
  if (/BASE/.test(n)) return "CUBATAO";
  return null;
}

export function localsInAlias(alias) {
  const a = squash(alias);
  return [...new Set(LOCALS.filter(([needle]) => a.includes(needle)).map(([, local]) => local))];
}

/**
 * Deriva os enlaces físicos.
 * @param {{hosts: Array, interfaces: Array}} inventory
 * @returns {Array} enlaces com { a, b, family, confidence }
 */
export function deriveLinks({ hosts, interfaces }) {
  const hostById = new Map(hosts.map(h => [String(h.hostid), h]));
  const physical = interfaces.filter(i => isPhysicalInterface(i.if_name));

  const keyOf = (i) => `${i.hostid}|${i.if_name}`;

  /** Interfaces que podem ser a ponta remota de uma referência. */
  function candidatesFor(from, ref, familyFrom) {
    let list = physical.filter(b =>
      String(b.hostid) !== String(from.hostid) &&
      slotOf(b.if_name) === ref.slot &&
      interfaceFamily(b.if_name) === (ref.family || familyFrom));

    // As localidades citadas no alias delimitam onde a ponta remota pode estar.
    // Todas valem, inclusive a do próprio host: um DWDM e o switch dele ficam no
    // mesmo POP ("SW-S6750_PRAIA-GRANDE" dito por um equipamento de Praia
    // Grande), enquanto uma rota nomeia as duas cidades ("SANTOS_x_PRAIA_GRANDE").
    // Vale mesmo com um único candidato: se o alias diz a cidade e o candidato
    // não está nela, a ponta remota é outro equipamento — fora do monitoramento.
    const localFrom = hostLocal(hostById.get(String(from.hostid)));
    const hints = localsInAlias(from.if_alias);
    if (hints.length) {
      list = list.filter(b => hints.includes(hostLocal(hostById.get(String(b.hostid)))));
    }
    if (list.length <= 1) return list;

    // Desempate: o alias do candidato cita a localidade de quem referencia.
    if (localFrom) {
      const narrowed = list.filter(b =>
        b.if_alias && localsInAlias(b.if_alias).includes(localFrom));
      if (narrowed.length) list = narrowed;
    }
    return list;
  }

  const links = [];
  const taken = new Set();

  const push = (a, b, family, confidence) => {
    const key = [keyOf(a), keyOf(b)].sort().join("::");
    if (taken.has(key)) return;
    taken.add(key);
    links.push({ a, b, family, confidence });
  };

  // Duas passagens: a confirmação mútua tem prioridade sobre a citação única,
  // para que um enlace confirmado nunca seja rotulado como "media".
  for (const confidence of ["alta", "media"]) {
    for (const a of physical) {
      if (!a.if_alias) continue;
      const slotA = slotOf(a.if_name);
      const familyA = interfaceFamily(a.if_name);
      if (!slotA || !familyA) continue;

      for (const ref of interfaceRefs(a.if_alias)) {
        // Auto-referência sem tipo não diz nada sobre a ponta remota.
        if (ref.slot === slotA && !ref.family) continue;

        const candidates = candidatesFor(a, ref, familyA);

        if (confidence === "alta") {
          for (const b of candidates) {
            if (!b.if_alias) continue;
            const back = interfaceRefs(b.if_alias).some(r =>
              r.slot === slotA && (!r.family || r.family === familyA));
            if (back) push(a, b, familyA, "alta");
          }
        } else if (candidates.length === 1) {
          push(a, candidates[0], familyA, "media");
        }
      }
    }
  }

  return links;
}

/** Rótulo de capacidade a partir de speed_bps, no formato usado na topologia. */
export function capacityLabel(bps) {
  const n = Number(bps);
  if (!Number.isFinite(n) || n <= 0) return "A confirmar";
  if (n >= 1e12) return `${+(n / 1e12).toFixed(1)} Tbps`;
  if (n >= 1e9) return `${Math.round(n / 1e9)} Gbps`;
  if (n >= 1e6) return `${Math.round(n / 1e6)} Mbps`;
  return `${n} bps`;
}

/**
 * Classifica o enlace pela natureza das pontas, reaproveitando o vocabulário
 * que a topologia já usa no campo `tipo`.
 */
export function linkKind(aliasA, aliasB) {
  const text = squash(`${aliasA} ${aliasB}`);
  if (text.includes("DWDM")) return "Transporte";
  if (text.includes("MPLS") || text.includes("ROTA")) return "BGP/MPLS";
  if (text.includes("NE8000") || text.includes("F1A")) return "Uplink";
  return "Enlace";
}
