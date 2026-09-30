// The notification gate. Every source (orders, reminders, digests, collab)
// calls notify() instead of pushing straight to the phone, and the gate
// decides: now, in the morning digest, or just log it. The rules:
//   1. Quiet hours 21:00-08:00: everything waits for the morning, orders too.
//   2. A daily cap of 3 alerts, orders not counted. The rest moves to tomorrow.
//   3. One alert per topic in 24 hours. No nagging.
//   4. Orders that arrive within 10 minutes are merged into one alert.
//   5. Each level can be switched off separately (settings.notify_config).
import type { D1Database } from "@cloudflare/workers-types";
import { pushNotify, type PushEnv } from "./push.server";
import { ilOffsetMs } from "./summary.server";

export type NotifyLevel = "now" | "morning" | "weekly" | "silent";
export type NotifyInput = { level: NotifyLevel; topic: string; title: string; body?: string; url?: string; isOrder?: boolean };
export type NotifyResult = { status: "sent" | "held" | "dropped" | "logged"; reason: string };
export type NotifyConfig = { quietStart: number; quietEnd: number; dailyCap: number; levels: { now: boolean; morning: boolean; weekly: boolean } };

const DEFAULTS: NotifyConfig = { quietStart: 21, quietEnd: 8, dailyCap: 3, levels: { now: true, morning: true, weekly: true } };
export const ORDER_COALESCE_MIN = 10;
const DEDUPE_HOURS = 24;
export const DEFAULT_URL = "/?tab=hobi";

export async function notifyConfig(db: D1Database): Promise<NotifyConfig> {
  try {
    const row = await db.prepare("SELECT value FROM settings WHERE key = 'notify_config'").first<{ value: string }>();
    const saved = JSON.parse(row?.value || "{}") as Partial<NotifyConfig>;
    return { ...DEFAULTS, ...saved, levels: { ...DEFAULTS.levels, ...(saved.levels ?? {}) } };
  } catch {
    return DEFAULTS;
  }
}

export async function setNotifyConfig(db: D1Database, patch: Partial<NotifyConfig>): Promise<NotifyConfig> {
  const cur = await notifyConfig(db);
  const clampHour = (v: unknown, d: number) => (typeof v === "number" && v >= 0 && v <= 23 ? Math.round(v) : d);
  const next: NotifyConfig = {
    quietStart: clampHour(patch.quietStart, cur.quietStart),
    quietEnd: clampHour(patch.quietEnd, cur.quietEnd),
    dailyCap: typeof patch.dailyCap === "number" && patch.dailyCap >= 0 && patch.dailyCap <= 20 ? Math.round(patch.dailyCap) : cur.dailyCap,
    levels: { ...cur.levels, ...(patch.levels ?? {}) },
  };
  await db.prepare("INSERT INTO settings (key, value) VALUES ('notify_config', ?1) ON CONFLICT(key) DO UPDATE SET value = ?1").bind(JSON.stringify(next)).run();
  return next;
}

const ilHour = (now: Date) => new Date(now.getTime() + ilOffsetMs(now)).getUTCHours();
export function inQuietHours(cfg: NotifyConfig, now: Date): boolean {
  const h = ilHour(now);
  return cfg.quietStart > cfg.quietEnd ? h >= cfg.quietStart || h < cfg.quietEnd : h >= cfg.quietStart && h < cfg.quietEnd;
}
/** Start of the current Israel day, as UTC in SQLite's format. */
function ilDayStartSql(now: Date): string {
  const off = ilOffsetMs(now);
  const il = new Date(now.getTime() + off);
  return new Date(Date.UTC(il.getUTCFullYear(), il.getUTCMonth(), il.getUTCDate()) - off).toISOString().slice(0, 19).replace("T", " ");
}
const sql = (d: Date) => d.toISOString().slice(0, 19).replace("T", " ");

async function log(db: D1Database, n: NotifyInput, status: NotifyResult["status"], reason: string, now: Date): Promise<void> {
  await db
    .prepare("INSERT INTO notify_log (level, topic, title, body, url, status, reason, created_at, sent_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .bind(n.level, n.topic, n.title.slice(0, 120), (n.body ?? "").slice(0, 300), n.url ?? DEFAULT_URL, status, reason, sql(now), status === "sent" ? sql(now) : null)
    .run();
}

export async function notify(env: PushEnv, n: NotifyInput, now = new Date()): Promise<NotifyResult> {
  if (!env.DB) return { status: "dropped", reason: "no_db" };
  const db = env.DB;
  const done = async (status: NotifyResult["status"], reason: string): Promise<NotifyResult> => {
    await log(db, n, status, reason, now);
    return { status, reason };
  };
  if (n.level === "silent") return done("logged", "");
  const cfg = await notifyConfig(db);
  if (!cfg.levels[n.level === "now" ? "now" : n.level]) return done("dropped", "level_off");

  // Once per topic. Orders are not duplicates (each order is a new event).
  if (n.topic && !n.isOrder) {
    const dup = await db
      .prepare("SELECT id FROM notify_log WHERE topic = ? AND status IN ('sent','held') AND created_at >= ? LIMIT 1")
      .bind(n.topic, sql(new Date(now.getTime() - DEDUPE_HOURS * 3600000)))
      .first<{ id: number }>();
    if (dup) return done("dropped", "duplicate");
  }
  // The "morning" level is never pushed on its own: it is collected into the one morning digest.
  if (n.level === "morning") return done("held", "morning_digest");
  if (n.level === "now" && inQuietHours(cfg, now)) return done("held", "quiet_hours");
  if (n.level === "now" && n.isOrder) {
    // A second order inside the merge window waits; flushHeldOrders sends them together when the window closes.
    const recent = await db
      .prepare("SELECT id FROM notify_log WHERE topic = 'order' AND status IN ('sent','held') AND created_at >= ? LIMIT 1")
      .bind(sql(new Date(now.getTime() - ORDER_COALESCE_MIN * 60000)))
      .first<{ id: number }>();
    if (recent) return done("held", "coalesced");
  }
  if (n.level === "now" && !n.isOrder) {
    const sentToday = await db
      .prepare("SELECT COUNT(*) AS c FROM notify_log WHERE status = 'sent' AND topic <> 'order' AND level IN ('now','morning') AND created_at >= ?")
      .bind(ilDayStartSql(now))
      .first<{ c: number }>();
    if ((sentToday?.c ?? 0) >= cfg.dailyCap) return done("held", "daily_cap");
  }
  await pushNotify(env, n.title, n.body ?? "", n.url ?? DEFAULT_URL);
  return done("sent", "");
}

/** Orders held for merging, after the window closed: one alert for all of them. */
export async function flushHeldOrders(env: PushEnv, now = new Date()): Promise<number> {
  if (!env.DB) return 0;
  const db = env.DB;
  const cfg = await notifyConfig(db);
  if (inQuietHours(cfg, now) || !cfg.levels.now) return 0;
  const held = (await db.prepare("SELECT id, title, body, url FROM notify_log WHERE topic = 'order' AND status = 'held' AND reason = 'coalesced' ORDER BY id").all<{ id: number; title: string; body: string; url: string }>()).results ?? [];
  if (!held.length) return 0;
  const newest = await db.prepare("SELECT MAX(created_at) AS t FROM notify_log WHERE topic = 'order' AND status = 'held' AND reason = 'coalesced'").first<{ t: string }>();
  if (newest?.t && Date.parse(`${newest.t.replace(" ", "T")}Z`) > now.getTime() - ORDER_COALESCE_MIN * 60000) return 0; // window still open
  const claimed = await db.prepare(`UPDATE notify_log SET status = 'sent', reason = 'coalesced_flush', sent_at = ? WHERE status = 'held' AND reason = 'coalesced' AND id IN (${held.map((h) => h.id).join(",")})`).bind(sql(now)).run();
  if ((claimed.meta?.changes ?? 0) === 0) return 0;
  await pushNotify(env, held.length === 1 ? held[0].title : `💸 ${held.length} הזמנות חדשות`, held.map((h) => h.body).join(" · ").slice(0, 280), held[0].url || DEFAULT_URL);
  return held.length;
}

/** When the DO must wake to release held orders (or null when there are none). */
export async function nextNotifyEpoch(db: D1Database | undefined): Promise<number | null> {
  if (!db) return null;
  try {
    const row = await db.prepare("SELECT MAX(created_at) AS t FROM notify_log WHERE topic = 'order' AND status = 'held' AND reason = 'coalesced'").first<{ t: string | null }>();
    return row?.t ? Date.parse(`${row.t.replace(" ", "T")}Z`) + ORDER_COALESCE_MIN * 60000 + 5000 : null;
  } catch {
    return null;
  }
}

/** The one morning message: everything that was held (night, cap, "morning"
 *  level) plus extra lines the caller adds (the brief's headline, open
 *  pending actions). A day with nothing = no message and no push. */
export async function morningDigest(env: PushEnv, extra: { lines?: string[] } = {}, now = new Date()): Promise<{ sent: boolean; items: number }> {
  if (!env.DB) return { sent: false, items: 0 };
  const db = env.DB;
  const cfg = await notifyConfig(db);
  const held = (await db.prepare("SELECT id, topic, title, body FROM notify_log WHERE status = 'held' AND reason <> 'coalesced' ORDER BY id").all<{ id: number; topic: string; title: string; body: string }>()).results ?? [];
  const orders = held.filter((h) => h.topic === "order");
  const others = held.filter((h) => h.topic !== "order");
  const lines: string[] = [];
  if (orders.length) lines.push(orders.length === 1 ? orders[0].title : `💸 ${orders.length} הזמנות נכנסו בלילה`);
  for (const l of (extra.lines ?? []).slice(0, 4)) lines.push(l);
  for (const h of others.slice(0, 4)) lines.push(h.title);
  if (others.length > 4) lines.push(`ועוד ${others.length - 4}`);
  if (held.length) await db.prepare(`UPDATE notify_log SET status = 'sent', reason = reason || '>digest', sent_at = ? WHERE id IN (${held.map((h) => h.id).join(",")})`).bind(sql(now)).run();
  if (!lines.length || !cfg.levels.morning) return { sent: false, items: lines.length };
  const text = `בוקר טוב.\n${lines.map((l) => `• ${l}`).join("\n")}`;
  await db.prepare("INSERT INTO assistant_chat (chat_id, role, content, kind) VALUES (1, 'assistant', ?, 'note')").bind(text.slice(0, 900)).run();
  await log(db, { level: "morning", topic: "digest", title: lines[0], body: lines.slice(1).join(" · ") }, "sent", "digest", now);
  await pushNotify(env, lines.length === 1 ? lines[0] : `בוקר טוב. ${lines.length} דברים מחכים`, lines.slice(0, 3).join(" · ").slice(0, 280));
  return { sent: true, items: lines.length };
}
