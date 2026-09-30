// חשבון כמויות לפריט: נשארו (בשני המיקומים) + נמכרו + חולקו מול כמות הקבלה מהספק
// (על הפריט עצמו, seed_items.received_*). בלי קבלה מאושרת הכמות משוחזרת ולא מאומתת.
import { beforeEach, expect, test } from "vitest";
import { freshDb } from "./d1";
import { collectionUnitCost, itemReconciliation, setReceivedQty, verifyReceivedQty } from "../src/lib/stock.reconcile.server";

let db: ReturnType<typeof freshDb>;
beforeEach(async () => {
  db = freshDb();
  // חולצה: 55 נשארו (אצל אביה ואצל ליאור), 12 נמכרו, 8 חולקו, ועוד הבטחה אחת שעוד לא יצאה מהמלאי.
  await db.prepare("INSERT INTO seed_items (id, name, size, price, collection) VALUES (17, 'חולצה לבנה', '', 249, 'jerseys')").run();
  await db.prepare("INSERT INTO seed_stock (item_id, location, qty, qty_xs, qty_s, qty_m, qty_l, qty_xl, qty_xxl) VALUES (17, 'avia', 0, 0, 6, 10, 18, 16, 2)").run();
  await db.prepare("INSERT INTO seed_stock (item_id, location, qty, qty_xs, qty_s, qty_m, qty_l, qty_xl, qty_xxl) VALUES (17, 'lior', 0, 0, 1, 0, 1, 0, 1)").run();
  for (let i = 0; i < 12; i++) await db.prepare("INSERT INTO seed_sales (item_id, buyer, qty, price, sold_at, ship_status) VALUES (17, 'קונה', 1, 249, '2026-09-01', 'delivered')").run();
  await db.prepare("INSERT INTO seed_sales (item_id, buyer, qty, price, sold_at, ship_status) VALUES (17, 'בוטל', 1, 249, '2026-09-01', 'cancelled')").run();
  for (let i = 0; i < 8; i++) await db.prepare("INSERT INTO seed_gifts (item_id, person, qty, status, given_at) VALUES (17, 'משפיענית', 1, 'given', '2026-09-01')").run();
  await db.prepare("INSERT INTO seed_gifts (item_id, person, qty, status, given_at) VALUES (17, 'הובטח', 1, 'promised', '2026-09-01')").run();
});

test("the reconstructed quantity counts both locations and gifts, and is not verified without a received quantity", async () => {
  const [r] = (await itemReconciliation(db as never)).filter((x) => x.itemId === 17);
  expect(r.left).toBe(55);
  expect(r.sold).toBe(12); // המבוטלת לא נספרת
  expect(r.given).toBe(8); // ההבטחה לא נספרת
  expect(r.accounted).toBe(75);
  expect(r.collection).toBe("jerseys");
  expect(r.verified).toBe(false);
  expect(r.gap).toBeNull();
  expect(r.received).toBeNull();
  expect(r.text).toContain("לא מאומתת");
  const uc = collectionUnitCost("jerseys", 15273, [r]);
  expect(uc.state).toBe("estimate");
  expect(uc.value).toBe(Math.round(15273 / 75));
  expect(uc.text).toContain("לא מאומת");
  // קולקציה בלי פריטים: לא ידוע, בלי מספר מומצא
  expect(collectionUnitCost("other", 15273, [r]).state).toBe("unknown");
});

test("a confirmed received quantity that matches verifies; a mismatch shows an unexplained gap; an edit drops the verification", async () => {
  // רישום אינו אימות
  expect(await setReceivedQty(db as never, 17, { value: 75, source: "חשבונית ספק 12.8", asOf: "2026-08-12" })).toEqual({ ok: true });
  let [r] = (await itemReconciliation(db as never)).filter((x) => x.itemId === 17);
  expect(r.received).toMatchObject({ value: 75, status: "pending", asOf: "2026-08-12" });
  expect(r.gap).toBe(0);
  expect(r.verified).toBe(false);
  // אימות חייב "מול מה"
  expect((await verifyReceivedQty(db as never, 17, "")).ok).toBe(false);
  expect(await verifyReceivedQty(db as never, 17, "חשבונית ספק 12.8")).toEqual({ ok: true });
  [r] = (await itemReconciliation(db as never)).filter((x) => x.itemId === 17);
  expect(r.verified).toBe(true);
  expect(collectionUnitCost("jerseys", 15273, [r]).state).toBe("verified");
  // שינוי הכמות אחרי אימות: חוזר ל"ממתין", ופער לא מוסבר
  await setReceivedQty(db as never, 17, { value: 80, source: "חשבונית ספק 12.8" });
  await verifyReceivedQty(db as never, 17, "חשבונית ספק 12.8");
  [r] = (await itemReconciliation(db as never)).filter((x) => x.itemId === 17);
  expect(r.gap).toBe(5);
  expect(r.verified).toBe(false);
  expect(r.text).toContain("פער של 5");
  expect(collectionUnitCost("jerseys", 15273, [r]).state).toBe("estimate");
  // קלט לא תקין
  expect((await setReceivedQty(db as never, 17, { value: -1 })).ok).toBe(false);
  expect((await setReceivedQty(db as never, 17, { value: 1, asOf: "12/08/2026" })).ok).toBe(false);
  expect((await setReceivedQty(db as never, 999, { value: 1 })).ok).toBe(false);
  expect((await verifyReceivedQty(db as never, 18, "x")).ok).toBe(false);
});

test("an item without a collection falls into 'main'", async () => {
  await db.prepare("INSERT INTO seed_items (id, name, collection) VALUES (18, 'כובע', '')").run();
  const r = (await itemReconciliation(db as never)).find((x) => x.itemId === 18)!;
  expect(r.collection).toBe("main");
  expect(r.accounted).toBe(0);
  // בלי כמות רשומה אין מה לאמת
  expect((await verifyReceivedQty(db as never, 18, "חשבונית")).ok).toBe(false);
});
