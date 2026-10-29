// Local stand-in for Cloudflare D1 on Node's built-in SQLite, for tests and
// the mock server only. Never deployed.
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import type { D1Like, D1Statement } from "../auth/handler.ts";

type Value = string | number | bigint | null | Uint8Array;

export function sqliteD1(
  file = ":memory:",
  migration = "migrations/0001_auth.sql",
) {
  const db = new DatabaseSync(file);
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec(readFileSync(migration, "utf8"));
  const statement = (sql: string, values: Value[] = []): D1Statement => ({
    bind: (...next: unknown[]) =>
      statement(
        sql,
        next.map((v) => (v === undefined ? null : (v as Value))),
      ),
    first: async <T>() =>
      ((db.prepare(sql).get(...values) as T | undefined) ?? null) as T | null,
    run: async () => {
      const result = db.prepare(sql).run(...values);
      return { meta: { changes: Number(result.changes) } };
    },
  });
  return {
    DB: { prepare: (sql: string) => statement(sql) } satisfies D1Like,
    raw: db,
  };
}
