// ברונו בשתי מהירויות: התשובה המיידית.
// מודל זול (Haiku), בלי כלים ובלי נתונים, עונה תוך שנייה-שתיים: או משפט שלם לשיחת
// חולין ("תודה" → "בכיף"), או רק "מה אני הולך לבדוק". התשובה העמוקה (כלים, נתונים,
// Sonnet) מגיעה אחר כך ומחליפה אותה. לכן: בלי מספרים, בלי עובדות, בלי "בוצע".
// הכללים נאכפים פעמיים: בהנחיה למודל, ובמסנן שאחריה (מספר או "בוצע" באישור = המשפט נזרק).
// התשובה המיידית לא נשמרת כתור בשיחה; היא חיה רק ברשומת התור החי ב-DO.

export type QuickKind = "ack" | "answer";
export type QuickReply = { text: string; kind: QuickKind };
export type QuickStored = QuickReply & { at: number };

const QUICK_MODEL = "claude-haiku-4-5-20251001";
const QUICK_TIMEOUT_MS = 2500;
const QUICK_MAX_TOKENS = 60;
export const QUICK_MAX_CHARS = 160;

export const QUICK_SYSTEM =
  "אתה ברונו, העוזר של SEGULA. ענה במשפט אחד קצר: אם זו שיחת חולין או תודה, ענה ישירות והתחל ב-[תשובה]; " +
  "אחרת אמור רק מה אתה הולך לבדוק (בלי מספרים, בלי עובדות, בלי 'בוצע', בלי להבטיח תוצאה). " +
  "בלי קו מפריד ארוך. בלי אימוג'י. עברית מדוברת, עד 20 מילים.";

/** ספרות בכל כתב (0-9, ספרות ערביות-הודיות וכו'). */
const HAS_DIGIT = /\p{Nd}/u;
/** מילים שטוענות שמשהו כבר נעשה. באישור הן אסורות: רק התשובה העמוקה יכולה לומר "בוצע". */
const CLAIMS_DONE = /(בוצע|ביצעתי|נרשם|רשמתי|עדכנתי|שלחתי|נשלח|סיימתי|אישרתי|מאומת|וידאתי|done|sent|updated|verified)/i;

/** מפצל למשפטים בלי לאבד את סימני הסיום. */
function sentences(text: string): string[] {
  return text
    .split(/(?<=[.!?…])\s+|\n+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** מנקה את הטקסט הגולמי מהמודל לתשובה מיידית תקינה, או null כשלא נשאר כלום.
 *  [תשובה] בתחילת הטקסט = תשובה שלמה (שיחת חולין); בלעדיו = אישור של "מה אבדק".
 *  באישור, משפט עם ספרה או עם טענת "בוצע" נזרק (מספרים ועובדות הם של התשובה העמוקה בלבד). */
export function filterQuick(raw: string): QuickReply | null {
  let text = (raw ?? "").trim();
  if (!text) return null;
  let kind: QuickKind = "ack";
  const m = text.match(/^\[?\s*תשובה\s*\]?\s*[:\-]?\s*/);
  if (m) {
    kind = "answer";
    text = text.slice(m[0].length).trim();
  }
  text = text.replace(/\s*[—–]\s*/g, ", ").replace(/\s+/g, " ").trim();
  if (kind === "ack") {
    text = sentences(text)
      .filter((s) => !HAS_DIGIT.test(s) && !CLAIMS_DONE.test(s))
      .join(" ")
      .trim();
  }
  if (!text) return null;
  if (text.length > QUICK_MAX_CHARS) text = `${text.slice(0, QUICK_MAX_CHARS - 1).trimEnd()}…`;
  return { text, kind };
}

/** שורות אחרונות מהשיחה, מקוצרות, כדי ש"תודה" ידע על מה. */
function contextLines(history: { role: string; content: string }[]): string {
  return history
    .slice(-4)
    .map((h) => `${h.role === "assistant" ? "ברונו" : "שותף"}: ${h.content.replace(/\s+/g, " ").slice(0, 160)}`)
    .join("\n");
}

/** התשובה המיידית. מחזירה null על כל תקלה או פסק זמן: אז פשוט אין תשובה מיידית, ושום דבר לא נשבר. */
export async function quickReply(
  env: { ANTHROPIC_API_KEY?: string },
  text: string,
  recentHistory: { role: string; content: string }[] = [],
): Promise<QuickReply | null> {
  if (!env.ANTHROPIC_API_KEY || !text.trim()) return null;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), QUICK_TIMEOUT_MS);
  try {
    const ctx = contextLines(recentHistory);
    const user = `${ctx ? `הקשר (השיחה האחרונה):\n${ctx}\n\n` : ""}ההודעה החדשה: ${text.trim().slice(0, 600)}`;
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: QUICK_MODEL, max_tokens: QUICK_MAX_TOKENS, system: QUICK_SYSTEM, messages: [{ role: "user", content: user }] }),
      signal: ctrl.signal,
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { content?: { type: string; text?: string }[] };
    const raw = (data.content ?? []).filter((b) => b.type === "text").map((b) => b.text ?? "").join(" ");
    return filterQuick(raw);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** מצרף תשובה מיידית לרשומת התור החי. טהור: מחזיר רשומה חדשה. כשהתור כבר הסתיים
 *  (התשובה המלאה הגיעה קודם) התשובה המיידית נזרקת, כדי שלא תוצג אחרי האמיתית. */
export function mergeQuick<T extends { done: boolean; at: number }>(record: T, quick: QuickReply | null, now = Date.now()): T & { quick?: QuickStored } {
  if (!quick || record.done) return record;
  return { ...record, quick: { text: quick.text, kind: quick.kind, at: now }, at: now };
}
