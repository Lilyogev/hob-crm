import { createFileRoute } from "@tanstack/react-router";
import { addTask, currentUser, db, notifyViaAgent, unauthorized } from "../../../lib/hob.server";

export const Route = createFileRoute("/api/task/add")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const user = await currentUser(request);
        if (!user) return unauthorized();
        let groupId = 0;
        let title = "";
        try {
          const body = (await request.json()) as { groupId?: unknown; title?: unknown };
          if (typeof body.groupId === "number") groupId = body.groupId;
          if (typeof body.title === "string") title = body.title.trim();
        } catch {
          return Response.json({ ok: false, code: "bad_request" }, { status: 400 });
        }
        if (!groupId || !title || title.length > 500) {
          return Response.json({ ok: false, code: "bad_request" }, { status: 400 });
        }
        // The actor is the session user; whatever the client sends is ignored.
        const task = await addTask(groupId, title, user.key);
        const group = await db()
          .prepare("SELECT title FROM board_groups WHERE id = ?")
          .bind(groupId)
          .first<{ title: string }>();
        await notifyViaAgent("added", user.key, title, group?.title);
        return Response.json({ ok: true, task });
      },
    },
  },
});
