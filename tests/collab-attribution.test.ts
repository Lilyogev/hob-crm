// ייחוס מכירה למשפיענית: הזמנה שנכנסה עם הקוד האישי שלה נרשמת לה בליגה
// (collab_sales) ומודיעה להובי — פעם אחת, גם כשה-webhook של החנות חוזר על
// עצמו. הסנכרון של שופיפיי קורא ל-attributeCollabSale עם ההזמנה הגולמית.
import { beforeEach, expect, test } from "vitest";
import { freshDb } from "./d1";
import { attributeCollabSale } from "../src/lib/collab.server";

let db: ReturnType<typeof freshDb>;
let kerenId = 0;

type Order = { id?: number; total_price?: string; discount_codes?: { code?: string }[] };

/** הזמנה בצורת ה-webhook האמיתי: פריט ב-39, קוד 10%. */
const order = (over: Partial<Order> = {}): Order => ({
  id: 6123456789012,
  total_price: "35.10",
  discount_codes: [{ code: "KRN10" }],
  ...over,
});

const run = (o: Order, orderNo = "#1067") => attributeCollabSale(db as never, o, orderNo);

const leagueRows = async () =>
  (
    await db
      .prepare("SELECT link_id, order_name, total FROM collab_sales ORDER BY id")
      .all<{ link_id: number; order_name: string; total: number }>()
  ).results;

const hobiNotes = async () =>
  (
    await db
      .prepare("SELECT content, kind FROM assistant_chat WHERE content LIKE '💸%' ORDER BY id")
      .all<{ content: string; kind: string }>()
  ).results;

beforeEach(async () => {
  db = freshDb();
  kerenId = Number(
    (
      await db
        .prepare(
          "INSERT INTO collab_links (token, campaign_id, name, instagram, discount_code, combines_ok, handled_by) VALUES ('vip-k', 1, 'קרן', 'keren_k', 'KRN10', 1, 'avia')",
        )
        .run()
    ).meta.last_row_id,
  );
});

test("הזמנה עם הקוד שלה נרשמת לה בליגה ומודיעה להובי", async () => {
  const res = await run(order());
  expect(res).toEqual({ linkId: kerenId, code: "KRN10" });

  expect(await leagueRows()).toEqual([{ link_id: kerenId, order_name: "#1067", total: 35.1 }]);
  const notes = await hobiNotes();
  expect(notes).toHaveLength(1);
  expect(notes[0].kind).toBe("note"); // לא נכנס להיסטוריה שהמודל קורא
  expect(notes[0].content).toContain("קרן");
  expect(notes[0].content).toContain("#1067");
  expect(notes[0].content).toContain("KRN10");
});

test("ה-webhook נשלח פעמיים (ריטריי של החנות): נספר פעם אחת", async () => {
  await run(order());
  await run(order());

  expect(await leagueRows()).toHaveLength(1);
  expect(await hobiNotes()).toHaveLength(1);
});

test("לקוח שהקליד את הקוד באותיות קטנות עדיין נזקף לה", async () => {
  await run(order({ discount_codes: [{ code: "krn10" }] }));
  expect((await leagueRows())[0]?.link_id).toBe(kerenId);
});

test("הנחה אוטומטית של החנות לא מפריעה לייחוס (לא מופיעה ב-discount_codes)", async () => {
  await run(order({ id: 6123456789099, total_price: "269.10" }), "#1068");
  expect(await leagueRows()).toEqual([{ link_id: kerenId, order_name: "#1068", total: 269.1 }]);
});

test("קופון של החנות שלא שייך למשפיענית לא נזקף לאף אחת", async () => {
  expect(await run(order({ discount_codes: [{ code: "WELCOME10" }] }))).toBeNull();
  expect(await leagueRows()).toEqual([]);
  expect(await hobiNotes()).toEqual([]);
});

test("הזמנה בלי קוד: הליגה לא נוגעת", async () => {
  expect(await run(order({ discount_codes: [] }))).toBeNull();
  expect(await leagueRows()).toEqual([]);
});

test("קוד שנסגר עדיין נזקף לה: הזמנות עבר ועמלה לא נעלמות", async () => {
  await db.prepare("UPDATE collab_links SET code_ended_at = '2026-09-01' WHERE id = ?").bind(kerenId).run();
  await run(order());
  expect(await leagueRows()).toHaveLength(1);
});
