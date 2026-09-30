import { beforeEach, expect, test } from "vitest";
import { freshDb } from "./d1";
import { financeDigest } from "../src/lib/assistant.server";
import { todayMoney } from "../src/lib/today.server";

let db: Awaited<ReturnType<typeof freshDb>>;
beforeEach(async () => {
  db = await freshDb();
  db.raw.exec("DELETE FROM seed_sales; DELETE FROM fin_expenses; DELETE FROM fin_settlements; DELETE FROM settings WHERE key = 'bank_opening';");
});

const money = async () => JSON.parse(await financeDigest(db as never)).expense_tracker.money;

test("ברונו: בלי יתרת פתיחה הבנק לא ידוע, לא אפס; כסף פנוי לא מחושב", async () => {
  const m = await money();
  expect(m.bank.value).toBeNull();
  expect(m.bank.note).toContain("יתרת פתיחה");
  expect(m.free_money.value).toBeNull();
});

test("ברונו ו'היום שלך' מציגים אותם מספרים, בלי מכירות מבוטלות", async () => {
  await db.prepare("INSERT INTO settings (key, value) VALUES ('bank_opening', '0')").run();
  await db.prepare("INSERT INTO seed_sales (item_label, buyer, qty, price, sold_at, ship_status, pay_method) VALUES ('א', 'x', 1, 300, '2026-09-10', 'delivered', 'transfer'), ('ב', 'y', 1, 540, '2026-09-10', 'cancelled', 'transfer'), ('ג', 'z', 1, 200, '2026-09-10', 'delivered', 'shopify'), ('ד', 'w', 1, 437, '2026-09-10', 'cancelled', 'shopify')").run();
  const m = await money();
  const t = await todayMoney(db as never);
  expect(m.bank.value).toBe(300);
  expect(m.waiting_at_clearers_gross.value).toBe(200);
  expect([t.bank.value, t.expected.value]).toEqual([m.bank.value, m.waiting_at_clearers_gross.value]);
});

test("ברונו: נתונים עסקיים עם מצב; תקרה ויעד מסומנים כתוכנית", async () => {
  const d = JSON.parse(await financeDigest(db as never));
  const byKey = Object.fromEntries(d.business_facts.map((f: { key: string; status: string }) => [f.key, f.status]));
  expect(byKey.investment_cap).toBe("מתוכנן");
  expect(byKey.revenue_goal).toBe("מתוכנן");
  expect(byKey.buyout_price).toBe("ממתין לאימות");
  expect(d.expense_tracker.total_budget_setting.kind).toContain("לא כסף");
});
