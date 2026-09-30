// הזמנות ומלאי לפי מיקום: קיבוץ לפי מזהה הזמנה, ימי עבודה, חסמים, מלאי אצל אביה / אצל ליאור,
// וכללי המלאי של ספר המכירות (מכירה מורידה במיקום שלה, ביטול מחזיר, העברה בין השותפות).
import { beforeEach, expect, test } from "vitest";
import { freshDb } from "./d1";
import { groupOrders, mergeManualRows, openOrdersGrouped, orderKeyOf, setDelivery, stockBlock, stockByLocation, workDaysSince, type SaleLine } from "../src/lib/orders.server";
import { addGift, addSale, deleteSale, getSeeding, normLocation, receiveStock, shopifyStockLocation, transferStock, updateSale } from "../src/lib/seeding.server";

let db: Awaited<ReturnType<typeof freshDb>>;
beforeEach(async () => {
  db = await freshDb();
});

const line = (o: Partial<SaleLine>): SaleLine => ({ id: 1, item_id: 1, item_label: "חולצה", buyer: "דין אורן", buyer_phone: "050", buyer_address: "רחוב 1, תל אביב", qty: 1, size: "L", price: 199, ship_status: "recorded", location: "avia", note: "", sold_at: "2026-09-14", order_ref: "", delivery: "", channel: "", ...o });

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
    line({ id: 4, order_ref: "#3", buyer_address: "", buyer_phone: "", location: "lior", size: "", handled_by: "lior" }),
  ];
  const orders = groupOrders(rows, { sizedItems: new Set([1]), stockAt: (i, loc) => (loc === "avia" ? -1 : 3) });
  expect(orders.map((o) => o.ref).sort()).toEqual(["#2", "#3"]);
  const o2 = orders.find((o) => o.ref === "#2")!;
  expect(o2.cancelledLines).toBe(1);
  expect(o2.saleIds).toEqual([2]);
  expect(o2.blockers.some((b) => b.includes("שלילי") && b.includes("אצל אביה"))).toBe(true);
  const o3 = orders.find((o) => o.ref === "#3")!;
  expect(o3.blockers).toContain("צורת מסירה לא צוינה ואין כתובת");
  expect(o3.blockers.some((b) => b.includes("מידה חסרה"))).toBe(true);
  // מלאי אצל ליאור הוא מלאי של העסק: לא חסם
  expect(o3.blockers.some((b) => b.includes("לא אצלך"))).toBe(false);
  expect(o3.lines[0].locationHe).toBe("אצל ליאור");
  expect(o3.handledBy).toBe("lior");
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

test("מלאי לפי מיקום: אצל אביה ואצל ליאור בנפרד; שמור והובטח הם מידע ולא הפחתה כפולה", async () => {
  await db.prepare("INSERT INTO seed_items (id, name, price) VALUES (901, 'חולצה-בדיקה', 199)").run();
  await db.prepare("INSERT INTO seed_stock (item_id, location, qty_l) VALUES (901, 'avia', 3), (901, 'lior', 1)").run();
  await db.prepare("INSERT INTO seed_sales (item_id, item_label, buyer, qty, size, sold_at, ship_status, order_ref) VALUES (901, 'חולצה', 'א', 2, 'L', '2026-09-15', 'recorded', '#1'), (901, 'חולצה', 'ב', 1, 'L', '2026-09-15', 'shipped', '#2')").run();
  await db.prepare("INSERT INTO seed_gifts (item_id, item_label, person, qty, size, status) VALUES (901, 'חולצה', 'משפיענית', 1, 'L', 'promised'), (901, 'חולצה', 'חברה', 1, 'L', 'given')").run();
  const lines = await stockByLocation(db);
  const l = lines.find((x) => x.itemId === 901)!;
  expect([l.size, l.avia, l.lior, l.total, l.reserved, l.allocated]).toEqual(["L", 3, 1, 4, 2, 1]);
  // המספרים במלאי לא זזו בגלל השאילתה: אין הפחתה כפולה
  const avia = await db.prepare("SELECT qty_l FROM seed_stock WHERE item_id = 901 AND location = 'avia'").first<{ qty_l: number }>();
  expect(avia?.qty_l).toBe(3);
  const text = stockBlock(lines);
  expect(text).toContain("אצל אביה 3");
  expect(text).toContain("אצל ליאור 1");
  expect(text).not.toContain("חנויות");
});

test("צורת מסירה: נשמרת לכל שורות ההזמנה, ולא על שורה שבוטלה; הזמנה שנשלחה יוצאת מהרשימה", async () => {
  await db.prepare("INSERT INTO seed_items (id, name, price) VALUES (901, 'חולצה-בדיקה', 199)").run();
  await db.prepare("INSERT INTO seed_sales (id, item_id, item_label, buyer, buyer_address, qty, size, sold_at, ship_status, order_ref) VALUES (10, 901, 'חולצה', 'א', 'תל אביב', 1, 'L', '2026-09-15', 'packed', '#1'), (11, 901, 'כובע', 'א', 'תל אביב', 1, '', '2026-09-15', 'packed', '#1'), (12, 901, 'חולצה', 'ב', 'חיפה', 1, 'M', '2026-09-15', 'cancelled', '#2')").run();
  expect(await setDelivery(db, [10, 12], "pickup")).toBe(1);
  expect((await openOrdersGrouped(db)).find((o) => o.ref === "#1")?.delivery).toBe("pickup");
  await updateSale(10, { ship_status: "shipped" });
  await updateSale(11, { ship_status: "shipped" });
  expect((await openOrdersGrouped(db)).some((o) => o.ref === "#1")).toBe(false);
});

test("חיבור רשומות ידניות להזמנה אחת: רק לפי החלטה, רק אותו קונה, בלי שורות Shopify או מבוטלות", async () => {
  await db.prepare("INSERT INTO seed_sales (id, item_label, buyer, qty, size, sold_at, ship_status, note, order_ref) VALUES (163, 'חולצה', 'שחר', 1, 'L', '2026-09-01', 'recorded', '10 אחוז הנחה', ''), (164, 'כובע', 'שחר', 1, '', '2026-09-01', 'recorded', '10 אחוז הנחה', ''), (165, 'חולצה', 'שחר', 1, 'XL', '2026-09-01', 'recorded', '10 אחוז הנחה', ''), (166, 'חולצה', 'מישהו אחר', 1, 'M', '2026-09-01', 'recorded', '', ''), (167, 'חולצה', 'שחר', 1, 'M', '2026-09-01', 'recorded', 'Shopify #1200', '#1200'), (168, 'חולצה', 'שחר', 1, 'M', '2026-09-01', 'cancelled', '', '')").run();
  expect((await openOrdersGrouped(db)).filter((o) => o.buyer === "שחר" && o.noRef)).toHaveLength(3);
  expect((await mergeManualRows(db, [163, 166])).ok).toBe(false); // קונה אחר
  expect((await mergeManualRows(db, [163, 167])).ok).toBe(false); // שורת Shopify
  expect((await mergeManualRows(db, [163, 168])).ok).toBe(false); // מבוטלת
  expect(await mergeManualRows(db, [165, 163, 164])).toEqual({ ok: true, ref: "ידני-163" });
  const merged = (await openOrdersGrouped(db)).filter((o) => o.ref === "ידני-163");
  expect(merged).toHaveLength(1);
  expect(merged[0].saleIds.sort()).toEqual([163, 164, 165]);
  expect(merged[0].noRef).toBe(false);
});

test("ספר המכירות: מכירה מורידה מלאי במיקום שלה, מי טיפלה נרשם, ביטול ומחיקה מחזירים", async () => {
  await db.prepare("INSERT INTO seed_items (id, name, price, collection) VALUES (7, 'חולצה לבנה', 199, 'main')").run();
  await receiveStock(7, "avia", "M", 5);
  await receiveStock(7, "lior", "M", 2);
  const r = await addSale({ itemId: 7, buyer: "נועה", qty: 1, size: "M", location: "lior", price: 199, payMethod: "bit", note: "", soldAt: "2026-09-20", handledBy: "lior" });
  expect(r).toEqual({ label: "חולצה לבנה", stockLeft: 1 });
  let { items, sales } = await getSeeding();
  expect(items[0].stock.find((s) => s.location === "lior")?.qty_m).toBe(1);
  expect(items[0].stock.find((s) => s.location === "avia")?.qty_m).toBe(5);
  expect(sales[0]).toMatchObject({ handled_by: "lior", location: "lior", pay_method: "bit" });
  // מיקום לא מוכר ומטפלת לא מוכרת: ברירת מחדל אביה / לא צוין
  expect(normLocation("garage")).toBe("avia");
  await addSale({ itemId: 7, buyer: "דנה", qty: 1, size: "M", location: "shop", price: 199, payMethod: "card", note: "", soldAt: "2026-09-20", handledBy: "nobody" });
  ({ items, sales } = await getSeeding());
  const dana = sales.find((s) => s.buyer === "דנה")!;
  expect([dana.location, dana.handled_by, dana.pay_method]).toEqual(["avia", "", ""]);
  expect(items[0].stock.find((s) => s.location === "avia")?.qty_m).toBe(4);
  // ביטול מחזיר, ביטול הביטול מוריד שוב
  await updateSale(dana.id, { ship_status: "cancelled" });
  expect((await getSeeding()).items[0].stock.find((s) => s.location === "avia")?.qty_m).toBe(5);
  await updateSale(dana.id, { ship_status: "recorded" });
  expect((await getSeeding()).items[0].stock.find((s) => s.location === "avia")?.qty_m).toBe(4);
  await deleteSale(dana.id);
  expect((await getSeeding()).items[0].stock.find((s) => s.location === "avia")?.qty_m).toBe(5);
  // העברה בין השותפות: הסכום לא משתנה, ולתור של Shopify לא נכנס כלום
  const queued = (await db.prepare("SELECT COUNT(*) AS n FROM shopify_push_queue").first<{ n: number }>())!.n;
  await transferStock(7, "avia", "lior", "M", 3);
  const after = (await getSeeding()).items[0].stock;
  expect([after.find((s) => s.location === "avia")?.qty_m, after.find((s) => s.location === "lior")?.qty_m]).toEqual([2, 4]);
  expect((await db.prepare("SELECT COUNT(*) AS n FROM shopify_push_queue").first<{ n: number }>())!.n).toBe(queued);
  // מתנה: אותם כללים, מיקום חובה מתוך השתיים
  const g = await addGift({ itemId: 7, person: "משפיענית", handle: "", kind: "influencer", qty: 1, size: "M", location: "lior", status: "given", note: "", givenAt: "2026-09-21" });
  expect(g?.stockLeft).toBe(3);
  expect((await getSeeding()).items[0].given).toBe(1);
});

test("מיקום המלאי של הזמנות Shopify: מההגדרות, ברירת מחדל אביה", async () => {
  expect(await shopifyStockLocation(db as never)).toBe("avia");
  await db.prepare("UPDATE settings SET value = 'lior' WHERE key = 'shopify_stock_location'").run();
  expect(await shopifyStockLocation(db as never)).toBe("lior");
  await db.prepare("UPDATE settings SET value = 'garage' WHERE key = 'shopify_stock_location'").run();
  expect(await shopifyStockLocation(db as never)).toBe("avia");
});
