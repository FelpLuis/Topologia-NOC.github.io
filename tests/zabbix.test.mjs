import test from "node:test";
import assert from "node:assert/strict";
import { zabbixConfig } from "../src/zabbix.js";

test("zabbixConfig remove aspas acidentais dos Secrets", () => {
  assert.deepEqual(
    zabbixConfig({
      ZABBIX_URL: '  "https://zbx.example/api_jsonrpc.php"  ',
      ZABBIX_TOKEN: "'token-secreto'"
    }),
    {
      url: "https://zbx.example/api_jsonrpc.php",
      token: "token-secreto"
    }
  );
});

test("zabbixConfig rejeita URL ausente ou inválida com mensagem clara", () => {
  assert.throws(
    () => zabbixConfig({ ZABBIX_TOKEN: "token" }),
    /ZABBIX_URL não configurada/
  );
  assert.throws(
    () => zabbixConfig({ ZABBIX_URL: "zbx.example/api_jsonrpc.php", ZABBIX_TOKEN: "token" }),
    /ZABBIX_URL inválida/
  );
});
