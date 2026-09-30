import { createFileRoute } from "@tanstack/react-router";
import { clientIp, createSession, loginFailed, loginLocked, loginSucceeded, verifyPassword } from "../../lib/hob.server";
import { isPartner } from "../../lib/partners";

// Login: {user: 'avia' | 'lior', password}. The lockout (per IP and global)
// lives in hob.server.ts (login_attempts).
export const Route = createFileRoute("/api/login")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        let user = "";
        let password = "";
        try {
          const body = (await request.json()) as { user?: unknown; password?: unknown };
          if (typeof body.user === "string") user = body.user.trim().toLowerCase();
          if (typeof body.password === "string") password = body.password;
        } catch {
          return Response.json({ ok: false, code: "bad_request" }, { status: 400 });
        }
        if (!isPartner(user) || !password || password.length > 200) {
          return Response.json({ ok: false, code: "bad_request" }, { status: 400 });
        }
        const ip = clientIp(request);
        if (await loginLocked(ip)) {
          return Response.json({ ok: false, code: "locked" }, { status: 429 });
        }
        const found = await verifyPassword(user, password);
        if (!found) {
          await loginFailed(ip);
          return Response.json({ ok: false, code: "wrong_password" }, { status: 401 });
        }
        await loginSucceeded(ip);
        return Response.json(
          { ok: true, user: { key: found.key, name: found.name } },
          { headers: { "Set-Cookie": await createSession(request, found.id) } },
        );
      },
    },
  },
});
