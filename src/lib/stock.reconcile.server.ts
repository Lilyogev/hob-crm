// חשבון כמויות לפריט: מה שהלוח מסביר (נשארו + נמכרו + חולקו) מול כמות הקבלה מהספק.
// כמות הקבלה יושבת על הפריט (seed_items.received_*) עם מקור ומצב, כי הלוח לא שומר
// מלאי פתיחה. בלי כמות קבלה מאושרת: הכמות "משוחזרת" ולא מאומתת, ועלות ליחידה לא
// מוצגת כמאומתת. פער בין הקבלה לחשבון מוצג לבירור, בלי הסבר מומצא.
import type { D1Database } from "@cloudflare/workers-types";
import { stockBalance } from "./stock.rules";

export type ReceivedStatus = "pending" | "confirmed";
export const RECEIVED_STATUS_HE: Record<ReceivedStatus, string> = { pending: "הוזן, ממתין לאימות", confirmed: "אומת" };

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
  received: { value: number | null; status: ReceivedStatus; source: string; asOf: string } | null;
  /** קבלה פחות חשבון. null כשאין כמות קבלה. */
  gap: number | null;
  /** מאומת = יש קבלה מאושרת והחשבון תואם. */
  verified: boolean;
  text: string;
};

type ItemRow = { id: number; name: string; collection: string; received_qty: number | null; received_source: string; received_status: string; received_at: string; updated_at: string };

export async function itemReconciliation(db: D1Database): Promise<ItemRecon[]> {
  const items = (await db.prepare("SELECT id, name, COALESCE(NULLIF(collection,''),'main') AS collection, received_qty, COALESCE(received_source,'') AS received_source, COALESCE(received_status,'pending') AS received_status, COALESCE(received_at,'') AS received_at, updated_at FROM seed_items ORDER BY id").all<ItemRow>()).results ?? [];
  const left = new Map((((await db.prepare("SELECT item_id, SUM(qty + qty_xs + qty_s + qty_m + qty_l + qty_xl + qty_xxl) AS n FROM seed_stock GROUP BY item_id").all<{ item_id: number; n: number }>()).results) ?? []).map((r) => [r.item_id, r.n]));
  // מכירות בלי מבוטלות ובלי ארכיון; מתנות שנמסרו או פורסמו (הבטחה עוד לא יצאה מהמלאי בפועל).
  const sold = new Map((((await db.prepare("SELECT item_id, SUM(qty) AS n FROM seed_sales WHERE ship_status <> 'cancelled' AND COALESCE(channel,'') <> 'archive' GROUP BY item_id").all<{ item_id: number; n: number }>()).results) ?? []).map((r) => [r.item_id, r.n]));
  const given = new Map((((await db.prepare("SELECT item_id, SUM(qty) AS n FROM seed_gifts WHERE status <> 'promised' GROUP BY item_id").all<{ item_id: number; n: number }>()).results) ?? []).map((r) => [r.item_id, r.n]));
  return items.map((it) => {
    const parts = { left: left.get(it.id) ?? 0, sold: sold.get(it.id) ?? 0, given: given.get(it.id) ?? 0 };
    const { accounted } = stockBalance(parts);
    const status: ReceivedStatus = it.received_status === "confirmed" ? "confirmed" : "pending";
    const received = it.received_qty !== null && it.received_qty !== undefined ? { value: it.received_qty, status, source: it.received_source, asOf: it.received_at || it.updated_at.slice(0, 10) } : null;
    const gap = received ? received.value! - accounted : null;
    const verified = gap === 0 && received?.status === "confirmed";
    const base = `נשארו ${parts.left} + נמכרו ${parts.sold} + חולקו ${parts.given} = ${accounted}`;
    const text =
      gap === null
        ? `${base} משוחזר. כמות קבלה מהספק לא רשומה, אז הכמות לא מאומתת`
        : gap === 0
          ? `${base}, תואם לקבלה של ${received!.value} (${RECEIVED_STATUS_HE[received!.status]}${received!.source ? `, ${received!.source}` : ""})`
          : `${base}, אבל הקבלה היא ${received!.value} (${RECEIVED_STATUS_HE[received!.status]}). פער של ${Math.abs(gap)} ${gap > 0 ? "שלא מוסבר בלוח" : "יותר ממה שהתקבל"}: לבדוק החזרות, תיקונים ידניים וספירה`;
    return { itemId: it.id, name: it.name, collection: it.collection, ...parts, accounted, received, gap, verified, text };
  });
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** רישום כמות הקבלה מהספק לפריט. רישום אינו אימות: כל שינוי מחזיר ל"ממתין לאימות". */
export async function setReceivedQty(db: D1Database, itemId: number, patch: { value: number | null; source?: string; asOf?: string }): Promise<{ ok: boolean; error?: string }> {
  if (patch.value !== null && (!Number.isInteger(patch.value) || patch.value < 0)) return { ok: false, error: "כמות שלמה, לא שלילית" };
  const asOf = (patch.asOf ?? "").trim();
  if (asOf && !DATE_RE.test(asOf)) return { ok: false, error: "תאריך בפורמט YYYY-MM-DD" };
  const res = await db
    .prepare("UPDATE seed_items SET received_qty = ?, received_source = ?, received_status = 'pending', received_at = ?, updated_at = datetime('now') WHERE id = ?")
    .bind(patch.value, (patch.source ?? "").trim().slice(0, 200), asOf, itemId)
    .run();
  return res.meta?.changes ? { ok: true } : { ok: false, error: "פריט לא נמצא" };
}

/** אימות כמות הקבלה מול ראיה (חשבונית ספק, תעודת משלוח). חובה לציין מול מה. */
export async function verifyReceivedQty(db: D1Database, itemId: number, against: string): Promise<{ ok: boolean; error?: string }> {
  const what = against.trim().slice(0, 200);
  if (!what) return { ok: false, error: "כדי לאמת צריך לציין מול מה (חשבונית, תעודת משלוח)" };
  const cur = await db.prepare("SELECT received_qty, received_source FROM seed_items WHERE id = ?").bind(itemId).first<{ received_qty: number | null; received_source: string }>();
  if (!cur) return { ok: false, error: "פריט לא נמצא" };
  if (cur.received_qty === null) return { ok: false, error: "אין כמות לאמת. קודם לרשום את הכמות" };
  await db
    .prepare("UPDATE seed_items SET received_status = 'confirmed', received_source = ?, updated_at = datetime('now') WHERE id = ?")
    .bind(cur.received_source || what, itemId)
    .run();
  return { ok: true };
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
