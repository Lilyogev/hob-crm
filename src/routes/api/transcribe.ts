import { createFileRoute } from "@tanstack/react-router";
import { bindings } from "../../lib/bindings.server";
import { isAuthed, unauthorized } from "../../lib/hob.server";
import { brandNameLite, transcribe, vocabPrompt } from "../../lib/stt";

// כפתור הקול בשיחה עם הובי: הדפדפן מקליט (MediaRecorder), שולח לכאן את
// הבייטים, ו-Whisper של Workers AI מחזיר טקסט בעברית. נבחר במקום זיהוי הדיבור
// של הדפדפן כי זה לא עובד באייפון כשהלוח מותקן על מסך הבית.
export const Route = createFileRoute("/api/transcribe")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        if (!(await isAuthed(request))) return unauthorized();
        const { AI, DB } = bindings();
        if (!AI) return Response.json({ ok: false, code: "no_ai" }, { status: 500 });
        const bytes = new Uint8Array(await request.arrayBuffer());
        if (bytes.byteLength < 1000) return Response.json({ ok: false, code: "empty" }, { status: 400 });
        if (bytes.byteLength > 6_000_000) return Response.json({ ok: false, code: "too_long" }, { status: 413 });
        let bin = "";
        for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
        try {
          const out = await transcribe(AI.run.bind(AI), btoa(bin), vocabPrompt(await brandNameLite(DB)));
          const text = typeof out.text === "string" ? out.text.trim() : "";
          return Response.json({ ok: true, text });
        } catch (error) {
          console.error("transcribe failed", String(error));
          return Response.json({ ok: false, code: "stt_failed", detail: String(error).slice(0, 200) }, { status: 502 });
        }
      },
    },
  },
});
