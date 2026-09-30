import { createFileRoute } from "@tanstack/react-router";
import { bindings } from "../../lib/bindings.server";
import { agentStub, currentUser, getSetting, unauthorized } from "../../lib/hob.server";

// Phone notifications. GET = the VAPID public key (for subscribing) or the
// latest notification (for the service worker). POST ops: subscribe /
// unsubscribe / test. The sending itself runs in the DO.
export const Route = createFileRoute("/api/push")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const user = await currentUser(request);
        if (!user) return unauthorized();
        const { DB, VAPID_PUBLIC_KEY } = bindings();
        if (!DB) return Response.json({ ok: false }, { status: 500 });
        const url = new URL(request.url);
        if (url.searchParams.get("latest")) {
          const row = await DB.prepare("SELECT title, body, url FROM push_outbox WHERE created_at >= datetime('now', '-30 minutes') ORDER BY id DESC LIMIT 1").first<{ title: string; body: string; url: string }>();
          return Response.json(row ?? {});
        }
        const subs = await DB.prepare("SELECT COUNT(*) AS n FROM push_subs").first<{ n: number }>();
        const mine = await DB.prepare("SELECT COUNT(*) AS n FROM push_subs WHERE user_id = ?").bind(user.id).first<{ n: number }>();
        return Response.json({ ok: true, key: VAPID_PUBLIC_KEY ?? "", devices: subs?.n ?? 0, mine: mine?.n ?? 0 });
      },
      POST: async ({ request }) => {
        const user = await currentUser(request);
        if (!user) return unauthorized();
        const { DB } = bindings();
        if (!DB) return Response.json({ ok: false }, { status: 500 });
        const body = (await request.json().catch(() => ({}))) as { op?: string; endpoint?: string };
        const endpoint = typeof body.endpoint === "string" && /^https:\/\//.test(body.endpoint) ? body.endpoint.slice(0, 1000) : "";
        if (body.op === "subscribe" && endpoint) {
          await DB.prepare("INSERT INTO push_subs (endpoint, user_id, ua) VALUES (?1, ?2, ?3) ON CONFLICT(endpoint) DO UPDATE SET user_id = ?2, ua = ?3")
            .bind(endpoint, user.id, (request.headers.get("user-agent") ?? "").slice(0, 200))
            .run();
          return Response.json({ ok: true });
        }
        if (body.op === "unsubscribe" && endpoint) {
          await DB.prepare("DELETE FROM push_subs WHERE endpoint = ?").bind(endpoint).run();
          return Response.json({ ok: true });
        }
        if (body.op === "test") {
          const stub = agentStub();
          if (!stub) return Response.json({ ok: false }, { status: 500 });
          const name = (await getSetting("assistant_name")) || "הובי";
          const res = await stub.fetch("https://agent/push", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ title: name, body: "ההתראות עובדות. מעכשיו אני מקפיצה לכן רק מה שחשוב." }),
          });
          return new Response(await res.text(), { headers: { "content-type": "application/json" } });
        }
        return Response.json({ ok: false, code: "bad_request" }, { status: 400 });
      },
    },
  },
});
