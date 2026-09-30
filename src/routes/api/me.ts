import { createFileRoute } from "@tanstack/react-router";
import { currentUser } from "../../lib/hob.server";

// Who is logged in on this device. The board keeps the answer in React state;
// every API route re-reads it from the session cookie anyway.
export const Route = createFileRoute("/api/me")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const user = await currentUser(request);
        return Response.json({ ok: true, authed: user !== null, user: user ? { key: user.key, name: user.name } : null });
      },
    },
  },
});
