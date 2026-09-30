// "מכירות בחלון": הגדרה אחת (orders.server salesWindow) לכל המסכים. ימים ישראליים כולל
// היום, בלי עתיד, sold_at או יום היצירה כשריק, ארכיון ומבוטלות בחוץ, הזמנות לפי מזהה.
import { beforeEach, expect, test } from "vitest";
import { freshDb } from "./d1";
import { countOrders, orderStats, salesByDaySeries, salesByItemWindows, salesWindow, shiftDay, windowBounds } from "../src/lib/orders.server";
import { ilOffsetMs, ilTodayISO } from "../src/lib/summary.server";

let db: ReturnType<typeof freshDb>;
const d1 = () => db as never;
const today = () => ilTodayISO();
const day = (ago: number) => shiftDay(today(), -ago);

async function sale(opts: { soldAt: string; price?: number; qty?: number; status?: string; channel?: string; ref?: string; createdAt?: string; pay?: string; itemId?: number | null }) {
  await db
    .prepare("INSERT INTO seed_sales (item_id, item_label, buyer, qty, price, ship_status, channel, order_ref, pay_method, sold_at, created_at) VALUES (?, 'חולצה', 'לקוח', ?, ?, ?, ?, ?, ?, ?, COALESCE(?, datetime('now')))")
    .bind(opts.itemId ?? null, opts.qty ?? 1, opts.price ?? 199, opts.status ?? "recorded", opts.channel ?? "", opts.ref ?? "", opts.pay ?? "shopify", opts.soldAt, opts.createdAt ?? null)
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
  expect(w.byPayMethod).toEqual({ shopify: 398 });
  // העטיפה הישנה מקבלת אותו גבול עליון
  expect((await orderStats(d1(), day(6))).orders).toBe(2);
  expect((await orderStats(d1(), day(7))).orders).toBe(3);
});

test("ארכיון ומבוטלות בחוץ; פופ-אפ נספר כברירת מחדל ויוצא רק עם includePopup: false", async () => {
  await sale({ soldAt: day(1), ref: "#1" });
  await sale({ soldAt: day(1), channel: "archive" });
  await sale({ soldAt: day(1), status: "cancelled" });
  await sale({ soldAt: day(1), channel: "popup", price: 149, pay: "bit" });
  expect(await salesWindow(d1(), { days: 7 })).toMatchObject({ orders: 2, revenue: 348 });
  const online = await salesWindow(d1(), { days: 7, includePopup: false });
  expect(online).toMatchObject({ orders: 1, revenue: 199 });
  expect(online.source).toContain("בלי פופ-אפ");
});

test("הזמנה = מזהה הזמנה: שתי שורות עם אותו מזהה הן הזמנה אחת, שורות בלי מזהה כל אחת לעצמה", async () => {
  await sale({ soldAt: day(0), ref: "#1", price: 199 });
  await sale({ soldAt: day(0), ref: "#1", price: 249 });
  await sale({ soldAt: day(0) });
  await sale({ soldAt: day(0) });
  expect(await salesWindow(d1(), { days: 1 })).toMatchObject({ orders: 3, lines: 4, units: 4, revenue: 846 });
  expect(countOrders([{ id: 1, order_ref: "#1009", note: "", qty: 2, price: 10 }, { id: 2, order_ref: "", note: "Shopify #1009", qty: 1, price: 10 }])).toEqual({ orders: 1, lines: 2, units: 3, revenue: 30 });
});

test("שורת Shopify בלי sold_at נספרת לפי יום היצירה בשעון ישראל", async () => {
  // 22:30 בלילה בישראל אתמול = אתמול, גם אם ב-UTC זה כבר יום אחר
  await sale({ soldAt: "", createdAt: createdAtIL(day(1), "22:30"), ref: "#10" });
  // 00:30 בלילה בישראל היום = היום, למרות ש-UTC עדיין אתמול
  await sale({ soldAt: "", createdAt: createdAtIL(day(0), "00:30"), ref: "#11" });
  const { series } = await salesByDaySeries(d1(), { days: 7 });
  expect(series.map((s) => [s.day, s.orders])).toEqual([[day(1), 1], [day(0), 1]]);
});

test("מכירות לפריט ב-7 וב-30 יום, ומה שנשאר בשני המיקומים", async () => {
  await db.prepare("INSERT INTO seed_items (id, name, price) VALUES (5, 'כובע', 99)").run();
  await db.prepare("INSERT INTO seed_stock (item_id, location, qty) VALUES (5, 'avia', 4), (5, 'lior', 2)").run();
  await sale({ soldAt: day(2), itemId: 5, ref: "#1" });
  await sale({ soldAt: day(20), itemId: 5, ref: "#2", qty: 2 });
  await sale({ soldAt: day(40), itemId: 5, ref: "#3" }); // מחוץ ל-30
  await sale({ soldAt: day(1), itemId: 5, status: "cancelled" });
  const w = await salesByItemWindows(d1());
  expect(w.items.find((i) => i.itemId === 5)).toMatchObject({ sold7: 1, sold30: 3, left: 6 });
  expect(w.asOf).toBe(today());
});
