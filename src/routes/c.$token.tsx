import { createFileRoute } from "@tanstack/react-router";
import { renderCollabNotFound, renderCollabPage } from "../lib/collab.page";
import { collabSettings, countLinkView, linkByToken } from "../lib/collab.server";
import {
  clientIp,
  isAuthed,
  isPreviewBot,
  MISS_LIMIT,
  MISS_WINDOW_MIN,
  rateHit,
  rateLocked,
} from "../lib/hob.server";

// Public influencer invite page — the ONE route on this site that must work
// without the board password (the whole point is sending it to strangers).
// Token parsed from the URL directly so we don't depend on router params
// plumbing inside a raw server handler.
export const Route = createFileRoute("/c/$token")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const url = new URL(request.url);
        const token = url.pathname.split("/").filter(Boolean).pop() ?? "";
        const settings = await collabSettings(url.origin);
        const missKey = `miss:${clientIp(request)}`;
        const found = (await rateLocked(missKey, MISS_LIMIT, MISS_WINDOW_MIN))
          ? null
          : await linkByToken(token);
        if (!found) {
          await rateHit(missKey, MISS_WINDOW_MIN);
          return new Response(renderCollabNotFound(settings), {
            status: 404,
            headers: { "content-type": "text/html; charset=utf-8" },
          });
        }
        // Partners opening links from the board (logged-in browsers) and
        // chat-app link previews must not pollute the "נפתח X×" signal —
        // count real strangers only.
        if (!isPreviewBot(request) && !(await isAuthed(request))) await countLinkView(token);
        return new Response(
          renderCollabPage(settings, found.link, found.campaign, found.product, found.products, found.offers),
          {
            headers: {
              "content-type": "text/html; charset=utf-8",
              "cache-control": "no-store",
              "x-robots-tag": "noindex",
            },
          },
        );
      },
    },
  },
});
