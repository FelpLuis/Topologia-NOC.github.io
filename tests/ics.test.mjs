import test from "node:test";
import assert from "node:assert/strict";
import { parseIcsCalendar } from "../src/ics.js";

test("importa compromisso com horário, fuso e textos escapados", () => {
  const events = parseIcsCalendar(`BEGIN:VCALENDAR\r
VERSION:2.0\r
BEGIN:VEVENT\r
UID:reuniao-1\r
DTSTART;TZID=America/Sao_Paulo:20260820T090000\r
DTEND;TZID=America/Sao_Paulo:20260820T100000\r
SUMMARY:Reunião\\, operação\r
LOCATION:Sala 1\\; NOC\r
DESCRIPTION:Linha 1\\nLinha 2\r
END:VEVENT\r
END:VCALENDAR`, { now: "2026-08-18T12:00:00Z" });

  assert.equal(events.length, 1);
  assert.equal(events[0].title, "Reunião, operação");
  assert.equal(events[0].location, "Sala 1; NOC");
  assert.equal(events[0].description, "Linha 1\nLinha 2");
  assert.equal(events[0].start_at, "2026-08-20T12:00:00.000Z");
  assert.equal(events[0].end_at, "2026-08-20T13:00:00.000Z");
});

test("expande recorrência semanal e respeita exclusões", () => {
  const events = parseIcsCalendar(`BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VEVENT
UID:plantao
DTSTART:20260803T120000Z
DURATION:PT1H
RRULE:FREQ=WEEKLY;BYDAY=MO,WE;COUNT=5
EXDATE:20260810T120000Z
SUMMARY:Plantão
END:VEVENT
END:VCALENDAR`, { now: "2026-08-01T00:00:00Z" });

  assert.deepEqual(events.map(event => event.start_at), [
    "2026-08-03T12:00:00.000Z",
    "2026-08-05T12:00:00.000Z",
    "2026-08-12T12:00:00.000Z",
    "2026-08-17T12:00:00.000Z"
  ]);
});

test("importa compromisso de dia inteiro", () => {
  const [event] = parseIcsCalendar(`BEGIN:VCALENDAR
BEGIN:VEVENT
UID:feriado
DTSTART;VALUE=DATE:20260825
DTEND;VALUE=DATE:20260826
SUMMARY:Feriado
END:VEVENT
END:VCALENDAR`);
  assert.equal(event.all_day, true);
  assert.equal(event.start_at, "2026-08-25T00:00:00.000Z");
  assert.equal(event.end_at, "2026-08-26T00:00:00.000Z");
});

test("expande recorrência mensal no último dia útil indicado", () => {
  const events = parseIcsCalendar(`BEGIN:VCALENDAR
BEGIN:VEVENT
UID:fechamento
DTSTART:20260831T180000Z
DURATION:PT30M
RRULE:FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1;COUNT=3
SUMMARY:Fechamento
END:VEVENT
END:VCALENDAR`, { now: "2026-08-01T00:00:00Z" });
  assert.deepEqual(events.map(event => event.start_at), [
    "2026-08-31T18:00:00.000Z",
    "2026-09-30T18:00:00.000Z",
    "2026-10-30T18:00:00.000Z"
  ]);
});

test("rejeita arquivo que não é um calendário ICS", () => {
  assert.throws(() => parseIcsCalendar("texto qualquer"), /ARQUIVO_ICS_INVALIDO/);
});
