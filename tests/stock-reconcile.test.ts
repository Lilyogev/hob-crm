import { beforeEach, expect, test } from "vitest";
import { freshDb } from "./d1";
import { setFact, verifyFact } from "../src/lib/finance.summary.server";
import { RECEIVED_KEY, dropUnitCost, itemReconciliation } from "../src/lib/stock.reconcile.server";
import { checkText, pageCheck } from "../src/lib/recipes/html";

let db: ReturnType<typeof freshDb>;
beforeEach(async () => {
  db = freshDb();
  // חולצת כדורגל: 55 נשארו, 12 נמכרו, 8 חולקו, ועוד הבטחה אחת שעוד לא יצאה מהמלאי.
  await db.prepare("INSERT INTO seed_items (id, name, size, price, collection) VALUES (17, 'חולצה · HOME KIT', '', 249, 'drop4')").run();
  await db.prepare("INSERT INTO seed_stock (item_id, location, qty, qty_xs, qty_s, qty_m, qty_l, qty_xl, qty_xxl) VALUES (17, 'room', 0, 0, 6, 10, 18, 16, 2)").run();
  await db.prepare("INSERT INTO seed_stock (item_id, location, qty, qty_xs, qty_s, qty_m, qty_l, qty_xl, qty_xxl) VALUES (17, 'dima', 0, 0, 1, 0, 1, 0, 1)").run();
  for (let i = 0; i < 12; i++) await db.prepare("INSERT INTO seed_sales (item_id, buyer, qty, price, sold_at, ship_status) VALUES (17, 'קונה', 1, 249, '2026-09-01', 'delivered')").run();
  await db.prepare("INSERT INTO seed_sales (item_id, buyer, qty, price, sold_at, ship_status) VALUES (17, 'בוטל', 1, 249, '2026-09-01', 'cancelled')").run();
  for (let i = 0; i < 8; i++) await db.prepare("INSERT INTO seed_gifts (item_id, person, qty, status, given_at) VALUES (17, 'משפיען', 1, 'given', '2026-09-01')").run();
  await db.prepare("INSERT INTO seed_gifts (item_id, person, qty, status, given_at) VALUES (17, 'הובטח', 1, 'promised', '2026-09-01')").run();
});

test("the reconstructed quantity counts gifts, and is not verified without a received quantity", async () => {
  const [r] = (await itemReconciliation(db as never)).filter((x) => x.itemId === 17);
  expect(r.left).toBe(55);
  expect(r.sold).toBe(12); // המבוטלת לא נספרת
  expect(r.given).toBe(8); // ההבטחה לא נספרת
  expect(r.accounted).toBe(75);
  expect(r.verified).toBe(false);
  expect(r.gap).toBeNull();
  expect(r.text).toContain("לא מאומתת");
  const uc = dropUnitCost("drop4", 15273, [r]);
  expect(uc.state).toBe("estimate");
  expect(uc.value).toBe(Math.round(15273 / 75));
  expect(uc.text).toContain("לא מאומת");
});

test("a confirmed received quantity that matches verifies; a mismatch shows an unexplained gap", async () => {
  await setFact(db as never, RECEIVED_KEY(17), { value: 75, source: "חשבונית ספק 12.8" });
  await verifyFact(db as never, RECEIVED_KEY(17), { against: "חשבונית ספק 12.8" });
  let [r] = (await itemReconciliation(db as never)).filter((x) => x.itemId === 17);
  expect(r.verified).toBe(true);
  expect(dropUnitCost("drop4", 15273, [r]).state).toBe("verified");
  await setFact(db as never, RECEIVED_KEY(17), { value: 80, source: "חשבונית ספק 12.8" });
  await verifyFact(db as never, RECEIVED_KEY(17), { against: "חשבונית ספק 12.8" });
  [r] = (await itemReconciliation(db as never)).filter((x) => x.itemId === 17);
  expect(r.gap).toBe(5);
  expect(r.verified).toBe(false);
  expect(r.text).toContain("פער של 5");
  expect(dropUnitCost("drop4", 15273, [r]).state).toBe("estimate");
});

test("migration seeds the received-quantity facts as unknown, never as a number", async () => {
  const rows = (await db.prepare("SELECT key, value, status FROM fin_facts WHERE key LIKE 'received_qty:%'").all<{ key: string; value: number | null; status: string }>()).results;
  expect(rows.map((r) => r.key).sort()).toEqual(["received_qty:17", "received_qty:18"]);
  expect(rows.every((r) => r.value === null && r.status === "pending")).toBe(true);
});

test("page check says exactly what was and was not checked", () => {
  const html = `<!doctype html><html lang="he" dir="rtl"><head><style>${"a{}".repeat(1200)}</style></head><body><h1>SEGULA</h1><a href="https://segula.club/products/x">לקנייה</a><a href="https://evil.example/x">x</a></body></html>`;
  const c = pageCheck(html, { minChars: 3000, rtl: true, allowedHosts: [/^https?:\/\/(www\.)?segula\.club/] });
  expect(c.ok).toBe(false);
  expect(c.problems.join()).toContain("evil.example");
  expect(c.checked.join()).toContain("כפתור פעולה");
  expect(checkText(c)).toContain("לא נבדק: תצוגה בפועל בנייד ובמחשב");
  const noCta = pageCheck(html.replace(/<a[^>]*>[^<]*<\/a>/g, ""), { minChars: 3000, rtl: true });
  expect(noCta.problems.join()).toContain("אין כפתור");
});
