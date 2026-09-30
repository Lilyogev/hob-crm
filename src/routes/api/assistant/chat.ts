import { createFileRoute } from "@tanstack/react-router";
import { bindings } from "../../../lib/bindings.server";
import { boardChatHistory, closeUnknown, listPending, pendingStatus, unreadCount } from "../../../lib/assistant.server";
import { agentStub, currentUser, unauthorized } from "../../../lib/hob.server";

// הצ'אט עם הובי בתוך הלוח. GET מחזיר את השרשור (או רק שורות חדשות מ-?after=<id>,
// או ספירה בלבד עם ?count=1 לתג על הטאב), POST שולח הודעה אחת ומחזיר תשובה.
// הכול מאחורי עוגיית הסשן; מי שכותבת (actor) נקבעת מהסשן בשרת, לעולם לא מהלקוח.
export const Route = createFileRoute("/api/assistant/chat")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const user = await currentUser(request);
        if (!user) return unauthorized();
        const env = bindings();
        if (!env.DB) return Response.json({ ok: false, code: "no_db" }, { status: 500 });
        const params = new URL(request.url).searchParams;
        const after = Number(params.get("after") ?? 0) || 0;
        // התג על הטאב: כמה שורות חדשות שלא היא כתבה.
        if (params.get("count") === "1") return Response.json({ ok: true, count: await unreadCount(env.DB, after, user.key) });
        // התשובה המיידית של התור שרץ עכשיו (נשמרת ב-DO בלבד).
        const turnQ = params.get("live_turn");
        if (turnQ) {
          const stub = agentStub();
          if (!stub) return Response.json({ ok: true, steps: [], done: false, quick: null });
          const res = await stub.fetch(`https://agent/live-steps?turn=${encodeURIComponent(turnQ.slice(0, 64))}`);
          return new Response(await res.text(), { status: 200, headers: { "content-type": "application/json", "cache-control": "no-store" } });
        }
        // מצב של אישור אחד: הלקוח שואל אחרי בקשת אישור שנפלה, לפני ניסיון נוסף.
        const one = Number(params.get("pending_id") ?? 0) || 0;
        if (one) return Response.json({ ok: true, pending_status: await pendingStatus(env.DB, one) });
        // האישורים הפעילים מגיעים עם השרשור: שורדים רענון ומכשיר אחר.
        return Response.json({ ok: true, me: user.key, messages: await boardChatHistory(env.DB, 80, after), pending: await listPending(env.DB).catch(() => []) });
      },
      POST: async ({ request }) => {
        const user = await currentUser(request);
        if (!user) return unauthorized();
        const actor = user.key;
        // A non-JSON body is a receipt photo from the 📷 button: raw image
        // bytes, mime in the content-type.
        const ctype = request.headers.get("content-type") ?? "";
        if (ctype && !ctype.includes("application/json")) {
          if (!/^image\/(jpeg|png|webp|gif)/.test(ctype)) return Response.json({ ok: false, code: "bad_type" }, { status: 400 });
          const bytes = await request.arrayBuffer();
          // The client downsizes before upload; anything this big means that failed.
          if (!bytes.byteLength || bytes.byteLength > 6 * 1024 * 1024) return Response.json({ ok: false, code: "bad_size" }, { status: 400 });
          const stub = agentStub();
          if (!stub) return Response.json({ ok: false, code: "agent_not_bound" }, { status: 500 });
          const res = await stub.fetch(`https://agent/board-receipt?mime=${encodeURIComponent(ctype.split(";")[0])}&actor=${encodeURIComponent(actor)}`, { method: "POST", body: bytes });
          if (!res.ok) return Response.json({ ok: false, code: "agent_error" }, { status: 502 });
          const data = (await res.json()) as { answer?: string };
          return Response.json({ ok: true, answer: data.answer ?? "" });
        }
        let text = "";
        let voice = false;
        let turn = "";
        let confirm: { id: number; approve: boolean; edits?: Record<string, unknown> } | null = null;
        let closeId = 0;
        try {
          const body = (await request.json()) as { text?: unknown; voice?: unknown; turn?: unknown; confirm?: unknown; approve?: unknown; edits?: unknown; close_unknown?: unknown };
          if (typeof body.text === "string") text = body.text.trim().slice(0, 2000);
          voice = body.voice === true;
          if (typeof body.turn === "string") turn = body.turn.slice(0, 64);
          if (typeof body.confirm === "number") {
            const edits = body.edits && typeof body.edits === "object" && !Array.isArray(body.edits) ? (body.edits as Record<string, unknown>) : undefined;
            confirm = { id: body.confirm, approve: body.approve === true, edits };
          }
          if (typeof body.close_unknown === "number") closeId = body.close_unknown;
        } catch {
          /* falls through to bad_request below */
        }
        if (closeId) {
          const env = bindings();
          if (!env.DB) return Response.json({ ok: false, code: "no_db" }, { status: 500 });
          return Response.json({ ok: await closeUnknown(env.DB, closeId) });
        }
        if (confirm) {
          const stub = agentStub();
          if (!stub) return Response.json({ ok: false, code: "agent_not_bound" }, { status: 500 });
          const res = await stub.fetch("https://agent/board-confirm", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(confirm) });
          return new Response(await res.text(), { status: 200, headers: { "content-type": "application/json" } });
        }
        if (!text) return Response.json({ ok: false, code: "bad_request" }, { status: 400 });
        const stub = agentStub();
        if (!stub) return Response.json({ ok: false, code: "agent_not_bound" }, { status: 500 });
        const res = await stub.fetch("https://agent/board-chat", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ text, actor, voice, turn }),
        });
        if (!res.ok) return Response.json({ ok: false, code: "agent_error" }, { status: 502 });
        const data = (await res.json()) as { answer?: string; pending?: unknown[] };
        return Response.json({ ok: true, answer: data.answer ?? "", pending: data.pending ?? [] });
      },
    },
  },
});
