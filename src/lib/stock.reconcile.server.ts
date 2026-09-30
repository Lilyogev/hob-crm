// חשבון כמויות לפריט: מה שהלוח מסביר (נשארו + נמכרו + חולקו) מול כמות הקבלה מהספק.
// כמות קבלה היא נתון ב-fin_facts (מפתח received_qty:<item_id>) עם מקור ומצב, כי הלוח לא
// שומר מלאי פתיחה. בלי כמות קבלה מאושרת: הכמות "משוחזרת" ולא מאומתת, ועלות ליחידה לא
// מוצגת כמאומתת. פער בין הקבלה לחשבון מוצג לבירור, בלי הסבר מומצא.
import type { D1Database } from "@cloudflare/workers-types";
import { type Fact, STATUS_HE, listFacts } from "./finance.summary.server";
import { stockBalance } from "./stock.rules";

export const RECEIVED_KEY = (itemId: number) => `received_qty:${itemId}`;

export type ItemRecon = {
  itemId: number;
  name: string;
  collection: string;
  left: number;
  sold: number;
  given: number;
  /** נשארו + נמכרו + חולקו: מה שהלוח מסביר. */
  accounted: number;
  /** כמות הקבלה מהספק, אם נרשמה. */
  received: { value: number | null; status: Fact["status"]; source: string; asOf: string } | null;
  /** קבלה פחות חשבון. null כשאין כמות קבלה. */
  gap: number | null;
  /** מאומת = יש קבלה מאושרת והחשבון תואם. */
  verified: boolean;
  text: string;
};

export async function itemReconciliation(db: D1Database): Promise<ItemRecon[]> {
  const items = (await db.prepare("SELECT id, name, COALESCE(NULLIF(collection,''),'main') AS collection FROM seed_items ORDER BY id").all<{ id: number; name: string; collection: string }>()).results ?? [];
  const left = new Map((((await db.prepare("SELECT item_id, SUM(qty + qty_xs + qty_s + qty_m + qty_l + qty_xl + qty_xxl) AS n FROM seed_stock GROUP BY item_id").all<{ item_id: number; n: number }>()).results) ?? []).map((r) => [r.item_id, r.n]));
  // מכירות בלי מבוטלות ובלי ארכיון; חלוקות שנמסרו או פורסמו (הבטחה עוד לא יצאה מהמלאי בפועל).
  const sold = new Map((((await db.prepare("SELECT item_id, SUM(qty) AS n FROM seed_sales WHERE ship_status <> 'cancelled' AND COALESCE(channel,'') <> 'archive' GROUP BY item_id").all<{ item_id: number; n: number }>()).results) ?? []).map((r) => [r.item_id, r.n]));
  const given = new Map((((await db.prepare("SELECT item_id, SUM(qty) AS n FROM seed_gifts WHERE status <> 'promised' GROUP BY item_id").all<{ item_id: number; n: number }>()).results) ?? []).map((r) => [r.item_id, r.n]));
  const facts = new Map((await listFacts(db)).map((f) => [f.key, f]));
  return items.map((it) => {
    const parts = { left: left.get(it.id) ?? 0, sold: sold.get(it.id) ?? 0, given: given.get(it.id) ?? 0 };
    const { accounted } = stockBalance(parts);
    const f = facts.get(RECEIVED_KEY(it.id));
    const received = f ? { value: f.value, status: f.status, source: f.source, asOf: f.as_of || f.updated_at.slice(0, 10) } : null;
    const gap = received?.value !== null && received?.value !== undefined ? received.value - accounted : null;
    const verified = gap === 0 && received?.status === "confirmed";
    const base = `נשארו ${parts.left} + נמכרו ${parts.sold} + חולקו ${parts.given} = ${accounted}`;
    const text =
      gap === null
        ? `${base} משוחזר. כמות קבלה מהספק לא רשומה, אז הכמות לא מאומתת`
        : gap === 0
          ? `${base}, תואם לקבלה של ${received!.value} (${STATUS_HE[received!.status]}${received!.source ? `, ${received!.source}` : ""})`
          : `${base}, אבל הקבלה היא ${received!.value} (${STATUS_HE[received!.status]}). פער של ${Math.abs(gap)} ${gap > 0 ? "שלא מוסבר בלוח" : "יותר ממה שהתקבל"}: לבדוק החזרות, תיקונים ידניים וספירה`;
    return { itemId: it.id, name: it.name, collection: it.collection, ...parts, accounted, received, gap, verified, text };
  });
}

export type UnitCost = { collection: string; value: number | null; state: "verified" | "estimate" | "unknown"; text: string };

/** עלות ליחידה לקולקציה: עלות הייצור שהוזנה חלקי כמות הקבלה. בלי קבלה מאושרת לכל הפריטים
 *  בקולקציה זו הערכה לפי הכמות המשוחזרת, ומסומנת כך. הקולקציה היא טקסט חופשי מ-seed_items. */
export function collectionUnitCost(collection: string, prodCost: number, recon: ItemRecon[]): UnitCost {
  const items = recon.filter((r) => r.collection === collection);
  if (!prodCost || !items.length) return { collection, value: null, state: "unknown", text: "אין עלות ייצור או פריטים לקולקציה" };
  const allVerified = items.every((r) => r.verified);
  const received = items.reduce((a, r) => a + (r.received?.value ?? r.accounted), 0);
  if (!received) return { collection, value: null, state: "unknown", text: "אין כמות" };
  const value = Math.round(prodCost / received);
  if (allVerified) return { collection, value, state: "verified", text: `${value} ₪ ליחידה לפי ${received} שהתקבלו (מאומת)` };
  const missing = items.filter((r) => !r.received || r.received.value === null).map((r) => r.name);
  return { collection, value, state: "estimate", text: `כ-${value} ₪ ליחידה לפי ${received} משוחזרות. לא מאומת: ${missing.length ? `חסרה כמות קבלה ל${missing.join(", ")}` : "כמות הקבלה לא אושרה או לא תואמת"}` };
}

/** שם ישן של collectionUnitCost, נשמר לתאימות. */
export const dropUnitCost = collectionUnitCost;
