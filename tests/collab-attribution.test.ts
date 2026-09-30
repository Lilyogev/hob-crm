// ייחוס מכירה למשפיענית (24.9.2026): עד היום אף הזמנה אמיתית לא עברה עם קוד
// של משפיענית, והנתיב הזה לא היה מכוסה בבדיקה. כאן מזינים ל-handleShopifyOrder
// הזמנה בצורה שבה שופיפיי שולחת את ה-webhook של orders/create, ובודקים את
// החצי שלנו בשרשרת: הקוד בהזמנה → שורה בליגה → התראה לברונו → בלי כפילויות.
// (החצי של שופיפיי, שה-webhook בכלל מגיע, מוכח בהזמנות הרגילות שנכנסות ללוח.)
import { beforeEach, expect, test } from "vitest";
import { freshDb } from "./d1";
import { handleShopifyOrder, type ShopifyOrderPayload } from "../src/lib/shopify-sync.server";

let db: ReturnType<typeof freshDb>;
let kerenId = 0;

/** הזמנה בצורת ה-webhook האמיתי: קליפס שטרות ב-39, קוד 10%. */
const order = (over: Partial<ShopifyOrderPayload> = {}): ShopifyOrderPayload => ({
  id: 6123456789012,
  name: "#1067",
  order_number: 1067,
  created_at: "2026-09-24T18:30:00+03:00",
  total_price: "35.10",
  email: "buyer@example.com",
  customer: { first_name: "נועה", last_name: "לוי" },
  shipping_address: { address1: "הרצל 1", city: "תל אביב", phone: "0500000000" },
  discount_codes: [{ code: "KRN10", amount: "3.90", type: "percentage" }],
  line_items: [{ title: "קליפס שטרות", quantity: 1, price: "39.00", variant_title: null }],
  shipping_lines: [{ title: "משלוח חינם" }],
  ...over,
});

const leagueRows = async () =>
  (
    await db
      .prepare("SELECT link_id, order_name, total FROM collab_sales ORDER BY id")
      .all<{ link_id: number; order_name: string; total: number }>()
  ).results;

const brunoNotes = async () =>
  (
    await db
      .prepare("SELECT content FROM assistant_chat WHERE content LIKE '💸%' ORDER BY id")
      .all<{ content: string }>()
  ).results.map((r) => r.content);

beforeEach(async () => {
  db = freshDb();
  kerenId = Number(
    (
      await db
        .prepare("INSERT INTO collab_links (token, campaign_id, name, instagram, discount_code, combines_ok) VALUES ('vip-k', 1, 'קרן', 'Keren_goldhamer', 'KRN10', 1)")
        .run()
    ).meta.last_row_id,
  );
});

test("הזמנה עם הקוד שלה נרשמת לה בליגה ומודיעה לברונו", async () => {
  await handleShopifyOrder({ DB: db as never }, order());

  expect(await leagueRows()).toEqual([{ link_id: kerenId, order_name: "#1067", total: 35.1 }]);
  const notes = await brunoNotes();
  expect(notes).toHaveLength(1);
  expect(notes[0]).toContain("קרן");
  expect(notes[0]).toContain("#1067");
  expect(notes[0]).toContain("KRN10");
});

test("ה-webhook נשלח פעמיים (ריטריי של שופיפיי): נספר פעם אחת", async () => {
  await handleShopifyOrder({ DB: db as never }, order());
  await handleShopifyOrder({ DB: db as never }, order());

  expect(await leagueRows()).toHaveLength(1);
  expect(await brunoNotes()).toHaveLength(1);
});

test("לקוח שהקליד את הקוד באותיות קטנות עדיין נזקף לה", async () => {
  await handleShopifyOrder({ DB: db as never }, order({ discount_codes: [{ code: "krn10" }] }));
  expect((await leagueRows())[0]?.link_id).toBe(kerenId);
});

test("סט DREAMER עם הקוד שלה: ההנחה האוטומטית לא מפריעה לייחוס", async () => {
  // הנחה אוטומטית לא מופיעה ב-discount_codes, רק הקוד שהקליד הלקוח.
  await handleShopifyOrder(
    { DB: db as never },
    order({
      id: 6123456789099,
      name: "#1068",
      total_price: "269.10",
      line_items: [
        { title: "חולצה · DREAMER · אפורה", quantity: 1, price: "199.00", variant_title: "M" },
        { title: "כובע · DREAMER · ירוק", quantity: 1, price: "149.00", variant_title: null },
      ],
    }),
  );
  expect(await leagueRows()).toEqual([{ link_id: kerenId, order_name: "#1068", total: 269.1 }]);
});

test("קופון של החנות שלא שייך למשפיענית לא נזקף לאף אחת", async () => {
  await handleShopifyOrder({ DB: db as never }, order({ discount_codes: [{ code: "WELCOME10" }] }));
  expect(await leagueRows()).toEqual([]);
  expect(await brunoNotes()).toEqual([]);
});

test("הזמנה רגילה בלי קוד: הליגה לא נוגעת, ספר המכירות כן", async () => {
  await handleShopifyOrder({ DB: db as never }, order({ discount_codes: [] }));
  expect(await leagueRows()).toEqual([]);
  const ledger = await db.prepare("SELECT COUNT(*) AS n FROM seed_sales WHERE note = 'Shopify #1067'").first<{ n: number }>();
  expect(ledger?.n).toBe(1);
});
