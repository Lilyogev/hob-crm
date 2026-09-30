import { createFileRoute } from "@tanstack/react-router";
import { clearAuthCookie, destroySession } from "../../lib/hob.server";

export const Route = createFileRoute("/api/logout")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        // Revoke on the server too — clearing the cookie alone would leave
        // the token valid on any other copy of it.
        await destroySession(request);
        return Response.json(
          { ok: true },
          { headers: { "Set-Cookie": clearAuthCookie() } },
        );
      },
    },
  },
});
