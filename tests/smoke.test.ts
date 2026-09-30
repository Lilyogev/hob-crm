import { expect, test } from "vitest";
import { freshDb } from "./d1";
import { getBoard, hashPassword } from "../src/lib/hob.server";
import { buildBrief, nextFireEpoch, slotForNow } from "../src/lib/summary.server";
import { listBackupTables } from "../src/lib/backup.server";

test("all migrations apply to a fresh database and seed the structural defaults", async () => {
  const db = freshDb();
  const groups = await db.prepare("SELECT COUNT(*) AS n FROM board_groups").first<{ n: number }>();
  expect(groups?.n).toBe(7);
  const s = await db.prepare("SELECT value FROM settings WHERE key = 'assistant_name'").first<{ value: string }>();
  expect(s?.value).toBe("הובי");
  const users = await db.prepare("SELECT COUNT(*) AS n FROM users").first<{ n: number }>();
  expect(users?.n).toBe(0); // users are created with scripts/create-user.mjs, never seeded
});

test("the board returns groups with their view", async () => {
  freshDb();
  const groups = await getBoard();
  const views = new Set(groups.map((g) => g.view));
  expect(views).toEqual(new Set(["shared", "avia", "lior"]));
  expect(groups.every((g) => Array.isArray(g.tasks))).toBe(true);
});

test("hashPassword produces the pbkdf2 format the create-user script prints", async () => {
  const h = await hashPassword("secret-123");
  expect(h).toMatch(/^pbkdf2-sha256\$100000\$[0-9a-f]{32}\$[0-9a-f]{64}$/);
  const again = await hashPassword("secret-123", h.split("$")[2]);
  expect(again).toBe(h);
});

test("the schedule: backup every night, brief on Sun/Tue/Thu, shopify on Thursday evening", () => {
  // 2026-09-17 is a Thursday. 15:00Z = 18:00 Israel.
  expect(slotForNow(new Date(Date.UTC(2026, 8, 17, 15, 1)))).toBe("shopify");
  expect(slotForNow(new Date(Date.UTC(2026, 8, 17, 5, 1)))).toBe("brief");
  expect(slotForNow(new Date(Date.UTC(2026, 8, 18, 5, 1)))).toBe(null); // Friday
  expect(slotForNow(new Date(Date.UTC(2026, 8, 18, 1, 0)))).toBe("backup");
  const next = nextFireEpoch(new Date(Date.UTC(2026, 8, 17, 15, 30)));
  expect(new Date(next).toISOString()).toBe("2026-09-18T00:00:30.000Z"); // 03:00 Israel
});

test("the brief lists overdue, due-today and stuck tasks by owner", async () => {
  const db = freshDb();
  await db.prepare("INSERT INTO tasks (group_id, title, owner, due_date) VALUES (1, 'לשלוח דוגמאות', 'avia', '2020-01-01')").run();
  await db.prepare("INSERT INTO tasks (group_id, title, owner, status) VALUES (5, 'צילום קולקציה', 'lior', 'stuck')").run();
  await db.prepare("INSERT INTO tasks (group_id, title, owner, status) VALUES (5, 'בוצע מזמן', 'lior', 'done')").run();
  const brief = await buildBrief(db as never);
  expect(brief.text).toContain("לשלוח דוגמאות (אביה)");
  expect(brief.text).toContain("צילום קולקציה (ליאור)");
  expect(brief.text).not.toContain("בוצע מזמן");
  expect(brief.headline).toContain("עברה את התאריך");
  expect(brief.items).toBe(2);
});

test("the backup skips sessions and never dumps password hashes", async () => {
  const db = freshDb();
  const tables = await listBackupTables(db as never);
  expect(tables).toContain("users");
  expect(tables).toContain("tasks");
  expect(tables).not.toContain("sessions");
  expect(tables).not.toContain("login_attempts");
});
