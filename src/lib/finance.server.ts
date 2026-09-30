// Server helpers for the כספים tab: expense journal, manual income, budgets
// per category, clearer settlements, receipt photos and saved drop scenarios.
import type { R2Bucket } from "@cloudflare/workers-types";
import { bindings } from "./bindings.server";
import { db } from "./hob.server";
import { type MoneySnapshot, type PocketBalance, moneySnapshot, pocketBalance } from "./finance.summary.server";
import { SALES_SOURCE, salesByDaySeries, salesWindow, shiftDay } from "./orders.server";
import { PAYERS, type Payer, isPartner } from "./partners";
import { ilTodayISO } from "./summary.server";

export type Expense = {
  id: number;
  date: string;
  /** avia | lior (her own pocket) | business */
  payer: string;
  category: string;
  description: string;
  amount: number;
  /** Which business pot paid: bank | bit | cash. "" = untagged, or from a partner's pocket. */
  paid_from: string;
  /** Read off a photographed receipt; 0 / "" on anything typed by hand. */
  vat: number;
  tax_id: string;
};

export const IS_PAYER = (v: unknown): v is Payer => typeof v === "string" && (PAYERS as readonly string[]).includes(v);

/** The pots business money actually sits in. Only transfers land in the bank
 *  on their own; store money waits at the clearer until a settlement row
 *  says it arrived (see `fin_settlements`). */
export const POTS = new Set(["", "bank", "bit", "cash"]);

/** Pay methods whose money sits at a clearer before it reaches the bank. */
export const SETTLED_PROVIDERS = ["shopify"] as const;
export type Provider = (typeof SETTLED_PROVIDERS)[number];
export const IS_PROVIDER = (v: string): v is Provider => (SETTLED_PROVIDERS as readonly string[]).includes(v);
const DEFAULT_FEE_RATES: Record<Provider, number> = { shopify: 0.024 };

/** One deposit that actually hit the bank. `gross` is how much of the
 *  provider's open sales it closes; `gross - net` is the clearer's fee. */
export type Settlement = {
  id: number;
  date: string;
  provider: string;
  net: number;
  gross: number;
  note: string;
};

/** amount 0 = no budget set (the screen says "הגדירו תקציב"). */
export type Budget = { category: string; amount: number; position: number };

// ---- Manual income ----
export const INCOME_SOURCES = ["", "shopify", "popup", "wholesale", "other"] as const;
export type IncomeSource = (typeof INCOME_SOURCES)[number];
export const IS_INCOME_SOURCE = (v: unknown): v is IncomeSource => typeof v === "string" && (INCOME_SOURCES as readonly string[]).includes(v);
export type Income = {
  id: number;
  date: string;
  amount: number;
  source: string;
  /** '' | avia | lior */
  handled_by: string;
  note: string;
};

/** Money in. `sales` is the sales ledger (seed_sales), `manual` is fin_income;
 *  `gross` is both. byMethod is keyed by seed_sales.pay_method ("" = not
 *  tagged), bySource by fin_income.source, byHandler by who handled it. */
export type Revenue = {
  gross: number;
  orders: number;
  sales: number;
  manual: number;
  byMethod: Record<string, number>;
  bySource: Record<string, number>;
  byHandler: { sales: Record<string, number>; manual: Record<string, number> };
};

/** A saved drop scenario: `data` is the simulator's DropSim JSON, opaque here. */
export type Scenario = { name: string; data: string; position: number };

/** One day of sales, feeding the pace strip. */
export type DailySale = { date: string; units: number; revenue: number };

/** דופק המכירות, מחושב בשרת: 7 ימים ישראליים כולל היום מול 7 שלפניהם, ו-8 שבועות אחורה.
 *  אותה הגדרה (salesWindow) כמו ב"היום שלך", כך שמספר אחד מופיע בכל מקום. */
export type SalesPulse = {
  last7: { orders: number; units: number; revenue: number; from: string; to: string };
  prev7: { orders: number; units: number; revenue: number; from: string; to: string };
  /** שבוע 0 = 7 הימים שמסתיימים היום; מהישן לחדש. */
  weeks: { weeksAgo: number; orders: number; units: number; revenue: number; from: string; to: string }[];
  from: string;
  to: string;
  source: string;
  asOf: string;
};

const NOT_CANCELLED = "channel <> 'archive' AND ship_status <> 'cancelled'";

export async function getSalesPulse(now = new Date()): Promise<SalesPulse> {
  const today = ilTodayISO(now);
  const pick = (w: { orders: number; units: number; revenue: number; from: string; to: string }) => ({ orders: w.orders, units: w.units, revenue: Math.round(w.revenue), from: w.from, to: w.to });
  const [last7, prev7, byDay] = await Promise.all([
    salesWindow(db(), { days: 7, now }),
    salesWindow(db(), { days: 7, endDay: shiftDay(today, -7), now }),
    salesByDaySeries(db(), { days: 56, now }),
  ]);
  const weeks = Array.from({ length: 8 }, (_, idx) => {
    const weeksAgo = 7 - idx;
    const to = shiftDay(today, -weeksAgo * 7);
    const from = shiftDay(to, -6);
    const days = byDay.series.filter((d) => d.day >= from && d.day <= to);
    return { weeksAgo, from, to, orders: days.reduce((a, d) => a + d.orders, 0), units: days.reduce((a, d) => a + d.units, 0), revenue: Math.round(days.reduce((a, d) => a + d.revenue, 0)) };
  });
  return { last7: pick(last7), prev7: pick(prev7), weeks, from: byDay.from, to: byDay.to, source: SALES_SOURCE, asOf: now.toISOString() };
}

export async function getDailySales(): Promise<DailySale[]> {
  // An empty sold_at falls back to the created date, like everywhere else.
  const res = await db()
    .prepare(
      `SELECT COALESCE(NULLIF(sold_at, ''), date(created_at)) AS date,
              COALESCE(SUM(qty), 0) AS units,
              COALESCE(SUM(qty * price), 0) AS revenue
       FROM seed_sales WHERE ${NOT_CANCELLED} GROUP BY 1 ORDER BY 1`,
    )
    .all<DailySale>();
  return res.results ?? [];
}

// ---- Settings read by this tab ----

async function setting(key: string): Promise<string | null> {
  const row = await db().prepare("SELECT value FROM settings WHERE key = ?").bind(key).first<{ value: string }>();
  return row ? row.value : null;
}

async function putSetting(key: string, value: string): Promise<void> {
  await db()
    .prepare("INSERT INTO settings (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = ?2")
    .bind(key, value)
    .run();
}

/** settings.vat_exempt: '1' = עוסק פטור (no VAT), '0' = עוסק מורשה (18%). Missing → exempt. */
export async function getVatExempt(): Promise<boolean> {
  return (await setting("vat_exempt")) !== "0";
}

export async function setVatExempt(exempt: boolean): Promise<void> {
  await putSetting("vat_exempt", exempt ? "1" : "0");
}

/** Estimated fee rate per provider (settings.fee_rates JSON), only ever used
 *  to project the net on money still in transit. A real settlement supersedes it. */
export async function getFeeRates(): Promise<Record<string, number>> {
  const out: Record<string, number> = { ...DEFAULT_FEE_RATES };
  try {
    const raw = JSON.parse((await setting("fee_rates")) ?? "{}") as Record<string, unknown>;
    for (const p of SETTLED_PROVIDERS) {
      if (typeof raw[p] === "number" && raw[p] >= 0 && raw[p] < 0.5) out[p] = raw[p] as number;
    }
  } catch {
    // a corrupt value just falls back to the defaults above
  }
  return out;
}

export async function setFeeRate(provider: Provider, rate: number): Promise<void> {
  const rates = await getFeeRates();
  rates[provider] = rate;
  await putSetting("fee_rates", JSON.stringify(rates));
}

/** Opening balances per pot (settings bank_opening / bit_opening / cash_opening):
 *  what was there before the ledger started describing it. null = not typed. */
export const OPENING_POTS = ["bank", "bit", "cash"] as const;
export type OpeningPot = (typeof OPENING_POTS)[number];
export const IS_OPENING_POT = (v: unknown): v is OpeningPot => typeof v === "string" && (OPENING_POTS as readonly string[]).includes(v);

export async function getPotOpenings(): Promise<Record<OpeningPot, number | null>> {
  const rows = await db()
    .prepare("SELECT key, value FROM settings WHERE key IN ('bank_opening', 'bit_opening', 'cash_opening')")
    .all<{ key: string; value: string }>();
  const out: Record<OpeningPot, number | null> = { bank: null, bit: null, cash: null };
  for (const r of rows.results ?? []) {
    const pot = r.key.replace("_opening", "") as OpeningPot;
    const v = parseFloat(r.value);
    out[pot] = Number.isFinite(v) ? v : 0;
  }
  return out;
}

export async function setPotOpening(pot: OpeningPot, amount: number): Promise<void> {
  await putSetting(`${pot}_opening`, String(amount));
}

/** The overall budget the partners set (settings fin_total_budget). 0 = not set. */
export async function getTotalBudget(): Promise<number> {
  const v = parseFloat((await setting("fin_total_budget")) ?? "0");
  return Number.isFinite(v) && v > 0 ? v : 0;
}

export async function setTotalBudget(amount: number): Promise<void> {
  await putSetting("fin_total_budget", String(Math.max(0, amount)));
}

// ---- Clearer settlements: store money on its way to the bank ----

export async function getSettlements(): Promise<Settlement[]> {
  const res = await db()
    .prepare("SELECT id, date, provider, net, gross, note FROM fin_settlements ORDER BY date DESC, id DESC")
    .all<Settlement>();
  return res.results ?? [];
}

/** Gross sales per provider that no settlement has closed yet. */
export async function pendingGross(): Promise<Record<string, number>> {
  const sales = await db()
    .prepare(
      `SELECT pay_method AS provider, COALESCE(SUM(qty * price), 0) AS total
       FROM seed_sales WHERE ${NOT_CANCELLED} AND pay_method IN ('shopify')
       GROUP BY pay_method`,
    )
    .all<{ provider: string; total: number }>();
  const settled = await db()
    .prepare("SELECT provider, COALESCE(SUM(gross), 0) AS total FROM fin_settlements GROUP BY provider")
    .all<{ provider: string; total: number }>();
  const out: Record<string, number> = {};
  for (const p of SETTLED_PROVIDERS) out[p] = 0;
  for (const r of sales.results ?? []) out[r.provider] = r.total;
  for (const r of settled.results ?? []) out[r.provider] = (out[r.provider] ?? 0) - r.total;
  return out;
}

/** חשד לכפילות לפני רישום זיכוי. לא חוסם לבד: מחזיר סיבות, והמסך או הובי מבקשים אישור.
 *  (1) זיכוי קיים באותו ספק, באותו נטו (עד 1 ₪ הפרש), בטווח של 3 ימים.
 *  (2) אין אצל הספק מכירות פתוחות לסגור, ולא צוין ברוטו: או כפילות, או שמכירה לא נרשמה. */
export async function settlementSuspicion(s: { date: string; provider: Provider; net: number; gross?: number }): Promise<string[]> {
  const reasons: string[] = [];
  const near = await db()
    .prepare("SELECT id, date, net FROM fin_settlements WHERE provider = ? AND ABS(net - ?) < 1 AND ABS(julianday(date) - julianday(?)) <= 3 ORDER BY date DESC LIMIT 3")
    .bind(s.provider, s.net, s.date)
    .all<{ id: number; date: string; net: number }>();
  for (const r of near.results ?? []) reasons.push(`כבר נרשם זיכוי זהה: #${r.id} מ-${r.date}, ${Math.round(r.net).toLocaleString("en-US")} ₪`);
  const hasGross = typeof s.gross === "number" && s.gross > 0;
  if (!hasGross && Math.max(0, (await pendingGross())[s.provider] ?? 0) <= 0) {
    reasons.push("אין אצל הסולק הזה מכירות פתוחות לסגור. אולי הזיכוי כבר נרשם, או שמכירה לא נרשמה בלוח");
  }
  return reasons;
}

/** כמה ברוטו זיכוי סוגר כשלא נאמר במפורש. זיכוי שמכסה את כל הפתוח (אחרי עמלה, עם מרווח
 *  של 5%) סוגר הכל. זיכוי קטן בבירור הוא הפקדה חלקית: הוא סוגר רק את הברוטו המשוער שלו
 *  (נטו / (1 − עמלה)), ולא מאפס את כל מה שממתין אצל הסולק. */
export function resolveGross(pending: number, net: number, feeRate: number): { gross: number; partial: boolean } {
  const open = Math.max(0, pending);
  if (open <= 0 || net <= 0) return { gross: open, partial: false };
  const rate = feeRate >= 0 && feeRate < 0.5 ? feeRate : 0;
  const expectedNet = open * (1 - rate);
  if (net >= expectedNet * 0.95) return { gross: open, partial: false };
  return { gross: Math.min(open, Math.round((net / (1 - rate)) * 100) / 100), partial: true };
}

/** Records a deposit. `gross` left at 0 means "close what this deposit covers"
 *  (see resolveGross). It is resolved to a number here and stored, so a sale
 *  logged late never rewrites an old settlement. */
export async function addSettlement(s: {
  date: string;
  provider: Provider;
  net: number;
  gross?: number;
  note?: string;
  actor?: string;
  reason?: string;
}): Promise<Settlement> {
  let gross = typeof s.gross === "number" && s.gross > 0 ? s.gross : 0;
  let note = s.note ?? "";
  if (!gross) {
    const r = resolveGross((await pendingGross())[s.provider] ?? 0, s.net, (await getFeeRates())[s.provider] ?? 0);
    gross = r.gross;
    if (r.partial) note = `${note ? `${note} · ` : ""}הפקדה חלקית: ברוטו משוער לפי העמלה, לא כל הממתין`.slice(0, 300);
  }
  const res = await db()
    .prepare(
      `INSERT INTO fin_settlements (date, provider, net, gross, note) VALUES (?, ?, ?, ?, ?)
       RETURNING id, date, provider, net, gross, note`,
    )
    .bind(s.date, s.provider, s.net, gross, note)
    .first<Settlement>();
  if (!res) throw new Error("settlement insert failed");
  await logSettlement(res.id, "add", res, s.actor ?? "", s.reason ?? "");
  return res;
}

// יומן: כל רישום ומחיקה של זיכוי נשמרים.
async function logSettlement(id: number, action: "add" | "delete", data: unknown, actor: string, reason: string): Promise<void> {
  await db()
    .prepare("INSERT INTO fin_settlement_log (settlement_id, action, data, actor, reason) VALUES (?, ?, ?, ?, ?)")
    .bind(id, action, JSON.stringify(data), actor.slice(0, 40), reason.slice(0, 400))
    .run()
    .catch(() => undefined);
}

export async function deleteSettlement(id: number, actor = ""): Promise<void> {
  const before = await db().prepare("SELECT id, date, provider, net, gross, note FROM fin_settlements WHERE id = ?").bind(id).first<Settlement>();
  await db().prepare("DELETE FROM fin_settlements WHERE id = ?").bind(id).run();
  if (before) await logSettlement(id, "delete", before, actor, "");
}

// ---- Saved scenarios ----

export async function getScenarios(): Promise<Scenario[]> {
  const res = await db().prepare("SELECT name, data, position FROM fin_scenarios ORDER BY position, name").all<Scenario>();
  return res.results ?? [];
}

export async function saveScenario(name: string, data: string): Promise<void> {
  // New scenarios land at the end; re-saving an existing name keeps its slot.
  await db()
    .prepare(
      `INSERT INTO fin_scenarios (name, data, position)
       VALUES (?, ?, (SELECT COALESCE(MAX(position), 0) + 1 FROM fin_scenarios))
       ON CONFLICT(name) DO UPDATE SET data = excluded.data, updated_at = datetime('now')`,
    )
    .bind(name, data)
    .run();
}

export async function deleteScenario(name: string): Promise<void> {
  await db().prepare("DELETE FROM fin_scenarios WHERE name = ?").bind(name).run();
}

// ---- Profit per collection ----
// Revenue is real (the sales ledger joined to items for the collection); the
// production cost is the partners' own figure per collection, kept in
// settings.drop_costs as JSON {collection: cost}. Sales whose item was
// deleted land in '' ("לא משויך"), shown only when money is actually there.
export type DropProfit = {
  collection: string;
  units: number;
  revenue: number;
  /** Production cost typed by the partners; 0 = not typed yet. */
  cost: number;
  /** Remaining stock × list price: what is still on the shelf. */
  stockValue: number;
};

async function readDropCosts(): Promise<Record<string, number>> {
  try {
    const raw = JSON.parse((await setting("drop_costs")) ?? "{}") as Record<string, unknown>;
    const out: Record<string, number> = {};
    for (const [k, v] of Object.entries(raw)) {
      if (typeof v === "number" && isFinite(v)) out[k] = v;
      // an older {prod, total} object keeps its production figure
      else if (v && typeof v === "object" && typeof (v as { prod?: unknown }).prod === "number") out[k] = (v as { prod: number }).prod;
    }
    return out;
  } catch {
    return {};
  }
}

export async function getDropProfits(): Promise<DropProfit[]> {
  const sold = await db()
    .prepare(
      `SELECT COALESCE(i.collection, '') AS collection,
              COALESCE(SUM(s.qty), 0) AS units,
              COALESCE(SUM(s.qty * s.price), 0) AS revenue
       FROM seed_sales s LEFT JOIN seed_items i ON i.id = s.item_id
       WHERE s.channel <> 'archive' AND s.ship_status <> 'cancelled'
       GROUP BY COALESCE(i.collection, '')`,
    )
    .all<{ collection: string; units: number; revenue: number }>();
  const costs = await readDropCosts();
  const map = new Map<string, DropProfit>();
  const at = (c: string): DropProfit => {
    const cur = map.get(c);
    if (cur) return cur;
    const fresh = { collection: c, units: 0, revenue: 0, cost: costs[c] ?? 0, stockValue: 0 };
    map.set(c, fresh);
    return fresh;
  };
  // Every collection in the catalog shows, even before its first sale.
  try {
    const cats = await db().prepare("SELECT DISTINCT collection FROM seed_items ORDER BY collection").all<{ collection: string }>();
    for (const r of cats.results ?? []) void at(r.collection ?? "");
  } catch (error) {
    console.error("collections unavailable", error);
  }
  for (const r of sold.results ?? []) Object.assign(at(r.collection), { units: r.units, revenue: r.revenue });
  // Shelf value is a bonus: a stock table of another shape must not sink the panel.
  try {
    const shelf = await db()
      .prepare(
        `SELECT i.collection AS collection,
                COALESCE(SUM((st.qty + st.qty_xs + st.qty_s + st.qty_m + st.qty_l + st.qty_xl + st.qty_xxl) * i.price), 0) AS stockValue
         FROM seed_items i JOIN seed_stock st ON st.item_id = i.id
         GROUP BY i.collection`,
      )
      .all<{ collection: string; stockValue: number }>();
    for (const r of shelf.results ?? []) at(r.collection ?? "").stockValue = Math.max(0, r.stockValue);
  } catch (error) {
    console.error("stock value unavailable", error);
  }
  for (const c of Object.keys(costs)) void at(c);
  return [...map.values()].sort((a, b) => a.collection.localeCompare(b.collection, "he"));
}

export async function setDropCost(collection: string, amount: number): Promise<void> {
  const costs = await readDropCosts();
  costs[collection] = amount;
  await putSetting("drop_costs", JSON.stringify(costs));
}

// ---- Revenue: sales ledger + manual income ----

const HANDLERS = ["avia", "lior", ""] as const;
const handlerMap = (): Record<string, number> => ({ avia: 0, lior: 0, "": 0 });
const normHandler = (v: unknown): string => (isPartner(v) ? v : "");

export async function getRevenue(): Promise<Revenue> {
  const revRow = await db()
    .prepare(`SELECT COALESCE(SUM(qty * price), 0) AS gross, COUNT(*) AS orders FROM seed_sales WHERE ${NOT_CANCELLED}`)
    .first<{ gross: number; orders: number }>();
  const methodRes = await db()
    .prepare(`SELECT pay_method, COALESCE(SUM(qty * price), 0) AS total FROM seed_sales WHERE ${NOT_CANCELLED} GROUP BY pay_method`)
    .all<{ pay_method: string; total: number }>();
  const byMethod: Record<string, number> = {};
  for (const row of methodRes.results ?? []) byMethod[row.pay_method ?? ""] = row.total;
  // Who handled each sale. The column is the stock module's; if it is not
  // there yet everything counts as "not tagged" rather than failing the tab.
  const salesBy = handlerMap();
  try {
    const rows = await db()
      .prepare(`SELECT COALESCE(handled_by, '') AS h, COALESCE(SUM(qty * price), 0) AS total FROM seed_sales WHERE ${NOT_CANCELLED} GROUP BY COALESCE(handled_by, '')`)
      .all<{ h: string; total: number }>();
    for (const r of rows.results ?? []) salesBy[normHandler(r.h)] += r.total;
  } catch {
    salesBy[""] = revRow?.gross ?? 0;
  }
  const manualRes = await db()
    .prepare("SELECT source, handled_by, COALESCE(SUM(amount), 0) AS total FROM fin_income GROUP BY source, handled_by")
    .all<{ source: string; handled_by: string; total: number }>();
  const bySource: Record<string, number> = {};
  const manualBy = handlerMap();
  let manual = 0;
  for (const r of manualRes.results ?? []) {
    bySource[r.source ?? ""] = (bySource[r.source ?? ""] ?? 0) + r.total;
    manualBy[normHandler(r.handled_by)] += r.total;
    manual += r.total;
  }
  const sales = revRow?.gross ?? 0;
  return { gross: sales + manual, orders: revRow?.orders ?? 0, sales, manual, byMethod, bySource, byHandler: { sales: salesBy, manual: manualBy } };
}

export async function getIncome(): Promise<Income[]> {
  const res = await db()
    .prepare("SELECT id, date, amount, source, handled_by, note FROM fin_income ORDER BY date DESC, id DESC")
    .all<Income>();
  return res.results ?? [];
}

export async function addIncome(i: { date: string; amount: number; source?: string; handledBy?: string; note?: string; createdBy?: string }): Promise<Income> {
  const res = await db()
    .prepare(
      `INSERT INTO fin_income (date, amount, source, handled_by, note, created_by) VALUES (?, ?, ?, ?, ?, ?)
       RETURNING id, date, amount, source, handled_by, note`,
    )
    .bind(i.date, i.amount, IS_INCOME_SOURCE(i.source) ? i.source : "", normHandler(i.handledBy), (i.note ?? "").slice(0, 300), (i.createdBy ?? "").slice(0, 40))
    .first<Income>();
  if (!res) throw new Error("income insert failed");
  return res;
}

export async function deleteIncome(id: number): Promise<void> {
  await db().prepare("DELETE FROM fin_income WHERE id = ?").bind(id).run();
}

/** Who handled money in and out is only meaningful for the two partners. */
export const HANDLER_KEYS = HANDLERS;

// ---- The whole tab in one read ----

export async function getFinance(): Promise<{
  expenses: Expense[];
  income: Income[];
  budgets: Budget[];
  /** 0 = not set. */
  totalBudget: number;
  revenue: Revenue;
  /** מהכיס: מה כל שותפה שמה, ומה צריך לעבור כדי להשוות. */
  pocket: PocketBalance;
  scenarios: Scenario[];
  dailySales: DailySale[];
  receipts: Receipt[];
  dropProfits: DropProfit[];
  settlements: Settlement[];
  feeRates: Record<string, number>;
  /** null = לא הוזנה יתרת פתיחה (שונה מאפס: אז השורה היא רק מה שנרשם בלוח). */
  openings: Record<OpeningPot, number | null>;
  vatExempt: boolean;
  /** דופק המכירות מהשרת (null = החישוב נכשל; המסך אומר "לא נבדק", לא אפס). */
  pulse: SalesPulse | null;
  /** תמונת הכסף: יתרות, תקבולים, התחייבויות וכסף פנוי, כל אחד עם מקור ומצב. */
  money: MoneySnapshot | null;
}> {
  const expensesRes = await db()
    .prepare("SELECT id, date, payer, category, description, amount, paid_from, vat, tax_id FROM fin_expenses ORDER BY date DESC, id DESC")
    .all<Expense>();
  const expenses = expensesRes.results ?? [];
  const budgetsRes = await db().prepare("SELECT category, amount, position FROM fin_budgets ORDER BY position, category").all<Budget>();
  const totalBudget = await getTotalBudget();
  const revenue = await getRevenue();
  const income = await getIncome();
  const pocket = pocketBalance({
    avia: expenses.filter((e) => e.payer === "avia").reduce((s, e) => s + e.amount, 0),
    lior: expenses.filter((e) => e.payer === "lior").reduce((s, e) => s + e.amount, 0),
  });
  const scenarios = await getScenarios();
  const dailySales = await getDailySales();
  // A missing bucket must not take the whole tab down: worst case the
  // paperclips just do not show up.
  let receipts: Receipt[] = [];
  try {
    receipts = await getReceipts();
  } catch (error) {
    console.error("receipts unavailable", error);
  }
  let dropProfits: DropProfit[] = [];
  try {
    dropProfits = await getDropProfits();
  } catch (error) {
    console.error("drop profits unavailable", error);
  }
  const [settlements, feeRates, openings, vatExempt] = await Promise.all([getSettlements(), getFeeRates(), getPotOpenings(), getVatExempt()]);
  // דופק ותמונת כסף: כישלון = null (המסך מציג "לא נבדק"), לא מפיל את הטאב ולא מציג אפס.
  const [pulse, money] = await Promise.all([
    getSalesPulse().catch((error) => {
      console.error("sales pulse unavailable", error);
      return null;
    }),
    moneySnapshot(db()).catch((error) => {
      console.error("money snapshot unavailable", error);
      return null;
    }),
  ]);
  return {
    pulse,
    money,
    expenses,
    income,
    budgets: budgetsRes.results ?? [],
    totalBudget,
    revenue,
    pocket,
    scenarios,
    dailySales,
    receipts,
    dropProfits,
    settlements,
    feeRates,
    openings,
    vatExempt,
  };
}

// Store-traffic cache (written by the traffic op after asking the DO). Kept
// in settings so every device shares one Shopify call per window.
export type TrafficSnapshot = {
  ts: number;
  t7: { sessions: number; purchases: number; conversionPct: number } | null;
  t14: { sessions: number; purchases: number; conversionPct: number } | null;
};

export async function getTrafficCache(): Promise<TrafficSnapshot | null> {
  const raw = await setting("traffic_cache");
  if (!raw) return null;
  try {
    return JSON.parse(raw) as TrafficSnapshot;
  } catch {
    return null;
  }
}

export async function setTrafficCache(v: TrafficSnapshot): Promise<void> {
  await putSetting("traffic_cache", JSON.stringify(v));
}

// ---- Expenses ----

export async function categoryStatus(category: string): Promise<{ spent: number; budget: number }> {
  const spentRow = await db().prepare("SELECT COALESCE(SUM(amount), 0) AS s FROM fin_expenses WHERE category = ?").bind(category).first<{ s: number }>();
  const budgetRow = await db().prepare("SELECT amount FROM fin_budgets WHERE category = ?").bind(category).first<{ amount: number }>();
  return { spent: spentRow?.s ?? 0, budget: budgetRow?.amount ?? 0 };
}

const EXPENSE_COLS = "id, date, payer, category, description, amount, paid_from, vat, tax_id";

export async function addExpense(e: {
  date: string;
  payer: string;
  category: string;
  description: string;
  amount: number;
  paidFrom?: string;
  vat?: number;
  taxId?: string;
  createdBy?: string;
}): Promise<Expense> {
  const payer = IS_PAYER(e.payer) ? e.payer : "business";
  // Only business money comes out of a pot; a partner paying from her own
  // pocket leaves the bank/Bit/cash balances untouched.
  const paidFrom = payer === "business" && POTS.has(e.paidFrom ?? "") ? (e.paidFrom ?? "") : "";
  // A category that is new to the list is added to it, so the budget panel
  // always shows every category that has money in it.
  await db().prepare("INSERT OR IGNORE INTO fin_budgets (category, amount, position) VALUES (?, 0, (SELECT COALESCE(MAX(position), 0) + 1 FROM fin_budgets))").bind(e.category).run();
  const res = await db()
    .prepare(
      `INSERT INTO fin_expenses (date, payer, category, description, amount, paid_from, vat, tax_id, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING ${EXPENSE_COLS}`,
    )
    .bind(e.date, payer, e.category, e.description, e.amount, paidFrom, e.vat ?? 0, e.taxId ?? "", (e.createdBy ?? "").slice(0, 40))
    .first<Expense>();
  if (!res) throw new Error("insert failed");
  return res;
}

/** Correcting what is already in the journal (Hobi files receipts on her own,
 *  so a misread number has to be fixable from the chat). Only the fields
 *  actually passed are touched. */
export async function updateExpense(
  id: number,
  fields: { amount?: number; category?: string; description?: string; date?: string; payer?: string; paidFrom?: string },
): Promise<Expense | null> {
  const sets: string[] = [];
  const binds: unknown[] = [];
  if (typeof fields.amount === "number") (sets.push("amount = ?"), binds.push(fields.amount));
  if (fields.category) (sets.push("category = ?"), binds.push(fields.category));
  if (typeof fields.description === "string") (sets.push("description = ?"), binds.push(fields.description));
  if (fields.date) (sets.push("date = ?"), binds.push(fields.date));
  if (IS_PAYER(fields.payer)) (sets.push("payer = ?"), binds.push(fields.payer));
  if (fields.paidFrom !== undefined && POTS.has(fields.paidFrom)) (sets.push("paid_from = ?"), binds.push(fields.paidFrom));
  if (!sets.length) return null;
  const row = await db()
    .prepare(`UPDATE fin_expenses SET ${sets.join(", ")} WHERE id = ? RETURNING ${EXPENSE_COLS}`)
    .bind(...binds, id)
    .first<Expense>();
  if (!row) return null;
  // A pocket expense never has a pot; a category is added to the list like on insert.
  if (row.payer !== "business" && row.paid_from) await db().prepare("UPDATE fin_expenses SET paid_from = '' WHERE id = ?").bind(id).run();
  if (fields.category) await db().prepare("INSERT OR IGNORE INTO fin_budgets (category, amount, position) VALUES (?, 0, (SELECT COALESCE(MAX(position), 0) + 1 FROM fin_budgets))").bind(fields.category).run();
  return { ...row, paid_from: row.payer === "business" ? row.paid_from : "" };
}

/** Retro-tagging from the expense journal, business rows only. */
export async function setExpensePaidFrom(id: number, paidFrom: string): Promise<void> {
  await db()
    .prepare("UPDATE fin_expenses SET paid_from = ? WHERE id = ? AND payer = 'business'")
    .bind(POTS.has(paidFrom) ? paidFrom : "", id)
    .run();
}

export async function deleteExpense(id: number): Promise<void> {
  // Free its receipts first, back to pending, where they can be re-filed.
  await db().prepare("UPDATE fin_receipts SET expense_id = NULL WHERE expense_id = ?").bind(id).run();
  await db().prepare("DELETE FROM fin_expenses WHERE id = ?").bind(id).run();
}

// ---- Budgets / categories ----

export async function setBudget(category: string, amount: number): Promise<void> {
  await db()
    .prepare(
      "INSERT INTO fin_budgets (category, amount, position) VALUES (?, ?, (SELECT COALESCE(MAX(position), 0) + 1 FROM fin_budgets)) ON CONFLICT(category) DO UPDATE SET amount = excluded.amount",
    )
    .bind(category, Math.max(0, amount))
    .run();
}

/** Removes a category from the list. Expenses keep their category text. */
export async function deleteBudget(category: string): Promise<void> {
  await db().prepare("DELETE FROM fin_budgets WHERE category = ?").bind(category).run();
}

export async function listCategories(): Promise<string[]> {
  const res = await db().prepare("SELECT category FROM fin_budgets ORDER BY position, category").all<{ category: string }>();
  return (res.results ?? []).map((r) => r.category);
}

// ---- Receipt photos ----------------------------------------------------
// Bytes live in R2 (STORAGE); D1 only holds the key. Nothing is served
// straight from the bucket: /api/receipt streams it behind the board cookie.

export type Receipt = { id: number; expense_id: number | null; mime: string; created_at: string };

function storage(): R2Bucket {
  const bucket = bindings().STORAGE;
  if (!bucket) throw new Error("no r2 binding");
  return bucket;
}

/** Every receipt, unattached ones included; the tab shows those in a strip. */
export async function getReceipts(): Promise<Receipt[]> {
  const res = await db().prepare("SELECT id, expense_id, mime, created_at FROM fin_receipts ORDER BY id").all<Receipt>();
  return res.results ?? [];
}

/** Hangs an already-stored receipt on an expense (the strip, and Hobi's tool). */
export async function attachReceipt(receiptId: number, expenseId: number): Promise<boolean> {
  const res = await db().prepare("UPDATE fin_receipts SET expense_id = ? WHERE id = ?").bind(expenseId, receiptId).run();
  return (res.meta?.changes ?? 0) > 0;
}

/** Unattached receipts from one chat, newest first. */
export async function pendingReceipts(chatId: string): Promise<Receipt[]> {
  const res = await db()
    .prepare("SELECT id, expense_id, mime, created_at FROM fin_receipts WHERE expense_id IS NULL AND chat_id = ? ORDER BY id DESC")
    .bind(chatId)
    .all<Receipt>();
  return res.results ?? [];
}

/** Stores the bytes and the row. `expenseId` is null for a photo that arrived
 *  before its expense; `claimPendingReceipt` attaches it later. */
export async function addReceipt(o: { expenseId: number | null; bytes: ArrayBuffer; mime: string; source: string; chatId?: string }): Promise<number> {
  // The key carries no guessable meaning and is never exposed to the client.
  const key = `receipts/${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  await storage().put(key, o.bytes, { httpMetadata: { contentType: o.mime } });
  const row = await db()
    .prepare("INSERT INTO fin_receipts (expense_id, r2_key, mime, source, chat_id) VALUES (?, ?, ?, ?, ?) RETURNING id")
    .bind(o.expenseId, key, o.mime, o.source, o.chatId ?? "")
    .first<{ id: number }>();
  return row?.id ?? 0;
}

/** Streams one receipt, or null when the id is unknown / the object is gone. */
export async function readReceipt(id: number): Promise<{ body: ReadableStream; mime: string } | null> {
  const row = await db().prepare("SELECT r2_key, mime FROM fin_receipts WHERE id = ?").bind(id).first<{ r2_key: string; mime: string }>();
  if (!row) return null;
  const obj = await storage().get(row.r2_key);
  if (!obj) return null;
  // An octet-stream would download instead of showing; assume a photo.
  const mime = !row.mime || row.mime === "application/octet-stream" ? "image/jpeg" : row.mime;
  return { body: obj.body as unknown as ReadableStream, mime };
}

export async function deleteReceipt(id: number): Promise<void> {
  const row = await db().prepare("SELECT r2_key FROM fin_receipts WHERE id = ?").bind(id).first<{ r2_key: string }>();
  if (!row) return;
  // Row first: a stranded object costs a few KB, a row pointing at nothing
  // shows the partners a broken receipt.
  await db().prepare("DELETE FROM fin_receipts WHERE id = ?").bind(id).run();
  try {
    await storage().delete(row.r2_key);
  } catch (error) {
    console.error("receipt object delete failed", error);
  }
}

/** Attaches the newest unattached receipt from a chat to a fresh expense, so
 *  "photo, then the amount" works as well as a photo with its caption. The
 *  30-minute window keeps an old orphan from latching onto tomorrow's expense. */
export async function claimPendingReceipt(expenseId: number, chatId: string): Promise<boolean> {
  const res = await db()
    .prepare(
      `UPDATE fin_receipts SET expense_id = ?
       WHERE id = (SELECT id FROM fin_receipts
                   WHERE expense_id IS NULL AND chat_id = ?
                     AND created_at >= datetime('now', '-30 minutes')
                   ORDER BY id DESC LIMIT 1)`,
    )
    .bind(expenseId, chatId)
    .run();
  return (res.meta?.changes ?? 0) > 0;
}
