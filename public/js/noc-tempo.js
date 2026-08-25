/* ============================================================
   UPDOWN NOC — fuso horário do sistema (America/Sao_Paulo)

   Uma fonte só para "que horas são" em todas as telas. Antes cada
   arquivo resolvia isso sozinho, e o resultado dependia do relógio da
   máquina: o telão do NOC com fuso errado (ou um Windows recém-instalado
   em UTC) mostrava a coleta no futuro e o evento da agenda três horas
   fora do lugar.

   Duas regras, e elas explicam toda a API abaixo:

   1. O banco guarda UTC. O `CURRENT_TIMESTAMP` do SQLite grava
      "2026-08-20 13:45:00" — UTC, mas sem o fuso declarado. O
      navegador leria essa string como hora local; por isso `instante()`
      completa o Z antes de entregar o Date.
   2. A tela fala São Paulo. Todo texto de data passa por um formatador
      com `timeZone` fixo, e não pelo fuso do sistema operacional. O que
      o operador lê é a hora do NOC, esteja a máquina onde estiver.

   O caminho de volta (o operador digita, o sistema grava) usa
   `deInput()`: um <input type="datetime-local"> devolve hora de parede
   sem fuso, e é `deInput` que decide que essa parede é a de São Paulo.
   ============================================================ */
window.TEMPO = (() => {
  "use strict";

  const ZONA = "America/Sao_Paulo";
  const LOCALE = "pt-BR";

  /* Intl.DateTimeFormat é caro de construir e barato de reusar — estas telas
     formatam milhares de carimbos por render (histórico GPON, logs RADIUS). */
  const cache = new Map();
  function formatador(opcoes) {
    const chave = JSON.stringify(opcoes);
    let f = cache.get(chave);
    if (!f) { f = new Intl.DateTimeFormat(LOCALE, { timeZone: ZONA, ...opcoes }); cache.set(chave, f); }
    return f;
  }

  /* "2026-08-20", "2026-08-20 13:45:00", "2026-08-20T13:45:00.123Z": os três
     formatos que o backend produz. O grupo final diz se o fuso veio junto. */
  const CARIMBO = /^(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?))?(Z|[+-]\d{2}:?\d{2})?$/i;

  const ehData = (v) => Object.prototype.toString.call(v) === "[object Date]";
  const valida = (d) => (Number.isNaN(d.getTime()) ? null : d);

  /* Converte qualquer coisa que o backend devolva em um instante de verdade.
     Devolve null (e não uma Data Inválida) quando não dá para saber a hora:
     quem chama decide o traço a mostrar no lugar. */
  function instante(valor) {
    if (valor === null || valor === undefined || valor === "") return null;
    if (ehData(valor)) return valida(valor);
    if (typeof valor === "number") return Number.isFinite(valor) ? new Date(valor) : null;

    const texto = String(valor).trim();
    if (!texto) return null;

    const m = CARIMBO.exec(texto);
    if (m) {
      // "2026-08-20": data de calendário (compromisso de dia inteiro, filtro
      // por dia). O dia começa à meia-noite de São Paulo, não à de Londres.
      if (!m[2]) return deInput(`${m[1]}T00:00`);
      // Sem fuso declarado, o carimbo é UTC: é assim que o SQLite grava.
      const iso = texto.replace(" ", "T");
      return valida(new Date(m[3] ? iso : `${iso}Z`));
    }

    /* Qualquer outro formato (o toString de um Date de outro contexto, uma data
       HTTP) vai para o parse nativo, que entende o que ele mesmo escreve.
       Completar com "Z" aqui inventaria um deslocamento. */
    return valida(new Date(texto));
  }

  /* Formatação: sempre com o fuso preso. `vazio` é o que aparece quando não há
     data — cada tela usa o seu ("—", "Não agendado", o texto cru do banco). */
  function fmt(valor, opcoes, vazio = "—") {
    const d = instante(valor);
    return d ? formatador(opcoes).format(d) : vazio;
  }

  const OPC_DATA = { day: "2-digit", month: "2-digit", year: "numeric" };
  const OPC_HORA = { hour: "2-digit", minute: "2-digit" };

  const data = (valor, vazio) => fmt(valor, OPC_DATA, vazio);
  const dataHora = (valor, vazio) => fmt(valor, { ...OPC_DATA, ...OPC_HORA }, vazio);
  const hora = (valor, vazio) => fmt(valor, OPC_HORA, vazio);
  const horaCompleta = (valor, vazio) => fmt(valor, { ...OPC_HORA, second: "2-digit" }, vazio);
  const dataHoraSegundos = (valor, vazio) => fmt(valor, { ...OPC_DATA, ...OPC_HORA, second: "2-digit" }, vazio);

  /* Os campos civis (ano, mês, dia, hora…) do instante em São Paulo. É daqui
     que saem as comparações de "mesmo dia" e o dia do mês do calendário. */
  function partes(valor) {
    const d = instante(valor);
    if (!d) return null;
    const p = Object.fromEntries(formatador({
      hour12: false, year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit"
    }).formatToParts(d).map(x => [x.type, x.value]));
    return {
      ano: Number(p.year), mes: Number(p.month), dia: Number(p.day),
      // "24" aparece na virada do dia em algumas engines com hour12:false.
      hora: Number(p.hour) % 24, minuto: Number(p.minute), segundo: Number(p.second)
    };
  }

  const pad = (n) => String(n).padStart(2, "0");

  /* "2026-08-20" no fuso de São Paulo: a chave que responde "é do mesmo dia?"
     sem depender do relógio da máquina. */
  function chaveDia(valor) {
    const p = partes(valor);
    return p ? `${p.ano}-${pad(p.mes)}-${pad(p.dia)}` : "";
  }

  const mesmoDia = (a, b) => {
    const x = chaveDia(a);
    return Boolean(x) && x === chaveDia(b);
  };
  const hoje = (valor) => mesmoDia(valor, new Date());

  /* Hora de parede de São Paulo -> instante. É a volta de `paraInput`, e o
     ponto onde o que o operador digitou vira UTC para o banco.

     Achar o instante exige duas passadas: a primeira chuta que a parede é UTC,
     mede o erro e corrige; a segunda acerta a borda de mudança de offset (o
     Brasil não tem mais horário de verão, mas datas anteriores a 2019 e
     qualquer volta dele passam por aqui). */
  function deInput(texto) {
    const m = String(texto || "").trim()
      .match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?$/);
    if (!m) return null;
    const alvo = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]),
      Number(m[4] || 0), Number(m[5] || 0), Number(m[6] || 0));
    let chute = alvo;
    for (let i = 0; i < 2; i++) {
      const p = Object.fromEntries(formatador({
        hour12: false, year: "numeric", month: "2-digit", day: "2-digit",
        hour: "2-digit", minute: "2-digit", second: "2-digit"
      }).formatToParts(new Date(chute)).map(x => [x.type, x.value]));
      const mostrado = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day),
        Number(p.hour) % 24, Number(p.minute), Number(p.second));
      chute += alvo - mostrado;
    }
    const d = new Date(chute);
    return Number.isNaN(d.getTime()) ? null : d;
  }

  /* O valor de um <input type="datetime-local">: hora de parede de São Paulo,
     sem fuso, no formato que o campo entende. */
  function paraInput(valor) {
    const p = partes(valor);
    return p ? `${p.ano}-${pad(p.mes)}-${pad(p.dia)}T${pad(p.hora)}:${pad(p.minuto)}` : "";
  }

  /* Meia-noite de São Paulo do dia em que o instante cai — a borda que o
     calendário e os filtros "de hoje" usam para separar um dia do outro. */
  const inicioDoDia = (valor) => deInput(`${chaveDia(valor)}T00:00`);

  return {
    ZONA, LOCALE, instante, fmt, data, dataHora, hora, horaCompleta, dataHoraSegundos,
    partes, chaveDia, mesmoDia, hoje, deInput, paraInput, inicioDoDia
  };
})();
