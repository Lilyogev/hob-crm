// Hobi's scheduled jobs: the Israel clock helpers, the alarm schedule of the
// SummaryAgent Durable Object (src/server.ts), and the Sun/Tue/Thu brief.
// The brief is rule-based (no model call): overdue / due-today / stuck tasks
// by owner, plus the open pending actions. Digests go into Hobi's board
// thread (assistant_chat chat_id 1, kind 'note').
import type { D1Database } from "@cloudflare/workers-types";
import { OWNER_LABEL, partnerLabel } from "./partners";

type AgentEnv = {
  DB?: D1Database;
};

export type Slot = "brief" | "backup" | "shopify";

type Task = {
  id: number;
  group_id: number;
  title: string;
  notes: string;
  status: string;
  priority: string;
  owner: string;
  due_date: string;
  created_at: string;
  updated_at: string;
};

// ---- Israel time helpers (DST-safe via Intl) ----

export function ilOffsetMs(date = new Date()): number {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Jerusalem",
    timeZoneName: "shortOffset",
  });
  const tz = fmt.formatToParts(date).find((p) => p.type === "timeZoneName")?.value ?? "GMT+2";
  const m = tz.match(/GMT([+-]\d+)(?::(\d+))?/);
  const h = m ? parseInt(m[1], 10) : 2;
  const mm = m && m[2] ? parseInt(m[2], 10) : 0;
  return (h * 60 + (h < 0 ? -mm : mm)) * 60000;
}

// A Date whose UTC fields equal the Israel wall clock.
export function ilClock(date = new Date()): Date {
  return new Date(date.getTime() + ilOffsetMs(date));
}

export function ilTodayISO(date = new Date()): string {
  const c = ilClock(date);
  const m = `${c.getUTCMonth() + 1}`.padStart(2, "0");
  const d = `${c.getUTCDate()}`.padStart(2, "0");
  return `${c.getUTCFullYear()}-${m}-${d}`;
}

export const WEEKDAY_NAMES = ["ראשון", "שני", "שלישי", "רביעי", "חמישי", "שישי", "שבת"];
// Sun / Tue / Thu mornings.
const BRIEF_WEEKDAYS = new Set([0, 2, 4]);

// Next fire time as a UTC epoch (ms): 03:00 every night (backup), 08:00 on
// Sun/Tue/Thu (brief) and Thursday 18:00 (the weekly Shopify report). Fires
// at :00:30 Israel time.
export function nextFireEpoch(now = new Date()): number {
  const off = ilOffsetMs(now);
  const c = ilClock(now);
  let best = Number.POSITIVE_INFINITY;
  for (let dayAhead = 0; dayAhead <= 8; dayAhead++) {
    const y = c.getUTCFullYear();
    const mo = c.getUTCMonth();
    const d = c.getUTCDate() + dayAhead;
    const weekday = new Date(Date.UTC(y, mo, d)).getUTCDay();
    const hours = [3];
    if (BRIEF_WEEKDAYS.has(weekday)) hours.push(8);
    if (weekday === 4) hours.push(18);
    for (const h of hours) {
      const t = Date.UTC(y, mo, d, h, 0, 30) - off;
      if (t > now.getTime() + 60000 && t < best) best = t;
    }
  }
  return Number.isFinite(best) ? best : now.getTime() + 12 * 3600 * 1000;
}

// Which job should fire right now (with a generous catch-up window).
export function slotForNow(now = new Date()): Slot | null {
  const clock = ilClock(now);
  const hour = clock.getUTCHours();
  const weekday = clock.getUTCDay();
  if (weekday === 4 && hour >= 18 && hour < 21) return "shopify";
  if (BRIEF_WEEKDAYS.has(weekday) && hour >= 8 && hour < 11) return "brief";
  if (hour >= 3 && hour < 8) return "backup";
  return null;
}

// ---- Board reading ----

function ownerTag(t: Task): string {
  const label = t.owner in OWNER_LABEL && t.owner ? OWNER_LABEL[t.owner as keyof typeof OWNER_LABEL] : partnerLabel(t.owner);
  return label && label !== "—" ? ` (${label})` : "";
}

const shortDay = (d: string) => `${Number(d.slice(8, 10))}.${Number(d.slice(5, 7))}`;

function list(tasks: Task[], max = 6, withDue = false): string {
  const lines = tasks.slice(0, max).map((t) => `• ${t.title}${ownerTag(t)}${withDue && t.due_date ? ` · יעד ${shortDay(t.due_date)}` : ""}`);
  if (tasks.length > max) lines.push(`  ...ועוד ${tasks.length - max}`);
  return lines.join("\n");
}

async function loadTasks(db: D1Database): Promise<Task[]> {
  const res = await db
    .prepare(
      "SELECT id, group_id, title, notes, status, priority, owner, due_date, created_at, updated_at FROM tasks WHERE status NOT IN ('done','archived')",
    )
    .all<Task>();
  return res.results ?? [];
}

async function brandName(db: D1Database): Promise<string> {
  try {
    const row = await db.prepare("SELECT value FROM settings WHERE key = 'brand_name'").first<{ value: string }>();
    return row?.value || "hob";
  } catch {
    return "hob";
  }
}

// ---- The brief ----

export type Brief = { text: string; headline: string; items: number };

export async function buildBrief(db: D1Database, now = new Date()): Promise<Brief> {
  const clock = ilClock(now);
  const weekdayIdx = clock.getUTCDay();
  const today = ilTodayISO(now);
  const brand = await brandName(db);
  const parts: string[] = [`📋 תדריך ${brand} · יום ${WEEKDAY_NAMES[weekdayIdx]} ${clock.getUTCDate()}.${clock.getUTCMonth() + 1}`];
  const headlineBits: string[] = [];
  let items = 0;

  try {
    const open = await loadTasks(db);
    const overdue = open.filter((t) => t.due_date && t.due_date < today).sort((a, b) => a.due_date.localeCompare(b.due_date));
    const dueToday = open.filter((t) => t.due_date === today);
    const stuck = open.filter((t) => t.status === "stuck" && !overdue.includes(t) && !dueToday.includes(t));
    if (overdue.length) {
      parts.push(`⚠️ עברו את התאריך:\n${list(overdue, 6, true)}`);
      headlineBits.push(overdue.length === 1 ? "משימה אחת עברה את התאריך" : `${overdue.length} משימות עברו את התאריך`);
    }
    if (dueToday.length) {
      parts.push(`📅 יעד היום:\n${list(dueToday)}`);
      headlineBits.push(dueToday.length === 1 ? "אחת ליום" : `${dueToday.length} להיום`);
    }
    if (stuck.length) {
      parts.push(`🔴 תקועות:\n${list(stuck)}`);
      headlineBits.push(stuck.length === 1 ? "אחת תקועה" : `${stuck.length} תקועות`);
    }
    items += overdue.length + dueToday.length + stuck.length;
    // Who carries what: a one-line split so both partners see the balance.
    const byOwner = new Map<string, number>();
    for (const t of open) byOwner.set(t.owner, (byOwner.get(t.owner) ?? 0) + 1);
    if (open.length) {
      const split = [...byOwner.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([o, n]) => `${o ? partnerLabel(o) : "בלי אחראית"} ${n}`)
        .join(" · ");
      parts.push(`📂 פתוחות: ${open.length} (${split})`);
    }
    if (!overdue.length && !dueToday.length && !stuck.length) parts.push("📌 הלוח נקי: אין תקועות ואין חריגות תאריך. 👏");
  } catch {
    // A board read failure must never kill the brief.
  }

  // Actions Hobi is still holding for a confirmation.
  try {
    const pending =
      (
        await db
          .prepare("SELECT summary FROM assistant_pending WHERE status = 'pending' AND expires_at > datetime('now') ORDER BY id DESC LIMIT 5")
          .all<{ summary: string }>()
      ).results ?? [];
    if (pending.length) {
      parts.push(`⏳ מחכות לאישור שלכן:\n${pending.map((p) => `• ${p.summary.split(" || ")[0].slice(0, 90)}`).join("\n")}`);
      headlineBits.push(pending.length === 1 ? "אישור אחד מחכה" : `${pending.length} אישורים מחכים`);
      items += pending.length;
    }
  } catch {
    // no pending table yet
  }

  const nextDay = weekdayIdx === 0 ? "שלישי" : weekdayIdx === 2 ? "חמישי" : "ראשון";
  parts.push(`התדריך הבא: יום ${nextDay} ב-8:00. לכל שאלה, פשוט כתבו לי כאן 💬`);
  const headline = headlineBits.length ? `תדריך הבוקר: ${headlineBits.join(", ")}` : "תדריך הבוקר: הלוח נקי";
  return { text: parts.join("\n\n"), headline, items };
}

// ---- Board thread delivery ----

// The partners' channel is Hobi's tab in the board. Scheduled digests and
// business alerts are written into the thread as notes (kind 'note'): shown
// in the chat, never fed back to the model as history.
async function postBoardMessage(db: D1Database, text: string): Promise<void> {
  await db
    .prepare("INSERT INTO assistant_chat (chat_id, role, content, kind) VALUES (1, 'assistant', ?, 'note')")
    .bind(text.slice(0, 4000))
    .run();
  await db
    .prepare(
      "DELETE FROM assistant_chat WHERE chat_id = 1 AND id NOT IN (SELECT id FROM assistant_chat WHERE chat_id = 1 ORDER BY id DESC LIMIT 400)",
    )
    .run();
}

export async function deliverToPartners(
  env: AgentEnv,
  text: string,
): Promise<{ ok: boolean; error?: string }> {
  let boardOk = false;
  if (env.DB) {
    try {
      await postBoardMessage(env.DB, text);
      boardOk = true;
    } catch (error) {
      console.error("board delivery failed", error);
    }
  }
  return boardOk ? { ok: true } : { ok: false, error: "board thread write failed" };
}

// ---- Real-time board notifications (task added / completed) ----

export async function notifyBoardEvent(
  env: AgentEnv,
  kind: "added" | "completed" | "deleted" | "custom",
  actor: string,
  taskTitle: string,
  groupTitle?: string,
): Promise<void> {
  const name = partnerLabel(actor) || "מישהי";
  let text: string;
  if (kind === "custom") {
    // Pre-formatted message (a sale, a stock warning), sent verbatim.
    text = taskTitle;
  } else if (kind === "added") {
    text = `🆕 ${name} הוסיפה ללוח: "${taskTitle}"${groupTitle ? ` · ${groupTitle}` : ""}`;
  } else if (kind === "completed") {
    text = `✅ ${name} סיימה: "${taskTitle}" 👏`;
  } else {
    text = `🗑 ${name} מחקה מהלוח: "${taskTitle}"`;
  }
  try {
    // Business events (the "custom" kind) go to the board thread. Task
    // add/done/delete pings are dropped: the partner who triggers them is
    // already inside the board, and in the thread they would just be noise.
    if (kind === "custom") await deliverToPartners(env, text);
  } catch {
    // Notifications must never fail the user's action.
  }
}

export async function runSummaryAgent(
  env: AgentEnv,
  slot: Slot,
): Promise<{ ok: boolean; slot: string; error?: string; headline?: string; items?: number }> {
  if (!env.DB) return { ok: false, slot, error: "DB not bound" };
  if (slot !== "brief") return { ok: false, slot, error: "not a summary slot" };
  const brief = await buildBrief(env.DB);
  const sent = await deliverToPartners(env, brief.text);
  return { ok: sent.ok, slot, error: sent.error, headline: brief.headline, items: brief.items };
}
