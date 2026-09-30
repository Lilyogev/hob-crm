// אלכס: חלוקת הנתונים העסקיים למדף. בלי .server כדי שהמסך והשרת יחלקו את אותה חלוקה.
// היסטוריית ההשקעה (מה דימה ויוגב שמו, מחיר הרכישה ומה שולם) והתקציב הנוכחי של יוגב
// (התקרה) הם שני חלקים נפרדים. אף פעם לא מסכמים אותם לחלוקת בעלות ולא לסכום אחד.
export type FactLite = { key: string; label: string; status: "confirmed" | "planned" | "pending"; value: number | null; unit: string; text: string; source: string; as_of?: string; updated_at?: string };

export const HISTORY_KEYS = ["invest_dima", "invest_yogev", "buyout_price", "buyout_paid"] as const;
export const CURRENT_KEYS = ["investment_cap"] as const;

export function factSections<T extends { key: string }>(facts: T[]): { history: T[]; current: T[]; other: T[] } {
  const byKey = new Map(facts.map((f) => [f.key, f]));
  const pick = (keys: readonly string[]) => keys.map((k) => byKey.get(k)).filter((f): f is T => Boolean(f));
  const taken = new Set<string>([...HISTORY_KEYS, ...CURRENT_KEYS]);
  return { history: pick(HISTORY_KEYS), current: pick(CURRENT_KEYS), other: facts.filter((f) => !taken.has(f.key)) };
}
