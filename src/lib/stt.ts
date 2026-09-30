// תמלול עם Whisper של Workers AI. במצב אנגלית של ברונו השפה לא קבועה (יוגב מדבר
// עברית או אנגלית), אבל זיהוי אוטומטי על משפט קצר טועה: עברית יצאה כצרפתית או
// קרואטית ("Et d'âme l'air."). לכן מקבלים רק עברית או אנגלית; כל שפה אחרת מתומללת
// מחדש כעברית.
export type WhisperRun = (model: string, input: Record<string, unknown>) => Promise<Record<string, unknown>>;
const MODEL = "@cf/openai/whisper-large-v3-turbo";

/** השפה ש-Whisper זיהה, ואם לא החזיר: ניחוש לפי האותיות. */
export function spokenLang(out: Record<string, unknown>): string {
  const info = out.transcription_info as { language?: unknown } | undefined;
  if (typeof info?.language === "string" && info.language) return info.language.toLowerCase();
  const text = typeof out.text === "string" ? out.text : "";
  if (/[֐-׿]/.test(text)) return "he";
  // אנגלית = אותיות לטיניות בלי סימנים (é, š, ž...). אחרת: שפה אחרת.
  if (/[A-Za-z]/.test(text) && !/[À-ɏ]/.test(text)) return "en";
  return text.trim() ? "other" : "";
}

/** רמז ל-Whisper: משפטים קצרים עם שמות העובדים והמוצרים, כמו שיוגב אומר אותם.
 *  נבדק 19.9 על 8 הקלטות: מדויק לגמרי 4/8 בלי הרמז, 7/8 איתו (עידו, ליה, יאן, דרימר),
 *  ומשפטים בלי שמות לא השתנו. ניסוח אחר (רשימת שמות יבשה) עזר הרבה פחות. */
export function vocabPrompt(names: { ops?: string; partners?: string; growth?: string; creative?: string; money?: string } = {}): string {
  const n = { ops: "עידו", partners: "ליה", growth: "יאן", creative: "מיכאלה", money: "אלכס", ...names };
  return `ברונו, מה ${n.ops} עושה? מ${n.partners} בודקת חנויות. ${n.growth} בודק את הקמפיין. מה ${n.creative} עושה? ${n.money} על הכספים. חולצות דרימר אפורות. SEGULA.`;
}

export async function transcribe(run: WhisperRun, audioB64: string, auto: boolean, prompt = ""): Promise<Record<string, unknown>> {
  // הרמז רק לתמלול בעברית: במצב אוטומטי רמז עברי היה מושך גם אנגלית לעברית.
  const he = { audio: audioB64, language: "he", task: "transcribe", ...(prompt ? { initial_prompt: prompt } : {}) };
  if (!auto) return run(MODEL, he);
  const first = await run(MODEL, { audio: audioB64, task: "transcribe" });
  const lang = spokenLang(first);
  if (lang === "en" || lang === "") return first;
  // עברית (או שפה שגויה): מתמללים שוב בעברית עם הרמז, שמדייק שמות.
  return run(MODEL, he);
}

/** השמות שיוגב נתן לעובדים (settings.team_names), בלי לטעון את כל מנוע הצוות. */
export async function workerNamesLite(db: { prepare: (q: string) => { first: <T>() => Promise<T | null> } } | undefined): Promise<Record<string, string>> {
  try {
    const row = await db?.prepare("SELECT value FROM settings WHERE key = 'team_names'").first<{ value: string }>();
    const saved = JSON.parse(row?.value || "{}") as Record<string, unknown>;
    return Object.fromEntries(Object.entries(saved).filter(([, v]) => typeof v === "string" && v.trim()).map(([k, v]) => [k, (v as string).trim().slice(0, 20)]));
  } catch {
    return {};
  }
}
