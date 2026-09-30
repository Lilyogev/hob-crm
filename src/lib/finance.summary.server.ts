// תמונת הכסף המובנית: כל נתון מגיע עם מקור, תאריך ומצב אמינות; ערך חסר הוא null
// (לא אפס), ו"כסף פנוי" מחושב רק כשכל הרכיבים שלו ידועים. אותה תמונה משמשת את טאב
// הכספים, את "היום שלך" ואת הובי, כדי שמספר אחד יופיע בכל מקום.
import type { D1Database } from "@cloudflare/workers-types";
import { PARTNER, type Partner } from "./partners";

/** מצב האמינות של נתון: מאומת (מול מסמך), נרשם בלוח (לא נבדק מול הבנק), אומדן, מתוכנן,
 *  או ממתין לאישור. "נרשם בלוח" אינו "מאומת". */
export type FigureState = "verified" | "recorded" | "estimate" | "planned" | "pending";
export const FIGURE_STATE_HE: Record<FigureState, string> = {
  verified: "מאומת",
  recorded: "נרשם בלוח, לא מאומת מול הבנק",
  estimate: "אומדן",
  planned: "מתוכנן",
  pending: "ממתין לאישור",
};

/** נתון בתמונת הכסף: ערך או null, מאיפה הוא בא ומתי, ומה מצב האמינות שלו. */
export type Figure = { value: number | null; source: string; asOf: string | null; note?: string; state?: FigureState };

/** שורת "מקור · עודכן" אחידה מתחת למספר. */
export function figureMeta(f: { source: string; asOf: string | null; state?: FigureState | null }): string {
  return [f.state ? FIGURE_STATE_HE[f.state] : "", `מקור: ${f.source}`, f.asOf ? `עודכן ${f.asOf.slice(0, 10)}` : "לא ידוע מתי עודכן"].filter(Boolean).join(" · ");
}

export type Gap = { key: string; text: string; question?: string };

/** מה כל שותפה שמה מהכיס, ומה צריך לעבור ביניהן כדי להשוות. */
export type PocketBalance = {
  avia: number;
  lior: number;
  /** מי שמה יותר (null = מאוזן). */
  ahead: Partner | null;
  /** כמה השנייה חייבת לה כדי להשוות: ההפרש חלקי 2. */
  transfer: number;
  text: string;
};

export type MoneySnapshot = {
  asOf: string;
  balances: { bank: Figure; bit: Figure; cash: Figure };
  receivables: { clearing: Figure };
  liabilities: { commissions: Figure };
  pocket: PocketBalance;
  period: {
    days: number;
    revenue: Figure;
    expenses: Figure;
    byCategory: { category: string; total: number; count: number }[];
    latest: { date: string; category: string; description: string; amount: number; payer: string; paid_from: string }[];
    shownLatest: number;
    totalRows: number;
  };
  ytd: { revenue: Figure; year: string };
  free: Figure; // כסף פנוי: null כשחסר רכיב
  gaps: Gap[];
};

const round = (n: number) => Math.round(n);
const known = (value: number, source: string, asOf: string | null = null, note?: string, state: FigureState = "recorded"): Figure => ({ value: round(value), source, asOf, note, state });
const unknown = (source: string, note: string): Figure => ({ value: null, source, asOf: null, note });

async function tryAll<T>(db: D1Database, sql: string, ...args: unknown[]): Promise<T[] | null> {
  try {
    return ((await db.prepare(sql).bind(...args).all<T>()).results ?? []) as T[];
  } catch {
    return null;
  }
}
async function tryFirst<T>(db: D1Database, sql: string, ...args: unknown[]): Promise<T | null | undefined> {
  try {
    return (await db.prepare(sql).bind(...args).first<T>()) ?? null;
  } catch {
    return undefined; // undefined = השאילתה נכשלה; null = אין שורה
  }
}

/** מה צריך לעבור בין השותפות כדי שההשקעה מהכיס תהיה שווה. טהור, בלי DB. */
export function pocketBalance(spent: { avia: number; lior: number }): PocketBalance {
  const diff = spent.avia - spent.lior;
  const transfer = Math.round((Math.abs(diff) / 2) * 100) / 100;
  if (transfer < 0.5) {
    return { avia: spent.avia, lior: spent.lior, ahead: null, transfer: 0, text: "מאוזן: שתיהן שמו אותו סכום מהכיס" };
  }
  const ahead: Partner = diff > 0 ? "avia" : "lior";
  const behind: Partner = ahead === "avia" ? "lior" : "avia";
  return {
    avia: spent.avia,
    lior: spent.lior,
    ahead,
    transfer,
    text: `${PARTNER[ahead].label} שמה יותר. כדי להשוות, ${PARTNER[behind].label} מעבירה לה ${transfer.toLocaleString("en-US")} ₪`,
  };
}

// ---- תמונת הכסף ----

export async function moneySnapshot(db: D1Database, opts: { days?: number; latestLimit?: number; now?: Date } = {}): Promise<MoneySnapshot> {
  const days = opts.days ?? 30;
  const limit = opts.latestLimit ?? 15;
  const now = opts.now ?? new Date();
  const today = now.toISOString().slice(0, 10);
  const since = new Date(now.getTime() - days * 86400000).toISOString().slice(0, 10);
  const year = today.slice(0, 4);
  const gaps: Gap[] = [];

  // בנק: פתיחה + העברות ישירות + זיכויי סליקה (נטו) − הוצאות מהבנק. אמין רק כשהזיכויים עדכניים.
  const opening = await tryFirst<{ value: string }>(db, "SELECT value FROM settings WHERE key = 'bank_opening'");
  const byMethod = await tryAll<{ m: string; total: number }>(db, "SELECT pay_method AS m, COALESCE(SUM(qty*price),0) AS total FROM seed_sales WHERE COALESCE(channel,'') <> 'archive' AND ship_status <> 'cancelled' GROUP BY pay_method");
  const settled = await tryAll<{ provider: string; gross: number; net: number; last: string | null }>(db, "SELECT provider, COALESCE(SUM(gross),0) AS gross, COALESCE(SUM(net),0) AS net, MAX(date) AS last FROM fin_settlements GROUP BY provider");
  const outBy = await tryAll<{ src: string; total: number }>(db, "SELECT paid_from AS src, COALESCE(SUM(amount),0) AS total FROM fin_expenses WHERE payer = 'business' GROUP BY paid_from");
  const sold = (m: string) => byMethod?.find((r) => r.m === m)?.total ?? 0;
  const out = (s: string) => outBy?.find((r) => r.src === s)?.total ?? 0;
  const lastSettle = settled?.map((r) => r.last ?? "").sort().pop() || null;
  const staleDays = lastSettle ? Math.floor((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${lastSettle}T00:00:00Z`)) / 86400000) : null;
  const anyStoreSales = sold("shopify") > 0;

  let bank: Figure;
  if (opening === undefined || byMethod === null || settled === null || outBy === null) bank = unknown("לוח הכספים", "השאילתה נכשלה");
  else if (!opening) bank = unknown("לוח הכספים", "אין יתרת פתיחה לבנק");
  else {
    const v = (parseFloat(opening.value) || 0) + sold("transfer") + settled.reduce((a, r) => a + r.net, 0) - out("bank");
    bank = known(v, "יתרת פתיחה + העברות + זיכויים שנרשמו − הוצאות מהבנק", lastSettle ?? today, staleDays !== null && staleDays > 14 ? `זיכוי אחרון נרשם לפני ${staleDays} ימים: המספר כנראה לא תואם את הבנק` : undefined);
  }
  if (!opening) gaps.push({ key: "bank_opening", text: "אין יתרת פתיחה לבנק, אז יתרת הבנק לא מחושבת.", question: "מה הייתה היתרה בחשבון העסק בתאריך שממנו הלוח סופר?" });
  if (anyStoreSales && staleDays === null) gaps.push({ key: "settlements_none", text: "לא נרשם אף זיכוי סליקה. אי אפשר לדעת כמה מהמכירות באתר כבר נכנס לבנק." });
  else if (staleDays !== null && staleDays > 14) gaps.push({ key: "settlements_stale", text: `זיכוי הסליקה האחרון נרשם ב-${lastSettle}, לפני ${staleDays} ימים.`, question: "לעבור על דף הבנק מאז ולרשום כל זיכוי (\"נכנס משופיפיי X\")." });

  // ביט ומזומן: בלי יתרת פתיחה (settings bit_opening / cash_opening) זה רק מה שנרשם בלוח.
  const bitOpen = await tryFirst<{ value: string }>(db, "SELECT value FROM settings WHERE key = 'bit_opening'");
  const cashOpen = await tryFirst<{ value: string }>(db, "SELECT value FROM settings WHERE key = 'cash_opening'");
  const bit = byMethod === null || outBy === null ? unknown("לוח הכספים", "השאילתה נכשלה") : bitOpen ? known((parseFloat(bitOpen.value) || 0) + sold("bit") - out("bit"), "יתרת פתיחה לביט + מכירות − הוצאות") : known(sold("bit") - out("bit"), "מכירות בביט − הוצאות מביט", null, "אין יתרת פתיחה לביט: זה רק מה שנרשם בלוח, לא יתרה");
  const cash = byMethod === null || outBy === null ? unknown("לוח הכספים", "השאילתה נכשלה") : cashOpen ? known((parseFloat(cashOpen.value) || 0) + sold("cash") - out("cash"), "ספירת קופה + מכירות − הוצאות") : known(sold("cash") - out("cash"), "מכירות במזומן − הוצאות במזומן", null, "אין ספירת קופה: זה רק מה שנרשם בלוח, לא יתרה");

  // תקבולים: כסף שמחכה אצל הסולק (ברוטו, לפני עמלה). "לא נרשם זיכוי בלוח" אינו
  // "הכסף לא נכנס לבנק": בלי דף בנק עדכני המצב בפועל לא ידוע.
  const unverifiedBank = staleDays === null || staleDays > 14;
  const clearing = byMethod === null || settled === null
    ? unknown("לוח הכספים", "השאילתה נכשלה")
    : known(sold("shopify") - settled.reduce((a, r) => a + r.gross, 0), "מכירות באתר − ברוטו שנרשם כזיכוי בלוח", lastSettle, `ברוטו, לפני עמלה. זה מה שלא נרשם כזיכוי בלוח, לא בהכרח מה שלא נכנס לבנק${unverifiedBank && anyStoreSales ? `. ${staleDays === null ? "לא נרשם אף זיכוי" : `הזיכוי האחרון נרשם לפני ${staleDays} ימים`}, אז כמה מזה כבר נכנס בפועל לא ידוע בלי דף בנק` : ""}`);

  // התחייבויות: עמלות משפיעניות שלא שולמו (אחוז מההגדרות; הטבלאות של הקולאבים אופציונליות).
  const pctRow = await tryFirst<{ value: string }>(db, "SELECT value FROM settings WHERE key = 'collab_commission_pct'");
  const commissionPct = pctRow ? parseFloat(pctRow.value) || 0 : 0;
  const comm = await tryFirst<{ due: number }>(db, "SELECT COALESCE(SUM(MAX(COALESCE(s.total,0) * ? - COALESCE(l.commission_paid,0), 0)),0) AS due FROM collab_links l LEFT JOIN (SELECT link_id, SUM(total) AS total FROM collab_sales GROUP BY link_id) s ON s.link_id = l.id", commissionPct / 100);
  const commissions = comm === undefined || comm === null ? unknown("משפיעניות", "לא נטען") : known(comm.due, `${commissionPct}% מהמכירות בקוד − מה ששולם`, null);

  // מהכיס: מה כל שותפה שילמה בעצמה, ומה צריך לעבור ביניהן כדי להשוות.
  const pocketRows = await tryAll<{ payer: string; total: number }>(db, "SELECT payer, COALESCE(SUM(amount),0) AS total FROM fin_expenses WHERE payer IN ('avia','lior') GROUP BY payer");
  const pocket = pocketBalance({ avia: pocketRows?.find((r) => r.payer === "avia")?.total ?? 0, lior: pocketRows?.find((r) => r.payer === "lior")?.total ?? 0 });

  // תקופה: סכומים מלאים מכל הרשומות; הרשימה המפורטת מוגבלת ואומרת כמה הוצגו.
  const salesRev = await tryFirst<{ r: number }>(db, "SELECT COALESCE(SUM(price*qty),0) AS r FROM seed_sales WHERE COALESCE(NULLIF(sold_at,''), date(created_at)) >= ? AND COALESCE(channel,'') <> 'archive' AND ship_status <> 'cancelled'", since);
  const manualRev = await tryFirst<{ r: number }>(db, "SELECT COALESCE(SUM(amount),0) AS r FROM fin_income WHERE date >= ?", since);
  const cats = await tryAll<{ category: string; total: number; count: number }>(db, "SELECT category, COALESCE(SUM(amount),0) AS total, COUNT(*) AS count FROM fin_expenses WHERE date >= ? GROUP BY category ORDER BY total DESC", since);
  const latest = await tryAll<MoneySnapshot["period"]["latest"][number]>(db, "SELECT date, category, description, amount, payer, paid_from FROM fin_expenses WHERE date >= ? ORDER BY date DESC, id DESC LIMIT ?", since, limit);
  const totalRows = cats ? cats.reduce((a, c) => a + c.count, 0) : 0;
  const ytdSales = await tryFirst<{ r: number }>(db, "SELECT COALESCE(SUM(price*qty),0) AS r FROM seed_sales WHERE COALESCE(NULLIF(sold_at,''), date(created_at)) >= ? AND COALESCE(channel,'') <> 'archive' AND ship_status <> 'cancelled'", `${year}-01-01`);
  const ytdManual = await tryFirst<{ r: number }>(db, "SELECT COALESCE(SUM(amount),0) AS r FROM fin_income WHERE date >= ?", `${year}-01-01`);
  const revenueFig = (s: { r: number } | null | undefined, m: { r: number } | null | undefined, source: string): Figure =>
    s === undefined || s === null ? unknown("מכירות", "השאילתה נכשלה") : known(s.r + (m?.r ?? 0), source, today);

  // זיכויים שכבר רשומים ונראים כפולים (אותו נטו, עד 3 ימים). לבירור, לא למחיקה.
  const dups = await tryAll<{ a: number; b: number; provider: string; net: number }>(db, "SELECT x.id AS a, y.id AS b, x.provider, x.net FROM fin_settlements x JOIN fin_settlements y ON x.id < y.id AND x.provider = y.provider AND ABS(x.net - y.net) < 1 AND ABS(julianday(x.date) - julianday(y.date)) <= 3");
  for (const d of dups ?? []) gaps.push({ key: `settlement_dup:${d.a}-${d.b}`, text: `זיכויים #${d.a} ו-#${d.b} (${d.provider}, ${round(d.net).toLocaleString("en-US")} ₪) נראים כמו אותו זיכוי שנרשם פעמיים.`, question: "לבדוק מול דף הבנק: שני זיכויים או אחד?" });

  // הוצאות של העסק בלי סימון מאיפה שולמו: הקופות לא מתעדכנות.
  const untagged = out("");
  if (untagged > 0) gaps.push({ key: "expenses_untagged", text: `${round(untagged).toLocaleString("en-US")} ₪ הוצאות של העסק בלי סימון מאיפה שולמו (בנק / ביט / מזומן).`, question: "לתייג ביומן ההוצאות, אחרת היתרות של הקופות לא נכונות." });

  // כסף פנוי: רק כשכל הרכיבים ידועים ועדכניים.
  const parts: [string, Figure][] = [["יתרת בנק", bank], ["ביט", bit], ["מזומן", cash], ["עמלות פתוחות", commissions]];
  const missingParts = parts.filter(([, f]) => f.value === null).map(([n]) => n);
  if (bank.note) missingParts.push("זיכויים עדכניים");
  if (bit.value !== null && !bitOpen) missingParts.push("יתרת פתיחה לביט");
  if (cash.value !== null && !cashOpen) missingParts.push("ספירת קופה");
  const free: Figure = missingParts.length
    ? { value: null, source: "יתרות − התחייבויות", asOf: null, note: `לא מחושב: חסר ${missingParts.join(", ")}` }
    : known((bank.value ?? 0) + (bit.value ?? 0) + (cash.value ?? 0) - (commissions.value ?? 0), "יתרות − התחייבויות ידועות", today, "לא כולל תקבולים שעוד לא הגיעו ולא מלאי. היתרות לפי הלוח, לא דף בנק", "estimate");

  return {
    asOf: now.toISOString(),
    balances: { bank, bit, cash },
    receivables: { clearing },
    liabilities: { commissions },
    pocket,
    period: {
      days,
      revenue: revenueFig(salesRev, manualRev, "מכירות בלוח + הכנסות שנרשמו ידנית"),
      expenses: cats === null ? unknown("הוצאות", "השאילתה נכשלה") : known(cats.reduce((a, c) => a + c.total, 0), "כל ההוצאות שנרשמו בתקופה", today),
      byCategory: cats ?? [],
      latest: latest ?? [],
      shownLatest: (latest ?? []).length,
      totalRows,
    },
    ytd: { revenue: revenueFig(ytdSales, ytdManual, `מכירות והכנסות בלוח מ-1.1.${year}`), year },
    free,
    gaps,
  };
}

// ---- טקסט לפרומפט של הובי ----

const fig = (f: Figure) => (f.value === null ? `לא ידוע${f.note ? ` (${f.note})` : ""}` : `${f.value.toLocaleString("en-US")} ₪${f.note ? ` (${f.note})` : ""}`);
const meta = (f: Figure) => `[${f.state ? `${FIGURE_STATE_HE[f.state]} · ` : ""}מקור: ${f.source}${f.asOf ? `, נכון ל-${f.asOf}` : ""}]`;

export function snapshotText(s: MoneySnapshot): string {
  const p = s.period;
  return [
    "## תמונת הכסף (מובנית; 'לא ידוע' = חסר, לא אפס. לכל נתון מצב: מאומת / נרשם בלוח / אומדן)",
    "### יתרות שנרשמו",
    `- בנק: ${fig(s.balances.bank)} ${meta(s.balances.bank)}`,
    `- ביט: ${fig(s.balances.bit)} ${meta(s.balances.bit)}`,
    `- מזומן: ${fig(s.balances.cash)} ${meta(s.balances.cash)}`,
    `### מחכה אצל הסולק: ${fig(s.receivables.clearing)} ${meta(s.receivables.clearing)}`,
    `### עמלות משפיעניות פתוחות: ${fig(s.liabilities.commissions)} ${meta(s.liabilities.commissions)}`,
    `### כסף פנוי: ${fig(s.free)}${s.free.value !== null ? ` ${meta(s.free)}` : ""}`,
    `### מהכיס: אביה ${s.pocket.avia.toLocaleString("en-US")} ₪ · ליאור ${s.pocket.lior.toLocaleString("en-US")} ₪. ${s.pocket.text}`,
    `### ${p.days} הימים האחרונים`,
    `- הכנסות: ${fig(p.revenue)} · הוצאות: ${fig(p.expenses)} (${p.totalRows} רשומות)`,
    p.byCategory.length ? `- לפי קטגוריה: ${p.byCategory.map((c) => `${c.category} ${round(c.total).toLocaleString("en-US")} ₪ (${c.count})`).join(" · ")}` : "- אין הוצאות בתקופה",
    p.latest.length ? `- פירוט: הוצגו ${p.shownLatest} האחרונות מתוך ${p.totalRows}:\n${p.latest.map((e) => `  - ${e.date} ${e.category}: ${e.description} ${round(e.amount)} ₪ (${e.payer === "business" ? `מהעסק, ${e.paid_from || "מקור לא צוין"}` : `שילמה ${PARTNER[e.payer as Partner]?.label ?? e.payer}`})`).join("\n")}` : "",
    `- הכנסות מתחילת ${s.ytd.year}: ${fig(s.ytd.revenue)}.`,
    `### פערים בנתונים (${s.gaps.length})`,
    ...s.gaps.map((g) => `- [${g.key}] ${g.text}${g.question ? ` שאלה: ${g.question}` : ""}`),
  ]
    .filter(Boolean)
    .join("\n");
}
