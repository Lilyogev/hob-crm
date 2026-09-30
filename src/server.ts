import "./lib/error-capture";

import { dueMonthReview, monthLabel, writeMonthReview } from "./lib/plan.server";
import type { D1Database, DurableObjectState, R2Bucket } from "@cloudflare/workers-types";

import { collabReminders } from "./lib/collab.server";
import { deliveryReminders } from "./lib/delivery.server";
import { consumeLastCapturedError } from "./lib/error-capture";
import { renderErrorPage } from "./lib/error-page";
import { applySecurityHeaders } from "./lib/security-headers.server";
import { confirmPending, handleBoardChat, handleBoardReceipt, recentBoardHistory, type LiveStep } from "./lib/assistant.server";
import { mergeQuick, quickReply, type QuickStored } from "./lib/assistant.quick.server";
import { thinkAboutConcept } from "./lib/studio.think.server";
import { synthesize } from "./lib/tts.server";
import { answerDecision } from "./lib/team.answer.server";
import { markConn } from "./lib/conn.server";
import type { ConceptRow } from "./lib/studio.server";
import { runBackup } from "./lib/backup.server";
import { fireDueReminders, nextReminderEpoch } from "./lib/reminders.server";
import { flushHeldOrders, nextNotifyEpoch, notify } from "./lib/notify.server";
import { pushNotify } from "./lib/push.server";
import { approveJob, drainRecipes, nextRecipeEpoch } from "./lib/recipes.server";
import { nextTeamEventEpoch, runAgent, runDueAgents, runPendingEvents, weeklyReview, workerScreen } from "./lib/team.server";
import type { TraceView } from "./lib/team.trace.server";
import { dailyQuota } from "./lib/team.browse.server";
import {
  backfillOrderContacts,
  buildVariantMap,
  drainShopifyPushQueue,
  importArchiveOrders,
  runShopifyWeekly, shopifyCharged, shopifyProductTitles, shopifyQL, shopifyTraffic, createCollabDiscount, deleteCollabDiscount, combineCollabDiscount, setCollabDiscountActive } from "./lib/shopify.server";
import { handleShopifyOrder, type ShopifyOrderPayload } from "./lib/shopify-sync.server";
import {
  ilOffsetMs,
  ilTodayISO,
  nextFireEpoch,
  notifyBoardEvent,
  runSummaryAgent,
  slotForNow,
  type Slot,
} from "./lib/summary.server";

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
// {"unhandled":true,"message":"HTTPError"} — try/catch alone never fires for those.
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

// The Segula summary agent: a singleton Durable Object whose alarm wakes on
// the brief mornings, builds the board summary, and posts it to the partners'
// Bruno thread in the board (see src/lib/summary.server.ts). The alarm chain
// is self-perpetuating; /api/agent/* routes reach it via env.ROOMS.
type AgentBindings = {
  DB?: D1Database;
  ANTHROPIC_API_KEY?: string;
  SHOPIFY_CLIENT_ID?: string;
  SHOPIFY_CLIENT_SECRET?: string;
  META_ADS_TOKEN?: string;
  VAPID_PRIVATE_JWK?: string;
  ELEVENLABS_API_KEY?: string;
  KLAVIYO_API_KEY?: string;
  // דפדפן אמיתי לעובדי המחקר (Browser Rendering) והדלי שבו הצילומים למסך העובד נשמרים.
  BROWSER?: { fetch: typeof fetch };
  STORAGE?: R2Bucket;
};

export class SummaryAgent {
  private state: DurableObjectState;
  private agentEnv: AgentBindings;
  // מצב ברונו: הצעדים החיים של כל תור (לפי מזהה מהדפדפן). בזיכרון של ה-DO בלבד: הם
  // רלוונטיים רק בזמן שהתור רץ, ובקשת ה"מה קורה" מגיעה לאותו אובייקט בזמן שהתור ממתין.
  private liveSteps = new Map<string, { steps: LiveStep[]; at: number; done: boolean; quick?: QuickStored }>();
  // מסך העובד: מה כל עובד עושה עכשיו (הצעדים של הריצה שרצה). אותו אובייקט שהריצה
  // מעדכנת במקום; אחרי הסיום המסך עובר ל-D1 (team_run_steps), וכאן זה נמחק אחרי 10 דקות.
  private workerLive = new Map<string, { view: TraceView; at: number }>();
  private readonly onWorkerStep = (v: TraceView) => {
    this.workerLive.set(v.worker, { view: v, at: Date.now() });
  };
  // The live video of the page a worker is browsing: only the latest frame, in memory.
  private workerFrame = new Map<string, { b64: string; url: string; at: number }>();
  private readonly onWorkerFrame = (worker: string, b64: string, url: string) => {
    this.workerFrame.set(worker, { b64, url, at: Date.now() });
  };

  constructor(state: DurableObjectState, env: unknown) {
    this.state = state;
    // A child of the real env (bindings stay reachable through the prototype) with the
    // worker-screen hook: runs started from Bruno's chat (delegate), queued events and
    // answers on this object show live on the worker screen like a direct run.
    const withScreen = Object.create(env as object) as AgentBindings & { onWorkerStep?: (v: TraceView) => void; onWorkerFrame?: (w: string, b64: string, url: string) => void };
    withScreen.onWorkerStep = this.onWorkerStep;
    withScreen.onWorkerFrame = this.onWorkerFrame;
    this.agentEnv = withScreen;
  }

  /**
   * The black box. One line per update, last ten kept — a single "last"
   * entry kept getting overwritten by the next message, which is how a
   * receipt that HAD arrived looked like it never did.
   */
  private async recordAssist(result: string): Promise<void> {
    const line = `${new Date().toISOString()} ${result}`;
    await this.state.storage.put("assist:last", line);
    const log = (await this.state.storage.get<string[]>("assist:log")) ?? [];
    log.push(line);
    await this.state.storage.put("assist:log", log.slice(-10));
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    // The in-board Bruno chat (the "ברונו" tab). Runs in the DO because
    // outbound fetch (Anthropic) is blocked in route handlers. Auth happened
    // in /api/assistant/chat before the relay.
    if (url.pathname === "/board-chat") {
      const { text, actor, voice, live, lang, turn } = (await request.json()) as { text?: string; actor?: string; voice?: boolean; live?: boolean; lang?: string; turn?: string };
      if (!text || typeof text !== "string") {
        return Response.json({ ok: false, code: "bad_request" }, { status: 400 });
      }
      const turnId = typeof turn === "string" && /^[\w-]{8,64}$/.test(turn) ? turn : "";
      if (turnId) {
        // ניקוי תורות ישנים (מעל 10 דקות)
        for (const [k, v] of this.liveSteps) if (Date.now() - v.at > 600_000) this.liveSteps.delete(k);
        this.liveSteps.set(turnId, { steps: [], at: Date.now(), done: false });
        // שתי מהירויות: תשובה מיידית (Haiku, בלי כלים) רצה במקביל לתשובה העמוקה ונכנסת
        // לרשומת התור ברגע שהיא מוכנה. אם העמוקה הקדימה אותה, היא נזרקת (mergeQuick).
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
      const { answer, status, pending, trace } = await handleBoardChat(this.agentEnv, text, typeof actor === "string" ? actor : "", { voice: voice === true, live: live === true, lang: lang === "en" ? "en" : "he", onStep });
      if (turnId) {
        const rec = this.liveSteps.get(turnId);
        if (rec) rec.done = true;
      }
      await this.recordAssist(status);
      // A chat message may have just created a reminder — pull the alarm
      // earlier if that reminder is due before the next scheduled slot.
      await this.ensureAlarm();
      // ...או התחיל עבודה של מתכון: היא רצה ב-alarm (עד 15 דקות), לא בתוך הבקשה.
      await this.kickRecipes();
      return Response.json({ ok: true, answer, pending: pending ?? [], trace });
    }

    // אישור של עבודת מתכון מ"מחכה לך" (האימות נעשה ב-/api/team). הכתיבה החוצה רצה ב-alarm.
    if (url.pathname === "/recipe-approve") {
      const { id } = (await request.json()) as { id?: number };
      const out = typeof id === "number" && this.agentEnv.DB ? await approveJob(this.agentEnv.DB, id) : { ok: false, error: "bad_request" };
      if (out.ok) await this.kickRecipes();
      return Response.json(out);
    }

    // מסך העובד: הצעדים החיים אם הוא רץ עכשיו, ותמיד הריצה האחרונה והבאה מ-D1.
    // One live frame (JPEG) of the page the worker is on; 204 when he is not browsing now.
    if (url.pathname === "/worker-frame") {
      const f = this.workerFrame.get(url.searchParams.get("worker") ?? "");
      if (!f || Date.now() - f.at > 15_000) return new Response(null, { status: 204 });
      const bin = atob(f.b64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      return new Response(bytes, { headers: { "content-type": "image/jpeg", "cache-control": "no-store", "x-frame-url": encodeURIComponent(f.url), "x-frame-at": String(f.at) } });
    }
    if (url.pathname === "/worker-screen") {
      const worker = url.searchParams.get("worker") ?? "";
      for (const [k, v] of this.workerLive) if (v.view.done && Date.now() - v.at > 600_000) this.workerLive.delete(k);
      const stored = this.agentEnv.DB ? await workerScreen(this.agentEnv.DB, worker).catch(() => null) : null;
      if (!stored) return Response.json({ ok: false, code: "unknown_worker" }, { status: 404 });
      const live = this.workerLive.get(worker)?.view;
      const running = Boolean(live && !live.done);
      const quota = this.agentEnv.DB ? await dailyQuota(this.agentEnv.DB).catch(() => null) : null;
      const frame = this.workerFrame.get(worker);
      return Response.json({ ok: true, ...stored, running, frameAt: frame && Date.now() - frame.at < 15_000 ? frame.at : null, live: running && live ? live.steps : null, steps: running && live ? live.steps : stored.steps, startedAt: running && live ? live.startedAt : stored.startedAt, quota: quota ? { usedS: quota.usedS, capS: quota.capS } : null });
    }

    // מצב ברונו: "מה ברונו עושה עכשיו" לתור שרץ.
    if (url.pathname === "/live-steps") {
      const rec = this.liveSteps.get(url.searchParams.get("turn") ?? "");
      return Response.json({ ok: true, steps: rec?.steps ?? [], done: rec?.done ?? false, quick: rec?.quick ?? null });
    }

    // הקול של מצב ברונו (ElevenLabs). 204 = אין קול, הלקוח חוזר לקול של הדפדפן.
    if (url.pathname === "/board-tts") {
      const { text, lang } = (await request.json()) as { text?: string; lang?: string };
      const audio = await synthesize(this.agentEnv.ELEVENLABS_API_KEY, typeof text === "string" ? text : "", lang === "en" ? "en" : "he");
      // בריאות הקול לשומר: רק כשיש מפתח (בלי מפתח זה הגיבוי המכוון, לא תקלה).
      if (this.agentEnv.ELEVENLABS_API_KEY && typeof text === "string" && text.trim()) await markConn(this.agentEnv.DB, "elevenlabs", audio ? undefined : "הקול לא נוצר (מכסה, מפתח או תקלה). ברונו עבר לקול של המכשיר");
      return audio ?? new Response(null, { status: 204 });
    }

    // אישור או ביטול של פעולה שמחכה (פקודה קולית שמשנה כסף/מלאי/משלוח).
    if (url.pathname === "/board-confirm") {
      const { id, approve, edits } = (await request.json()) as { id?: number; approve?: boolean; edits?: Record<string, unknown> };
      const result = await confirmPending(this.agentEnv, typeof id === "number" ? id : 0, approve === true, edits && typeof edits === "object" ? edits : undefined);
      await this.recordAssist(`confirm ${id}: ${result.status}`);
      await this.ensureAlarm();
      return Response.json(result);
    }

    // A receipt photo from the board chat (the 📷 button). Raw image bytes in
    // the body; mime + actor ride the query string. Auth happened in the
    // route before the relay.
    // Bruno reads a studio concept (row relayed from /api/studio op "think",
    // auth done there) and answers with slogans, music, labels, critique.
    if (url.pathname === "/studio-think") {
      const { concept } = (await request.json()) as { concept?: ConceptRow };
      if (!concept || typeof concept !== "object") {
        return Response.json({ ok: false, code: "bad_request" }, { status: 400 });
      }
      const result = await thinkAboutConcept(this.agentEnv, concept);
      await this.recordAssist(result.ok ? `studio think: ${concept.title}` : `studio think error: ${result.error}`);
      return Response.json(result);
    }

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
    // (HMAC already verified there). Logs the sale into the board's inventory
    // ledger and notifies the partners in the board thread.
    if (url.pathname === "/shopify-order") {
      const order = (await request.json()) as ShopifyOrderPayload;
      let result: string;
      try {
        result = await handleShopifyOrder(this.agentEnv, order);
      } catch (error) {
        result = `error: ${String(error).slice(0, 300)}`;
      }
      await this.state.storage.put("shopify:last", `${new Date().toISOString()} ${result}`);
      // הזמנה חדשה = התראה מיידית לטלפון, ועידו (כובע החנות) רץ מיד: מלאי,
      // מה לארוז, ומה עוד מחכה. לא מחכים ל-08:00 של מחר.
      if (!result.startsWith("duplicate") && !result.startsWith("error")) {
        const who = [order.customer?.first_name, order.customer?.last_name].filter(Boolean).join(" ") || "לקוח";
        const items = (order.line_items ?? []).map((li) => `${li.title ?? ""}${li.variant_title ? ` ${li.variant_title}` : ""}`).join(", ").slice(0, 160);
        await notify(this.agentEnv, { level: "now", topic: "order", isOrder: true, title: `💸 הזמנה חדשה ${order.name ?? ""} · ${Math.round(parseFloat(order.total_price ?? "0"))} ₪`, body: `${who}: ${items}`, url: "/?tab=seeding" });
        await this.ensureAlarm();
        this.state.waitUntil(
          runAgent(this.agentEnv, "shop", { trigger: "event", onStep: this.onWorkerStep })
            .catch(() => undefined)
            // אם האירוע נרשם כממתין, ה-alarm צריך להתעורר בשבילו.
            .then(() => this.ensureAlarm()),
        );
      }
      return Response.json({ ok: true, result });
    }

    // Outbound Shopify stock push: routes queue deltas in D1 and poke this
    // path; the actual GraphQL calls run here because only the DO has egress.
    // Live store traffic for the finance tab. Shopify egress only works from
    // the DO; the finance route caches this in D1 so tab polling never
    // hammers ShopifyQL.
    if (url.pathname === "/traffic-stats") {
      const t7 = await shopifyTraffic(this.agentEnv, 7);
      const t14 = await shopifyTraffic(this.agentEnv, 14);
      return Response.json({ t7, t14 });
    }

    // What the store actually charged per day — the figure a clearer's deposit
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

    if (url.pathname === "/shopify-push-drain") {
      const result = await drainShopifyPushQueue(this.agentEnv);
      return Response.json({ ok: true, ...result });
    }

    // Remove a collab code from the store (deleted link / test cleanup).
    if (url.pathname === "/collab-discount-delete") {
      const body = (await request.json()) as { code?: string };
      const result = await deleteCollabDiscount(this.agentEnv, body.code ?? "");
      return Response.json(result);
    }

    // Close (or reopen) a collab code without deleting it.
    if (url.pathname === "/collab-discount-active") {
      const body = (await request.json()) as { code?: string; active?: boolean };
      const result = await setCollabDiscountActive(
        this.agentEnv,
        body.code ?? "",
        body.active === true,
      );
      return Response.json(result);
    }

    // Let an existing collab code combine with the store's automatic
    // discounts (repair for codes minted before 24.9).
    if (url.pathname === "/collab-discount-combine") {
      const body = (await request.json()) as { code?: string };
      const result = await combineCollabDiscount(this.agentEnv, body.code ?? "");
      return Response.json(result);
    }

    // Create a collab influencer's personal discount code (egress-only work).
    if (url.pathname === "/collab-discount") {
      const body = (await request.json()) as { code?: string; pct?: number };
      const result = await createCollabDiscount(
        this.agentEnv,
        body.code ?? "",
        typeof body.pct === "number" ? body.pct : 0.1,
      );
      return Response.json(result);
    }

    // Build/refresh the item↔variant map (also reachable through Bruno's
    // shopify_map tool; this path lets the authed seeding API trigger it).
    if (url.pathname === "/shopify-map") {
      const report = await buildVariantMap(this.agentEnv);
      return new Response(report, { headers: { "content-type": "application/json" } });
    }

    // One-time customer-contact backfill for already-synced store orders
    // (triggered via the authed seeding API; Shopify egress only works here).
    if (url.pathname === "/shopify-contact-backfill") {
      const report = await backfillOrderContacts(this.agentEnv);
      return new Response(report, { headers: { "content-type": "application/json" } });
    }

    // Historical order import — previous drops become archive ledger rows.
    if (url.pathname === "/shopify-archive-import") {
      const report = await importArchiveOrders(this.agentEnv);
      return new Response(report, { headers: { "content-type": "application/json" } });
    }

    // Board notification relay for the API routes. Only "custom" (pre-formatted
    // business events) reaches the board thread now; task add/done/delete
    // pings were Telegram-only and are dropped inside notifyBoardEvent.
    if (url.pathname === "/notify") {
      const body = (await request.json()) as {
        kind?: string;
        actor?: string;
        title?: string;
        group?: string;
      };
      if (
        body.kind === "added" ||
        body.kind === "completed" ||
        body.kind === "deleted" ||
        body.kind === "custom"
      ) {
        await notifyBoardEvent(
          this.agentEnv,
          body.kind,
          body.actor ?? "",
          body.title ?? "",
          body.group,
        );
      }
      return Response.json({ ok: true });
    }

    // הצוות של ברונו: ריצה ידנית של סוכן, או משימה ישירה ("ברונו, תבדוק X").
    // רץ כאן כי רק ל-DO יש egress ל-Anthropic ולמטא. Auth ב-/api/team.
    if (url.pathname === "/push") {
      const body = (await request.json()) as { title?: string; body?: string; url?: string };
      return Response.json({ ok: true, ...(await pushNotify(this.agentEnv, body.title ?? "SEGULA", body.body ?? "", body.url)) });
    }

    if (url.pathname === "/team-review") {
      return Response.json(await weeklyReview(this.agentEnv));
    }

    // יוגב ענה על הכרעה במילים שלו: מבינים מה נאמר (בחירה / שאלה / מידע / בוצע) ופועלים.
    if (url.pathname === "/team-answer") {
      const body = (await request.json()) as { id?: number; note?: string };
      const result = await answerDecision(this.agentEnv, typeof body.id === "number" ? body.id : 0, typeof body.note === "string" ? body.note : "");
      await this.recordAssist(`team answer #${body.id}: ${result.kind ?? result.error}`);
      await this.ensureAlarm().catch(() => undefined);
      return Response.json(result);
    }

    if (url.pathname === "/team-run") {
      const body = (await request.json()) as { agent?: string; command?: string; research?: boolean; images?: { mime?: string; b64?: string; label?: string }[] };
      const command = typeof body.command === "string" ? body.command.trim().slice(0, 6000) : "";
      // "עזרי לי לסיים": פריימים שהדפדפן חילץ מהסרטון של יוגב. עד 12, JPEG בלבד.
      const images = (Array.isArray(body.images) ? body.images : [])
        .filter((im) => im && im.mime === "image/jpeg" && typeof im.b64 === "string" && im.b64.length < 450_000)
        .slice(0, 12)
        .map((im, i) => ({ mime: "image/jpeg", b64: im.b64 as string, label: String(im.label ?? `פריים ${i + 1}`).slice(0, 60) }));
      const result = await runAgent(this.agentEnv, body.agent ?? "", {
        trigger: command ? "command" : "manual",
        command: command || undefined,
        research: command ? undefined : body.research === true,
        images: images.length ? images : undefined,
        onStep: this.onWorkerStep,
      });
      await this.recordAssist(`team ${body.agent}: ${result.ok ? `ok ${result.decisions}` : result.error}`);
      // העברה דחופה נרשמת כאירוע ממתין לנמען: לוודא שה-DO יתעורר בזמן להריץ אותו.
      await this.ensureAlarm().catch(() => undefined);
      return Response.json(result);
    }

    if (url.pathname === "/run") {
      const slotParam = url.searchParams.get("slot");
      if (slotParam === "collab") {
        const result = await collabReminders();
        return Response.json({ ok: true, result });
      }
      if (slotParam === "delivery") {
        const result = await deliveryReminders();
        return Response.json({ ok: true, result });
      }
      const slot: Slot =
        slotParam === "brief"
          ? "brief"
          : slotParam === "evening"
          ? "evening"
          : slotParam === "weekly"
            ? "weekly"
            : slotParam === "shopify"
              ? "shopify"
              : slotParam === "backup"
                ? "backup"
                : slotParam === "move"
                  ? "move"
                  : "morning";
      const result =
        slot === "shopify"
          ? await runShopifyWeekly(this.agentEnv)
          : slot === "backup"
            ? await runBackup(this.agentEnv)
            : await runSummaryAgent(this.agentEnv, slot);
      await this.ensureAlarm();
      return Response.json(result);
    }

    // Default (/init, /status): make sure the alarm chain is alive.
    await this.ensureAlarm();
    const alarm = await this.state.storage.getAlarm();
    const lastMorning = await this.state.storage.get<string>("last:morning");
    const lastEvening = await this.state.storage.get<string>("last:evening");
    const assistLast = await this.state.storage.get<string>("assist:last");
    const shopifyLast = await this.state.storage.get<string>("shopify:last");
    return Response.json({
      ok: true,
      next_alarm: alarm ? new Date(alarm).toISOString() : null,
      last_morning: lastMorning ?? null,
      last_evening: lastEvening ?? null,
      assistant_last: assistLast ?? null,
      assistant_log: (await this.state.storage.get<string[]>("assist:log")) ?? [],
      shopify_last: shopifyLast ?? null,
    });
  }

  async alarm(): Promise<void> {
    // תוכנית: כשחודש נגמר, ברונו כותב עליו סיכום (פעם אחת), ושם אותו בשרשור ובטאב התוכנית.
    try {
      const db = this.agentEnv.DB;
      const due = db ? await dueMonthReview(db) : null;
      if (db && due) {
        const r = await writeMonthReview(this.agentEnv, due);
        if (r.ok && r.text) {
          await db.prepare("INSERT INTO assistant_chat (chat_id, role, content, kind) VALUES (1, 'assistant', ?, 'note')").bind(`🎯 סיכום ${monthLabel(due)} בתוכנית\n\n${r.text}`.slice(0, 3000)).run();
          await notify(this.agentEnv, { level: "morning", topic: "plan_review", title: `🎯 סיכום ${monthLabel(due)} בתוכנית מוכן`, body: r.text.split("\n")[0].slice(0, 140), url: "/?tab=plan" });
        }
      }
    } catch (error) {
      console.error(`plan review failed: ${String(error)}`);
    }
    const slot = slotForNow();
    if (slot) {
      const today = ilTodayISO();
      const key = `last:${slot}`;
      const last = await this.state.storage.get<string>(key);
      if (last !== today) {
        const result =
          slot === "shopify"
            ? await runShopifyWeekly(this.agentEnv)
            : slot === "backup"
              ? await runBackup(this.agentEnv)
              : await runSummaryAgent(this.agentEnv, slot);
        if (result.ok) await this.state.storage.put(key, today);
        // חמישי 18:00, אחרי דוח המספרים: הסיכום השבועי של ברונו על הצוות.
        if (slot === "shopify") {
          try {
            await weeklyReview(this.agentEnv);
          } catch (error) {
            console.error(`weekly review failed: ${String(error)}`);
          }
        }
        else console.error(`summary agent ${slot} failed: ${result.error}`);
        // Collab-pilot reminders ride the brief mornings (Sun/Tue/Thu).
        if (slot === "brief" && result.ok) {
          try {
            await collabReminders();
          } catch (error) {
            console.error(`collab reminders failed: ${String(error)}`);
          }
          try {
            await deliveryReminders();
          } catch (error) {
            console.error(`delivery reminders failed: ${String(error)}`);
          }
        }
      }
    }
    // Personal reminders ride the same alarm: fire what's due, then wake at
    // the earlier of the next slot and the next pending reminder.
    await fireDueReminders(this.agentEnv);
    // עבודות של מתכונים (ברונו התחיל, או יוגב אישר). ה-alarm נותן להן עד 15 דקות.
    await drainRecipes(this.agentEnv).catch((error) => console.error(`recipes failed: ${String(error)}`));
    // אירועים שנרשמו כממתינים (הגיעו בזמן ריצה או מיד אחריה) מעובדים עכשיו.
    await runPendingEvents(this.agentEnv).catch((error) => console.error(`pending events failed: ${String(error)}`));
    // הזמנות שהוחזקו לאיחוד יוצאות כהתראה אחת כשהחלון נסגר.
    await flushHeldOrders(this.agentEnv).catch(() => 0);
    // הצוות רוכב על אותה השכמה: כל סוכן שהיום יום ריצה שלו ועוד לא רץ.
    try {
      const il = new Date(Date.now() + ilOffsetMs());
      await runDueAgents(this.agentEnv, il.getUTCHours(), il.getUTCDay(), this.onWorkerStep);
    } catch (error) {
      console.error(`team agents failed: ${String(error)}`);
    }
    await this.state.storage.setAlarm(await this.nextWakeEpoch());
  }

  private async nextWakeEpoch(): Promise<number> {
    const slotNext = nextFireEpoch();
    const remNext = await nextReminderEpoch(this.agentEnv.DB);
    const notifyNext = await nextNotifyEpoch(this.agentEnv.DB);
    const eventsNext = await nextTeamEventEpoch(this.agentEnv.DB);
    const recipesNext = await nextRecipeEpoch(this.agentEnv.DB);
    // Never wake in the past — clamp a stale reminder to "in one minute".
    const floor = Date.now() + 60000;
    const soonest = [remNext, notifyNext, eventsNext, recipesNext].filter((t): t is number => t !== null).reduce((a, b) => Math.min(a, b), slotNext);
    return soonest < slotNext ? Math.max(soonest, floor) : slotNext;
  }

  /** עבודה חדשה או מאושרת: ה-alarm מתעורר בעוד שתי שניות במקום לחכות לדקה. */
  private async kickRecipes(): Promise<void> {
    const row = await this.agentEnv.DB?.prepare("SELECT COUNT(*) AS n FROM recipe_jobs WHERE status IN ('queued','approved')").first<{ n: number }>().catch(() => null);
    if (!row?.n) return;
    const soon = Date.now() + 2000;
    const alarm = await this.state.storage.getAlarm();
    if (alarm === null || alarm > soon) await this.state.storage.setAlarm(soon);
  }

  private async ensureAlarm(): Promise<void> {
    const alarm = await this.state.storage.getAlarm();
    const next = await this.nextWakeEpoch();
    if (alarm === null || next < alarm) await this.state.storage.setAlarm(next);
  }
}
