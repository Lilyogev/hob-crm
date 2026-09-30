import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { freshDb } from "./d1";
import { boardChatHistory, handleBoardChat, recentBoardHistory, unreadCount } from "../src/lib/assistant.server";
import { addMemory, forget, listFacts, memoryForPrompt } from "../src/lib/memory.server";

let db: ReturnType<typeof freshDb>;
const env = () => ({ DB: db as never, ANTHROPIC_API_KEY: "test" });

// Claude מדומה: משפט אחד, ומה שהודעת המערכת הכילה נשמר לבדיקה.
const systems: string[] = [];
function stubClaude(answer = "בכיף.") {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init?: { body?: string }) => {
      const body = JSON.parse(init?.body ?? "{}") as { system?: { text: string }[] };
      systems.push((body.system ?? []).map((b) => b.text).join("\n"));
      return new Response(JSON.stringify({ content: [{ type: "text", text: answer }], stop_reason: "end_turn" }), { status: 200 });
    }),
  );
}

beforeEach(() => {
  db = freshDb();
  systems.length = 0;
  stubClaude();
});
afterEach(() => vi.unstubAllGlobals());

test("תור נשמר עם מי שכתבה, והשורה מתחילה בשם שלה; הובי עונה בלשון נקבה מהגדרות המותג", async () => {
  await handleBoardChat(env(), "מה במלאי?", "avia");
  const rows = await boardChatHistory(db as never);
  expect(rows).toHaveLength(2);
  expect(rows[0]).toMatchObject({ role: "user", actor: "avia", content: "אביה: מה במלאי?" });
  expect(rows[1]).toMatchObject({ role: "assistant", content: "בכיף." });
  expect(systems[0]).toContain("את הובי");
  expect(systems[0]).toContain("מי שכותבת לך עכשיו: אביה");
  expect(systems[0]).not.toMatch(/ברונו|Segula|SEGULA|יוגב|דימה/);
});

test("הקשר להגדרות: owner_context, brand_context והזיכרון נכנסים לבלוק הקבוע", async () => {
  await db.prepare("UPDATE settings SET value = 'אביה מטפלת במלאי, ליאור בכספים' WHERE key = 'owner_context'").run();
  await db.prepare("UPDATE settings SET value = 'מותג בגדי נשים' WHERE key = 'brand_context'").run();
  const id = await addMemory(db as never, "הספקית של הבדים היא רותי", "lior");
  await handleBoardChat(env(), "היי", "lior");
  expect(systems[0]).toContain("אביה מטפלת במלאי");
  expect(systems[0]).toContain("מותג בגדי נשים");
  expect(systems[0]).toContain(`#${id} (`);
  expect(systems[0]).toContain("רותי");
  expect(await forget(db as never, id)).toBe(true);
  expect(await listFacts(db as never)).toHaveLength(0);
  expect(await memoryForPrompt(db as never)).toBe("");
});

test("היסטוריה למודל: 12 תורות אחרונים, בלי עדכוני לוח (kind=note); after וספירה לתג", async () => {
  await db.prepare("INSERT INTO assistant_chat (chat_id, role, content, kind) VALUES (1, 'assistant', 'נרשמה משפיענית חדשה', 'note')").run();
  for (let i = 1; i <= 8; i++) await handleBoardChat(env(), `שאלה ${i}`, i % 2 ? "avia" : "lior");
  const recent = await recentBoardHistory(db as never, 4);
  expect(recent.map((r) => r.content)).toEqual(["אביה: שאלה 7", "בכיף.", "ליאור: שאלה 8", "בכיף."]);
  // the model saw 12 turns at most, and never the note
  const lastBody = JSON.parse((vi.mocked(fetch).mock.calls.at(-1)?.[1] as { body: string }).body) as { messages: { content: string }[] };
  expect(lastBody.messages).toHaveLength(13);
  expect(lastBody.messages.some((m) => String(m.content).includes("משפיענית"))).toBe(false);
  // the thread itself keeps the note, and paging by id works
  const all = await boardChatHistory(db as never);
  expect(all[0].kind).toBe("note");
  const after = await boardChatHistory(db as never, 80, all[all.length - 3].id);
  expect(after).toHaveLength(2);
  // unread for the badge: rows I did not write myself
  expect(await unreadCount(db as never, all[all.length - 3].id, "lior")).toBe(1); // only Hobi's answer to my own question
  expect(await unreadCount(db as never, all[all.length - 3].id, "avia")).toBe(2); // Lior's question and Hobi's answer
});
