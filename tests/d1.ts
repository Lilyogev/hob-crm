// A minimal D1 over node:sqlite, enough for the board's raw-SQL style
// (prepare/bind/first/all/run/batch). Every call yields to the event loop first,
// so Promise.all really interleaves statements the way concurrent requests do.
import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { env } from "./cf-workers-stub";

const tick = () => new Promise<void>((r) => setImmediate(r));

class Stmt {
  private sql: string;
  private args: unknown[];
  // node:sqlite does not bind D1-style numbered parameters (?1, ?2 reused):
  // rewrite them to plain positional ones and repeat the values accordingly.
  constructor(private db: DatabaseSync, sql: string, args: unknown[] = []) {
    this.original = sql;
    if (/\?\d+/.test(sql) && args.length) {
      const expanded: unknown[] = [];
      this.sql = sql.replace(/\?(\d+)/g, (_m, n: string) => {
        expanded.push(args[Number(n) - 1]);
        return "?";
      });
      this.args = expanded;
    } else {
      this.sql = sql;
      this.args = args;
    }
  }
  private original?: string;
  bind(...args: unknown[]) {
    return new Stmt(this.db, this.original ?? this.sql, args.map((a) => (a === undefined ? null : a)));
  }
  async first<T>(): Promise<T | null> {
    await tick();
    return (this.db.prepare(this.sql).get(...(this.args as never[])) as T) ?? null;
  }
  async all<T>(): Promise<{ results: T[] }> {
    await tick();
    return { results: this.db.prepare(this.sql).all(...(this.args as never[])) as T[] };
  }
  async run() {
    await tick();
    const r = this.db.prepare(this.sql).run(...(this.args as never[]));
    return { success: true, meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } };
  }
  runSync() {
    return this.db.prepare(this.sql).run(...(this.args as never[]));
  }
}

export function freshDb() {
  const db = new DatabaseSync(":memory:");
  const dir = join(__dirname, "..", "migrations");
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".sql")).sort()) {
    try {
      db.exec(readFileSync(join(dir, f), "utf8"));
    } catch (error) {
      throw new Error(`migration ${f}: ${String(error)}`);
    }
  }
  const d1 = {
    prepare: (sql: string) => new Stmt(db, sql),
    batch: async (stmts: Stmt[]) => {
      await tick();
      db.exec("BEGIN");
      try {
        const out = stmts.map((s) => s.runSync());
        db.exec("COMMIT");
        return out;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
    raw: db,
  };
  env.DB = d1;
  return d1;
}
