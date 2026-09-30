import { beforeEach, expect, test } from "vitest";
import { freshDb } from "./d1";
import { addSettlement, deleteSettlement, settlementSuspicion } from "../src/lib/finance.server";
import { moneySnapshot } from "../src/lib/finance.summary.server";

let db: Awaited<ReturnType<typeof freshDb>>;
beforeEach(async () => {
  db = await freshDb();
  db.raw.exec("DELETE FROM seed_sales; DELETE FROM fin_settlements; DELETE FROM fin_settlement_log;");
});

test("זיכוי ראשון על מכירות פתוחות: אין חשד", async () => {
  await db.prepare("INSERT INTO seed_sales (item_label, buyer, qty, price, sold_at, ship_status, pay_method) VALUES ('א', 'x', 1, 2400, '2026-09-10', 'delivered', 'shopify')").run();
  expect(await settlementSuspicion({ date: "2026-09-15", provider: "shopify", net: 2368 })).toEqual([]);
});

test("אותו זיכוי פעמיים: חשד עם מספר הזיכוי הקיים, וגם 'אין מה לסגור'", async () => {
  await db.prepare("INSERT INTO seed_sales (item_label, buyer, qty, price, sold_at, ship_status, pay_method) VALUES ('א', 'x', 1, 2400, '2026-09-10', 'delivered', 'shopify')").run();
  const first = await addSettlement({ date: "2026-09-15", provider: "shopify", net: 2368, actor: "yogev" });
  const again = await settlementSuspicion({ date: "2026-09-16", provider: "shopify", net: 2368 });
  expect(again.some((r) => r.includes(`#${first.id}`))).toBe(true);
  expect(again.some((r) => r.includes("אין אצל הסולק"))).toBe(true);
  // ספק אחר או סכום אחר: לא זהה
  expect((await settlementSuspicion({ date: "2026-09-16", provider: "hyp", net: 2368, gross: 2400 })).some((r) => r.includes("זהה"))).toBe(false);
  // מחוץ לטווח של 3 ימים: לא זהה
  expect((await settlementSuspicion({ date: "2026-09-25", provider: "shopify", net: 2368, gross: 2400 })).some((r) => r.includes("זהה"))).toBe(false);
});

test("יומן: רישום ומחיקה נשמרים, והזיכוי המחוק נשאר בהיסטוריה", async () => {
  const s = await addSettlement({ date: "2026-09-15", provider: "hyp", net: 1430, gross: 1460, actor: "yogev", reason: "אושר למרות חשד: בדיקה" });
  await deleteSettlement(s.id, "yogev");
  const log = (await db.prepare("SELECT action, data, actor, reason FROM fin_settlement_log WHERE settlement_id = ? ORDER BY id").bind(s.id).all<{ action: string; data: string; actor: string; reason: string }>()).results ?? [];
  expect(log.map((l) => l.action)).toEqual(["add", "delete"]);
  expect(JSON.parse(log[1].data).net).toBe(1430);
  expect(log[0].reason).toContain("אושר למרות חשד");
});

test("כפילות שכבר ברשומות מופיעה ברשימת הפערים של אלכס, בלי למחוק כלום", async () => {
  await db.prepare("INSERT INTO fin_settlements (date, provider, net, gross) VALUES ('2026-09-15', 'shopify', 2368, 2400), ('2026-09-16', 'shopify', 2368, 0)").run();
  const snap = await moneySnapshot(db, { now: new Date("2026-09-18T09:00:00Z") });
  expect(snap.gaps.some((g) => g.key.startsWith("settlement_dup:"))).toBe(true);
  expect((await db.prepare("SELECT COUNT(*) AS n FROM fin_settlements").first<{ n: number }>())?.n).toBe(2);
});
