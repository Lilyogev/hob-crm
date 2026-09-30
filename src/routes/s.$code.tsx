import { createFileRoute } from "@tanstack/react-router";
import { countSaleClick, saleCodeExists } from "../lib/collab.server";
import { isAuthed } from "../lib/hob.server";

// The influencer's public sale link: /s/<code> counts the click and forwards
// to Shopify's native auto-apply redirect, so the leaderboard can show
// clicks → sales conversion per influencer. Unknown codes still land on the
// store — a dead link in an influencer's story would be worse than a lost
// count.
export const Route = createFileRoute("/s/$code")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const code = (new URL(request.url).pathname.split("/").filter(Boolean).pop() ?? "")
          .toUpperCase()
          .replace(/[^A-Z0-9]/g, "");
        // A logged-in partner testing her sale link still gets the redirect,
        // but the click never reaches the leaderboard funnel.
        const authed = await isAuthed(request);
        const known = code ? (authed ? await saleCodeExists(code) : await countSaleClick(code)) : false;
        const target = known
          ? `https://segula.club/discount/${code}`
          : "https://segula.club/";
        return new Response(null, {
          status: 302,
          headers: { location: target, "cache-control": "no-store" },
        });
      },
    },
  },
});
