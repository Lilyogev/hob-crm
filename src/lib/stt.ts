// תמלול עם Whisper של Workers AI, תמיד בעברית (השותפות מדברות עברית). רמז אוצר
// מילים עם שמות השותפות והמותג מדייק את השמות בתמלול.
import { PARTNER, PARTNERS } from "./partners";

export type WhisperRun = (model: string, input: Record<string, unknown>) => Promise<Record<string, unknown>>;
const MODEL = "@cf/openai/whisper-large-v3-turbo";

/** רמז ל-Whisper: משפטים קצרים עם שמות השותפות והמותג, כמו שאומרים אותם בצ'אט. */
export function vocabPrompt(brand = "hob"): string {
  const [a, b] = PARTNERS.map((k) => PARTNER[k].label);
  const name = brand.trim() || "hob";
  return `הובי, מה יש במלאי אצל ${a}? ${b} שילמה על אריזות. תזכירי ל${a} מחר. ${name}, House of Bais.`;
}

export async function transcribe(run: WhisperRun, audioB64: string, prompt = ""): Promise<Record<string, unknown>> {
  return run(MODEL, { audio: audioB64, language: "he", task: "transcribe", ...(prompt ? { initial_prompt: prompt } : {}) });
}

/** שם המותג מההגדרות (settings.brand_name), בלי לטעון מודולים אחרים. */
export async function brandNameLite(db: { prepare: (q: string) => { first: <T>() => Promise<T | null> } } | undefined): Promise<string> {
  try {
    const row = await db?.prepare("SELECT value FROM settings WHERE key = 'brand_name'").first<{ value: string }>();
    return (row?.value ?? "").trim().slice(0, 40);
  } catch {
    return "";
  }
}
