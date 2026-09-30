import { createFileRoute } from "@tanstack/react-router";
import { bindings } from "../../../lib/bindings.server";
import { boardChatHistory, closeUnknown, listLiveSummaries, listPending, pendingStatus, runningAgents, saveLiveSummary } from "../../../lib/assistant.server";
import { agentStub, isAuthed, unauthorized } from "../../../lib/hob.server";

// The in-board Bruno chat. GET returns the thread (optionally only rows newer
// than ?after=<id> — the polling path), POST sends one message and returns the
// answer. Both sit behind the board's session cookie: this chat has no public
// surface at all — no bot username, no webhook, nothing a stranger can reach.
export const Route = createFileRoute("/api/assistant/chat")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        if (!(await isAuthed(request))) return unauthorized();
        const env = bindings();
        if (!env.DB) return Response.json({ ok: false, code: "no_db" }, { status: 500 });
        const params = new URL(request.url).searchParams;
        // מצב של אישור אחד: הלקוח שואל אחרי בקשת אישור שנפלה, לפני ניסיון נוסף.
        // מצב ברונו: מי מהעובדים רץ עכשיו (בטיפול), וסיכומי השיחה המשותפים.
        if (params.get("live_status") === "1") return Response.json({ ok: true, running: await runningAgents(env.DB).catch(() => []) });
        // מצב ברונו: הצעדים החיים של התור שרץ עכשיו.
        const turnQ = params.get("live_turn");
        if (turnQ) {
          const stub = agentStub();
          if (!stub) return Response.json({ ok: true, steps: [], done: false });
          const res = await stub.fetch(`https://agent/live-steps?turn=${encodeURIComponent(turnQ.slice(0, 64))}`);
          return new Response(await res.text(), { status: 200, headers: { "content-type": "application/json", "cache-control": "no-store" } });
        }
        if (params.get("live_sessions") === "1") return Response.json({ ok: true, sessions: await listLiveSummaries(env.DB) });
        const one = Number(params.get("pending_id") ?? 0) || 0;
        if (one) return Response.json({ ok: true, pending_status: await pendingStatus(env.DB, one) });
        const after = Number(params.get("after") ?? 0) || 0;
        // האישורים הפעילים מגיעים עם השרשור: שורדים רענון ומכשיר אחר.
        return Response.json({ ok: true, messages: await boardChatHistory(env.DB, 80, after), pending: await listPending(env.DB).catch(() => []) });
      },
      POST: async ({ request }) => {
        if (!(await isAuthed(request))) return unauthorized();
        // A non-JSON body is a receipt photo from the 📷 button: raw image
        // bytes, mime in the content-type, actor in the query string. Kept on
        // this route so routeTree.gen.ts stays untouched.
        const ctype = request.headers.get("content-type") ?? "";
        if (ctype && !ctype.includes("application/json")) {
          if (!/^image\/(jpeg|png|webp|gif)/.test(ctype)) {
            return Response.json({ ok: false, code: "bad_type" }, { status: 400 });
          }
          const bytes = await request.arrayBuffer();
          // The client downsizes before upload; anything this big means that
          // failed — reject instead of feeding the vision API a whale.
          if (!bytes.byteLength || bytes.byteLength > 6 * 1024 * 1024) {
            return Response.json({ ok: false, code: "bad_size" }, { status: 400 });
          }
          const actorParam = new URL(request.url).searchParams.get("actor") ?? "";
          const stub = agentStub();
          if (!stub) return Response.json({ ok: false, code: "agent_not_bound" }, { status: 500 });
          const res = await stub.fetch(
            `https://agent/board-receipt?mime=${encodeURIComponent(ctype.split(";")[0])}&actor=${encodeURIComponent(actorParam)}`,
            { method: "POST", body: bytes },
          );
          if (!res.ok) return Response.json({ ok: false, code: "agent_error" }, { status: 502 });
          const data = (await res.json()) as { answer?: string };
          return Response.json({ ok: true, answer: data.answer ?? "" });
        }
        let text = "";
        let actor = "";
        let voice = false;
        let live = false;
        let lang: "he" | "en" = "he";
        let speak = "";
        let liveSummary: unknown = null;
        let turn = "";
        let confirm: { id: number; approve: boolean; edits?: Record<string, unknown> } | null = null;
        let closeId = 0;
        try {
          const body = (await request.json()) as { text?: unknown; actor?: unknown; voice?: unknown; live?: unknown; lang?: unknown; speak?: unknown; live_summary?: unknown; turn?: unknown; confirm?: unknown; approve?: unknown; edits?: unknown; close_unknown?: unknown };
          if (typeof body.text === "string") text = body.text.trim().slice(0, 2000);
          if (typeof body.actor === "string") actor = body.actor;
          voice = body.voice === true;
          live = body.live === true;
          if (body.lang === "en") lang = "en";
          if (typeof body.speak === "string") speak = body.speak.trim().slice(0, 700);
          if (body.live_summary) liveSummary = body.live_summary;
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
        if (liveSummary) {
          const env = bindings();
          if (!env.DB) return Response.json({ ok: false, code: "no_db" }, { status: 500 });
          return Response.json(await saveLiveSummary(env.DB, liveSummary, actor));
        }
        // הקול של מצב ברונו: {speak, lang} מחזיר mp3, או 204 כשאין קול (הלקוח חוזר לקול הדפדפן).
        if (speak) {
          const stub = agentStub();
          if (!stub) return new Response(null, { status: 204 });
          const res = await stub.fetch("https://agent/board-tts", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: speak, lang }) });
          if (res.status !== 200) return new Response(null, { status: 204 });
          return new Response(res.body, { headers: { "content-type": "audio/mpeg", "cache-control": "no-store" } });
        }
        if (!text) return Response.json({ ok: false, code: "bad_request" }, { status: 400 });
        const stub = agentStub();
        if (!stub) return Response.json({ ok: false, code: "agent_not_bound" }, { status: 500 });
        const res = await stub.fetch("https://agent/board-chat", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ text, actor, voice, live, lang, turn }),
        });
        if (!res.ok) return Response.json({ ok: false, code: "agent_error" }, { status: 502 });
        const data = (await res.json()) as { answer?: string; pending?: unknown[]; trace?: unknown };
        return Response.json({ ok: true, answer: data.answer ?? "", pending: data.pending ?? [], trace: data.trace ?? null });
      },
    },
  },
});
