import { createFileRoute } from "@tanstack/react-router";
import { renderCollabNotFound, renderMyStatsPage } from "../lib/collab.page";
import { myStats } from "../lib/collab.server";
import { clientIp, MISS_LIMIT, MISS_WINDOW_MIN, rateHit, rateLocked } from "../lib/hob.server";

// The influencer's private stats page: /my/<token> shows HER numbers — code,
// clicks, orders, commission accrued and paid. Same unguessable token as her
// invite page, so no login; generic (QR) links and links without a minted
// code get the branded dead end instead of an empty dashboard.
export const Route = createFileRoute("/my/$token")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const token = new URL(request.url).pathname.split("/").filter(Boolean).pop() ?? "";
        const missKey = `miss:${clientIp(request)}`;
        const found = (await rateLocked(missKey, MISS_LIMIT, MISS_WINDOW_MIN))
          ? null
          : await myStats(token);
        if (!found) {
          await rateHit(missKey, MISS_WINDOW_MIN);
          return new Response(renderCollabNotFound(), {
            status: 404,
            headers: { "content-type": "text/html; charset=utf-8" },
          });
        }
        return new Response(renderMyStatsPage(found.link, found.sales), {
          headers: {
            "content-type": "text/html; charset=utf-8",
            "cache-control": "no-store",
            "x-robots-tag": "noindex",
          },
        });
      },
    },
  },
});
