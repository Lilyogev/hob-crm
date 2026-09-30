import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { freshDb } from "./d1";

// יומן הכספים שייך למודול הפיננסי (הטבלאות שלו לא ב-0001_core): מדמים את הכניסה
// שהובי קוראת לה, ובודקים רק את מה שהובי אחראית עליו: מי שילמה, ומה נשלח.
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

import { financeDigest, handleBoardChat } from "../src/lib/assistant.server";

let db: ReturnType<typeof freshDb>;
const env = () => ({ DB: db as never, ANTHROPIC_API_KEY: "test" });

// Claude מדומה: קודם מבקש log_expense עם ה-payer שנשלח, ואז משפט אחד.
function stubClaude(payer: string | undefined) {
  let call = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      call++;
      const content =
        call === 1
          ? [{ type: "tool_use", id: "tu_1", name: "log_expense", input: { amount: 120, category: "אריזות", description: "בדיקה", ...(payer ? { payer } : {}) } }]
          : [{ type: "text", text: "רשמתי." }];
      return new Response(JSON.stringify({ content, stop_reason: call === 1 ? "tool_use" : "end_turn" }), { status: 200 });
    }),
  );
}

beforeEach(() => {
  db = freshDb();
  written.length = 0;
});
afterEach(() => vi.unstubAllGlobals());

test("הוצאה בלי payer: מי שכותבת שילמה", async () => {
  stubClaude(undefined);
  await handleBoardChat(env(), "שילמתי 120 על אריזות", "lior");
  expect(written).toHaveLength(1);
  expect(written[0].payer).toBe("lior");
  expect(written[0].amount).toBe(120);
});

test("payer שאינו שותפה או העסק נדחה לטובת מי שכותבת; business נשאר", async () => {
  stubClaude("stranger");
  await handleBoardChat(env(), "שילמתי 120 על אריזות", "avia");
  expect(written[0].payer).toBe("avia");
  stubClaude("business");
  await handleBoardChat(env(), "העסק שילם 120 על אריזות", "avia");
  expect(written[1].payer).toBe("business");
});

test("תמונת הכספים לא נופלת בלי טבלאות הכספים: JSON תקין עם פטור ממע\"מ מההגדרות", async () => {
  const d = JSON.parse(await financeDigest(db as never)) as Record<string, unknown>;
  expect(d.vat_exempt).toBe(true);
  expect((d.pending_receipts as { count: number }).count).toBe(0);
  expect(typeof d.finance).toBe("object");
  await db.prepare("UPDATE settings SET value = '0' WHERE key = 'vat_exempt'").run();
  expect((JSON.parse(await financeDigest(db as never)) as Record<string, unknown>).vat_exempt).toBe(false);
});
