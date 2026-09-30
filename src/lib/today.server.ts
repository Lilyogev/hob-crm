// "היום שלכן": what needs handling and what the next action is, at the top of
// the task views. Not another source of truth: everything is derived from
// what already exists (the sales ledger, the tasks board). Up to three
// cards, and no generic advice when there is nothing to do.
// A shipping update goes through Hobi's confirmation mechanism
// (assistant_pending): waiting → executing → done / failed, survives a
// refresh, and runs once.
import type { D1Database } from "@cloudflare/workers-types";
import { ilTodayISO } from "./summary.server";
import { partnerLabel } from "./partners";
import { type Delivery, mergeManualRows, openOrdersGrouped, orderKeyOf, SALES_SOURCE, salesWindow, setDelivery as setDeliveryRows, type ShipState, shipTargetDays } from "./orders.server";

export type TodayMoney = {
  revenue7: { value: number | null; orders: number | null; from: string | null; to: string | null; source: string; asOf: string | null };
  updatedAt: string;
};
export type OrderLine = { id: number; label: string; size: string; qty: number; price: number; status: string; location: string; locationHe: string };
export type TodayOrder = {
  key: string; // order:#1106 (Shopify id) or row:<id> for a manual row without an id
  ref: string;
  noRef: boolean;
  buyer: string;
  firstName: string;
  city: string;
  phone: string;
  days: number;
  workDays: number; // working days (Sun-Thu) elapsed
  late: boolean; // past the shipping target in working days
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
  shipState: ShipState;
  shipLabel: string;
};
export type TodayCard = {
  id: string;
  level: "red" | "orange";
  who: string;
  title: string;
  why: string;
  minutes: number; // an estimate only
  urgent: boolean;
  kind: "ship" | "tasks";
  href?: string;
  orders?: TodayOrder[];
  /** Tasks that have not moved for STALE_TASK_DAYS. */
  tasks?: { id: number; title: string; who: string; days: number }[];
};

/** An open task nobody touched for a week comes back to "today". */
export const STALE_TASK_DAYS = 7;
export type TodayAction = { id: number; title: string; change: string; state: "waiting" | "running" | "done" | "failed" | "unknown"; result: string; at: string };

const daysSince = (day: string) => Math.max(0, Math.floor((Date.parse(`${ilTodayISO()}T12:00:00Z`) - Date.parse(`${day}T12:00:00Z`)) / 86400000));

async function tryFirst<T>(db: D1Database, sql: string, ...binds: unknown[]): Promise<T | null> {
  try {
    return await db.prepare(sql).bind(...binds).first<T>();
  } catch {
    return null;
  }
}

async function brandName(db: D1Database): Promise<string> {
  const row = await tryFirst<{ value: string }>(db, "SELECT value FROM settings WHERE key = 'brand_name'");
  return row?.value || "hob";
}

/** Revenue of the last 7 Israel days, from the sales ledger. Never zero in place of "unknown". */
export async function todayMoney(db: D1Database): Promise<TodayMoney> {
  const rev = await salesWindow(db, { days: 7 }).catch(() => null);
  return {
    revenue7: { value: rev ? Math.round(rev.revenue) : null, orders: rev ? rev.orders : null, from: rev?.from ?? null, to: rev?.to ?? null, source: rev?.source ?? SALES_SOURCE, asOf: rev?.asOf ?? null },
    updatedAt: new Date().toISOString(),
  };
}

/** Draft message to the customer, from the data only. What is unknown goes to `missing`, never invented. */
function customerDraft(brand: string, firstName: string, ref: string, workDays: number, missing: string[], target: number): string {
  const late = workDays > target ? "\nסליחה שלקח קצת יותר ממה שרצינו." : "";
  if (!firstName) missing.push("שם הלקוחה. ההודעה נפתחת בלי שם.");
  missing.push("מספר מעקב. לא רשום בלוח, אז אין שורת מעקב בהודעה.");
  return `היי${firstName ? ` ${firstName}` : ""}, כאן ${brand} 🤍\nההזמנה שלך${ref ? ` (${ref})` : ""} יצאה היום לדרך.${late}\nאם משהו לא יושב טוב, החלפה ראשונה עלינו.`;
}

export async function openOrders(db: D1Database): Promise<TodayOrder[]> {
  const target = await shipTargetDays(db);
  const brand = await brandName(db);
  return (await openOrdersGrouped(db)).map((o) => {
    const missing: string[] = [];
    if (!o.address && o.delivery !== "hand" && o.delivery !== "pickup") missing.push("כתובת למשלוח לא רשומה בהזמנה.");
    if (o.shipState === "shipped_unrecorded") missing.push("יש ראיה שההזמנה כבר יצאה (מספר מעקב או 'נשלח:'), אבל הסטטוס בלוח עוד לא עודכן. לעדכן סטטוס, לא לשלוח שוב.");
    // A manual id is internal: it does not go into the customer's message.
    const draft = customerDraft(brand, o.firstName, o.ref.startsWith("#") ? o.ref : "", o.workDays, missing, target);
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

/** "Not now" with a return date. An urgent card (an order past target) cannot be snoozed. */
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

  // 1. Orders waiting to ship. Past the target = urgent, always first.
  try {
    const orders = await openOrders(db);
    if (orders.length) {
      const target = await shipTargetDays(db);
      const oldest = Math.max(...orders.map((o) => o.workDays));
      const late = orders.filter((o) => o.late);
      const urgent = late.length > 0;
      const who = [...orders].sort((a, b) => b.workDays - a.workDays)[0];
      cards.push({
        id: "ship",
        kind: "ship",
        level: urgent ? "red" : "orange",
        urgent,
        who: "משלוחים",
        title: orders.length === 1 ? "לשלוח הזמנה אחת שמחכה" : `לשלוח ${orders.length} הזמנות שמחכות`,
        why: urgent
          ? `ההזמנה של ${who.firstName || who.buyer} מחכה ${oldest} ימי עבודה. היעד הוא עד ${target === 2 ? "יומיים" : `${target} ימים`} (א'-ה').${late.length > 1 ? ` עוד ${late.length - 1} מעל היעד.` : ""}`
          : `הוותיקה מחכה ${oldest === 0 ? "מהיום" : oldest === 1 ? "יום עבודה אחד" : `${oldest} ימי עבודה`}, עדיין בתוך היעד.`,
        minutes: Math.min(60, 5 * orders.length),
        orders,
      });
    }
  } catch {
    failed.push("הזמנות שמחכות למשלוח");
  }

  // 2. Tasks that have not moved for a week. Up to three, oldest first, with
  //    "סיימתי" / "לא רלוונטי" right here. No extra alert; "not now" snoozes.
  try {
    const rows =
      (
        await db
          .prepare(
            `SELECT id, title, owner, updated_at FROM tasks
              WHERE status NOT IN ('done','archived') AND updated_at <= datetime('now', '-${STALE_TASK_DAYS} days')
              ORDER BY updated_at, id LIMIT 3`,
          )
          .all<{ id: number; title: string; owner: string; updated_at: string }>()
      ).results ?? [];
    if (rows.length) {
      const list = rows.map((t) => ({ id: t.id, title: t.title, who: t.owner ? partnerLabel(t.owner) : "בלי אחראית", days: daysSince(t.updated_at.slice(0, 10)) }));
      cards.push({
        id: "tasks",
        kind: "tasks",
        level: "orange",
        urgent: false,
        who: "הלוח",
        title: list.length === 1 ? `עדיין פתוח: ${list[0].title}` : `${list.length} משימות לא זזו`,
        why: `לא זזה ${list[0].days} ימים. סיימתן? לחצו "סיימתי". לא רלוונטי? סגרו אותה.`,
        minutes: 2,
        href: "/",
        tasks: list,
      });
    }
  } catch {
    failed.push("משימות שלא זזו");
  }

  // Urgent first, then the order above. A snooze never hides an urgent card.
  const visible = cards.filter((c) => c.urgent || !hidden[c.id]);
  visible.sort((a, b) => Number(b.urgent) - Number(a.urgent));
  return { cards: visible, failed };
}

/** One sentence from Hobi, from the numbers only (no model call). */
export function hobiLine(cards: TodayCard[], failed: string[]): string {
  const bits: string[] = [];
  const ship = cards.find((c) => c.kind === "ship");
  if (ship) bits.push(ship.urgent ? `${ship.title.replace("לשלוח ", "")}, ואחת מהן עברה את היעד. זה הדבר הראשון.` : `${ship.title.replace("לשלוח ", "")}, כולן עדיין בזמן.`);
  if (cards.some((c) => c.kind === "tasks")) bits.push("יש משימה פתוחה שלא זזה.");
  const base = bits.length ? bits.join(" ") : "אין היום משהו שדורש אתכן.";
  return failed.length ? `${base} שימו לב: לא הצלחתי לבדוק ${failed.join(" ו")}, אז זה לא מופיע כאן.` : base;
}

// ---- Actions: shipping update with confirmation ----

const stateOf = (status: string): TodayAction["state"] => (status === "pending" ? "waiting" : status === "executing" ? "running" : status === "done" ? "done" : status === "failed" ? "failed" : "unknown");

export async function listActions(db: D1Database): Promise<TodayAction[]> {
  const rows =
    (
      await db
        .prepare("SELECT id, summary, status, result, created_at AS at FROM assistant_pending WHERE tool = 'today_ship' AND status NOT IN ('cancelled','expired') AND created_at >= datetime('now', '-2 days') ORDER BY id DESC LIMIT 8")
        .all<{ id: number; summary: string; status: string; result: string; at: string }>()
    ).results ?? [];
  return rows.map((r) => {
    const [title, change] = r.summary.split(" || ");
    return { id: r.id, title, change: change ?? "", state: stateOf(r.status), result: r.result, at: r.at };
  });
}

/** "Prepare for confirmation": records exactly what will change. Changes nothing yet. */
export async function prepareShip(db: D1Database, saleIds: number[], status: "shipped" | "delivered", actor = ""): Promise<{ ok: boolean; id?: number; error?: string }> {
  const ids = [...new Set(saleIds.filter((n) => Number.isInteger(n) && n > 0))].slice(0, 20);
  if (!ids.length) return { ok: false, error: "no_lines" };
  const rows = (await db.prepare(`SELECT id, buyer, item_label, size, ship_status FROM seed_sales WHERE id IN (${ids.map(() => "?").join(",")})`).bind(...ids).all<{ id: number; buyer: string; item_label: string; size: string; ship_status: string }>()).results ?? [];
  if (rows.length !== ids.length) return { ok: false, error: "lines_not_found" };
  // A cancelled order never advances to shipping, not even by mistake.
  if (rows.some((r) => r.ship_status === "cancelled")) return { ok: false, error: "cancelled_line" };
  // The same request twice (double tap) returns the same pending action.
  const input = JSON.stringify({ sale_ids: ids.sort((a, b) => a - b), status });
  const dup = await db.prepare("SELECT id FROM assistant_pending WHERE tool = 'today_ship' AND input = ? AND status IN ('pending','executing') LIMIT 1").bind(input).first<{ id: number }>();
  if (dup) return { ok: true, id: dup.id };
  const he = status === "delivered" ? "נמסר" : "נשלח";
  const buyer = (rows[0].buyer || "").split(" ")[0];
  const summary = `עדכון משלוח · ${buyer} || ${rows.map((r) => `#${r.id} ${r.item_label} ${r.size}`.trim()).join(", ")}: ${rows[0].ship_status === "packed" ? "ארוז" : "נרשם"} ← ${he}`;
  const res = await db.prepare("INSERT INTO assistant_pending (tool, input, summary, actor, expires_at) VALUES ('today_ship', ?, ?, ?, datetime('now', '+2 days'))").bind(input, summary.slice(0, 600), actor).run();
  return { ok: true, id: Number(res.meta?.last_row_id ?? 0) };
}

/** Confirm: atomic claim, execute, and a result that can be checked. "Done" only after the rows really changed. */
export async function confirmShip(db: D1Database, id: number): Promise<{ ok: boolean; state: TodayAction["state"]; text: string }> {
  const row = await db.prepare("SELECT input, status, result FROM assistant_pending WHERE id = ? AND tool = 'today_ship'").bind(id).first<{ input: string; status: string; result: string }>();
  if (!row) return { ok: false, state: "failed", text: "הפעולה לא נמצאה" };
  if (row.status === "done") return { ok: true, state: "done", text: row.result };
  // pending, failed and unknown may run: the shipping update is idempotent (a row already "shipped" stays so).
  const claim = await db.prepare("UPDATE assistant_pending SET status = 'executing' WHERE id = ? AND status IN ('pending','failed','unknown')").bind(id).run();
  if ((claim.meta?.changes ?? 0) !== 1) return { ok: false, state: "running", text: "הפעולה כבר בביצוע. לא נשלחה שוב." };
  const input = JSON.parse(row.input) as { sale_ids: number[]; status: string };
  const status = input.status === "delivered" ? "delivered" : "shipped";
  let text: string;
  let done = false;
  try {
    const first = await db.prepare("SELECT order_ref, note FROM seed_sales WHERE id = ?").bind(input.sale_ids[0] ?? 0).first<{ order_ref: string; note: string }>();
    const ref = orderKeyOf({ id: input.sale_ids[0] ?? 0, order_ref: first?.order_ref ?? "", note: first?.note ?? "" }).ref;
    const marks = input.sale_ids.map(() => "?").join(",");
    // Evidence on the row: a manual confirmation in the today tab, with the order id.
    const upd = await db
      .prepare(
        `UPDATE seed_sales SET ship_status = ?, note = CASE WHEN note LIKE '%נשלח:%' THEN note ELSE TRIM(note || ' נשלח: אישור ידני בטאב היום' || ?) END
          WHERE id IN (${marks}) AND ship_status IN ('recorded','packed','shipped')`,
      )
      .bind(status, ref ? ` (${ref})` : "", ...input.sale_ids)
      .run();
    const n = upd.meta?.changes ?? 0;
    done = n > 0;
    text = done ? `${n} שורות סומנו ${status === "delivered" ? "נמסר" : "נשלח"}${ref ? ` · ${ref}` : ""}` : "אף שורה לא השתנתה (כבר מסומנות או בוטלו)";
  } catch (error) {
    text = `שגיאה: ${String(error).slice(0, 200)}`;
  }
  await db.prepare("UPDATE assistant_pending SET status = ?, result = ? WHERE id = ?").bind(done ? "done" : "failed", text.slice(0, 600), id).run();
  return { ok: done, state: done ? "done" : "failed", text };
}

export async function cancelShip(db: D1Database, id: number): Promise<boolean> {
  const res = await db.prepare("UPDATE assistant_pending SET status = 'cancelled' WHERE id = ? AND tool = 'today_ship' AND status IN ('pending','failed','unknown')").bind(id).run();
  return (res.meta?.changes ?? 0) === 1;
}

export async function todayState(db: D1Database) {
  const [{ cards, failed }, money, actions] = await Promise.all([todayCards(db), todayMoney(db), listActions(db).catch(() => [] as TodayAction[])]);
  // A little positive feedback: what already closed today.
  const doneToday = await tryFirst<{ n: number }>(
    db,
    "SELECT (SELECT COUNT(*) FROM tasks WHERE status = 'done' AND updated_at >= datetime('now','-18 hours')) + (SELECT COUNT(*) FROM assistant_pending WHERE tool = 'today_ship' AND status = 'done' AND created_at >= datetime('now','-18 hours')) AS n",
  );
  return { cards, failed, money, actions, line: hobiLine(cards, failed), doneToday: doneToday?.n ?? 0 };
}

/** "סיימתי" / "לא רלוונטי" from the "not moving" card: any task, but only an open one.
 *  A task already done or archived is left alone (a double tap returns false). */
export async function closeStaleTask(db: D1Database, id: number, how: "done" | "archived"): Promise<boolean> {
  if (!Number.isInteger(id) || id <= 0) return false;
  const res = await db.prepare("UPDATE tasks SET status = ?, updated_at = datetime('now') WHERE id = ? AND status NOT IN ('done','archived')").bind(how, id).run();
  return (res.meta?.changes ?? 0) === 1;
}
