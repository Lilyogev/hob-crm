import { expect, test } from "vitest";
import { transcribe, vocabPrompt, type WhisperRun } from "../src/lib/stt";

// Whisper מדומה: רושם את הקלט ומחזיר טקסט קבוע.
const fake = () => {
  const calls: Record<string, unknown>[] = [];
  const run: WhisperRun = async (_m, input) => {
    calls.push(input);
    return { text: "מה יש במלאי אצל אביה", transcription_info: { language: "he" } };
  };
  return { run, calls };
};

test("תמיד עברית, קריאה אחת, עם רמז אוצר המילים כשניתן", async () => {
  const f = fake();
  await transcribe(f.run, "x");
  expect(f.calls).toEqual([{ audio: "x", language: "he", task: "transcribe" }]);
  const g = fake();
  expect((await transcribe(g.run, "x", "רמז")).text).toBe("מה יש במלאי אצל אביה");
  expect(g.calls).toEqual([{ audio: "x", language: "he", task: "transcribe", initial_prompt: "רמז" }]);
});

test("רמז אוצר המילים: שמות השותפות והמותג, בלי שמות ישנים", () => {
  const p = vocabPrompt();
  expect(p).toContain("אביה");
  expect(p).toContain("ליאור");
  expect(p).toContain("הובי");
  expect(p).toContain("hob");
  expect(p).not.toMatch(/ברונו|SEGULA|יוגב|עידו/);
  expect(vocabPrompt("House of Bais")).toContain("House of Bais");
});
