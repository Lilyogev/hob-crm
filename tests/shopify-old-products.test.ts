import { expect, test } from "vitest";
import { freshDb } from "./d1";
import { handleShopifyOrder, matchItem, sizeFromVariant } from "../src/lib/shopify-sync.server";

// Board items as a small clothing catalogue would name them (they mirror the
// store titles). Generic sample data, not real inventory.
const ITEMS = [
  { id: 1, name: "שמלה · LUNA · שחורה", size: "" },
  { id: 2, name: "שמלה · LUNA · לבנה", size: "" },
  { id: 3, name: "חצאית · MAYA · בז'", size: "" },
  { id: 4, name: "חצאית · MAYA · שחורה", size: "" },
  { id: 5, name: "טופ · NOA · שחור", size: "" },
  { id: 6, name: "ג'קט · RIO", size: "" },
  { id: 7, name: "סט · TALIA · ירוק", size: "" },
  { id: 8, name: "חגורת עור", size: "" },
];

test("store products with no board item never take stock from another item", () => {
  for (const t of [
    "שמלה · CLASSIC BLACK שחור M",
    "שמלה · SUMMER NIGHT שחור L",
    "חצאית · PLEATED לבן S",
    "טופ · BASIC ירוק M",
    "ג'קט · DENIM כחול M",
  ]) {
    expect(matchItem(t, ITEMS), t).toBeNull();
  }
});

test("every product finds its own item, colour and gender aside", () => {
  expect(matchItem("שמלה · LUNA · שחורה שחור M", ITEMS)?.id).toBe(1);
  expect(matchItem("שמלה · LUNA · לבנה לבן S", ITEMS)?.id).toBe(2);
  expect(matchItem("חצאית · MAYA · בז' beige L", ITEMS)?.id).toBe(3);
  expect(matchItem("טופ · NOA · שחור black One size", ITEMS)?.id).toBe(5);
  expect(matchItem("סט · TALIA · ירוק green XL", ITEMS)?.id).toBe(7);
});

test("garment type plus colour alone is not a match; a bare product word is a tie", () => {
  // "שמלה" + "שחור" is shared by LUNA and CLASSIC BLACK: not identifying.
  expect(matchItem("שמלה שחורה M", ITEMS)).toBeNull();
  // MAYA without a colour ties between the two MAYA skirts.
  expect(matchItem("חצאית · MAYA · אדומה", ITEMS)).toBeNull();
});

test("size comes out of the variant title in either position", () => {
  expect(sizeFromVariant("שחור / L")).toBe("L");
  expect(sizeFromVariant("XS / לבן")).toBe("XS");
  expect(sizeFromVariant("2XL")).toBe("XXL");
  expect(sizeFromVariant("One size")).toBe("");
  expect(sizeFromVariant(null)).toBe("");
});

// End to end against the real migrations: an orders/create payload becomes a
// ledger row, leaves the configured partner's stock, posts a note, dedupes.
test("a store order is logged once, leaves stock and posts a note", async () => {
  const db = freshDb();
  await db.prepare("INSERT INTO seed_items (id, name, size) VALUES (1, 'שמלה · LUNA · שחורה', '')").run();
  await db.prepare("INSERT INTO seed_stock (item_id, location, qty_m) VALUES (1, 'avia', 5)").run();
  const order = {
    id: 99,
    name: "#1001",
    created_at: "2026-09-30T10:00:00Z",
    total_price: "299.00",
    customer: { first_name: "דנה", last_name: "כהן" },
    shipping_address: { address1: "הרצל 1", city: "תל אביב", phone: "050" },
    line_items: [{ title: "שמלה · LUNA · שחורה", variant_title: "שחור / M", quantity: 1, price: "299.00" }],
  };
  const first = await handleShopifyOrder({ DB: db as never }, order);
  expect(first.startsWith("ok:")).toBe(true);
  const sale = await db.prepare("SELECT * FROM seed_sales").first<Record<string, unknown>>();
  expect(sale?.pay_method).toBe("shopify");
  expect(sale?.location).toBe("avia");
  expect(sale?.handled_by).toBe("");
  expect(sale?.item_id).toBe(1);
  expect(sale?.order_ref).toBe("#1001");
  expect(sale?.delivery).toBe("ship");
  const stock = await db.prepare("SELECT qty_m FROM seed_stock WHERE item_id = 1 AND location = 'avia'").first<{ qty_m: number }>();
  expect(stock?.qty_m).toBe(4);
  const note = await db.prepare("SELECT kind, content FROM assistant_chat ORDER BY id DESC LIMIT 1").first<{ kind: string; content: string }>();
  expect(note?.kind).toBe("note");
  expect(note?.content).toContain("#1001");
  // A webhook retry never double-logs, and a synced order never queues a push.
  const again = await handleShopifyOrder({ DB: db as never }, order);
  expect(again.startsWith("duplicate")).toBe(true);
  const queued = await db.prepare("SELECT COUNT(*) AS c FROM shopify_push_queue").first<{ c: number }>();
  expect(queued?.c).toBe(0);
});
