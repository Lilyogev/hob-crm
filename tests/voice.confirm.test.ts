import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { freshDb } from "./d1";
import { confirmPending, handleBoardChat } from "../src/lib/assistant.server";

let db: ReturnType<typeof freshDb>;
const env = () => ({ DB: db as never, ANTHROPIC_API_KEY: "test" });
const expenses = async () => (await db.prepare("SELECT COUNT(*) AS n FROM fin_expenses WHERE description = 'בדיקת קול'").first<{ n: number }>())?.n ?? -1;

// Claude is stubbed: first it asks for log_expense, then it says one sentence.
function stubClaude() {
  let call = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      call++;
      const content =
        call === 1
          ? [{ type: "tool_use", id: "tu_1", name: "log_expense", input: { amount: 450, category: "אחר", description: "בדיקת קול", payer: "yogev" } }]
          : [{ type: "text", text: "מחכה לאישור שלך." }];
      return new Response(JSON.stringify({ content, stop_reason: call === 1 ? "tool_use" : "end_turn" }), { status: 200 });
    }),
  );
}

beforeEach(() => {
  db = freshDb();
  stubClaude();
});
afterEach(() => vi.unstubAllGlobals());

test("a spoken money command is held for confirmation, not executed", async () => {
  const before = await expenses();
  const res = await handleBoardChat(env(), "רשום הוצאה 450 שקל", "yogev", { voice: true });
  expect(await expenses()).toBe(before);
  expect(res.pending).toHaveLength(1);
  expect(res.pending?.[0].summary).toContain("רישום הוצאה");
  expect(res.pending?.[0].summary).toContain("450");

  // two taps on "approve" run it once
  const id = res.pending?.[0].id as number;
  const taps = await Promise.all([confirmPending(env(), id, true), confirmPending(env(), id, true)]);
  expect(await expenses()).toBe(before + 1);
  expect(taps.filter((t) => t.status === "done").length).toBeGreaterThanOrEqual(1);
  expect((await confirmPending(env(), id, true)).status).toBe("done"); // replay, still one
  expect(await expenses()).toBe(before + 1);
});

test("cancelling a held command changes nothing, and it cannot be approved afterwards", async () => {
  const before = await expenses();
  const res = await handleBoardChat(env(), "רשום הוצאה 450 שקל", "yogev", { voice: true });
  const id = res.pending?.[0].id as number;
  expect((await confirmPending(env(), id, false)).status).toBe("cancelled");
  expect((await confirmPending(env(), id, true)).ok).toBe(false);
  expect(await expenses()).toBe(before);
});

test("the same command typed by hand still runs immediately", async () => {
  const before = await expenses();
  const res = await handleBoardChat(env(), "רשום הוצאה 450 שקל", "yogev");
  expect(res.pending).toHaveLength(0);
  expect(await expenses()).toBe(before + 1);
});
