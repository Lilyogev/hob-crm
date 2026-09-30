import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { freshDb } from "./d1";

// The expense ledger belongs to the finance module (its tables are not in
// 0001_core): the write Hobi calls is stubbed, and the test checks what is
// Hobi's own: hold on voice, one execution per approval, cancel = nothing.
const written: Record<string, unknown>[] = [];
vi.mock("../src/lib/finance.server", async (importOriginal) => {
  const mod = (await importOriginal()) as Record<string, unknown>;
  return {
    ...mod,
    addExpense: async (e: Record<string, unknown>) => {
      written.push(e);
      return { id: written.length, ...e };
    },
    claimPendingReceipt: async () => false,
  };
});

import { confirmPending, handleBoardChat } from "../src/lib/assistant.server";

let db: ReturnType<typeof freshDb>;
const env = () => ({ DB: db as never, ANTHROPIC_API_KEY: "test" });
const expenses = () => written.filter((e) => e.description === "בדיקת קול").length;

// Claude is stubbed: first it asks for log_expense, then it says one sentence.
function stubClaude() {
  let call = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      call++;
      const content =
        call === 1
          ? [{ type: "tool_use", id: "tu_1", name: "log_expense", input: { amount: 450, category: "אחר", description: "בדיקת קול", payer: "avia" } }]
          : [{ type: "text", text: "מחכה לאישור שלך." }];
      return new Response(JSON.stringify({ content, stop_reason: call === 1 ? "tool_use" : "end_turn" }), { status: 200 });
    }),
  );
}

beforeEach(() => {
  db = freshDb();
  written.length = 0;
  stubClaude();
});
afterEach(() => vi.unstubAllGlobals());

test("a spoken money command is held for confirmation, not executed", async () => {
  const res = await handleBoardChat(env(), "רשמי הוצאה 450 שקל", "avia", { voice: true });
  expect(expenses()).toBe(0);
  expect(res.pending).toHaveLength(1);
  expect(res.pending[0].summary).toContain("רישום הוצאה");
  expect(res.pending[0].summary).toContain("450");
  const row = await db.prepare("SELECT actor, status FROM assistant_pending WHERE id = ?").bind(res.pending[0].id).first<{ actor: string; status: string }>();
  expect(row).toEqual({ actor: "avia", status: "pending" });

  // two taps on "approve" run it once
  const id = res.pending[0].id;
  const taps = await Promise.all([confirmPending(env(), id, true), confirmPending(env(), id, true)]);
  expect(expenses()).toBe(1);
  expect(taps.filter((t) => t.status === "done").length).toBeGreaterThanOrEqual(1);
  expect((await confirmPending(env(), id, true)).status).toBe("done"); // replay, still one
  expect(expenses()).toBe(1);
  // the confirmation lands in the thread as Hobi's line
  const last = await db.prepare("SELECT role, content FROM assistant_chat ORDER BY id DESC LIMIT 1").first<{ role: string; content: string }>();
  expect(last?.role).toBe("assistant");
  expect(last?.content).toContain("בוצע");
});

test("cancelling a held command changes nothing, and it cannot be approved afterwards", async () => {
  const res = await handleBoardChat(env(), "רשמי הוצאה 450 שקל", "lior", { voice: true });
  const id = res.pending[0].id;
  expect((await confirmPending(env(), id, false)).status).toBe("cancelled");
  expect((await confirmPending(env(), id, true)).ok).toBe(false);
  expect(expenses()).toBe(0);
});

test("an edit before approval is applied; a bad edit keeps it pending", async () => {
  const res = await handleBoardChat(env(), "רשמי הוצאה 450 שקל", "avia", { voice: true });
  const id = res.pending[0].id;
  expect((await confirmPending(env(), id, true, { amount: "abc" })).status).toBe("pending");
  expect(expenses()).toBe(0);
  const out = await confirmPending(env(), id, true, { amount: "1,200" });
  expect(out.status).toBe("done");
  expect(written[0].amount).toBe(1200);
});

test("the same command typed by hand still runs immediately", async () => {
  const res = await handleBoardChat(env(), "רשמי הוצאה 450 שקל", "avia");
  expect(res.pending).toHaveLength(0);
  expect(expenses()).toBe(1);
});
