import { createFileRoute } from "@tanstack/react-router";
import { bindings } from "../../lib/bindings.server";
import { verifyShopifyHmac } from "../../lib/shopify-sync.server";

// Shopify orders/create webhook. Authenticated by the HMAC Shopify signs over
// the raw body — not by the board cookie. A webhook created from the admin
// (Settings → Notifications → Webhooks) is signed with the signing secret
// shown on that page (SHOPIFY_WEBHOOK_SECRET); one created by the app itself
// is signed with the app's client secret. Both are accepted. The payload is
// relayed to the SummaryAgent DO (outbound fetch only works there; D1 writes
// happen there too so the whole order is one unit). See SHOPIFY.md.
export const Route = createFileRoute("/api/shopify-webhook")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const env = bindings() as ReturnType<typeof bindings> & { SHOPIFY_WEBHOOK_SECRET?: string };
        const secrets = [env.SHOPIFY_WEBHOOK_SECRET, env.SHOPIFY_CLIENT_SECRET].filter((s): s is string => Boolean(s));
        const raw = await request.text();
        const hmac = request.headers.get("x-shopify-hmac-sha256") ?? "";
        let valid = false;
        for (const secret of secrets) {
          if (await verifyShopifyHmac(secret, raw, hmac)) {
            valid = true;
            break;
          }
        }
        if (!valid) return Response.json({ ok: false }, { status: 401 });
        try {
          const rooms = env.ROOMS;
          if (rooms) {
            const stub = rooms.get(rooms.idFromName("hob-agent"));
            await stub.fetch("https://agent/shopify-order", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: raw,
            });
          }
        } catch (error) {
          console.error("shopify webhook error", error);
        }
        // Always 200 so Shopify doesn't retry-storm; failures are visible in
        // the DO black box via /api/agent/status.
        return Response.json({ ok: true });
      },
    },
  },
});
