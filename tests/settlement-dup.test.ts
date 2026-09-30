// זיכויי סליקה: חשד לכפילות, יומן רישום/מחיקה, והפער שתמונת הכסף מציגה.
import { beforeEach, expect, test } from "vitest";
import { freshDb } from "./d1";
import { addSettlement, deleteSettlement, pendingGross, resolveGross, settlementSuspicion } from "../src/lib/finance.server";
import { moneySnapshot } from "../src/lib/finance.summary.server";

let db: ReturnType<typeof freshDb>;
beforeEach(() => {
  db = freshDb();
  db.raw.exec("DELETE FROM seed_sales; DELETE FROM fin_settlements; DELETE FROM fin_settlement_log;");
});

const sale = (price: number, pay = "shopify") =>
  db.prepare("INSERT INTO seed_sales (item_label, buyer, qty, price, sold_at, ship_status, pay_method) VALUES ('א', 'x', 1, ?, '2026-09-10', 'delivered', ?)").bind(price, pay).run();

test("זיכוי ראשון על מכירות פתוחות: אין חשד", async () => {
  await sale(2400);
  expect(await settlementSuspicion({ date: "2026-09-15", provider: "shopify", net: 2368 })).toEqual([]);
});

test("אותו זיכוי פעמיים: חשד עם מספר הזיכוי הקיים, וגם 'אין מה לסגור'", async () => {
  await sale(2400);
  const first = await addSettlement({ date: "2026-09-15", provider: "shopify", net: 2368, actor: "avia" });
  expect(first.gross).toBe(2400); // סגר את כל הפתוח
  const again = await settlementSuspicion({ date: "2026-09-16", provider: "shopify", net: 2368 });
  expect(again.some((r) => r.includes(`#${first.id}`))).toBe(true);
  expect(again.some((r) => r.includes("אין אצל הסולק"))).toBe(true);
  // סכום אחר עם ברוטו מפורש: לא זהה
  expect((await settlementSuspicion({ date: "2026-09-16", provider: "shopify", net: 1200, gross: 1230 })).some((r) => r.includes("זהה"))).toBe(false);
  // מחוץ לטווח של 3 ימים: לא זהה
  expect((await settlementSuspicion({ date: "2026-09-25", provider: "shopify", net: 2368, gross: 2400 })).some((r) => r.includes("זהה"))).toBe(false);
});

test("רק שופיפיי ממתין אצל סולק: ביט ומזומן לא נכנסים לברוטו הפתוח", async () => {
  await sale(1000);
  await sale(500, "bit");
  await sale(300, "cash");
  expect(await pendingGross()).toEqual({ shopify: 1000 });
});

test("הפקדה חלקית סוגרת רק את הברוטו המשוער שלה, לפי העמלה מההגדרות", async () => {
  expect(resolveGross(10000, 9760, 0.024)).toEqual({ gross: 10000, partial: false });
  expect(resolveGross(10000, 4880, 0.024)).toEqual({ gross: 5000, partial: true });
  expect(resolveGross(0, 500, 0.024)).toEqual({ gross: 0, partial: false });
  await sale(10000);
  db.raw.exec(`INSERT INTO settings (key, value) VALUES ('fee_rates', '{"shopify":0.024}') ON CONFLICT(key) DO UPDATE SET value = excluded.value`);
  const s = await addSettlement({ date: "2026-09-15", provider: "shopify", net: 4880, actor: "lior" });
  expect(s.gross).toBe(5000);
  expect(s.note).toContain("הפקדה חלקית");
  expect((await pendingGross()).shopify).toBe(5000);
});

test("יומן: רישום ומחיקה נשמרים, והזיכוי המחוק נשאר בהיסטוריה", async () => {
  const s = await addSettlement({ date: "2026-09-15", provider: "shopify", net: 1430, gross: 1460, actor: "avia", reason: "אושר למרות חשד: בדיקה" });
  await deleteSettlement(s.id, "avia");
  const log = (await db.prepare("SELECT action, data, actor, reason FROM fin_settlement_log WHERE settlement_id = ? ORDER BY id").bind(s.id).all<{ action: string; data: string; actor: string; reason: string }>()).results ?? [];
  expect(log.map((l) => l.action)).toEqual(["add", "delete"]);
  expect(JSON.parse(log[1].data).net).toBe(1430);
  expect(log[0].reason).toContain("אושר למרות חשד");
  expect(log[0].actor).toBe("avia");
});

test("כפילות שכבר ברשומות מופיעה ברשימת הפערים, בלי למחוק כלום", async () => {
  await db.prepare("INSERT INTO fin_settlements (date, provider, net, gross) VALUES ('2026-09-15', 'shopify', 2368, 2400), ('2026-09-16', 'shopify', 2368, 0)").run();
  const snap = await moneySnapshot(db as never, { now: new Date("2026-09-18T09:00:00Z") });
  expect(snap.gaps.some((g) => g.key.startsWith("settlement_dup:"))).toBe(true);
  expect((await db.prepare("SELECT COUNT(*) AS n FROM fin_settlements").first<{ n: number }>())?.n).toBe(2);
});
