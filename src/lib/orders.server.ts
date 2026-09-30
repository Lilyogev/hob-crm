// הזמנות ומלאי לפי מיקום.
// הזמנה = כל השורות עם אותו order_ref (מ-Shopify). רשומה ידנית בלי מזהה היא הזמנה
// של שורה אחת, ומסומנת כך. איחור נמדד בימי עבודה (א'-ה') מול יעד מהגדרות העסק.
// מיקומי מלאי = שתי השותפות (partners.ts LOCATIONS): אצל אביה / אצל ליאור.
import { classifyVariant, type GapKind, type WebStatus, webStatusOf } from "./stock.rules";
import { ilOffsetMs, ilTodayISO } from "./summary.server";
import { LOCATIONS, LOCATION_LABEL, type Location } from "./partners";
import type { D1Database } from "@cloudflare/workers-types";

export type SaleLine = {
  id: number;
  item_id: number | null;
  item_label: string;
  buyer: string;
  buyer_phone: string;
  buyer_address: string;
  qty: number;
  size: string;
  price: number;
  ship_status: string;
  location: string;
  note: string;
  sold_at: string;
  order_ref: string;
  delivery: string;
  channel: string;
  handled_by?: string;
};
export type Delivery = "" | "ship" | "pickup" | "hand";
export const DELIVERY_HE: Record<string, string> = { ship: "משלוח", pickup: "איסוף עצמי", hand: "מסירה ביד", "": "לא צוין" };
export const LOCATION_HE: Record<string, string> = { ...LOCATION_LABEL };

export type Order = {
  key: string;
  ref: string;
  noRef: boolean;
  buyer: string;
  firstName: string;
  phone: string;
  address: string;
  city: string;
  soldAt: string;
  days: number;
  workDays: number;
  late: boolean;
  delivery: Delivery;
  deliveryAssumed: boolean;
  status: "recorded" | "packed";
  lines: { id: number; label: string; size: string; qty: number; price: number; status: string; location: string; locationHe: string }[];
  locations: string[];
  /** מי מטפלת בהזמנה ('' | avia | lior), לפי השורה הראשונה. */
  handledBy: string;
  saleIds: number[];
  total: number;
  blockers: string[];
  cancelledLines: number;
  /** "לא נשלח" מול "נשלח בפועל אבל הלוח לא עודכן": שני מצבים שונים, שני צעדים שונים. */
  shipState: ShipState;
  shipLabel: string;
};

/** not_shipped = נרשם/ארוז בלי ראיה למשלוח. shipped_unrecorded = הסטטוס עוד נרשם/ארוז אבל על
 *  השורה יש ראיה ("נשלח: ..." או מספר מעקב), כלומר יצא בפועל והלוח לא עודכן. shipped = הסטטוס עצמו. */
export type ShipState = "not_shipped" | "shipped_unrecorded" | "shipped";
export const SHIP_STATE_HE: Record<ShipState, string> = {
  not_shipped: "לא נשלח: לארוז ולשלוח",
  shipped_unrecorded: "נשלח בפועל, הלוח לא עודכן: לעדכן סטטוס",
  shipped: "נשלח",
};
const TRACKING_RE = /\b[A-Z]{2}\d{9}[A-Z]{2}\b|\b\d{10,14}\b/;

/** מצב משלוח לפי הסטטוס והראיה שעל השורות. ראיה = "נשלח:" (מהכלי של הובי) או מספר מעקב. */
export function shipStateOf(lines: { ship_status: string; note: string | null }[]): ShipState {
  if (lines.length && lines.every((l) => l.ship_status === "shipped" || l.ship_status === "delivered")) return "shipped";
  const evidence = lines.some((l) => /נשלח:/.test(l.note ?? "") || TRACKING_RE.test(l.note ?? ""));
  return evidence ? "shipped_unrecorded" : "not_shipped";
}

/** ימי עבודה (א'-ה') שחלפו מאז המכירה, לא כולל היום עצמו. */
export function workDaysSince(soldAt: string, now = new Date()): number {
  const start = new Date(`${soldAt.slice(0, 10)}T00:00:00Z`);
  const end = new Date(`${now.toISOString().slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(start.getTime()) || end <= start) return 0;
  let n = 0;
  for (let d = new Date(start.getTime() + 86400000); d <= end; d = new Date(d.getTime() + 86400000)) {
    const dow = d.getUTCDay();
    if (dow <= 4) n++; // 0=ראשון ... 4=חמישי
  }
  return n;
}

const daysSince = (day: string, now = new Date()) => Math.max(0, Math.floor((now.getTime() - Date.parse(`${day.slice(0, 10)}T00:00:00Z`)) / 86400000));

/** מפתח ההזמנה: מזהה Shopify, או השורה עצמה כשאין מזהה. אף פעם לא שם+תאריך. */
export function orderKeyOf(row: Pick<SaleLine, "id" | "order_ref" | "note">): { key: string; ref: string; noRef: boolean } {
  const ref = (row.order_ref || /Shopify\s+(#\d{3,6})/.exec(row.note || "")?.[1] || "").trim();
  return ref ? { key: `order:${ref}`, ref, noRef: false } : { key: `row:${row.id}`, ref: "", noRef: true };
}

/** הגדרה אחת ל"הזמנה" בכל המסכים והדוחות: מזהה הזמנה (orderKeyOf), לא "קונה + תאריך".
 *  lines = שורות מוצר, units = יחידות. מחזיר גם פירוק לפי יום (sold_at). */
export type OrderCount = { orders: number; lines: number; units: number; revenue: number };
export function countOrders(rows: { id: number; order_ref: string | null; note: string | null; qty: number; price: number }[]): OrderCount {
  const keys = new Set(rows.map((r) => orderKeyOf({ id: r.id, order_ref: r.order_ref ?? "", note: r.note ?? "" }).key));
  return { orders: keys.size, lines: rows.length, units: rows.reduce((a, r) => a + (r.qty || 0), 0), revenue: rows.reduce((a, r) => a + (r.price || 0) * (r.qty || 0), 0) };
}

// ---- "מכירות בחלון": הגדרה אחת לכל המסכים והדוחות ----
// עד 20.9 כל מסך ספר אחרת: "היום שלך" ספר 8 ימים בלי גבול עליון (גם תאריכים עתידיים),
// "דופק מכירות" חישב בדפדפן לפי שעון המכשיר, הבריף ספר created_at ב-UTC, והדוח לממומן
// השמיט את היום. התוצאה: 2 הזמנות במסך אחד ו-0 במסך אחר לאותו שבוע. מכאן והלאה:
//  - יום המכירה = sold_at; כשריק (שורות ישנות וסנכרון Shopify שלא מילא אותו) יום היצירה
//    לפי שעון ישראל. הכל נחתך ל-10 תווים, כך שגם sold_at עם שעה נספר נכון.
//  - החלון = N ימים ישראליים אחרונים כולל היום, עם גבול עליון מפורש (בלי תאריכים עתידיים).
//  - בלי ארכיון (דרופים ישנים שיובאו) ובלי שורות מבוטלות.
//  - פופ-אפ נספר כברירת מחדל: זה כסף שנכנס. מי שמודד ממומן מול אונליין בלבד מעביר
//    includePopup: false, ומסמן את זה במסך ("בלי פופ-אפ").
//  - הזמנות לפי מזהה הזמנה (orderKeyOf), לא לפי שורות.

export const SALES_SOURCE = "ספר המכירות בלוח (בלי ארכיון ובלי מבוטלות)";

/** תאריך ISO + n ימים, בחשבון על התאריך עצמו (לא על מילישניות), כדי שמעבר שעון קיץ לא יזיז יום. */
export function shiftDay(dayISO: string, n: number): string {
  return new Date(Date.parse(`${dayISO.slice(0, 10)}T12:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
}

/** גבולות החלון: N ימים ישראליים שמסתיימים ב-endDay (ברירת מחדל: היום בישראל), כולל שני הקצוות. */
export function windowBounds(days: number, opts: { endDay?: string; now?: Date } = {}): { from: string; to: string; days: number } {
  const n = Math.max(1, Math.round(days));
  const to = opts.endDay ?? ilTodayISO(opts.now ?? new Date());
  return { from: shiftDay(to, -(n - 1)), to, days: n };
}

/** יום המכירה בישראל: sold_at כשיש, אחרת created_at מוזז לשעון ישראל (?1 = ההיסט). alias לטבלה עם כינוי. */
const saleDaySql = (alias = "") => `substr(COALESCE(NULLIF(${alias}sold_at,''), datetime(${alias}created_at, ?1)), 1, 10)`;
const SALE_DAY_SQL = saleDaySql();
const ilOffsetModifier = (now: Date) => `${ilOffsetMs(now) >= 0 ? "+" : "-"}${Math.abs(Math.round(ilOffsetMs(now) / 60000))} minutes`;

type WindowRow = { id: number; day: string; order_ref: string | null; note: string | null; qty: number; price: number; channel: string; pay_method: string };

async function salesRowsBetween(db: D1Database, from: string, to: string, opts: { includePopup?: boolean; now?: Date } = {}): Promise<WindowRow[]> {
  const includePopup = opts.includePopup ?? true;
  return (
    (
      await db
        .prepare(
          `SELECT id, ${SALE_DAY_SQL} AS day, order_ref, note, qty, price, COALESCE(channel,'') AS channel, COALESCE(pay_method,'') AS pay_method
             FROM seed_sales
            WHERE ${SALE_DAY_SQL} BETWEEN ?2 AND ?3
              AND COALESCE(channel,'') <> 'archive' AND ship_status <> 'cancelled'${includePopup ? "" : " AND COALESCE(channel,'') <> 'popup'"}
            ORDER BY day, id`,
        )
        .bind(ilOffsetModifier(opts.now ?? new Date()), from, to)
        .all<WindowRow>()
    ).results ?? []
  );
}

export type SalesWindow = OrderCount & {
  from: string;
  to: string;
  days: number;
  /** פדיון לפי אמצעי תשלום ("" = לא סומן), לבריף. */
  byPayMethod: Record<string, number>;
  source: string;
  asOf: string;
};

/** מכירות ב-N הימים הישראליים האחרונים כולל היום (או עד endDay), לפי ההגדרה שלמעלה. */
export async function salesWindow(db: D1Database, opts: { days: number; endDay?: string; includePopup?: boolean; now?: Date }): Promise<SalesWindow> {
  const now = opts.now ?? new Date();
  const { from, to, days } = windowBounds(opts.days, { endDay: opts.endDay, now });
  const rows = await salesRowsBetween(db, from, to, { includePopup: opts.includePopup, now });
  const byPayMethod: Record<string, number> = {};
  for (const r of rows) byPayMethod[r.pay_method] = (byPayMethod[r.pay_method] ?? 0) + (r.price || 0) * (r.qty || 0);
  return { ...countOrders(rows), from, to, days, byPayMethod, source: opts.includePopup === false ? `${SALES_SOURCE}, בלי פופ-אפ` : SALES_SOURCE, asOf: now.toISOString() };
}

export type SalesDay = { day: string; orders: number; lines: number; units: number; revenue: number };

/** אותו חלון, מפורק ליום (רק ימים שהיו בהם מכירות). לדופק המכירות ולגרפים. */
export async function salesByDaySeries(db: D1Database, opts: { days: number; endDay?: string; includePopup?: boolean; now?: Date }): Promise<{ from: string; to: string; series: SalesDay[] }> {
  const now = opts.now ?? new Date();
  const { from, to } = windowBounds(opts.days, { endDay: opts.endDay, now });
  const rows = await salesRowsBetween(db, from, to, { includePopup: opts.includePopup, now });
  const byDay = new Map<string, WindowRow[]>();
  for (const r of rows) byDay.set(r.day, [...(byDay.get(r.day) ?? []), r]);
  return { from, to, series: [...byDay.entries()].map(([day, rs]) => ({ day, ...countOrders(rs) })) };
}

/** מכירות מיום מסוים ועד היום (בישראל), בספירת הזמנות אחידה. עטיפה ל-salesWindow למי
 *  שכבר מחזיק תאריך התחלה; קוד חדש עדיף שיקרא ל-salesWindow עם מספר ימים. */
export async function orderStats(db: D1Database, sinceDay: string, opts: { excludePopup?: boolean; now?: Date } = {}): Promise<OrderCount> {
  const now = opts.now ?? new Date();
  const today = ilTodayISO(now);
  const days = Math.max(1, Math.round((Date.parse(`${today}T12:00:00Z`) - Date.parse(`${sinceDay.slice(0, 10)}T12:00:00Z`)) / 86400000) + 1);
  const w = await salesWindow(db, { days, includePopup: !opts.excludePopup, now });
  return { orders: w.orders, lines: w.lines, units: w.units, revenue: w.revenue };
}

export function groupOrders(rows: SaleLine[], opts: { targetDays?: number; now?: Date; sizedItems?: Set<number>; stockAt?: (itemId: number, location: string, size: string) => number | null } = {}): Order[] {
  const target = opts.targetDays ?? 2;
  const now = opts.now ?? new Date();
  const groups = new Map<string, SaleLine[]>();
  for (const r of rows) {
    const { key } = orderKeyOf(r);
    groups.set(key, [...(groups.get(key) ?? []), r]);
  }
  const orders: Order[] = [];
  for (const [key, all] of groups) {
    const live = all.filter((l) => l.ship_status === "recorded" || l.ship_status === "packed");
    if (!live.length) continue; // הזמנה שבוטלה או שכבר יצאה לא נכנסת לרשימת העבודה
    const first = live[0];
    const { ref, noRef } = orderKeyOf(first);
    const blockers: string[] = [];
    const delivery = (first.delivery as Delivery) || "";
    const deliveryAssumed = !delivery;
    if (!delivery && !first.buyer_address) blockers.push("צורת מסירה לא צוינה ואין כתובת");
    if ((delivery === "ship" || (!delivery && first.buyer_address === "")) && !first.buyer_address) blockers.push("אין כתובת למשלוח");
    if (delivery === "ship" && !first.buyer_phone) blockers.push("אין טלפון לשליח");
    for (const l of live) {
      if (l.item_id === null) blockers.push(`${l.item_label}: לא משויך לפריט במלאי`);
      else if (opts.sizedItems?.has(l.item_id) && !l.size) blockers.push(`${l.item_label}: מידה חסרה`);
      else if (opts.stockAt) {
        const left = opts.stockAt(l.item_id, l.location, l.size);
        if (left !== null && left < 0) blockers.push(`${l.item_label}${l.size ? ` ${l.size}` : ""}: המלאי ב${LOCATION_HE[l.location] ?? l.location} שלילי (${left}), כנראה נמכר יותר ממה שיש`);
      }
    }
    const workDays = workDaysSince(first.sold_at, now);
    const shipState = shipStateOf(live);
    orders.push({
      shipState,
      shipLabel: SHIP_STATE_HE[shipState],
      key,
      ref,
      noRef,
      buyer: first.buyer || "בלי שם",
      firstName: (first.buyer || "").trim().split(/\s+/)[0] ?? "",
      phone: first.buyer_phone || "",
      address: first.buyer_address || "",
      city: (first.buyer_address || "").split(",").map((s) => s.trim()).filter((s) => s && !/^\d+$/.test(s)).slice(-1)[0] ?? "",
      soldAt: first.sold_at.slice(0, 10),
      days: daysSince(first.sold_at, now),
      workDays,
      late: workDays > target,
      delivery,
      deliveryAssumed,
      status: live.every((l) => l.ship_status === "packed") ? "packed" : "recorded",
      lines: live.map((l) => ({ id: l.id, label: l.item_label, size: l.size, qty: l.qty, price: l.price, status: l.ship_status, location: l.location, locationHe: LOCATION_HE[l.location] ?? l.location })),
      locations: [...new Set(live.map((l) => l.location))],
      handledBy: first.handled_by ?? "",
      saleIds: live.map((l) => l.id),
      total: Math.round(live.reduce((a, l) => a + l.qty * l.price, 0)),
      blockers: [...new Set(blockers)],
      cancelledLines: all.length - live.length,
    });
  }
  // דחיפות: קודם מי שעבר את היעד (הוותיק ראשון), אחר כך לפי גיל; חסומים לא קופצים לראש.
  return orders.sort((a, b) => Number(b.late) - Number(a.late) || b.workDays - a.workDays || a.soldAt.localeCompare(b.soldAt));
}

const SIZE_COL: Record<string, string> = { "": "qty", XS: "qty_xs", S: "qty_s", M: "qty_m", L: "qty_l", XL: "qty_xl", XXL: "qty_xxl" };

export async function shipTargetDays(db: D1Database): Promise<number> {
  const row = await db.prepare("SELECT value FROM settings WHERE key = 'ship_target_days'").bind().first<{ value: string }>().catch(() => null);
  const n = Number(row?.value);
  return Number.isInteger(n) && n > 0 && n < 15 ? n : 2;
}

export async function openOrdersGrouped(db: D1Database, now = new Date()): Promise<Order[]> {
  const rows =
    (
      await db
        .prepare(
          `SELECT id, item_id, item_label, buyer, buyer_phone, buyer_address, qty, size, price, ship_status, location, note,
                  COALESCE(NULLIF(sold_at,''), substr(created_at,1,10)) AS sold_at, order_ref, delivery, COALESCE(channel,'') AS channel,
                  COALESCE(handled_by,'') AS handled_by
             FROM seed_sales
            WHERE (ship_status IN ('recorded','packed') OR order_ref IN (SELECT order_ref FROM seed_sales WHERE ship_status IN ('recorded','packed') AND order_ref != ''))
              AND COALESCE(channel,'') NOT IN ('archive','popup')
            ORDER BY sold_at, id`,
        )
        .all<SaleLine>()
    ).results ?? [];
  const stock = (await db.prepare("SELECT item_id, location, qty, qty_xs, qty_s, qty_m, qty_l, qty_xl, qty_xxl FROM seed_stock").all<Record<string, number> & { location: string }>()).results ?? [];
  const sized = new Set<number>();
  const at = new Map<string, number>();
  for (const s of stock) {
    if (s.qty_xs + s.qty_s + s.qty_m + s.qty_l + s.qty_xl + s.qty_xxl !== 0) sized.add(s.item_id);
    for (const [size, col] of Object.entries(SIZE_COL)) at.set(`${s.item_id}|${s.location}|${size}`, s[col]);
  }
  const target = await shipTargetDays(db);
  return groupOrders(rows, { targetDays: target, now, sizedItems: sized, stockAt: (i, loc, size) => at.get(`${i}|${loc}|${size.toUpperCase()}`) ?? null });
}

/** מחבר רשומות ידניות (בלי מזהה Shopify) להזמנה אחת, לפי החלטה של השותפות. המזהה הוא
 *  "ידני-<השורה הראשונה>". שורה עם מזהה Shopify, שורה שבוטלה או שורה של קונה אחר לא מחוברת. */
export async function mergeManualRows(db: D1Database, saleIds: number[]): Promise<{ ok: boolean; ref?: string; error?: string }> {
  const ids = [...new Set(saleIds.filter((n) => Number.isInteger(n) && n > 0))].slice(0, 20);
  if (ids.length < 2) return { ok: false, error: "צריך לפחות שתי שורות" };
  const rows = (await db.prepare(`SELECT id, buyer, order_ref, note, ship_status FROM seed_sales WHERE id IN (${ids.map(() => "?").join(",")})`).bind(...ids).all<{ id: number; buyer: string; order_ref: string; note: string; ship_status: string }>()).results ?? [];
  if (rows.length !== ids.length) return { ok: false, error: "שורה לא נמצאה" };
  if (rows.some((r) => r.ship_status === "cancelled")) return { ok: false, error: "אחת השורות בוטלה" };
  if (rows.some((r) => /^#\d/.test(r.order_ref) || /Shopify\s+#\d/.test(r.note))) return { ok: false, error: "שורה עם מזהה Shopify לא מחוברת ידנית" };
  if (new Set(rows.map((r) => r.buyer.trim())).size > 1) return { ok: false, error: "השורות של קונים שונים" };
  const ref = `ידני-${Math.min(...ids)}`;
  await db.prepare(`UPDATE seed_sales SET order_ref = ? WHERE id IN (${ids.map(() => "?").join(",")})`).bind(ref, ...ids).run();
  return { ok: true, ref };
}

/** צורת מסירה לכל שורות ההזמנה. לא נוגע בסטטוס ולא במלאי. */
export async function setDelivery(db: D1Database, saleIds: number[], delivery: Delivery): Promise<number> {
  if (!["", "ship", "pickup", "hand"].includes(delivery)) return 0;
  const ids = [...new Set(saleIds.filter((n) => Number.isInteger(n) && n > 0))].slice(0, 30);
  if (!ids.length) return 0;
  const res = await db.prepare(`UPDATE seed_sales SET delivery = ? WHERE id IN (${ids.map(() => "?").join(",")}) AND ship_status != 'cancelled'`).bind(delivery, ...ids).run();
  return res.meta?.changes ?? 0;
}

// ---- מלאי לפי מיקום ----
// המלאי כבר יורד ברגע המכירה או המתנה (adjustStockStmt), אז "שמור להזמנות" ו"הוקצה
// לצילום/משפיענים" הם מידע ולא הפחתה נוספת. מה שכתוב כאן מתאר מה יש פיזית ואצל מי.

/** webReason מלא = "מלאי פיזי בלבד, לא מוצג באתר בכוונה" (seed_items.web_status), עם הסיבה.
 *  avia / lior = כמה יש אצל כל שותפה; total = הסכום. */
export type StockLine = { itemId: number; name: string; size: string; avia: number; lior: number; total: number; reserved: number; allocated: number; webReason?: string };
/** kind: "gap" = פער סנכרון לבירור. "historical" = רשומת Shopify ישנה של פריט שלא מוצג באתר בכוונה. */
export type GapTreatStatus = "new" | "working" | "explained";
export type GapTreat = { status: GapTreatStatus; note: string; at: string };
/** source/syncedAt = מאיפה ומתי הצד של Shopify (המטמון של 10 דקות או משיכה חיה); הצד של הלוח
 *  תמיד "לוח, עכשיו". nextStep = צעד קבוע לפי סוג הפער. treat = מצב הטיפול, נשמר ב-settings לפי variant. */
export type StockGap = { name: string; size: string; board: number; shopify: number | null; variant: string; note: string; kind?: GapKind; source: string; syncedAt: string | null; nextStep: string; treat: GapTreat };

const GAP_TREAT_KEY = "stock_gap_treat";
export const GAP_TREAT_HE: Record<GapTreatStatus, string> = { new: "חדש", working: "בטיפול", explained: "הוסבר" };

/** צעד הבא לפער, דטרמיניסטי: לפי מה שרואים, לא לפי ניחוש. אף פעם לא תיקון אוטומטי של Shopify. */
export function gapNextStep(g: { board: number; shopify: number | null; status?: string; kind?: GapKind }): string {
  if (g.kind === "historical") return "רשומה ישנה של פריט שלא באתר בכוונה: לא פער מלאי, לא לפרסם";
  if (g.shopify === null) return "לבדוק אם המוצר שונה שם או נמחק ב-Shopify, ואז shopify_map";
  if (g.status && g.status !== "ACTIVE") return "מוצר לא פעיל בחנות: לא פער מלאי";
  if (g.board > g.shopify) return "לספור פיזית; אם הלוח צודק, לעדכן את החנות ידנית (לא אוטומטי)";
  if (g.board < g.shopify) return "לבדוק מכירה שלא נרשמה בלוח או חלוקה שלא נרשמה";
  return "";
}

export async function loadGapTreat(db: D1Database): Promise<Record<string, GapTreat>> {
  try {
    const row = await db.prepare("SELECT value FROM settings WHERE key = ?").bind(GAP_TREAT_KEY).first<{ value: string }>();
    const parsed = row ? (JSON.parse(row.value) as Record<string, GapTreat>) : {};
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

/** סימון טיפול בפער (חדש / בטיפול / הוסבר) עם הערה. "חדש" בלי הערה מוחק את הרשומה. */
export async function setGapTreat(db: D1Database, variant: string, status: string, note = ""): Promise<{ ok: boolean; error?: string }> {
  const v = variant.trim().slice(0, 200);
  if (!v) return { ok: false, error: "חסר וריאנט" };
  if (status !== "new" && status !== "working" && status !== "explained") return { ok: false, error: "מצב לא מוכר" };
  const all = await loadGapTreat(db);
  const clean = note.trim().slice(0, 300);
  if (status === "new" && !clean) delete all[v];
  else all[v] = { status, note: clean, at: new Date().toISOString() };
  await db.prepare("INSERT INTO settings (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = ?2").bind(GAP_TREAT_KEY, JSON.stringify(all)).run();
  return { ok: true };
}

export async function stockByLocation(db: D1Database): Promise<StockLine[]> {
  const items = (await itemsWithWebStatus(db)).sort((a, b) => a.id - b.id);
  const stock = (await db.prepare("SELECT item_id, location, qty, qty_xs, qty_s, qty_m, qty_l, qty_xl, qty_xxl FROM seed_stock").all<Record<string, number> & { location: string }>()).results ?? [];
  const reserved = (await db.prepare("SELECT item_id, UPPER(size) AS size, SUM(qty) AS n FROM seed_sales WHERE ship_status IN ('recorded','packed') AND COALESCE(channel,'') NOT IN ('archive') AND item_id IS NOT NULL GROUP BY item_id, UPPER(size)").all<{ item_id: number; size: string; n: number }>()).results ?? [];
  const allocated = (await db.prepare("SELECT item_id, UPPER(size) AS size, SUM(qty) AS n FROM seed_gifts WHERE status = 'promised' AND item_id IS NOT NULL GROUP BY item_id, UPPER(size)").all<{ item_id: number; size: string; n: number }>()).results ?? [];
  const key = (i: number, s: string) => `${i}|${s}`;
  const res = new Map<string, number>(reserved.map((r) => [key(r.item_id, r.size), r.n]));
  const alloc = new Map<string, number>(allocated.map((r) => [key(r.item_id, r.size), r.n]));
  const out: StockLine[] = [];
  for (const it of items) {
    const rows = stock.filter((s) => s.item_id === it.id);
    for (const [size, col] of Object.entries(SIZE_COL)) {
      const at = (loc: Location) => rows.filter((r) => r.location === loc).reduce((a, r) => a + (r[col] ?? 0), 0);
      const avia = at("avia");
      const lior = at("lior");
      const line: StockLine = { itemId: it.id, name: it.name, size, avia, lior, total: avia + lior, reserved: res.get(key(it.id, size)) ?? 0, allocated: alloc.get(key(it.id, size)) ?? 0, ...(it.webStatus === "physical_only" ? { webReason: it.webReason || "לא צוינה סיבה" } : {}) };
      if (line.avia || line.lior || line.reserved || line.allocated) out.push(line);
    }
  }
  return out;
}

export function stockBlock(lines: StockLine[]): string {
  if (!lines.length) return "### מלאי לפי מיקום\nאין רשומות מלאי.";
  const byItem = new Map<string, StockLine[]>();
  for (const l of lines) byItem.set(l.name, [...(byItem.get(l.name) ?? []), l]);
  const fmt = (n: number) => (n ? String(n) : "-");
  const rows = [...byItem.entries()].map(([name, ls]) => `- ${name}${ls[0]?.webReason ? ` [מלאי פיזי בלבד, לא מוצג באתר בכוונה: ${ls[0].webReason}. נספר במלאי ובשווי, לא פער סנכרון]` : ""}: ${ls.map((l) => `${l.size || "ללא מידה"} ${LOCATION_LABEL.avia} ${fmt(l.avia)}, ${LOCATION_LABEL.lior} ${fmt(l.lior)}${l.reserved ? `, בהזמנות פתוחות ${l.reserved}` : ""}${l.allocated ? `, הובטח למשפיענים ${l.allocated}` : ""}`).join(" · ")}`);
  return `### מלאי לפי מיקום (המלאי כבר הופחת בעת המכירה; "בהזמנות פתוחות" ו"הובטח" הם מידע, לא הפחתה נוספת)\nהמלאי יושב אצל אחת השותפות (${LOCATIONS.map((l) => LOCATION_LABEL[l]).join(" / ")}); לאריזה צריך שהפריט יהיה אצל מי שאורזת.\n${rows.join("\n")}`;
}

/** פערים מול Shopify דרך מפת הווריאנטים (מזהים יציבים). בלי תיקון אוטומטי. פריט "מלאי פיזי
 *  בלבד" לא נחשב פער; רשומה ישנה שלו עם כמות שלילית חוזרת כ-historical, בנפרד. */
export async function shopifyGaps(
  db: D1Database,
  variants: { product: string; variant: string; qty: number | null; status: string }[],
  lines: StockLine[],
  opts: { source?: string; syncedAt?: number | null } = {},
): Promise<StockGap[]> {
  const map = (await db.prepare("SELECT item_id, size, variant_title FROM seed_variant_map").all<{ item_id: number; size: string; variant_title: string }>()).results ?? [];
  if (!map.length) return [];
  const web = new Map((await itemsWithWebStatus(db)).map((i) => [i.id, i]));
  const treat = await loadGapTreat(db);
  const source = opts.source ?? "Shopify (מטמון 10 דק׳) מול הלוח";
  const syncedAt = opts.syncedAt ? new Date(opts.syncedAt).toISOString() : null;
  const gaps: StockGap[] = [];
  for (const m of map) {
    const v = variants.find((x) => `${x.product} / ${x.variant}` === m.variant_title);
    const line = lines.find((l) => l.itemId === m.item_id && l.size === (m.size || "").toUpperCase());
    const item = web.get(m.item_id);
    const board = line ? line.total : 0;
    const name = line?.name ?? item?.name ?? `פריט ${m.item_id}`;
    const kind = classifyVariant({ webStatus: item?.webStatus ?? "listed", board, shopify: v ? v.qty : null, found: Boolean(v) });
    if (!kind) continue;
    const base = { name, size: m.size, board, variant: m.variant_title, kind, source, syncedAt, treat: treat[m.variant_title] ?? { status: "new" as const, note: "", at: "" } };
    if (kind === "historical") {
      gaps.push({ ...base, shopify: v?.qty ?? null, nextStep: gapNextStep({ board, shopify: v?.qty ?? null, kind }), note: `לא מוצג באתר בכוונה (${item?.webReason || "לא צוינה סיבה"}). רשומה ישנה ב-Shopify עם כמות שלילית: נתון היסטורי לבדיקה, לא סיבה לפרסם` });
      continue;
    }
    if (!v) gaps.push({ ...base, shopify: null, nextStep: gapNextStep({ board, shopify: null }), note: "הווריאנט לא נמצא ב-Shopify (נמחק או שונה שם)" });
    else gaps.push({ ...base, shopify: v.qty, nextStep: gapNextStep({ board, shopify: v.qty, status: v.status }), note: v.status !== "ACTIVE" ? `מוצר ${v.status}` : "" });
  }
  return gaps;
}

/** שורת טקסט אחת לפער, לדוח ולהובי: מקור, זמן סנכרון, צעד הבא ומצב הטיפול. */
export function gapLine(x: StockGap): string {
  const sync = x.syncedAt ? `סונכרן ${x.syncedAt.slice(0, 16).replace("T", " ")}` : "זמן סנכרון לא ידוע";
  const treat = x.treat.status === "new" ? "" : ` · ${GAP_TREAT_HE[x.treat.status]}${x.treat.note ? `: ${x.treat.note}` : ""}`;
  return `- ${x.name}${x.size ? ` ${x.size}` : ""}: בלוח (שני המיקומים) ${x.board}, ב-Shopify ${x.shopify === null ? "לא נמצא" : x.shopify}${x.note ? ` · ${x.note}` : ""} · מקור: ${x.source}, ${sync}${x.nextStep ? ` · הצעד הבא: ${x.nextStep}` : ""}${treat}`;
}

/** מכירות לפריט ב-7 וב-30 הימים הישראליים האחרונים כולל היום, באותו ביטוי יום כמו salesWindow,
 *  ומה שנשאר במלאי (כל המיקומים). להובי: נתון חי עם תאריך, לא זיכרון. */
export async function salesByItemWindows(db: D1Database, now = new Date()): Promise<{ asOf: string; from7: string; from30: string; items: { itemId: number; name: string; sold7: number; sold30: number; left: number }[] }> {
  const { from: from7, to } = windowBounds(7, { now });
  const { from: from30 } = windowBounds(30, { now });
  const rows =
    (
      await db
        .prepare(
          `SELECT i.id AS item_id, i.name,
                  COALESCE(SUM(CASE WHEN ${saleDaySql("s.")} BETWEEN ?2 AND ?4 THEN s.qty ELSE 0 END), 0) AS sold7,
                  COALESCE(SUM(CASE WHEN ${saleDaySql("s.")} BETWEEN ?3 AND ?4 THEN s.qty ELSE 0 END), 0) AS sold30,
                  (SELECT COALESCE(SUM(qty + qty_xs + qty_s + qty_m + qty_l + qty_xl + qty_xxl), 0) FROM seed_stock WHERE item_id = i.id) AS left_qty
             FROM seed_items i
             LEFT JOIN seed_sales s ON s.item_id = i.id AND COALESCE(s.channel,'') <> 'archive' AND s.ship_status <> 'cancelled'
            GROUP BY i.id, i.name
            ORDER BY i.id`,
        )
        .bind(ilOffsetModifier(now), from7, from30, to)
        .all<{ item_id: number; name: string; sold7: number; sold30: number; left_qty: number }>()
    ).results ?? [];
  return { asOf: to, from7, from30, items: rows.map((r) => ({ itemId: r.item_id, name: r.name, sold7: r.sold7, sold30: r.sold30, left: r.left_qty })) };
}

/** פריטים עם הסטטוס שלהם באתר. עמיד גם בלי העמודה: אז הכל 'listed'. */
export async function itemsWithWebStatus(db: D1Database): Promise<{ id: number; name: string; webStatus: WebStatus; webReason: string }[]> {
  try {
    const rows = (await db.prepare("SELECT id, name, web_status, web_reason FROM seed_items").all<{ id: number; name: string; web_status: string; web_reason: string }>()).results ?? [];
    return rows.map((r) => ({ id: r.id, name: r.name, webStatus: webStatusOf(r.web_status), webReason: r.web_reason ?? "" }));
  } catch {
    const rows = (await db.prepare("SELECT id, name FROM seed_items").all<{ id: number; name: string }>()).results ?? [];
    return rows.map((r) => ({ id: r.id, name: r.name, webStatus: "listed" as const, webReason: "" }));
  }
}

/** סימון פריט כ"מלאי פיזי בלבד" (עם סיבה, חובה) או החזרה ל"מוצג באתר". לא נוגע במלאי. */
export async function setWebStatus(db: D1Database, itemId: number, status: WebStatus, reason: string): Promise<{ ok: boolean; error?: string }> {
  const why = reason.trim().slice(0, 200);
  if (status === "physical_only" && !why) return { ok: false, error: "צריך סיבה: למה הפריט לא מוצג באתר" };
  const res = await db.prepare("UPDATE seed_items SET web_status = ?, web_reason = ? WHERE id = ?").bind(status, status === "physical_only" ? why : "", itemId).run();
  if (!res.meta?.changes) return { ok: false, error: "פריט לא נמצא" };
  // עדכונים שכבר חיכו בתור לסנכרון של פריט כזה לא יוצאים ל-Shopify.
  if (status === "physical_only") await db.prepare("DELETE FROM shopify_push_queue WHERE item_id = ?").bind(itemId).run();
  return { ok: true };
}
