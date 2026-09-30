// הובי: העוזרת הדיגיטלית של hob. עונה לשתי השותפות בטאב "הובי" עם Claude ועם
// ההקשר המלא של הלוח, ופועלת דרך כלים (משימות, מלאי, מכירות, הוצאות, תזכורות).
// הדלת היחידה אליה היא צ'אט הלוח (handleBoardChat), אחרי אימות הסשן.
import type { D1Database } from "@cloudflare/workers-types";
import {
  addExpense,
  addReceipt,
  addSettlement,
  attachReceipt,
  claimPendingReceipt,
  deleteExpense,
  deleteReceipt,
  getFinance,
  IS_PROVIDER,
  pendingReceipts,
  settlementSuspicion,
  updateExpense,
} from "./finance.server";
import { moneySnapshot } from "./finance.summary.server";
import { collabFunnelLine } from "./collab.server";
import { pushNotify } from "./push.server";
import { addReminder } from "./reminders.server";
import { addGift, addItem, addSale, getSeeding, receiveStock, transferStock, updateSale } from "./seeding.server";
import { addTask, updateTask } from "./hob.server";
import { buildVariantMap, drainShopifyPushQueue, shopifyQuickStats } from "./shopify.server";
import { isPartner, LOCATIONS, OWNERS, PARTNER, PARTNERS, partnerLabel, PAYERS } from "./partners";
import { addMemory, forget, memoryForPrompt } from "./memory.server";

export type AssistantEnv = {
  DB?: D1Database;
  ANTHROPIC_API_KEY?: string;
  SHOPIFY_CLIENT_ID?: string;
  SHOPIFY_CLIENT_SECRET?: string;
  VAPID_PRIVATE_JWK?: string;
};

const MAIN_MODEL = "claude-sonnet-5";
const HISTORY_SEND = 12; // turns sent to Claude
const BOARD_HISTORY_KEEP = 200; // rows kept in the board thread
const WEEKDAY_NAMES = ["ראשון", "שני", "שלישי", "רביעי", "חמישי", "שישי", "שבת"];

/** Chat key for the board thread in assistant_chat. */
export const BOARD_CHAT_ID = 1;

const SCREEN_TABS = ["shared", "avia", "lior", "stock", "finance", "collab", "hobi", "settings"] as const;
const TAB_HE: Record<string, string> = { shared: "משותף", avia: "המשימות של אביה", lior: "המשימות של ליאור", stock: "מלאי", finance: "כספים", collab: "משפיעניות", hobi: "הובי", settings: "הגדרות" };
const SCREEN_TAB_SET = new Set<string>(SCREEN_TABS);

// ---- Settings ----

export async function getSetting(db: D1Database, key: string): Promise<string | null> {
  const row = await db.prepare("SELECT value FROM settings WHERE key = ?").bind(key).first<{ value: string }>();
  return row?.value ?? null;
}

export async function putSetting(db: D1Database, key: string, value: string): Promise<void> {
  await db
    .prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .bind(key, value)
    .run();
}

// ---- Israel time (DST-safe via Intl) ----

export function ilOffsetMs(date = new Date()): number {
  const fmt = new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Jerusalem", timeZoneName: "shortOffset" });
  const tz = fmt.formatToParts(date).find((p) => p.type === "timeZoneName")?.value ?? "GMT+2";
  const m = tz.match(/GMT([+-]\d+)(?::(\d+))?/);
  const h = m ? parseInt(m[1], 10) : 2;
  const mm = m && m[2] ? parseInt(m[2], 10) : 0;
  return (h * 60 + (h < 0 ? -mm : mm)) * 60000;
}

export function ilTodayISO(date = new Date()): string {
  const c = new Date(date.getTime() + ilOffsetMs(date));
  return `${c.getUTCFullYear()}-${`${c.getUTCMonth() + 1}`.padStart(2, "0")}-${`${c.getUTCDate()}`.padStart(2, "0")}`;
}

// ---- The speaker ----

/** The partner label for the prompt and the history lines; a stranger is "שותפה". */
export function speakerLabel(actor: string): string {
  return isPartner(actor) ? PARTNER[actor].label : "שותפה";
}

/** Payer / location default: the speaker herself, never a stranger's key. */
function partnerOr(actor: string, fallback: string): string {
  return isPartner(actor) ? actor : fallback;
}

// ---- Chat history (D1) ----

type HistoryRow = { role: string; content: string };

/** השורות האחרונות של הצ'אט, לתשובה המיידית (הקשר קצר). */
export async function recentBoardHistory(db: D1Database | undefined, n = 4): Promise<HistoryRow[]> {
  if (!db) return [];
  const rows = await loadHistory(db, BOARD_CHAT_ID);
  return rows.slice(-n);
}

async function loadHistory(db: D1Database, chatId: number): Promise<HistoryRow[]> {
  try {
    const res = await db
      .prepare(
        // kind='note' rows are board notifications (text typed by strangers:
        // signups, buyers): shown in the chat, never replayed to the model.
        "SELECT role, content FROM assistant_chat WHERE chat_id = ? AND kind = '' ORDER BY id DESC LIMIT ?",
      )
      .bind(chatId, HISTORY_SEND)
      .all<HistoryRow>();
    return (res.results ?? []).reverse();
  } catch (error) {
    console.error("assistant history load failed", error);
    return [];
  }
}

export type BoardChatRow = { id: number; role: string; content: string; kind: string; actor: string; created_at: string };

export async function boardChatHistory(db: D1Database, limit = 80, afterId = 0): Promise<BoardChatRow[]> {
  const res = await db
    .prepare("SELECT id, role, content, kind, actor, created_at FROM assistant_chat WHERE chat_id = ? AND id > ? ORDER BY id DESC LIMIT ?")
    .bind(BOARD_CHAT_ID, afterId, limit)
    .all<BoardChatRow>();
  return (res.results ?? []).reverse();
}

/** Rows newer than `afterId` that the viewer did not write herself (the badge on the tab). */
export async function unreadCount(db: D1Database, afterId: number, actor = ""): Promise<number> {
  const row = await db
    .prepare("SELECT COUNT(*) AS n FROM assistant_chat WHERE chat_id = ? AND id > ? AND NOT (role = 'user' AND actor = ?)")
    .bind(BOARD_CHAT_ID, afterId, actor)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

async function saveBoardTurn(db: D1Database, role: "user" | "assistant", content: string, actor = ""): Promise<void> {
  await db
    .prepare("INSERT INTO assistant_chat (chat_id, role, content, actor) VALUES (?, ?, ?, ?)")
    .bind(BOARD_CHAT_ID, role, content.slice(0, 4000), actor)
    .run();
  await db
    .prepare("DELETE FROM assistant_chat WHERE chat_id = ? AND id NOT IN (SELECT id FROM assistant_chat WHERE chat_id = ? ORDER BY id DESC LIMIT ?)")
    .bind(BOARD_CHAT_ID, BOARD_CHAT_ID, BOARD_HISTORY_KEEP)
    .run();
}

// ---- Digests for the system prompt ----

/** Shape-agnostic trimming of another module's data: arrays capped, strings
 *  capped, depth capped. The other modules are free to change their shapes
 *  without breaking the prompt. */
function compact(value: unknown, depth = 0, maxItems = 40): unknown {
  if (depth > 5) return undefined;
  if (Array.isArray(value)) return value.slice(0, maxItems).map((v) => compact(v, depth + 1, maxItems));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (v === undefined || typeof v === "function") continue;
      out[k] = compact(v, depth + 1, maxItems);
    }
    return out;
  }
  if (typeof value === "string") return value.length > 200 ? `${value.slice(0, 200)}…` : value;
  return value;
}

type DigestTask = { id: number; title: string; notes?: string; status: string; priority?: string; owner?: string; due?: string; updated?: string };

/** לוח המשימות: קבוצות לפי view (shared/avia/lior) עם המשימות שלהן, כולל מזהים לכלים. */
async function boardDigest(db: D1Database): Promise<string> {
  try {
    const groups = await db.prepare("SELECT id, view, title FROM board_groups ORDER BY position, id").all<{ id: number; view: string; title: string }>();
    const tasks = await db
      .prepare("SELECT id, group_id, title, notes, status, priority, owner, due_date, updated_at FROM tasks WHERE status <> 'archived'")
      .all<{ id: number; group_id: number; title: string; notes: string; status: string; priority: string; owner: string; due_date: string; updated_at: string }>();
    const byGroup = new Map<number, DigestTask[]>();
    for (const t of tasks.results ?? []) {
      const list = byGroup.get(t.group_id) ?? [];
      list.push({ id: t.id, title: t.title, notes: t.notes || undefined, status: t.status, priority: t.priority || undefined, owner: t.owner || undefined, due: t.due_date || undefined, updated: t.updated_at });
      byGroup.set(t.group_id, list);
    }
    return JSON.stringify((groups.results ?? []).map((g) => ({ group_id: g.id, view: g.view, group: g.title, tasks: byGroup.get(g.id) ?? [] })));
  } catch (error) {
    console.error("board digest failed", error);
    return "[]";
  }
}

/** מלאי, חלוקות ומכירות אחרונות, מהמודול של המלאי (כמו שהוא כרגע). */
async function stockDigest(): Promise<string> {
  try {
    const s = (await getSeeding()) as unknown as Record<string, unknown>;
    const items = Array.isArray(s.items) ? s.items : [];
    const gifts = Array.isArray(s.gifts) ? s.gifts : [];
    const sales = Array.isArray(s.sales) ? s.sales : [];
    const today = ilTodayISO();
    const todaySales = sales.filter((x) => (x as { sold_at?: string }).sold_at === today);
    return JSON.stringify({
      stock_locations: Object.fromEntries(LOCATIONS.map((l) => [l, `אצל ${PARTNER[l].label}`])),
      inventory: compact(items, 0, 80),
      recent_gifts: compact(gifts.slice(0, 12)),
      recent_sales: compact(sales.filter((x) => (x as { channel?: string }).channel !== "archive").slice(0, 12)),
      open_orders: compact(
        sales
          .filter((x) => {
            const st = (x as { ship_status?: string }).ship_status || "recorded";
            return st !== "delivered" && st !== "cancelled";
          })
          .slice(0, 30),
      ),
      today: { sales_count: todaySales.length, revenue: todaySales.reduce((sum, x) => sum + Number((x as { price?: number }).price ?? 0) * Number((x as { qty?: number }).qty ?? 1), 0) },
    });
  } catch (error) {
    console.error("stock digest failed", error);
    return JSON.stringify({ error: "המלאי לא נטען" });
  }
}

/** תמונת הכספים: הוצאות ותקציבים מהמודול הפיננסי, תמונת הכסף, קבלות שממתינות, ופטור ממע"מ. */
export async function financeDigest(db: D1Database, chatId: number = BOARD_CHAT_ID): Promise<string> {
  const out: Record<string, unknown> = {};
  try {
    const fin = (await getFinance()) as unknown as Record<string, unknown>;
    const expenses = Array.isArray(fin.expenses) ? fin.expenses : [];
    out.recent_expenses = compact(expenses.slice(0, 8));
    out.budgets = compact(fin.budgets ?? []);
    const rest: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(fin)) if (k !== "expenses" && k !== "budgets" && k !== "receipts") rest[k] = compact(v, 0, 12);
    out.finance = rest;
  } catch {
    out.finance = { error: "יומן הכספים לא נטען. אל תמסרי מספר של הוצאות." };
  }
  try {
    out.money = compact(await moneySnapshot(db), 0, 12);
  } catch {
    out.money = { error: "תמונת הכסף לא נטענה. אל תמסרי יתרה." };
  }
  try {
    const waiting = await pendingReceipts(String(chatId));
    out.pending_receipts = { count: waiting.length, ids: waiting.slice(0, 5).map((r) => r.id) };
  } catch {
    out.pending_receipts = { count: 0 };
  }
  try {
    out.vat_exempt = ((await getSetting(db, "vat_exempt")) ?? "1") === "1";
  } catch {
    out.vat_exempt = true;
  }
  return JSON.stringify(out);
}

async function collabLine(): Promise<string> {
  try {
    return await collabFunnelLine();
  } catch {
    return "";
  }
}

// ---- Shipping status (one order, with evidence) ----

export type ShipUpdate =
  | { ok: true; buyer: string; status: string; updated_lines: number; ids: number[] }
  | { ok: false; error: string; ambiguous?: true; orders?: { ref: string; lines: number; status: string; sold_at: string }[] };

const SHIP_STATUSES = new Set(["recorded", "packed", "shipped", "delivered"]);

/** עדכון משלוח להזמנה אחת של קונה. "נשלח"/"התקבל" רק עם מספר הזמנה או ראיה (מספר מעקב,
 *  שליח, למי נמסר ביד), והראיה נשמרת בהערה. כמה הזמנות פתוחות בלי ref = שאלה, לא ניחוש. */
export async function updateShipStatus(input: Record<string, unknown>): Promise<ShipUpdate> {
  const buyer = typeof input.buyer === "string" ? input.buyer.trim() : "";
  const status = typeof input.status === "string" && SHIP_STATUSES.has(input.status) ? input.status : "";
  if (!buyer || !status) return { ok: false, error: "missing buyer/status" };
  const refRaw = typeof input.ref === "string" ? input.ref.trim() : "";
  const ref = refRaw ? `#${refRaw.replace(/^.*?#?(\d{3,6})\s*$/, "$1")}` : "";
  const evidence = typeof input.evidence === "string" ? input.evidence.trim().slice(0, 200) : "";
  if ((status === "shipped" || status === "delivered") && !ref && !evidence) {
    return { ok: false, error: `לא סומן "${status}": צריך מספר הזמנה (ref) או ראיה (evidence: מספר מעקב, שליח, למי נמסר ביד). שאלי.` };
  }
  type Line = { id: number; buyer: string; order_ref?: string | null; note?: string | null; ship_status: string; sold_at: string; channel?: string };
  let rows: Line[];
  try {
    const s = (await getSeeding()) as unknown as { sales?: Line[] };
    rows = (s.sales ?? []).filter((r) => (r.buyer ?? "").trim() === buyer && r.ship_status !== "cancelled" && (r.channel ?? "") !== "archive");
  } catch {
    return { ok: false, error: "יומן המכירות לא נטען" };
  }
  if (!rows.length) return { ok: false, error: "buyer not found" };
  const keyOf = (r: Line): string => {
    const fromRef = (r.order_ref ?? "").trim();
    const fromNote = (r.note ?? "").match(/#(\d{3,6})/)?.[1] ?? "";
    return fromRef ? (fromRef.startsWith("#") ? fromRef : `#${fromRef}`) : fromNote ? `#${fromNote}` : `row:${r.id}`;
  };
  const groups = new Map<string, Line[]>();
  for (const r of rows) {
    const k = keyOf(r);
    groups.set(k, [...(groups.get(k) ?? []), r]);
  }
  const describe = (k: string, lines: Line[]) => ({ ref: k.startsWith("row:") ? "" : k, lines: lines.length, status: lines[0].ship_status, sold_at: (lines[0].sold_at ?? "").slice(0, 10) });
  let target: [string, Line[]] | undefined;
  if (ref) {
    target = [...groups.entries()].find(([k]) => k === ref);
    if (!target) return { ok: false, error: `אין הזמנה ${ref} של ${buyer}. ההזמנות: ${[...groups.entries()].map(([k, l]) => describe(k, l).ref || "בלי מספר").join(", ")}` };
  } else {
    const open = [...groups.entries()].filter(([, l]) => l.some((x) => x.ship_status !== "delivered" && x.ship_status !== status));
    if (open.length > 1) return { ok: false, ambiguous: true, error: "לקונה כמה הזמנות פתוחות, צריך מספר הזמנה", orders: open.map(([k, l]) => describe(k, l)) };
    target = open[0] ?? [...groups.entries()][0];
  }
  const [, lines] = target;
  const ids = lines.map((l) => l.id);
  for (const l of lines) {
    const note = (l.note ?? "").trim();
    const mark = evidence ? `נשלח: ${evidence}` : "";
    const patch: { ship_status: string; note?: string } = { ship_status: status };
    if (mark && !note.includes(mark)) patch.note = note ? `${note} · ${mark}` : mark;
    await updateSale(l.id, patch);
  }
  return { ok: true, buyer, status, updated_lines: ids.length, ids };
}

// ---- Claude tools ----

const TOOLS = [
  {
    name: "add_task",
    description:
      "מוסיפה משימה ללוח. group_id מתוך הקבוצות בבלוק 'מצב הלוח' (לפי view: shared=משותף, avia=אביה, lior=ליאור). אם לא צוין לאיזו קבוצה, שלחי view במקום group_id ואבחר את הקבוצה הראשונה של ה-view.",
    input_schema: {
      type: "object",
      properties: {
        title: { type: "string", description: "כותרת המשימה בעברית" },
        group_id: { type: "number", description: "מזהה הקבוצה מהלוח" },
        view: { type: "string", enum: ["shared", "avia", "lior"], description: "במקום group_id: לאיזה לוח" },
        notes: { type: "string" },
        owner: { type: "string", enum: [...OWNERS], description: "'' = אין, avia, lior, both = שתיהן" },
        priority: { type: "string", enum: ["high", "medium", "low"] },
        due_date: { type: "string", description: "YYYY-MM-DD" },
      },
      required: ["title"],
    },
  },
  {
    name: "update_task",
    description: "מעדכנת משימה קיימת לפי id מהלוח: סטטוס (not_started/working/stuck/done/archived), כותרת, הערות, אחראית, עדיפות, תאריך יעד, או העברה לקבוצה אחרת.",
    input_schema: {
      type: "object",
      properties: {
        id: { type: "number", description: "מזהה המשימה מהלוח" },
        title: { type: "string" },
        notes: { type: "string" },
        status: { type: "string", enum: ["not_started", "working", "stuck", "done", "archived"] },
        owner: { type: "string", enum: [...OWNERS] },
        priority: { type: "string", enum: ["high", "medium", "low"] },
        due_date: { type: "string", description: "YYYY-MM-DD, ריק למחיקת התאריך" },
        group_id: { type: "number" },
      },
      required: ["id"],
    },
  },
  {
    name: "remember",
    description:
      "שומרת עובדה בזיכרון הקבוע של המותג (לכל השיחות). השתמשי כשמבקשות לזכור משהו או כשמדווחות עדכון עסקי חשוב: תאריכים, החלטות, ספקים, מחירים, אירועים. נסחי קצר וברור.",
    input_schema: { type: "object", properties: { fact: { type: "string", description: "העובדה, משפט אחד או שניים" } }, required: ["fact"] },
  },
  {
    name: "forget",
    description: "מוחקת עובדה מהזיכרון לפי המזהה (#id) שמופיע בבלוק הזיכרון. השתמשי כשמבקשות לשכוח או כשעובדה התיישנה והוחלפה בחדשה.",
    input_schema: { type: "object", properties: { id: { type: "number", description: "מזהה העובדה" } }, required: ["id"] },
  },
  {
    name: "log_gift",
    description:
      "רושמת חלוקה של פריט למשפיענית או לחברה ומורידה מהמלאי. item_id מתוך המלאי המצורף לפי שם ומידה. אין פריט תואם: אל תנחשי, אמרי מה יש ושאלי.",
    input_schema: {
      type: "object",
      properties: {
        item_id: { type: "number" },
        person: { type: "string", description: "שם מקבלת הפריט" },
        handle: { type: "string", description: "יוזר אינסטגרם בלי @, אם צוין" },
        kind: { type: "string", enum: ["influencer", "friend", "other"] },
        qty: { type: "number", description: "ברירת מחדל 1" },
        size: { type: "string", description: "המידה שנלקחה, אם צוינה" },
        location: { type: "string", enum: [...LOCATIONS], description: "מאיפה יצא: avia = אצל אביה, lior = אצל ליאור. ברירת מחדל: מי שכותבת" },
        note: { type: "string" },
        given_at: { type: "string", description: "YYYY-MM-DD, ברירת מחדל היום" },
      },
      required: ["item_id", "person"],
    },
  },
  {
    name: "log_sale",
    description: "רושמת מכירה ידנית (מחוץ לאתר) ומורידה מהמלאי. item_id מהמלאי המצורף; price = מחיר ליחידה בש\"ח. בלי מחיר ובלי מחיר מוגדר לפריט: שאלי.",
    input_schema: {
      type: "object",
      properties: {
        item_id: { type: "number" },
        buyer: { type: "string", description: "שם הקונה" },
        qty: { type: "number", description: "ברירת מחדל 1" },
        size: { type: "string" },
        location: { type: "string", enum: [...LOCATIONS], description: "מאיפה יצא. ברירת מחדל: מי שכותבת" },
        price: { type: "number", description: "מחיר ליחידה בש\"ח" },
        pay_method: { type: "string", enum: ["shopify", "bit", "cash", "transfer"], description: "איך שילמו. לא צוין: bit" },
        note: { type: "string" },
        sold_at: { type: "string", description: "YYYY-MM-DD, ברירת מחדל היום" },
      },
      required: ["item_id", "buyer", "price"],
    },
  },
  {
    name: "add_inventory",
    description: "מוסיפה פריט למלאי או מגדילה כמות של פריט קיים (אותו שם ומידה מתמזגים). למשל כשמגיעה סחורה חדשה.",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string", description: "שם הפריט" },
        size: { type: "string", description: "מידה, ריק אם אין" },
        qty: { type: "number" },
        location: { type: "string", enum: [...LOCATIONS], description: "איפה הסחורה. ברירת מחדל: אצל מי שכותבת" },
      },
      required: ["name", "qty"],
    },
  },
  {
    name: "transfer_stock",
    description: "מעבירה מלאי בין השותפות ('העברתי לליאור 5 חולצות M'). item_id מהמלאי המצורף. מיקומים: avia = אצל אביה, lior = אצל ליאור.",
    input_schema: {
      type: "object",
      properties: {
        item_id: { type: "number" },
        from: { type: "string", enum: [...LOCATIONS] },
        to: { type: "string", enum: [...LOCATIONS] },
        size: { type: "string", description: "מידה או ריק לבלי-מידה" },
        qty: { type: "number" },
      },
      required: ["item_id", "from", "to", "qty"],
    },
  },
  {
    name: "log_expense",
    description:
      "רושמת הוצאה ביומן הכספים. כשאחת השותפות כותבת ששילמה/קנתה משהו לעסק. קטגוריה מתוך budgets בנתונים; אין התאמה: 'אחר'. payer = מי שילמה: avia, lior, או business (חשבון העסק). לא נאמר: מי שכותבת.",
    input_schema: {
      type: "object",
      properties: {
        amount: { type: "number", description: "בש\"ח (חיובי; החזר = שלילי)" },
        category: { type: "string" },
        description: { type: "string", description: "על מה, בקצרה" },
        payer: { type: "string", enum: [...PAYERS] },
        date: { type: "string", description: "YYYY-MM-DD, ברירת מחדל היום" },
        paid_from: { type: "string", enum: ["bank", "bit", "cash"], description: "רק כש-payer=business: מאיזו קופה. לא נאמר: אל תנחשי, שאלי." },
      },
      required: ["amount", "category"],
    },
  },
  {
    name: "fix_expense",
    description:
      "מתקנת או מוחקת הוצאה שכבר רשומה ('לא, זה היה 350', 'תמחקי את זה'). expense_id מ-recent_expenses בנתונים; לא ברור איזו: שאלי. שלחי רק שדות שמשתנים.",
    input_schema: {
      type: "object",
      properties: {
        expense_id: { type: "number" },
        amount: { type: "number" },
        category: { type: "string" },
        description: { type: "string" },
        date: { type: "string", description: "YYYY-MM-DD" },
        payer: { type: "string", enum: [...PAYERS] },
        paid_from: { type: "string", enum: ["bank", "bit", "cash"] },
        delete: { type: "boolean", description: "true = מחיקה. הקבלה שלה חוזרת לממתינות" },
      },
      required: ["expense_id"],
    },
  },
  {
    name: "log_settlement",
    description:
      "רושמת זיכוי סליקה שנחת בבנק ('שופיפיי העבירו 2,300'). הלוח מוריד מהכסף שממתין אצל הסולק, מוסיף לבנק בנטו ומחשב עמלה. לא למכירה חדשה (שם log_sale).",
    input_schema: {
      type: "object",
      properties: {
        provider: { type: "string", description: "מי העביר (למשל shopify)" },
        net: { type: "number", description: "כמה נכנס בפועל, בש\"ח" },
        gross: { type: "number", description: "רשות. רק אם נאמר במפורש על כמה ברוטו; אחרת אל תשלחי" },
        date: { type: "string", description: "YYYY-MM-DD, ברירת מחדל היום" },
        note: { type: "string" },
      },
      required: ["provider", "net"],
    },
  },
  {
    name: "attach_receipt",
    description: "מצרפת קבלה שכבר נשלחה בצ'אט להוצאה קיימת ('תצרפי את התמונה להוצאה של האריזות'). לא ליצירת הוצאה חדשה: log_expense מצרף לבד את הקבלה האחרונה.",
    input_schema: {
      type: "object",
      properties: {
        expense_hint: { type: "string", description: "מילה מהתיאור או מהקטגוריה" },
        amount: { type: "number", description: "סכום ההוצאה, אם ידוע" },
      },
      required: [],
    },
  },
  {
    name: "shopify_map",
    description: "מחברת/מרעננת את הקישור בין פריטי המלאי לווריאנטים בחנות שופיפיי ומפעילה סנכרון יוצא. כשמבקשות 'תחברי את המלאי לשופיפיי'. דווחי מה הותאם ומה לא.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "update_ship_status",
    description:
      "מעדכנת סטטוס משלוח של הזמנה אחת (קונה + מספר הזמנה): recorded=נרשם, packed=נארז, shipped=נשלח, delivered=התקבל. 'נשלח' ו'התקבל' דורשים ref (מספר הזמנה מ-open_orders) או evidence (מספר מעקב, שליח, למי נמסר ביד). ambiguous בתשובה = שאלי איזו הזמנה.",
    input_schema: {
      type: "object",
      properties: {
        buyer: { type: "string" },
        status: { type: "string", enum: ["recorded", "packed", "shipped", "delivered"] },
        ref: { type: "string", description: "מספר ההזמנה (#1112)" },
        evidence: { type: "string", description: "ראיה שהמשלוח יצא/נמסר. נשמר על ההזמנה" },
      },
      required: ["buyer", "status"],
    },
  },
  {
    name: "get_person_history",
    description: "כל ההיסטוריה של אדם: כל החלוקות והקניות שלו אי פעם (המצורף לשיחה מציג רק את האחרונים). כששואלות 'מה קיבלה/קנתה X'.",
    input_schema: { type: "object", properties: { name: { type: "string", description: "שם (או חלק ממנו)" } }, required: ["name"] },
  },
  {
    name: "shop_stats",
    description: "מספרי החנות בשופיפיי בזמן אמת: הזמנות והכנסות היום ו-7 ימים + הפריט הנמכר. כששואלות על החנות/האתר.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "export_seeding_csv",
    description: "מכינה CSV (לאקסל) של החלוקות, המכירות והמלאי. כשמבקשות אקסל או ייצוא.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "add_reminder",
    description: "קובעת תזכורת מתוזמנת ('תזכירי לי מחר ב-10'). חשבי תאריך ושעה מהיום הנוכחי. ההודעה תופיע בצ'אט הזה בזמן שנקבע.",
    input_schema: {
      type: "object",
      properties: {
        when: { type: "string", description: "שעון ישראל, YYYY-MM-DD HH:MM" },
        text: { type: "string" },
      },
      required: ["when", "text"],
    },
  },
  {
    name: "show_screen",
    description: "מעבירה את המסך לטאב בלוח כשמבקשות 'תראי לי' / 'תפתחי': shared=משותף, avia=אביה, lior=ליאור, stock=מלאי, finance=כספים, collab=משפיעניות, hobi=הצ'אט, settings=הגדרות. אחרי הקריאה עני במשפט אחד.",
    input_schema: { type: "object", properties: { tab: { type: "string", enum: [...SCREEN_TABS] } }, required: ["tab"] },
  },
  {
    name: "send_to_phone",
    description: "שולחת התראה לטלפונים של השותפות (Web Push) עם כותרת, שורת תוכן ולינק לטאב. כשמבקשות 'תשלחי לי לטלפון'. לתזכורת עתידית: add_reminder.",
    input_schema: {
      type: "object",
      properties: {
        title: { type: "string", description: "עד 60 תווים" },
        body: { type: "string", description: "עד 200 תווים, המידע עצמו" },
        tab: { type: "string", enum: [...SCREEN_TABS] },
      },
      required: ["title", "body"],
    },
  },
] as const;

/** צעד חי בזמן שהובי עובדת (לחלונית "הובי בודקת"). */
export type LiveStep = { id: number; label: string; state: "running" | "done" | "failed" | "pending" };

const short = (v: unknown, n: number) => (typeof v === "string" ? (v.trim().length > n ? `${v.trim().slice(0, n)}…` : v.trim()) : "");

/** תיאור קצר בעברית של מה שהכלי עושה. */
export function stepLabel(name: string, input: Record<string, unknown>): string {
  switch (name) {
    case "show_screen":
      return `פותחת את ${TAB_HE[String(input.tab)] ?? "המסך"}`;
    case "send_to_phone":
      return "שולחת לטלפון";
    case "shop_stats":
      return "בודקת את החנות בשופיפיי";
    case "get_person_history":
      return `מחפשת את ההיסטוריה של ${short(input.name, 24) || "הלקוחה"}`;
    case "add_task":
      return `פותחת משימה: ${short(input.title, 40)}`;
    case "update_task":
      return "מעדכנת משימה";
    case "add_reminder":
      return `קובעת תזכורת: ${short(input.text, 36)}`;
    case "remember":
      return "שומרת בזיכרון";
    case "forget":
      return "מוחקת מהזיכרון";
    case "export_seeding_csv":
      return "מכינה קובץ של המלאי";
    default:
      return TOOL_HE[name] ? `מכינה: ${TOOL_HE[name]}` : name;
  }
}

type ToolUse = { type: "tool_use"; id: string; name: string; input: Record<string, unknown> };
type ContentBlock = { type: string; text?: string; id?: string; name?: string; input?: Record<string, unknown> };

const csvCell = (v: unknown): string => `"${String(v ?? "").replace(/"/g, '""')}"`;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const normLoc = (v: unknown, actor: string): string => (typeof v === "string" && (LOCATIONS as readonly string[]).includes(v) ? v : partnerOr(actor, LOCATIONS[0]));
const normPayer = (v: unknown, actor: string): string => (typeof v === "string" && (PAYERS as readonly string[]).includes(v) ? v : partnerOr(actor, "business"));

/** קטגוריות ההוצאות מהמודול הפיננסי, או ריק כשהוא לא נטען. */
async function expenseCategories(): Promise<string[]> {
  try {
    const fin = (await getFinance()) as unknown as { budgets?: { category?: string }[] };
    return (fin.budgets ?? []).map((b) => b.category ?? "").filter(Boolean);
  } catch {
    return [];
  }
}

async function resolveGroupId(db: D1Database, input: Record<string, unknown>): Promise<number> {
  if (typeof input.group_id === "number" && input.group_id > 0) {
    const row = await db.prepare("SELECT id FROM board_groups WHERE id = ?").bind(input.group_id).first<{ id: number }>();
    if (row) return row.id;
  }
  const view = typeof input.view === "string" ? input.view : "shared";
  const row = await db.prepare("SELECT id FROM board_groups WHERE view = ? ORDER BY position, id LIMIT 1").bind(view).first<{ id: number }>();
  if (row) return row.id;
  const any = await db.prepare("SELECT id FROM board_groups ORDER BY position, id LIMIT 1").first<{ id: number }>();
  return any?.id ?? 0;
}

async function runTool(env: AssistantEnv, db: D1Database, chatId: number, name: string, input: Record<string, unknown>, actor: string): Promise<string> {
  try {
    if (name === "show_screen") {
      const tab = typeof input.tab === "string" ? input.tab : "";
      return JSON.stringify(SCREEN_TAB_SET.has(tab) ? { ok: true, note: "המסך מתחלף." } : { ok: false, error: "unknown tab" });
    }
    if (name === "send_to_phone") {
      const title = typeof input.title === "string" ? input.title.trim() : "";
      const body = typeof input.body === "string" ? input.body.trim() : "";
      const tab = typeof input.tab === "string" && SCREEN_TAB_SET.has(input.tab) ? input.tab : "hobi";
      if (!title) return JSON.stringify({ ok: false, error: "missing title" });
      const out = await pushNotify(env, title, body, `/?tab=${tab}`);
      return JSON.stringify(out.sent > 0 ? { ok: true, sent: out.sent } : { ok: false, error: "אין מכשיר רשום להתראות. צריך להפעיל התראות בטלפון (בטאב הגדרות)." });
    }
    if (name === "add_task") {
      const title = typeof input.title === "string" ? input.title.trim() : "";
      if (!title) return JSON.stringify({ ok: false, error: "missing title" });
      const groupId = await resolveGroupId(db, input);
      if (!groupId) return JSON.stringify({ ok: false, error: "no board group" });
      const task = await addTask(groupId, title);
      const patch: Record<string, unknown> = {};
      for (const k of ["notes", "priority", "due_date"] as const) if (typeof input[k] === "string" && input[k]) patch[k] = input[k];
      if (typeof input.owner === "string" && (OWNERS as readonly string[]).includes(input.owner)) patch.owner = input.owner;
      if (Object.keys(patch).length > 0) await updateTask(task.id, patch as Parameters<typeof updateTask>[1]);
      return JSON.stringify({ ok: true, task_id: task.id, group_id: groupId });
    }
    if (name === "update_task") {
      const id = typeof input.id === "number" ? input.id : 0;
      if (!id) return JSON.stringify({ ok: false, error: "missing id" });
      const patch: Record<string, unknown> = {};
      for (const k of ["title", "notes", "status", "priority", "due_date"] as const) if (typeof input[k] === "string") patch[k] = input[k];
      if (typeof input.owner === "string" && (OWNERS as readonly string[]).includes(input.owner)) patch.owner = input.owner;
      if (typeof input.group_id === "number") patch.group_id = input.group_id;
      const changed = await updateTask(id, patch as Parameters<typeof updateTask>[1]);
      return JSON.stringify({ ok: changed });
    }
    if (name === "remember") {
      const fact = typeof input.fact === "string" ? input.fact.trim() : "";
      if (!fact) return JSON.stringify({ ok: false, error: "missing fact" });
      return JSON.stringify({ ok: true, fact_id: await addMemory(db, fact, actor) });
    }
    if (name === "forget") {
      const id = typeof input.id === "number" ? Math.trunc(input.id) : 0;
      if (!id) return JSON.stringify({ ok: false, error: "missing id" });
      return JSON.stringify({ ok: await forget(db, id) });
    }
    if (name === "log_gift") {
      const itemId = typeof input.item_id === "number" ? input.item_id : 0;
      const person = typeof input.person === "string" ? input.person.trim() : "";
      if (!itemId || !person) return JSON.stringify({ ok: false, error: "missing item_id/person" });
      const result = await addGift({
        itemId,
        person,
        handle: typeof input.handle === "string" ? input.handle.trim().replace(/^@/, "") : "",
        kind: typeof input.kind === "string" && ["influencer", "friend", "other"].includes(input.kind) ? input.kind : "influencer",
        qty: typeof input.qty === "number" && input.qty >= 1 ? Math.trunc(input.qty) : 1,
        size: typeof input.size === "string" ? input.size.trim().slice(0, 30) : "",
        location: normLoc(input.location, actor),
        status: "given",
        note: typeof input.note === "string" ? input.note.trim() : "",
        givenAt: typeof input.given_at === "string" && DATE_RE.test(input.given_at) ? input.given_at : ilTodayISO(),
      });
      if (!result) return JSON.stringify({ ok: false, error: "item not found in inventory" });
      await drainShopifyPushQueue(env).catch(() => undefined);
      return JSON.stringify({ ok: true, item: result.label, stock_left: result.stockLeft });
    }
    if (name === "log_sale") {
      const itemId = typeof input.item_id === "number" ? input.item_id : 0;
      const buyer = typeof input.buyer === "string" ? input.buyer.trim() : "";
      const price = typeof input.price === "number" && input.price >= 0 ? input.price : -1;
      if (!itemId || !buyer || price < 0) return JSON.stringify({ ok: false, error: "missing item_id/buyer/price" });
      const result = await addSale({
        itemId,
        buyer,
        qty: typeof input.qty === "number" && input.qty >= 1 ? Math.trunc(input.qty) : 1,
        size: typeof input.size === "string" ? input.size.trim().slice(0, 30) : "",
        location: normLoc(input.location, actor),
        price,
        payMethod: typeof input.pay_method === "string" && input.pay_method ? input.pay_method : "bit",
        note: typeof input.note === "string" ? input.note.trim() : "",
        soldAt: typeof input.sold_at === "string" && DATE_RE.test(input.sold_at) ? input.sold_at : ilTodayISO(),
      });
      if (!result) return JSON.stringify({ ok: false, error: "item not found in inventory" });
      await drainShopifyPushQueue(env).catch(() => undefined);
      return JSON.stringify({ ok: true, item: result.label, stock_left: result.stockLeft });
    }
    if (name === "add_inventory") {
      const itemName = typeof input.name === "string" ? input.name.trim() : "";
      const size = typeof input.size === "string" ? input.size.trim() : "";
      const qty = typeof input.qty === "number" ? Math.trunc(input.qty) : 0;
      if (!itemName || qty < 1) return JSON.stringify({ ok: false, error: "missing name/qty" });
      const location = normLoc(input.location, actor);
      const s = (await getSeeding()) as unknown as { items?: { id: number; name: string; size: string }[] };
      const existing = (s.items ?? []).find((i) => i.name === itemName && (i.size ?? "") === size);
      if (existing) {
        await receiveStock(existing.id, location, "", qty);
        return JSON.stringify({ ok: true, merged: true, added: qty, location });
      }
      await addItem(itemName, size, qty);
      return JSON.stringify({ ok: true, added: qty });
    }
    if (name === "transfer_stock") {
      const itemId = typeof input.item_id === "number" ? input.item_id : 0;
      const qty = typeof input.qty === "number" ? Math.trunc(input.qty) : 0;
      const from = normLoc(input.from, actor);
      const to = normLoc(input.to, from === LOCATIONS[0] ? LOCATIONS[1] : LOCATIONS[0]);
      const size = typeof input.size === "string" ? input.size.trim() : "";
      if (!itemId || qty < 1 || from === to) return JSON.stringify({ ok: false, error: "missing item_id/qty or same location" });
      await transferStock(itemId, from, to, size, qty);
      return JSON.stringify({ ok: true, moved: qty, from, to });
    }
    if (name === "log_expense") {
      const amount = typeof input.amount === "number" && isFinite(input.amount) && input.amount !== 0 ? input.amount : 0;
      const category = typeof input.category === "string" ? input.category.trim() : "";
      if (!amount || !category) return JSON.stringify({ ok: false, error: "missing amount/category" });
      const payer = normPayer(input.payer, actor);
      const description = typeof input.description === "string" ? input.description.trim().slice(0, 300) : "";
      const date = typeof input.date === "string" && DATE_RE.test(input.date) ? input.date : ilTodayISO();
      const paidFrom = payer === "business" && typeof input.paid_from === "string" && ["bank", "bit", "cash"].includes(input.paid_from) ? input.paid_from : "";
      const expense = await addExpense({ date, payer, category, description, amount, paidFrom });
      let receiptAttached = false;
      try {
        receiptAttached = await claimPendingReceipt(expense.id, String(chatId));
      } catch (error) {
        console.error("receipt claim failed", error);
      }
      return JSON.stringify({ ok: true, expense_id: expense.id, category, amount, payer, paid_from: paidFrom || undefined, receipt_attached: receiptAttached || undefined });
    }
    if (name === "fix_expense") {
      const id = typeof input.expense_id === "number" ? Math.trunc(input.expense_id) : 0;
      if (!id) return JSON.stringify({ ok: false, error: "missing expense_id" });
      if (input.delete === true) {
        await deleteExpense(id);
        return JSON.stringify({ ok: true, deleted: id });
      }
      const after = await updateExpense(id, {
        amount: typeof input.amount === "number" ? input.amount : undefined,
        category: typeof input.category === "string" ? input.category.trim() : undefined,
        description: typeof input.description === "string" ? input.description.trim().slice(0, 300) : undefined,
        date: typeof input.date === "string" && DATE_RE.test(input.date) ? input.date : undefined,
        payer: typeof input.payer === "string" && (PAYERS as readonly string[]).includes(input.payer) ? input.payer : undefined,
        paidFrom: typeof input.paid_from === "string" && ["bank", "bit", "cash"].includes(input.paid_from) ? input.paid_from : undefined,
      });
      if (!after) return JSON.stringify({ ok: false, error: "nothing to change" });
      return JSON.stringify({ ok: true, after });
    }
    if (name === "log_settlement") {
      const provider = typeof input.provider === "string" && IS_PROVIDER(input.provider) ? input.provider : null;
      const net = typeof input.net === "number" && isFinite(input.net) && input.net > 0 ? input.net : 0;
      if (!provider || !net) return JSON.stringify({ ok: false, error: "missing provider/net" });
      const date = typeof input.date === "string" && DATE_RE.test(input.date) ? input.date : ilTodayISO();
      const gross = typeof input.gross === "number" && isFinite(input.gross) && input.gross > 0 ? input.gross : 0;
      const note = typeof input.note === "string" ? input.note.trim().slice(0, 200) : "";
      const doubt = typeof input["חשד לכפילות"] === "string" ? (input["חשד לכפילות"] as string) : "";
      const s = await addSettlement({ date, provider, net, gross, note, actor: `הובי (${speakerLabel(actor)})`, reason: doubt ? `אושר בכפתור למרות חשד: ${doubt}` : "" });
      const fee = s.gross - s.net;
      return JSON.stringify({ ok: true, provider, net_into_bank: Math.round(s.net), gross_closed: Math.round(s.gross), fee: Math.round(fee), fee_pct: s.gross > 0 ? Number(((fee / s.gross) * 100).toFixed(2)) : null });
    }
    if (name === "attach_receipt") {
      const waiting = await pendingReceipts(String(chatId));
      if (!waiting.length) return JSON.stringify({ ok: false, error: "no_pending_receipt", hint: "אין קבלה שממתינה לשיוך. בקשי לשלוח את התמונה קודם" });
      const hint = typeof input.expense_hint === "string" ? input.expense_hint.trim() : "";
      const amount = typeof input.amount === "number" && isFinite(input.amount) ? input.amount : null;
      const fin = (await getFinance()) as unknown as { expenses?: { id: number; category?: string; description?: string; amount?: number }[] };
      const match = (fin.expenses ?? []).find((e) => (!hint || (e.description ?? "").includes(hint) || (e.category ?? "").includes(hint)) && (amount === null || e.amount === amount));
      if (!match) return JSON.stringify({ ok: false, error: "expense_not_found", recent_expenses: (fin.expenses ?? []).slice(0, 5), hint: "לא מצאתי הוצאה מתאימה. הציגי את האחרונות ובקשי לבחור" });
      const attached = await attachReceipt(waiting[0].id, match.id);
      return JSON.stringify({ ok: attached, attached_to: { category: match.category, description: match.description, amount: match.amount }, receipts_still_waiting: waiting.length - 1 });
    }
    if (name === "shopify_map") return await buildVariantMap(env);
    if (name === "update_ship_status") return JSON.stringify(await updateShipStatus(input));
    if (name === "get_person_history") {
      const q = typeof input.name === "string" ? input.name.trim() : "";
      if (!q) return JSON.stringify({ ok: false, error: "missing name" });
      const s = (await getSeeding()) as unknown as { gifts?: { person?: string }[]; sales?: { buyer?: string }[] };
      return JSON.stringify({
        ok: true,
        gifts: compact((s.gifts ?? []).filter((g) => (g.person ?? "").includes(q))),
        sales: compact((s.sales ?? []).filter((x) => (x.buyer ?? "").includes(q))),
      });
    }
    if (name === "shop_stats") return await shopifyQuickStats(env);
    if (name === "export_seeding_csv") {
      const s = (await getSeeding()) as unknown as { items?: Record<string, unknown>[]; gifts?: Record<string, unknown>[]; sales?: Record<string, unknown>[] };
      const section = (title: string, rows: Record<string, unknown>[]): string[] => {
        if (!rows.length) return [`== ${title} ==`, "(ריק)", ""];
        const cols = Object.keys(rows[0]).filter((k) => typeof rows[0][k] !== "object");
        return [`== ${title} ==`, cols.map(csvCell).join(","), ...rows.map((r) => cols.map((c) => csvCell(r[c])).join(",")), ""];
      };
      const lines = [...section("חלוקות", s.gifts ?? []), ...section("מכירות", s.sales ?? []), ...section("מלאי", s.items ?? [])];
      const csv = lines.join("\n");
      return JSON.stringify({ ok: true, filename: `hob-stock-${ilTodayISO()}.csv`, rows: lines.length, csv: csv.length > 6000 ? `${csv.slice(0, 6000)}\n… (קוצר)` : csv, note: "הציגי את ה-CSV בבלוק קוד; אין שליחת קבצים בצ'אט" });
    }
    if (name === "add_reminder") {
      const when = typeof input.when === "string" ? input.when.trim() : "";
      const text = typeof input.text === "string" ? input.text.trim() : "";
      const m = when.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})$/);
      if (!m || !text) return JSON.stringify({ ok: false, error: "when must be YYYY-MM-DD HH:MM" });
      const asUtcGuess = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
      const fireAt = new Date(asUtcGuess - ilOffsetMs(new Date(asUtcGuess))).toISOString();
      if (Date.parse(fireAt) < Date.now() - 60000) return JSON.stringify({ ok: false, error: "time is in the past" });
      await addReminder(db, chatId, fireAt, text);
      return JSON.stringify({ ok: true, fire_at_israel: when });
    }
    return JSON.stringify({ ok: false, error: `unknown tool ${name}` });
  } catch (error) {
    return JSON.stringify({ ok: false, error: String(error) });
  }
}

// ---- The system prompt ----

type SystemBlock = { type: "text"; text: string; cache_control?: { type: "ephemeral" } };

function systemPrompt(p: { digest: string; stock: string; finance: string; collab: string; brandName: string; brandContext: string; ownerContext: string; memory: string; speaker: string }): SystemBlock[] {
  const today = ilTodayISO();
  const weekday = WEEKDAY_NAMES[new Date(`${today}T12:00:00Z`).getUTCDay()];
  const names = PARTNERS.map((k) => PARTNER[k].label).join(" ו");
  // Two blocks on purpose: the stable one (persona, contexts, memory, tool
  // rules) is cached; the live one (date, speaker, digests) is not.
  const stable =
    `את הובי, העוזרת הדיגיטלית של ${p.brandName || "hob"} (House of Bais), מותג בגדים של שתי שותפות, ${names}. את חיה בטאב "הובי" בלוח, מחוברת ללוח, למלאי, לכספים ולמשפיעניות, ופועלת דרך כלים.\n` +
    "דברי בעברית, בלשון נקבה על עצמך (\"אני בודקת\", \"רשמתי\"), ופני לשותפות בנקבה. קצר וישיר: השורה התחתונה קודם, עד 5 שורות, בלי רשימות ארוכות ובלי לחזור על נתונים שלא נשאלת עליהם. פירוט רק כשמבקשות.\n\n" +
    (p.ownerContext ? `על השותפות (מהגדרות הלוח):\n${p.ownerContext}\n\n` : "") +
    (p.brandContext ? `על המותג (מהגדרות הלוח):\n${p.brandContext}\n\n` : "") +
    (p.memory ? `הזיכרון שלך (עובדות שהשותפות ביקשו לזכור, לפי #id; החדש גובר על הישן, והנתונים החיים שלמטה גוברים על מספר שבזיכרון):\n${p.memory}\n\n` : "") +
    "זיכרון: יש לך remember ו-forget. כששותפה מוסרת עדכון עסקי, מתקנת תאריך או אומרת משהו שסותר את הזיכרון, שמרי מיד את הגרסה המתוקנת (ומחקי את הישנה עם forget), גם בלי שביקשו 'תזכרי'. עובדה שלא נשמרה תישכח.\n\n" +
    "משימות: add_task ו-update_task רק כשמבקשות במפורש להוסיף, לעדכן או לסמן משימה. הקבוצות בבלוק 'מצב הלוח' לפי view: shared = משותף, avia = של אביה, lior = של ליאור. 'תסמני שסיימתי' = מצאי לפי הכותרת ו-update_task עם status=done. אחראית (owner): avia, lior או both. לא ברור לאיזו משימה הכוונה: שאלי.\n\n" +
    "מלאי, חלוקות ומכירות: המלאי יושב אצל אביה או אצל ליאור (stock_locations). 'נתתי לדנה חולצה M' = log_gift עם item_id מהמלאי, size, ו-location = מי שכותבת אלא אם נאמר אחרת. 'מכרתי לרוני ב-150' = log_sale (price ליחידה; בלי מחיר ובלי מחיר מוגדר לפריט, שאלי). 'הגיעה סחורה' = add_inventory. 'העברתי לליאור' = transfer_stock. אין פריט תואם: אל תמציאי item_id, אמרי מה יש ושאלי. נשארו 2 או פחות: אזהרת מלאי. כמה פריטים לאותו אדם = קריאה לכל פריט. אחרי פעולה אשרי בקצרה עם מה שנשאר.\n\n" +
    "כספים: 'שילמתי 300 על אריזות' = log_expense; קטגוריה מתוך budgets (אין: 'אחר'), payer = מי שכותבת אלא אם נאמר 'העסק שילם' (business, ואז שאלי מאיזו קופה: bank/bit/cash). העסק פטור ממע\"מ כש-vat_exempt=true: אל תוסיפי מע\"מ לחישובים. 'נכנס זיכוי משופיפיי' = log_settlement (בלי gross אלא אם נאמר במפורש). יתרות (בנק/ביט/מזומן) רק מבלוק money: value=null אומר 'לא ידוע' ולמה, לא אפס; אל תחשבי במקומו ואל תסכמי מכירות כאילו הן כסף בבנק. " +
    "תמונת קבלה שנשלחת נקראת אוטומטית: המערכת מחלצת סכום ובית עסק, רושמת הוצאה (payer = מי ששלחה) ומצרפת את הקבלה עוד לפני שהגעת לשיחה. שורה '[שלחה תמונת קבלה ...]' בהיסטוריה היא עדות שהתמונה הגיעה, ו-pending_receipts הן קבלות שעוד מחכות לשיוך: כל עוד יש כאלה אל תאמרי שלא הגיעה תמונה. את לא רואה את התמונה עצמה, וזה בסדר לומר. תיקון של מה שנרשם = fix_expense לפי expense_id מ-recent_expenses (גם מחיקה, delete:true). צירוף קבלה להוצאה קיימת = attach_receipt. " +
    "אסור לאשר פעולה שלא ביצעת בכלי: אשרי רק מה שהכלי החזיר ok. כלי שהחזיר pending_confirmation = הפעולה מחכה לאישור בכפתור ולא בוצעה; אמרי את זה במשפט אחד.\n\n" +
    "משלוחים: open_orders הן ההזמנות שעוד לא נמסרו. 'החבילה של רוני נשלחה' = update_ship_status על הזמנה אחת; 'נשלח'/'התקבל' רק עם מספר הזמנה או ראיה, אחרת שאלי מה הראיה. ambiguous = שאלי איזו הזמנה.\n\n" +
    "שאלות: 'כמה עשינו היום' מבלוק today (מכירות יד) ואם רלוונטי גם shop_stats לחנות. 'מה קיבלה X' = get_person_history. החנות/האתר = shop_stats. אקסל = export_seeding_csv. 'תזכירי לי' = add_reminder עם תאריך ושעה מהיום. 'תראי לי' = show_screen. 'תשלחי לטלפון' = send_to_phone. 'תחברי לשופיפיי' = shopify_map.\n\n" +
    "כללים: כשהודעה מצדיקה פעולה, קראי לכלי מיד באותה תשובה, בלי לשאול אישור מיותר. כשכלי או נתון מחזיר שגיאה, null או 'לא נטען': אמרי 'לא הצלחתי לבדוק את X', לא 'אין' ולא 0. על מצב הלוח עני מהנתונים בלבד, אל תמציאי משימות. יש לך את ההודעות האחרונות, אז את זוכרת את ההקשר הקרוב; הזיכרון הארוך הוא הלוח והזיכרון שלך. " +
    "ייתכן שהשותפה כבר קיבלה ממך אישור מיידי קצר ('בודקת, רגע') לפני התשובה הזו: התחילי ישר מהעיקר. את גם שותפה לחשיבה: כששואלות על מחירים, רווחיות או מהלכים, חשבי מהמספרים שבנתונים והציעי צעד ראשון קונקרטי, ואת רשאית לאתגר בכנות.";
  const live =
    `היום (שעון ישראל): יום ${weekday}, ${today}. מי שכותבת לך עכשיו: ${p.speaker}.\n\n` +
    `מצב הלוח (JSON, קבוצות ומשימות עם מזהים):\n${p.digest}\n\n` +
    `מלאי, חלוקות ומכירות (JSON):\n${p.stock}\n\n` +
    `כספים (JSON: recent_expenses, budgets, money, pending_receipts, vat_exempt):\n${p.finance}` +
    (p.collab ? `\n\nמשפיעניות: ${p.collab}` : "");
  return [
    { type: "text", text: stable, cache_control: { type: "ephemeral" } },
    { type: "text", text: live },
  ];
}

/** The tool list, with a cache breakpoint on the last one (covers the array). */
function toolsForRequest() {
  return TOOLS.map((t, i) => (i === TOOLS.length - 1 ? { ...t, cache_control: { type: "ephemeral" } } : t));
}

// ---- Confirmation before execution (voice commands) ----

export type PendingField = { key: string; label: string; value: string | number; kind: "number" | "text" };
export type PendingAction = { id: number; summary: string; tool?: string; action?: string; fields?: PendingField[] };

const FIELD_HE: Record<string, string> = {
  item: "פריט",
  item_id: "מזהה פריט",
  name: "שם",
  buyer: "קונה",
  person: "למי",
  qty: "כמות",
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
  date: "תאריך",
  payer: "מי שילמה",
  paid_from: "מאיזו קופה",
  provider: "סולק",
  status: "סטטוס",
  ref: "הזמנה",
  evidence: "ראיה",
  expense_id: "מספר הוצאה",
  note: "הערה",
  kind: "סוג",
  pay_method: "אמצעי תשלום",
  handle: "אינסטגרם",
};

/** השדות שאפשר לראות ולתקן לפני אישור: רק ערכים פשוטים שכבר קיימים בקלט. */
export function pendingFields(input: Record<string, unknown>): PendingField[] {
  return Object.entries(input)
    .filter(([k, v]) => k !== "חשד לכפילות" && (typeof v === "number" || (typeof v === "string" && v !== "")))
    .map(([k, v]) => ({ key: k, label: FIELD_HE[k] ?? k, value: v as string | number, kind: typeof v === "number" ? ("number" as const) : ("text" as const) }));
}

/** מחילה תיקונים על הקלט לפני אישור. רק מפתחות קיימים ובאותו סוג; תיקון לא תקין = שגיאה, כלום לא מבוצע. */
export function applyEdits(input: Record<string, unknown>, edits: Record<string, unknown>): { ok: true; input: Record<string, unknown> } | { ok: false; error: string } {
  const out = { ...input };
  for (const [k, v] of Object.entries(edits)) {
    if (k === "חשד לכפילות" || !(k in input)) return { ok: false, error: `אי אפשר לתקן את "${k}"` };
    const cur = input[k];
    if (typeof cur === "number") {
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

/** כלים שמשנים כסף, מלאי או סטטוס הזמנה. תמלול קולי יכול לטעות במספר או בשם, אז מהמיקרופון הם מחכים לאישור. */
const CONFIRM_ON_VOICE = new Set(["log_sale", "log_gift", "log_expense", "fix_expense", "log_settlement", "add_inventory", "transfer_stock", "update_ship_status"]);
const PENDING_TTL_MIN = 15;
const EXECUTING_STALE_SEC = 120;

const TOOL_HE: Record<string, string> = {
  log_sale: "רישום מכירה",
  log_gift: "רישום חלוקה",
  log_expense: "רישום הוצאה",
  fix_expense: "תיקון הוצאה",
  log_settlement: "רישום זיכוי סליקה",
  add_inventory: "הוספת מלאי",
  transfer_stock: "העברת מלאי",
  update_ship_status: "עדכון משלוח",
};

/** תיאור הפעולה מהקלט עצמו (לא מהניסוח של המודל), כדי שמה שמאשרות הוא בדיוק מה שיבוצע. */
function summarizeToolCall(tool: string, input: Record<string, unknown>): string {
  const fields = Object.entries(input)
    .filter(([, v]) => v !== "" && v !== null && v !== undefined)
    .map(([k, v]) => `${FIELD_HE[k] ?? k}: ${typeof v === "object" ? JSON.stringify(v) : String(v)}`)
    .join(" · ");
  return `${TOOL_HE[tool] ?? tool} — ${fields}`.slice(0, 400);
}

/** זיכוי שנראה כפול לא נרשם ישר: הופך לפעולה ממתינה עם הסיבה. */
async function suspectSettlement(tool: string, input: Record<string, unknown>): Promise<string> {
  if (tool !== "log_settlement") return "";
  const provider = typeof input.provider === "string" && IS_PROVIDER(input.provider) ? input.provider : null;
  const net = typeof input.net === "number" && isFinite(input.net) && input.net > 0 ? input.net : 0;
  if (!provider || !net) return "";
  const date = typeof input.date === "string" && DATE_RE.test(input.date) ? input.date : ilTodayISO();
  const gross = typeof input.gross === "number" && input.gross > 0 ? input.gross : 0;
  const reasons = await settlementSuspicion({ date, provider, net, gross }).catch(() => [] as string[]);
  return reasons.join(" · ");
}

async function holdForConfirmation(db: D1Database, tool: string, input: Record<string, unknown>, actor: string, sink?: PendingAction[]): Promise<string> {
  const summary = summarizeToolCall(tool, input);
  const res = await db
    .prepare(`INSERT INTO assistant_pending (tool, input, summary, actor, expires_at) VALUES (?, ?, ?, ?, datetime('now', '+${PENDING_TTL_MIN} minutes'))`)
    .bind(tool, JSON.stringify(input), summary, actor)
    .run();
  const id = Number(res.meta?.last_row_id ?? 0);
  sink?.push({ id, summary, tool, action: TOOL_HE[tool] ?? tool, fields: pendingFields(input) });
  return JSON.stringify({ ok: false, pending_confirmation: true, confirmation_id: id, note: "הפעולה לא בוצעה. היא מחכה לאישור בכפתור שמופיע עכשיו. אמרי במשפט אחד מה מחכה לאישור, ואל תאשרי שבוצע." });
}

/** מה שמחכה לאישור עכשיו, מהשרת (שורד רענון ומכשיר אחר). בדרך מסמנת מה שפג, ומה שנתקע
 *  באמצע ביצוע הופך ל-unknown: כלי כמו רישום הוצאה אינו אידמפוטנטי, אז לא מנסים שוב לבד. */
export async function listPending(db: D1Database): Promise<(PendingAction & { state: "pending" | "unknown"; actor: string; created_at: string })[]> {
  await db.prepare("UPDATE assistant_pending SET status = 'expired' WHERE status = 'pending' AND expires_at < datetime('now')").run();
  // expires_at doubles as the deadline of an execution in flight (set on claim).
  await db.prepare("UPDATE assistant_pending SET status = 'unknown', result = 'הביצוע נקטע באמצע. לא ידוע אם הפעולה נרשמה.' WHERE status = 'executing' AND expires_at < datetime('now')").run();
  const rows = await db
    .prepare("SELECT id, tool, input, summary, status, actor, created_at FROM assistant_pending WHERE status = 'pending' OR (status = 'unknown' AND created_at >= datetime('now', '-1 day')) ORDER BY id")
    .all<{ id: number; tool: string; input: string; summary: string; status: string; actor: string; created_at: string }>();
  return (rows.results ?? []).map((r) => {
    let input: Record<string, unknown> = {};
    try {
      input = JSON.parse(r.input) as Record<string, unknown>;
    } catch {
      input = {};
    }
    return { id: r.id, summary: r.summary, tool: r.tool, action: TOOL_HE[r.tool] ?? r.tool, fields: pendingFields(input), state: r.status === "unknown" ? ("unknown" as const) : ("pending" as const), actor: r.actor, created_at: r.created_at };
  });
}

/** מצב של פעולה אחת: הלקוח שואל כשבקשת האישור נפלה ולא ברור מה קרה. */
export async function pendingStatus(db: D1Database, id: number): Promise<{ status: string; text: string } | null> {
  await listPending(db);
  const row = await db.prepare("SELECT status, result, summary FROM assistant_pending WHERE id = ?").bind(id).first<{ status: string; result: string; summary: string }>();
  return row ? { status: row.status, text: row.result || row.summary } : null;
}

/** בדקו ביומן וסוגרות פעולה שמצבה לא היה ידוע. */
export async function closeUnknown(db: D1Database, id: number): Promise<boolean> {
  const res = await db.prepare("UPDATE assistant_pending SET status = 'closed' WHERE id = ? AND status = 'unknown'").bind(id).run();
  return (res.meta?.changes ?? 0) === 1;
}

/** אישור או ביטול של פעולה ממתינה. תפיסה אטומית: לחיצה כפולה מבצעת פעם אחת. */
export async function confirmPending(env: AssistantEnv, id: number, approve: boolean, edits?: Record<string, unknown>): Promise<{ ok: boolean; status: string; text: string }> {
  if (!env.DB) return { ok: false, status: "error", text: "אין חיבור לנתונים" };
  const db = env.DB;
  const row = await db.prepare("SELECT id, tool, input, summary, status, result, actor FROM assistant_pending WHERE id = ?").bind(id).first<{ id: number; tool: string; input: string; summary: string; status: string; result: string; actor: string }>();
  if (!row) return { ok: false, status: "not_found", text: "הפעולה לא נמצאה" };
  if (row.status === "done") return { ok: true, status: "done", text: row.result || "כבר בוצע" };
  if (row.status === "failed") return { ok: false, status: "failed", text: row.result || "הפעולה נכשלה ולא בוצעה" };
  if (row.status === "unknown") return { ok: false, status: "unknown", text: "הביצוע נקטע באמצע ולא ידוע אם נרשם. בדקו ביומן לפני בקשה חוזרת." };
  if (row.status !== "pending") return { ok: false, status: row.status, text: row.status === "cancelled" ? "הפעולה בוטלה" : row.status === "expired" ? "פג תוקף האישור, אמרו שוב את הפקודה" : "הפעולה כבר בטיפול" };
  if (!approve) {
    const c = await db.prepare("UPDATE assistant_pending SET status = 'cancelled' WHERE id = ? AND status = 'pending'").bind(id).run();
    if ((c.meta?.changes ?? 0) === 1) await saveBoardTurn(db, "assistant", `בוטל, לא בוצע: ${row.summary}`);
    return { ok: true, status: "cancelled", text: "בוטל, לא בוצע כלום" };
  }
  const fresh = await db.prepare("UPDATE assistant_pending SET status = 'expired' WHERE id = ? AND status = 'pending' AND expires_at < datetime('now')").bind(id).run();
  if ((fresh.meta?.changes ?? 0) === 1) return { ok: false, status: "expired", text: "פג תוקף האישור, אמרו שוב את הפקודה" };
  let input: Record<string, unknown> = {};
  try {
    input = JSON.parse(row.input) as Record<string, unknown>;
  } catch {
    // stays empty; the tool answers with a clear error
  }
  let summary = row.summary;
  if (edits && Object.keys(edits).length) {
    const fixed = applyEdits(input, edits);
    if (!fixed.ok) return { ok: false, status: "pending", text: fixed.error };
    input = fixed.input;
    summary = summarizeToolCall(row.tool, input);
  }
  const claim = await db
    .prepare(`UPDATE assistant_pending SET status = 'executing', input = ?, summary = ?, expires_at = datetime('now', '+${EXECUTING_STALE_SEC} seconds') WHERE id = ? AND status = 'pending'`)
    .bind(JSON.stringify(input), summary, id)
    .run();
  if ((claim.meta?.changes ?? 0) !== 1) return { ok: false, status: "in_progress", text: "הפעולה כבר בטיפול" };
  const raw = await runTool(env, db, BOARD_CHAT_ID, row.tool, input, row.actor);
  let okResult = false;
  try {
    okResult = (JSON.parse(raw) as { ok?: boolean }).ok === true;
  } catch {
    okResult = false;
  }
  const text = okResult ? `בוצע: ${summary}` : `לא בוצע (${raw.slice(0, 200)}): ${summary}`;
  await db.prepare("UPDATE assistant_pending SET status = ?, result = ? WHERE id = ?").bind(okResult ? "done" : "failed", text.slice(0, 600), id).run();
  await saveBoardTurn(db, "assistant", text);
  return { ok: okResult, status: okResult ? "done" : "failed", text };
}

// ---- The conversation ----

async function askClaude(
  env: AssistantEnv,
  db: D1Database,
  chatId: number,
  history: HistoryRow[],
  userText: string,
  actor: string,
  opts: { voice?: boolean; pending?: PendingAction[]; onStep?: (s: LiveStep) => void } = {},
): Promise<string> {
  const [digest, stock, finance, collab, memory] = await Promise.all([boardDigest(db), stockDigest(), financeDigest(db, chatId), collabLine(), memoryForPrompt(db).catch(() => "")]);
  const setting = async (k: string) => (await getSetting(db, k).catch(() => null)) ?? "";
  const system = systemPrompt({
    digest,
    stock,
    finance,
    collab,
    brandName: await setting("brand_name"),
    brandContext: await setting("brand_context"),
    ownerContext: await setting("owner_context"),
    memory,
    speaker: speakerLabel(actor),
  });
  const messages: { role: string; content: unknown }[] = [...history.map((h) => ({ role: h.role, content: h.content })), { role: "user", content: userText }];

  let spokenSoFar = "";
  let stepId = 0;
  const step = (s: Omit<LiveStep, "id"> & { id?: number }): number => {
    const id = s.id ?? ++stepId;
    try {
      opts.onStep?.({ ...s, id });
    } catch {
      // display only
    }
    return id;
  };
  const thinking = opts.onStep ? step({ label: "מבינה מה ביקשת ובודקת את הנתונים", state: "running" }) : 0;
  let thought = false;
  // The model sometimes runs tools and then stops without a word: ask once
  // for a short answer, without tools.
  let nudged = false;
  for (let round = 0; round < 6; round++) {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": env.ANTHROPIC_API_KEY as string, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: MAIN_MODEL,
        max_tokens: 1500,
        thinking: { type: "disabled" },
        system,
        tools: toolsForRequest(),
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
      step({ id: thinking, label: "מבינה מה ביקשת ובודקת את הנתונים", state: "done" });
    }
    const toolUses = blocks.filter((b): b is ToolUse => b.type === "tool_use");
    const text = blocks
      .filter((b) => b.type === "text" && b.text)
      .map((b) => b.text)
      .join("\n")
      .trim();
    if (data.stop_reason !== "tool_use" || toolUses.length === 0) {
      if (text || spokenSoFar || nudged) return text || spokenSoFar;
      nudged = true;
      const ask = { type: "text", text: "עני עכשיו בקצרה, בלי כלים: מה עשית, מה מצאת, ומה הצעד הבא." };
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
      const label = stepLabel(tu.name, tu.input ?? {});
      const sid = opts.onStep ? step({ label, state: "running" }) : 0;
      const suspect = opts.voice && CONFIRM_ON_VOICE.has(tu.name) ? "" : await suspectSettlement(tu.name, tu.input ?? {});
      // A voice command that changes money, stock or shipping is not executed:
      // it is held, and the partner approves it in a button that shows exactly
      // what will be done. Enforced here, on the server.
      const content =
        opts.voice && CONFIRM_ON_VOICE.has(tu.name)
          ? await holdForConfirmation(db, tu.name, tu.input ?? {}, actor, opts.pending)
          : suspect
            ? await holdForConfirmation(db, tu.name, { ...(tu.input ?? {}), "חשד לכפילות": suspect }, actor, opts.pending)
            : await runTool(env, db, chatId, tu.name, tu.input ?? {}, actor);
      if (sid) {
        let parsed: Record<string, unknown> = {};
        try {
          parsed = JSON.parse(content) as Record<string, unknown>;
        } catch {
          parsed = {};
        }
        step({ id: sid, label, state: parsed.pending_confirmation === true ? "pending" : parsed.ok === false ? "failed" : "done" });
      }
      results.push({ type: "tool_result", tool_use_id: tu.id, content });
    }
    messages.push({ role: "user", content: results });
  }
  return spokenSoFar || "עשיתי כמה פעולות אבל התבלבלתי בדרך. תבדקו את הלוח 🙈";
}

// ---- Receipts (vision) ----

type SavedReceipt = { id: number; bytes: ArrayBuffer; mime: string };

type ReceiptRead = { is_receipt?: boolean; amount?: number | null; vendor?: string; date?: string | null; category?: string; confidence?: string };

/** btoa needs a binary string; chunked so a big photo can't blow the stack. */
function toBase64(bytes: ArrayBuffer): string {
  const view = new Uint8Array(bytes);
  let binary = "";
  for (let i = 0; i < view.length; i += 0x8000) binary += String.fromCharCode(...view.subarray(i, i + 0x8000));
  return btoa(binary);
}

/** Asks Claude what the receipt says. null whenever the answer cannot be trusted. */
async function readReceiptImage(env: AssistantEnv, categories: string[], saved: SavedReceipt): Promise<ReceiptRead | null> {
  if (!env.ANTHROPIC_API_KEY || !/^image\/(jpeg|png|webp|gif)$/.test(saved.mime)) return null;
  const prompt =
    "בתמונה הזאת אמורה להיות קבלה או חשבונית של עסק ישראלי. החזר JSON בלבד, בלי טקסט מסביב, במבנה:\n" +
    '{"is_receipt": true/false, "amount": מספר או null, "vendor": "שם בית העסק", "date": "YYYY-MM-DD" או null, "category": "אחת מהרשימה", "confidence": "high" או "low"}\n' +
    'amount = הסכום הסופי לתשלום (השורה "סה"כ לתשלום"/"סה"כ"), לא סכום ביניים. מספר בלבד, בלי ₪.\n' +
    (categories.length ? `category חייבת להיות אחת מאלה בדיוק: ${categories.join(" | ")}, ואם שום אחת לא מתאימה: אחר.\n` : "category: מילה אחת שמתארת את סוג ההוצאה, או אחר.\n") +
    'confidence = "high" רק אם הסכום הסופי קריא בבירור. מטושטש, חתוך, מסופק, או לא קבלה בכלל: "low".\n' +
    "אל תנחש סכום. עדיף low מאשר מספר שגוי.";
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: MAIN_MODEL,
        max_tokens: 400,
        thinking: { type: "disabled" },
        messages: [{ role: "user", content: [{ type: "image", source: { type: "base64", media_type: saved.mime, data: toBase64(saved.bytes) } }, { type: "text", text: prompt }] }],
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

/** A photographed receipt files itself: read the paper, write the expense
 *  (payer = the partner who sent it), attach the image, say what was recorded.
 *  Anything less than a confident reading falls back to asking. */
async function fileReceiptAutomatically(env: AssistantEnv, actor: string, saved: SavedReceipt): Promise<{ text: string; status: string }> {
  const categories = await expenseCategories();
  const read = await readReceiptImage(env, categories, saved);
  const amount = typeof read?.amount === "number" && read.amount > 0 ? Math.round(read.amount * 100) / 100 : 0;
  if (read && read.is_receipt === false) {
    await deleteReceipt(saved.id).catch(() => undefined);
    return { text: "📎 זו לא נראית לי קבלה, אז לא רשמתי כלום. אם זו כן הוצאה, כתבו לי סכום וקטגוריה (למשל \"305 אריזות\").", status: `image ${saved.id} not a receipt, removed` };
  }
  if (!read?.is_receipt || !amount || read.confidence !== "high") {
    return { text: "📎 קיבלתי את הקבלה ושמרתי אותה, אבל לא הצלחתי לקרוא ממנה סכום בוודאות. כמה זה היה? (סכום + קטגוריה, למשל \"305 אריזות\") ואצרף אותה מיד.", status: `receipt ${saved.id} saved, unreadable` };
  }
  const today = ilTodayISO();
  const onPaper = typeof read.date === "string" && DATE_RE.test(read.date) ? read.date : "";
  const yearAgo = new Date(Date.now() - 365 * 864e5).toISOString().slice(0, 10);
  const date = onPaper && onPaper <= today && onPaper >= yearAgo ? onPaper : today;
  const category = categories.includes(read.category ?? "") ? (read.category as string) : (read.category ?? "").trim() || "אחר";
  const vendor = (read.vendor ?? "").trim().slice(0, 60);
  // The partner who sent the photo paid, never a stranger.
  const payer = partnerOr(actor, "business");
  // The same receipt sent twice must not become two expenses.
  try {
    const fin = (await getFinance()) as unknown as { expenses?: { id: number; amount?: number; date?: string; description?: string }[] };
    const twin = (fin.expenses ?? []).find((e) => e.amount === amount && e.date === date && (e.description ?? "") === vendor);
    if (twin) return { text: `📎 קיבלתי קבלה על ${amount} ₪${vendor ? ` מ-${vendor}` : ""}, אבל כבר רשומה הוצאה זהה, אז לא רשמתי פעמיים. אם זו באמת הוצאה נוספת כתבו לי "כן, תרשמי ${amount} ${category}".`, status: `receipt ${saved.id} saved, duplicate of expense ${twin.id}` };
  } catch {
    // the ledger did not load; filing still goes ahead
  }
  try {
    const expense = await addExpense({ date, payer, category, description: vendor, amount, paidFrom: "" });
    await attachReceipt(saved.id, expense.id);
    const he = `${date.slice(8)}/${date.slice(5, 7)}`;
    return {
      text: `📎 רשמתי: ${amount} ₪ · ${category}${vendor ? ` · ${vendor}` : ""} · ${he} · שילמה: ${partnerLabel(payer)}. הקבלה מצורפת להוצאה.\nלא נכון? כתבו לי מה לתקן (למשל "זה היה 350") ואתקן.`,
      status: `receipt ${saved.id} filed as expense ${expense.id}`,
    };
  } catch (error) {
    console.error("auto file receipt failed", error);
    return { text: `📎 קראתי מהקבלה ${amount} ₪ אבל לא הצלחתי לרשום את ההוצאה. כתבו לי "${amount} ${category}" ואני ארשום ואצרף.`, status: `receipt ${saved.id} saved, insert failed` };
  }
}

/** A receipt photographed straight into the chat (the 📷 button): saved to
 *  R2 as a pending receipt, filed by the vision pipeline, both sides of the
 *  exchange recorded in the thread. */
export async function handleBoardReceipt(env: AssistantEnv, bytes: ArrayBuffer, mime: string, actor: string): Promise<{ answer: string; status: string }> {
  if (!env.DB) return { answer: "😵 אין חיבור לנתונים. נסו לרענן.", status: "error: no db" };
  let saved: SavedReceipt | null = null;
  try {
    const id = await addReceipt({ expenseId: null, bytes, mime, source: "board-chat", chatId: String(BOARD_CHAT_ID) });
    saved = { id, bytes, mime };
  } catch (error) {
    console.error("board receipt save failed", error);
  }
  const filed = saved ? await fileReceiptAutomatically(env, actor, saved) : { text: "😵 לא הצלחתי לשמור את הקבלה. נסו לצלם שוב, ואם זה חוזר רשמו את ההוצאה ידנית בינתיים.", status: "board receipt save failed" };
  try {
    await saveBoardTurn(env.DB, "user", `${speakerLabel(actor)}: [שלחה תמונת קבלה — ${saved ? "התקבלה ונשמרה" : "השמירה נכשלה"}]`, actor);
    await saveBoardTurn(env.DB, "assistant", filed.text);
  } catch (error) {
    console.error("board receipt history save failed", error);
  }
  return { answer: filed.text, status: filed.status };
}

// ---- Board chat: the "הובי" tab ----

const NO_BRAIN_TEXT = "🧠 המוח שלי עדיין לא חובר (חסר מפתח Anthropic API). ברגע שהמפתח יוגדר אענה כאן על הכול.";

export async function handleBoardChat(
  env: AssistantEnv,
  text: string,
  actor: string,
  opts: { voice?: boolean; onStep?: (s: LiveStep) => void } = {},
): Promise<{ answer: string; status: string; pending: PendingAction[] }> {
  if (!env.DB) return { answer: "😵 אין חיבור לנתונים. נסו לרענן.", status: "error: no db", pending: [] };
  if (!env.ANTHROPIC_API_KEY) return { answer: NO_BRAIN_TEXT, status: "replied: no-brain notice", pending: [] };
  const pending: PendingAction[] = [];
  const history = await loadHistory(env.DB, BOARD_CHAT_ID);
  const userTurn = `${speakerLabel(actor)}: ${text}`;
  let answer: string;
  try {
    answer = await askClaude(env, env.DB, BOARD_CHAT_ID, history, userTurn, actor, { voice: opts.voice, pending, onStep: opts.onStep });
  } catch (error) {
    console.error("board chat error", error);
    answer = "😵 משהו השתבש אצלי. נסו שוב עוד רגע.";
  }
  if (!answer) answer = "🤔 לא הצלחתי לנסח תשובה. נסו לנסח אחרת.";
  // Save the user turn even if the answer errored: the thread is the record.
  try {
    await saveBoardTurn(env.DB, "user", userTurn, actor);
    await saveBoardTurn(env.DB, "assistant", answer);
  } catch (error) {
    console.error("board chat history save failed", error);
  }
  return { answer, status: `board answered: ${answer.slice(0, 40)}`, pending };
}
