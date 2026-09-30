// "היום שלך": מה מצב העסק, מה דורש טיפול ומה הפעולה הבאה, בראש הלוח.
// לא עוד מקור אמת: הכל נגזר ממה שכבר קיים (ספר המכירות, תור ההכרעות של הצוות,
// צנרת הלידים, יומן הכספים). עד שלוש פעולות, ובלי המלצות כלליות כשאין מה לעשות.
// עדכון משלוח עובר דרך אותו מנגנון אישור של ברונו (assistant_pending): ממתין
// לאישור → בביצוע → בוצע / נכשל / לא ידוע, שורד רענון, ומבוצע פעם אחת.
import type { D1Database } from "@cloudflare/workers-types";
import { AUTO_TYPES } from "./team.rules.server";
import { type DecisionAction, executeAction, previewAction } from "./team.actions.server";
import { ilTodayISO } from "./summary.server";
import { type FigureState, moneySnapshot } from "./finance.summary.server";
import { type WaitingCounts, waitingCounts } from "./team.light.server";
import { type Delivery, mergeManualRows, openOrdersGrouped, orderKeyOf, SALES_SOURCE, salesWindow, setDelivery as setDeliveryRows, type ShipState, shipTargetDays } from "./orders.server";

/** לכל מספר: מקור, נכון-למתי ומצב אמינות (FIGURE_STATE_HE), כדי שהמסך יגיד את זה ולא רק בטולטיפ. */
export type TodayMoney = {
  revenue7: { value: number | null; orders: number | null; from: string | null; to: string | null; source: string; asOf: string | null };
  bank: { value: number | null; asOf: string | null; source: string; state: FigureState | null; note: string | null };
  expected: { value: number | null; asOf: string | null; source: string; state: FigureState | null; note: string | null };
  updatedAt: string;
};
export type OrderLine = { id: number; label: string; size: string; qty: number; price: number; status: string; location: string; locationHe: string };
export type TodayOrder = {
  key: string; // order:#1106 (מזהה Shopify) או row:<id> לרשומה ידנית בלי מזהה
  ref: string; // "#1104" או ריק
  noRef: boolean; // רשומה ידנית: אין מזהה הזמנה, כל שורה היא הזמנה
  buyer: string;
  firstName: string;
  city: string;
  phone: string;
  days: number;
  workDays: number; // ימי עבודה (א'-ה') שחלפו
  late: boolean; // מעל יעד ההוצאה בימי עבודה
  delivery: Delivery;
  deliveryAssumed: boolean;
  total: number;
  lines: OrderLine[];
  locations: string[];
  saleIds: number[];
  blockers: string[];
  cancelledLines: number;
  draft: string;
  missing: string[];
  /** לא נשלח מול נשלח-ולא-עודכן: מהראיה שעל השורות, לא ניחוש. */
  shipState: ShipState;
  shipLabel: string;
};
export type TodayCard = {
  id: string;
  level: "red" | "orange";
  who: string;
  title: string;
  why: string;
  minutes: number; // הערכה בלבד
  urgent: boolean;
  kind: "ship" | "decision" | "leads" | "tasks";
  href?: string;
  orders?: TodayOrder[];
  /** להכרעה של הצוות: האפשרויות עם "מה בדיוק ישתנה", כדי להכריע מכאן בלי לעבור טאב. */
  decisionId?: number;
  options?: { label: string; preview: string; auto?: boolean }[];
  leads?: { id: number; name: string; city: string; followup: string; daysLate: number; phone: string; draft: string; missing: string[] }[];
  /** משימות שלא זזו: של הצוות אחרי 3 ימים, כל משימה פתוחה אחרי 7. team = נפתחה ע"י עובד. */
  tasks?: { id: number; title: string; who: string; days: number; team: boolean }[];
};

/** משימה שעובד פתח ולא זזה כמה ימים חוזרת ל"היום שלך". */
export const STALE_TASK_DAYS = 3;
/** כל משימה פתוחה אחרת בלוח שלא זזה שבוע חוזרת לאותו כרטיס: תיבה אחת, לא עוד רשימה. */
export const STALE_ANY_TASK_DAYS = 7;
const TEAM_MARK = "%(הצוות של ברונו)%";
export type TodayAction = { id: number; title: string; change: string; state: "waiting" | "running" | "done" | "failed" | "unknown"; result: string; at: string };

const SHIP_TARGET_DAYS = 2;
// מי העלה את ההכרעה, בשם של העובד (ברירות המחדל; שינוי שם בטאב ברונו לא משנה כאן).
const WHO: Record<string, string> = { content: "מיכאלה · תוכן", design: "מיכאלה · עיצוב", ads: "יאן · ממומן", email: "יאן · מייל", collab: "ליה · משפיענים", bizdev: "ליה · הפצה", shop: "עידו · חנות", stock: "עידו · מלאי", finance: "אלכס · כספים" };
const daysSince = (day: string) => Math.max(0, Math.floor((Date.parse(`${ilTodayISO()}T12:00:00Z`) - Date.parse(`${day}T12:00:00Z`)) / 86400000));

async function tryFirst<T>(db: D1Database, sql: string, ...binds: unknown[]): Promise<T | null> {
  try {
    return await db.prepare(sql).bind(...binds).first<T>();
  } catch {
    return null;
  }
}

/** שלושה מספרים שונים, ואף פעם לא אפס במקום "לא ידוע": הכנסות (מה נמכר), כסף זמין
 *  (מה שבאמת נחת בבנק) וצפוי להיכנס (נמכר, ועדיין אצל הסולק). */
export async function todayMoney(db: D1Database): Promise<TodayMoney> {
  // 7 ימים ישראליים כולל היום, בלי תאריכים עתידיים: salesWindow, אותה הגדרה כמו בכרטיסי
  // הצוות, בדופק המכירות בטאב הכספים ובבריף. הזמנות לפי מזהה הזמנה (orderKeyOf).
  const rev = await salesWindow(db, { days: 7 }).catch(() => null);
  // אותה תמונת כסף שאלכס רואה: בלי כפילות חישוב, ובלי מכירות מבוטלות ב"צפוי".
  const snap = await moneySnapshot(db).catch(() => null);
  const bank = snap?.balances.bank ?? null;
  const clearing = snap?.receivables.clearing ?? null;
  return {
    revenue7: { value: rev ? Math.round(rev.revenue) : null, orders: rev ? rev.orders : null, from: rev?.from ?? null, to: rev?.to ?? null, source: rev?.source ?? SALES_SOURCE, asOf: rev?.asOf ?? null },
    bank: { value: bank?.value ?? null, asOf: bank?.asOf ?? null, source: bank?.source ?? "לוח הכספים", state: bank?.state ?? null, note: bank?.note ?? null },
    expected: { value: clearing?.value ?? null, asOf: clearing?.asOf ?? null, source: clearing?.source ?? "לוח הכספים", state: clearing?.state ?? null, note: clearing?.note ?? null },
    updatedAt: new Date().toISOString(),
  };
}

type SaleRow = { id: number; item_label: string; buyer: string; buyer_phone: string; buyer_address: string; qty: number; size: string; price: number; ship_status: string; note: string; sold_at: string };

/** טיוטת הודעה ללקוח, מהנתונים בלבד. מה שלא ידוע נרשם ב-missing ולא מומצא. */
function customerDraft(firstName: string, ref: string, workDays: number, missing: string[], target = SHIP_TARGET_DAYS): string {
  const late = workDays > target ? "\nסליחה שלקח קצת יותר ממה שרצינו." : "";
  if (!firstName) missing.push("שם הלקוח. ההודעה נפתחת בלי שם.");
  missing.push("מספר מעקב. לא רשום בלוח, אז אין שורת מעקב בהודעה.");
  // בשם המותג, לא בשם פרטי (יוגב, 19.9.2026: "שזה יהיה רק מסגולה").
  return `היי${firstName ? ` ${firstName}` : ""}, כאן SEGULA 🙌\nההזמנה שלך${ref ? ` (${ref})` : ""} יצאה היום לדרך.${late}\nאם משהו לא יושב טוב, החלפה ראשונה עלינו.`;
}

export async function openOrders(db: D1Database): Promise<TodayOrder[]> {
  const target = await shipTargetDays(db);
  return (await openOrdersGrouped(db)).map((o) => {
    const missing: string[] = [];
    if (!o.address && o.delivery !== "hand" && o.delivery !== "pickup") missing.push("כתובת למשלוח לא רשומה בהזמנה.");
    if (o.shipState === "shipped_unrecorded") missing.push("יש ראיה שההזמנה כבר יצאה (מספר מעקב או 'נשלח:'), אבל הסטטוס בלוח עוד לא עודכן. לעדכן סטטוס, לא לשלוח שוב.");
    // מזהה ידני הוא פנימי: לא נכנס להודעה ללקוח.
    const draft = customerDraft(o.firstName, o.ref.startsWith("#") ? o.ref : "", o.workDays, missing, target);
    return {
      key: o.key,
      ref: o.ref,
      noRef: o.noRef,
      buyer: o.buyer,
      firstName: o.firstName,
      city: o.city,
      phone: o.phone,
      days: o.days,
      workDays: o.workDays,
      late: o.late,
      delivery: o.delivery,
      deliveryAssumed: o.deliveryAssumed,
      total: o.total,
      lines: o.lines,
      locations: o.locations,
      saleIds: o.saleIds,
      blockers: o.blockers,
      cancelledLines: o.cancelledLines,
      draft,
      missing,
      shipState: o.shipState,
      shipLabel: o.shipLabel,
    };
  });
}

export async function mergeOrders(db: D1Database, saleIds: number[]) {
  return mergeManualRows(db, saleIds);
}

export async function setDelivery(db: D1Database, saleIds: number[], delivery: Delivery): Promise<number> {
  return setDeliveryRows(db, saleIds, delivery);
}

async function snoozed(db: D1Database): Promise<Record<string, string>> {
  try {
    const row = await db.prepare("SELECT value FROM settings WHERE key = 'today_snooze'").first<{ value: string }>();
    const all = JSON.parse(row?.value || "{}") as Record<string, string>;
    const today = ilTodayISO();
    return Object.fromEntries(Object.entries(all).filter(([, until]) => until > today));
  } catch {
    return {};
  }
}

/** "לא עכשיו" עם מועד חזרה. דבר דחוף (הזמנה מעל היעד) אי אפשר לדחות ליותר מיום. */
export async function snoozeCard(db: D1Database, cardId: string, days: number): Promise<string> {
  const d = Math.min(14, Math.max(1, Math.round(days)));
  const until = ilTodayISO(new Date(Date.now() + d * 86400000));
  const cur = await snoozed(db);
  cur[cardId] = until;
  await db.prepare("INSERT INTO settings (key, value) VALUES ('today_snooze', ?1) ON CONFLICT(key) DO UPDATE SET value = ?1").bind(JSON.stringify(cur)).run();
  return until;
}

export async function todayCards(db: D1Database): Promise<{ cards: TodayCard[]; failed: string[] }> {
  const failed: string[] = [];
  const cards: TodayCard[] = [];
  const hidden = await snoozed(db);

  // 1. הזמנות שמחכות למשלוח. מעל היעד = דחוף, תמיד ראשון.
  try {
    const orders = await openOrders(db);
    if (orders.length) {
      const oldest = Math.max(...orders.map((o) => o.workDays));
      const late = orders.filter((o) => o.late);
      const urgent = late.length > 0;
      const who = [...orders].sort((a, b) => b.workDays - a.workDays)[0];
      cards.push({
        id: "ship",
        kind: "ship",
        level: urgent ? "red" : "orange",
        urgent,
        who: "עידו · חנות",
        title: orders.length === 1 ? "לשלוח הזמנה אחת שמחכה" : `לשלוח ${orders.length} הזמנות שמחכות`,
        why: urgent
          ? `ההזמנה של ${who.firstName || who.buyer} מחכה ${oldest} ימי עבודה. היעד שלך הוא עד ${SHIP_TARGET_DAYS === 2 ? "יומיים" : `${SHIP_TARGET_DAYS} ימים`} (א'-ה').${late.length > 1 ? ` עוד ${late.length - 1} מעל היעד.` : ""}`
          : `הוותיקה מחכה ${oldest === 0 ? "מהיום" : oldest === 1 ? "יום עבודה אחד" : `${oldest} ימי עבודה`}, עדיין בתוך היעד של יומיים.`,
        minutes: Math.min(60, 5 * orders.length),
        orders,
      });
    }
  } catch {
    failed.push("הזמנות שמחכות למשלוח");
  }

  // 2. ההכרעות הפתוחות של הצוות (התור הקיים, עד שלוש, מדורג).
  try {
    const rows = (await db.prepare("SELECT id, agent, question, context, impact, options FROM team_decisions WHERE status = 'open' ORDER BY (origin = 'command') DESC, impact DESC, id ASC LIMIT 3").all<{ id: number; agent: string; question: string; context: string; impact: number; options: string }>()).results ?? [];
    for (const d of rows) {
      let options: { label: string; preview: string; auto?: boolean }[] = [];
      try {
        const parsed = JSON.parse(d.options) as { label: string; action?: DecisionAction }[];
        options = await Promise.all(parsed.map(async (o) => ({ label: o.label, preview: await previewAction(db, o.action).catch(() => ""), auto: Boolean(o.action?.type && AUTO_TYPES.has(o.action.type)) })));
      } catch {
        // אפשרויות לא קריאות: הכרטיס יפנה לטאב ברונו
      }
      cards.push({ id: `decision:${d.id}`, kind: "decision", decisionId: d.id, options, level: d.impact >= 5 ? "red" : "orange", urgent: d.impact >= 5, who: WHO[d.agent] ?? "הצוות של ברונו", title: d.question, why: d.context, minutes: 2, href: "/?tab=bruno" });
    }
  } catch {
    failed.push("ההכרעות של הצוות");
  }

  // 3. מעקבי לידים שעבר זמנם, עם נוסח הפתיחה שכבר שמור לכל ליד.
  try {
    const today = ilTodayISO();
    const leads = (await db.prepare("SELECT id, name, city, phone, followup_date, opener FROM bd_leads WHERE followup_date <> '' AND followup_date <= ? AND status NOT IN ('closed','archived') ORDER BY followup_date LIMIT 5").bind(today).all<{ id: number; name: string; city: string; phone: string; followup_date: string; opener: string }>()).results ?? [];
    if (leads.length) {
      const worst = daysSince(leads[0].followup_date);
      cards.push({
        id: "leads",
        kind: "leads",
        level: "orange",
        urgent: false,
        who: "ליה · הפצה",
        title: leads.length === 1 ? `לחזור ל${leads[0].name}` : `${leads.length} מעקבים שעבר זמנם`,
        why: `המעקב של ${leads[0].name} היה אמור לצאת לפני ${worst === 0 ? "היום" : `${worst} ימים`}.`,
        minutes: 5 * leads.length,
        href: "/?tab=bizdev",
        leads: leads.map((l) => {
          const missing: string[] = [];
          if (!l.opener) missing.push("אין נוסח פתיחה שמור לליד הזה. לא ניסחתי בשמך.");
          if (!l.phone) missing.push("אין טלפון רשום.");
          return { id: l.id, name: l.name, city: l.city, followup: l.followup_date, daysLate: daysSince(l.followup_date), phone: l.phone, draft: l.opener, missing };
        }),
      });
    }
  } catch {
    failed.push("מעקבי לידים");
  }

  // 4. משימות שלא זזו: מה שהצוות פתח ליוגב אחרי STALE_TASK_DAYS ימים, וכל משימה פתוחה
  //    אחרת בלוח אחרי STALE_ANY_TASK_DAYS. חוזרות לכאן עם "סיימתי" או "לא רלוונטי",
  //    עד שלוש, הכי ישנה (הכי הרבה זמן בלי תזוזה) קודם. בלי התראה נוספת; "לא עכשיו" דוחה כרגיל.
  try {
    const rows = (await db
      .prepare(
        `SELECT t.id, t.title, t.notes, t.created_at, t.updated_at, (t.notes LIKE ?1) AS team FROM tasks t
          WHERE t.status NOT IN ('done','archived')
            AND ((t.notes LIKE ?1 AND t.updated_at <= datetime('now', '-${STALE_TASK_DAYS} days'))
              OR t.updated_at <= datetime('now', '-${STALE_ANY_TASK_DAYS} days'))
          ORDER BY t.updated_at, t.id LIMIT 3`,
      )
      .bind(TEAM_MARK)
      .all<{ id: number; title: string; notes: string; created_at: string; updated_at: string; team: number }>()).results ?? [];
    if (rows.length) {
      // משימה של הצוות: מי פתח ולפני כמה ימים (כמו קודם). משימה רגילה: כמה ימים לא נגעו בה.
      const list = rows.map((t) =>
        t.team
          ? { id: t.id, title: t.title, who: (/^מאת: (.+?) \(הצוות של ברונו\)/.exec(t.notes)?.[1] ?? "הצוות").trim(), days: daysSince(t.created_at.slice(0, 10)), team: true }
          : { id: t.id, title: t.title, who: "משימה בלוח", days: daysSince(t.updated_at.slice(0, 10)), team: false },
      );
      const allTeam = list.every((t) => t.team);
      cards.push({
        id: "tasks",
        kind: "tasks",
        level: "orange",
        urgent: false,
        who: list[0].who,
        title: list.length === 1 ? `עדיין פתוח: ${list[0].title}` : allTeam ? `${list.length} משימות מהצוות לא זזו` : `${list.length} משימות לא זזו`,
        why: `${list[0].team ? `נפתחה לפני ${list[0].days} ימים ולא התקדמה` : `לא זזה ${list[0].days} ימים`}. סיימת? לחץ "סיימתי". לא רלוונטי? סגור אותה.`,
        minutes: 2,
        href: "/",
        tasks: list,
      });
    }
  } catch {
    failed.push("משימות שלא זזו");
  }

  // דחוף קודם, ובתוך כל רמה לפי הסדר שלמעלה. דחייה לא מסתירה דבר דחוף.
  const visible = cards.filter((c) => c.urgent || !hidden[c.id]);
  visible.sort((a, b) => Number(b.urgent) - Number(a.urgent));
  return { cards: visible, failed };
}

/** משפט אחד מברונו, מהמספרים בלבד (בלי קריאה למודל, בלי עלות). */
export function brunoLine(cards: TodayCard[], failed: string[], waiting?: WaitingCounts | null): string {
  const bits: string[] = [];
  const ship = cards.find((c) => c.kind === "ship");
  if (ship) bits.push(ship.urgent ? `${ship.title.replace("לשלוח ", "")}, ואחת מהן עברה את היעד. זה הדבר הראשון.` : `${ship.title.replace("לשלוח ", "")}, כולן עדיין בזמן.`);
  // אותה ספירה כמו התג וכותרת טאב הצוות (waitingCounts). כרטיס הכרעה כאן הוא אותו פריט, לא עוד אחד.
  if (waiting) {
    if (waiting.total) bits.push(`מחכות לך: ${waiting.breakdown}.`);
  } else {
    const decisions = cards.filter((c) => c.kind === "decision").length;
    if (decisions) bits.push(decisions === 1 ? "הכרעה אחת מחכה לך מהצוות." : `${decisions} הכרעות מחכות לך מהצוות.`);
  }
  if (cards.some((c) => c.kind === "leads")) bits.push("יש מעקב ליד שעבר זמנו.");
  const stale = cards.find((c) => c.kind === "tasks");
  if (stale) bits.push(stale.tasks?.every((t) => t.team) ? "יש משימה מהצוות שלא זזה." : "יש משימה פתוחה שלא זזה.");
  const base = bits.length ? bits.join(" ") : "אין היום משהו שדורש אותך.";
  return failed.length ? `${base} שים לב: לא הצלחתי לבדוק ${failed.join(" ו")}, אז זה לא מופיע כאן.` : base;
}

// ---- פעולות: עדכון משלוח באישור ----

const stateOf = (status: string): TodayAction["state"] => (status === "pending" ? "waiting" : status === "executing" ? "running" : status === "done" ? "done" : status === "failed" ? "failed" : "unknown");

export async function listActions(db: D1Database): Promise<TodayAction[]> {
  // ביצוע שנתקע יותר משתי דקות: לא ידוע. עדכון משלוח אידמפוטנטי, אז אפשר לבדוק ולהשלים בבטחה.
  await db.prepare("UPDATE assistant_pending SET status = 'unknown' WHERE tool = 'today_ship' AND status = 'executing' AND decided_at < datetime('now', '-120 seconds')").run();
  const rows =
    (
      await db
        .prepare("SELECT id, summary, status, result, COALESCE(decided_at, created_at) AS at FROM assistant_pending WHERE tool = 'today_ship' AND status <> 'cancelled' AND created_at >= datetime('now', '-2 days') ORDER BY id DESC LIMIT 8")
        .all<{ id: number; summary: string; status: string; result: string; at: string }>()
    ).results ?? [];
  return rows.map((r) => {
    const [title, change] = r.summary.split(" || ");
    return { id: r.id, title, change: change ?? "", state: stateOf(r.status), result: r.result, at: r.at };
  });
}

/** שלב "הכן לאישור": רושם מה בדיוק ישתנה. עוד לא משנה כלום. */
export async function prepareShip(db: D1Database, saleIds: number[], status: "shipped" | "delivered"): Promise<{ ok: boolean; id?: number; error?: string }> {
  const ids = [...new Set(saleIds.filter((n) => Number.isInteger(n) && n > 0))].slice(0, 20);
  if (!ids.length) return { ok: false, error: "no_lines" };
  const rows = (await db.prepare(`SELECT id, buyer, item_label, size, ship_status FROM seed_sales WHERE id IN (${ids.map(() => "?").join(",")})`).bind(...ids).all<{ id: number; buyer: string; item_label: string; size: string; ship_status: string }>()).results ?? [];
  if (rows.length !== ids.length) return { ok: false, error: "lines_not_found" };
  // הזמנה שבוטלה לא מתקדמת למשלוח, גם לא בטעות.
  if (rows.some((r) => r.ship_status === "cancelled")) return { ok: false, error: "cancelled_line" };
  // אותה בקשה פעמיים (לחיצה כפולה) מחזירה את אותה פעולה ממתינה.
  const input = JSON.stringify({ sale_ids: ids.sort((a, b) => a - b), status });
  const dup = await db.prepare("SELECT id FROM assistant_pending WHERE tool = 'today_ship' AND input = ? AND status IN ('pending','executing') LIMIT 1").bind(input).first<{ id: number }>();
  if (dup) return { ok: true, id: dup.id };
  const he = status === "delivered" ? "נמסר" : "נשלח";
  const buyer = (rows[0].buyer || "").split(" ")[0];
  const summary = `עדכון משלוח · ${buyer} || ${rows.map((r) => `#${r.id} ${r.item_label} ${r.size}`.trim()).join(", ")}: ${rows[0].ship_status === "packed" ? "ארוז" : "נרשם"} ← ${he}`;
  const res = await db.prepare("INSERT INTO assistant_pending (tool, input, summary, actor) VALUES ('today_ship', ?, ?, 'יוגב')").bind(input, summary.slice(0, 600)).run();
  return { ok: true, id: Number(res.meta?.last_row_id ?? 0) };
}

/** אישור: תפיסה אטומית, ביצוע, ותוצאה שאפשר לבדוק. "בוצע" רק אחרי שהשורות באמת עודכנו. */
export async function confirmShip(db: D1Database, id: number): Promise<{ ok: boolean; state: TodayAction["state"]; text: string }> {
  const row = await db.prepare("SELECT input, status, result FROM assistant_pending WHERE id = ? AND tool = 'today_ship'").bind(id).first<{ input: string; status: string; result: string }>();
  if (!row) return { ok: false, state: "failed", text: "הפעולה לא נמצאה" };
  if (row.status === "done") return { ok: true, state: "done", text: row.result };
  // pending, failed ו-unknown אפשר להריץ: עדכון סטטוס משלוח אידמפוטנטי (שורה שכבר "נשלח" נשארת כך).
  const claim = await db.prepare("UPDATE assistant_pending SET status = 'executing', decided_at = datetime('now') WHERE id = ? AND status IN ('pending','failed','unknown')").bind(id).run();
  if ((claim.meta?.changes ?? 0) !== 1) return { ok: false, state: "running", text: "הפעולה כבר בביצוע. לא נשלחה שוב." };
  const input = JSON.parse(row.input) as { sale_ids: number[]; status: string };
  // הראיה כאן היא ההזמנה עצמה: יוגב אישר בשני צעדים על כרטיס של הזמנה אחת (מזהה ההזמנה נשמר על השורה).
  const first = await db.prepare("SELECT order_ref, note FROM seed_sales WHERE id = ?").bind(input.sale_ids[0] ?? 0).first<{ order_ref: string; note: string }>();
  const ref = orderKeyOf({ id: input.sale_ids[0] ?? 0, order_ref: first?.order_ref ?? "", note: first?.note ?? "" }).ref;
  const out = await executeAction(db, "היום שלך", { type: "ship", sale_ids: input.sale_ids, status: input.status, evidence: `${ref ? `הזמנה ${ref}, ` : ""}אישור ידני בטאב היום` }, id, async () => undefined);
  const state: TodayAction["state"] = out.status === "ok" ? "done" : out.status === "partial" ? "failed" : "failed";
  await db.prepare("UPDATE assistant_pending SET status = ?, result = ? WHERE id = ?").bind(state === "done" ? "done" : "failed", out.text.slice(0, 600), id).run();
  return { ok: state === "done", state, text: out.text };
}

export async function cancelShip(db: D1Database, id: number): Promise<boolean> {
  const res = await db.prepare("UPDATE assistant_pending SET status = 'cancelled', decided_at = datetime('now') WHERE id = ? AND tool = 'today_ship' AND status IN ('pending','failed','unknown')").bind(id).run();
  return (res.meta?.changes ?? 0) === 1;
}

export async function todayState(db: D1Database) {
  const [{ cards, failed }, money, actions, waiting] = await Promise.all([todayCards(db), todayMoney(db), listActions(db).catch(() => [] as TodayAction[]), waitingCounts(db).catch(() => null)]);
  // משוב חיובי קטן: מה כבר נסגר היום (הכרעות שהוכרעו ושורות שסומנו כנשלחו).
  const doneToday = await tryFirst<{ n: number }>(
    db,
    "SELECT (SELECT COUNT(*) FROM team_decisions WHERE status = 'decided' AND decided_at >= datetime('now','-18 hours')) + (SELECT COUNT(*) FROM assistant_pending WHERE tool = 'today_ship' AND status = 'done' AND decided_at >= datetime('now','-18 hours')) AS n",
  );
  return { cards, failed, money, actions, line: brunoLine(cards, failed, waiting), waiting, doneToday: doneToday?.n ?? 0 };
}

/** "סיימתי" / "לא רלוונטי" על משימה של הצוות. רק משימות שהצוות פתח.
 *  הכרטיס ב"היום שלך" משתמש ב-closeStaleTask (גם משימות רגילות). */
export async function closeTeamTask(db: D1Database, id: number, how: "done" | "archived"): Promise<boolean> {
  const res = await db.prepare("UPDATE tasks SET status = ?, updated_at = datetime('now') WHERE id = ? AND status NOT IN ('done','archived') AND notes LIKE '%(הצוות של ברונו)%'").bind(how, id).run();
  return (res.meta?.changes ?? 0) === 1;
}

/** "סיימתי" / "לא רלוונטי" מכרטיס "לא זזו" ב"היום שלך": כל משימה, אבל רק פתוחה.
 *  משימה שכבר בוצעה או בארכיון לא נוגעים בה (לחיצה כפולה מחזירה false). */
export async function closeStaleTask(db: D1Database, id: number, how: "done" | "archived"): Promise<boolean> {
  if (!Number.isInteger(id) || id <= 0) return false;
  const res = await db.prepare("UPDATE tasks SET status = ?, updated_at = datetime('now') WHERE id = ? AND status NOT IN ('done','archived')").bind(how, id).run();
  return (res.meta?.changes ?? 0) === 1;
}
