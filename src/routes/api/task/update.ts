import { createFileRoute } from "@tanstack/react-router";
import { currentUser, db, notifyViaAgent, unauthorized, updateTask } from "../../../lib/hob.server";

export const Route = createFileRoute("/api/task/update")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const user = await currentUser(request);
        if (!user) return unauthorized();
        let id = 0;
        let patch: Record<string, unknown> = {};
        try {
          const body = (await request.json()) as { id?: unknown; patch?: unknown };
          if (typeof body.id === "number") id = body.id;
          if (body.patch && typeof body.patch === "object") {
            patch = body.patch as Record<string, unknown>;
          }
        } catch {
          return Response.json({ ok: false, code: "bad_request" }, { status: 400 });
        }
        if (!id) {
          return Response.json({ ok: false, code: "bad_request" }, { status: 400 });
        }
        // Snapshot before the update so we can detect a "just completed" event.
        const before = await db()
          .prepare("SELECT title, status FROM tasks WHERE id = ?")
          .bind(id)
          .first<{ title: string; status: string }>();
        const changed = await updateTask(id, patch);
        if (changed && before && patch.status === "done" && before.status !== "done") {
          await notifyViaAgent("completed", user.key, before.title);
        }
        return Response.json({ ok: true, changed });
      },
    },
  },
});
