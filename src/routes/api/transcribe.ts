import { createFileRoute } from "@tanstack/react-router";
import { bindings } from "../../lib/bindings.server";
import { isAuthed, unauthorized } from "../../lib/hob.server";
import { transcribe, vocabPrompt, workerNamesLite } from "../../lib/stt";
import { markConn } from "../../lib/conn.server";

// כפתור הקול בשיחה עם ברונו: הדפדפן מקליט (MediaRecorder), שולח לכאן את
// הבייטים, ו-Whisper של Workers AI מחזיר טקסט בעברית. נבחר במקום זיהוי הדיבור
// של הדפדפן כי זה לא עובד באייפון כשהלוח מותקן על מסך הבית.
export const Route = createFileRoute("/api/transcribe")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        if (!(await isAuthed(request))) return unauthorized();
        const { AI } = bindings();
        if (!AI) return Response.json({ ok: false, code: "no_ai" }, { status: 500 });
        const bytes = new Uint8Array(await request.arrayBuffer());
        if (bytes.byteLength < 1000) return Response.json({ ok: false, code: "empty" }, { status: 400 });
        if (bytes.byteLength > 6_000_000) return Response.json({ ok: false, code: "too_long" }, { status: 413 });
        let bin = "";
        for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
        try {
          // ?lang=en כשמצב ברונו על אנגלית: עברית או אנגלית בלבד (ראו stt.ts). כל השאר עברית.
          const auto = new URL(request.url).searchParams.get("lang") === "en";
          const out = await transcribe(AI.run.bind(AI), btoa(bin), auto, vocabPrompt(await workerNamesLite(bindings().DB)));
          await markConn(bindings().DB, "whisper");
          const text = typeof out.text === "string" ? out.text.trim() : "";
          // זמנים לכל משפט, כש-Whisper מחזיר אותם. משמש את "עזרי לי לסיים"; הצ'אט קורא רק את text.
          const raw = (out as { segments?: unknown }).segments;
          const segments = (Array.isArray(raw) ? raw : [])
            .map((x) => x as { start?: unknown; end?: unknown; text?: unknown })
            .filter((x) => typeof x.start === "number" && typeof x.end === "number" && typeof x.text === "string")
            .slice(0, 60)
            .map((x) => ({ start: x.start as number, end: x.end as number, text: (x.text as string).trim() }));
          return Response.json({ ok: true, text, segments });
        } catch (error) {
          console.error("transcribe failed", String(error));
          await markConn(bindings().DB, "whisper", error);
          return Response.json({ ok: false, code: "stt_failed", detail: String(error).slice(0, 200) }, { status: 502 });
        }
      },
    },
  },
});
