import { createFileRoute } from "@tanstack/react-router";
import { bindings } from "../../lib/bindings.server";
import { currentUser, unauthorized } from "../../lib/hob.server";
import { cancelShip, confirmShip, mergeOrders, prepareShip, setDelivery, snoozeCard, todayState, closeStaleTask } from "../../lib/today.server";

// "היום שלכן". GET = the state (cards, money, action log). POST ops: prepare /
// confirm / cancel (shipping update with confirmation), merge, delivery,
// task_done / task_drop and snooze. D1 only, no outbound calls.
export const Route = createFileRoute("/api/today")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        if (!(await currentUser(request))) return unauthorized();
        const { DB } = bindings();
        if (!DB) return Response.json({ ok: false, code: "no_db" }, { status: 500 });
        return Response.json({ ok: true, ...(await todayState(DB)) });
      },
      POST: async ({ request }) => {
        const user = await currentUser(request);
        if (!user) return unauthorized();
        const { DB } = bindings();
        if (!DB) return Response.json({ ok: false, code: "no_db" }, { status: 500 });
        const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
        const id = typeof body.id === "number" ? body.id : 0;
        const saleIds = () => (Array.isArray(body.sale_ids) ? body.sale_ids.filter((n): n is number => typeof n === "number") : []);
        if (body.op === "prepare") {
          return Response.json(await prepareShip(DB, saleIds(), body.status === "delivered" ? "delivered" : "shipped", user.key));
        }
        if (body.op === "confirm" && id) return Response.json(await confirmShip(DB, id));
        if (body.op === "merge") return Response.json(await mergeOrders(DB, saleIds()));
        if (body.op === "delivery") {
          const mode = ["", "ship", "pickup", "hand"].includes(String(body.delivery)) ? (String(body.delivery) as "" | "ship" | "pickup" | "hand") : null;
          if (mode === null) return Response.json({ ok: false, code: "bad_request" }, { status: 400 });
          return Response.json({ ok: true, changed: await setDelivery(DB, saleIds(), mode) });
        }
        if (body.op === "cancel" && id) return Response.json({ ok: await cancelShip(DB, id) });
        if ((body.op === "task_done" || body.op === "task_drop") && id) return Response.json({ ok: await closeStaleTask(DB, id, body.op === "task_done" ? "done" : "archived") });
        if (body.op === "snooze" && typeof body.card === "string") {
          return Response.json({ ok: true, until: await snoozeCard(DB, body.card.slice(0, 40), typeof body.days === "number" ? body.days : 1) });
        }
        return Response.json({ ok: false, code: "bad_request" }, { status: 400 });
      },
    },
  },
});
