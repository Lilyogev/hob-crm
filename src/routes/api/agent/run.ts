import { createFileRoute } from "@tanstack/react-router";
import { bindings } from "../../../lib/bindings.server";
import { isAuthed, unauthorized } from "../../../lib/hob.server";

// Manually fire a scheduled job (for testing / on demand):
// POST {"slot":"brief"|"backup"|"shopify"|"collab"}.
export const Route = createFileRoute("/api/agent/run")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        if (!(await isAuthed(request))) return unauthorized();
        let slot = "brief";
        try {
          const body = (await request.json()) as { slot?: unknown };
          if (body.slot === "brief" || body.slot === "backup" || body.slot === "shopify" || body.slot === "collab") {
            slot = body.slot;
          }
        } catch {
          // default slot
        }
        const { ROOMS } = bindings();
        if (!ROOMS) {
          return Response.json({ ok: false, code: "agent_not_bound" }, { status: 500 });
        }
        const stub = ROOMS.get(ROOMS.idFromName("hob-agent"));
        const res = await stub.fetch(`https://agent/run?slot=${slot}`);
        return new Response(await res.text(), {
          status: res.status,
          headers: { "content-type": "application/json" },
        });
      },
    },
  },
});
