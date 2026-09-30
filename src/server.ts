import "./lib/error-capture";

import type { D1Database, DurableObjectState, R2Bucket } from "@cloudflare/workers-types";

import { collabReminders } from "./lib/collab.server";
import { consumeLastCapturedError } from "./lib/error-capture";
import { renderErrorPage } from "./lib/error-page";
import { applySecurityHeaders } from "./lib/security-headers.server";
import { confirmPending, handleBoardChat, handleBoardReceipt, recentBoardHistory, type LiveStep } from "./lib/assistant.server";
import { mergeQuick, quickReply, type QuickStored } from "./lib/assistant.quick.server";
import { runBackup } from "./lib/backup.server";
import { fireDueReminders, nextReminderEpoch } from "./lib/reminders.server";
import { flushHeldOrders, nextNotifyEpoch, notify } from "./lib/notify.server";
import { pushNotify } from "./lib/push.server";
import {
  backfillOrderContacts,
  buildVariantMap,
  drainShopifyPushQueue,
  importArchiveOrders,
  runShopifyWeekly,
  shopifyCharged,
  shopifyProductTitles,
  shopifyQL,
  shopifyTraffic,
  createCollabDiscount,
  deleteCollabDiscount,
  combineCollabDiscount,
  setCollabDiscountActive,
} from "./lib/shopify.server";
import { handleShopifyOrder, type ShopifyOrderPayload } from "./lib/shopify-sync.server";
import { ilTodayISO, nextFireEpoch, notifyBoardEvent, runSummaryAgent, slotForNow, type Slot } from "./lib/summary.server";

type ServerEntry = {
  fetch: (request: Request, env: unknown, ctx: unknown) => Promise<Response> | Response;
};

let serverEntryPromise: Promise<ServerEntry> | undefined;

async function getServerEntry(): Promise<ServerEntry> {
  if (!serverEntryPromise) {
    serverEntryPromise = import("@tanstack/react-start/server-entry").then(
      (m) => (m.default ?? m) as ServerEntry,
    );
  }
  return serverEntryPromise;
}

// h3 swallows in-handler throws into a normal 500 Response with body
// {"unhandled":true,"message":"HTTPError"}; try/catch alone never fires for those.
async function normalizeCatastrophicSsrResponse(response: Response): Promise<Response> {
  if (response.status < 500) return response;
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) return response;

  const body = await response.clone().text();
  if (!body.includes('"unhandled":true') || !body.includes('"message":"HTTPError"')) {
    return response;
  }

  console.error(consumeLastCapturedError() ?? new Error(`h3 swallowed SSR error: ${body}`));
  return new Response(renderErrorPage(), {
    status: 500,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

export default {
  async fetch(request: Request, env: unknown, ctx: unknown) {
    try {
      const handler = await getServerEntry();
      const response = await handler.fetch(request, env, ctx);
      return applySecurityHeaders(await normalizeCatastrophicSsrResponse(response));
    } catch (error) {
      console.error(error);
      return new Response(renderErrorPage(), {
        status: 500,
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }
  },
};

// The hob agent: a singleton Durable Object. Its alarm runs every time-based
// job (nightly backup, the Sun/Tue/Thu brief, the Thursday Shopify report,
// reminders, held notifications), and it is the only place with outbound
// fetch (Anthropic for Hobi, Shopify, the push servers). The alarm chain is
// self-perpetuating; /api/agent/* routes reach it via env.ROOMS.
type AgentBindings = {
  DB?: D1Database;
  ANTHROPIC_API_KEY?: string;
  SHOPIFY_CLIENT_ID?: string;
  SHOPIFY_CLIENT_SECRET?: string;
  VAPID_PRIVATE_JWK?: string;
  VAPID_PUBLIC_KEY?: string;
  STORAGE?: R2Bucket;
};

export class SummaryAgent {
  private state: DurableObjectState;
  private agentEnv: AgentBindings;
  // Hobi's live steps per chat turn (keyed by the browser's turn id). In the
  // DO's memory only: they matter while the turn runs, and the "what is
  // happening" poll reaches this same object while the turn is pending.
  private liveSteps = new Map<string, { steps: LiveStep[]; at: number; done: boolean; quick?: QuickStored }>();

  constructor(state: DurableObjectState, env: unknown) {
    this.state = state;
    this.agentEnv = env as AgentBindings;
  }

  /** The black box: one line per update, last ten kept. */
  private async recordAssist(result: string): Promise<void> {
    const line = `${new Date().toISOString()} ${result}`;
    await this.state.storage.put("assist:last", line);
    const log = (await this.state.storage.get<string[]>("assist:log")) ?? [];
    log.push(line);
    await this.state.storage.put("assist:log", log.slice(-10));
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    // Hobi's chat (the הובי tab). Runs in the DO because outbound fetch
    // (Anthropic) is blocked in route handlers. Auth happened in
    // /api/assistant/chat before the relay; actor is the session user's key.
    if (url.pathname === "/board-chat") {
      const { text, actor, voice, turn } = (await request.json()) as { text?: string; actor?: string; voice?: boolean; turn?: string };
      if (!text || typeof text !== "string") {
        return Response.json({ ok: false, code: "bad_request" }, { status: 400 });
      }
      const turnId = typeof turn === "string" && /^[\w-]{8,64}$/.test(turn) ? turn : "";
      if (turnId) {
        // Drop turns older than 10 minutes.
        for (const [k, v] of this.liveSteps) if (Date.now() - v.at > 600_000) this.liveSteps.delete(k);
        this.liveSteps.set(turnId, { steps: [], at: Date.now(), done: false });
        // Two speeds: an instant reply (no tools) runs alongside the deep one
        // and lands in the turn record as soon as it is ready. If the deep
        // answer got there first, it is discarded (mergeQuick).
        void recentBoardHistory(this.agentEnv.DB, 4)
          .then((hist) => quickReply(this.agentEnv, text, hist))
          .then((q) => {
            const rec = this.liveSteps.get(turnId);
            if (rec && q) this.liveSteps.set(turnId, mergeQuick(rec, q));
          })
          .catch(() => undefined);
      }
      const onStep = turnId
        ? (st: LiveStep) => {
            const rec = this.liveSteps.get(turnId);
            if (!rec) return;
            const i = rec.steps.findIndex((x) => x.id === st.id);
            if (i >= 0) rec.steps[i] = st;
            else rec.steps.push(st);
            rec.at = Date.now();
          }
        : undefined;
      const { answer, status, pending } = await handleBoardChat(this.agentEnv, text, typeof actor === "string" ? actor : "", { voice: voice === true, onStep });
      if (turnId) {
        const rec = this.liveSteps.get(turnId);
        if (rec) rec.done = true;
      }
      await this.recordAssist(status);
      // A chat message may have just created a reminder: pull the alarm
      // earlier if that reminder is due before the next scheduled slot.
      await this.ensureAlarm();
      return Response.json({ ok: true, answer, pending: pending ?? [] });
    }

    // "What is Hobi doing now" for a running turn (plus the quick reply).
    if (url.pathname === "/live-steps") {
      const rec = this.liveSteps.get(url.searchParams.get("turn") ?? "");
      return Response.json({ ok: true, steps: rec?.steps ?? [], done: rec?.done ?? false, quick: rec?.quick ?? null });
    }

    // Confirm or cancel a held action (a command that changes money/stock/shipping).
    if (url.pathname === "/board-confirm") {
      const { id, approve, edits } = (await request.json()) as { id?: number; approve?: boolean; edits?: Record<string, unknown> };
      const result = await confirmPending(this.agentEnv, typeof id === "number" ? id : 0, approve === true, edits && typeof edits === "object" ? edits : undefined);
      await this.recordAssist(`confirm ${id}: ${result.status}`);
      await this.ensureAlarm();
      return Response.json(result);
    }

    // A receipt photo from the chat (the 📷 button). Raw image bytes in the
    // body; mime + actor ride the query string. Auth happened in the route.
    if (url.pathname === "/board-receipt") {
      const mime = url.searchParams.get("mime") ?? "image/jpeg";
      const actor = url.searchParams.get("actor") ?? "";
      const bytes = await request.arrayBuffer();
      if (!bytes.byteLength) {
        return Response.json({ ok: false, code: "bad_request" }, { status: 400 });
      }
      const { answer, status } = await handleBoardReceipt(this.agentEnv, bytes, mime, actor);
      await this.recordAssist(status);
      return Response.json({ ok: true, answer });
    }

    // A Shopify orders/create webhook, relayed from /api/shopify-webhook
    // (HMAC already verified there). Logs the sale into the stock ledger and
    // notifies the partners.
    if (url.pathname === "/shopify-order") {
      const order = (await request.json()) as ShopifyOrderPayload;
      let result: string;
      try {
        result = await handleShopifyOrder(this.agentEnv, order);
      } catch (error) {
        result = `error: ${String(error).slice(0, 300)}`;
      }
      await this.state.storage.put("shopify:last", `${new Date().toISOString()} ${result}`);
      // A new order = an immediate phone alert (through the gate: quiet hours, merging).
      if (!result.startsWith("duplicate") && !result.startsWith("error")) {
        const who = [order.customer?.first_name, order.customer?.last_name].filter(Boolean).join(" ") || "לקוחה";
        const items = (order.line_items ?? []).map((li) => `${li.title ?? ""}${li.variant_title ? ` ${li.variant_title}` : ""}`).join(", ").slice(0, 160);
        await notify(this.agentEnv, { level: "now", topic: "order", isOrder: true, title: `💸 הזמנה חדשה ${order.name ?? ""} · ${Math.round(parseFloat(order.total_price ?? "0"))} ₪`, body: `${who}: ${items}`, url: "/?tab=stock" });
        await this.ensureAlarm();
      }
      return Response.json({ ok: true, result });
    }

    // Live store traffic for the finance tab. Shopify egress only works from
    // the DO; the finance route caches this in D1 so polling never hammers
    // ShopifyQL.
    if (url.pathname === "/traffic-stats") {
      const t7 = await shopifyTraffic(this.agentEnv, 7);
      const t14 = await shopifyTraffic(this.agentEnv, 14);
      return Response.json({ t7, t14 });
    }

    // What the store actually charged per day: the figure a clearer's deposit
    // is built from, as opposed to the catalogue prices in the sales ledger.
    if (url.pathname === "/shopify-charged") {
      const since = url.searchParams.get("since") ?? "";
      const until = url.searchParams.get("until") ?? "";
      return Response.json(await shopifyCharged(this.agentEnv, since, until));
    }

    if (url.pathname === "/shopify-ql") {
      const q = url.searchParams.get("q") ?? "";
      return Response.json(await shopifyQL(this.agentEnv, q));
    }

    if (url.pathname === "/shopify-product-titles") {
      return Response.json(await shopifyProductTitles(this.agentEnv));
    }

    // Outbound Shopify stock push: routes queue deltas in D1 and poke this
    // path; the GraphQL calls run here because only the DO has egress.
    if (url.pathname === "/shopify-push-drain") {
      const result = await drainShopifyPushQueue(this.agentEnv);
      return Response.json({ ok: true, ...result });
    }

    // Remove a collab code from the store (deleted link / test cleanup).
    if (url.pathname === "/collab-discount-delete") {
      const body = (await request.json()) as { code?: string };
      return Response.json(await deleteCollabDiscount(this.agentEnv, body.code ?? ""));
    }

    // Close (or reopen) a collab code without deleting it.
    if (url.pathname === "/collab-discount-active") {
      const body = (await request.json()) as { code?: string; active?: boolean };
      return Response.json(await setCollabDiscountActive(this.agentEnv, body.code ?? "", body.active === true));
    }

    // Let an existing collab code combine with the store's automatic discounts.
    if (url.pathname === "/collab-discount-combine") {
      const body = (await request.json()) as { code?: string };
      return Response.json(await combineCollabDiscount(this.agentEnv, body.code ?? ""));
    }

    // Create a collab influencer's personal discount code (egress-only work).
    if (url.pathname === "/collab-discount") {
      const body = (await request.json()) as { code?: string; pct?: number };
      return Response.json(await createCollabDiscount(this.agentEnv, body.code ?? "", typeof body.pct === "number" ? body.pct : 0.1));
    }

    // Build/refresh the item↔variant map.
    if (url.pathname === "/shopify-map") {
      const report = await buildVariantMap(this.agentEnv);
      return new Response(report, { headers: { "content-type": "application/json" } });
    }

    // Customer-contact backfill for already-synced store orders.
    if (url.pathname === "/shopify-contact-backfill") {
      const report = await backfillOrderContacts(this.agentEnv);
      return new Response(report, { headers: { "content-type": "application/json" } });
    }

    // Historical order import: previous collections become archive ledger rows.
    if (url.pathname === "/shopify-archive-import") {
      const report = await importArchiveOrders(this.agentEnv);
      return new Response(report, { headers: { "content-type": "application/json" } });
    }

    // Board notification relay for the API routes. Only "custom" (pre-formatted
    // business events) reaches the board thread; task pings are dropped
    // inside notifyBoardEvent.
    if (url.pathname === "/notify") {
      const body = (await request.json()) as { kind?: string; actor?: string; title?: string; group?: string };
      if (body.kind === "added" || body.kind === "completed" || body.kind === "deleted" || body.kind === "custom") {
        await notifyBoardEvent(this.agentEnv, body.kind, body.actor ?? "", body.title ?? "", body.group);
      }
      return Response.json({ ok: true });
    }

    // A direct phone push (the "בדיקת התראה" button in settings). Bypasses the gate on purpose.
    if (url.pathname === "/push") {
      const body = (await request.json()) as { title?: string; body?: string; url?: string };
      return Response.json({ ok: true, ...(await pushNotify(this.agentEnv, body.title ?? "hob", body.body ?? "", body.url)) });
    }

    if (url.pathname === "/run") {
      const slotParam = url.searchParams.get("slot");
      if (slotParam === "collab") {
        const result = await collabReminders();
        return Response.json({ ok: true, result });
      }
      const slot: Slot = slotParam === "shopify" ? "shopify" : slotParam === "backup" ? "backup" : "brief";
      const result = await this.runSlot(slot);
      await this.ensureAlarm();
      return Response.json(result);
    }

    // Default (/init, /status): make sure the alarm chain is alive.
    await this.ensureAlarm();
    const alarm = await this.state.storage.getAlarm();
    return Response.json({
      ok: true,
      next_alarm: alarm ? new Date(alarm).toISOString() : null,
      last_brief: (await this.state.storage.get<string>("last:brief")) ?? null,
      last_backup: (await this.state.storage.get<string>("last:backup")) ?? null,
      last_shopify: (await this.state.storage.get<string>("last:shopify")) ?? null,
      assistant_last: (await this.state.storage.get<string>("assist:last")) ?? null,
      assistant_log: (await this.state.storage.get<string[]>("assist:log")) ?? [],
      shopify_last: (await this.state.storage.get<string>("shopify:last")) ?? null,
    });
  }

  /** One scheduled job. The brief also wakes the phone (through the gate) and
   *  runs the collab reminders. */
  private async runSlot(slot: Slot): Promise<{ ok: boolean; slot: string; error?: string }> {
    if (slot === "backup") return runBackup(this.agentEnv);
    if (slot === "shopify") return runShopifyWeekly(this.agentEnv);
    const result = await runSummaryAgent(this.agentEnv, slot);
    if (result.ok) {
      if (result.items) {
        await notify(this.agentEnv, { level: "now", topic: "brief", title: result.headline ?? "תדריך הבוקר", body: "הפירוט אצל הובי", url: "/?tab=hobi" }).catch(() => undefined);
      }
      try {
        await collabReminders();
      } catch (error) {
        console.error(`collab reminders failed: ${String(error)}`);
      }
    }
    return result;
  }

  async alarm(): Promise<void> {
    const slot = slotForNow();
    if (slot) {
      const today = ilTodayISO();
      const key = `last:${slot}`;
      const last = await this.state.storage.get<string>(key);
      if (last !== today) {
        const result = await this.runSlot(slot);
        if (result.ok) await this.state.storage.put(key, today);
        else console.error(`scheduled ${slot} failed: ${result.error}`);
      }
    }
    // Reminders ride the same alarm: fire what is due, then wake at the
    // earlier of the next slot and the next pending reminder.
    await fireDueReminders(this.agentEnv);
    // Orders held for merging go out as one alert when the window closes.
    await flushHeldOrders(this.agentEnv).catch(() => 0);
    await this.state.storage.setAlarm(await this.nextWakeEpoch());
  }

  private async nextWakeEpoch(): Promise<number> {
    const slotNext = nextFireEpoch();
    const remNext = await nextReminderEpoch(this.agentEnv.DB);
    const notifyNext = await nextNotifyEpoch(this.agentEnv.DB);
    // Never wake in the past: clamp a stale reminder to "in one minute".
    const floor = Date.now() + 60000;
    const soonest = [remNext, notifyNext].filter((t): t is number => t !== null).reduce((a, b) => Math.min(a, b), slotNext);
    return soonest < slotNext ? Math.max(soonest, floor) : slotNext;
  }

  private async ensureAlarm(): Promise<void> {
    const alarm = await this.state.storage.getAlarm();
    const next = await this.nextWakeEpoch();
    if (alarm === null || next < alarm) await this.state.storage.setAlarm(next);
  }
}
