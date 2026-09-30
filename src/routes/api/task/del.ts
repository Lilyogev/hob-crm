import { createFileRoute } from "@tanstack/react-router";
import { deleteTask, isAuthed, unauthorized } from "../../../lib/hob.server";

export const Route = createFileRoute("/api/task/del")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        if (!(await isAuthed(request))) return unauthorized();
        let id = 0;
        try {
          const body = (await request.json()) as { id?: unknown };
          if (typeof body.id === "number") id = body.id;
        } catch {
          return Response.json({ ok: false, code: "bad_request" }, { status: 400 });
        }
        if (!id) {
          return Response.json({ ok: false, code: "bad_request" }, { status: 400 });
        }
        await deleteTask(id);
        return Response.json({ ok: true });
      },
    },
  },
});
