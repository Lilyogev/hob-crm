import { createFileRoute } from "@tanstack/react-router";
import { collabSettings, countSaleClick, discountURL, saleCodeExists } from "../lib/collab.server";
import { isAuthed } from "../lib/hob.server";

// The influencer's public sale link: /s/<code> counts the click and forwards
// to the store's native discount redirect (settings.store_url + /discount/CODE),
// so the leaderboard can show clicks → sales conversion per influencer.
// Unknown or closed codes still land on the store — a dead link in an
// influencer's story would be worse than a lost count.
export const Route = createFileRoute("/s/$code")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const url = new URL(request.url);
        const code = (url.pathname.split("/").filter(Boolean).pop() ?? "")
          .toUpperCase()
          .replace(/[^A-Z0-9]/g, "");
        const settings = await collabSettings(url.origin);
        // A logged-in partner testing her sale link still gets the redirect,
        // but the click never reaches the leaderboard funnel.
        const authed = await isAuthed(request);
        const known = code ? (authed ? await saleCodeExists(code) : await countSaleClick(code)) : false;
        const target = known ? discountURL(settings, code) : settings.storeUrl || "/";
        return new Response(null, {
          status: 302,
          headers: { location: target, "cache-control": "no-store" },
        });
      },
    },
  },
});
