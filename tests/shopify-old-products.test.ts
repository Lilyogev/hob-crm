import { expect, test } from "vitest";
import { matchItem, sizeFromVariant } from "../src/lib/shopify-sync.server";

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
