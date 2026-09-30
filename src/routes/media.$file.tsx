import { createFileRoute } from "@tanstack/react-router";
import { bindings } from "../lib/bindings.server";
import { domStream } from "../lib/r2-stream";

// Video delivery with HTTP Range support, straight from R2. The static-assets
// host answers Range requests with a full 200 body, and iOS Safari refuses to
// play <video> from a server that can't do 206 — so the collab-page reels are
// served here instead. Whitelisted keys only; R2 does the byte slicing.
const MEDIA: Record<string, string> = {
  "reel1.mp4": "media/reel1.mp4",
  "reel2.mp4": "media/reel2.mp4",
  "reel3.mp4": "media/reel3.mp4",
};

export const Route = createFileRoute("/media/$file")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const name = new URL(request.url).pathname.split("/").filter(Boolean).pop() ?? "";
        const key = MEDIA[name];
        const { STORAGE } = bindings();
        if (!key || !STORAGE) return new Response("not found", { status: 404 });

        const head = await STORAGE.head(key);
        if (!head) return new Response("not found", { status: 404 });
        const total = head.size;

        const common = {
          "content-type": "video/mp4",
          "accept-ranges": "bytes",
          "cache-control": "public, max-age=86400",
        };

        const range = request.headers.get("range");
        const m = range ? /bytes=(\d*)-(\d*)/.exec(range) : null;
        if (m && (m[1] !== "" || m[2] !== "")) {
          // bytes=a-b | bytes=a- | bytes=-suffix
          let start: number;
          let end: number;
          if (m[1] === "") {
            const suffix = Math.min(Number(m[2]), total);
            start = total - suffix;
            end = total - 1;
          } else {
            start = Number(m[1]);
            end = m[2] === "" ? total - 1 : Math.min(Number(m[2]), total - 1);
          }
          if (start > end || start >= total) {
            return new Response(null, {
              status: 416,
              headers: { ...common, "content-range": `bytes */${total}` },
            });
          }
          const obj = await STORAGE.get(key, {
            range: { offset: start, length: end - start + 1 },
          });
          if (!obj) return new Response("not found", { status: 404 });
          return new Response(domStream(obj.body), {
            status: 206,
            headers: {
              ...common,
              "content-range": `bytes ${start}-${end}/${total}`,
              "content-length": String(end - start + 1),
            },
          });
        }

        const obj = await STORAGE.get(key);
        if (!obj) return new Response("not found", { status: 404 });
        return new Response(domStream(obj.body), {
          headers: { ...common, "content-length": String(total) },
        });
      },
    },
  },
});
