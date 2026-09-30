import { createFileRoute } from "@tanstack/react-router";
import { agentStub, db, isAuthed, notifyViaAgent, unauthorized } from "../../lib/hob.server";
import {
  IS_INCOME_SOURCE,
  IS_OPENING_POT,
  IS_PAYER,
  IS_PROVIDER,
  POTS,
  type TrafficSnapshot,
  addExpense,
  addIncome,
  addSettlement,
  categoryStatus,
  deleteBudget,
  deleteExpense,
  deleteIncome,
  deleteScenario,
  deleteSettlement,
  getFinance,
  getTrafficCache,
  saveScenario,
  setBudget,
  setDropCost,
  setExpensePaidFrom,
  setFeeRate,
  setPotOpening,
  setTotalBudget,
  setTrafficCache,
  setVatExempt,
  settlementSuspicion,
} from "../../lib/finance.server";
import { type Partner, isPartner, partnerLabel } from "../../lib/partners";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function bad(): Response {
  return Response.json({ ok: false, code: "bad_request" }, { status: 400 });
}

const num = (v: unknown): number => (typeof v === "number" && isFinite(v) ? v : NaN);
const str = (v: unknown, max = 300): string => (typeof v === "string" ? v.trim().slice(0, max) : "");

/** The partner behind the request, from the session cookie (sessions.user_id →
 *  users.key). Falls back to the body's `actor` only when it names a partner. */
async function actorOf(request: Request, body: Record<string, unknown>): Promise<Partner | ""> {
  const token = (request.headers.get("cookie") ?? "")
    .split(";")
    .map((c) => c.trim())
    .find((c) => c.startsWith("hob_auth="))
    ?.slice("hob_auth=".length);
  if (token && /^[0-9a-f]{64}$/.test(token)) {
    try {
      const row = await db()
        .prepare("SELECT u.key AS key FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ?")
        .bind(token)
        .first<{ key: string }>();
      if (row && isPartner(row.key)) return row.key;
    } catch {
      // an older session row without a user: fall through
    }
  }
  return isPartner(body.actor) ? body.actor : "";
}

export const Route = createFileRoute("/api/finance")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        if (!(await isAuthed(request))) return unauthorized();
        return Response.json({ ok: true, ...(await getFinance()) });
      },
      POST: async ({ request }) => {
        if (!(await isAuthed(request))) return unauthorized();
        let body: Record<string, unknown>;
        try {
          body = (await request.json()) as Record<string, unknown>;
        } catch {
          return bad();
        }
        const op = body.op;
        const actor = await actorOf(request, body);
        const who = actor ? partnerLabel(actor) : "מישהי";

        if (op === "add_expense") {
          const date = DATE_RE.test(str(body.date)) ? str(body.date) : "";
          const payer = IS_PAYER(body.payer) ? body.payer : "business";
          const category = str(body.category, 60);
          const description = str(body.description);
          const amount = num(body.amount);
          const paidFrom = typeof body.paidFrom === "string" && POTS.has(body.paidFrom) ? body.paidFrom : "";
          if (!date || !category || Number.isNaN(amount) || amount === 0) return bad();
          const expense = await addExpense({ date, payer, category, description, amount, paidFrom, createdBy: actor });
          if (body.silent !== true) {
            let msg = `💸 ${who} רשמה הוצאה: ${category} — ${Math.round(amount).toLocaleString("en-US")} ₪${description ? ` (${description})` : ""}`;
            const st = await categoryStatus(category);
            if (st.budget > 0 && st.spent / st.budget >= 0.9) {
              msg += `\n⚠️ "${category}" הגיעה ל-${Math.round((st.spent / st.budget) * 100)}% מהתקציב (${Math.round(st.spent).toLocaleString("en-US")} מתוך ${Math.round(st.budget).toLocaleString("en-US")} ₪) — שווה לעצור ולדבר.`;
            }
            await notifyViaAgent("custom", actor, msg);
          }
          return Response.json({ ok: true, expense });
        }

        if (op === "delete_expense") {
          const id = num(body.id);
          if (!id) return bad();
          await deleteExpense(id);
          return Response.json({ ok: true });
        }

        if (op === "set_expense_paid_from") {
          const id = num(body.id);
          const paidFrom = typeof body.paidFrom === "string" && POTS.has(body.paidFrom) ? body.paidFrom : "";
          if (!id) return bad();
          await setExpensePaidFrom(id, paidFrom);
          return Response.json({ ok: true });
        }

        // הכנסה ידנית: מה שספר המכירות לא מכיר (סיטונאי, יום פופ-אפ, אחר).
        if (op === "add_income") {
          const date = DATE_RE.test(str(body.date)) ? str(body.date) : "";
          const amount = num(body.amount);
          const source = IS_INCOME_SOURCE(body.source) ? body.source : "";
          const handledBy = isPartner(body.handledBy) ? body.handledBy : "";
          const note = str(body.note);
          if (!date || Number.isNaN(amount) || amount <= 0) return bad();
          const income = await addIncome({ date, amount, source, handledBy, note, createdBy: actor });
          if (body.silent !== true) {
            await notifyViaAgent("custom", actor, `💰 ${who} רשמה הכנסה: ${Math.round(amount).toLocaleString("en-US")} ₪${note ? ` (${note})` : ""}`);
          }
          return Response.json({ ok: true, income });
        }

        if (op === "delete_income") {
          const id = num(body.id);
          if (!id) return bad();
          await deleteIncome(id);
          return Response.json({ ok: true });
        }

        // Reconciliation helper: what the store actually charged (after
        // discount codes, including shipping) versus the catalogue prices in
        // the ledger. Served by the Durable Object, the only Shopify caller.
        if (op === "charged") {
          const since = DATE_RE.test(str(body.since)) ? str(body.since) : "";
          const until = DATE_RE.test(str(body.until)) ? str(body.until) : "";
          if (!since || !until) return bad();
          const stub = agentStub();
          if (!stub) return Response.json({ ok: false, code: "no_agent" }, { status: 503 });
          const res = await stub.fetch(`https://do/shopify-charged?since=${since}T00:00:00Z&until=${until}T23:59:59Z`);
          return Response.json({ ok: true, ...((await res.json()) as Record<string, unknown>) });
        }

        if (op === "shopifyql") {
          const q = typeof body.query === "string" ? body.query : "";
          if (!q) return bad();
          const stub = agentStub();
          if (!stub) return Response.json({ ok: false, code: "no_agent" }, { status: 503 });
          const res = await stub.fetch(`https://do/shopify-ql?q=${encodeURIComponent(q)}`);
          return Response.json({ ok: true, ...((await res.json()) as Record<string, unknown>) });
        }

        if (op === "product_titles") {
          const stub = agentStub();
          if (!stub) return Response.json({ ok: false, code: "no_agent" }, { status: 503 });
          const res = await stub.fetch("https://do/shopify-product-titles");
          return Response.json({ ok: true, ...((await res.json()) as Record<string, unknown>) });
        }

        if (op === "add_settlement") {
          const date = DATE_RE.test(str(body.date)) ? str(body.date) : "";
          const provider = typeof body.provider === "string" && IS_PROVIDER(body.provider) ? body.provider : null;
          const net = num(body.net);
          // 0 / missing means "close everything still open at this provider".
          const gross = num(body.gross) > 0 ? num(body.gross) : 0;
          const note = str(body.note, 200);
          if (!date || !provider || Number.isNaN(net) || net <= 0) return bad();
          // חשד לכפילות: לא נרשם עד שמאשרות במפורש (confirm: true) במסך.
          const reasons = await settlementSuspicion({ date, provider, net, gross });
          if (reasons.length && body.confirm !== true) return Response.json({ ok: true, saved: false, suspect: true, reasons });
          const settlement = await addSettlement({ date, provider, net, gross, note, actor, reason: reasons.length ? `אושר למרות חשד: ${reasons.join(" · ")}` : "" });
          if (body.silent !== true) {
            const fee = settlement.gross - settlement.net;
            let msg = `🏦 ${who} רשמה זיכוי משופיפיי: ${Math.round(settlement.net).toLocaleString("en-US")} ₪ נכנסו לבנק`;
            if (settlement.gross > 0) {
              msg += `\nסגר מכירות בברוטו ${Math.round(settlement.gross).toLocaleString("en-US")} ₪ · עמלה ${Math.round(fee).toLocaleString("en-US")} ₪ (${((fee / settlement.gross) * 100).toFixed(2)}%)`;
            }
            await notifyViaAgent("custom", actor, msg);
          }
          return Response.json({ ok: true, settlement });
        }

        if (op === "delete_settlement") {
          const id = num(body.id);
          if (!id) return bad();
          await deleteSettlement(id, actor);
          return Response.json({ ok: true });
        }

        // יתרת פתיחה לבנק / ביט / מזומן: מה שהיה לפני שהלוח התחיל לעקוב.
        if (op === "set_pot_opening") {
          const amount = num(body.amount);
          if (!IS_OPENING_POT(body.pot) || Number.isNaN(amount)) return bad();
          await setPotOpening(body.pot, amount);
          return Response.json({ ok: true });
        }

        if (op === "set_fee_rate") {
          const provider = typeof body.provider === "string" && IS_PROVIDER(body.provider) ? body.provider : null;
          // Sent as a percent from the UI (2.4), stored as a fraction.
          const pct = num(body.percent);
          if (!provider || Number.isNaN(pct) || pct < 0 || pct >= 50) return bad();
          await setFeeRate(provider, pct / 100);
          return Response.json({ ok: true });
        }

        if (op === "set_vat_exempt") {
          if (typeof body.exempt !== "boolean") return bad();
          await setVatExempt(body.exempt);
          return Response.json({ ok: true });
        }

        // עלות ייצור לקולקציה (settings.drop_costs): המפתח הוא שם הקולקציה כפי שהוא במלאי.
        if (op === "set_drop_cost") {
          const collection = str(body.collection, 60);
          const amount = num(body.amount);
          if (!collection || Number.isNaN(amount) || amount < 0) return bad();
          await setDropCost(collection, amount);
          return Response.json({ ok: true });
        }

        // 0 = אין תקציב (המסך מציג "הגדירו תקציב").
        if (op === "set_total_budget") {
          const amount = num(body.amount);
          if (Number.isNaN(amount) || amount < 0) return bad();
          await setTotalBudget(amount);
          return Response.json({ ok: true });
        }

        if (op === "set_budget") {
          const category = str(body.category, 60);
          const amount = num(body.amount);
          if (!category || Number.isNaN(amount) || amount < 0) return bad();
          await setBudget(category, amount);
          return Response.json({ ok: true });
        }

        if (op === "delete_budget") {
          const category = str(body.category, 60);
          if (!category) return bad();
          await deleteBudget(category);
          return Response.json({ ok: true });
        }

        if (op === "traffic") {
          // Serve from the shared cache; refresh through the DO (the only
          // context allowed to reach Shopify) at most every 45 minutes.
          const MAX_AGE = 45 * 60 * 1000;
          const cached = await getTrafficCache();
          if (cached && Date.now() - cached.ts < MAX_AGE) {
            return Response.json({ ok: true, traffic: cached });
          }
          const stub = agentStub();
          if (stub) {
            try {
              const res = await stub.fetch("https://do/traffic-stats");
              const fresh = (await res.json()) as { t7: TrafficSnapshot["t7"]; t14: TrafficSnapshot["t14"] };
              if (fresh && (fresh.t7 || fresh.t14)) {
                const snapshot = { ts: Date.now(), t7: fresh.t7, t14: fresh.t14 };
                await setTrafficCache(snapshot);
                return Response.json({ ok: true, traffic: snapshot });
              }
            } catch {
              // fall through to whatever we had
            }
          }
          return Response.json({ ok: true, traffic: cached });
        }

        if (op === "save_scenario") {
          const name = str(body.name, 60);
          // `data` is the simulator's own DropSim JSON, stored verbatim, capped
          // so a runaway client cannot stuff the row.
          const data = typeof body.data === "string" ? body.data : "";
          if (!name || !data || data.length > 20000) return bad();
          try {
            JSON.parse(data);
          } catch {
            return bad();
          }
          await saveScenario(name, data);
          return Response.json({ ok: true });
        }

        if (op === "delete_scenario") {
          const name = str(body.name, 60);
          if (!name) return bad();
          await deleteScenario(name);
          return Response.json({ ok: true });
        }

        return bad();
      },
    },
  },
});
