import assert from "node:assert/strict";
import test from "node:test";

import { createTursoD1, getTursoD1 } from "../src/turso-d1.js";

function result({ columns = [], rows = [], rowsAffected = 0, lastInsertRowid } = {}) {
  return {
    columns,
    columnTypes: columns.map(() => ""),
    rows,
    rowsAffected,
    lastInsertRowid
  };
}

test("adaptador preserva prepare, bind, all e o formato de resposta do D1", async () => {
  const calls = [];
  const client = {
    async execute(statement) {
      calls.push(statement);
      return result({ columns: ["id", "active"], rows: [[7, 1]] });
    }
  };
  const db = createTursoD1(client);
  const response = await db.prepare("SELECT id,active FROM users WHERE active=? AND note IS ?")
    .bind(true, undefined)
    .all();

  assert.deepEqual(calls, [{
    sql: "SELECT id,active FROM users WHERE active=? AND note IS ?",
    args: [1, null]
  }]);
  assert.deepEqual(response.results, [{ id: 7, active: 1 }]);
  assert.equal(response.success, true);
  assert.equal(response.meta.rows_read, 1);
});

test("first devolve linha, coluna isolada ou null", async () => {
  const responses = [
    result({ columns: ["id", "name"], rows: [[3, "NOC"]] }),
    result({ columns: ["id", "name"], rows: [[3, "NOC"]] }),
    result({ columns: ["id"], rows: [] })
  ];
  const db = createTursoD1({ execute: async () => responses.shift() });

  assert.deepEqual(await db.prepare("SELECT 1").first(), { id: 3, name: "NOC" });
  assert.equal(await db.prepare("SELECT 1").first("name"), "NOC");
  assert.equal(await db.prepare("SELECT 1").first(), null);
});

test("run converte lastInsertRowid e alterações para meta compatível", async () => {
  const db = createTursoD1({
    execute: async () => result({ rowsAffected: 1, lastInsertRowid: 42n })
  });
  const response = await db.prepare("INSERT INTO roles(name) VALUES (?)").bind("teste").run();

  assert.equal(response.meta.last_row_id, 42);
  assert.equal(response.meta.changes, 1);
  assert.equal(response.meta.rows_written, 1);
});

test("batch envia statements atomicamente em modo write", async () => {
  let received;
  const client = {
    async batch(statements, mode) {
      received = { statements, mode };
      return [result({ rowsAffected: 1 }), result({ rowsAffected: 2 })];
    }
  };
  const db = createTursoD1(client);
  const responses = await db.batch([
    db.prepare("DELETE FROM sessions"),
    db.prepare("UPDATE users SET active=?").bind(false)
  ]);

  assert.deepEqual(received, {
    statements: [
      { sql: "DELETE FROM sessions", args: [] },
      { sql: "UPDATE users SET active=?", args: [0] }
    ],
    mode: "write"
  });
  assert.deepEqual(responses.map(item => item.meta.changes), [1, 2]);
});

test("configuração ausente falha sem expor credenciais", () => {
  assert.throws(() => getTursoD1({}), /TURSO_DATABASE_URL não configurado/);
  assert.throws(
    () => getTursoD1({ TURSO_DATABASE_URL: "libsql://db.example" }),
    /TURSO_AUTH_TOKEN não configurado/
  );
});
