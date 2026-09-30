import { beforeEach, expect, test } from "vitest";
import { freshDb } from "./d1";
import { mergeManualRows, groupOrders, openOrdersGrouped, orderKeyOf, setDelivery, stockByLocation, workDaysSince, type SaleLine } from "../src/lib/orders.server";
import { confirmShip, prepareShip } from "../src/lib/today.server";

let db: Awaited<ReturnType<typeof freshDb>>;
beforeEach(async () => {
  db = await freshDb();
});

const line = (o: Partial<SaleLine>): SaleLine => ({ id: 1, item_id: 1, item_label: "חולצה", buyer: "דין אורן", buyer_phone: "050", buyer_address: "רחוב 1, תל אביב", qty: 1, size: "L", price: 199, ship_status: "recorded", location: "room", note: "", sold_at: "2026-09-14", order_ref: "", delivery: "", channel: "", ...o });

test("ימי עבודה: א'-ה' בלבד, בלי היום עצמו", () => {
  // 14.9.2026 = יום שני. עד יום שני 21.9: ג,ד,ה (3) + א,ב (2) = 5
  expect(workDaysSince("2026-09-14", new Date("2026-09-21T10:00:00Z"))).toBe(5);
  expect(workDaysSince("2026-09-17", new Date("2026-09-19T10:00:00Z"))).toBe(0); // חמישי → שבת: אין ימי עבודה
  expect(workDaysSince("2026-09-17", new Date("2026-09-20T10:00:00Z"))).toBe(1); // ראשון
});

test("הזמנה עם כמה פריטים = הזמנה אחת; שתי הזמנות של אותו לקוח באותו יום לא מתאחדות", () => {
  const rows = [
    line({ id: 1, order_ref: "#1106", item_label: "חולצה", size: "L" }),
    line({ id: 2, order_ref: "#1106", item_label: "כובע", size: "" }),
    line({ id: 3, order_ref: "#1107", item_label: "חולצה", size: "M" }), // אותו קונה, אותו יום, הזמנה אחרת
    line({ id: 4, order_ref: "", note: "10 אחוז הנחה", buyer: "שחר" }), // רשומה ידנית
    line({ id: 5, order_ref: "", note: "10 אחוז הנחה", buyer: "שחר" }), // עוד רשומה ידנית של אותו אדם: לא מתאחדת
  ];
  const orders = groupOrders(rows, { now: new Date("2026-09-15T10:00:00Z") });
  expect(orders).toHaveLength(4);
  const o1106 = orders.find((o) => o.ref === "#1106")!;
  expect(o1106.lines.map((l) => l.id)).toEqual([1, 2]);
  expect(o1106.total).toBe(398);
  expect(orders.filter((o) => o.buyer === "דין אורן")).toHaveLength(2);
  const manual = orders.filter((o) => o.noRef);
  expect(manual).toHaveLength(2);
  expect(manual[0].key).toMatch(/^row:/);
  // מזהה ישן שנמצא רק בהערה
  expect(orderKeyOf({ id: 9, order_ref: "", note: "Shopify #1068 בוצע" })).toEqual({ key: "order:#1068", ref: "#1068", noRef: false });
});

test("הזמנה שבוטלה לא מופיעה; שורה שבוטלה בתוך הזמנה מדווחת; חסמים ומיקומים", () => {
  const rows = [
    line({ id: 1, order_ref: "#1", ship_status: "cancelled" }),
    line({ id: 2, order_ref: "#2", ship_status: "recorded" }),
    line({ id: 3, order_ref: "#2", ship_status: "cancelled" }),
    line({ id: 4, order_ref: "#3", buyer_address: "", buyer_phone: "", location: "stores", size: "" }),
  ];
  const orders = groupOrders(rows, { sizedItems: new Set([1]), stockAt: (i, loc) => (loc === "room" ? -1 : 3) });
  expect(orders.map((o) => o.ref).sort()).toEqual(["#2", "#3"]);
  const o2 = orders.find((o) => o.ref === "#2")!;
  expect(o2.cancelledLines).toBe(1);
  expect(o2.saleIds).toEqual([2]);
  expect(o2.blockers.some((b) => b.includes("שלילי"))).toBe(true);
  const o3 = orders.find((o) => o.ref === "#3")!;
  expect(o3.blockers).toContain("צורת מסירה לא צוינה ואין כתובת");
  expect(o3.blockers.some((b) => b.includes("מידה חסרה"))).toBe(true);
  expect(o3.blockers.some((b) => b.includes("אצל חנויות, לא אצלך"))).toBe(true);
  expect(o3.deliveryAssumed).toBe(true);
});

test("דחיפות: מעל היעד ראשון, ואיחור לפי ימי עבודה ולא לפי ימים קלנדריים", () => {
  const now = new Date("2026-09-20T10:00:00Z"); // ראשון
  const rows = [line({ id: 1, order_ref: "#a", sold_at: "2026-09-17" }), line({ id: 2, order_ref: "#b", sold_at: "2026-09-13" })];
  const orders = groupOrders(rows, { now, targetDays: 2 });
  expect(orders[0].ref).toBe("#b");
  expect(orders[0].late).toBe(true);
  const a = orders.find((o) => o.ref === "#a")!;
  expect([a.days, a.workDays, a.late]).toEqual([3, 1, false]);
});

test("מלאי בחנות אחרת לא זמין לאריזה; שמור והובטח הם מידע ולא הפחתה כפולה", async () => {
  await db.prepare("INSERT INTO seed_items (id, name, price) VALUES (901, 'חולצה-בדיקה', 199)").run();
  await db.prepare("INSERT INTO seed_stock (item_id, location, qty_l) VALUES (901, 'room', 3), (901, 'car', 1), (901, 'stores', 5), (901, 'dima', 2)").run();
  await db.prepare("INSERT INTO seed_sales (item_id, item_label, buyer, qty, size, sold_at, ship_status, order_ref) VALUES (901, 'חולצה', 'א', 2, 'L', '2026-09-15', 'recorded', '#1'), (901, 'חולצה', 'ב', 1, 'L', '2026-09-15', 'shipped', '#2')").run();
  await db.prepare("INSERT INTO seed_gifts (item_id, item_label, person, qty, size, status) VALUES (901, 'חולצה', 'משפיען', 1, 'L', 'promised'), (901, 'חולצה', 'חבר', 1, 'L', 'given')").run();
  const l = (await stockByLocation(db)).find((x) => x.itemId === 901)!;
  // 'dima' הוא מיקום שנסגר ב-27.9 (העסק של יוגב): שורה ישנה שם לא נספרת כזמינה לאריזה.
  expect([l.size, l.yogev, l.stores, l.reserved, l.allocated]).toEqual(["L", 4, 5, 2, 1]);
  // המספרים במלאי לא זזו בגלל השאילתה: אין הפחתה כפולה
  const room = await db.prepare("SELECT qty_l FROM seed_stock WHERE item_id = 901 AND location = 'room'").first<{ qty_l: number }>();
  expect(room?.qty_l).toBe(3);
});

test("מעבר מצב: מהשרת בלבד, לחיצה כפולה לא מבצעת פעמיים, והזמנה שבוטלה לא מתקדמת", async () => {
  await db.prepare("INSERT INTO seed_items (id, name, price) VALUES (901, 'חולצה-בדיקה', 199)").run();
  await db.prepare("INSERT INTO seed_sales (id, item_id, item_label, buyer, buyer_address, qty, size, sold_at, ship_status, order_ref) VALUES (10, 901, 'חולצה', 'א', 'תל אביב', 1, 'L', '2026-09-15', 'packed', '#1'), (11, 901, 'כובע', 'א', 'תל אביב', 1, '', '2026-09-15', 'packed', '#1'), (12, 901, 'חולצה', 'ב', 'חיפה', 1, 'M', '2026-09-15', 'cancelled', '#2')").run();
  const p1 = await prepareShip(db, [10, 11], "shipped");
  const p2 = await prepareShip(db, [11, 10], "shipped"); // לחיצה כפולה = אותה פעולה
  expect(p1.ok && p2.ok && p1.id === p2.id).toBe(true);
  const [c1, c2] = await Promise.all([confirmShip(db, p1.id!), confirmShip(db, p1.id!)]);
  expect([c1.state, c2.state].sort()).toEqual(["done", "running"]);
  const after = await db.prepare("SELECT ship_status FROM seed_sales WHERE id IN (10, 11)").all<{ ship_status: string }>();
  expect(after.results?.map((r) => r.ship_status)).toEqual(["shipped", "shipped"]);
  // "רענון" = קריאה מחדש: ההזמנה כבר לא ברשימה
  expect((await openOrdersGrouped(db)).some((o) => o.ref === "#1")).toBe(false);
  // הזמנה שבוטלה: לא מוכנה ולא מתקדמת
  expect((await prepareShip(db, [12], "shipped")).error).toBe("cancelled_line");
  expect((await db.prepare("SELECT ship_status FROM seed_sales WHERE id = 12").first<{ ship_status: string }>())?.ship_status).toBe("cancelled");
  // צורת מסירה: נשמרת, ולא על שורה שבוטלה
  expect(await setDelivery(db, [10, 12], "pickup")).toBe(1);
});

test("חיבור רשומות ידניות להזמנה אחת: רק לפי החלטה, רק אותו קונה, בלי שורות Shopify או מבוטלות", async () => {
  await db.prepare("INSERT INTO seed_sales (id, item_label, buyer, qty, size, sold_at, ship_status, note, order_ref) VALUES (163, 'חולצת כדורגל', 'שחר וילנסקי', 1, 'L', '2026-09-01', 'recorded', '10 אחוז הנחה', ''), (164, 'כובע', 'שחר וילנסקי', 1, '', '2026-09-01', 'recorded', '10 אחוז הנחה', ''), (165, 'חולצה', 'שחר וילנסקי', 1, 'XL', '2026-09-01', 'recorded', '10 אחוז הנחה', ''), (166, 'חולצה', 'מישהו אחר', 1, 'M', '2026-09-01', 'recorded', '', ''), (167, 'חולצה', 'שחר וילנסקי', 1, 'M', '2026-09-01', 'recorded', 'Shopify #1200', '#1200'), (168, 'חולצה', 'שחר וילנסקי', 1, 'M', '2026-09-01', 'cancelled', '', '')").run();
  expect((await openOrdersGrouped(db)).filter((o) => o.buyer === "שחר וילנסקי" && o.noRef)).toHaveLength(3);
  expect((await mergeManualRows(db, [163, 166])).ok).toBe(false); // קונה אחר
  expect((await mergeManualRows(db, [163, 167])).ok).toBe(false); // שורת Shopify
  expect((await mergeManualRows(db, [163, 168])).ok).toBe(false); // מבוטלת
  expect(await mergeManualRows(db, [165, 163, 164])).toEqual({ ok: true, ref: "ידני-163" });
  const merged = (await openOrdersGrouped(db)).filter((o) => o.ref === "ידני-163");
  expect(merged).toHaveLength(1);
  expect(merged[0].saleIds.sort()).toEqual([163, 164, 165]);
  expect(merged[0].noRef).toBe(false);
});
