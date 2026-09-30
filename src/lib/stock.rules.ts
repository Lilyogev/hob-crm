// חישובי מלאי שהסוכנים מקבלים מוכנים, במקום לחשב לבד בטקסט. נולד מדוח שקבע ש-19 שבועות
// כיסוי הם "מעל סף של 26": ההשוואה נעשית כאן בקוד, והסוכן מקבל מסקנה מחושבת עם הסף.
// פונקציות טהורות, בלי DB, כדי שאפשר לבדוק אותן.

export const STUCK_WEEKS = 26;
/** מתחת לזה אין מספיק מכירות כדי לומר איזו מידה מבוקשת. */
export const MIN_SIZE_SAMPLE = 8;

export type WebStatus = "listed" | "physical_only";

export type Cover = { weekly: number; weeks: number | null; stuck: boolean; text: string };

/** שבועות כיסוי = מלאי / קצב שבועי (30 יום). אין מכירות ב-30 יום = לא מחושב, ונחשב תקוע. */
export function stockCover(left: number, sold30: number, threshold = STUCK_WEEKS): Cover {
  const weekly = sold30 / (30 / 7);
  if (left <= 0) return { weekly, weeks: 0, stuck: false, text: "אין מלאי" };
  if (weekly <= 0) return { weekly: 0, weeks: null, stuck: true, text: `לא נמכר ב-30 יום: כיסוי לא מחושב, מעל סף ${threshold} שבועות (תקוע)` };
  const weeks = Math.round(left / weekly);
  const stuck = weeks > threshold;
  return { weekly, weeks, stuck, text: `${weeks} שבועות כיסוי (${stuck ? "מעל" : weeks === threshold ? "בדיוק על" : "מתחת ל"}סף ${threshold}: ${stuck ? "תקוע" : "לא תקוע"})` };
}

export type SizeDemand = { enough: boolean; sample: number; text: string };

/**
 * ביקוש לפי מידה רק ממכירות לפי מידה. כמות שנשארה לא מעידה על ביקוש: מידה שנשארו ממנה
 * מעט יכולה פשוט להיות מידה שהוזמנה מעט. מתחת ל-MIN_SIZE_SAMPLE מכירות: אין מספיק מידע.
 */
export function sizeDemand(soldBySize: Record<string, number>, min = MIN_SIZE_SAMPLE): SizeDemand {
  const entries = Object.entries(soldBySize).filter(([k, v]) => k !== "" && v > 0);
  const sample = entries.reduce((a, [, v]) => a + v, 0);
  if (sample < min) {
    return { enough: false, sample, text: `מכירות לפי מידה: ${sample ? entries.map(([k, v]) => `${k}:${v}`).join(" ") : "אין"} (${sample} מכירות, פחות מ-${min}): אין מספיק מידע לקבוע איזו מידה מבוקשת. אל תסיק ביקוש מהכמות שנשארה.` };
  }
  const sorted = entries.sort((a, b) => b[1] - a[1]);
  return { enough: true, sample, text: `מכירות לפי מידה (${sample}): ${sorted.map(([k, v]) => `${k}:${v} (${Math.round((v / sample) * 100)}%)`).join(" ")}` };
}

export type GapKind = "gap" | "historical";

/**
 * איך להציג שורת מיפוי מול Shopify. פריט "מלאי פיזי בלבד" אינו פער סנכרון: הוא לא מוצג
 * באתר בכוונה. אם ב-Shopify נשארה לו רשומה ישנה עם כמות שלילית, היא מוצגת בנפרד כנתון
 * היסטורי לבדיקה, בלי מסקנה שצריך לפרסם אותו. כל פריט אחר: פער רגיל, כמו קודם.
 */
export function classifyVariant(p: { webStatus: WebStatus; board: number; shopify: number | null; found: boolean }): GapKind | null {
  if (p.webStatus === "physical_only") return p.found && p.shopify !== null && p.shopify < 0 ? "historical" : null;
  if (!p.found) return "gap";
  if (p.shopify !== null && p.shopify !== p.board) return "gap";
  return null;
}

export function webStatusOf(v: unknown): WebStatus {
  return v === "physical_only" ? "physical_only" : "listed";
}

export type Balance = { accounted: number; text: string };

/** חשבון מלאי לפריט: מה שנשאר + נמכר + חולק. מלאי פתיחה לא נשמר בלוח, אז הסכום לא מאומת
 *  מול הזמנת הייצור: הוא רק מה שהלוח יודע להסביר. */
export function stockBalance(p: { left: number; sold: number; given: number }): Balance {
  const accounted = p.left + p.sold + p.given;
  return { accounted, text: `חשבון מלאי: נשארו ${p.left} + נמכרו ${p.sold} + חולקו ${p.given} = ${accounted} שהלוח מסביר. מלאי פתיחה לא רשום בלוח, אז הסכום לא מאומת מול הייצור` };
}

export type Reconcile = { gap: number; text: string };

/**
 * השוואה של מספר שנטען (למשל "137 חולצות") מול החלקים שמסבירים אותו. פער = "פער לא מוסבר",
 * עם רשימת מה לבדוק, בלי להמציא הסבר. זה ה-check שעובר גם על מספרים ששני עובדים הסכימו עליהם:
 * הסכמה אינה אימות.
 */
export function reconcileClaim(claimed: number, parts: Record<string, number>): Reconcile {
  const total = Object.values(parts).reduce((a, b) => a + b, 0);
  const gap = claimed - total;
  const sumText = `${Object.entries(parts).map(([k, v]) => `${v} ${k}`).join(" + ")} = ${total}`;
  if (gap === 0) return { gap, text: `${claimed} מתאים: ${sumText}` };
  return {
    gap,
    text: `פער לא מוסבר של ${Math.abs(gap)}: נטען ${claimed}, אבל ${sumText}. לבדוק: מלאי פתיחה, מתנות, החזרות ותיקונים ידניים. אין הסבר עד שנבדק.`,
  };
}
