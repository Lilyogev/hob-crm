import { expect, test } from "vitest";
import { spokenLang, transcribe, vocabPrompt, type WhisperRun } from "../src/lib/stt";

// Whisper מדומה: בלי שפה קבועה מחזיר את מה שזיהה; עם language=he מחזיר עברית.
const fake = (autoOut: Record<string, unknown>) => {
  const calls: Record<string, unknown>[] = [];
  const run: WhisperRun = async (_m, input) => {
    calls.push(input);
    return input.language === "he" ? { text: "תסביר לי מה עידו עושה", transcription_info: { language: "he" } } : autoOut;
  };
  return { run, calls };
};

test("מצב אנגלית: עברית שזוהתה כצרפתית מתומללת מחדש כעברית", async () => {
  const f = fake({ text: "Et d'âme l'air.", transcription_info: { language: "fr" } });
  const out = await transcribe(f.run, "x", true);
  expect(out.text).toBe("תסביר לי מה עידו עושה");
  expect(f.calls).toHaveLength(2);
});

test("מצב אנגלית: אנגלית נשארת בקריאה אחת; עברית מתומללת שוב עם רמז השמות", async () => {
  const en = fake({ text: "How are sales?", transcription_info: { language: "en" } });
  expect((await transcribe(en.run, "x", true, "רמז")).text).toBe("How are sales?");
  expect(en.calls).toHaveLength(1);
  const he = fake({ text: "תסביר לי מה היא דוסה", transcription_info: { language: "he" } });
  expect((await transcribe(he.run, "x", true, "רמז")).text).toBe("תסביר לי מה עידו עושה");
  expect(he.calls[1]).toMatchObject({ language: "he", initial_prompt: "רמז" });
});

test("רמז השמות: ברירת מחדל = הניסוח שנבדק; שמות שיוגב שינה נכנסים במקום", () => {
  expect(vocabPrompt()).toBe("ברונו, מה עידו עושה? מליה בודקת חנויות. יאן בודק את הקמפיין. מה מיכאלה עושה? אלכס על הכספים. חולצות דרימר אפורות. SEGULA.");
  expect(vocabPrompt({ ops: "דני" })).toContain("מה דני עושה?");
});

test("בלי transcription_info: מזהים לפי האותיות", () => {
  expect(spokenLang({ text: "Bruno, oni roceš što sviđerili" })).toBe("other");
  expect(spokenLang({ text: "Hey Bruno, tell me what Ido is doing?" })).toBe("en");
  expect(spokenLang({ text: "מה דחוף היום" })).toBe("he");
});

test("מצב עברית: תמיד language=he, קריאה אחת", async () => {
  const f = fake({ text: "x" });
  await transcribe(f.run, "x", false);
  expect(f.calls).toEqual([{ audio: "x", language: "he", task: "transcribe" }]);
  const g = fake({ text: "x" });
  await transcribe(g.run, "x", false, "רמז");
  expect(g.calls).toEqual([{ audio: "x", language: "he", task: "transcribe", initial_prompt: "רמז" }]);
});
