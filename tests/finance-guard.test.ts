// כספים: המשלמות, הקופות, ההכנסות (ספר המכירות + ידני), ההשקעה מהכיס והמאזן בין
// השותפות, קטגוריות בלי סידינג, ומה שנקרא מ-settings.
import { beforeEach, expect, test } from "vitest";
import { freshDb } from "./d1";
import { addExpense, addIncome, deleteBudget, getDropProfits, getFeeRates, getFinance, getRevenue, getVatExempt, setBudget, setDropCost, setVatExempt, updateExpense } from "../src/lib/finance.server";
import { moneySnapshot, pocketBalance } from "../src/lib/finance.summary.server";

let db: ReturnType<typeof freshDb>;
beforeEach(() => {
  db = freshDb();
});

const setting = (key: string, value: string) => db.raw.exec(`INSERT INTO settings (key, value) VALUES ('${key}', '${value}') ON CONFLICT(key) DO UPDATE SET value = excluded.value`);

test("אין קטגוריות ואין תקציב מסודר מראש; תקציב 0 = לא הוגדר", async () => {
  const f = await getFinance();
  expect(f.budgets).toEqual([]);
  expect(f.totalBudget).toBe(0);
  expect(f.expenses).toEqual([]);
  expect(f.income).toEqual([]);
  expect(f.revenue.gross).toBe(0);
});

test("משלמת: אביה / ליאור מהכיס בלי קופה; העסק עם קופה; משלמת לא מוכרת הופכת לעסק", async () => {
  const a = await addExpense({ date: "2026-09-01", payer: "avia", category: "ייצור", description: "", amount: 300, paidFrom: "bank" });
  expect(a.payer).toBe("avia");
  expect(a.paid_from).toBe(""); // מהכיס: הקופות לא נוגעות
  const b = await addExpense({ date: "2026-09-02", payer: "business", category: "משלוחים", description: "", amount: 120, paidFrom: "bit" });
  expect(b.paid_from).toBe("bit");
  const c = await addExpense({ date: "2026-09-03", payer: "someone", category: "משלוחים", description: "", amount: 50, paidFrom: "cash" });
  expect(c.payer).toBe("business");
  // קטגוריה שנרשמה בה הוצאה נכנסת לרשימה, בלי תקציב
  const f = await getFinance();
  expect(f.budgets.map((x) => x.category).sort()).toEqual(["ייצור", "משלוחים"]);
  expect(f.budgets.every((x) => x.amount === 0)).toBe(true);
  // תיקון: מעבר לכיס מוחק את הקופה
  const fixed = await updateExpense(b.id, { payer: "lior" });
  expect(fixed?.payer).toBe("lior");
  expect(fixed?.paid_from).toBe("");
});

test("הכנסות = ספר המכירות + הכנסות ידניות, עם פיצול לפי אמצעי תשלום, מקור ומי טיפלה", async () => {
  await db.prepare("INSERT INTO seed_sales (item_label, buyer, qty, price, sold_at, ship_status, pay_method, handled_by) VALUES ('א', 'x', 2, 100, '2026-09-10', 'delivered', 'shopify', 'avia')").run();
  await db.prepare("INSERT INTO seed_sales (item_label, buyer, qty, price, sold_at, ship_status, pay_method, handled_by) VALUES ('ב', 'y', 1, 50, '2026-09-11', 'delivered', 'cash', '')").run();
  await db.prepare("INSERT INTO seed_sales (item_label, buyer, qty, price, sold_at, ship_status, pay_method, handled_by) VALUES ('ג', 'z', 1, 999, '2026-09-11', 'cancelled', 'shopify', 'lior')").run();
  await addIncome({ date: "2026-09-12", amount: 1500, source: "wholesale", handledBy: "lior", note: "חנות" });
  await addIncome({ date: "2026-09-13", amount: 200, source: "nope", handledBy: "someone" });
  const r = await getRevenue();
  expect(r.sales).toBe(250);
  expect(r.manual).toBe(1700);
  expect(r.gross).toBe(1950);
  expect(r.orders).toBe(2);
  expect(r.byMethod).toEqual({ shopify: 200, cash: 50 });
  expect(r.bySource).toEqual({ wholesale: 1500, "": 200 });
  expect(r.byHandler.sales).toEqual({ avia: 200, lior: 0, "": 50 });
  expect(r.byHandler.manual).toEqual({ avia: 0, lior: 1500, "": 200 });
  const snap = await moneySnapshot(db as never, { now: new Date("2026-09-20T09:00:00Z") });
  expect(snap.period.revenue.value).toBe(1950);
});

test("מהכיס: סכום לכל שותפה, וההפרש חלקי 2 הוא מה שעובר כדי להשוות", async () => {
  expect(pocketBalance({ avia: 0, lior: 0 }).ahead).toBeNull();
  const p = pocketBalance({ avia: 1000, lior: 400 });
  expect(p.ahead).toBe("avia");
  expect(p.transfer).toBe(300);
  expect(p.text).toContain("ליאור");
  await addExpense({ date: "2026-09-01", payer: "avia", category: "ייצור", description: "", amount: 700 });
  await addExpense({ date: "2026-09-01", payer: "lior", category: "ייצור", description: "", amount: 100 });
  await addExpense({ date: "2026-09-01", payer: "business", category: "ייצור", description: "", amount: 5000, paidFrom: "bank" });
  const f = await getFinance();
  expect(f.pocket).toMatchObject({ avia: 700, lior: 100, ahead: "avia", transfer: 300 });
  const snap = await moneySnapshot(db as never);
  expect(snap.pocket.transfer).toBe(300);
});

test("settings: עמלה מ-fee_rates, מע\"מ מ-vat_exempt, ברירת מחדל = עוסק פטור", async () => {
  expect(await getFeeRates()).toEqual({ shopify: 0.024 });
  setting("fee_rates", '{"shopify":0.03,"other":0.02}');
  expect(await getFeeRates()).toEqual({ shopify: 0.03 }); // ספק שלא קיים לא נכנס
  setting("fee_rates", "not json");
  expect(await getFeeRates()).toEqual({ shopify: 0.024 });
  expect(await getVatExempt()).toBe(true);
  await setVatExempt(false);
  expect(await getVatExempt()).toBe(false);
  expect((await getFinance()).vatExempt).toBe(false);
});

test("רווח לפי קולקציה: כל קולקציה שבמלאי, עלות ייצור מ-settings.drop_costs לפי שם", async () => {
  await db.prepare("INSERT INTO seed_items (id, name, price, collection) VALUES (1, 'טי', 120, 'קיץ'), (2, 'כובע', 80, 'חורף')").run();
  await db.prepare("INSERT INTO seed_sales (item_id, item_label, buyer, qty, price, sold_at, ship_status) VALUES (1, 'טי', 'x', 3, 120, '2026-09-10', 'delivered')").run();
  await db.prepare("INSERT INTO seed_stock (item_id, location, qty_m) VALUES (2, 'avia', 2)").run();
  await setDropCost("קיץ", 200);
  const rows = await getDropProfits();
  expect(rows.map((r) => r.collection)).toEqual(["חורף", "קיץ"]);
  expect(rows.find((r) => r.collection === "קיץ")).toMatchObject({ units: 3, revenue: 360, cost: 200 });
  expect(rows.find((r) => r.collection === "חורף")).toMatchObject({ units: 0, revenue: 0, cost: 0, stockValue: 160 });
  expect(JSON.parse((await db.prepare("SELECT value FROM settings WHERE key = 'drop_costs'").first<{ value: string }>())!.value)).toEqual({ קיץ: 200 });
});

test("קטגוריות: הוספה, תקציב, הסרה; ההוצאות שומרות את שם הקטגוריה", async () => {
  await setBudget("שיווק", 0);
  await setBudget("שיווק", 1200);
  await addExpense({ date: "2026-09-01", payer: "business", category: "שיווק", description: "", amount: 300, paidFrom: "bank" });
  let f = await getFinance();
  expect(f.budgets).toEqual([{ category: "שיווק", amount: 1200, position: 1 }]);
  await deleteBudget("שיווק");
  f = await getFinance();
  expect(f.budgets).toEqual([]);
  expect(f.expenses[0].category).toBe("שיווק");
});
