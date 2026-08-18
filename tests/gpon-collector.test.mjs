import test from "node:test";
import assert from "node:assert/strict";
import { parseOnuBaseInfo, parseOnuStates } from "../collector/zte-cli.mjs";

test("interpreta estados das ONUs ZTE sem confundir cabeçalhos", () => {
  const output = `
OnuIndex   Admin State  OMCC State  Phase State  Channel
--------------------------------------------------------
1/2/1:1   enable       enable      working      1(GPON)
1/2/1:2   enable       disable     DyingGasp    1(GPON)
1/2/1:3   enable       disable     LOS          1(GPON)`;
  const rows = parseOnuStates(output, { id: "olt-c350" });
  assert.equal(rows.length, 3);
  assert.equal(rows[0].status, "online");
  assert.equal(rows[1].status, "dyinggasp");
  assert.equal(rows[2].status, "los");
  assert.equal(rows[0].id, "olt-c350:1/2/1:1");
});

test("importa serial, modelo e autenticação do cadastro básico ZTE", () => {
  const output = `
OnuIndex            Type        Mode    AuthInfo                State
-------------------------------------------------------------------------------
gpon-onu_1/2/1:1    ZTEF670L    sn      SN:ZTEG00000001         ready
gpon-onu_1/2/1:2    F673AV9     loid    CLIENTE-002              ready`;
  const rows = parseOnuBaseInfo(output);
  assert.deepEqual(rows.get("1/2/1:1"), {
    model: "ZTEF670L", auth_mode: "sn", serial: "ZTEG00000001", registration_state: "ready",
  });
  assert.equal(rows.get("1/2/1:2").serial, "CLIENTE-002");
});
