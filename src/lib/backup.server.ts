// Nightly full-data backup: dumps every business table to a JSON file in the
// board's own R2 bucket (backups/hob-backup-YYYY-MM-DD.json, 03:00 Israel
// time). D1 itself is Cloudflare-managed and durable, but this gives the
// partners their own restorable copy. Same-day reruns overwrite the same key,
// and files older than KEEP_BACKUPS days are pruned so the bucket never grows
// unbounded. The table list is read from sqlite_master, so a new table is
// backed up the night it is created.
import type { D1Database, R2Bucket } from "@cloudflare/workers-types";
import { ilTodayISO } from "./summary.server";

type BackupEnv = {
  DB?: D1Database;
  STORAGE?: R2Bucket;
};

// Daily files kept before pruning: enough history to recover from a mistake
// discovered weeks later, small enough to stay far inside the free tier.
const KEEP_BACKUPS = 45;

// Operational tables with no business value in a restore. Sessions are login
// tokens and never leave the database.
const SKIP_TABLES = new Set([
  "d1_migrations",
  "login_attempts",
  "rate_limits",
  "sessions",
  "push_subs",
  "shopify_push_queue",
]);

// Columns that never land in a backup file (credentials).
const SKIP_COLUMNS: Record<string, Set<string>> = {
  users: new Set(["pass_hash"]),
};

// Settings rows that must never land in a backup file: credentials and
// webhook secrets. Everything else is business state and goes in.
function isSecretSetting(key: string): boolean {
  return /password|secret|token|api_key/i.test(key);
}

export async function listBackupTables(db: D1Database): Promise<string[]> {
  const res = await db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY name",
    )
    .all<{ name: string }>();
  return (res.results ?? [])
    .map((r) => r.name)
    .filter((n) => !SKIP_TABLES.has(n) && n !== "settings");
}

function stripColumns(table: string, rows: Record<string, unknown>[]): Record<string, unknown>[] {
  const skip = SKIP_COLUMNS[table];
  if (!skip) return rows;
  return rows.map((r) => Object.fromEntries(Object.entries(r).filter(([k]) => !skip.has(k))));
}

export async function runBackup(
  env: BackupEnv,
): Promise<{ ok: boolean; slot: string; error?: string; tables?: number }> {
  if (!env.DB || !env.STORAGE) {
    return { ok: false, slot: "backup", error: "DB or STORAGE not configured" };
  }
  const dump: Record<string, unknown> = { exported_at: new Date().toISOString() };
  let tables: string[] = [];
  try {
    tables = await listBackupTables(env.DB);
  } catch (error) {
    return { ok: false, slot: "backup", error: `table list failed: ${String(error)}` };
  }
  for (const table of tables) {
    try {
      // Table names come from sqlite_master itself, never from user input.
      const rows = ((await env.DB.prepare(`SELECT * FROM "${table}"`).all()).results ?? []) as Record<string, unknown>[];
      dump[table] = stripColumns(table, rows);
    } catch (error) {
      // One broken table must not kill the whole backup.
      dump[table] = { error: String(error) };
    }
  }
  try {
    const s = await env.DB.prepare("SELECT key, value FROM settings").all<{
      key: string;
      value: string;
    }>();
    dump.settings = (s.results ?? []).filter((r) => !isSecretSetting(r.key));
  } catch (error) {
    dump.settings = { error: String(error) };
  }

  const today = ilTodayISO();
  try {
    await env.STORAGE.put(
      `backups/hob-backup-${today}.json`,
      JSON.stringify(dump, null, 1),
      { httpMetadata: { contentType: "application/json" } },
    );
    // Prune the oldest files beyond the retention window. Keys embed the date,
    // so lexicographic order IS chronological order.
    const listed = await env.STORAGE.list({ prefix: "backups/hob-backup-" });
    const keys = listed.objects.map((o) => o.key).sort();
    for (const key of keys.slice(0, Math.max(0, keys.length - KEEP_BACKUPS))) {
      await env.STORAGE.delete(key);
    }
    // Receipt images: the dump carries only their R2 keys, the bytes exist
    // once. Mirror them under backups/receipts/ so an accidental delete cannot
    // cost the partners a tax document. Append-only.
    try {
      const receipts = await env.STORAGE.list({ prefix: "receipts/" });
      const mirrored = await env.STORAGE.list({ prefix: "backups/receipts/" });
      const have = new Set(mirrored.objects.map((o) => o.key));
      for (const obj of receipts.objects) {
        const dest = `backups/${obj.key}`;
        if (have.has(dest)) continue;
        const body = await env.STORAGE.get(obj.key);
        if (body) await env.STORAGE.put(dest, body.body, { httpMetadata: body.httpMetadata });
      }
    } catch (error) {
      // The dump is the critical part; a failed mirror must not fail the run.
      console.error("receipt mirror failed", error);
    }
    return { ok: true, slot: "backup", tables: tables.length };
  } catch (error) {
    return { ok: false, slot: "backup", error: String(error) };
  }
}
