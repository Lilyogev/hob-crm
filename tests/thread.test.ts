import { beforeEach, expect, test } from "vitest";
import { freshDb } from "./d1";
import { pendingLearn, recentThread, resolveLearn } from "../src/lib/team.server";
import { listFacts } from "../src/lib/team.memory.server";

let db: Awaited<ReturnType<typeof freshDb>>;
beforeEach(async () => {
  db = await freshDb();
});

test("שיחה קצרה: רק ריצות עם הודעה, 48 שעות, עד 3, הישן ראשון, לכל הכובעים של העובד", async () => {
  await db.prepare("INSERT INTO team_runs (agent, trigger, status, summary, report, command, created_at) VALUES ('finance','cron','ok','בוקר','דוח בוקר','', datetime('now','-1 hour'))").run();
  await db.prepare("INSERT INTO team_runs (agent, trigger, status, summary, report, command, created_at) VALUES ('finance','command','ok','ישן','דוח ישן','שאלה ישנה', datetime('now','-3 days'))").run();
  for (let i = 4; i >= 1; i--) await db.prepare("INSERT INTO team_runs (agent, trigger, status, summary, report, command, created_at) VALUES ('finance','command','ok',?,?,?, datetime('now', ?))").bind(`s${i}`, `תשובה ${i}`, `שאלה ${i}`, `-${i} hours`).run();
  await db.prepare("INSERT INTO team_runs (agent, trigger, status, summary, report, command, created_at) VALUES ('finance','command','error','נפל','','שאלה שנכשלה', datetime('now','-30 minutes'))").run();
  const t = await recentThread(db, ["finance"], "אלכס");
  expect(t).not.toContain("דוח בוקר");
  expect(t).not.toContain("שאלה ישנה");
  expect(t).not.toContain("שאלה 4"); // רק 3 אחרונות
  expect(t.indexOf("שאלה 2")).toBeLessThan(t.indexOf("שאלה 1"));
  expect(t).toContain("(הריצה נכשלה: נפל)");
  expect(t).toContain("אלכס:");
  expect(await recentThread(db, ["ads"], "יאן")).toBe("");
});

test("זיקוק: הצעה מחכה לאישור, ונשמרת כעובדה רק כשיוגב מאשר", async () => {
  await db.prepare("INSERT INTO settings (key, value) VALUES ('team_learn_money', ?)").bind(JSON.stringify({ text: "יוגב מעדיף דוחות בשורות קצרות", at: "2026-09-18T10:00:00Z", hat: "finance" })).run();
  expect((await pendingLearn(db, "money"))?.text).toContain("שורות קצרות");
  expect(await resolveLearn(db, "money", false)).toBe(true);
  expect(await pendingLearn(db, "money")).toBeNull();
  expect((await listFacts(db, "money")).some((f) => f.text.includes("שורות קצרות"))).toBe(false);
  await db.prepare("INSERT INTO settings (key, value) VALUES ('team_learn_ops', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind(JSON.stringify({ text: "יוגב מוסר ביד בגוש דן", at: "2026-09-18T10:00:00Z", hat: "shop" })).run();
  expect(await resolveLearn(db, "ops", true)).toBe(true);
  expect((await listFacts(db, "ops")).some((f) => f.text === "יוגב מוסר ביד בגוש דן")).toBe(true);
  expect(await resolveLearn(db, "ops", true)).toBe(false);
});
