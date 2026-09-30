import { createFileRoute } from "@tanstack/react-router";
import { agentStub, isAuthed, notifyViaAgent, unauthorized } from "../../lib/hob.server";
import { LOCATION_LABEL, isPartner, partnerLabel } from "../../lib/partners";
import {
  GIFT_STATUSES,
  addGift,
  addItem,
  addSale,
  deleteGift,
  deleteItem,
  deleteSale,
  getSeeding,
  normHandledBy,
  normLocation,
  popupTodayTotals,
  receiveStock,
  salesCsv,
  setPositions,
  stockCsv,
  transferStock,
  updateGift,
  updateItem,
  updateSale,
  updateStock,
} from "../../lib/seeding.server";

// Kick the DO to drain the Shopify push queue (fire-safe: a failure here
// never fails the user's action; rows stay queued for the next kick).
async function pokeShopifyPush(): Promise<void> {
  try {
    const stub = agentStub();
    if (!stub) return;
    await stub.fetch("https://agent/shopify-push-drain", { method: "POST" });
  } catch {
    // Queue rows survive; the next mutation retries.
  }
}

// "from Avia's place" / "from Lior's place" for the board message.
const fromLocation = (loc: string) => `מ${LOCATION_LABEL[normLocation(loc)]}`;

const PAY_HE: Record<string, string> = { shopify: "שופיפיי", bit: "ביט", cash: "מזומן", transfer: "העברה" };

function bad(): Response {
  return Response.json({ ok: false, code: "bad_request" }, { status: 400 });
}

type BucketPatch = Partial<Record<"qty" | "qty_xs" | "qty_s" | "qty_m" | "qty_l" | "qty_xl" | "qty_xxl", number>>;

// One person can take/buy SEVERAL items in one action: the client sends an
// items array; each line becomes its own row (per-item stock math stays
// simple). Falls back to the single itemId/qty shape (used by Hobi's tools).
function parseLines(
  body: Record<string, unknown>,
  withPrice: boolean,
): { itemId: number; qty: number; size: string; price: number }[] | null {
  const raw = Array.isArray(body.items)
    ? body.items
    : [{ itemId: body.itemId, qty: body.qty, size: body.size, price: body.price }];
  const lines: { itemId: number; qty: number; size: string; price: number }[] = [];
  for (const entry of raw as Record<string, unknown>[]) {
    const rawItemId = entry?.itemId;
    const rawQty = entry?.qty;
    const rawSize = entry?.size;
    const rawPrice = entry?.price;
    const itemId = typeof rawItemId === "number" ? rawItemId : 0;
    const qty = typeof rawQty === "number" ? Math.trunc(rawQty) : 1;
    const size = typeof rawSize === "string" ? rawSize.trim().slice(0, 30) : "";
    const price = withPrice && typeof rawPrice === "number" ? rawPrice : 0;
    if (!itemId || qty < 1 || qty > 1000 || price < 0) return null;
    lines.push({ itemId, qty, size, price });
  }
  return lines.length > 0 && lines.length <= 20 ? lines : null;
}

function lineText(r: { label: string; size: string; qty: number }): string {
  return `${r.label}${r.size ? ` מידה ${r.size}` : ""}${r.qty > 1 ? ` ×${r.qty}` : ""}`;
}

// Update/delete accept a single id or an ids array: the UI shows a
// multi-item gift/sale as ONE grouped row, so shared-field edits and deletes
// apply to all of its lines at once.
function parseIds(body: Record<string, unknown>, single: number): number[] {
  if (Array.isArray(body.ids)) {
    const ids = body.ids.filter((n): n is number => typeof n === "number");
    return ids.length > 0 && ids.length <= 50 ? ids : [];
  }
  return single ? [single] : [];
}

// Reorder payload: the full group sequence, each entry = one grouped row.
function parseOrders(body: Record<string, unknown>): { ids: number[]; position: number }[] | null {
  if (!Array.isArray(body.orders) || body.orders.length > 300) return null;
  const orders: { ids: number[]; position: number }[] = [];
  for (const entry of body.orders as Record<string, unknown>[]) {
    const rawIds = entry?.ids;
    const rawPos = entry?.position;
    if (!Array.isArray(rawIds) || typeof rawPos !== "number") return null;
    const ids = rawIds.filter((n): n is number => typeof n === "number");
    if (!ids.length || ids.length > 50) return null;
    orders.push({ ids, position: Math.trunc(rawPos) });
  }
  return orders.length ? orders : null;
}

function stockWarnings(results: { label: string; size: string; stockLeft: number }[]): string {
  const warnings: string[] = [];
  for (const r of results) {
    const what = r.size ? `${r.label} מידה ${r.size}` : r.label;
    if (r.stockLeft <= 0) warnings.push(`⚠️ נגמר המלאי של ${what} (נשאר: ${r.stockLeft})`);
    else if (r.stockLeft <= 2) warnings.push(`📉 נשארו רק ${r.stockLeft} במלאי של ${what}`);
  }
  return warnings.length ? `\n${warnings.join("\n")}` : "";
}

// Single endpoint for the stock module: GET returns items + stock + gifts +
// sales (or a CSV with ?export=sales|stock), POST takes { action, ... }.
export const Route = createFileRoute("/api/seeding")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        if (!(await isAuthed(request))) return unauthorized();
        const url = new URL(request.url);
        const exp = url.searchParams.get("export");
        if (exp === "sales" || exp === "stock") {
          const csv = exp === "sales" ? await salesCsv() : await stockCsv();
          return new Response(`﻿${csv}`, {
            headers: {
              "content-type": "text/csv; charset=utf-8",
              "content-disposition": `attachment; filename="hob-${exp}.csv"`,
            },
          });
        }
        const data = await getSeeding();
        return Response.json({ ok: true, ...data });
      },
      POST: async ({ request }) => {
        if (!(await isAuthed(request))) return unauthorized();
        let body: Record<string, unknown>;
        try {
          body = (await request.json()) as Record<string, unknown>;
        } catch {
          return bad();
        }
        const action = typeof body.action === "string" ? body.action : "";
        // The actor is the logged-in partner ('avia' | 'lior'). Until the
        // session carries the user, the client sends it; anything else is ''.
        const actor = isPartner(body.actor) ? body.actor : "";
        const actorName = actor ? partnerLabel(actor) : "מישהי";
        const id = typeof body.id === "number" ? body.id : 0;

        if (action === "item_add") {
          const name = typeof body.name === "string" ? body.name.trim() : "";
          const size = typeof body.size === "string" ? body.size.trim() : "";
          const qty = typeof body.qty === "number" ? Math.trunc(body.qty) : 0;
          const price = typeof body.price === "number" ? body.price : undefined;
          const unitCost = typeof body.unitCost === "number" ? body.unitCost : undefined;
          const collection = typeof body.collection === "string" ? body.collection : undefined;
          const image = typeof body.image === "string" ? body.image : undefined;
          if (!name || name.length > 200 || qty < 0 || qty > 100000) return bad();
          await addItem(name, size, qty, { price, unitCost, collection, image, location: normLocation(body.location) });
        } else if (action === "item_update") {
          if (!id || typeof body.patch !== "object" || body.patch === null) return bad();
          const itemPatch = body.patch as Record<string, unknown>;
          await updateItem(id, itemPatch as { name?: string; price?: number; unit_cost?: number; collection?: string; image?: string });
        } else if (action === "stock_update") {
          if (!id || typeof body.patch !== "object" || body.patch === null) return bad();
          await updateStock(id, normLocation(body.location), body.patch as BucketPatch);
        } else if (action === "stock_receive") {
          // Add inventory (a shipment arrived): relative, at one location.
          const size = typeof body.size === "string" ? body.size : "";
          const qty = typeof body.qty === "number" ? Math.trunc(body.qty) : 0;
          if (!id || qty < 1 || qty > 100000) return bad();
          await receiveStock(id, normLocation(body.location), size, qty);
        } else if (action === "stock_transfer") {
          const size = typeof body.size === "string" ? body.size : "";
          const qty = typeof body.qty === "number" ? Math.trunc(body.qty) : 0;
          if (!id || qty < 1 || qty > 10000) return bad();
          await transferStock(id, normLocation(body.from), normLocation(body.to), size, qty);
        } else if (action === "item_del") {
          if (!id) return bad();
          await deleteItem(id);
        } else if (action === "gift_add") {
          const person = typeof body.person === "string" ? body.person.trim() : "";
          const handle = typeof body.handle === "string" ? body.handle.trim() : "";
          // Presets or a free-text label ("צלמת", "ספק"...): both are valid kinds.
          const kind =
            typeof body.kind === "string" && body.kind.trim()
              ? body.kind.trim().slice(0, 30)
              : "influencer";
          const status =
            typeof body.status === "string" && GIFT_STATUSES.has(body.status)
              ? body.status
              : "given";
          const note = typeof body.note === "string" ? body.note.trim() : "";
          const givenAt = typeof body.givenAt === "string" ? body.givenAt : "";
          const location = normLocation(body.location);
          const lines = parseLines(body, false);
          if (!lines || !person || person.length > 200) return bad();
          const results: { label: string; stockLeft: number; qty: number; size: string }[] = [];
          for (const line of lines) {
            const result = await addGift({
              itemId: line.itemId,
              person,
              handle,
              kind,
              qty: line.qty,
              size: line.size,
              location,
              status,
              note,
              givenAt,
            });
            if (result) results.push({ ...result, qty: line.qty, size: line.size });
          }
          if (!results.length) return bad();
          const who = handle ? `${person} (@${handle.replace(/^@/, "")})` : person;
          const itemsTxt = results.map(lineText).join(" + ");
          await notifyViaAgent(
            "custom",
            actor,
            `🎁 ${actorName} רשמה מתנה ${fromLocation(location)}: ${who} — ${itemsTxt}${stockWarnings(results)}`,
          );
        } else if (action === "sale_add") {
          const buyer = typeof body.buyer === "string" ? body.buyer.trim() : "";
          const buyerPhone = typeof body.buyerPhone === "string" ? body.buyerPhone.trim().slice(0, 30) : "";
          const note = typeof body.note === "string" ? body.note.trim() : "";
          const soldAt = typeof body.soldAt === "string" ? body.soldAt : "";
          const location = normLocation(body.location);
          const payMethod = typeof body.payMethod === "string" ? body.payMethod : "";
          const channel = body.channel === "popup" ? "popup" : "";
          // Who handled the sale: explicit choice, else whoever is logging it.
          const handledBy = normHandledBy(body.handledBy) || actor;
          const lines = parseLines(body, true);
          if (!lines || !buyer || buyer.length > 200) return bad();
          const results: { label: string; stockLeft: number; qty: number; size: string; price: number }[] = [];
          for (const line of lines) {
            const result = await addSale({
              itemId: line.itemId,
              buyer,
              buyerPhone,
              qty: line.qty,
              size: line.size,
              location,
              price: line.price,
              payMethod,
              channel,
              note,
              soldAt,
              handledBy,
            });
            if (result) results.push({ ...result, qty: line.qty, size: line.size, price: line.price });
          }
          if (!results.length) return bad();
          const itemsTxt = results.map(lineText).join(" + ");
          const total = results.reduce((s, r) => s + r.price * r.qty, 0);
          if (channel === "popup" || buyer === "פופ-אפ") {
            // Event mode: the board sees the live score, not who typed it.
            const pay = PAY_HE[payMethod] ?? payMethod;
            const day = await popupTodayTotals();
            const who = buyer && buyer !== "פופ-אפ" ? ` · ${buyer}` : "";
            await notifyViaAgent(
              "custom",
              actor,
              `🎪 מכירה בפופ-אפ (${LOCATION_LABEL[location]}): ${itemsTxt}${who}${pay ? ` · ${pay}` : ""} · ₪${total}\nהיום: ${day.count} מכירות · ₪${day.revenue}${stockWarnings(results)}`,
            );
          } else {
            await notifyViaAgent(
              "custom",
              actor,
              `🛒 ${actorName} רשמה מכירה ${fromLocation(location)}: ${buyer} — ${itemsTxt} · ₪${total}${stockWarnings(results)}`,
            );
          }
        } else if (action === "sale_update") {
          const ids = parseIds(body, id);
          if (!ids.length || typeof body.patch !== "object" || body.patch === null) return bad();
          for (const sid of ids) {
            await updateSale(
              sid,
              body.patch as {
                buyer?: string;
                buyer_phone?: string;
                buyer_email?: string;
                buyer_address?: string;
                qty?: number;
                size?: string;
                price?: number;
                ship_status?: string;
                pay_method?: string;
                note?: string;
                sold_at?: string;
                channel?: string;
                delivery?: string;
                handled_by?: string;
              },
            );
          }
        } else if (action === "sale_del") {
          const ids = parseIds(body, id);
          if (!ids.length) return bad();
          for (const sid of ids) await deleteSale(sid);
        } else if (action === "gift_update") {
          const ids = parseIds(body, id);
          if (!ids.length || typeof body.patch !== "object" || body.patch === null) return bad();
          for (const gid of ids) {
            await updateGift(
              gid,
              body.patch as {
                person?: string;
                handle?: string;
                kind?: string;
                qty?: number;
                size?: string;
                status?: string;
                note?: string;
                given_at?: string;
              },
            );
          }
        } else if (action === "gift_del") {
          const ids = parseIds(body, id);
          if (!ids.length) return bad();
          for (const gid of ids) await deleteGift(gid);
        } else if (action === "shopify_map") {
          // Rebuild the (item, size) → Shopify variant map from live store data.
          const stub = agentStub();
          if (!stub) return Response.json({ ok: false, code: "agent_not_bound" }, { status: 500 });
          const r = await stub.fetch("https://agent/shopify-map", { method: "POST" });
          return new Response(await r.text(), { headers: { "content-type": "application/json" } });
        } else if (action === "gift_reorder" || action === "sale_reorder") {
          const orders = parseOrders(body);
          if (!orders) return bad();
          await setPositions(action === "gift_reorder" ? "seed_gifts" : "seed_sales", orders);
        } else {
          return bad();
        }
        // Every action that queued a Shopify delta flushes it now; otherwise
        // the row would sit in the queue until the next sale happened to.
        if (
          [
            "gift_add",
            "gift_update",
            "gift_del",
            "sale_add",
            "sale_update",
            "sale_del",
            "stock_update",
            "stock_receive",
          ].includes(action)
        ) {
          await pokeShopifyPush();
        }
        const data = await getSeeding();
        return Response.json({ ok: true, ...data });
      },
    },
  },
});
