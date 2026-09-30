// Bruno, the Segula Assistant: answers the partners inside the board's
// "ברונו" tab with Claude and full board context, and acts on the board
// through tools (tasks, gifts, sales, expenses, stock, reminders). Born on
// Telegram in July 2026; that channel was banned in Aug 2026 and its code
// removed 3.9.2026 — the board chat (handleBoardChat) is the only door.
import { addItem as addPlanItem, planPromptBlock, updateItem as updatePlanItem } from "./plan.server";
import type { D1Database } from "@cloudflare/workers-types";
import {
  deleteReceipt,
  addExpense,
  addReceipt,
  addSettlement,
  settlementSuspicion,
  attachReceipt,
  claimPendingReceipt,
  deleteExpense,
  IS_PROVIDER,
  pendingReceipts,
  updateExpense,
} from "./finance.server";
import { pushNotify } from "./push.server";
import { orderKeyOf, salesByItemWindows } from "./orders.server";
import { addReminder } from "./reminders.server";
import {
  GIFT_KINDS,
  PAY_METHODS,
  SHIP_STATUSES,
  addGift,
  addItem,
  addSale,
  getSeeding,
  normLocation,
  receiveStock,
  transferStock,
} from "./seeding.server";
import { addTask, updateTask } from "./hob.server";
import { buildVariantMap, drainShopifyPushQueue, shopifyQuickStats } from "./shopify.server";
import {
  goalsBlock,
  ilOffsetMs,
  ilTodayISO,
} from "./summary.server";

import { OWNER_CONTEXT_DEFAULT } from "./team.context";
import { addMemory, listFacts, memoryForPrompt, reviseFact, revokeFact } from "./team.memory.server";
import { runAgent, teamStatusForBruno, workerNames, workerOfHat } from "./team.server";
import { type LinkKind, linkWork, reviewPlan, setWorkState, updateWork, upsertWork, workSummaryForBruno } from "./team.work.server";
import { RECIPES } from "./recipes";
import { cancelJob, jobStatusForBruno, recipesPromptBlock, startRecipe } from "./recipes.server";
import { FIGURE_STATE_HE, type FigureState, STATUS_HE as FIN_STATUS_HE, listFacts as listFinFacts, moneySnapshot } from "./finance.summary.server";
import { STATUS_HE as PARTNER_STATUS_HE, resolveProspect, updateProspect } from "./partners.server";
import { moveProspects } from "./team.actions.server";

export type AssistantEnv = {
  DB?: D1Database;
  ANTHROPIC_API_KEY?: string;
  SHOPIFY_CLIENT_ID?: string;
  SHOPIFY_CLIENT_SECRET?: string;
  VAPID_PRIVATE_JWK?: string;
  KLAVIYO_API_KEY?: string;
};

const HISTORY_KEEP = 30; // rows kept per chat
const HISTORY_SEND = 12; // turns sent to Claude
const WEEKDAY_NAMES = ["ראשון", "שני", "שלישי", "רביעי", "חמישי", "שישי", "שבת"];

// ---- Settings helpers (webhook secret + bot username live in D1) ----

export async function getSetting(db: D1Database, key: string): Promise<string | null> {
  const row = await db
    .prepare("SELECT value FROM settings WHERE key = ?")
    .bind(key)
    .first<{ value: string }>();
  return row?.value ?? null;
}

export async function putSetting(db: D1Database, key: string, value: string): Promise<void> {
  await db
    .prepare(
      "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    )
    .bind(key, value)
    .run();
}

// ---- Chat history (D1) ----

type HistoryRow = { role: string; content: string };

/** השורות האחרונות של צ'אט הלוח, לתשובה המיידית (הקשר קצר, בלי הכל). */
export async function recentBoardHistory(db: D1Database | undefined, n = 4): Promise<HistoryRow[]> {
  if (!db) return [];
  const rows = await loadHistory(db, BOARD_CHAT_ID);
  return rows.slice(-n);
}

async function loadHistory(db: D1Database, chatId: number): Promise<HistoryRow[]> {
  try {
    const res = await db
      .prepare(
        // kind='note' rows are board notifications carrying stranger-typed
        // text (signups, signed notes, buyers) — shown in the chat, never
        // replayed to the model as its own past words.
        "SELECT role, content FROM assistant_chat WHERE chat_id = ? AND kind = '' ORDER BY id DESC LIMIT ?",
      )
      .bind(chatId, HISTORY_SEND)
      .all<HistoryRow>();
    return (res.results ?? []).reverse();
  } catch (error) {
    // History is nice-to-have — never let it silence the bot.
    console.error("assistant history load failed", error);
    return [];
  }
}

async function saveTurn(
  db: D1Database,
  chatId: number,
  role: "user" | "assistant",
  content: string,
): Promise<void> {
  await db
    .prepare("INSERT INTO assistant_chat (chat_id, role, content) VALUES (?, ?, ?)")
    .bind(chatId, role, content.slice(0, 4000))
    .run();
  await db
    .prepare(
      "DELETE FROM assistant_chat WHERE chat_id = ? AND id NOT IN (SELECT id FROM assistant_chat WHERE chat_id = ? ORDER BY id DESC LIMIT ?)",
    )
    .bind(chatId, chatId, HISTORY_KEEP)
    .run();
}

// ---- Board digest for the system prompt ----

type DigestTask = {
  id: number;
  title: string;
  notes?: string;
  status: string;
  priority?: string;
  owner?: string;
  due?: string;
  updated?: string;
};

async function boardDigest(db: D1Database): Promise<string> {
  const groups = await db
    .prepare("SELECT id, title FROM board_groups ORDER BY position, id")
    .all<{ id: number; title: string }>();
  const tasks = await db
    .prepare(
      "SELECT id, group_id, title, notes, status, priority, owner, due_date, updated_at FROM tasks",
    )
    .all<{
      id: number;
      group_id: number;
      title: string;
      notes: string;
      status: string;
      priority: string;
      owner: string;
      due_date: string;
      updated_at: string;
    }>();
  const byGroup = new Map<number, DigestTask[]>();
  for (const t of tasks.results ?? []) {
    const list = byGroup.get(t.group_id) ?? [];
    list.push({
      id: t.id,
      title: t.title,
      notes: t.notes || undefined,
      status: t.status,
      priority: t.priority || undefined,
      owner: t.owner || undefined,
      due: t.due_date || undefined,
      updated: t.updated_at,
    });
    byGroup.set(t.group_id, list);
  }
  const digest = (groups.results ?? []).map((g) => ({
    group_id: g.id,
    group: g.title,
    tasks: byGroup.get(g.id) ?? [],
  }));
  return JSON.stringify(digest);
}

// Financial context for business-development advice: the live price list,
// the partners' financial model (mirrors their Google Sheet), and budgets.
export async function financeDigest(db: D1Database, chatId?: number): Promise<string> {
  try {
    // Receipts already in hand. Without this the brain has no idea a photo
    // ever arrived and tells the partners "לא הגיעה אליי תמונה" while their
    // receipt sits in the journal's pending strip.
    const pending = await db
      .prepare(
        `SELECT COUNT(*) AS n,
                CAST((julianday('now') - julianday(MAX(created_at))) * 1440 AS INT) AS newest_min
         FROM fin_receipts WHERE expense_id IS NULL AND (? = '' OR chat_id = ?)`,
      )
      .bind(chatId ? String(chatId) : "", chatId ? String(chatId) : "")
      .first<{ n: number; newest_min: number | null }>();
    // Attaching a receipt in the board used to erase it from Bruno's view —
    // the pending count dropped to 0 and he went back to denying the photo
    // ever came. Recent arrivals are listed whether or not they found an
    // expense yet.
    const recent = await db
      .prepare(
        `SELECT id, expense_id,
                CAST((julianday('now') - julianday(created_at)) * 1440 AS INT) AS min_ago
         FROM fin_receipts
         WHERE created_at >= datetime('now', '-6 hours') AND (? = '' OR chat_id = ?)
         ORDER BY id DESC LIMIT 10`,
      )
      .bind(chatId ? String(chatId) : "", chatId ? String(chatId) : "")
      .all<{ id: number; expense_id: number | null; min_ago: number }>();
    // The last rows written, with their ids — without them fix_expense has
    // nothing to aim at when a partner says "לא, זה היה 350".
    const lastExpenses = await db
      .prepare(
        "SELECT id, date, payer, category, description, amount, vat FROM fin_expenses ORDER BY id DESC LIMIT 8",
      )
      .all<Record<string, unknown>>();
    // VAT the partners actually paid this month, for the accountant's question.
    const vatMonth = await db
      .prepare(
        "SELECT COALESCE(SUM(vat), 0) AS vat, COUNT(*) AS rows FROM fin_expenses WHERE vat > 0 AND date >= date('now','start of month')",
      )
      .first<{ vat: number; rows: number }>();
    const products = await db
      .prepare("SELECT name, cost, shipping, extra, price FROM products")
      .all<{ name: string; cost: number; shipping: number; extra: number; price: number | null }>();
    const fin = await db
      .prepare(
        "SELECT name, qty, price, cost, packaging, gifts, ship_unit, ship_total, ship_count FROM product_fin",
      )
      .all<Record<string, unknown>>();
    const budgets = await db
      .prepare("SELECT name, amount FROM budgets")
      .all<{ name: string; amount: number }>();
    const fixed = await db
      .prepare("SELECT value FROM settings WHERE key = 'fixed_costs'")
      .first<{ value: string }>();
    // The live expense tracker (finance tab): categories with budget vs spent,
    // so log_expense picks valid categories and Bruno can answer "כמה הוצאנו".
    const finBudgets = await db
      .prepare(
        "SELECT b.category, b.amount AS budget, COALESCE(SUM(e.amount), 0) AS spent FROM fin_budgets b LEFT JOIN fin_expenses e ON e.category = b.category GROUP BY b.category, b.amount ORDER BY b.position, b.category",
      )
      .all<{ category: string; budget: number; spent: number }>();
    const finTotals = await db
      .prepare(
        "SELECT COALESCE(SUM(amount), 0) AS spent, COALESCE(SUM(CASE WHEN payer = 'yogev' THEN amount END), 0) AS yogev, COALESCE(SUM(CASE WHEN payer = 'yogev_buyout' THEN amount END), 0) AS yogev_buyout, COALESCE(SUM(CASE WHEN payer = 'business' THEN amount END), 0) AS business FROM fin_expenses",
      )
      .first<{ spent: number; yogev: number; yogev_buyout: number; business: number }>();
    const tbRow = await db
      .prepare("SELECT value FROM settings WHERE key = 'fin_total_budget'")
      .first<{ value: string }>();
    // הכסף: אותה תמונה מובנית שאלכס ו"היום שלך" רואים (finance.summary.server), כדי שברונו
    // לא יחשב לבד מספר אחר. בלי מכירות מבוטלות, ו"לא ידוע" (null) כשחסר רכיב, לא אפס.
    const snap = await moneySnapshot(db).catch(() => null);
    const bizFacts = await listFinFacts(db).catch(() => []);
    const settledFees = await db
      .prepare("SELECT COALESCE(SUM(gross - net), 0) AS fees FROM fin_settlements")
      .first<{ fees: number }>()
      .catch(() => null);
    const fig = (f: { value: number | null; source: string; asOf: string | null; note?: string; state?: FigureState } | undefined) =>
      f ? { value: f.value, source: f.source, as_of: f.asOf, note: f.note ?? null, state: f.state ? FIGURE_STATE_HE[f.state] : null } : { value: null, source: "", as_of: null, note: "לא נטען", state: null };
    const money = snap
      ? {
          bank: fig(snap.balances.bank),
          bit: fig(snap.balances.bit),
          cash: fig(snap.balances.cash),
          waiting_at_clearers_gross: fig(snap.receivables.clearing),
          consignment_note: snap.receivables.consignment.note ?? null,
          buyout_balance_to_dima: fig(snap.liabilities.buyout),
          open_influencer_commissions: fig(snap.liabilities.commissions),
          free_money: fig(snap.free),
          // מיום החתימה על הרכישה הכסף של יוגב, בחשבון חדש. היתרות למעלה כבר נספרות מהתאריך הזה.
          since_buyout: snap.era
            ? { start: snap.era.start, revenue: fig(snap.era.revenue), expenses: fig(snap.era.expenses) }
            : { start: null, note: "ההסכם עוד לא נחתם בלוח (אין תאריך רכישה): כל הסכומים מתחילת הרישומים" },
          data_gaps: snap.gaps.map((g) => g.text),
        }
      : { error: "תמונת הכסף לא נטענה. אל תמסור מספר כסף." };
    return JSON.stringify({
      price_list: products.results ?? [],
      financial_model: fin.results ?? [],
      // נתונים עסקיים (רכישה מדימה, תקרת השקעה, יעד, עלויות): ערך + מצב + מקור. זה המקור היחיד שלהם.
      business_facts: bizFacts.map((f) => ({ key: f.key, label: f.label, value: f.value, unit: f.unit, status: FIN_STATUS_HE[f.status] ?? f.status, source: f.source, note: f.text })),
      budgets: budgets.results ?? [],
      fixed_costs: fixed ? Number(fixed.value) : null,
      expense_tracker: {
        // הגדרת תקציב מטאב הכספים (תוכנית, לא כסף שיש). ברירת המחדל 60,000 אם לא הוגדר.
        total_budget_setting: { value: tbRow ? parseFloat(tbRow.value) || 60000 : 60000, is_default: !tbRow, kind: "תוכנית, לא כסף" },
        total_spent: Math.round(finTotals?.spent ?? 0),
        spent_by_yogev: Math.round(finTotals?.yogev ?? 0),
        // ההוצאות שדימה שילם עד הרכישה (27.9) — של יוגב עכשיו, מוצגות בנפרד.
        spent_by_yogev_from_buyout: Math.round(finTotals?.yogev_buyout ?? 0),
        spent_by_business: Math.round(finTotals?.business ?? 0),
        categories: finBudgets.results ?? [],
        // "כמה כסף יש בבנק/בביט/במזומן" — answer from here, not by adding up sales.
        // bank = deposits that actually arrived, in net. pending_* = money still
        // sitting at Shopify/Hyp that has not reached the account yet.
        money,
        clearing_fees_paid: Math.round(settledFees?.fees ?? 0),
        pending_receipts: {
          count: pending?.n ?? 0,
          newest_minutes_ago: pending?.newest_min ?? null,
        },
        receipts_received_recently: (recent.results ?? []).map((r) => ({
          id: r.id,
          minutes_ago: r.min_ago,
          attached_to_expense: r.expense_id,
        })),
        recent_expenses: lastExpenses.results ?? [],
        vat_this_month: {
          total: Math.round(vatMonth?.vat ?? 0),
          expenses_with_vat: vatMonth?.rows ?? 0,
        },
      },
    });
  } catch (error) {
    console.error("finance digest failed", error);
    return "{}";
  }
}

export type ShipUpdate =
  | { ok: true; ref: string; buyer: string; status: string; updated_lines: number; ids: number[] }
  | { ok: false; error: string; ambiguous?: true; orders?: { ref: string; lines: number; status: string; sold_at: string }[] };

/** הכלי של ברונו לעדכון משלוח: הזמנה אחת (קונה + מספר הזמנה), לא כל השורות של הקונה.
 *  "נשלח"/"התקבל" רק עם ראיה: מספר הזמנה שמופיע על השורה או evidence (מספר מעקב, שליח,
 *  למי נמסר ביד), והראיה נשמרת על השורה ("נשלח: ..."). כמה הזמנות פתוחות בלי ref = שאלה, לא ניחוש. */
export async function updateShipStatus(db: D1Database, input: Record<string, unknown>): Promise<ShipUpdate> {
  const buyer = typeof input.buyer === "string" ? input.buyer.trim() : "";
  const status = typeof input.status === "string" && SHIP_STATUSES.has(input.status) && input.status !== "cancelled" ? input.status : "";
  if (!buyer || !status) return { ok: false, error: "missing buyer/status" };
  // "#1112", "1112", "Shopify #1112" → "#1112"
  const refRaw = typeof input.ref === "string" ? input.ref.trim() : "";
  const ref = refRaw ? `#${refRaw.replace(/^.*?#?(\d{3,6})\s*$/, "$1")}` : "";
  const evidence = typeof input.evidence === "string" ? input.evidence.trim().slice(0, 200) : "";
  const needsProof = status === "shipped" || status === "delivered";
  if (needsProof && !ref && !evidence) return { ok: false, error: `לא סומן "${status}": צריך מספר הזמנה (ref) או ראיה (evidence: מספר מעקב, שליח, למי נמסר ביד). שאל את יוגב.` };
  const rows =
    (
      await db
        .prepare("SELECT id, order_ref, note, ship_status, sold_at FROM seed_sales WHERE TRIM(buyer) = ? AND ship_status <> 'cancelled' AND COALESCE(channel,'') <> 'archive' ORDER BY id")
        .bind(buyer)
        .all<{ id: number; order_ref: string | null; note: string | null; ship_status: string; sold_at: string }>()
    ).results ?? [];
  if (!rows.length) return { ok: false, error: "buyer not found" };
  const groups = new Map<string, typeof rows>();
  for (const r of rows) {
    const k = orderKeyOf({ id: r.id, order_ref: r.order_ref ?? "", note: r.note ?? "" });
    groups.set(k.ref || k.key, [...(groups.get(k.ref || k.key) ?? []), r]);
  }
  const describe = (k: string, lines: typeof rows) => ({ ref: k.startsWith("row:") ? "" : k, lines: lines.length, status: lines[0].ship_status, sold_at: lines[0].sold_at.slice(0, 10) });
  let target: [string, typeof rows] | undefined;
  if (ref) {
    target = [...groups.entries()].find(([k]) => k === ref);
    if (!target) return { ok: false, error: `אין הזמנה ${ref} של ${buyer}. ההזמנות שלו: ${[...groups.entries()].map(([k, l]) => describe(k, l).ref || "בלי מספר").join(", ")}` };
  } else {
    // בלי ref: מועמדת = הזמנה שעוד לא נמסרה ועוד לא בשלב המבוקש. אחת = היא; יותר = לשאול.
    const open = [...groups.entries()].filter(([, l]) => l.some((x) => x.ship_status !== "delivered" && x.ship_status !== status));
    if (open.length > 1) return { ok: false, ambiguous: true, error: "לקונה כמה הזמנות פתוחות, צריך מספר הזמנה", orders: open.map(([k, l]) => describe(k, l)) };
    target = open[0] ?? [...groups.entries()][0];
  }
  const [key, lines] = target;
  const ids = lines.map((l) => l.id);
  await db
    .prepare(`UPDATE seed_sales SET ship_status = ?, updated_at = datetime('now') WHERE id IN (${ids.map(() => "?").join(",")})`)
    .bind(status, ...ids)
    .run();
  if (evidence) {
    // הראיה פעם אחת על כל שורה של ההזמנה (ניסיון חוזר לא מכפיל).
    await db
      .prepare(`UPDATE seed_sales SET note = CASE WHEN note = '' THEN ? ELSE note || ' · ' || ? END WHERE id IN (${ids.map(() => "?").join(",")}) AND instr(note, ?) = 0`)
      .bind(`נשלח: ${evidence}`, `נשלח: ${evidence}`, ...ids, `נשלח: ${evidence}`)
      .run();
  }
  const after = (await db.prepare(`SELECT id FROM seed_sales WHERE ship_status = ? AND id IN (${ids.map(() => "?").join(",")})`).bind(status, ...ids).all<{ id: number }>()).results ?? [];
  if (after.length !== ids.length) return { ok: false, error: `עודכנו ${after.length} מתוך ${ids.length} שורות, בדוק בטאב ההפצה` };
  return { ok: true, ref: key.startsWith("row:") ? "" : key, buyer, status, updated_lines: ids.length, ids };
}

// Seeding context: giveaway inventory + recent gifts, so the bot can log
// gifts by item id and warn on low stock.
/** מכירות לפריט ב-7 וב-30 יום, מהלוח ונכון לעכשיו, כדי שברונו לא יגיד "אין לי חלוקה שבועית"
 *  ולא יצטט כמויות מתוכננות מהזיכרון ("300 מתוכננות") כאילו הן מצב נוכחי. */
async function itemSalesBlock(db: D1Database): Promise<string> {
  const w = await salesByItemWindows(db);
  if (!w.items.length) return "";
  const rows = w.items.map((i) => `- ${i.name}: 7 יום ${i.sold7} · 30 יום ${i.sold30} · נשארו ${i.left}`);
  return `מכירות לפריט (7 / 30 יום, מהלוח, נכון ל-${w.asOf}; 7 יום = ${w.from7} עד ${w.asOf}, 30 יום = ${w.from30} עד ${w.asOf}, יחידות, בלי ארכיון ובלי מבוטלות):\n${rows.join("\n")}\nכמויות ותוכניות שבזיכרון (למשל "300 מתוכננות") הן היסטוריה עם תאריך; כשיש כאן מספר חי, צטט אותו ואת התאריך, לא את הזיכרון.`;
}

async function seedingDigest(): Promise<string> {
  try {
    const { items, gifts, sales: allSales } = await getSeeding();
    // Archive rows (previous drops, imported for the customer list) stay out
    // of the digest's live numbers — Bruno's revenue/fulfillment talk is
    // about the CURRENT drop. Customer lookups query the table directly.
    const sales = allSales.filter((s) => s.channel !== "archive");
    const rowTotal = (r: {
      qty: number;
      qty_xs: number;
      qty_s: number;
      qty_m: number;
      qty_l: number;
      qty_xl: number;
      qty_xxl: number;
    }) => r.qty + r.qty_xs + r.qty_s + r.qty_m + r.qty_l + r.qty_xl + r.qty_xxl;
    return JSON.stringify({
      stock_locations: { room: "החדר", car: "האוטו של יוגב" },
      inventory: items.map((i) => ({
        item_id: i.id,
        name: i.name,
        price: i.price,
        stock_by_location: Object.fromEntries(
          i.stock.map((r) => [
            r.location,
            {
              no_size: r.qty,
              XS: r.qty_xs,
              S: r.qty_s,
              M: r.qty_m,
              L: r.qty_l,
              XL: r.qty_xl,
              XXL: r.qty_xxl,
              total: rowTotal(r),
            },
          ]),
        ),
        in_stock_total: i.stock.reduce((s, r) => s + rowTotal(r), 0),
        given: i.given,
        sold: i.sold,
      })),
      recent_gifts: gifts.slice(0, 12).map((g) => ({
        person: g.person,
        handle: g.handle,
        item: g.item_label,
        size: g.size,
        qty: g.qty,
        status: g.status,
        date: g.given_at,
      })),
      recent_sales: sales.slice(0, 12).map((s) => ({
        buyer: s.buyer,
        item: s.item_label,
        size: s.size,
        qty: s.qty,
        unit_price: s.price,
        ship_status: s.ship_status,
        pay_method: s.pay_method || "",
        date: s.sold_at,
      })),
      // Revenue split by where the money landed: shopify = in the bank,
      // bit/cash = received in person, "" = nobody tagged it yet.
      revenue_by_pay_method: (() => {
        const m: Record<string, number> = {};
        for (const s of sales) m[s.pay_method || ""] = (m[s.pay_method || ""] ?? 0) + s.price * s.qty;
        return m;
      })(),
      // Fulfillment queue: every order (grouped by buyer) not yet delivered, with the
      // order refs (#1112) Bruno must pass to update_ship_status when there are several.
      open_orders: (() => {
        const byBuyer = new Map<string, { items: number; total: number; status: string; refs: string[] }>();
        for (const s of sales) {
          if ((s.ship_status || "recorded") === "delivered" || s.ship_status === "cancelled") continue;
          const e = byBuyer.get(s.buyer.trim()) ?? {
            items: 0,
            total: 0,
            status: s.ship_status || "recorded",
            refs: [],
          };
          e.items += s.qty;
          e.total += s.price * s.qty;
          const ref = orderKeyOf({ id: s.id, order_ref: (s as { order_ref?: string }).order_ref ?? "", note: s.note ?? "" }).ref;
          if (ref && !e.refs.includes(ref)) e.refs.push(ref);
          byBuyer.set(s.buyer.trim(), e);
        }
        return [...byBuyer.entries()].map(([buyer, e]) => ({ buyer, ...e }));
      })(),
      today: (() => {
        const t = ilTodayISO();
        const todaySales = sales.filter((s) => s.sold_at === t);
        const todayGifts = gifts.filter((g) => g.given_at === t);
        const units = new Map<string, number>();
        for (const s of todaySales) units.set(s.item_label, (units.get(s.item_label) ?? 0) + s.qty);
        const top = [...units.entries()].sort((a, b) => b[1] - a[1])[0];
        return {
          sales_count: todaySales.length,
          revenue: todaySales.reduce((sum, s) => sum + s.price * s.qty, 0),
          gifts_count: todayGifts.reduce((sum, g) => sum + g.qty, 0),
          top_item: top ? top[0] : null,
        };
      })(),
      total_revenue: sales.reduce((sum, s) => sum + s.price * s.qty, 0),
    });
  } catch (error) {
    console.error("seeding digest failed", error);
    return "{}";
  }
}

// ---- Claude tools: acting on the board ----

const TOOLS = [
  {
    name: "add_task",
    description:
      "מוסיף משימה חדשה ללוח. בחר group_id מתוך הקבוצות בלוח לפי ההקשר (קבוצת יום לשיבוץ יומי, קבוצת בעלים למשימה כללית).",
    input_schema: {
      type: "object",
      properties: {
        title: { type: "string", description: "כותרת המשימה בעברית" },
        group_id: { type: "number", description: "מזהה הקבוצה מהלוח" },
        notes: { type: "string" },
        owner: { type: "string", enum: ["yogev"] },
        priority: { type: "string", enum: ["high", "medium", "low"] },
        due_date: { type: "string", description: "YYYY-MM-DD" },
      },
      required: ["title", "group_id"],
    },
  },
  {
    name: "remember",
    description:
      "שומר עובדה בזיכרון הקבוע של המותג (לכל השיחות, לתמיד). השתמש כשיוגב מבקש לזכור משהו או מדווחים עדכון עסקי חשוב: תאריכים שהשתנו, החלטות, ספקים, אירועים ('הבגדים הגיעו', 'ההשקה נדחתה ל...'). נסח את העובדה קצר וברור.",
    input_schema: {
      type: "object",
      properties: {
        fact: { type: "string", description: "העובדה לשמירה, משפט אחד או שניים" },
      },
      required: ["fact"],
    },
  },
  {
    name: "update_followers",
    description:
      "מעדכן את מספר העוקבים הנוכחי של @segula.club במעקב היעדים (היעד בטאב התוכנית). השתמש בכל פעם שמדווחים לך מספר עוקבים עדכני.",
    input_schema: {
      type: "object",
      properties: {
        current: { type: "number", description: "מספר העוקבים הנוכחי" },
      },
      required: ["current"],
    },
  },
  {
    name: "update_task",
    description:
      "מעדכן משימה קיימת לפי id מהלוח: סטטוס (not_started/working/stuck/done/archived), כותרת, הערות, אחראי, עדיפות, תאריך יעד, או העברה לקבוצה אחרת.",
    input_schema: {
      type: "object",
      properties: {
        id: { type: "number", description: "מזהה המשימה מהלוח" },
        title: { type: "string" },
        notes: { type: "string" },
        status: {
          type: "string",
          enum: ["not_started", "working", "stuck", "done", "archived"],
        },
        owner: { type: "string", enum: ["yogev"] },
        priority: { type: "string", enum: ["high", "medium", "low"] },
        due_date: { type: "string", description: "YYYY-MM-DD, ריק למחיקת התאריך" },
        group_id: { type: "number" },
      },
      required: ["id"],
    },
  },
  {
    name: "log_gift",
    description:
      "רושם חלוקת מוצר למשפיען/חבר ביומן החלוקות (טאב 'חלוקות' בלוח) ומוריד אוטומטית מהמלאי. בחר item_id מתוך מלאי החלוקות המצורף לפי שם ומידה. אם אין פריט תואם במלאי — אל תנחש: אמור מה כן יש ושאל.",
    input_schema: {
      type: "object",
      properties: {
        item_id: { type: "number", description: "מזהה הפריט ממלאי החלוקות" },
        person: { type: "string", description: "שם מקבל המוצר" },
        handle: { type: "string", description: "יוזר אינסטגרם, בלי @, אם צוין" },
        kind: { type: "string", enum: ["influencer", "friend", "other"] },
        qty: { type: "number", description: "כמות, ברירת מחדל 1" },
        size: { type: "string", description: "המידה שנלקחה (S/M/L/XL...), אם צוינה" },
        location: {
          type: "string",
          enum: ["room", "car"],
          description: "מאיפה יצא: room=החדר, car=האוטו של יוגב. ברירת מחדל room",
        },
        note: { type: "string" },
        given_at: { type: "string", description: "YYYY-MM-DD, ברירת מחדל היום" },
      },
      required: ["item_id", "person"],
    },
  },
  {
    name: "log_sale",
    description:
      "רושם מכירה ידנית (מי קנה, כמה, ובאיזה מחיר ליחידה בש\"ח) ומוריד אוטומטית מהמלאי. לשימוש עד שהחנות בשופיפיי עולה. בחר item_id ממלאי החלוקות המצורף; אם לא צוין מחיר — שאל.",
    input_schema: {
      type: "object",
      properties: {
        item_id: { type: "number", description: "מזהה הפריט ממלאי החלוקות" },
        buyer: { type: "string", description: "שם הקונה" },
        qty: { type: "number", description: "כמות, ברירת מחדל 1" },
        size: { type: "string", description: "המידה שנמכרה (S/M/L/XL...), אם צוינה" },
        location: {
          type: "string",
          enum: ["room", "car"],
          description: "מאיפה יצא: room=החדר, car=האוטו של יוגב. ברירת מחדל room",
        },
        price: { type: "number", description: "מחיר ליחידה בש\"ח" },
        pay_method: {
          type: "string",
          enum: ["shopify", "hyp", "bit", "cash", "transfer"],
          description:
            "איך שילמו: shopify=דרך האתר, hyp=סולק Hyp (אשראי בפופ-אפ), bit=ביט, cash=מזומן, transfer=העברה בנקאית. מכירה ידנית היא בדרך כלל מחוץ לאתר — אם לא צוין, ברירת מחדל bit",
        },
        note: { type: "string" },
        sold_at: { type: "string", description: "YYYY-MM-DD, ברירת מחדל היום" },
      },
      required: ["item_id", "buyer", "price"],
    },
  },
  {
    name: "log_expense",
    description:
      "רושם הוצאה ביומן הכספים של הלוח (טאב 'כספים'). כשיוגב כותב שהוציא/שילם/קנה משהו לעסק — רשום כאן. בחר קטגוריה מתוך expense_tracker בהקשר; אם שום קטגוריה לא מתאימה — 'אחר'.",
    input_schema: {
      type: "object",
      properties: {
        amount: { type: "number", description: "הסכום בש\"ח (חיובי; החזר כספי = מספר שלילי)" },
        category: { type: "string", description: "קטגוריה מרשימת expense_tracker, למשל: ייצור, סמפלים, שיווק ממומן" },
        description: { type: "string", description: "על מה ההוצאה, בקצרה" },
        payer: {
          type: "string",
          enum: ["yogev", "business"],
          description: "מי שילם: יוגב מהכיס, או העסק. 'העסק שילם' → business",
        },
        date: { type: "string", description: "YYYY-MM-DD, ברירת מחדל היום" },
        paid_from: {
          type: "string",
          enum: ["bank", "bit", "cash"],
          description:
            "רק כש-payer=business: מאיפה יצא הכסף — bank (חשבון הבנק/שופיפיי/Hyp), bit, cash. אם לא נאמר, אל תנחש — שאל.",
        },
      },
      required: ["amount", "category"],
    },
  },
  {
    name: "log_settlement",
    description:
      "רושם זיכוי סליקה שנחת בחשבון הבנק ('נכנס לנו זיכוי מ-Hyp 1,430', 'שופיפיי העבירו 2,300'). הלוח מוריד את הסכום מהכסף שממתין אצל הספק, מוסיף אותו לקופת הבנק בנטו, ומחשב לבד את העמלה. לא לשימוש למכירה חדשה — שם log_sale.",
    input_schema: {
      type: "object",
      properties: {
        provider: {
          type: "string",
          enum: ["shopify", "hyp"],
          description: "מי העביר את הכסף",
        },
        net: { type: "number", description: "כמה נכנס בפועל לחשבון הבנק, בש\"ח" },
        gross: {
          type: "number",
          description:
            "רשות. על כמה מכירות בברוטו הזיכוי הזה. אם לא נאמר במפורש — אל תשלח: ברירת המחדל סוגרת את כל מה שפתוח אצל הספק, וזה המצב הרגיל.",
        },
        date: { type: "string", description: "YYYY-MM-DD, ברירת מחדל היום" },
        note: { type: "string", description: "הערה קצרה, אם יש" },
      },
      required: ["provider", "net"],
    },
  },
  {
    name: "attach_receipt",
    description:
      "מצרף קבלה שכבר נשלחה בצ'אט להוצאה שכבר רשומה ביומן ('תוסיף את התמונה להוצאה של החותמת'). לא ליצירת הוצאה חדשה — שם log_expense מצרף לבד את הקבלה האחרונה.",
    input_schema: {
      type: "object",
      properties: {
        expense_hint: {
          type: "string",
          description: "מילה מהתיאור או מהקטגוריה של ההוצאה, למשל 'חותמת' או 'אריזה ומיתוג'",
        },
        amount: { type: "number", description: "סכום ההוצאה, אם ידוע — עוזר לזהות במדויק" },
      },
      required: [],
    },
  },
  {
    name: "fix_expense",
    description:
      "מתקן או מוחק הוצאה שכבר רשומה ביומן. השתמש בזה כשיוגב אומר שמשהו שנרשם שגוי — במיוחד אחרי שקבלה נקראה אוטומטית ('לא, זה היה 350', 'זה לא ייצור אלא סמפלים', 'תמחק את ההוצאה הזאת'). את ה-expense_id קח מ-recent_expenses בנתונים; אם לא ברור על איזו הוצאה מדובר — שאל לפני. שלח רק את השדות שמשתנים.",
    input_schema: {
      type: "object",
      properties: {
        expense_id: { type: "number", description: "ה-id מ-recent_expenses" },
        amount: { type: "number", description: "סכום מתוקן בש\"ח" },
        category: { type: "string", description: "קטגוריה מתוקנת, מרשימת expense_tracker" },
        description: { type: "string", description: "תיאור מתוקן" },
        date: { type: "string", description: "YYYY-MM-DD" },
        payer: { type: "string", enum: ["yogev", "business"], description: "מי שילם: יוגב מהכיס, או העסק" },
        paid_from: { type: "string", enum: ["bank", "bit", "cash"], description: "רק כש-payer=business" },
        delete: { type: "boolean", description: "true = מחיקת ההוצאה. הקבלה שלה חוזרת לרשימת הממתינות" },
      },
      required: ["expense_id"],
    },
  },
  {
    name: "add_inventory",
    description:
      "מוסיף פריט למלאי החלוקות או מגדיל כמות של פריט קיים (אותו שם ומידה מתמזגים). למשל כשמגיע משלוח חדש או כשמקצים עוד יחידות לחלוקה.",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string", description: "שם הפריט, למשל: חולצת KEEP DREAMIN" },
        size: { type: "string", description: "מידה, ריק אם אין" },
        qty: { type: "number", description: "כמה יחידות להוסיף" },
      },
      required: ["name", "qty"],
    },
  },
  {
    name: "shopify_map",
    description:
      "מחבר/מרענן את הקישור בין פריטי המלאי לווריאנטים בחנות שופיפיי ומפעיל את הסנכרון היוצא (חלוקה/מכירה ידנית יורידו מלאי גם בחנות). הרץ כשמבקשים 'חבר את המלאי לשופיפיי' או אחרי שינוי מוצרים בחנות. דווח מה הותאם ומה לא.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "set_revenue_goal",
    description:
      "קובע או מעדכן את יעד ההכנסות של הדרופ בש\"ח, עם דדליין אופציונלי ('היעד שלנו 40,000 עד 31.8'). מהרגע שנקבע — מעקב היעדים והסיכומים מציגים התקדמות וקצב נדרש ליום.",
    input_schema: {
      type: "object",
      properties: {
        target_nis: { type: "number", description: "יעד ההכנסות בש\"ח" },
        deadline: { type: "string", description: "YYYY-MM-DD, אופציונלי" },
      },
      required: ["target_nis"],
    },
  },
  {
    name: "update_ship_status",
    description:
      "מעדכן סטטוס משלוח של הזמנה אחת (קונה + מספר הזמנה), לא של כל השורות של הקונה: recorded=נרשם, packed=אריזה מוכנה, shipped=משלוח יצא, delivered=התקבל. " +
      "'נשלח' ו'התקבל' דורשים ראיה: מספר הזמנה (ref, כמו #1112 מרשימת open_orders) או evidence (מספר מעקב, שם השליח, 'מסרתי ביד לדנה'). בלי אחד מהם הכלי מסרב, ואז שאל את יוגב מה הראיה. " +
      "כשלקונה כמה הזמנות פתוחות ולא צוין ref, הכלי מחזיר ambiguous עם רשימת ההזמנות: שאל איזו, אל תנחש.",
    input_schema: {
      type: "object",
      properties: {
        buyer: { type: "string", description: "שם הקונה כפי שמופיע ברשימת open_orders" },
        status: { type: "string", enum: ["recorded", "packed", "shipped", "delivered"] },
        ref: { type: "string", description: "מספר ההזמנה (#1112) מ-open_orders.refs. חובה כשלקונה יותר מהזמנה פתוחה אחת." },
        evidence: { type: "string", description: "ראיה שהמשלוח יצא / נמסר: מספר מעקב, שם השליח, או למי נמסר ביד. נשמר על ההזמנה." },
      },
      required: ["buyer", "status"],
    },
  },
  {
    name: "get_person_history",
    description:
      "מחזיר את כל ההיסטוריה של אדם — כל החלוקות והקניות שלו אי פעם (המצורף לשיחה מציג רק את האחרונים). השתמש כששואלים 'מה קיבלה/קנתה X'.",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string", description: "שם האדם (או חלק ממנו)" },
      },
      required: ["name"],
    },
  },
  {
    name: "shop_stats",
    description:
      "מספרי החנות בשופיפיי בזמן אמת: הזמנות והכנסות של היום ושל 7 הימים האחרונים + הפריט הנמכר. השתמש כששואלים על החנות/האתר/הזמנות אונליין.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "export_seeding_csv",
    description:
      "שולח לצ'אט קובץ CSV (נפתח באקסל) עם כל יומן החלוקות, המכירות והמלאי. השתמש כשמבקשים 'אקסל חלוקות' או ייצוא.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "add_reminder",
    description:
      "קובע תזכורת אישית מתוזמנת ('תזכיר לי מחר ב-10 להתקשר לשליח'). חשב את התאריך והשעה מההקשר של היום. ההודעה תישלח לצ'אט הזה בזמן שנקבע.",
    input_schema: {
      type: "object",
      properties: {
        when: {
          type: "string",
          description: "מתי להזכיר, שעון ישראל, בפורמט YYYY-MM-DD HH:MM",
        },
        text: { type: "string", description: "נוסח התזכורת" },
      },
      required: ["when", "text"],
    },
  },
  {
    name: "transfer_stock",
    description:
      "מעביר מלאי בין מיקומים ('העברתי 10 חולצות M מהחדר לאוטו'). בחר item_id מהמלאי המצורף. מיקומים: room=חדר, car=אוטו של יוגב.",
    input_schema: {
      type: "object",
      properties: {
        item_id: { type: "number", description: "מזהה הפריט" },
        from: { type: "string", enum: ["room", "car"] },
        to: { type: "string", enum: ["room", "car"] },
        size: { type: "string", description: "מידה (XS/S/M/L/XL/XXL) או ריק לבלי-מידה" },
        qty: { type: "number", description: "כמה יחידות" },
      },
      required: ["item_id", "from", "to", "qty"],
    },
  },
  {
    name: "team_fact",
    description:
      "הזיכרון הקבוע של עובדי הצוות. list = מציג את העובדות של עובד (עם מזהים). add = שומר עובדה חדשה ('מיכאלה, אני לא מצטלם מדבר למצלמה'). fix = מתקן עובדה קיימת לפי id (הישנה מבוטלת, אין שתי גרסאות). forget = מבטל עובדה לפי id. bruno=הזיכרון שלך עצמך (מה ששמרת עם remember), creative=קריאייטיב, growth=צמיחה, partners=שותפויות, ops=חנות ומלאי, money=כספים. לפני fix או forget בלי id ידוע, קרא ל-list.",
    input_schema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["list", "add", "fix", "forget"] },
        worker: { type: "string", enum: ["bruno", "creative", "growth", "partners", "ops", "money"] },
        id: { type: "number", description: "מזהה העובדה (ל-fix ול-forget)" },
        text: { type: "string", description: "נוסח העובדה (ל-add ול-fix)" },
      },
      required: ["action"],
    },
  },
  {
    name: "partner_update",
    description:
      "עדכון בשפה חופשית על משפיען או שותף מרשימת המשפיענים ('דניאל ענה, רוצה חולצה במידה L ויכול לצלם בחמישי'). מוצא את האדם לפי שם או ידית; אם יש כמה התאמות או אף אחת, מחזיר את האפשרויות ואתה שואל את יוגב לפני שמירה. שלבים: candidate מועמד, to_contact אושר לפנייה, contacted נשלחה פנייה, talking ענה, agreed סוכמו תנאים, package_sent חבילה נשלחה, shoot_set צילום נקבע, received התקבל תוכן, done הושלם. חבילה וצילום הם שני דברים נפרדים: 'שלחתי לו חבילה' = package_sent בלבד. צילום נקבע רק כשיוגב אומר במפורש שהאדם אישר השתתפות בצילום, ואז shoot_confirmed=true עם shoot_when/shoot_where כפי שנאמרו (מה שלא נאמר נשאר ריק). 'יכול אולי בחמישי' אינו אישור: רק הערה. מיכאלה מקבלת אישור השתתפות רק על צילום שאושר. לא שולח הודעות לאף אחד.",
    input_schema: {
      type: "object",
      properties: {
        who: { type: "string", description: "שם או ידית כפי שיוגב אמר." },
        prospect_id: { type: "integer", description: "כשכבר בררת ויוגב בחר מתוך האפשרויות." },
        status: { type: "string", enum: ["candidate", "to_contact", "contacted", "talking", "agreed", "package_sent", "shoot_set", "received", "done", "rejected"], description: "רק אם מהעדכון ברור שהשלב השתנה. shoot_set רק יחד עם shoot_confirmed=true. rejected = ארכיון: רק כשיוגב אומר במפורש לארכב, לפסול או להוריד מהרשימה את האדם הזה בשמו; נרשם ביומן הכרטיס 'לפי הוראה של יוגב בצ'אט'. 'תני סקירה' או 'מה המצב' אינם הוראת ארכוב." },
        shoot_confirmed: { type: "boolean", description: "true רק כשיוגב אמר במפורש שהאדם אישר שהוא מגיע לצילום." },
        shoot_when: { type: "string", description: "מתי הצילום, במילים של יוגב. ריק אם לא נאמר." },
        shoot_where: { type: "string", description: "איפה הצילום, במילים של יוגב. ריק אם לא נאמר." },
        note: { type: "string", description: "מה יוגב אמר, במילים שלו, נכנס ליומן." },
        size: { type: "string" },
        next_step: { type: "string" },
        followup_date: { type: "string", description: "YYYY-MM-DD" },
      },
      required: ["note"],
    },
  },
  {
    name: "delegate",
    description:
      "אתה המנכ\"ל: שולח משימה לאחד מעובדי הצוות שלך ומקבל ממנו דוח. העובד רואה את הנתונים החיים של התחום שלו ויכול לפתוח הכרעות ליוגב. מחקר רשת (מתחרים, מודעות, טרנדים, ירידים) רץ רק אם research=true. השתמש בזה בכל בקשה שדורשת עומק בתחום: ads=ממומן, content=תוכן ורילז, design=עיצוב, קונספטים ורפרנסים לדרופים, email=לקוחות ומייל, collab=משפיענים, bizdev=חנויות וירידים, shop=האתר וההזמנות, stock=מלאי ותכנון דרופ, finance=כספים. נסח את המשימה במדויק, עם כל ההקשר שיוגב נתן. בלי מחקר: עד דקה. עם מחקר: 2-5 דקות.",
    input_schema: {
      type: "object",
      properties: {
        agent: { type: "string", enum: ["ads", "content", "design", "email", "collab", "bizdev", "shop", "stock", "finance"] },
        task: { type: "string", description: "המשימה לעובד, בעברית, מנוסחת כבריף מלא" },
        research: { type: "boolean", description: "true רק כשהמשימה דורשת מידע מחוץ ללוח (מתחרים, טרנדים, ירידים, מחירי שוק). מוסיף 2-5 דקות. לשאלות על הנתונים של SEGULA עצמה: false." },
      },
      required: ["agent", "task"],
    },
  },
  {
    name: "plan_item",
    description:
      "תוכנית חצי השנה (הטאב 🎯 תוכנית, הבלוק 'תוכנית חצי השנה' בנתונים, כל אבן דרך עם #מזהה). רק כשיוגב ביקש במפורש: action=add מוסיף אבן דרך לתחום ולחודש (area = מפתח התחום מהסוגריים המרובעים בבלוק התוכנית; month = YYYY-MM), action=status משנה מצב (planned=מתוכנן, doing=בהכנה, done=בוצע, late=לא בוצע; done רק כשיוגב אמר שזה בוצע), action=approve מאשר טיוטה. לא ממציא אבני דרך ולא מסמן בוצע על דעת עצמך.",
    input_schema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["add", "status", "approve"] },
        id: { type: "number", description: "מזהה אבן הדרך (status/approve)" },
        area: { type: "string", description: "מפתח התחום כמו שמופיע בסוגריים המרובעים בבלוק התוכנית (למשל [content])" },
        month: { type: "string", description: "YYYY-MM (add)" },
        text: { type: "string", description: "אבן הדרך במילים של יוגב (add)" },
        status: { type: "string", enum: ["planned", "doing", "done", "late"] },
      },
      required: ["action"],
    },
  },
  {
    name: "recipe",
    description:
      "הידיים שלך: מתחיל עבודה אמיתית שרצה ברקע לפי מתכון קבוע (הרשימה והמזהים בבלוק 'הידיים שלך' בנתונים). action=start מתחיל (recipe + params), action=status מחזיר מה רץ ומה מוכן, action=cancel מבטל עבודה שעוד לא בוצעה (job_id). אחרי start ענה במשפט אחד שהתחלת; אל תגיד שזה מוכן, המערכת מודיעה בעצמה אחרי בדיקה.",
    input_schema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["start", "status", "cancel"] },
        recipe: { type: "string", enum: RECIPES.map((r) => r.id) },
        params: { type: "object", description: "הפרטים שיוגב נתן, לפי המפתחות של המתכון. רק מה שנאמר, בלי להמציא." },
        job_id: { type: "number" },
      },
      required: ["action"],
    },
  },
  {
    name: "work",
    description:
      "עבודה משותפת: רשומה אחת לכל נושא שהצוות עובד עליו (למשל bundle_shirt_cap), עם בעלים, סוג (work_kind: offer=הצעה עם מחיר וקהל, campaign=קמפיין עם קהל, content, ops, other), מחיר ומקורו, קהל שנטען מול מאומת, חסמים, צעד הבא ומצב. action=list מחזיר את כל העבודות (קרא לזה לפני שאתה עונה על נושא שהצוות אולי כבר מטפל בו). action=open פותח עבודה חדשה (topic באנגלית + title, ואם ידוע owner = מפתח עובד, work_kind, price רק עם price_source, next_step). action=update מעדכן לפי id (work_kind, price רק עם price_source, next_step, outcome, blockers_add). action=review = 'בדקתי את התוכנית' (קריאה של התוכנית; לא מזיז מצב). action=state מעביר מצב בסדר בלבד: prepared→approved→done→verified. approved: רק בלי חסמים. done: חובה ראיה על פעולה: kind+ref_id של פריט מקושר שהושלם (עבודה ברקע done, הכרעה שבוצעה, משימה done) או manual_text = דיווח ידני (נשמר מסומן כידני). verified: חובה ראיה על התוצאה: kind+ref_id של פריט מקושר שהושלם או url, ועוד note; note לבד נדחה. השרת מחזיר את הסיבה כשנדחה: תמסור אותה ליוגב, אל תנסה לעקוף. action=link מקשר פריט קיים (kind: draft|decision|job|task|idea, ref_id).",
    input_schema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["list", "open", "update", "review", "state", "link"] },
        id: { type: "number" },
        topic: { type: "string", description: "מילה-שתיים באנגלית עם קו תחתון, למשל bundle_shirt_cap" },
        title: { type: "string" },
        owner: { type: "string", enum: ["creative", "growth", "partners", "ops", "money"] },
        work_kind: { type: "string", enum: ["offer", "campaign", "content", "ops", "other"], description: "סוג העבודה: offer דורש מחיר וקהל, campaign דורש קהל" },
        price: { type: "number" },
        price_source: { type: "string", description: "מאיפה המחיר: מחירון, החלטה של יוגב בשיחה, Shopify" },
        next_step: { type: "string" },
        outcome: { type: "string" },
        blockers_add: { type: "string" },
        state: { type: "string", enum: ["prepared", "approved", "done", "verified"] },
        note: { type: "string", description: "ל-verified: מה נבדק ומול מה (בנוסף לראיה, לא במקומה)" },
        kind: { type: "string", enum: ["draft", "decision", "job", "task", "idea"], description: "ל-link: סוג הפריט. ל-state done/verified: סוג הפריט המקושר שהושלם שמשמש ראיה" },
        ref_id: { type: "number", description: "מזהה הפריט (ל-link, או הראיה ל-state)" },
        url: { type: "string", description: "ל-state verified: קישור לראיה על התוצאה (למשל תצוגה של עבודה ברקע /p/..., או עמוד באתר)" },
        manual_text: { type: "string", description: "ל-state done בלי פריט מקושר שהושלם: דיווח ידני של מה בוצע ומי אמר" },
      },
      required: ["action"],
    },
  },
  {
    name: "show_screen",
    description:
      "מצב ברונו (שיחה קולית על מסך מלא): מעביר את המסך של יוגב לטאב בלוח. השתמש כשיוגב אומר 'תראה לי' / 'תפתח' משהו. yogev=משימות, seeding=חלוקות ומכירות פופאפ, finance=כספים, bizdev=הפצה וחנויות, ads=ממומן, collab=משפיענים, studio=סטודיו, bruno=הצוות וההכרעות (שם גם המלאי, אצל העובד של התפעול). אחרי הקריאה ענה במשפט אחד קצר ('פותח את הכספים').",
    input_schema: {
      type: "object",
      properties: {
        tab: { type: "string", enum: ["yogev", "seeding", "finance", "bizdev", "ads", "collab", "studio", "bruno"] },
      },
      required: ["tab"],
    },
  },
  {
    name: "send_to_phone",
    description:
      "שולח התראה לטלפון של יוגב (Web Push), עם כותרת, שורת תוכן ולינק לטאב בלוח. השתמש כשיוגב מבקש 'שלח לי לטלפון' או 'תזכיר לי בטלפון עכשיו'. לתזכורת בעתיד השתמש ב-add_reminder.",
    input_schema: {
      type: "object",
      properties: {
        title: { type: "string", description: "עד 60 תווים" },
        body: { type: "string", description: "עד 200 תווים, המידע עצמו (מספרים, שמות)" },
        tab: { type: "string", enum: ["yogev", "seeding", "finance", "bizdev", "ads", "collab", "studio", "bruno"] },
      },
      required: ["title", "body"],
    },
  },
] as const;

/** מה ברונו עשה בתור אחד, בשביל המסך של מצב ברונו. הכל נקבע מתוצאות הכלים עצמם
 *  (ok מהשרת), לא מהניסוח של המודל: done = בוצע ונרשם, failed = נכשל, pending = הוכן
 *  ומחכה לאישור (לא בוצע), read = קריאה בלבד. runs = עובדים שהופעלו, עם התוצאה
 *  (delegate רץ עד הסוף בתוך התור, אז כשהתשובה מגיעה התוצאה ידועה). */
export type LiveAction = { tool: string; status: "done" | "failed" | "pending" | "read"; summary: string; id?: number; bg?: boolean };
export type LiveRun = { agent: string; task: string; ok: boolean; error?: string; decisions?: number; report?: string };
export type LiveCard = { found?: string; source?: string; as_of?: string; uncertain?: string; details?: string; next?: { label: string; who: "bruno" | "yogev"; tab?: string } };
export type LiveTrace = { tools: string[]; delegated: string[]; show: string; pushed: boolean; actions: LiveAction[]; runs: LiveRun[]; card: LiveCard | null };
/** צעד חי במצב ברונו: מה ברונו עושה ברגע זה, כדי שהמסך יראה את העבודה קורית ולא רק את התוצאה. */
export type LiveStep = { id: number; label: string; state: "running" | "done" | "failed" | "pending"; worker?: string };
const TAB_STEP_HE: Record<string, string> = { yogev: "משימות", seeding: "חלוקות", finance: "כספים", bizdev: "הפצה", ads: "ממומן", collab: "משפיענים", studio: "סטודיו", bruno: "הצוות" };
const short = (v: unknown, n: number) => (typeof v === "string" ? (v.trim().length > n ? `${v.trim().slice(0, n)}…` : v.trim()) : "");
/** תיאור קצר בעברית של מה שהכלי עושה, לחלונית "ברונו עובד". */
export function stepLabel(name: string, input: Record<string, unknown>, names: Record<string, string> = {}): string {
  const worker = typeof input.agent === "string" ? (names[workerOfHat(input.agent)?.key ?? ""] ?? input.agent) : "";
  switch (name) {
    case "delegate":
      return `שולח ל${worker}: ${short(input.task, 46)}`;
    case "show_screen":
      return `פותח את ${TAB_STEP_HE[String(input.tab)] ?? "המסך"}`;
    case "send_to_phone":
      return "שולח לטלפון";
    case "live_card":
      return "מכין כרטיס תוצאה";
    case "shop_stats":
      return "בודק את החנות ב-Shopify";
    case "get_person_history":
      return `מחפש את ההיסטוריה של ${short(input.name ?? input.person ?? input.query, 24) || "הלקוח"}`;
    case "add_task":
      return `פותח משימה: ${short(input.title, 40)}`;
    case "update_task":
      return "מעדכן משימה";
    case "add_reminder":
      return `קובע תזכורת: ${short(input.text ?? input.title, 36)}`;
    case "remember":
      return "שומר בזיכרון";
    case "team_fact":
      return "מעדכן עובדה של הצוות";
    case "export_seeding_csv":
      return "מכין קובץ של החלוקות";
    case "recipe":
      return input.action === "start" ? `מתחיל עבודה ברקע: ${RECIPES.find((r) => r.id === input.recipe)?.name ?? "מתכון"}` : input.action === "cancel" ? "מבטל עבודה" : "בודק מה רץ ברקע";
    case "work":
      return input.action === "list" ? "בודק מה הצוות כבר מכין" : input.action === "open" ? `פותח עבודה משותפת: ${short(input.title, 40)}` : input.action === "state" ? "מעדכן מצב של עבודה" : input.action === "review" ? "מסמן שהתוכנית נבדקה" : "מעדכן עבודה משותפת";
    default:
      return TOOL_HE[name] ? `מכין: ${TOOL_HE[name]}` : name;
  }
}

export const newLiveTrace = (): LiveTrace => ({ tools: [], delegated: [], show: "", pushed: false, actions: [], runs: [], card: null });
const SCREEN_TABS = new Set(["yogev", "seeding", "finance", "bizdev", "ads", "collab", "studio", "bruno"]);
/** כלים שרק קוראים או מציגים: לא נכנסים ל"מה בוצע" בסיכום. */
const READ_TOOLS = new Set(["get_person_history", "shop_stats", "export_seeding_csv", "show_screen", "live_card"]);

/** כרטיס התוצאה של מצב ברונו. רק במצב ברונו (live), ולכן לא ברשימת הכלים הקבועה. */
const LIVE_CARD_TOOL = {
  name: "live_card",
  description:
    "מצב ברונו בלבד: כרטיס קצר שמוצג מתחת לתשובה המדוברת. קרא לו רק כשהתשובה נשענת על נתונים או מובילה לצעד הבא; לא לשיחה פשוטה, לא לאישור ולא ל'פותח את X'. כל שדה אופציונלי, ומה שלא ידוע נשאר ריק (לא ממציאים מקור או תאריך).",
  input_schema: {
    type: "object",
    properties: {
      found: { type: "string", description: "מה נמצא, עד 160 תווים" },
      source: { type: "string", description: "מאיזה נתון בלוח (למשל 'יומן המכירות', 'משימות פתוחות', 'שופיפיי')" },
      as_of: { type: "string", description: "מועד העדכון של הנתון, רק אם הוא מופיע בנתונים" },
      uncertain: { type: "string", description: "מה חסר או לא ודאי, עד 160 תווים" },
      details: { type: "string", description: "כשיוגב מבקש תוכנית, הסבר או פירוט: הפירוט המלא, עד 8 שורות קצרות (כל שורה צעד אחד, מופרדות בירידת שורה). מוצג על המסך בלבד, לא מוקרא." },
      next: {
        type: "object",
        properties: {
          label: { type: "string", description: "הצעד הבא, עד 60 תווים" },
          who: { type: "string", enum: ["bruno", "yogev"], description: "bruno = אתה יכול לבצע בכלי שלך. yogev = רק יוגב יכול (שיחה, צילום, תשלום, החלטה)" },
          tab: { type: "string", enum: ["yogev", "seeding", "finance", "bizdev", "ads", "collab", "studio", "bruno"] },
        },
        required: ["label", "who"],
      },
    },
  },
} as const;

const clip = (v: unknown, n: number): string | undefined => (typeof v === "string" && v.trim() ? v.trim().slice(0, n) : undefined);
function readCard(input: Record<string, unknown>): LiveCard {
  const nx = input.next && typeof input.next === "object" ? (input.next as Record<string, unknown>) : null;
  const label = clip(nx?.label, 60);
  const tab = typeof nx?.tab === "string" && SCREEN_TABS.has(nx.tab) ? nx.tab : undefined;
  return {
    found: clip(input.found, 160),
    source: clip(input.source, 60),
    as_of: clip(input.as_of, 40),
    uncertain: clip(input.uncertain, 160),
    details: typeof input.details === "string" && input.details.trim() ? input.details.trim().split("\n").map((l) => l.trim()).filter(Boolean).slice(0, 8).map((l) => l.slice(0, 160)).join("\n") : undefined,
    next: label ? { label, who: nx?.who === "bruno" ? "bruno" : "yogev", tab } : undefined,
  };
}

/** רושם את התוצאה האמיתית של קריאת כלי אחת ב-trace. */
function traceTool(trace: LiveTrace, name: string, input: Record<string, unknown>, result: string) {
  let parsed: Record<string, unknown> = {};
  try {
    parsed = JSON.parse(result) as Record<string, unknown>;
  } catch {
    parsed = {};
  }
  if (name === "live_card") {
    trace.card = readCard(input);
    return;
  }
  if (name === "delegate") {
    const agent = typeof input.agent === "string" ? input.agent : "";
    trace.runs.push({
      agent,
      task: clip(input.task, 200) ?? "",
      ok: parsed.ok === true,
      error: parsed.ok === true ? undefined : clip(parsed.error, 160) ?? "העובד לא החזיר דוח",
      decisions: typeof parsed.decisions_opened === "number" ? parsed.decisions_opened : undefined,
      report: clip(parsed.report, 400),
    });
    return;
  }
  const summary = summarizeToolCall(name, input);
  if (name === "recipe" && parsed.started === true) {
    trace.actions.push({ tool: name, status: "pending", summary: `רץ ברקע: ${summary}`, bg: true });
    return;
  }
  if (name === "recipe" && input.action === "status") {
    trace.actions.push({ tool: name, status: "read", summary });
    return;
  }
  if (parsed.pending_confirmation === true) {
    trace.actions.push({ tool: name, status: "pending", summary, id: typeof parsed.confirmation_id === "number" ? parsed.confirmation_id : undefined });
    return;
  }
  if (READ_TOOLS.has(name)) {
    trace.actions.push({ tool: name, status: "read", summary });
    return;
  }
  trace.actions.push({ tool: name, status: parsed.ok === true ? "done" : "failed", summary });
}

type ToolUse = { type: "tool_use"; id: string; name: string; input: Record<string, unknown> };
type ContentBlock = {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
};

const csvCell = (v: string | number): string => `"${String(v).replace(/"/g, '""')}"`;

async function runTool(
  env: AssistantEnv,
  db: D1Database,
  chatId: number,
  name: string,
  input: Record<string, unknown>,
): Promise<string> {
  try {
    if (name === "team_fact") {
      const action = typeof input.action === "string" ? input.action : "";
      const worker = typeof input.worker === "string" ? input.worker : "";
      const text = typeof input.text === "string" ? input.text.trim() : "";
      const factId = typeof input.id === "number" ? input.id : 0;
      const source = `יוגב בשיחה, ${ilTodayISO()}`;
      if (action === "list") return JSON.stringify({ ok: true, facts: (await listFacts(db, worker || undefined)).map((f) => ({ id: f.id, worker: f.worker, text: f.text, since: f.created_at.slice(0, 10), source: f.source })) });
      if (action === "add") {
        if (!worker || !text) return JSON.stringify({ ok: false, error: "missing worker/text" });
        return JSON.stringify({ ok: true, id: await addMemory(db, worker, "fact", text, source) });
      }
      if (action === "fix") {
        if (!factId || !text) return JSON.stringify({ ok: false, error: "missing id/text" });
        return JSON.stringify(await reviseFact(db, factId, text, source));
      }
      if (action === "forget") {
        if (!factId) return JSON.stringify({ ok: false, error: "missing id" });
        return JSON.stringify(await revokeFact(db, factId));
      }
      return JSON.stringify({ ok: false, error: "unknown action" });
    }
    if (name === "partner_update") {
      const note = typeof input.note === "string" ? input.note.trim() : "";
      let id = typeof input.prospect_id === "number" ? input.prospect_id : 0;
      if (!id) {
        const matches = await resolveProspect(db, typeof input.who === "string" ? input.who : "");
        if (matches.length !== 1) return JSON.stringify({ ok: false, ambiguous: true, matches: matches.map((m) => ({ id: m.id, name: m.name, instagram: m.instagram, status: PARTNER_STATUS_HE[m.status] ?? m.status })), hint: matches.length ? "כמה התאמות: שאל את יוגב למי הכוונה, ואז שלח prospect_id" : "לא נמצא ברשימה: שאל את יוגב אם להוסיף בטאב המשפיענים" });
        id = matches[0].id;
      }
      // ארכיון מהצ'אט: רק כשיוגב נקב בשם (הגענו לכאן עם התאמה אחת או עם prospect_id שהוא בחר).
      // נכתב דרך moveProspects, כדי שהיומן, ה-verdict ואימות הקריאה החוזרת יהיו כמו בכל ארכוב.
      if (input.status === "rejected") {
        const w = await moveProspects(db, [id], "rejected", note, "ברונו לפי הוראה של יוגב בצ'אט");
        return JSON.stringify(w.ok.length ? { ok: true, id, archived: true } : { ok: false, error: w.failed.join(", ") || "לא אורכב" });
      }
      const res = await updateProspect(db, id, { status: typeof input.status === "string" ? input.status : undefined, note, size: typeof input.size === "string" ? input.size : undefined, nextStep: typeof input.next_step === "string" ? input.next_step : undefined, followupDate: typeof input.followup_date === "string" ? input.followup_date : undefined, shoot: input.shoot_confirmed === true ? { confirmed: true, when: typeof input.shoot_when === "string" ? input.shoot_when : "", where: typeof input.shoot_where === "string" ? input.shoot_where : "" } : undefined });
      return JSON.stringify(res.ok ? { ok: true, id, handoff_to_michaela: res.handoff ?? null } : { ok: false, error: res.error ?? "not found" });
    }
    if (name === "live_card") return JSON.stringify({ ok: true });
    if (name === "show_screen") {
      const tab = typeof input.tab === "string" ? input.tab : "";
      return JSON.stringify(SCREEN_TABS.has(tab) ? { ok: true, note: "המסך מתחלף אצל יוגב." } : { ok: false, error: "unknown tab" });
    }
    if (name === "send_to_phone") {
      const title = typeof input.title === "string" ? input.title.trim() : "";
      const body = typeof input.body === "string" ? input.body.trim() : "";
      const tab = typeof input.tab === "string" && SCREEN_TABS.has(input.tab) ? input.tab : "bruno";
      if (!title) return JSON.stringify({ ok: false, error: "missing title" });
      const out = await pushNotify(env, title, body, tab === "yogev" ? "/" : `/?tab=${tab}`);
      return JSON.stringify(
        out.sent > 0
          ? { ok: true, sent: out.sent }
          : { ok: false, error: "אין מכשיר רשום להתראות. יוגב צריך להפעיל התראות בטאב ברונו (בטלפון)." },
      );
    }
    if (name === "recipe") {
      const action = typeof input.action === "string" ? input.action : "";
      if (action === "status") return JSON.stringify({ ok: true, jobs: await jobStatusForBruno(db) });
      if (action === "cancel") {
        const jobId = typeof input.job_id === "number" ? input.job_id : 0;
        return JSON.stringify(jobId && (await cancelJob(db, jobId)).ok ? { ok: true } : { ok: false, error: "אי אפשר לבטל: העבודה לא נמצאה או שכבר רצה או הסתיימה" });
      }
      if (action !== "start") return JSON.stringify({ ok: false, error: "unknown action" });
      const raw = input.params && typeof input.params === "object" ? (input.params as Record<string, unknown>) : {};
      const out = await startRecipe(env, db, typeof input.recipe === "string" ? input.recipe : "", raw, chatId === BOARD_CHAT_ID ? "board" : String(chatId));
      if (!out.ok) return JSON.stringify("ask" in out ? { ok: false, ask: out.ask, note: "שאל את יוגב רק את זה, ואז התחל שוב עם התשובה." } : "not_connected" in out ? { ok: false, not_connected: out.not_connected } : { ok: false, error: out.error });
      return JSON.stringify({
        ok: true,
        started: true,
        job_id: out.jobId,
        existing: out.existing,
        note: out.approval
          ? "רץ ברקע. כשההכנה תסתיים זה יחכה לאישור של יוגב ב'מחכה לך' לפני שמשהו נכתב החוצה. אל תגיד שזה בוצע."
          : "רץ ברקע. המערכת תודיע בשרשור ובטלפון כשזה מוכן ונבדק. אל תגיד שזה מוכן.",
      });
    }
    if (name === "work") {
      // עבודה משותפת: רשומה אחת לנושא. list = קריאה בלבד; השאר כותבים ומחזירים ok רק כשנשמר.
      const action = typeof input.action === "string" ? input.action : "";
      const workId = typeof input.id === "number" ? input.id : 0;
      const s = (k: string) => (typeof input[k] === "string" ? (input[k] as string).trim() : "");
      if (action === "list") return JSON.stringify({ ok: true, work: await workSummaryForBruno(db, await workerNames(db)) });
      if (action === "open") {
        const out = await upsertWork(db, { topic: s("topic"), title: s("title"), owner: s("owner"), kind: s("work_kind"), price: typeof input.price === "number" ? input.price : undefined, price_source: s("price_source"), next_step: s("next_step"), by: "bruno" });
        return JSON.stringify(out.ok ? { ok: true, id: out.id, created: out.created, note: out.created ? "נפתחה עבודה משותפת." : "כבר הייתה עבודה על הנושא, עודכנה." } : { ok: false, error: out.error });
      }
      if (!workId) return JSON.stringify({ ok: false, error: "חסר id של העבודה (קח מ-action=list)" });
      if (action === "update") {
        const patch: Record<string, unknown> = {};
        for (const k of ["next_step", "outcome", "blockers_add", "price_source", "title"]) if (s(k)) patch[k] = s(k);
        if (s("work_kind")) patch.kind = s("work_kind");
        if (typeof input.price === "number") patch.price = input.price;
        return JSON.stringify(await updateWork(db, workId, patch));
      }
      // "בדקתי את התוכנית": נפרד מהמצבים. ברונו יכול לסמן שקרא, לא שביצע.
      if (action === "review") return JSON.stringify(await reviewPlan(db, workId, "bruno"));
      // מעבר מצב: אותם כללים כמו הכפתור בלוח (חסמים, ראיה ל-done, ראיה + מי בדק ל-verified). הסיבה חוזרת למודל.
      if (action === "state") return JSON.stringify(await setWorkState(db, workId, s("state"), "bruno", { note: s("note"), kind: s("kind"), ref_id: typeof input.ref_id === "number" ? input.ref_id : undefined, url: s("url"), manual_text: s("manual_text") }));
      if (action === "link") return JSON.stringify(await linkWork(db, workId, s("kind") as LinkKind, typeof input.ref_id === "number" ? input.ref_id : 0));
      return JSON.stringify({ ok: false, error: "unknown action" });
    }
    if (name === "plan_item") {
      const action = typeof input.action === "string" ? input.action : "";
      const id = typeof input.id === "number" ? Math.trunc(input.id) : 0;
      if (action === "add") return JSON.stringify(await addPlanItem(db, { area: String(input.area ?? ""), month: String(input.month ?? ""), text: String(input.text ?? ""), status: typeof input.status === "string" ? input.status : "planned", source: "bruno" }));
      if (action === "status" && id) return JSON.stringify(await updatePlanItem(db, id, { status: String(input.status ?? "") }));
      if (action === "approve" && id) return JSON.stringify(await updatePlanItem(db, id, { status: "planned" }));
      return JSON.stringify({ ok: false, error: "missing action/id" });
    }
    if (name === "delegate") {
      const agent = typeof input.agent === "string" ? input.agent : "";
      const task = typeof input.task === "string" ? input.task.trim() : "";
      if (!agent || !task) return JSON.stringify({ ok: false, error: "missing agent/task" });
      const result = await runAgent(env, agent, { trigger: "command", command: task, research: input.research === true });
      if (!result.ok) return JSON.stringify({ ok: false, error: result.error });
      return JSON.stringify({
        ok: true,
        report: result.report,
        decisions_opened: result.decisions,
        note: result.decisions ? "ההכרעות מחכות ליוגב בראש הטאב, עם כפתורים. ספר לו שהן שם." : "",
      });
    }
    if (name === "add_task") {
      const title = typeof input.title === "string" ? input.title.trim() : "";
      const groupId = typeof input.group_id === "number" ? input.group_id : 0;
      if (!title || !groupId) return JSON.stringify({ ok: false, error: "missing title/group_id" });
      const task = await addTask(groupId, title);
      const patch: Record<string, unknown> = {};
      for (const k of ["notes", "owner", "priority", "due_date"] as const) {
        if (typeof input[k] === "string" && input[k]) patch[k] = input[k];
      }
      if (Object.keys(patch).length > 0) await updateTask(task.id, patch);
      return JSON.stringify({ ok: true, task_id: task.id });
    }
    if (name === "remember") {
      const fact = typeof input.fact === "string" ? input.fact.trim() : "";
      if (!fact) return JSON.stringify({ ok: false, error: "missing fact" });
      // שורה בטבלת הזיכרון (worker='bruno'), לא מחרוזת אחת שנחתכת: בגרסה הקודמת,
      // כשהזיכרון עבר 6000 תווים נמחקו דווקא העובדות הכי ישנות.
      const id = await addMemory(db, "bruno", "fact", fact, `שיחה, ${ilTodayISO()}`);
      return JSON.stringify({ ok: true, fact_id: id });
    }
    if (name === "update_followers") {
      const current = typeof input.current === "number" ? Math.round(input.current) : -1;
      if (current < 0) return JSON.stringify({ ok: false, error: "missing current" });
      let target = 5000;
      try {
        const existing = (await getSetting(db, "goal_followers")) ?? "";
        const parsed = JSON.parse(existing) as { target?: number };
        if (typeof parsed.target === "number") target = parsed.target;
      } catch {
        // keep default target
      }
      await putSetting(
        db,
        "goal_followers",
        JSON.stringify({ target, current, updated: ilTodayISO() }),
      );
      return JSON.stringify({ ok: true, current, target });
    }
    if (name === "update_task") {
      const id = typeof input.id === "number" ? input.id : 0;
      if (!id) return JSON.stringify({ ok: false, error: "missing id" });
      const patch: Record<string, unknown> = {};
      for (const k of ["title", "notes", "status", "owner", "priority", "due_date"] as const) {
        if (typeof input[k] === "string") patch[k] = input[k];
      }
      if (typeof input.group_id === "number") patch.group_id = input.group_id;
      const changed = await updateTask(id, patch as Parameters<typeof updateTask>[1]);
      return JSON.stringify({ ok: changed });
    }
    if (name === "log_gift") {
      const itemId = typeof input.item_id === "number" ? input.item_id : 0;
      const person = typeof input.person === "string" ? input.person.trim() : "";
      if (!itemId || !person) {
        return JSON.stringify({ ok: false, error: "missing item_id/person" });
      }
      const result = await addGift({
        itemId,
        person,
        handle: typeof input.handle === "string" ? input.handle.trim().replace(/^@/, "") : "",
        kind:
          typeof input.kind === "string" && GIFT_KINDS.has(input.kind)
            ? input.kind
            : "influencer",
        qty: typeof input.qty === "number" && input.qty >= 1 ? Math.trunc(input.qty) : 1,
        size: typeof input.size === "string" ? input.size.trim().slice(0, 30) : "",
        location: normLocation(input.location),
        status: "given",
        note: typeof input.note === "string" ? input.note.trim() : "",
        givenAt:
          typeof input.given_at === "string" && input.given_at ? input.given_at : ilTodayISO(),
      });
      if (!result) return JSON.stringify({ ok: false, error: "item not found in inventory" });
      // Bruno runs inside the DO — drain the Shopify push queue directly.
      await drainShopifyPushQueue(env);
      return JSON.stringify({ ok: true, item: result.label, stock_left: result.stockLeft });
    }
    if (name === "log_sale") {
      const itemId = typeof input.item_id === "number" ? input.item_id : 0;
      const buyer = typeof input.buyer === "string" ? input.buyer.trim() : "";
      const price = typeof input.price === "number" && input.price >= 0 ? input.price : -1;
      if (!itemId || !buyer || price < 0) {
        return JSON.stringify({ ok: false, error: "missing item_id/buyer/price" });
      }
      const result = await addSale({
        itemId,
        buyer,
        qty: typeof input.qty === "number" && input.qty >= 1 ? Math.trunc(input.qty) : 1,
        size: typeof input.size === "string" ? input.size.trim().slice(0, 30) : "",
        location: normLocation(input.location),
        price,
        // Anything Bruno logs by hand came in outside the store, so Bit is the
        // sane default — the store's own orders sync themselves.
        payMethod:
          typeof input.pay_method === "string" && PAY_METHODS.has(input.pay_method)
            ? input.pay_method
            : "bit",
        note: typeof input.note === "string" ? input.note.trim() : "",
        soldAt:
          typeof input.sold_at === "string" && input.sold_at ? input.sold_at : ilTodayISO(),
      });
      if (!result) return JSON.stringify({ ok: false, error: "item not found in inventory" });
      await drainShopifyPushQueue(env);
      return JSON.stringify({ ok: true, item: result.label, stock_left: result.stockLeft });
    }
    if (name === "attach_receipt") {
      const waiting = await pendingReceipts(String(chatId));
      if (!waiting.length) {
        return JSON.stringify({
          ok: false,
          error: "no_pending_receipt",
          hint: "אין קבלה שממתינה לשיוך בצ'אט הזה — בקש מיוגב לשלוח את התמונה קודם",
        });
      }
      const hint = typeof input.expense_hint === "string" ? input.expense_hint.trim() : "";
      const amount = typeof input.amount === "number" && isFinite(input.amount) ? input.amount : null;
      // Newest match wins: a receipt almost always belongs to a fresh expense.
      const match = await db
        .prepare(
          `SELECT id, date, payer, category, description, amount FROM fin_expenses
           WHERE (? = '' OR description LIKE ? OR category LIKE ?)
             AND (? IS NULL OR amount = ?)
           ORDER BY date DESC, id DESC LIMIT 1`,
        )
        .bind(hint, `%${hint}%`, `%${hint}%`, amount, amount)
        .first<{ id: number; date: string; payer: string; category: string; description: string; amount: number }>();
      if (!match) {
        const recent = await db
          .prepare("SELECT id, date, category, description, amount FROM fin_expenses ORDER BY date DESC, id DESC LIMIT 5")
          .all<{ id: number; date: string; category: string; description: string; amount: number }>();
        return JSON.stringify({
          ok: false,
          error: "expense_not_found",
          recent_expenses: recent.results ?? [],
          hint: "לא מצאתי הוצאה שמתאימה — הצג את האחרונות ובקש מיוגב לבחור",
        });
      }
      const attached = await attachReceipt(waiting[0].id, match.id);
      return JSON.stringify({
        ok: attached,
        attached_to: { category: match.category, description: match.description, amount: match.amount },
        receipts_still_waiting: waiting.length - 1,
      });
    }
    if (name === "log_settlement") {
      const provider = typeof input.provider === "string" && IS_PROVIDER(input.provider) ? input.provider : null;
      const net = typeof input.net === "number" && isFinite(input.net) && input.net > 0 ? input.net : 0;
      if (!provider || !net) return JSON.stringify({ ok: false, error: "missing provider/net" });
      const date =
        typeof input.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(input.date) ? input.date : ilTodayISO();
      // Left out on purpose in the normal case — addSettlement then closes
      // everything still open at that provider.
      const gross = typeof input.gross === "number" && isFinite(input.gross) && input.gross > 0 ? input.gross : 0;
      const note = typeof input.note === "string" ? input.note.trim().slice(0, 200) : "";
      const doubt = typeof input["חשד לכפילות"] === "string" ? (input["חשד לכפילות"] as string) : "";
      const s = await addSettlement({ date, provider, net, gross, note, actor: "ברונו", reason: doubt ? `אושר בכפתור למרות חשד: ${doubt}` : "" });
      const fee = s.gross - s.net;
      return JSON.stringify({
        ok: true,
        provider,
        net_into_bank: Math.round(s.net),
        gross_closed: Math.round(s.gross),
        fee: Math.round(fee),
        fee_pct: s.gross > 0 ? Number(((fee / s.gross) * 100).toFixed(2)) : null,
        ...(s.note.includes("הפקדה חלקית")
          ? { partial_deposit: true, note: "הפקדה חלקית: נסגר רק הברוטו המשוער שלה, לפי אחוז העמלה המוגדר. היתרה נשארת ממתינה אצל הסולק. העמלה כאן משוערת, לא נמדדה." }
          : {}),
      });
    }
    if (name === "log_expense") {
      const amount =
        typeof input.amount === "number" && isFinite(input.amount) && input.amount !== 0
          ? input.amount
          : 0;
      const category = typeof input.category === "string" ? input.category.trim() : "";
      if (!amount || !category) return JSON.stringify({ ok: false, error: "missing amount/category" });
      const payer =
        typeof input.payer === "string" && ["yogev", "business"].includes(input.payer)
          ? input.payer
          : "business";
      const description =
        typeof input.description === "string" ? input.description.trim().slice(0, 300) : "";
      const date =
        typeof input.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(input.date)
          ? input.date
          : ilTodayISO();
      // Only the business spends out of a pot; a partner pays from their pocket.
      const paidFrom =
        payer === "business" && typeof input.paid_from === "string" && ["bank", "bit", "cash"].includes(input.paid_from)
          ? input.paid_from
          : "";
      const inserted = await db
        .prepare(
          "INSERT INTO fin_expenses (date, payer, category, description, amount, paid_from) VALUES (?, ?, ?, ?, ?, ?) RETURNING id",
        )
        .bind(date, payer, category, description, amount, paidFrom)
        .first<{ id: number }>();
      // A receipt photographed moments earlier in this chat belongs to it.
      let receiptAttached = false;
      if (inserted?.id) {
        try {
          receiptAttached = await claimPendingReceipt(inserted.id, String(chatId));
        } catch (error) {
          console.error("receipt claim failed", error);
        }
      }
      // Unknown category → create it with a 0 budget so it shows up in the
      // tab's dropdown and budget bars (the partners can set an amount there).
      await db
        .prepare("INSERT OR IGNORE INTO fin_budgets (category, amount, position) VALUES (?, 0, 99)")
        .bind(category)
        .run();
      const catSpent = await db
        .prepare("SELECT COALESCE(SUM(amount), 0) AS s FROM fin_expenses WHERE category = ?")
        .bind(category)
        .first<{ s: number }>();
      const catBudget = await db
        .prepare("SELECT amount FROM fin_budgets WHERE category = ?")
        .bind(category)
        .first<{ amount: number }>();
      const spent = catSpent?.s ?? 0;
      const budget = catBudget?.amount ?? 0;
      const pct = budget > 0 ? Math.round((spent / budget) * 100) : null;
      return JSON.stringify({
        ok: true,
        category,
        amount,
        payer,
        paid_from: paidFrom || undefined,
        receipt_attached: receiptAttached || undefined,
        category_spent: Math.round(spent),
        category_budget: Math.round(budget),
        category_pct: pct,
        budget_warning:
          pct !== null && pct >= 90
            ? "הקטגוריה חצתה 90% מהתקציב — הדגש את זה ליוגב והמלץ לעצור ולבדוק לפני הוצאות נוספות בה"
            : undefined,
      });
    }
    // Bruno files receipts on his own now, so a misread number has to be
    // fixable where it was reported — in the chat, not only in the board.
    if (name === "fix_expense") {
      const id = typeof input.expense_id === "number" ? Math.trunc(input.expense_id) : 0;
      if (!id) return JSON.stringify({ ok: false, error: "missing expense_id" });
      const before = await db
        .prepare("SELECT id, date, payer, category, description, amount FROM fin_expenses WHERE id = ?")
        .bind(id)
        .first<{ id: number; date: string; payer: string; category: string; description: string; amount: number }>();
      if (!before) return JSON.stringify({ ok: false, error: `no expense ${id}` });
      if (input.delete === true) {
        // Its receipt goes back to the pending strip rather than vanishing.
        await deleteExpense(id);
        return JSON.stringify({ ok: true, deleted: before });
      }
      const after = await updateExpense(id, {
        amount: typeof input.amount === "number" ? input.amount : undefined,
        category: typeof input.category === "string" ? input.category.trim() : undefined,
        description: typeof input.description === "string" ? input.description.trim().slice(0, 300) : undefined,
        date: typeof input.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(input.date) ? input.date : undefined,
        payer:
          typeof input.payer === "string" && ["yogev", "business"].includes(input.payer)
            ? input.payer
            : undefined,
        paidFrom:
          typeof input.paid_from === "string" && ["bank", "bit", "cash"].includes(input.paid_from)
            ? input.paid_from
            : undefined,
      });
      if (!after) return JSON.stringify({ ok: false, error: "nothing to change" });
      // Unknown category → make sure the tab can show it.
      await db
        .prepare("INSERT OR IGNORE INTO fin_budgets (category, amount, position) VALUES (?, 0, 99)")
        .bind(after.category)
        .run();
      return JSON.stringify({ ok: true, before, after });
    }
    if (name === "add_inventory") {
      const itemName = typeof input.name === "string" ? input.name.trim() : "";
      const size = typeof input.size === "string" ? input.size.trim() : "";
      const qty = typeof input.qty === "number" ? Math.trunc(input.qty) : 0;
      if (!itemName || qty < 1) return JSON.stringify({ ok: false, error: "missing name/qty" });
      const existing = await db
        .prepare("SELECT id FROM seed_items WHERE name = ? AND size = ?")
        .bind(itemName, size)
        .first<{ id: number }>();
      if (existing) {
        // New units land in the room's no-size bucket.
        await receiveStock(existing.id, "room", "", qty);
        return JSON.stringify({ ok: true, merged: true, added: qty });
      }
      await addItem(itemName, size, qty);
      return JSON.stringify({ ok: true, added: qty });
    }
    if (name === "shopify_map") {
      return await buildVariantMap(env);
    }
    if (name === "set_revenue_goal") {
      const target =
        typeof input.target_nis === "number" && input.target_nis > 0
          ? Math.round(input.target_nis)
          : 0;
      if (!target) return JSON.stringify({ ok: false, error: "missing target_nis" });
      const deadline =
        typeof input.deadline === "string" && /^\d{4}-\d{2}-\d{2}$/.test(input.deadline)
          ? input.deadline
          : "";
      await putSetting(
        db,
        "goal_revenue",
        JSON.stringify({ target, deadline, updated: ilTodayISO() }),
      );
      return JSON.stringify({ ok: true, target, deadline });
    }
    if (name === "update_ship_status") return JSON.stringify(await updateShipStatus(db, input));
    if (name === "get_person_history") {
      const q = typeof input.name === "string" ? input.name.trim() : "";
      if (!q) return JSON.stringify({ ok: false, error: "missing name" });
      const like = `%${q}%`;
      const gifts = await db
        .prepare(
          "SELECT person, item_label, size, qty, status, location, given_at FROM seed_gifts WHERE person LIKE ? ORDER BY id",
        )
        .bind(like)
        .all();
      const sales = await db
        .prepare(
          "SELECT buyer, item_label, size, qty, price, ship_status, pay_method, sold_at FROM seed_sales WHERE buyer LIKE ? ORDER BY id",
        )
        .bind(like)
        .all();
      return JSON.stringify({
        ok: true,
        gifts: gifts.results ?? [],
        sales: sales.results ?? [],
      });
    }
    if (name === "shop_stats") {
      return await shopifyQuickStats(env);
    }
    if (name === "export_seeding_csv") {
      const { items, gifts, sales } = await getSeeding();
      const lines: string[] = [];
      lines.push("== חלוקות ==");
      lines.push("שם,אינסטגרם,סוג,פריט,מידה,כמות,סטטוס,מיקום,תאריך");
      for (const g of gifts) {
        lines.push(
          [g.person, g.handle, g.kind, g.item_label, g.size, g.qty, g.status, g.location, g.given_at]
            .map(csvCell)
            .join(","),
        );
      }
      lines.push("");
      lines.push("== מכירות ==");
      lines.push("קונה,פריט,מידה,כמות,מחיר ליחידה,סהכ,משלוח,תשלום,מיקום,תאריך");
      for (const s of sales) {
        lines.push(
          [
            s.buyer,
            s.item_label,
            s.size,
            s.qty,
            s.price,
            s.price * s.qty,
            s.ship_status,
            s.pay_method,
            s.location,
            s.sold_at,
          ]
            .map(csvCell)
            .join(","),
        );
      }
      lines.push("");
      lines.push("== מלאי ==");
      lines.push("פריט,מיקום,בלי מידה,XS,S,M,L,XL,XXL,מחיר");
      for (const i of items) {
        for (const r of i.stock) {
          lines.push(
            [i.name, r.location, r.qty, r.qty_xs, r.qty_s, r.qty_m, r.qty_l, r.qty_xl, r.qty_xxl, i.price]
              .map(csvCell)
              .join(","),
          );
        }
      }
      // No file channel exists inside the board chat (the CSV used to go out
      // as a Telegram document) — hand the model the text itself, capped so
      // a big ledger can't blow the context; the partners copy it into Excel.
      const csv = lines.join("\n");
      return JSON.stringify({
        ok: true,
        filename: `segula-seeding-${ilTodayISO()}.csv`,
        rows: lines.length - 1,
        csv: csv.length > 6000 ? csv.slice(0, 6000) + "\n… (קוצר)" : csv,
        note: "הצג את ה-CSV בבלוק קוד; אין שליחת קבצים בצ'אט הלוח",
      });
    }
    if (name === "add_reminder") {
      const when = typeof input.when === "string" ? input.when.trim() : "";
      const text = typeof input.text === "string" ? input.text.trim() : "";
      const m = when.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})$/);
      if (!m || !text) {
        return JSON.stringify({ ok: false, error: "when must be YYYY-MM-DD HH:MM" });
      }
      // The model speaks Israel wall time; storage is UTC.
      const asUtcGuess = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
      const fireAt = new Date(asUtcGuess - ilOffsetMs(new Date(asUtcGuess))).toISOString();
      if (Date.parse(fireAt) < Date.now() - 60000) {
        return JSON.stringify({ ok: false, error: "time is in the past" });
      }
      await addReminder(db, chatId, fireAt, text);
      return JSON.stringify({ ok: true, fire_at_israel: when });
    }
    if (name === "transfer_stock") {
      const itemId = typeof input.item_id === "number" ? input.item_id : 0;
      const qty = typeof input.qty === "number" ? Math.trunc(input.qty) : 0;
      const from = normLocation(input.from);
      const to = normLocation(input.to);
      const size = typeof input.size === "string" ? input.size.trim() : "";
      if (!itemId || qty < 1 || from === to) {
        return JSON.stringify({ ok: false, error: "missing item_id/qty or same location" });
      }
      await transferStock(itemId, from, to, size, qty);
      return JSON.stringify({ ok: true, moved: qty, from, to });
    }
    return JSON.stringify({ ok: false, error: `unknown tool ${name}` });
  } catch (error) {
    return JSON.stringify({ ok: false, error: String(error) });
  }
}

// ---- The conversation ----

function systemPrompt(
  digest: string,
  finance: string,
  seeding: string,
  brandContext: string,
  brandMemory: string,
  competitorIntel: string,
  speaker: string,
  ownerContext: string,
): SystemBlock[] {
  const today = ilTodayISO();
  const weekday = WEEKDAY_NAMES[new Date(today + "T12:00:00Z").getUTCDay()];
  // Two blocks on purpose: the first (persona, brand context, memory, the
  // long instruction sheet) changes only when a partner edits the memory,
  // so it is marked for prompt caching — every tool round of every message
  // used to re-send all of it at full price. The second block is live data
  // (today, speaker, the three digests) and is never cached.
  const stable =
    "אתה ברונו (Bruno) — המנכ\"ל הדיגיטלי, העוזר האישי ויועץ הפיתוח העסקי של SEGULA, מותג בגדים ישראלי (אינסטגרם @segula.club, סלוגן: we do what we want). זה השם שלך ופונים אליך בו. " +
    `${ownerContext}\n` +
    "אתה חי בצ'אט של הלוח ומחובר ללוח ולמודל הפיננסי.\n\n" +
    "קול המותג: כל טקסט שאתה מנסח ללקוח, למשפיען, לחנות או לעוקבים נכתב בשם SEGULA, ב'אנחנו', בלי שמות פרטיים (לא יוגב, לא דימה) ובלי 'זה יוגב'. חתימה: SEGULA, ומתחת we do what we want.\n\n" +
    (brandContext ? `רקע מלא על המותג:\n${brandContext}\n\n` : "") +
    (brandMemory
      ? `זיכרון חי — עובדות שיוגב ביקש לזכור (העדכני גובר על הרקע). מספר בזיכרון הוא היסטוריה עם תאריך: הנתונים החיים שלמטה גוברים עליו, וכשיש סתירה אמור את המספר החי ואת הפער:\n${brandMemory}\n\n`
      : "") +
    (competitorIntel ? `${competitorIntel}\n\n` : "") +
    "יש לך כלי remember — וחובה להשתמש בו בכל פעם שיוגב מוסר עדכון עסקי, מתקן תאריך, או אומר משהו שסותר את הרקע או הזיכרון — גם בלי שביקש 'תזכור'. שמור את הגרסה המתוקנת מיד, ואז ענה. עובדה שלא נשמרה = עובדה שתישכח.\n\n" +
    "בתור יועץ פיתוח עסקי: כששואלים אותך על מחירים, רווחיות, תקציבים, כמויות או החלטות עסקיות — חשב מהמספרים האמיתיים במודל הפיננסי שמצורף (מחירים, עלויות, משלוחים, מתנות, תקציבים) והצג חישוב קצר ושקוף. " +
    "כשמציעים מהלכי צמיחה (שת\"פים, פופ-אפים, תוכן, קהילה, וויטליסט) — קשור אותם למספרים ולמה שעל הלוח, והצע צעד ראשון קונקרטי שאפשר להוסיף כמשימה. אתה רשאי לאתגר החלטות בכנות כשהמספרים לא מסתדרים.\n\n" +
    "למשימות בלוח יש לך add_task ו-update_task. השתמש בהם רק כשמבקשים ממך במפורש להוסיף/לעדכן/לסמן משימה. " +
    "כשמבקשים לסמן משימה כבוצעה — מצא אותה לפי הכותרת בלוח והשתמש ב-update_task עם status=done. " +
    "כשמוסיפים משימה ליום מסוים — שבץ בקבוצת היום המתאימה וחשב את due_date מהתאריך של היום. " +
    "אחרי פעולה, אשר בקצרה מה עשית. אם לא ברור לאיזו משימה מתכוונים — שאל.\n\n" +
    "יש לך גם כלים למערכת החלוקות והמכירות (טאב 'חלוקות' בלוח): log_gift, log_sale ו-add_inventory. " +
    "כשיוגב כותב שנתן/מסר/הביא מוצר למישהו בחינם ('נתתי לדנה חולצה לבנה מידה M') — מצא את הפריט במלאי לפי השם, העבר את המידה בפרמטר size. המלאי מפוצל גם לפי מיקום (stock_by_location: room=החדר, car=האוטו של יוגב, dima=אצל דימה) — אם צוין מיקום ('מהאוטו', 'מדימה') העבר את location המתאים, אחרת room. הרישום יוריד מהמידה והמיקום הנכונים. אשר בקצרה כולל כמה נשאר באותה מידה באותו מיקום. אותו דבר ב-log_sale למכירות. " +
    "כשיוגב כותב שמכר ('מכרתי לרוני חולצה M ב-150') — רשום עם log_sale (price = מחיר ליחידה). אם לא צוין מחיר אבל לפריט מוגדר price במלאי — השתמש בו בלי לשאול; אם אין גם price, שאל לפני שאתה רושם. " +
    "כשיוגב כותב שהוציא/שילם/קנה משהו לעסק ('שילמתי 450 על סמפלים', 'רשום הוצאה 300 משלוחים') — רשום עם log_expense. קטגוריה מתוך expense_tracker (אין התאמה → 'אחר'), payer = מי שכותב אלא אם נאמר אחרת. אשר בקצרה עם ניצול תקציב הקטגוריה, ואם יש budget_warning בתשובה — הדגש אזהרה. כשה-payer הוא business שאל מאיפה שולם (בנק/ביט/מזומן) ושלח paid_from — בלי זה היתרה של הקופה לא מתעדכנת. על 'כמה מכרתי / כמה הכנסות / כמה הרווחתי' ענה מ-expense_tracker.money.since_buyout כשיש לו start, ואמור במפורש 'מאז החתימה על הרכישה (תאריך)'; את הסכום מתחילת הרישומים תן רק אם יוגב ביקש את הכל, ואמור שזה כולל את התקופה עם דימה. על 'כמה כסף יש לנו בבנק/בביט/במזומן' ענה רק מ-expense_tracker.money, לא מסכימת מכירות: אותם מספרים שאלכס ו'היום שלך' מציגים. לכל מספר יש source, as_of ו-note: אם value הוא null אמור 'לא ידוע' ולמה (note), אל תחשב במקומו ואל תאמר אפס. אם ב-note כתוב שהזיכויים ישנים, אמור שהמספר לא תואם את הבנק מאז as_of. מכירה בשופיפיי או ב-Hyp היא לא כסף בבנק: היא ב-waiting_at_clearers_gross עד שנכנס זיכוי, ומגיעה פחות עמלה. אבל 'לא נרשמה העברה בלוח' אינו 'הכסף לא נכנס לבנק': אם הזיכוי האחרון ישן או לא נרשם, אמור שהמצב בפועל לא ידוע בלי דף בנק, ואל תקבע שהכסף עוד לא הגיע. לכל מספר יש state: 'מאומת', 'נרשם בלוח, לא מאומת מול הבנק', 'אומדן', 'מתוכנן' או 'ממתין לאישור'. אמור אותו כשהוא לא 'מאומת', ואל תציג אומדן או רישום בלוח כעובדה מאומתת. 'כסף פנוי' רק מ-free_money; אם הוא null, אמור שלא מחושב ומה חסר. נתונים עסקיים (סכום הרכישה מדימה, תקרת השקעה, יעד הכנסות, עלויות יחידה) רק מ-business_facts, ותמיד עם המצב שלהם ('ממתין לאימות', 'מתוכנן'): תקרה ויעד הם תוכניות ולא כסף, והוצאה מתוכננת היא לא הוצאה ששולמה. אם עובדה בזיכרון שלך סותרת את business_facts, business_facts קובע. total_budget_setting היא הגדרת תקציב, לא כסף שיש. כשיוגב אומר שנכנס זיכוי ('נכנס מ-Hyp 1,430', 'שופיפיי העבירו 2,300') — רשום עם log_settlement ואמור כמה נכנס, כמה ברוטו זה סגר ומה העמלה באחוזים שהכלי החזיר. אל תשלח gross אלא אם יוגב אמר במפורש על כמה מכירות מדובר. כששולחים תמונת קבלה היא נשמרת אוטומטית ומצטרפת להוצאה שתירשם מיד אחריה (receipt_attached:true בתשובה — ציין שצירפת); אם אין סכום או קטגוריה בכיתוב, בקש אותם בשורה אחת. expense_tracker.receipts_received_recently הוא רשימת הקבלות שהתקבלו אצלך ב-6 השעות האחרונות (לפני כמה דקות, ולאיזו הוצאה כבר צורפו), ו-pending_receipts הן אלה שעוד מחכות לשיוך. כל עוד הרשימה לא ריקה אסור לך לומר שלא הגיעה תמונה או שקיבלת רק טקסט — גם אם הקבלה כבר שויכה. תגיד 'קיבלתי את הקבלה' (ואם attached_to_expense מלא — 'והיא כבר מצורפת להוצאה'). בהיסטוריית השיחה תמונה שהתקבלה מופיעה כשורה '[שלח תמונת קבלה ...]' — זו עדות שהיא הגיעה. תמונת קבלה בלי סכום בכיתוב נקראת אוטומטית: המערכת מחלצת ממנה סכום ובית עסק, רושמת את ההוצאה ומצרפת אליה את הקבלה עוד לפני שהגעת לשיחה — כשמדברים איתך על קבלה כזו, ההוצאה כבר רשומה. אם יוגב אומר שמה שנרשם שגוי — תקן עם fix_expense לפי ה-id מ-recent_expenses (אותו כלי גם מוחק, delete:true, והקבלה חוזרת לרשימת הממתינות). אל תנחש על איזו הוצאה מדובר: אם לא ברור, שאל. אחרי תיקון אמור מה השתנה ומה הערך החדש. קבלה שנקראה אוטומטית שומרת גם את סכום המע\"מ ומספר העוסק כשהם מופיעים עליה — vat_this_month בנתונים הוא המע\"מ שנצבר החודש. אתה לא רואה את תוכן התמונה עצמה (לא את הסכום שכתוב עליה) — זה בסדר, תגיד את זה ישר במקום להכחיש שהיא הגיעה. אם מבקשים לצרף את התמונה להוצאה שכבר קיימת — attach_receipt. עריכת הוצאה קיימת נעשית רק עם fix_expense: הוא משנה סכום, קטגוריה, תיאור, תאריך, מי שילם ומאיפה שולם, וגם מוחק. מה שאין לך: מיזוג שתי הוצאות לאחת (הפתרון: מחק אחת ותקן את השנייה), ועריכה של מכירה או חלוקה שכבר נרשמו (אמור בפירוש שאת זה עושים בטאב חלוקות). אסור לך לאשר פעולה שלא ביצעת בכלי: אשר רק מה שהכלי החזיר ok, ואם כלי החזיר pending_confirmation אמור שזה מחכה לאישור בכפתור ולא בוצע. " +
    "אם אדם אחד לקח/קנה כמה פריטים — קרא לכלי פעם אחת לכל פריט (אפשר כמה קריאות באותה תשובה). " +
    "אם נשארו 2 או פחות — הוסף אזהרת מלאי. אם אין פריט תואם במלאי — אל תנחש ואל תמציא item_id: אמור מה כן יש במלאי ושאל אם להוסיף את הפריט (add_inventory) ואז לרשום. " +
    "כשמדווחים שהגיע מלאי חדש ('הגיעו עוד 10 חולצות M') — השתמש ב-add_inventory. " +
    "כשמדווחים על העברת מלאי בין מיקומים ('העברתי 10 חולצות מהחדר לאוטו') — transfer_stock. " +
    "כשמבקשים לחבר/לרענן את הסנכרון לחנות ('חבר את המלאי לשופיפיי') — shopify_map, ודווח מה הותאם ומה לא. אחרי שהסנכרון פעיל, כל חלוקה ומכירה ידנית מעדכנות אוטומטית גם את מלאי החנות.\n\n" +
    "משלוחים: ברשימת open_orders בנתונים רואים כל הזמנה שעוד לא נמסרה, עם מספרי ההזמנה (refs). כששואלים 'מה מחכה למשלוח' — ענה ממנה לפי שלבים (נרשם/נארז/נשלח). כשמדווחים על התקדמות ('החבילה של רוני נשלחה', 'ההזמנה של איתן התקבלה') — עדכן עם update_ship_status על הזמנה אחת: 'נשלח'/'התקבל' רק עם מספר הזמנה או ראיה (מספר מעקב, שליח, למי נמסר ביד); אם אין, שאל מה הראיה לפני שאתה מעדכן. כשהכלי מחזיר ambiguous, שאל איזו הזמנה מתוך הרשימה. " +
    "כששואלים 'כמה עשינו היום' — ענה מבלוק today בנתונים (מכירות יד) ואם רלוונטי הוסף גם shop_stats לחנות האונליין. " +
    "כששואלים על אדם ספציפי ('מה קיבלה דנה?') — השתמש ב-get_person_history לקבל את כל ההיסטוריה. " +
    "כששואלים על החנות/הזמנות אונליין — shop_stats. כשמבקשים אקסל/ייצוא של החלוקות — export_seeding_csv. " +
    "כשמבקשים תזכורת ('תזכיר לי מחר ב-10...') — add_reminder עם תאריך ושעה מחושבים מהיום הנוכחי, ואשר בקצרה מתי היא תקפוץ.\n\n" +
    "מעקב יעדים: יעד העוקבים (5,000 עד מרץ 2027, בטאב התוכנית) מתעדכן עם הכלי update_followers — השתמש בו בכל פעם שמדווחים לך מספר עוקבים עדכני. יעד ההכנסות של הדרופ נקבע ומתעדכן עם set_revenue_goal כשיוגב מגדיר אותו בצ'אט. המכירות נספרות אוטומטית מרישומי המכירות — אל תנהל להן ספירה נפרדת. כשמדברים על התקדמות, אמור בכנות אם הקצב מספיק ליעד (יש לך את הקצב הנדרש ליום במצב היעדים) ומה יסגור את הפער.\n\n" +
    "יש לך זיכרון שיחה: ההודעות האחרונות בצ'אט מצורפות אליך, כך שאתה כן זוכר את ההקשר האחרון — אל תגיד שאתה לא זוכר שיחות. הזיכרון ארוך-הטווח שלכם הוא הלוח עצמו. " +
    "חשוב: כשהודעה מצדיקה פעולה (רישום מכירה/חלוקה, עדכון מלאי, תזכורת, עדכון משלוח, עדכון יעד) — קרא לכלי המתאים מיד באותה תשובה, אל תסתפק בטקסט ואל תשאל אישור מיותר. " +
    "כשכלי או נתון מחזיר שגיאה, null או 'לא זמין': אמור 'לא הצלחתי לבדוק את X', לעולם לא 'אין' ולא 0. אם הנתון ישן (מצוין לידו מתי עודכן), אמור ממתי הוא. " +
    "לשאלות על מצב הלוח ענה מהנתונים בלבד, אל תמציא משימות. ענה בעברית, קצר וישיר: עד 5 שורות, השורה התחתונה קודם, בלי רשימות ארוכות ובלי לחזור על נתונים שלא נשאלת עליהם. יוגב ביקש במפורש שלא יחפרו לו; פירוט רק כשהוא מבקש. " +
    "אתה גם המנכ\"ל של צוות עובדים דיגיטליים (ממומן, תוכן, לקוחות ומייל, משפיענים, הפצה, חנות, מלאי ודרופ, כספים). יוגב מפעיל את העסק לבד, והצוות הוא הידיים שלו. כשיוגב מבקש משהו ששייך לתחום של עובד (מחקר מתחרים, תסריטי רילז, מייל ללקוחות, למי לפנות, מה לתקן באתר, כמה להזמין) — אל תענה מהראש: שלח את העובד המתאים עם delegate, ואז סכם ליוגב את מה שחזר בקצרה ובגובה העיניים, עם השורה התחתונה קודם. אם המשימה נוגעת לשני תחומים, שלח שניים. כשיוגב נותן הנחיה קבועה לעובד ('מיכאלה, אני לא מצטלם מדבר') או מתקן משהו שעובד כבר יודע, שמור או תקן אותה עם team_fact כדי שתחול מהריצה הבאה. על שאלות פשוטות מהלוח ענה בעצמך. מצב הצוות מצורף למטה. " +
    "עבודה משותפת (הכלי work): כשיוגב מדבר על נושא שכבר יש לו עבודה ב-work list (למשל הבאנדל חולצה+כובע), ענה ממנה (בעלים, מחיר ומקורו, חסמים, צעד הבא) במקום לפתוח טיוטה או הכרעה חדשה; המצבים נפרדים (הוכן, אושר, בוצע, נבדק), ו'בוצע' הוא רק מה שכלי אישר.\n\n" +
    "אתה גם שותף אסטרטגי — כששואלים אותך על המותג, תן עצות מעשיות בהתאם לקונספט של הדרופ הנוכחי (אל תניח אותו — בדוק או שאל). " +
    "ייתכן שיוגב כבר קיבל ממך אישור מיידי קצר ('בודק את המלאי, רגע') לפני התשובה הזו: התחל ישר מהעיקר, לא מ'בודק' או 'רגע'.";
  const live =
    `היום (שעון ישראל): יום ${weekday}, ${today}. מי שכותב לך עכשיו: ${speaker}.\n\n` +
    `מצב הלוח כרגע (JSON):\n${digest}\n\n` +
    `מלאי החלוקות למשפיענים + רישומים אחרונים (JSON), ואחריהם מכירות לפריט ב-7/30 יום (נתון חי: כמויות ותוכניות מהזיכרון הן היסטוריה, וכשיש מספר חי מצטטים אותו עם התאריך):\n${seeding}\n\n` +
    `הנתונים הפיננסיים (JSON — price_list מהמחירון, financial_model מהמודל הפיננסי, budgets, fixed_costs):\n${finance}`;
  return [
    { type: "text", text: stable, cache_control: { type: "ephemeral" } },
    { type: "text", text: live },
  ];
}

type SystemBlock = { type: "text"; text: string; cache_control?: { type: "ephemeral" } };

// מצב ברונו: יוגב מדבר ושומע, בלי מסך צ'אט. התשובה מוקראת בקול, אז היא חייבת להיות
// קצרה ומדוברת. בלוק נפרד בסוף, כדי לא לשבור את ה-cache של הבלוק הקבוע.
const LIVE_MODE_PROMPT =
  "מצב ברונו פעיל: יוגב מדבר איתך בקול, והתשובה שלך מוקראת לו בקול. כללים למצב הזה בלבד: " +
  "עד שני משפטים קצרים (עד כ-30 מילים), בעברית מדוברת. בלי רשימות, בלי כוכביות, בלי אימוג'י, בלי קישורים ובלי מספרי משימה. " +
  "מספרים כתוב בספרות ועגל ('בערך 3,700 שקל'). קודם השורה התחתונה. " +
  "האופי: כמו ג'ארוויס. רגוע, בטוח, קצת הומור יבש כשזה מתאים, ולפעמים פנה אליו 'בוס'. אף פעם לא על חשבון הדיוק: מספר שאין לך, אמור שאין. " +
  "כשהוא מבקש לראות משהו, קרא ל-show_screen. כשהוא מבקש לשלוח לטלפון, קרא ל-send_to_phone. " +
  "כשפעולה מחכה לאישור, אמור במשפט אחד שהיא מחכה לאישור שלו על המסך. " +
  "מה שיוגב אמר מגיע מתמלול קולי, ושמות משתבשים בו ('היא דוסה' או 'זידו' = עידו, 'מלאה' = ליה, 'ין' = יאן, 'ברימה' = DREAMER). מילה שנשמעת כמו שם של עובד, מוצר או חנות: הבן לפי ההקשר. באמת לא ברור? שאל שאלה אחת קצרה, אל תנחש פעולה. " +
  "תוכנית, הסבר או פירוט במצב הזה: אמור בקול רק את השורה התחתונה (עד שני משפטים), ושים את הפירוט המלא ב-live_card.details. אל תבקש 'יותר מקום' ואל תשאל אם לפרט, פשוט פרט בכרטיס. " +
  "כרטיס: כשהתשובה נשענת על נתונים או מובילה לצעד, קרא ל-live_card (מה נמצא, מקור, מועד עדכון אם ידוע, מה חסר, הצעד הבא). לשיחה פשוטה אל תקרא לו. " +
  "'מה דחוף היום': רק מתוך המשימות הפתוחות, התאריכים, ההכרעות והנתונים שלפניך. אין משהו דחוף? אמור שאין. אל תמציא פעילות. " +
  "'בוא נמשיך מאיפה שעצרנו': התבסס על השרשור ועל 'סיכום השיחה הקודמת' אם צורף. אין על מה להתבסס? אמור את זה. " +
  "כשיוגב אומר כמה זמן פנוי יש לו ('יש לי 15 דקות'): בחר משימה פתוחה אחת בלבד שאפשר לסיים בזמן הזה, אמור במשפט אחד למה היא הכי חשובה עכשיו, " +
  "קרא ל-show_screen לטאב שלה ול-live_card עם next.who (bruno אם אתה יכול לבצע בכלי, yogev אם רק הוא). " +
  "אל תסמן משימה כהושלמה ואל תשנה סטטוס רק כי פתחת מסך או הכנת טיוטה; משימה נסגרת רק כשיוגב אומר שסיים.";

/** הכלים לתור: במצב ברונו נוסף כרטיס התוצאה. ה-cache על הכלי האחרון בכל גרסה. */
function toolsFor(live: boolean) {
  const list: readonly { name: string }[] = live ? [...TOOLS, LIVE_CARD_TOOL] : TOOLS;
  return list.map((t, i) => (i === list.length - 1 ? { ...t, cache_control: { type: "ephemeral" } } : t));
}

// מצב ברונו באנגלית (המתג EN): אותם כללים, רק שהתשובה המדוברת באנגלית בריטית.
// הכלים והנתונים נשארים בעברית; שמות מוצרים ואנשים כותבים כמו שהם.
const LIVE_MODE_EN_PROMPT =
  "LANGUAGE OVERRIDE for this voice turn: your reply will be spoken by a British voice. Yogev may speak to you in Hebrew or in English; understand either, and always reply in English. " +
  "Answer in natural spoken English only (never Hebrew), still at most two short sentences. Numbers in digits, money as 'about 3,700 shekels'. " +
  "Keep the Jarvis character (calm, confident, dry humour), address him as 'boss' now and then. Hebrew names of products or people may stay as they are.";

// ---- אישור לפני ביצוע (פקודות קוליות) ----

/** שדה אחד של פעולה ממתינה, להצגה ולתיקון לפני אישור. kind קובע איך מתקנים. */
export type PendingField = { key: string; label: string; value: string | number; kind: "number" | "text" };
export type PendingAction = { id: number; summary: string; tool?: string; action?: string; fields?: PendingField[] };

const FIELD_HE: Record<string, string> = {
  item: "פריט",
  item_label: "פריט",
  items: "פריטים",
  name: "שם",
  buyer: "קונה",
  person: "למי",
  who: "מי",
  qty: "כמות",
  quantity: "כמות",
  price: "מחיר",
  amount: "סכום",
  net: "נטו",
  gross: "ברוטו",
  size: "מידה",
  location: "מיקום",
  from: "מ",
  to: "אל",
  category: "קטגוריה",
  description: "תיאור",
  vendor: "ספק",
  date: "תאריך",
  payer: "מי שילם",
  provider: "סולק",
  status: "סטטוס",
  order: "הזמנה",
  sale_id: "מספר מכירה",
  expense_id: "מספר הוצאה",
  target: "יעד",
  note: "הערה",
  kind: "סוג",
  pay_method: "אמצעי תשלום",
};

// ---- מצב ברונו: מי עובד עכשיו, וסיכומי שיחה משותפים לכל המכשירים ----

/** עובדים שרצים ברגע זה, לפי נעילת הריצה (team_locks) שהשרת מחזיק בזמן ריצה. עובדה, לא ניחוש. */
export async function runningAgents(db: D1Database): Promise<string[]> {
  const rows = await db.prepare("SELECT agent FROM team_locks WHERE until > datetime('now')").all<{ agent: string }>();
  return (rows.results ?? []).map((r) => r.agent);
}

export type LiveSummary = { at: string; actor: string; done: string[]; prepared: string[]; failed: string[]; open: string[] };
const LIVE_SESSIONS_KEY = "bruno_live_sessions";
const LIVE_SESSIONS_MAX = 20;

function cleanList(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.trim() !== "").slice(0, 20).map((x) => x.trim().slice(0, 200)) : [];
}

/** סיכום שיחה מהמסך נשמר בשרת, כדי שיופיע גם בטלפון וגם במחשב. סיכום ריק לא נשמר. */
export async function saveLiveSummary(db: D1Database, raw: unknown, actor: string): Promise<{ ok: boolean; error?: string }> {
  if (!raw || typeof raw !== "object") return { ok: false, error: "bad_summary" };
  const r = raw as Record<string, unknown>;
  const s: LiveSummary = { at: typeof r.at === "string" ? r.at.slice(0, 40) : "", actor: actor.slice(0, 20), done: cleanList(r.done), prepared: cleanList(r.prepared), failed: cleanList(r.failed), open: cleanList(r.open) };
  if (!s.at || !(s.done.length + s.prepared.length + s.failed.length + s.open.length)) return { ok: false, error: "empty" };
  const list = await listLiveSummaries(db);
  const same = (x: LiveSummary) => x.at === s.at && x.actor === s.actor;
  await putSetting(db, LIVE_SESSIONS_KEY, JSON.stringify([s, ...list.filter((x) => !same(x))].slice(0, LIVE_SESSIONS_MAX)));
  return { ok: true };
}

export async function listLiveSummaries(db: D1Database): Promise<LiveSummary[]> {
  try {
    const list = JSON.parse((await getSetting(db, LIVE_SESSIONS_KEY)) ?? "[]") as unknown;
    return Array.isArray(list) ? (list as LiveSummary[]) : [];
  } catch {
    return [];
  }
}

/** השדות שיוגב רואה ויכול לתקן: רק ערכים פשוטים (מספר/טקסט) שכבר קיימים בקלט. */
export function pendingFields(input: Record<string, unknown>): PendingField[] {
  return Object.entries(input)
    .filter(([k, v]) => k !== "חשד לכפילות" && (typeof v === "number" || (typeof v === "string" && v !== "")))
    .map(([k, v]) => ({ key: k, label: FIELD_HE[k] ?? k, value: v as string | number, kind: typeof v === "number" ? ("number" as const) : ("text" as const) }));
}

/** מחיל תיקונים של יוגב על הקלט. רק מפתחות שכבר קיימים, ורק באותו סוג: מספר נשאר מספר
 *  תקין, טקסט לא ריק. תיקון לא תקין מחזיר שגיאה ולא מבוצע כלום. */
export function applyEdits(input: Record<string, unknown>, edits: Record<string, unknown>): { ok: true; input: Record<string, unknown> } | { ok: false; error: string } {
  const out = { ...input };
  for (const [k, v] of Object.entries(edits)) {
    if (k === "חשד לכפילות" || !(k in input)) return { ok: false, error: `אי אפשר לתקן את "${k}"` };
    const cur = input[k];
    if (typeof cur === "number") {
      // "1,200" ו-"₪540" בסדר; "abc" או ריק אינם מספר (ולא הופכים לאפס בשקט).
      const digits = typeof v === "number" ? String(v) : String(v).replace(/[,₪\s]/g, "");
      const n = /^-?\d+(\.\d+)?$/.test(digits) ? Number(digits) : NaN;
      if (!Number.isFinite(n)) return { ok: false, error: `"${FIELD_HE[k] ?? k}" חייב להיות מספר` };
      out[k] = n;
    } else if (typeof cur === "string") {
      const s = String(v).trim();
      if (!s) return { ok: false, error: `"${FIELD_HE[k] ?? k}" לא יכול להיות ריק` };
      out[k] = s.slice(0, 200);
    } else return { ok: false, error: `אי אפשר לתקן את "${k}"` };
  }
  return { ok: true, input: out };
}

/** כלים שמשנים כספים, מלאי או סטטוס הזמנה. תמלול קולי יכול לטעות במספר או בשם,
 *  אז כשההודעה הגיעה מהמיקרופון הם מחכים לאישור. שאלות מידע ומשימות רצות מיד. */
const CONFIRM_ON_VOICE = new Set(["log_sale", "log_gift", "log_expense", "fix_expense", "log_settlement", "add_inventory", "transfer_stock", "update_ship_status", "set_revenue_goal", "partner_update"]);
const PENDING_TTL_MIN = 15;

const TOOL_HE: Record<string, string> = {
  log_sale: "רישום מכירה",
  log_gift: "רישום חלוקה",
  log_expense: "רישום הוצאה",
  fix_expense: "תיקון הוצאה",
  log_settlement: "רישום התחשבנות",
  add_inventory: "הוספת מלאי",
  transfer_stock: "העברת מלאי",
  update_ship_status: "עדכון סטטוס משלוח",
  set_revenue_goal: "עדכון יעד הכנסות",
  partner_update: "עדכון משפיען או שותף",
  recipe: "עבודה ברקע",
  work: "עבודה משותפת",
};

/** תיאור הפעולה נבנה מהקלט עצמו (לא מהניסוח של המודל), כדי שמה שיוגב מאשר הוא בדיוק מה שיבוצע. */
function summarizeToolCall(tool: string, input: Record<string, unknown>): string {
  const fields = Object.entries(input)
    .filter(([, v]) => v !== "" && v !== null && v !== undefined)
    .map(([k, v]) => `${FIELD_HE[k] ?? k}: ${typeof v === "object" ? JSON.stringify(v) : String(v)}`)
    .join(" · ");
  return `${TOOL_HE[tool] ?? tool} — ${fields}`.slice(0, 400);
}

/** זיכוי שנראה כפול לא נרשם ישר: הוא הופך לפעולה ממתינה עם הסיבה, ויוגב מאשר בכפתור.
 *  הבדיקה כאן, לפני הכלי, ולא בתוכו: אישור בכפתור מריץ את הכלי ישירות, בלי לבדוק שוב. */
async function suspectSettlement(tool: string, input: Record<string, unknown>): Promise<string> {
  if (tool !== "log_settlement") return "";
  const provider = typeof input.provider === "string" && IS_PROVIDER(input.provider) ? input.provider : null;
  const net = typeof input.net === "number" && isFinite(input.net) && input.net > 0 ? input.net : 0;
  if (!provider || !net) return "";
  const date = typeof input.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(input.date) ? input.date : ilTodayISO();
  const gross = typeof input.gross === "number" && input.gross > 0 ? input.gross : 0;
  const reasons = await settlementSuspicion({ date, provider, net, gross }).catch(() => [] as string[]);
  return reasons.join(" · ");
}

async function holdForConfirmation(db: D1Database, tool: string, input: Record<string, unknown>, speaker: string, sink?: PendingAction[]): Promise<string> {
  const summary = summarizeToolCall(tool, input);
  const res = await db.prepare("INSERT INTO assistant_pending (tool, input, summary, actor) VALUES (?, ?, ?, ?)").bind(tool, JSON.stringify(input), summary, speaker).run();
  const id = Number(res.meta?.last_row_id ?? 0);
  sink?.push({ id, summary, tool, action: TOOL_HE[tool] ?? tool, fields: pendingFields(input) });
  return JSON.stringify({ ok: false, pending_confirmation: true, confirmation_id: id, note: "הפעולה לא בוצעה. היא מחכה לאישור של יוגב בכפתור שמופיע לו עכשיו. אמור במשפט אחד מה מחכה לאישור, ואל תאשר שבוצע." });
}

const EXECUTING_STALE_SEC = 120;

/** מה שמחכה ליוגב עכשיו, מהשרת (ולא מה-state של הדפדפן): שורד רענון ומכשיר אחר.
 *  בדרך מסמן מה שפג, ומה שנתקע באמצע ביצוע הופך ל-unknown: כלי כמו רישום הוצאה
 *  אינו אידמפוטנטי, אז לא מנסים שוב לבד ולא מציעים "אשר" — מבקשים לבדוק ביומן. */
export async function listPending(db: D1Database): Promise<(PendingAction & { state: "pending" | "unknown"; created_at: string })[]> {
  await db.prepare(`UPDATE assistant_pending SET status = 'expired' WHERE tool <> 'today_ship' AND status = 'pending' AND created_at < datetime('now', '-${PENDING_TTL_MIN} minutes')`).run();
  await db
    .prepare(`UPDATE assistant_pending SET status = 'unknown', result = 'הביצוע נקטע באמצע. לא ידוע אם הפעולה נרשמה.' WHERE tool <> 'today_ship' AND status = 'executing' AND decided_at < datetime('now', '-${EXECUTING_STALE_SEC} seconds')`)
    .run();
  const rows = await db
    .prepare("SELECT id, tool, input, summary, status, created_at FROM assistant_pending WHERE tool <> 'today_ship' AND (status = 'pending' OR (status = 'unknown' AND created_at >= datetime('now', '-1 day'))) ORDER BY id")
    .all<{ id: number; tool: string; input: string; summary: string; status: string; created_at: string }>();
  return (rows.results ?? []).map((r) => {
    let input: Record<string, unknown> = {};
    try {
      input = JSON.parse(r.input) as Record<string, unknown>;
    } catch {
      input = {};
    }
    return { id: r.id, summary: r.summary, tool: r.tool, action: TOOL_HE[r.tool] ?? r.tool, fields: pendingFields(input), state: r.status === "unknown" ? ("unknown" as const) : ("pending" as const), created_at: r.created_at };
  });
}

/** מצב של פעולה אחת — הלקוח שואל את זה כשבקשת האישור נפלה ולא ברור מה קרה. */
export async function pendingStatus(db: D1Database, id: number): Promise<{ status: string; text: string } | null> {
  await listPending(db); // מעדכן פג/נתקע לפני שעונים
  const row = await db.prepare("SELECT status, result, summary FROM assistant_pending WHERE id = ?").bind(id).first<{ status: string; result: string; summary: string }>();
  return row ? { status: row.status, text: row.result || row.summary } : null;
}

/** יוגב בדק ביומן וסוגר פעולה שמצבה לא היה ידוע. */
export async function closeUnknown(db: D1Database, id: number): Promise<boolean> {
  const res = await db.prepare("UPDATE assistant_pending SET status = 'closed', decided_at = datetime('now') WHERE id = ? AND status = 'unknown'").bind(id).run();
  return (res.meta?.changes ?? 0) === 1;
}

/** אישור או ביטול של פעולה ממתינה. תפיסה אטומית: לחיצה כפולה מבצעת פעם אחת. */
export async function confirmPending(env: AssistantEnv, id: number, approve: boolean, edits?: Record<string, unknown>): Promise<{ ok: boolean; status: string; text: string }> {
  if (!env.DB) return { ok: false, status: "error", text: "אין חיבור לנתונים" };
  const db = env.DB;
  const row = await db.prepare("SELECT * FROM assistant_pending WHERE id = ?").bind(id).first<{ id: number; tool: string; input: string; summary: string; status: string; result: string; created_at: string }>();
  if (!row || row.tool === "today_ship") return { ok: false, status: "not_found", text: "הפעולה לא נמצאה" };
  if (row.status === "done") return { ok: true, status: "done", text: row.result || "כבר בוצע" };
  if (row.status === "failed") return { ok: false, status: "failed", text: row.result || "הפעולה נכשלה ולא בוצעה" };
  if (row.status === "unknown") return { ok: false, status: "unknown", text: "הביצוע נקטע באמצע ולא ידוע אם נרשם. בדוק ביומן לפני שאתה מבקש שוב." };
  if (row.status !== "pending") return { ok: false, status: row.status, text: row.status === "cancelled" ? "הפעולה בוטלה" : row.status === "expired" ? "פג תוקף האישור, אמור שוב את הפקודה" : "הפעולה כבר בטיפול" };
  if (!approve) {
    const c = await db.prepare("UPDATE assistant_pending SET status = 'cancelled', decided_at = datetime('now') WHERE id = ? AND status = 'pending'").bind(id).run();
    if ((c.meta?.changes ?? 0) === 1) await saveBoardTurn(db, "assistant", `בוטל, לא בוצע: ${row.summary}`);
    return { ok: true, status: "cancelled", text: "בוטל, לא בוצע כלום" };
  }
  const fresh = await db.prepare(`UPDATE assistant_pending SET status = 'expired' WHERE id = ? AND status = 'pending' AND created_at < datetime('now', '-${PENDING_TTL_MIN} minutes')`).bind(id).run();
  if ((fresh.meta?.changes ?? 0) === 1) return { ok: false, status: "expired", text: "פג תוקף האישור, אמור שוב את הפקודה" };
  let input: Record<string, unknown> = {};
  try {
    input = JSON.parse(row.input) as Record<string, unknown>;
  } catch {
    // נשאר ריק, הכלי יחזיר שגיאה מסודרת
  }
  // תיקון של יוגב (שם, כמות, סכום) לפני האישור. נבדק לפני התפיסה: תיקון לא תקין
  // משאיר את הפעולה ממתינה, בלי לבצע כלום.
  let summary = row.summary;
  if (edits && Object.keys(edits).length) {
    const fixed = applyEdits(input, edits);
    if (!fixed.ok) return { ok: false, status: "pending", text: fixed.error };
    input = fixed.input;
    summary = summarizeToolCall(row.tool, input);
  }
  const claim = await db.prepare("UPDATE assistant_pending SET status = 'executing', decided_at = datetime('now'), input = ?, summary = ? WHERE id = ? AND status = 'pending'").bind(JSON.stringify(input), summary, id).run();
  if ((claim.meta?.changes ?? 0) !== 1) return { ok: false, status: "in_progress", text: "הפעולה כבר בטיפול" };
  row.summary = summary;
  const raw = await runTool(env, db, BOARD_CHAT_ID, row.tool, input);
  let okResult = false;
  try {
    okResult = (JSON.parse(raw) as { ok?: boolean }).ok === true;
  } catch {
    okResult = false;
  }
  const text = okResult ? `בוצע: ${row.summary}` : `לא בוצע (${raw.slice(0, 200)}): ${row.summary}`;
  await db.prepare("UPDATE assistant_pending SET status = ?, result = ? WHERE id = ?").bind(okResult ? "done" : "failed", text.slice(0, 600), id).run();
  await saveBoardTurn(db, "assistant", text);
  return { ok: okResult, status: okResult ? "done" : "failed", text };
}

async function askClaude(
  env: AssistantEnv,
  db: D1Database,
  chatId: number,
  history: HistoryRow[],
  userText: string,
  speaker: string,
  opts: { voice?: boolean; live?: boolean; lang?: "he" | "en"; pending?: PendingAction[]; trace?: LiveTrace; onStep?: (s: LiveStep) => void } = {},
): Promise<string> {
  const digest = await boardDigest(db);
  const goals = await goalsBlock(db);
  const finance =
    (await financeDigest(db, chatId)) + (goals ? `\n\nמצב היעדים והמכירות:\n${goals}` : "") + (await planPromptBlock(db).then((p) => (p ? `\n\n${p}` : "")).catch(() => ""));
  const team = await teamStatusForBruno(db);
  const jobs = await jobStatusForBruno(db).catch(() => "");
  const itemSales = await itemSalesBlock(db).catch(() => "");
  const seeding = (await seedingDigest()) + (itemSales ? `\n\n${itemSales}` : "") + (team ? `\n\n${team}` : "") + `\n\n${recipesPromptBlock(env)}\n\nעבודות ברקע (מהמערכת, לא מהזיכרון שלך):\n${jobs}`;
  const brandContext = (await getSetting(db, "brand_context")) ?? "";
  // הזיכרון של ברונו: עובדות פעילות מהטבלה (המחרוזת הישנה מיובאת פעם אחת כעובדות).
  const brandMemory = await memoryForPrompt(db, "bruno", "brand_memory", "fact");
  const competitorIntel = (await getSetting(db, "competitor_intel")) ?? "";
  const ownerContext = (await getSetting(db, "owner_context")) || OWNER_CONTEXT_DEFAULT;
  const messages: { role: string; content: unknown }[] = [
    ...history.map((h) => ({ role: h.role, content: h.content })),
    { role: "user", content: userText },
  ];

  let spokenSoFar = "";
  // חלונית "ברונו עובד": כל כלי הוא צעד (רץ → בוצע / נכשל / מחכה לאישור).
  let stepId = 0;
  const names = opts.onStep ? await workerNames(db).catch(() => ({}) as Record<string, string>) : {};
  const step = (s: Omit<LiveStep, "id"> & { id?: number }): number => {
    const id = s.id ?? ++stepId;
    try {
      opts.onStep?.({ ...s, id });
    } catch {
      // החלונית היא תצוגה בלבד; תקלה בה לא עוצרת את ברונו
    }
    return id;
  };
  const thinking = opts.onStep ? step({ label: "מבין מה ביקשת ובודק את הנתונים", state: "running" }) : 0;
  let thought = false;
  // המודל לפעמים מפעיל כלים ואז מסיים בלי מילה (יוגב קיבל "לא הצלחתי לנסח תשובה", 19.9).
  // במקרה כזה מבקשים ממנו פעם אחת לענות, בלי כלים.
  let nudged = false;
  for (let round = 0; round < 6; round++) {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": env.ANTHROPIC_API_KEY as string,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        // Sonnet 5 = עברית חזקה + שותף אסטרטגי אמיתי. חשיבה כבויה במפורש
        // כדי שלא תבלע את תקציב הטוקנים ותשאיר תשובה ריקה (הבאג ההוא).
        model: "claude-sonnet-5",
        max_tokens: 1500,
        thinking: { type: "disabled" },
        system: [
          ...systemPrompt(digest, finance, seeding, brandContext, brandMemory, competitorIntel, speaker, ownerContext),
          ...(opts.live ? [{ type: "text" as const, text: LIVE_MODE_PROMPT }] : []),
          ...(opts.live && opts.lang === "en" ? [{ type: "text" as const, text: LIVE_MODE_EN_PROMPT }] : []),
        ],
        // The 19 tool schemas never change between calls — cache them too
        // (a breakpoint on the last tool covers the whole tools array).
        tools: toolsFor(opts.live === true),
        ...(nudged ? { tool_choice: { type: "none" } } : {}),
        messages,
      }),
    });
    if (!res.ok) {
      console.error("assistant claude error", res.status, await res.text());
      return "😵 משהו השתבש אצלי בחיבור למוח. נסו שוב עוד רגע.";
    }
    const data = (await res.json()) as { content?: ContentBlock[]; stop_reason?: string };
    const blocks = data.content ?? [];
    if (!thought && thinking) {
      thought = true;
      step({ id: thinking, label: "מבין מה ביקשת ובודק את הנתונים", state: "done" });
    }
    const toolUses = blocks.filter((b): b is ToolUse => b.type === "tool_use");

    const text = blocks
      .filter((b) => b.type === "text" && b.text)
      .map((b) => b.text)
      .join("\n")
      .trim();
    if (data.stop_reason !== "tool_use" || toolUses.length === 0) {
      // המודל כתב את התשובה באותה הודעה שבה קרא לכלי (למשל כרטיס התוצאה), ואחרי
      // תוצאת הכלי לא הוסיף כלום: מחזירים את מה שכבר כתב, לא תשובה ריקה.
      if (text || spokenSoFar || nudged) return text || spokenSoFar;
      nudged = true;
      const ask = { type: "text", text: "ענה עכשיו ליוגב בקצרה, בלי כלים: מה עשית, מה מצאת, ומה הצעד הבא." };
      const last = messages[messages.length - 1];
      if (blocks.length) messages.push({ role: "assistant", content: blocks }, { role: "user", content: [ask] });
      else if (last?.role === "user" && Array.isArray(last.content)) last.content = [...(last.content as unknown[]), ask];
      else messages.push({ role: "user", content: [ask] });
      continue;
    }
    if (text) spokenSoFar = text;

    messages.push({ role: "assistant", content: blocks });
    const results = [] as { type: string; tool_use_id: string; content: string }[];
    for (const tu of toolUses) {
      if (opts.trace) {
        opts.trace.tools.push(tu.name);
        if (tu.name === "delegate" && typeof tu.input?.agent === "string") opts.trace.delegated.push(tu.input.agent);
        if (tu.name === "show_screen" && typeof tu.input?.tab === "string" && SCREEN_TABS.has(tu.input.tab)) opts.trace.show = tu.input.tab;
      }
      const label = stepLabel(tu.name, tu.input ?? {}, names);
      const worker = tu.name === "delegate" && typeof tu.input?.agent === "string" ? workerOfHat(tu.input.agent)?.key : undefined;
      const sid = opts.onStep ? step({ label, state: "running", worker }) : 0;
      const suspect = opts.voice && CONFIRM_ON_VOICE.has(tu.name) ? "" : await suspectSettlement(tu.name, tu.input ?? {});
      // פקודה קולית שמשנה כסף, מלאי או סטטוס הזמנה לא מבוצעת: היא נשמרת
      // כפעולה ממתינה, ויוגב מאשר בכפתור שמציג בדיוק מה ייעשה. האכיפה כאן,
      // בשרת, ולא רק במסך.
      const content =
        opts.voice && CONFIRM_ON_VOICE.has(tu.name)
          ? await holdForConfirmation(db, tu.name, tu.input ?? {}, speaker, opts.pending)
          : suspect
            ? await holdForConfirmation(db, tu.name, { ...(tu.input ?? {}), "חשד לכפילות": suspect }, speaker, opts.pending)
            : await runTool(env, db, chatId, tu.name, tu.input ?? {});
      if (opts.trace) {
        traceTool(opts.trace, tu.name, tu.input ?? {}, content);
        // "נשלח לטלפון" רק כשהשליחה באמת הצליחה.
        if (tu.name === "send_to_phone" && opts.trace.actions.at(-1)?.status === "done") opts.trace.pushed = true;
      }
      if (sid) {
        let parsed: Record<string, unknown> = {};
        try {
          parsed = JSON.parse(content) as Record<string, unknown>;
        } catch {
          parsed = {};
        }
        // מתכון שחסר לו פרט (ask) לא נכשל: ברונו שואל ומתחיל שוב. עבודה שהתחילה ברקע עוד לא "בוצעה".
        const state: LiveStep["state"] = parsed.pending_confirmation === true || parsed.ask || parsed.started === true ? "pending" : parsed.ok === false ? "failed" : "done";
        step({ id: sid, label: tu.name === "delegate" && state === "done" ? `${names[worker ?? ""] ?? "העובד"} סיים: ${short(tu.input?.task, 40)}` : label, state, worker });
      }
      results.push({ type: "tool_result", tool_use_id: tu.id, content });
    }
    messages.push({ role: "user", content: results });
  }
  return spokenSoFar || "עשיתי כמה פעולות אבל התבלבלתי בדרך — תבדקו את הלוח 🙈";
}

// ---- Webhook registration (runs inside the Durable Object: outbound fetch
// to Telegram is blocked in route handlers on this platform, but works from
// the DO) ----

// ---- Update handling ----

/** A receipt that made it into storage, kept in memory so it can also be read. */
type SavedReceipt = { id: number; bytes: ArrayBuffer; mime: string };

// ---- Reading the receipt itself ----

type ReceiptRead = {
  is_receipt?: boolean;
  amount?: number | null;
  vat?: number | null;
  tax_id?: string | null;
  vendor?: string;
  date?: string | null;
  category?: string;
  confidence?: string;
};

/** btoa needs a binary string; chunked so a big photo can't blow the stack. */
function toBase64(bytes: ArrayBuffer): string {
  const view = new Uint8Array(bytes);
  let binary = "";
  for (let i = 0; i < view.length; i += 0x8000) {
    binary += String.fromCharCode(...view.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

/**
 * Asks Claude what the receipt says. Returns null whenever the answer cannot
 * be trusted (not an image, no key, unreadable) — the caller then falls back
 * to asking the partner for the amount, which is what happened before.
 */
async function readReceiptImage(
  env: AssistantEnv,
  categories: string[],
  saved: SavedReceipt,
): Promise<ReceiptRead | null> {
  // PDFs and anything exotic stay manual; the vision block takes real images.
  if (!env.ANTHROPIC_API_KEY || !/^image\/(jpeg|png|webp|gif)$/.test(saved.mime)) return null;
  const prompt =
    "בתמונה הזאת אמורה להיות קבלה או חשבונית של עסק ישראלי. החזר JSON בלבד, בלי שום טקסט מסביב, במבנה:\n" +
    '{"is_receipt": true/false, "amount": מספר או null, "vat": מספר או null, "tax_id": "מספר עוסק/ח.פ" או null, "vendor": "שם בית העסק", "date": "YYYY-MM-DD" או null, "category": "אחת מהרשימה", "confidence": "high" או "low"}\n' +
    'amount = הסכום הסופי לתשלום, כולל מע"מ (השורה "סה"כ לתשלום"/"סה"כ"), לא סכום ביניים ולא המע"מ בנפרד. מספר בלבד, בלי ₪.\n' +
    'vat = סכום המע"מ אם הוא כתוב בקבלה במפורש, אחרת null. אל תחשב אותו בעצמך.\n' +
    "tax_id = מספר עוסק מורשה / ח.פ של בית העסק אם מופיע, אחרת null.\n" +
    `category חייבת להיות אחת מאלה בדיוק: ${categories.join(" | ")} — ואם שום אחת לא מתאימה: אחר.\n` +
    'confidence = "high" רק אם הסכום הסופי קריא בבירור בתמונה. אם מטושטש, חתוך, מסופק, או שזו בכלל לא קבלה — "low".\n' +
    "אל תנחש סכום. עדיף low מאשר מספר שגוי.";
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": env.ANTHROPIC_API_KEY as string,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-5",
        max_tokens: 400,
        thinking: { type: "disabled" },
        messages: [
          {
            role: "user",
            content: [
              { type: "image", source: { type: "base64", media_type: saved.mime, data: toBase64(saved.bytes) } },
              { type: "text", text: prompt },
            ],
          },
        ],
      }),
    });
    if (!res.ok) {
      console.error("receipt vision error", res.status, await res.text());
      return null;
    }
    const data = (await res.json()) as { content?: { type?: string; text?: string }[] };
    const text = (data.content ?? []).find((b) => b.type === "text")?.text ?? "";
    const json = text.match(/\{[\s\S]*\}/);
    return json ? (JSON.parse(json[0]) as ReceiptRead) : null;
  } catch (error) {
    console.error("receipt vision failed", error);
    return null;
  }
}

/**
 * The whole point of photographing a receipt: it files itself. Reads the
 * paper, writes the expense, attaches the image to it, and says out loud what
 * it recorded so a wrong reading is caught immediately. Anything less than a
 * confident reading falls back to asking — never a guessed number.
 */
async function fileReceiptAutomatically(
  env: AssistantEnv,
  db: D1Database,
  speaker: string,
  saved: SavedReceipt,
): Promise<{ text: string; status: string }> {
  const cats = await db
    .prepare("SELECT category FROM fin_budgets ORDER BY position, category")
    .all<{ category: string }>();
  const categories = (cats.results ?? []).map((c) => c.category);
  const read = await readReceiptImage(env, categories, saved);
  const amount = typeof read?.amount === "number" && read.amount > 0 ? Math.round(read.amount * 100) / 100 : 0;
  // לא קבלה בכלל (צילום מסך של רילז, מודעה או בגד של מותג אחר): זה רפרנס
  // קריאייטיבי. מעבירים לכובע התוכן של הקריאייטיב עם התמונה, ומוחקים את
  // רשומת הקבלה היתומה כדי שלא תחכה לשיוך בטאב הכספים.
  if (read && read.is_receipt === false && /^image\/(jpeg|png|webp|gif)$/.test(saved.mime) && saved.bytes.byteLength <= 4_500_000) {
    const result = await runAgent(env, "content", {
      trigger: "command",
      command:
        "יוגב שלח לברונו תמונה (מצורפת). זו לא קבלה. קודם זהה אם זה חומר של SEGULA עצמה או של מותג אחר. תאר בקצרה מה רואים (רילז / מודעה / פריט / עיצוב), מה עובד שם ולמה, ואיך SEGULA עושה גרסה משלה בתוך THE DREAMER: אם זה תוכן, תסריט מלא מוכן לצילום; אם זה עיצוב או בגד, רפרנס מסודר לדרופ הבא (מה לקחת, מה לא). אל תפתח הכרעה אלא אם יש צעד ברור לשבוע הזה.",
      research: false,
      images: [{ mime: saved.mime, b64: toBase64(saved.bytes), label: "צילום מסך מיוגב" }],
    });
    if (result.ok) {
      await deleteReceipt(saved.id).catch(() => {});
      return {
        text: `🎨 זו לא קבלה, אז העברתי לקריאייטיב:\n\n${result.report ?? result.summary ?? ""}${result.decisions ? "\n\nפתחתי לך הכרעה על זה למעלה." : ""}`.slice(0, 3800),
        status: `image routed to creative (receipt ${saved.id} removed)`,
      };
    }
  }
  if (!read?.is_receipt || !amount || read.confidence !== "high") {
    return {
      text: "📎 קיבלתי את הקבלה ושמרתי אותה, אבל לא הצלחתי לקרוא ממנה סכום בוודאות. כמה זה היה? (סכום + קטגוריה, למשל \"305 אריזה ומיתוג\") ואצרף אותה מיד.",
      status: `receipt ${saved.id} saved, unreadable`,
    };
  }
  const today = ilTodayISO();
  // A date from the paper is better than today, but only when it is sane:
  // a misread year must not file the expense into a different month.
  const onPaper = typeof read.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(read.date) ? read.date : "";
  const yearAgo = new Date(Date.now() - 365 * 864e5).toISOString().slice(0, 10);
  const date = onPaper && onPaper <= today && onPaper >= yearAgo ? onPaper : today;
  const category = categories.includes(read.category ?? "") ? (read.category as string) : "אחר";
  const vendor = (read.vendor ?? "").trim().slice(0, 60);
  const payer = speaker === "יוגב" ? "yogev" : "business";
  // The same receipt sent twice must not become two expenses.
  const twin = await db
    .prepare(
      "SELECT id FROM fin_expenses WHERE amount = ? AND date = ? AND created_at >= datetime('now', '-30 minutes') LIMIT 1",
    )
    .bind(amount, date)
    .first<{ id: number }>();
  if (twin) {
    return {
      text: `📎 קיבלתי קבלה על ${amount} ₪${vendor ? ` מ-${vendor}` : ""} — אבל כבר רשומה הוצאה זהה מהדקות האחרונות, אז לא רשמתי פעמיים. אם זו באמת הוצאה נוספת תכתוב לי "כן, תרשום ${amount} ${category}".`,
      status: `receipt ${saved.id} saved, duplicate of expense ${twin.id}`,
    };
  }
  // VAT is kept only when it is a sane slice of the total — a misread line
  // ("סה\"כ" caught twice) must not turn into a bogus tax figure.
  const vat = typeof read.vat === "number" && read.vat > 0 && read.vat < amount * 0.5 ? Math.round(read.vat * 100) / 100 : 0;
  const taxId = (read.tax_id ?? "").replace(/\D/g, "").slice(0, 15);
  try {
    const expense = await addExpense({ date, payer, category, description: vendor, amount, paidFrom: "", vat, taxId });
    await attachReceipt(saved.id, expense.id);
    // An unknown category would otherwise be missing from the tab's dropdown.
    await db
      .prepare("INSERT OR IGNORE INTO fin_budgets (category, amount, position) VALUES (?, 0, 99)")
      .bind(category)
      .run();
    const he = `${date.slice(8)}/${date.slice(5, 7)}`;
    return {
      text:
        `📎 רשמתי: ${amount} ₪ · ${category}${vendor ? ` · ${vendor}` : ""} · ${he}${vat ? ` · מע"מ ${vat} ₪` : ""} — והקבלה מצורפת להוצאה.\n` +
        "לא נכון? תגיד לי מה לתקן (למשל \"זה היה 350\") ואני מתקן.",
      status: `receipt ${saved.id} filed as expense ${expense.id}`,
    };
  } catch (error) {
    console.error("auto file receipt failed", error);
    return {
      text: `📎 קראתי מהקבלה ${amount} ₪ אבל לא הצלחתי לרשום את ההוצאה. תכתוב לי "${amount} ${category}" ואני ארשום ואצרף.`,
      status: `receipt ${saved.id} saved, insert failed`,
    };
  }
}

/**
 * Records "a receipt arrived" as a turn of the conversation, so the brain sees
 * it like any other message. Both sides are written to keep the roles
 * alternating, and a failure here must never cost the partners their receipt.
 */
async function rememberReceiptTurn(
  db: D1Database,
  chatId: number,
  speaker: string,
  answer: string,
  saved: boolean,
): Promise<void> {
  try {
    await saveTurn(db, chatId, "user", `${speaker}: [שלח תמונת קבלה — ${saved ? "התקבלה ונשמרה" : "השמירה נכשלה"}]`);
    await saveTurn(db, chatId, "assistant", answer);
  } catch (error) {
    console.error("receipt history save failed", error);
  }
}

// ---- Board chat: the in-board "ברונו" tab ----
//
// Telegram banned the Segula community (Aug 19, 2026), so the board itself is
// now Bruno's front door: same brain, same tools, same assistant_chat history
// table — just no messaging platform in the path. The only way in is the
// board's authed session, so no stranger can ever talk to (or report) him.

/** Chat key for the board thread in assistant_chat. The historical Telegram
 *  ids were 9+ digits (groups negative), so 1 never collided with one. */
export const BOARD_CHAT_ID = 1;

const NO_BRAIN_TEXT =
  "🧠 המוח שלי עדיין לא חובר (חסר מפתח Anthropic API). " +
  "ברגע שהמפתח יוגדר אענה כאן על הכול.";

/** The board thread keeps a longer scrollback than the Telegram chats: it is
 *  the partners' only window into past automated messages and answers. */
const BOARD_HISTORY_KEEP = 200;

export type BoardChatRow = { id: number; role: string; content: string; created_at: string };

export async function boardChatHistory(
  db: D1Database,
  limit = 80,
  afterId = 0,
): Promise<BoardChatRow[]> {
  const res = await db
    .prepare(
      "SELECT id, role, content, created_at FROM assistant_chat WHERE chat_id = ? AND id > ? ORDER BY id DESC LIMIT ?",
    )
    .bind(BOARD_CHAT_ID, afterId, limit)
    .all<BoardChatRow>();
  return (res.results ?? []).reverse();
}

/** saveTurn prunes to HISTORY_KEEP (30) — fine for Telegram, too short for the
 *  board's visible scrollback. Board turns are saved directly with a deeper
 *  prune; Claude still only receives the last HISTORY_SEND turns. */
async function saveBoardTurn(
  db: D1Database,
  role: "user" | "assistant",
  content: string,
): Promise<void> {
  await db
    .prepare("INSERT INTO assistant_chat (chat_id, role, content) VALUES (?, ?, ?)")
    .bind(BOARD_CHAT_ID, role, content.slice(0, 4000))
    .run();
  await db
    .prepare(
      "DELETE FROM assistant_chat WHERE chat_id = ? AND id NOT IN (SELECT id FROM assistant_chat WHERE chat_id = ? ORDER BY id DESC LIMIT ?)",
    )
    .bind(BOARD_CHAT_ID, BOARD_CHAT_ID, BOARD_HISTORY_KEEP)
    .run();
}

/**
 * A receipt photographed straight into the board chat — the Telegram flow's
 * successor. Saves the image to R2 as a pending receipt, runs the same vision
 * filing pipeline (reads the paper, writes the expense, attaches the photo),
 * and records both sides of the exchange in the board thread.
 */
export async function handleBoardReceipt(
  env: AssistantEnv,
  bytes: ArrayBuffer,
  mime: string,
  actor: string,
): Promise<{ answer: string; status: string }> {
  if (!env.DB) return { answer: "😵 אין חיבור לנתונים — נסו לרענן.", status: "error: no db" };
  // יוגב הוא המשתמש היחיד בלוח (27.9).
  const speaker = "יוגב";
  let saved: SavedReceipt | null = null;
  try {
    const id = await addReceipt({
      expenseId: null,
      bytes,
      mime,
      source: "board-chat",
      chatId: String(BOARD_CHAT_ID),
    });
    saved = { id, bytes, mime };
  } catch (error) {
    console.error("board receipt save failed", error);
  }
  const filed = saved
    ? await fileReceiptAutomatically(env, env.DB, speaker, saved)
    : {
        text: "😵 לא הצלחתי לשמור את הקבלה. נסו לצלם שוב — ואם זה חוזר, תרשמו את ההוצאה ידנית בינתיים.",
        status: "board receipt save failed",
      };
  try {
    await saveBoardTurn(env.DB, "user", `${speaker}: [שלח תמונת קבלה — ${saved ? "התקבלה ונשמרה" : "השמירה נכשלה"}]`);
    await saveBoardTurn(env.DB, "assistant", filed.text);
  } catch (error) {
    console.error("board receipt history save failed", error);
  }
  return { answer: filed.text, status: filed.status };
}

export async function handleBoardChat(
  env: AssistantEnv,
  text: string,
  actor: string,
  opts: { voice?: boolean; live?: boolean; lang?: "he" | "en"; onStep?: (s: LiveStep) => void } = {},
): Promise<{ answer: string; status: string; pending?: PendingAction[]; trace?: LiveTrace }> {
  if (!env.DB) return { answer: "😵 אין חיבור לנתונים — נסו לרענן.", status: "error: no db" };
  if (!env.ANTHROPIC_API_KEY) return { answer: NO_BRAIN_TEXT, status: "replied: no-brain notice" };
  const pending: PendingAction[] = [];
  const trace = newLiveTrace();
  // יוגב הוא המשתמש היחיד בלוח (27.9).
  const speaker = "יוגב";
  const history = await loadHistory(env.DB, BOARD_CHAT_ID);
  const userTurn = `${speaker}: ${text}`;
  let answer: string;
  try {
    answer = await askClaude(env, env.DB, BOARD_CHAT_ID, history, userTurn, speaker, { voice: opts.voice, live: opts.live, lang: opts.lang, pending, trace, onStep: opts.onStep });
  } catch (error) {
    console.error("board chat error", error);
    answer = "😵 משהו השתבש אצלי. נסו שוב עוד רגע.";
  }
  if (!answer) answer = "🤔 לא הצלחתי לנסח תשובה — נסו לנסח אחרת.";
  // Save the user turn even if the answer errored — the thread is the record.
  try {
    await saveBoardTurn(env.DB, "user", userTurn);
    await saveBoardTurn(env.DB, "assistant", answer);
  } catch (error) {
    console.error("board chat history save failed", error);
  }
  return { answer, status: `board answered: ${answer.slice(0, 40)}`, pending, trace };
}
