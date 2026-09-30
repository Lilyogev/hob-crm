// "מכירות בחלון": הגדרה אחת (orders.server salesWindow) לכל המסכים. ימים ישראליים כולל
// היום, בלי עתיד, sold_at או יום היצירה כשריק, ואותם מספרים ב"היום שלך", בכרטיסי הצוות,
// בדופק המכירות ובבריף.
import { beforeEach, expect, test } from "vitest";
import { freshDb } from "./d1";
import { orderStats, salesByDaySeries, salesWindow, shiftDay, windowBounds } from "../src/lib/orders.server";
import { ilOffsetMs, ilTodayISO, buildSummary } from "../src/lib/summary.server";
import { todayMoney } from "../src/lib/today.server";
import { workerKpis } from "../src/lib/team.server";
import { getFinance } from "../src/lib/finance.server";
import { salesByDay } from "../src/lib/campaign.server";

let db: ReturnType<typeof freshDb>;
const d1 = () => db as never;
const today = () => ilTodayISO();
const day = (ago: number) => shiftDay(today(), -ago);

async function sale(opts: { soldAt: string; price?: number; qty?: number; status?: string; channel?: string; ref?: string; createdAt?: string; pay?: string }) {
  await db
    .prepare("INSERT INTO seed_sales (item_label, buyer, qty, price, ship_status, channel, order_ref, pay_method, sold_at, created_at) VALUES ('חולצה', 'לקוח', ?, ?, ?, ?, ?, ?, ?, COALESCE(?, datetime('now')))")
    .bind(opts.qty ?? 1, opts.price ?? 199, opts.status ?? "recorded", opts.channel ?? "", opts.ref ?? "", opts.pay ?? "shopify", opts.soldAt, opts.createdAt ?? null)
    .run();
}
/** created_at (UTC, כמו datetime('now')) של רגע נתון בשעון ישראל. */
function createdAtIL(dayISO: string, hhmm: string): string {
  const wall = Date.parse(`${dayISO}T${hhmm}:00Z`);
  const utc = new Date(wall - ilOffsetMs(new Date(wall)));
  return utc.toISOString().slice(0, 19).replace("T", " ");
}

beforeEach(() => {
  db = freshDb();
  db.raw.exec("DELETE FROM seed_sales; DELETE FROM fin_settlements; DELETE FROM fin_expenses; DELETE FROM settings WHERE key IN ('bank_opening','bit_opening','cash_opening');");
});

test("חלון של 7 ימים = היום ועוד 6 אחורה: לפני 7 ימים בחוץ, היום בפנים, עתיד בחוץ", async () => {
  expect(windowBounds(7, { endDay: "2026-09-20" })).toEqual({ from: "2026-09-14", to: "2026-09-20", days: 7 });
  await sale({ soldAt: day(7), ref: "#1" }); // בחוץ
  await sale({ soldAt: day(6), ref: "#2" }); // הקצה הפנימי
  await sale({ soldAt: day(0), ref: "#3" }); // היום
  await sale({ soldAt: shiftDay(today(), 1), ref: "#4" }); // תאריך עתידי: לא נספר
  const w = await salesWindow(d1(), { days: 7 });
  expect(w).toMatchObject({ orders: 2, lines: 2, units: 2, revenue: 398, from: day(6), to: day(0), days: 7 });
  expect(w.source).toContain("ספר המכירות");
  // העטיפה הישנה מקבלת אותו גבול עליון
  expect((await orderStats(d1(), day(6))).orders).toBe(2);
  expect((await orderStats(d1(), day(7))).orders).toBe(3);
});

test("ארכיון ומבוטלות בחוץ; פופ-אפ נספר כברירת מחדל ויוצא רק עם includePopup: false", async () => {
  await sale({ soldAt: day(1), ref: "#1" });
  await sale({ soldAt: day(1), channel: "archive" });
  await sale({ soldAt: day(1), status: "cancelled" });
  await sale({ soldAt: day(1), channel: "popup", price: 149 });
  expect(await salesWindow(d1(), { days: 7 })).toMatchObject({ orders: 2, revenue: 348 });
  const online = await salesWindow(d1(), { days: 7, includePopup: false });
  expect(online).toMatchObject({ orders: 1, revenue: 199 });
  expect(online.source).toContain("בלי פופ-אפ");
  // הטאב הממומן: אונליין ופופ-אפ בנפרד, מאותה הגדרה
  const byDay = await salesByDay(day(7));
  expect(byDay).toEqual([{ day: day(1), orders: 1, revenue: 199, popup_orders: 1, popup_revenue: 149 }]);
});

test("שורת Shopify בלי sold_at נספרת לפי יום היצירה בשעון ישראל", async () => {
  // 22:30 בלילה בישראל אתמול = אתמול, גם אם ב-UTC זה כבר יום אחר לפי החישוב הישן
  await sale({ soldAt: "", createdAt: createdAtIL(day(1), "22:30"), ref: "#10" });
  // 00:30 בלילה בישראל היום = היום, למרות ש-UTC עדיין אתמול
  await sale({ soldAt: "", createdAt: createdAtIL(day(0), "00:30"), ref: "#11" });
  const { series } = await salesByDaySeries(d1(), { days: 7 });
  expect(series.map((s) => [s.day, s.orders])).toEqual([[day(1), 1], [day(0), 1]]);
});

test("אותו מספר בכל מסך: היום שלך, כרטיסי הצוות ודופק המכירות בטאב הכספים", async () => {
  await sale({ soldAt: day(0), ref: "#1", price: 199 });
  await sale({ soldAt: day(0), ref: "#1", price: 249 }); // שתי שורות, הזמנה אחת
  await sale({ soldAt: day(3), channel: "popup", price: 149 });
  await sale({ soldAt: day(6), ref: "#2", price: 199 });
  await sale({ soldAt: day(7), ref: "#3", price: 999 }); // מחוץ לחלון
  await sale({ soldAt: day(9), ref: "#4", price: 100 }); // בחלון הקודם
  const expected = { orders: 3, revenue: 796 };

  const money = await todayMoney(d1());
  expect(money.revenue7).toMatchObject({ value: expected.revenue, orders: expected.orders, from: day(6), to: day(0) });

  const kpis = await workerKpis(d1());
  const k = kpis.growth.find((x) => x.label.includes("הזמנות"));
  expect(k?.value).toBe(`${expected.orders} · ${expected.revenue.toLocaleString("en-US")} ₪`);
  expect(kpis.money[0].value).toBe(`${expected.revenue.toLocaleString("en-US")} ₪`);

  const fin = await getFinance();
  expect(fin.pulse?.last7).toMatchObject({ orders: expected.orders, units: 4, revenue: expected.revenue, from: day(6), to: day(0) });
  expect(fin.pulse?.prev7).toMatchObject({ orders: 2, revenue: 1099, from: day(13), to: day(7) });
  expect(fin.pulse?.weeks).toHaveLength(8);
  expect(fin.pulse?.weeks[7]).toMatchObject({ weeksAgo: 0, units: 4 });
  expect(fin.pulse?.weeks[6]).toMatchObject({ weeksAgo: 1, units: 2 });
});

test("זיכוי אחרון לפני יותר מ-14 יום: הבנק מסומן לא מאומת והכסף הפנוי לא מחושב", async () => {
  await db.prepare("INSERT INTO settings (key, value) VALUES ('bank_opening', '1000')").run();
  await db.prepare("INSERT INTO fin_settlements (date, provider, net, gross) VALUES (?, 'shopify', 98, 100)").bind(day(30)).run();
  await sale({ soldAt: day(1), ref: "#1" });
  const fin = await getFinance();
  const bank = fin.money?.balances.bank;
  expect(bank?.value).toBe(1098);
  expect(bank?.state).not.toBe("verified");
  expect(bank?.note).toContain("30 ימים");
  expect(bank?.asOf).toBe(day(30));
  expect(fin.money?.free.value).toBeNull();
  expect(fin.money?.free.note).toContain("זיכויים עדכניים");
  // ב"היום שלך" אותו מצב עובר הלאה, לא רק הערך
  const m = await todayMoney(d1());
  expect(m.bank).toMatchObject({ value: 1098, asOf: day(30), state: "recorded" });
  expect(m.bank.note).toContain("30 ימים");
});

test("הבריף סופר לפי ימים ישראליים: מכירה ב-22:30 אתמול נספרת כאתמול", async () => {
  await sale({ soldAt: "", createdAt: createdAtIL(day(1), "22:30"), ref: "#77", price: 199 });
  await sale({ soldAt: day(20), ref: "#78", price: 999 }); // ישן, לא בבריף
  const text = await buildSummary(d1(), "brief");
  expect(text).toContain("מכירות: 1 הזמנות · 1 יחידות · 199 ₪");
  expect(text).toContain("ספר המכירות");
  expect(text).not.toContain("999");
});
