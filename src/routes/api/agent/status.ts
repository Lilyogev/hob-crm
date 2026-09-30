import { createFileRoute } from "@tanstack/react-router";
import { bindings } from "../../../lib/bindings.server";
import { isAuthed, unauthorized } from "../../../lib/hob.server";

// Reports the summary agent's next alarm + last sends, and (re)arms the alarm
// chain if it is not scheduled. Safe to call any time.
export const Route = createFileRoute("/api/agent/status")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        if (!(await isAuthed(request))) return unauthorized();
        const { ROOMS } = bindings();
        if (!ROOMS) {
          return Response.json({ ok: false, code: "agent_not_bound" }, { status: 500 });
        }
        const stub = ROOMS.get(ROOMS.idFromName("hob-agent"));
        const res = await stub.fetch("https://agent/status");
        return new Response(await res.text(), {
          status: res.status,
          headers: { "content-type": "application/json" },
        });
      },
    },
  },
});
