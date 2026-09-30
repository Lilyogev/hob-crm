// Receipt photos: upload one for an expense, read it back, delete it. The
// bytes never leave through the bucket itself — every byte passes this route,
// which requires the same board cookie as the rest of the finance data.
import { createFileRoute } from "@tanstack/react-router";
import { isAuthed, unauthorized } from "../../lib/hob.server";
import { addReceipt, attachReceipt, deleteReceipt, readReceipt } from "../../lib/finance.server";

// Phones shoot 3-4MB stills; the board resizes before sending, so anything
// this big means something went wrong client-side.
const MAX_BYTES = 6 * 1024 * 1024;
const ALLOWED = new Set(["image/jpeg", "image/png", "image/webp", "application/pdf"]);

function bad(code: string): Response {
  return Response.json({ ok: false, code }, { status: 400 });
}

export const Route = createFileRoute("/api/receipt")({
  server: {
    handlers: {
      // GET /api/receipt?id=12 — streams the file for the viewer.
      GET: async ({ request }) => {
        if (!(await isAuthed(request))) return unauthorized();
        const id = Number(new URL(request.url).searchParams.get("id") ?? 0);
        if (!id) return bad("bad_request");
        let file: Awaited<ReturnType<typeof readReceipt>>;
        try {
          file = await readReceipt(id);
        } catch {
          return Response.json({ ok: false, code: "no_storage" }, { status: 503 });
        }
        if (!file) return Response.json({ ok: false, code: "not_found" }, { status: 404 });
        return new Response(file.body as unknown as BodyInit, {
          headers: {
            "content-type": file.mime,
            // Private: a receipt is business paperwork, not a public asset.
            "cache-control": "private, max-age=86400",
          },
        });
      },

      // POST /api/receipt?expense_id=41 with the raw file as the body.
      POST: async ({ request }) => {
        if (!(await isAuthed(request))) return unauthorized();
        const url = new URL(request.url);
        const del = Number(url.searchParams.get("delete") ?? 0);
        if (del) {
          try {
            await deleteReceipt(del);
          } catch {
            return Response.json({ ok: false, code: "no_storage" }, { status: 503 });
          }
          return Response.json({ ok: true });
        }
        // Hanging an already-stored receipt (the pending strip) on an expense.
        const attach = Number(url.searchParams.get("attach") ?? 0);
        const expenseId = Number(url.searchParams.get("expense_id") ?? 0);
        if (attach) {
          if (!expenseId) return bad("bad_request");
          const ok = await attachReceipt(attach, expenseId);
          return Response.json({ ok });
        }
        const mime = (request.headers.get("content-type") ?? "").split(";")[0].trim();
        if (!expenseId || !ALLOWED.has(mime)) return bad("bad_request");
        const bytes = await request.arrayBuffer();
        if (!bytes.byteLength || bytes.byteLength > MAX_BYTES) return bad("bad_size");
        try {
          const id = await addReceipt({ expenseId, bytes, mime, source: "board" });
          return Response.json({ ok: true, id });
        } catch (error) {
          console.error("receipt upload failed", error);
          return Response.json({ ok: false, code: "no_storage" }, { status: 503 });
        }
      },
    },
  },
});
