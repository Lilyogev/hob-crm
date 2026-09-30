// Timed reminders ("תזכירי לי מחר ב-10"), created by Hobi's add_reminder tool
// and fired by the SummaryAgent Durable Object alarm (which re-arms itself to
// the earliest pending reminder, see server.ts).
import type { D1Database } from "@cloudflare/workers-types";
import { notify } from "./notify.server";
import type { PushEnv } from "./push.server";

export async function addReminder(
  db: D1Database,
  chatId: number,
  fireAtUtcIso: string,
  text: string,
): Promise<void> {
  await db
    .prepare("INSERT INTO reminders (chat_id, fire_at, text) VALUES (?, ?, ?)")
    .bind(chatId, fireAtUtcIso, text)
    .run();
}

// Epoch ms of the earliest pending reminder, or null when there is none.
export async function nextReminderEpoch(db: D1Database | undefined): Promise<number | null> {
  if (!db) return null;
  try {
    const row = await db
      .prepare("SELECT fire_at FROM reminders WHERE done = 0 ORDER BY fire_at LIMIT 1")
      .first<{ fire_at: string }>();
    if (!row) return null;
    const t = Date.parse(row.fire_at);
    return Number.isFinite(t) ? t : null;
  } catch {
    // Table may not exist yet mid-migration: never break the alarm chain.
    return null;
  }
}

// Fire every due reminder and mark it done. Reminders land in Hobi's board
// thread (chat_id 1) as a note, and go through the notification gate so the
// phone buzzes too.
export async function fireDueReminders(env: PushEnv): Promise<void> {
  if (!env.DB) return;
  try {
    const due = await env.DB.prepare(
      "SELECT id, text FROM reminders WHERE done = 0 AND fire_at <= ?",
    )
      .bind(new Date().toISOString())
      .all<{ id: number; text: string }>();
    for (const r of due.results ?? []) {
      try {
        await env.DB.prepare(
          "INSERT INTO assistant_chat (chat_id, role, content, kind) VALUES (1, 'assistant', ?, 'note')",
        )
          .bind(`⏰ תזכורת: ${r.text}`.slice(0, 4000))
          .run();
        await notify(env, { level: "now", topic: `reminder:${r.id}`, title: `⏰ ${r.text.slice(0, 70)}`, body: "תזכורת מהובי" });
      } finally {
        await env.DB.prepare("UPDATE reminders SET done = 1 WHERE id = ?").bind(r.id).run();
      }
    }
  } catch (error) {
    console.error("fire reminders failed", error);
  }
}
