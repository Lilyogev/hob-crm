import { createFileRoute } from "@tanstack/react-router";
import { getBoard, isAuthed, unauthorized } from "../../lib/hob.server";

export const Route = createFileRoute("/api/board")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        if (!(await isAuthed(request))) return unauthorized();
        const params = new URL(request.url).searchParams;
        // בדיקת גרסה בלבד: טאבים אחרים שואלים רק "יש פריסה חדשה?", בלי למשוך את כל הלוח.
        if (params.get("only") === "v") return Response.json({ ok: true, v: __BUILD_ID__ });
        // ?archived=1: רק המשימות שבארכיון, כשפותחים את הארכיון. בלי זה הן לא נשלחות.
        const groups = await getBoard({ archived: params.get("archived") === "1" ? "only" : "exclude" });
        // v = the server bundle's build stamp; the client reloads on mismatch
        // so open tabs pick up a new deploy within one poll cycle.
        return Response.json({ ok: true, groups, v: __BUILD_ID__ });
      },
    },
  },
});
