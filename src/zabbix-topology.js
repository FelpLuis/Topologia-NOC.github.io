// Projeta o inventário do Zabbix sobre a topologia editável.
//
// Duas coisas acontecem aqui:
//
// 1. As portas dos equipamentos monitorados passam a ser as interfaces físicas
//    reais (nome, velocidade e descrição vindos do SNMP), em vez das portas
//    genéricas "A confirmar" cadastradas à mão. O campo `numero` continua sendo
//    a chave usada pelas telas e pelas conexões.
//
// 2. As conexões entre equipamentos monitorados são derivadas dos aliases
//    (src/zabbix-links.js). Equipamento que o Zabbix não monitora — o DWDM Nokia
//    e o concentrador de Cubatão — não é tocado: suas portas e as conexões que
//    só envolvem ele são preservadas, e os enlaces até ele são reconstruídos a
//    partir do que o alias do lado monitorado declara.

import {
  isPhysicalInterface,
  interfaceFamily,
  capacityLabel,
  linkKind,
  localsInAlias,
  hostLocal,
  slotOf,
  interfaceRefs
} from "./zabbix-links.js";

/**
 * Regras para enlaces cuja ponta remota não é monitorada pelo Zabbix.
 * São poucas e explícitas porque cada uma depende de uma convenção de
 * nomenclatura específica da rede.
 */
const EXTERNAL_PEERS = [
  {
    // "DWDM-NOKIA-PRAIAGRANDE-PORT1" / "DWDM-NOKIA-PORT02"
    //
    // O DWDM fica no mesmo POP do switch: quem manda é a localidade do host, e
    // não a cidade citada no alias. Nesses circuitos o alias nomeia a ponta
    // distante — "DWDM-DATACOM-PRAIAGRANDE" dito pelo switch de Ascenty é a
    // porta do DWDM de Ascenty que sai para Praia Grande (foi assim que o
    // Datacom, que é monitorado, se confirmou nos dois lados).
    nome: "dwdm-nokia",
    resolve(alias, host) {
      const m = String(alias).toUpperCase().match(/DWDM[-_ ]?NOKIA.*?PORT0*(\d+)/);
      if (!m) return null;
      const local = hostLocal(host);
      const equipamentoId = local === "ASCENTY" ? "nokia1"
        : local === "PRAIA_GRANDE" ? "nokia2" : null;
      if (!equipamentoId) return null;
      return { equipamentoId, porta: Number(m[1]), tipo: "Transporte" };
    }
  },
  {
    // "MPLS-ROTA-SANTOS_x_CUBATAO-100GE0/1/49" — o concentrador de Cubatão não
    // está vinculado a um host, mas o alias diz em qual porta dele o enlace
    // chega. Usa esse número na porta já cadastrada do equipamento.
    nome: "cubatao",
    resolve(alias, host, equipamentos, ifName) {
      if (!localsInAlias(alias).includes("CUBATAO")) return null;
      // A referência que interessa é a da ponta remota, não a da porta local.
      const ref = interfaceRefs(alias).find(r => r.slot !== slotOf(ifName));
      if (!ref) return null;
      const porta = Number(ref.slot.split("/").pop());
      const alvo = equipamentos.find(e =>
        e.id === "m8" && (e.portas || []).some(p => Number(p.numero) === porta));
      if (!alvo) return null;
      return { equipamentoId: alvo.id, porta, tipo: "BGP/MPLS" };
    }
  }
];

/** Status de porta no vocabulário que as telas já usam. */
const statusPorta = (temEnlace, alias) =>
  temEnlace ? "conectada" : (alias ? "reservada" : "livre");

/**
 * @param {object} topology topologia atual (equipamentos, conexoes, pops, config)
 * @param {{hosts:Array, interfaces:Array}} inventory inventário do Zabbix
 * @param {Array} links enlaces derivados por deriveLinks()
 */
export function applyZabbixToTopology(topology, inventory, links) {
  const hostById = new Map(inventory.hosts.map(h => [String(h.hostid), h]));

  // equipamento monitorado -> host
  const hostByEquip = new Map();
  for (const host of inventory.hosts) {
    if (host.equipamento_id) hostByEquip.set(host.equipamento_id, host);
  }

  const interfacesByHost = new Map();
  for (const iface of inventory.interfaces) {
    if (!isPhysicalInterface(iface.if_name)) continue;
    const id = String(iface.hostid);
    if (!interfacesByHost.has(id)) interfacesByHost.set(id, []);
    interfacesByHost.get(id).push(iface);
  }
  // Ordem do próprio equipamento (ifIndex SNMP), para a numeração ficar estável.
  for (const list of interfacesByHost.values()) {
    list.sort((a, b) => Number(a.if_index) - Number(b.if_index));
  }

  const equipamentos = [];
  const portaDe = new Map();   // "equipId|ifName" -> numero
  const reconstruidos = new Set();
  const relatorio = {
    portas: [],
    conexoes: { derivadas: [], externas: [], preservadas: [], descartadas: [], conflitos: [] }
  };

  for (const equipamento of topology.equipamentos || []) {
    const host = hostByEquip.get(equipamento.id);
    const fisicas = host ? (interfacesByHost.get(String(host.hostid)) || []) : [];

    if (!host || !fisicas.length) {
      equipamentos.push(equipamento);   // não monitorado: preservado como está
      continue;
    }

    reconstruidos.add(equipamento.id);

    const portas = fisicas.map((iface, i) => {
      const numero = i + 1;
      portaDe.set(`${equipamento.id}|${iface.if_name}`, numero);
      return {
        numero,
        nome: iface.if_name,
        capacidade: capacityLabel(iface.speed_bps),
        tipo: interfaceFamily(iface.if_name) || "A confirmar",
        status: "livre",                 // ajustado depois, com as conexões prontas
        descricao: iface.if_alias || "",
        zabbix: {
          hostid: String(iface.hostid),
          ifIndex: Number(iface.if_index),
          operStatus: iface.oper_status,
          speedBps: iface.speed_bps
        }
      };
    });

    /* O Zabbix só monitora as interfaces em uso, então o número de interfaces é
       menor que o de portas do chassi. Completar com as portas livres que já
       estavam cadastradas preserva o controle de capacidade: sem isso a
       ocupação de todo equipamento passaria a marcar 100%.
       `numero` deixa de espelhar a etiqueta física do chassi (nunca espelhou:
       era um contador). A identidade física agora está em `nome`. */
    const antes = equipamento.portas || [];
    for (let i = portas.length; i < antes.length; i++) {
      const original = antes[i];
      portas.push({
        ...original,
        numero: i + 1,
        status: "livre"
      });
    }

    relatorio.portas.push({
      equipamento: equipamento.id,
      antes: antes.length,
      reais: fisicas.length,
      total: portas.length
    });

    equipamentos.push({ ...equipamento, portas });
  }

  const porId = new Map(equipamentos.map(e => [e.id, e]));
  const equipOf = (hostid) => hostById.get(String(hostid))?.equipamento_id || null;

  const conexoes = [];
  const ocupadas = new Set();          // "equipId|numero"

  /* Uma porta física só tem um enlace. Registrar sem checar ocupação deixaria a
     mesma porta em duas conexões, e as telas resolvem enlace por porta com um
     find(): a segunda ficaria invisível. Devolve false quando recusa. */
  const registra = (c) => {
    const chaveA = `${c.origem}|${c.portaOrigem}`;
    const chaveB = `${c.destino}|${c.portaDestino}`;
    if (ocupadas.has(chaveA) || ocupadas.has(chaveB)) return false;
    conexoes.push(c);
    ocupadas.add(chaveA);
    ocupadas.add(chaveB);
    return true;
  };

  // --- conexões derivadas: as duas pontas monitoradas ---
  for (const link of links) {
    const origem = equipOf(link.a.hostid);
    const destino = equipOf(link.b.hostid);
    if (!origem || !destino) continue;

    const portaOrigem = portaDe.get(`${origem}|${link.a.if_name}`);
    const portaDestino = portaDe.get(`${destino}|${link.b.if_name}`);
    if (!portaOrigem || !portaDestino) continue;

    const conexao = {
      origem, portaOrigem, destino, portaDestino,
      capacidade: capacityLabel(link.a.speed_bps),
      tipo: linkKind(link.a.if_alias, link.b.if_alias),
      fonte: "zabbix",
      confianca: link.confidence,
      descricao: link.a.if_alias || link.b.if_alias || ""
    };
    const rotulo = `${origem} ${link.a.if_name} <-> ${destino} ${link.b.if_name} (${link.confidence})`;
    if (registra(conexao)) relatorio.conexoes.derivadas.push(rotulo);
    else relatorio.conexoes.conflitos.push(`${rotulo} — porta já ocupada por outro enlace`);
  }

  /* --- conexões antigas que seguem válidas ---
     Vem antes da inferência por texto: enlace entre equipamentos que o Zabbix
     não monitora (o trunk entre os dois DWDM Nokia, por exemplo) só existe no
     cadastro manual, e não deve ser derrubado por um palpite de alias.
     Só sobrevive a conexão que não envolve equipamento reconstruído: nos
     reconstruídos a numeração mudou, e o número antigo não aponta mais para a
     mesma porta física. */
  for (const antiga of topology.conexoes || []) {
    const mexeu = reconstruidos.has(antiga.origem) || reconstruidos.has(antiga.destino);
    const descricao = `${antiga.origem} p${antiga.portaOrigem} -> ${antiga.destino} p${antiga.portaDestino}`;

    if (!mexeu) {
      if (registra({ ...antiga })) relatorio.conexoes.preservadas.push(descricao);
      else relatorio.conexoes.conflitos.push(`${descricao} — porta já ocupada`);
      continue;
    }

    const jaCoberta = conexoes.some(c =>
      (c.origem === antiga.origem && c.destino === antiga.destino) ||
      (c.origem === antiga.destino && c.destino === antiga.origem));

    relatorio.conexoes.descartadas.push(
      `${descricao}${jaCoberta ? " (substituída por enlace do Zabbix)" : " (sem confirmação no Zabbix)"}`);
  }

  // --- enlaces até equipamento não monitorado, pelo alias do lado monitorado ---
  for (const equipamento of equipamentos) {
    if (!reconstruidos.has(equipamento.id)) continue;
    const host = hostByEquip.get(equipamento.id);

    for (const porta of equipamento.portas) {
      if (!porta.descricao) continue;
      if (ocupadas.has(`${equipamento.id}|${porta.numero}`)) continue;

      for (const regra of EXTERNAL_PEERS) {
        const alvo = regra.resolve(porta.descricao, host, equipamentos, porta.nome);
        if (!alvo) continue;

        const peer = porId.get(alvo.equipamentoId);
        if (!peer) continue;
        if (!(peer.portas || []).some(p => Number(p.numero) === alvo.porta)) continue;
        if (ocupadas.has(`${peer.id}|${alvo.porta}`)) continue;

        registra({
          origem: equipamento.id,
          portaOrigem: porta.numero,
          destino: peer.id,
          portaDestino: alvo.porta,
          capacidade: porta.capacidade,
          tipo: alvo.tipo,
          fonte: "zabbix-alias",
          confianca: "media",
          descricao: porta.descricao
        });
        relatorio.conexoes.externas.push(
          `${equipamento.id} ${porta.nome} -> ${peer.id} porta ${alvo.porta} (${regra.nome})`);
        break;
      }
    }
  }

  // --- status das portas, agora que as conexões existem ---
  for (const equipamento of equipamentos) {
    if (!reconstruidos.has(equipamento.id)) continue;
    for (const porta of equipamento.portas) {
      porta.status = statusPorta(ocupadas.has(`${equipamento.id}|${porta.numero}`), porta.descricao);
    }
  }

  return {
    topology: { ...topology, equipamentos, conexoes },
    relatorio
  };
}
