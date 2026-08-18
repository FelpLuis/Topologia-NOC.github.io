import { createClient } from "@libsql/client/web";

function normalizeArgument(value) {
  if (value === undefined) return null;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (value instanceof Date) return value.toISOString();
  return value;
}

function rowsAsObjects(result) {
  return result.rows.map(row => Object.fromEntries(
    result.columns.map((column, index) => [column, row[index]])
  ));
}

function d1Meta(result) {
  return {
    changed_db: result.rowsAffected > 0,
    changes: result.rowsAffected,
    duration: 0,
    last_row_id: result.lastInsertRowid == null ? 0 : Number(result.lastInsertRowid),
    rows_read: result.rows.length,
    rows_written: result.rowsAffected,
    size_after: 0
  };
}

function d1Result(result) {
  return {
    success: true,
    results: rowsAsObjects(result),
    meta: d1Meta(result)
  };
}

export class TursoD1PreparedStatement {
  constructor(client, sql, args = []) {
    this.client = client;
    this.sql = String(sql);
    this.args = args.map(normalizeArgument);
  }

  bind(...args) {
    return new TursoD1PreparedStatement(this.client, this.sql, args);
  }

  toLibsqlStatement() {
    return { sql: this.sql, args: this.args };
  }

  async all() {
    return d1Result(await this.client.execute(this.toLibsqlStatement()));
  }

  async first(column) {
    const result = await this.client.execute(this.toLibsqlStatement());
    const row = rowsAsObjects(result)[0] ?? null;
    if (column === undefined) return row;
    return row == null ? null : row[column];
  }

  async run() {
    return d1Result(await this.client.execute(this.toLibsqlStatement()));
  }

  async raw(options = {}) {
    const result = await this.client.execute(this.toLibsqlStatement());
    const rows = result.rows.map(row => result.columns.map((_, index) => row[index]));
    return options.columnNames ? [result.columns, ...rows] : rows;
  }
}

export class TursoD1Database {
  constructor(client) {
    this.client = client;
  }

  prepare(sql) {
    return new TursoD1PreparedStatement(this.client, sql);
  }

  async batch(statements) {
    if (!Array.isArray(statements) || statements.some(statement => !(statement instanceof TursoD1PreparedStatement))) {
      throw new TypeError("Turso batch aceita somente statements preparados pelo adaptador.");
    }
    const results = await this.client.batch(
      statements.map(statement => statement.toLibsqlStatement()),
      "write"
    );
    return results.map(d1Result);
  }

  async exec(sql) {
    await this.client.executeMultiple(String(sql));
    return { count: 0, duration: 0 };
  }
}

export function createTursoD1(client) {
  return new TursoD1Database(client);
}

const databaseByEnvironment = new WeakMap();

export function getTursoD1(env) {
  if (!env || typeof env !== "object") throw new Error("Ambiente do Worker inválido.");

  let database = databaseByEnvironment.get(env);
  if (database) return database;

  const url = String(env.TURSO_DATABASE_URL || "").trim();
  const authToken = String(env.TURSO_AUTH_TOKEN || "").trim();
  if (!url) throw new Error("Secret TURSO_DATABASE_URL não configurado.");
  if (!authToken) throw new Error("Secret TURSO_AUTH_TOKEN não configurado.");

  // O cliente web usa fetch/HTTP e não mantém uma conexão TCP presa a uma
  // requisição. Reutilizá-lo por conjunto de bindings evita recriação em cada
  // consulta sem armazenar estado específico de usuário ou de request.
  database = createTursoD1(createClient({ url, authToken, intMode: "number" }));
  databaseByEnvironment.set(env, database);
  return database;
}
