const MAX_EVENTS = 5000;
const DAY_MS = 86400000;

/* O fuso do sistema. Um .ics pode trazer hora "flutuante" — sem TZID e sem Z —
   e o RFC 5545 diz que ela vale no fuso de quem lê o calendário. Quem lê aqui é
   o NOC, em São Paulo. Sem isso o Worker (que roda em UTC) tratava 09:00 como
   09:00 UTC e o compromisso importado entrava na agenda três horas cedo. */
export const FUSO_PADRAO = "America/Sao_Paulo";

function unfold(text) {
  return String(text || "").replace(/\r\n/g, "\n").replace(/\r/g, "\n").replace(/\n[ \t]/g, "");
}

function unescapeText(value) {
  return String(value || "")
    .replace(/\\[nN]/g, "\n")
    .replace(/\\,/g, ",")
    .replace(/\\;/g, ";")
    .replace(/\\\\/g, "\\");
}

function propertyOf(line) {
  const colon = line.indexOf(":");
  if (colon < 1) return null;
  const head = line.slice(0, colon).split(";");
  const params = {};
  for (const item of head.slice(1)) {
    const equal = item.indexOf("=");
    if (equal > 0) params[item.slice(0, equal).toUpperCase()] = item.slice(equal + 1).replace(/^"|"$/g, "");
  }
  return { name: head[0].toUpperCase(), params, value: line.slice(colon + 1) };
}

function zonedDate(parts, timeZone) {
  const wanted = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  if (!timeZone) return new Date(wanted);
  try {
    let guess = wanted;
    const formatter = new Intl.DateTimeFormat("en-US", {
      timeZone, hour12: false, year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit"
    });
    for (let i = 0; i < 2; i++) {
      const shown = Object.fromEntries(formatter.formatToParts(new Date(guess)).map(part => [part.type, part.value]));
      const represented = Date.UTC(Number(shown.year), Number(shown.month) - 1, Number(shown.day),
        Number(shown.hour) % 24, Number(shown.minute), Number(shown.second));
      guess += wanted - represented;
    }
    return new Date(guess);
  } catch { return new Date(wanted); }
}

function parseDateValue(property) {
  if (!property) return null;
  const raw = property.value.trim();
  const allDay = property.params.VALUE === "DATE" || /^\d{8}$/.test(raw);
  const match = raw.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?)?(Z)?$/);
  if (!match) return null;
  const parts = {
    year: Number(match[1]), month: Number(match[2]), day: Number(match[3]),
    hour: Number(match[4] || 0), minute: Number(match[5] || 0), second: Number(match[6] || 0)
  };
  /* Compromisso de dia inteiro não tem hora para converter: fica na meia-noite
     UTC, e quem mostra o dia na tela é que o lê no fuso de São Paulo. */
  const date = match[7]
    ? new Date(Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second))
    : zonedDate(parts, allDay ? null : (property.params.TZID || FUSO_PADRAO));
  return Number.isFinite(date.getTime()) ? { date, allDay } : null;
}

function parseDuration(value) {
  const match = String(value || "").match(/^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/i);
  if (!match) return null;
  return (((Number(match[1] || 0) * 24 + Number(match[2] || 0)) * 60 * 60)
    + Number(match[3] || 0) * 60 + Number(match[4] || 0)) * 1000;
}

function ruleOf(value) {
  return Object.fromEntries(String(value || "").split(";").map(part => {
    const [key, ...rest] = part.split("=");
    return [String(key).toUpperCase(), rest.join("=")];
  }));
}

const WEEKDAY = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };

function addMonths(date, count) {
  const result = new Date(date);
  const day = result.getUTCDate();
  result.setUTCDate(1);
  result.setUTCMonth(result.getUTCMonth() + count);
  const last = new Date(Date.UTC(result.getUTCFullYear(), result.getUTCMonth() + 1, 0)).getUTCDate();
  result.setUTCDate(Math.min(day, last));
  return result;
}

function monthCandidates(start, year, month, rule) {
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const monthDays = String(rule.BYMONTHDAY || "").split(",").map(Number).filter(Number.isInteger)
    .map(day => day < 0 ? lastDay + day + 1 : day).filter(day => day >= 1 && day <= lastDay);
  const weekdayTokens = String(rule.BYDAY || "").split(",").filter(Boolean);
  const weekdayDays = [];
  for (const token of weekdayTokens) {
    const match = token.match(/^([+-]?\d+)?(SU|MO|TU|WE|TH|FR|SA)$/);
    if (!match) continue;
    const ordinal = Number(match[1] || 0);
    const weekday = WEEKDAY[match[2]];
    const matching = Array.from({ length: lastDay }, (_, index) => index + 1)
      .filter(day => new Date(Date.UTC(year, month, day)).getUTCDay() === weekday);
    if (!ordinal) weekdayDays.push(...matching);
    else {
      const selected = ordinal > 0 ? matching[ordinal - 1] : matching[matching.length + ordinal];
      if (selected) weekdayDays.push(selected);
    }
  }

  let days;
  if (monthDays.length && weekdayDays.length) days = monthDays.filter(day => weekdayDays.includes(day));
  else if (monthDays.length) days = monthDays;
  else if (weekdayDays.length) days = weekdayDays;
  else days = start.getUTCDate() <= lastDay ? [start.getUTCDate()] : [];
  days = [...new Set(days)].sort((a, b) => a - b);

  const positions = String(rule.BYSETPOS || "").split(",").map(Number).filter(Number.isInteger);
  if (positions.length) days = positions.map(position => position > 0 ? days[position - 1] : days[days.length + position]).filter(Boolean);
  return days.map(day => new Date(Date.UTC(year, month, day,
    start.getUTCHours(), start.getUTCMinutes(), start.getUTCSeconds(), start.getUTCMilliseconds())));
}

function expand(start, rule, excluded, rangeStart, rangeEnd) {
  const interval = Math.max(1, Number(rule.INTERVAL) || 1);
  const countLimit = Math.max(0, Number(rule.COUNT) || 0);
  const untilParsed = rule.UNTIL ? parseDateValue({ value: rule.UNTIL, params: {} }) : null;
  const until = untilParsed?.date || rangeEnd;
  const limit = new Date(Math.min(until.getTime(), rangeEnd.getTime()));
  const results = [];
  let occurrenceCount = 0;
  const accept = date => {
    occurrenceCount++;
    if (date >= rangeStart && date <= limit && !excluded.has(date.getTime())) results.push(date);
    return !countLimit || occurrenceCount < countLimit;
  };

  if (rule.FREQ === "WEEKLY") {
    const days = (rule.BYDAY || "").split(",").map(day => WEEKDAY[day.replace(/^[-+]?\d+/, "")]).filter(day => day !== undefined);
    const allowed = new Set(days.length ? days : [start.getUTCDay()]);
    for (let cursor = new Date(start), safety = 0; cursor <= limit && safety < 20000; cursor = new Date(cursor.getTime() + DAY_MS), safety++) {
      const weeks = Math.floor((cursor.getTime() - start.getTime()) / (7 * DAY_MS));
      if (weeks % interval === 0 && allowed.has(cursor.getUTCDay()) && !accept(new Date(cursor))) break;
    }
    return results;
  }

  if (rule.FREQ === "MONTHLY" || rule.FREQ === "YEARLY") {
    for (let period = 0, safety = 0; safety < 10000; period += interval, safety++) {
      const base = addMonths(start, rule.FREQ === "YEARLY" ? period * 12 : period);
      if (base > limit && base.getUTCFullYear() > limit.getUTCFullYear()) break;
      const months = rule.FREQ === "YEARLY" && rule.BYMONTH
        ? rule.BYMONTH.split(",").map(Number).filter(month => month >= 1 && month <= 12).map(month => month - 1)
        : [base.getUTCMonth()];
      const candidates = months.flatMap(month => monthCandidates(start, base.getUTCFullYear(), month, rule))
        .sort((a, b) => a - b);
      for (const candidate of candidates) {
        if (candidate < start || candidate > limit) continue;
        if (!accept(candidate)) return results;
      }
      if (base > limit || (rule.FREQ === "YEARLY" && base.getUTCFullYear() >= limit.getUTCFullYear())) break;
    }
    return results;
  }

  let cursor = new Date(start);
  for (let safety = 0; cursor <= limit && safety < 10000; safety++) {
    const byDays = String(rule.BYDAY || "").split(",").map(day => WEEKDAY[day.replace(/^[-+]?\d+/, "")]).filter(day => day !== undefined);
    if ((!byDays.length || byDays.includes(cursor.getUTCDay())) && !accept(new Date(cursor))) break;
    if (rule.FREQ === "DAILY") cursor = new Date(cursor.getTime() + interval * DAY_MS);
    else break;
  }
  return results;
}

function eventFromRecord(record, startDate, duration, suffix = "") {
  const uid = unescapeText(record.UID?.[0]?.value || `sem-uid-${suffix}`);
  return {
    external_uid: `${uid}:${startDate.toISOString()}`,
    title: unescapeText(record.SUMMARY?.[0]?.value || "Compromisso"),
    description: unescapeText(record.DESCRIPTION?.[0]?.value || ""),
    location: unescapeText(record.LOCATION?.[0]?.value || ""),
    start_at: startDate.toISOString(),
    end_at: new Date(startDate.getTime() + duration).toISOString(),
    all_day: Boolean(parseDateValue(record.DTSTART?.[0])?.allDay)
  };
}

export function parseIcsCalendar(text, options = {}) {
  if (!/BEGIN:VCALENDAR/i.test(String(text || ""))) throw new Error("ARQUIVO_ICS_INVALIDO");
  const records = [];
  let current = null;
  for (const line of unfold(text).split("\n")) {
    if (line.trim().toUpperCase() === "BEGIN:VEVENT") { current = {}; continue; }
    if (line.trim().toUpperCase() === "END:VEVENT") { if (current) records.push(current); current = null; continue; }
    if (!current) continue;
    const property = propertyOf(line);
    if (!property) continue;
    (current[property.name] ||= []).push(property);
  }

  const now = options.now ? new Date(options.now) : new Date();
  const rangeStart = new Date(now.getTime() - 366 * DAY_MS);
  const rangeEnd = new Date(now.getTime() + 5 * 366 * DAY_MS);
  const overrides = new Map();
  for (const record of records) {
    const uid = record.UID?.[0]?.value;
    const recurrence = parseDateValue(record["RECURRENCE-ID"]?.[0]);
    if (uid && recurrence) (overrides.get(uid) || overrides.set(uid, new Set()).get(uid)).add(recurrence.date.getTime());
  }

  const events = [];
  for (const record of records) {
    if (String(record.STATUS?.[0]?.value || "").toUpperCase() === "CANCELLED") continue;
    const start = parseDateValue(record.DTSTART?.[0]);
    if (!start) continue;
    const end = parseDateValue(record.DTEND?.[0]);
    const duration = end ? Math.max(1, end.date.getTime() - start.date.getTime())
      : parseDuration(record.DURATION?.[0]?.value) || (start.allDay ? DAY_MS : 3600000);
    const recurrenceId = parseDateValue(record["RECURRENCE-ID"]?.[0]);
    if (recurrenceId) {
      events.push(eventFromRecord(record, start.date, duration, "override"));
      continue;
    }
    const excluded = new Set(overrides.get(record.UID?.[0]?.value) || []);
    for (const exdate of record.EXDATE || []) {
      for (const value of exdate.value.split(",")) {
        const parsed = parseDateValue({ ...exdate, value });
        if (parsed) excluded.add(parsed.date.getTime());
      }
    }
    const rule = record.RRULE?.[0] ? ruleOf(record.RRULE[0].value) : null;
    const starts = rule ? expand(start.date, rule, excluded, rangeStart, rangeEnd) : [start.date];
    for (const occurrence of starts) {
      if (events.length >= MAX_EVENTS) throw new Error("ARQUIVO_ICS_MUITO_GRANDE");
      events.push(eventFromRecord(record, occurrence, duration));
    }
  }
  return [...new Map(events.map(event => [event.external_uid, event])).values()]
    .sort((a, b) => a.start_at.localeCompare(b.start_at));
}
