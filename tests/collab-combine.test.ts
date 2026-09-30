// קודי משפיענים מול החנות (דרך ה-DO): יצירת קוד, שילוב עם ההנחות האוטומטיות
// של החנות (תיקון חד-פעמי לקודים ישנים, מסומן רק כשהחנות אישרה), וסגירה של
// שיתוף פעולה (הקוד מפסיק לעבוד אבל לא נמחק). האחוזים מגיעים מ-settings.
import { beforeEach, expect, test } from "vitest";
import { freshDb } from "./d1";
import { env } from "./cf-workers-stub";
import {
  countSaleClick,
  ensureDiscountCode,
  fixCodeCombinations,
  saleCodeExists,
  setCodeActive,
} from "../src/lib/collab.server";

let db: ReturnType<typeof freshDb>;

/** ה-DO המדומה: אוסף את הפניות ועונה לפי מה שהבדיקה ביקשה. */
type Call = { path: string; body: Record<string, unknown> };
function fakeAgent(reply: (call: Call) => { ok: boolean; error?: string }): Call[] {
  const calls: Call[] = [];
  const stub = {
    fetch: async (url: string, init?: RequestInit) => {
      const call: Call = {
        path: new URL(url).pathname,
        body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
      };
      calls.push(call);
      return Response.json(reply(call));
    },
  };
  env.ROOMS = { idFromName: () => "id", get: () => stub };
  return calls;
}

const linkWithCode = async (code: string): Promise<number> =>
  Number(
    (
      await db
        .prepare("INSERT INTO collab_links (token, campaign_id, name, instagram, discount_code) VALUES (?, 1, ?, ?, ?)")
        .bind(`tok-${code}`, "קרן", "keren", code)
        .run()
    ).meta.last_row_id,
  );

const combinesOk = async (id: number): Promise<number> =>
  (await db.prepare("SELECT combines_ok FROM collab_links WHERE id = ?").bind(id).first<{ combines_ok: number }>())
    ?.combines_ok ?? -1;

beforeEach(() => {
  db = freshDb();
  delete env.ROOMS;
});

test("קוד קיים מתוקן בחנות ומסומן פעם אחת בלבד", async () => {
  const id = await linkWithCode("KRN10");
  expect(await combinesOk(id)).toBe(0);

  const calls = fakeAgent(() => ({ ok: true }));
  const first = await fixCodeCombinations();
  expect(first).toEqual({ ok: true, fixed: 1, failed: [] });
  expect(calls).toEqual([{ path: "/collab-discount-combine", body: { code: "KRN10" } }]);
  expect(await combinesOk(id)).toBe(1);

  // ריצה שנייה לא נוגעת בחנות שוב.
  const second = await fixCodeCombinations();
  expect(second.fixed).toBe(0);
  expect(calls).toHaveLength(1);
});

test("כשהחנות נכשלת הקוד נשאר מסומן לתיקון וניתן לנסות שוב", async () => {
  const id = await linkWithCode("NOA10");
  let allow = false;
  fakeAgent(() => (allow ? { ok: true } : { ok: false, error: "code not found" }));

  const failed = await fixCodeCombinations();
  expect(failed.ok).toBe(false);
  expect(failed.fixed).toBe(0);
  expect(failed.failed[0]).toContain("NOA10");
  expect(await combinesOk(id)).toBe(0);

  allow = true;
  expect((await fixCodeCombinations()).fixed).toBe(1);
  expect(await combinesOk(id)).toBe(1);
});

test("תיקון של משפיענית אחת לא נוגע באחרות", async () => {
  const keren = await linkWithCode("KRN10");
  const noa = await linkWithCode("NOA10");
  const calls = fakeAgent(() => ({ ok: true }));

  await fixCodeCombinations(keren);
  expect(calls.map((c) => c.body.code)).toEqual(["KRN10"]);
  expect(await combinesOk(keren)).toBe(1);
  expect(await combinesOk(noa)).toBe(0);
});

test("קוד חדש נולד משולב, עם אחוז ההנחה מההגדרות", async () => {
  const id = Number(
    (
      await db
        .prepare("INSERT INTO collab_links (token, campaign_id, name, instagram) VALUES ('t-new', 1, 'דנה', 'dana')")
        .run()
    ).meta.last_row_id,
  );
  const calls = fakeAgent(() => ({ ok: true }));

  const res = await ensureDiscountCode(id);
  expect(res).toEqual({ ok: true, code: "DANA10" });
  expect(calls[0]).toEqual({ path: "/collab-discount", body: { code: "DANA10", pct: 0.1 } });
  expect(await combinesOk(id)).toBe(1);

  // אין מה לתקן: הקוד כבר נולד עם שילוב הנחות.
  expect((await fixCodeCombinations()).fixed).toBe(0);
});

test("שינוי אחוז ההנחה בהגדרות משנה את הסיומת של הקוד", async () => {
  await db.prepare("UPDATE settings SET value = '15' WHERE key = 'collab_discount_pct'").run();
  const id = Number(
    (
      await db
        .prepare("INSERT INTO collab_links (token, campaign_id, name, instagram) VALUES ('t-heb', 1, 'נועה לוי', '')")
        .run()
    ).meta.last_row_id,
  );
  const calls = fakeAgent(() => ({ ok: true }));
  const res = await ensureDiscountCode(id);
  // בלי אינסטגרם: תעתיק של השם הפרטי.
  expect(res).toEqual({ ok: true, code: "NOA15" });
  expect(calls[0].body.pct).toBeCloseTo(0.15);
});

// ---- סיום שיתוף פעולה ----
// אין תפוגה אוטומטית; הסגירה יזומה מהטאב. הקוד לא נמחק: מה שנצבר נשאר,
// והלינק הישן בסטורי מוביל לחנות רגילה במקום להנחה מתה.

const endedAt = async (id: number): Promise<string> =>
  (await db.prepare("SELECT code_ended_at FROM collab_links WHERE id = ?").bind(id).first<{ code_ended_at: string }>())
    ?.code_ended_at ?? "";

test("סגירת קוד מכבה אותו בחנות ומנטרלת את לינק המכירה", async () => {
  const id = await linkWithCode("KRN10");
  const calls = fakeAgent(() => ({ ok: true }));

  expect(await setCodeActive(id, false)).toEqual({ ok: true });
  expect(calls).toEqual([{ path: "/collab-discount-active", body: { code: "KRN10", active: false } }]);
  expect(await endedAt(id)).toMatch(/^\d{4}-\d{2}-\d{2}$/);

  // הקליק לא נספר יותר, כי הוא כבר לא יכול להפוך למכירה.
  expect(await countSaleClick("KRN10")).toBe(false);
  expect(await saleCodeExists("KRN10")).toBe(false);
  const clicks = await db.prepare("SELECT sale_clicks FROM collab_links WHERE id = ?").bind(id).first<{ sale_clicks: number }>();
  expect(clicks?.sale_clicks).toBe(0);
});

test("החזרה לפעילות מנקה את הסגירה ומחזירה את הלינק", async () => {
  const id = await linkWithCode("KRN10");
  fakeAgent(() => ({ ok: true }));
  await setCodeActive(id, false);

  expect(await setCodeActive(id, true)).toEqual({ ok: true });
  expect(await endedAt(id)).toBe("");
  expect(await countSaleClick("KRN10")).toBe(true);
});

test("כשהחנות נכשלת הקוד לא מסומן כסגור", async () => {
  const id = await linkWithCode("KRN10");
  fakeAgent(() => ({ ok: false, error: "code not found" }));

  const res = await setCodeActive(id, false);
  expect(res.ok).toBe(false);
  expect(await endedAt(id)).toBe("");
  // עדיין פעיל לכל דבר, כדי שהטאב לא ישקר על מצב שלא קרה.
  expect(await saleCodeExists("KRN10")).toBe(true);
});
