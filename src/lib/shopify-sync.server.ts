// Shopify → board inventory sync (direction 1). An orders/create webhook hits
// /api/shopify-webhook, which verifies the HMAC and relays the payload to the
// SummaryAgent DO. Each order line becomes a seed_sales row and decrements
// seed_stock exactly like a manual sale typed in the UI (through the stock
// module's adjustStock), and the partners get a note in Hobi's thread plus a
// push.
//
// Shopify stays the source of truth for its own stock — we only mirror the
// movement into the board's ledger. Dedupe is by the "Shopify #<n>" note so
// webhook retries can't double-log an order.
import type { D1Database } from "@cloudflare/workers-types";
import { attributeCollabSale } from "./collab.server";
import { notify } from "./notify.server";
import type { PushEnv } from "./push.server";
import { adjustStock, normSize, shopifyStockLocation } from "./seeding.server";

type SyncEnv = PushEnv & { DB?: D1Database };

type ShopifyLineItem = {
  title?: string;
  variant_title?: string | null;
  quantity?: number;
  price?: string;
};

export type ShopifyOrderPayload = {
  id?: number;
  discount_codes?: { code?: string; amount?: string; type?: string }[];
  order_number?: number;
  name?: string;
  created_at?: string;
  total_price?: string;
  email?: string | null;
  phone?: string | null;
  customer?: {
    first_name?: string | null;
    last_name?: string | null;
    email?: string | null;
    phone?: string | null;
  };
  shipping_address?: {
    address1?: string | null;
    address2?: string | null;
    city?: string | null;
    zip?: string | null;
    phone?: string | null;
  } | null;
  line_items?: ShopifyLineItem[];
  shipping_lines?: { title?: string | null; code?: string | null }[];
};

// HMAC verification for the route handler (crypto.subtle is local compute —
// fine outside the DO). Shopify signs the RAW body with the app's client
// secret and sends base64 in X-Shopify-Hmac-Sha256.
export async function verifyShopifyHmac(
  secret: string,
  rawBody: string,
  headerValue: string,
): Promise<boolean> {
  if (!headerValue) return false;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(rawBody));
  const expected = btoa(String.fromCharCode(...new Uint8Array(sig)));
  // Constant-time-ish compare; lengths differ → fail fast is fine.
  if (expected.length !== headerValue.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ headerValue.charCodeAt(i);
  return diff === 0;
}

// ---- Settings helpers shared with shopify.server ----

export async function settingGet(db: D1Database, key: string): Promise<string | null> {
  const row = await db
    .prepare("SELECT value FROM settings WHERE key = ?")
    .bind(key)
    .first<{ value: string }>();
  return row?.value ?? null;
}

export async function settingPut(db: D1Database, key: string, value: string): Promise<void> {
  await db
    .prepare(
      "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    )
    .bind(key, value)
    .run();
}

// A line in Hobi's thread. kind 'note' = board notification the model never
// reads as history (orders, signups); '' = a real assistant turn.
export async function postThreadNote(db: D1Database, text: string, kind: "note" | "" = "note"): Promise<void> {
  await db
    .prepare("INSERT INTO assistant_chat (chat_id, role, content, kind) VALUES (1, 'assistant', ?, ?)")
    .bind(text.slice(0, 4000), kind)
    .run();
}

// ---- Matching a Shopify line to a seed_items row ----

const SIZE_TOKENS: Record<string, string> = {
  XS: "XS",
  S: "S",
  M: "M",
  L: "L",
  XL: "XL",
  XXL: "XXL",
  "2XL": "XXL",
};

export function sizeFromVariant(variantTitle: string | null | undefined): string {
  if (!variantTitle) return "";
  for (const part of variantTitle.split("/").map((p) => p.trim().toUpperCase())) {
    if (SIZE_TOKENS[part]) return SIZE_TOKENS[part];
  }
  return "";
}

// Colour words arrive in either language and either Hebrew gender ("לבן" on
// the Shopify variant vs "לבנה" on the inventory row) — collapse them all to
// one canonical token so they actually match. Generic list; extend freely.
const COLOR_CANON: Record<string, string> = {
  לבן: "לבן", לבנה: "לבן", white: "לבן", offwhite: "לבן",
  שחור: "שחור", שחורה: "שחור", black: "שחור",
  אפור: "אפור", אפורה: "אפור", gray: "אפור", grey: "אפור",
  ירוק: "ירוק", ירוקה: "ירוק", green: "ירוק", זית: "ירוק", olive: "ירוק",
  כחול: "כחול", כחולה: "כחול", blue: "כחול", navy: "כחול", נייבי: "כחול",
  אדום: "אדום", אדומה: "אדום", red: "אדום", בורדו: "אדום", burgundy: "אדום",
  ורוד: "ורוד", ורודה: "ורוד", pink: "ורוד",
  צהוב: "צהוב", צהובה: "צהוב", yellow: "צהוב",
  כתום: "כתום", כתומה: "כתום", orange: "כתום",
  סגול: "סגול", סגולה: "סגול", purple: "סגול", lilac: "סגול", לילך: "סגול",
  חום: "חום", חומה: "חום", brown: "חום", מוקה: "חום", mocha: "חום",
  "בז'": "בז'", בז: "בז'", beige: "בז'", nude: "בז'", ניוד: "בז'", camel: "בז'", קאמל: "בז'",
  שמנת: "שמנת", cream: "שמנת", קרם: "שמנת", ivory: "שמנת", אייבורי: "שמנת",
  חאקי: "חאקי", khaki: "חאקי",
  כסף: "כסף", כסוף: "כסף", כסופה: "כסף", silver: "כסף",
  זהב: "זהב", זהוב: "זהב", זהובה: "זהב", gold: "זהב",
  "ג'ינס": "ג'ינס", denim: "ג'ינס",
};

// Words that place a product in a bucket but never identify WHICH product:
// the garment type, the colour, and Shopify's filler variant labels. Half the
// catalogue may be dresses and half of those black, so "שמלה" + "שחור" in
// common says nothing. Garment words still count toward the score (they
// break a colour tie between a black skirt and a black top); they just
// cannot carry a match on their own.
//
// EXTEND THIS when a new garment category is added — a category word missing
// here is treated as identifying, which is exactly how two colours of the
// same new product would start matching each other.
const GENERIC_TOKENS = new Set([
  "שמלה", "שמלת", "שמלות", "חצאית", "חצאיות", "מכנסיים", "מכנס", "מכנסי", "טופ", "טופים",
  "חולצה", "חולצת", "חולצות", "גופיה", "גופיות", "ג'קט", "ז'קט", "מעיל", "קרדיגן", "סוודר",
  "סווטשירט", "קפוצ'ון", "קפוצ׳ון", "אוברול", "סט", "בגד", "ים", "ביקיני", "טרנינג", "כובע",
  "תיק", "חגורה", "שורט", "שורטס", "בלייזר", "וסט", "קימונו", "עליונית", "טוניקה",
  "dress", "skirt", "pants", "top", "shirt", "tee", "blouse", "tank", "jacket", "coat",
  "cardigan", "sweater", "hoodie", "sweatshirt", "overall", "jumpsuit", "set", "bikini",
  "swimsuit", "hat", "cap", "bag", "belt", "shorts", "blazer", "vest", "kimono", "tunic",
  "mini", "midi", "maxi", "מיני", "מידי", "מקסי", "בהיר", "כהה", "default", "title", "one", "size",
  ...Object.values(COLOR_CANON),
]);

function tokens(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[·|:,()"״׳\-–—]/g, " ")
    .split(/\s+/)
    .map((t) => COLOR_CANON[t] ?? t)
    .filter((t) => t.length > 1);
}

// Best-overlap match: the item whose name shares the most tokens with the
// Shopify title. Ties or too little overlap → null (logged unlinked, stock
// untouched — better than corrupting the wrong bucket).
//
// Two guards, because the overlap score alone accepts two kinds of accident:
//   MIN_SCORE — a single shared word is not a match (a brand word or a
//   collection name that every product carries would otherwise link
//   everything to the first item that has it).
//   GENERIC_TOKENS — two shared words are not a match either when both are
//   generic: garment type + colour is shared by every second product.
const MIN_SCORE = 2;

export function matchItem(
  shopifyTitle: string,
  items: { id: number; name: string; size: string }[],
): { id: number; name: string; size: string } | null {
  const wanted = new Set(tokens(shopifyTitle));
  if (wanted.size === 0) return null;
  let best: { item: (typeof items)[number]; score: number } | null = null;
  let tie = false;
  for (const item of items) {
    let score = 0;
    let identifying = false;
    for (const t of tokens(`${item.name} ${item.size}`)) {
      if (!wanted.has(t)) continue;
      score++;
      if (!GENERIC_TOKENS.has(t)) identifying = true;
    }
    if (score < MIN_SCORE || !identifying) continue;
    if (!best || score > best.score) {
      best = { item, score };
      tie = false;
    } else if (score === best.score) {
      tie = true;
    }
  }
  return best && !tie ? best.item : null;
}

// Size → stock bucket column, whitelisted (the name reaches SQL). Mirrors the
// stock module's bucket matrix; a different schema just yields "left: unknown".
const SIZE_COLS: Record<string, string> = {
  XS: "qty_xs",
  S: "qty_s",
  M: "qty_m",
  L: "qty_l",
  XL: "qty_xl",
  XXL: "qty_xxl",
};

async function stockLeft(db: D1Database, itemId: number, location: string, size: string): Promise<number | null> {
  try {
    const col = SIZE_COLS[normSize(size)] ?? "qty";
    const row = await db
      .prepare(`SELECT ${col} AS v FROM seed_stock WHERE item_id = ? AND location = ?`)
      .bind(itemId, location)
      .first<{ v: number }>();
    return row?.v ?? 0;
  } catch {
    return null;
  }
}

export async function handleShopifyOrder(
  env: SyncEnv,
  order: ShopifyOrderPayload,
): Promise<string> {
  const db = env.DB;
  if (!db) return "error: DB not bound";
  const orderNo = order.name ?? `#${order.order_number ?? order.id ?? "?"}`;
  const note = `Shopify ${orderNo}`;
  await attributeCollabSale(db, order, orderNo);

  const dup = await db
    .prepare("SELECT id FROM seed_sales WHERE note = ? LIMIT 1")
    .bind(note)
    .first<{ id: number }>();
  if (dup) return `duplicate: ${orderNo} already logged`;

  const location = await shopifyStockLocation(db);
  const itemsRes = await db
    .prepare("SELECT id, name, size FROM seed_items")
    .all<{ id: number; name: string; size: string }>();
  const items = itemsRes.results ?? [];

  const buyer = [order.customer?.first_name, order.customer?.last_name]
    .filter(Boolean)
    .join(" ")
    .trim();
  const soldAt = (order.created_at ?? "").slice(0, 10);
  // Customer contact — filled automatically so store orders arrive with full
  // details. Phone: shipping address first, it's the one couriers reach.
  const ship = order.shipping_address;
  const buyerPhone = (ship?.phone ?? order.phone ?? order.customer?.phone ?? "").trim();
  const buyerEmail = (order.email ?? order.customer?.email ?? "").trim();
  const buyerAddress = [ship?.address1, ship?.address2, ship?.city, ship?.zip]
    .map((p) => (p ?? "").trim())
    .filter(Boolean)
    .join(", ");

  // צורת מסירה: שורת המשלוח אומרת אם זה איסוף; אחרת כתובת = משלוח.
  const shipTitle = (order.shipping_lines?.[0]?.title ?? "").toLowerCase();
  const delivery = /איסוף|pickup|pick up|local/.test(shipTitle) ? "pickup" : buyerAddress ? "ship" : "";
  const orderRef = orderNo.startsWith("#") ? orderNo : `#${orderNo}`;
  const lines: string[] = [];
  let unmatched = 0;
  for (const li of order.line_items ?? []) {
    const qty = li.quantity ?? 1;
    const title = li.title ?? "?";
    const size = sizeFromVariant(li.variant_title);
    const price = parseFloat(li.price ?? "0") || 0;
    // Colour usually lives in the variant ("ירוק / L"), not the product title —
    // match on both so each colour maps to its own inventory row.
    const match = matchItem(`${title} ${li.variant_title ?? ""}`, items);
    const label = match
      ? match.size
        ? `${match.name} (${match.size})`
        : match.name
      : title;

    await db
      .prepare(
        `INSERT INTO seed_sales (item_id, item_label, buyer, buyer_phone, buyer_email, buyer_address, qty, size, location, price, pay_method, handled_by, note, sold_at, order_ref, delivery)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'shopify', '', ?, ?, ?, ?)`,
      )
      .bind(
        match?.id ?? null,
        label,
        buyer || "לקוחת האתר",
        buyerPhone,
        buyerEmail,
        buyerAddress,
        qty,
        size,
        location,
        price,
        note,
        soldAt,
        orderRef,
        delivery,
      )
      .run();
    let left: number | null = null;
    if (match) {
      // Same relative bucket adjustment a manual sale makes (stock module).
      await adjustStock(match.id, location, size, -qty);
      left = await stockLeft(db, match.id, location, size);
    } else {
      unmatched++;
    }

    lines.push(
      `• ${label}${size ? ` · ${size}` : ""} ×${qty} · ₪${price.toFixed(0)}` +
        (match ? (left !== null ? ` · נשאר: ${left}` : "") : " · ⚠️ לא זוהה במלאי הלוח"),
    );
  }

  const total = parseFloat(order.total_price ?? "0") || 0;
  const parts = [
    `🛍️ הזמנה חדשה באתר! ${orderNo}`,
    lines.join("\n"),
    `💰 סה"כ: ₪${total.toFixed(0)}${buyer ? ` · ${buyer}` : ""}`,
    `📍 ירד מהמלאי שנמצא אצל ${location === "lior" ? "ליאור" : "אביה"}. יצא ממקום אחר? מחקו את השורה ביומן ורשמו אותה מחדש מהמיקום הנכון.`,
  ];
  if (unmatched > 0) {
    parts.push(
      `⚠️ ${unmatched} פריט(ים) נרשמו ביומן בלי קישור למלאי — פתחו את טאב המלאי ושייכו אותם כדי שהספירה תרד.`,
    );
  }
  let noteOk = true;
  try {
    await postThreadNote(db, parts.join("\n\n"), "note");
  } catch (error) {
    noteOk = false;
    console.error("order note failed", error);
  }
  // Push to both phones. The notify gate coalesces bursts and respects quiet
  // hours; a failure here must never undo the ledger write.
  try {
    const itemsText = (order.line_items ?? [])
      .map((li) => `${li.title ?? ""}${li.variant_title ? ` ${li.variant_title}` : ""}`)
      .join(", ")
      .slice(0, 160);
    await notify(env, {
      level: "now",
      topic: "order",
      isOrder: true,
      title: `💸 הזמנה חדשה ${orderNo} · ${Math.round(total)} ₪`,
      body: `${buyer || "לקוחה"}: ${itemsText}`,
      url: "/?tab=seeding",
    });
  } catch (error) {
    console.error("order push failed", error);
  }
  return noteOk
    ? `ok: ${orderNo} logged (${lines.length} lines, ${unmatched} unmatched)`
    : "logged, delivery failed: board thread write failed";
}
