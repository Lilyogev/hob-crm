import type { D1Database, D1PreparedStatement } from "@cloudflare/workers-types";
import { db } from "./hob.server";
import { LOCATIONS, type Location, isPartner } from "./partners";

// ---- Stock (מלאי): items, stock per location, gifts log, sales ledger ----
//
// Stock rules: stock lives in seed_stock rows, one row per (item, location),
// each with the full size-bucket matrix. A gift/sale line decrements the
// bucket matching its size AT ITS LOCATION, deleting restores it, and
// qty/size edits move the delta between buckets. Buckets can go negative:
// the UI shows that in red so a counting mistake is visible instead of
// silently clamped. Locations are the two partners (partners.ts LOCATIONS).

export type StockRow = {
  location: string;
  qty: number;
  qty_xs: number;
  qty_s: number;
  qty_m: number;
  qty_l: number;
  qty_xl: number;
  qty_xxl: number;
};

export type SeedItem = {
  id: number;
  name: string;
  size: string;
  price: number;
  unit_cost: number;
  collection: string;
  image: string;
  web_status: string;
  web_reason: string;
  given: number;
  sold: number;
  updated_at: string;
  stock: StockRow[];
};

// Collections are free text. The default group is 'main'; the list the UI
// offers is whatever exists on items (listCollections) plus a free input.
export const DEFAULT_COLLECTION = "main";

export function normCollection(c: unknown): string {
  const v = typeof c === "string" ? c.trim().slice(0, 40) : "";
  return v || DEFAULT_COLLECTION;
}

export async function listCollections(): Promise<string[]> {
  const rows = await db()
    .prepare("SELECT collection, COUNT(*) AS n FROM seed_items GROUP BY collection ORDER BY MIN(id)")
    .all<{ collection: string; n: number }>();
  const list = (rows.results ?? []).map((r) => r.collection || DEFAULT_COLLECTION);
  return list.includes(DEFAULT_COLLECTION) ? list : [DEFAULT_COLLECTION, ...list];
}

// Size string -> stock bucket column. Whitelisted names only: these get
// interpolated into SQL.
const SIZE_COLS: Record<string, string> = {
  XS: "qty_xs",
  S: "qty_s",
  M: "qty_m",
  L: "qty_l",
  XL: "qty_xl",
  XXL: "qty_xxl",
};

export function normSize(size: string): string {
  const up = size.trim().toUpperCase();
  return SIZE_COLS[up] ? up : size.trim();
}

function stockCol(size: string): string {
  return SIZE_COLS[normSize(size)] ?? "qty";
}

// Stock locations: the two partners. Whitelisted, they reach SQL and the
// gifts/sales rows. Anything unknown falls back to Avia.
export { LOCATIONS };
export const DEFAULT_LOCATION: Location = "avia";

export function normLocation(loc: unknown): Location {
  return isPartner(loc) ? loc : DEFAULT_LOCATION;
}

// Who handled a sale: '' (unknown / store) or a partner.
export function normHandledBy(v: unknown): "" | Location {
  return isPartner(v) ? v : "";
}

/** Where a Shopify order's stock is deducted: settings.shopify_stock_location,
 *  falling back to Avia. Takes an explicit D1 handle for the Durable Object. */
export async function shopifyStockLocation(d1?: D1Database): Promise<Location> {
  try {
    const row = await (d1 ?? db())
      .prepare("SELECT value FROM settings WHERE key = 'shopify_stock_location'")
      .first<{ value: string }>();
    return normLocation(row?.value);
  } catch {
    return DEFAULT_LOCATION;
  }
}

const BUCKET_COLS = ["qty", "qty_xs", "qty_s", "qty_m", "qty_l", "qty_xl", "qty_xxl"] as const;
export type BucketCol = (typeof BUCKET_COLS)[number];

/** Bucket column → the size token the Shopify variant map is keyed by. */
const SIZE_OF_COL: Record<string, string> = {
  qty: "",
  qty_xs: "XS",
  qty_s: "S",
  qty_m: "M",
  qty_l: "L",
  qty_xl: "XL",
  qty_xxl: "XXL",
};

// Relative stock adjustment at (item, location): creates the row on first
// touch via upsert so a location never needs explicit setup. Exported so the
// Shopify order sync applies exactly the same SQL as a manual sale.
export function adjustStockStmt(
  itemId: number,
  location: string,
  size: string,
  delta: number,
  d1: D1Database = db(),
): D1PreparedStatement {
  const col = stockCol(size);
  return d1
    .prepare(
      `INSERT INTO seed_stock (item_id, location, ${col}) VALUES (?, ?, ?)
       ON CONFLICT(item_id, location) DO UPDATE SET ${col} = ${col} + excluded.${col}, updated_at = datetime('now')`,
    )
    .bind(itemId, normLocation(location), delta);
}

export type SeedGift = {
  id: number;
  item_id: number | null;
  item_label: string;
  person: string;
  handle: string;
  kind: string;
  qty: number;
  size: string;
  location: string;
  status: string;
  note: string;
  given_at: string;
  position: number;
  updated_at: string;
};

export type SeedSale = {
  id: number;
  item_id: number | null;
  item_label: string;
  buyer: string;
  buyer_phone: string;
  buyer_email: string;
  buyer_address: string;
  qty: number;
  size: string;
  location: string;
  price: number;
  ship_status: string;
  pay_method: string;
  channel: string;
  note: string;
  sold_at: string;
  order_ref: string;
  delivery: string;
  handled_by: string;
  position: number;
  updated_at: string;
};

export const SHIP_STATUSES = new Set(["recorded", "packed", "shipped", "delivered", "cancelled"]);

// Where the money for a sale landed. Store orders are tagged automatically;
// a face-to-face sale is tagged by hand. "" = not tagged yet, a legal state.
export const PAY_METHODS = new Set(["", "shopify", "bit", "cash", "transfer"]);

// Where the sale happened. "" = store / regular manual row. 'archive' rows
// are imported history and stay out of every current number.
export const SALE_CHANNELS = new Set(["", "popup", "archive"]);

export const GIFT_KINDS = new Set(["influencer", "friend", "other"]);
export const GIFT_STATUSES = new Set(["promised", "given", "story", "posted"]);

const SALE_COLS =
  "id, item_id, item_label, buyer, buyer_phone, buyer_email, buyer_address, qty, size, location, price, ship_status, pay_method, channel, note, sold_at, order_ref, delivery, handled_by, position, updated_at";

export async function getSeeding(): Promise<{
  items: SeedItem[];
  collections: string[];
  gifts: SeedGift[];
  sales: SeedSale[];
}> {
  const itemsRes = await db()
    .prepare(
      `SELECT i.id, i.name, i.size, i.price, i.unit_cost, i.collection, i.image, i.web_status, i.web_reason, i.updated_at,
              COALESCE((SELECT SUM(g.qty) FROM seed_gifts g WHERE g.item_id = i.id), 0) AS given,
              COALESCE((SELECT SUM(s.qty) FROM seed_sales s WHERE s.item_id = i.id AND s.ship_status <> 'cancelled' AND COALESCE(s.channel,'') <> 'archive'), 0) AS sold
       FROM seed_items i ORDER BY i.id`,
    )
    .all<Omit<SeedItem, "stock">>();
  const stockRes = await db()
    .prepare(
      `SELECT item_id, location, qty, qty_xs, qty_s, qty_m, qty_l, qty_xl, qty_xxl
       FROM seed_stock`,
    )
    .all<StockRow & { item_id: number }>();
  const giftsRes = await db()
    .prepare(
      `SELECT id, item_id, item_label, person, handle, kind, qty, size, location, status, note, given_at, position, updated_at
       FROM seed_gifts ORDER BY position, given_at DESC, id DESC`,
    )
    .all<SeedGift>();
  const salesRes = await db()
    .prepare(`SELECT ${SALE_COLS} FROM seed_sales ORDER BY position, sold_at DESC, id DESC`)
    .all<SeedSale>();
  const stockByItem = new Map<number, StockRow[]>();
  for (const row of stockRes.results ?? []) {
    const list = stockByItem.get(row.item_id) ?? [];
    list.push(row);
    stockByItem.set(row.item_id, list);
  }
  const items = (itemsRes.results ?? []).map((i) => ({
    ...i,
    collection: i.collection || DEFAULT_COLLECTION,
    stock: stockByItem.get(i.id) ?? [],
  }));
  const collections: string[] = [];
  for (const i of items) if (!collections.includes(i.collection)) collections.push(i.collection);
  if (!collections.includes(DEFAULT_COLLECTION)) collections.unshift(DEFAULT_COLLECTION);
  return { items, collections, gifts: giftsRes.results ?? [], sales: salesRes.results ?? [] };
}

/** New item. The initial count (optional) lands in the no-size bucket at
 *  `location` (Avia by default); the size split is typed in afterwards. */
export async function addItem(
  name: string,
  size: string,
  qty: number,
  opts: { collection?: string; price?: number; unitCost?: number; location?: string; image?: string } = {},
): Promise<number> {
  const res = await db()
    .prepare("INSERT INTO seed_items (name, size, price, unit_cost, collection, image) VALUES (?, ?, ?, ?, ?, ?) RETURNING id")
    .bind(
      name,
      size,
      typeof opts.price === "number" && opts.price >= 0 ? opts.price : 0,
      typeof opts.unitCost === "number" && opts.unitCost >= 0 ? opts.unitCost : 0,
      normCollection(opts.collection),
      typeof opts.image === "string" ? opts.image.slice(0, 500) : "",
    )
    .first<{ id: number }>();
  if (!res) return 0;
  if (qty > 0) await adjustStockStmt(res.id, normLocation(opts.location), "", qty).run();
  return res.id;
}

export async function updateItem(
  id: number,
  patch: { name?: string; price?: number; unit_cost?: number; collection?: string; image?: string },
): Promise<void> {
  const sets: string[] = [];
  const vals: (string | number)[] = [];
  if (typeof patch.name === "string" && patch.name.trim()) {
    sets.push("name = ?");
    vals.push(patch.name.trim().slice(0, 200));
  }
  if (typeof patch.price === "number" && Number.isFinite(patch.price) && patch.price >= 0) {
    sets.push("price = ?");
    vals.push(patch.price);
  }
  if (typeof patch.unit_cost === "number" && Number.isFinite(patch.unit_cost) && patch.unit_cost >= 0) {
    sets.push("unit_cost = ?");
    vals.push(patch.unit_cost);
  }
  if (typeof patch.collection === "string") {
    sets.push("collection = ?");
    vals.push(normCollection(patch.collection));
  }
  if (typeof patch.image === "string") {
    sets.push("image = ?");
    vals.push(patch.image.trim().slice(0, 500));
  }
  if (!sets.length) return;
  sets.push("updated_at = datetime('now')");
  await db()
    .prepare(`UPDATE seed_items SET ${sets.join(", ")} WHERE id = ?`)
    .bind(...vals, id)
    .run();
}

// Absolute per-bucket edit at one location (the numbers typed in the UI).
export async function updateStock(
  itemId: number,
  location: string,
  patch: Partial<Record<BucketCol, number>>,
): Promise<void> {
  const loc = normLocation(location);
  const cols: string[] = [];
  const vals: number[] = [];
  for (const col of BUCKET_COLS) {
    const val = patch[col];
    if (typeof val === "number" && Number.isFinite(val)) {
      cols.push(col);
      vals.push(Math.trunc(val));
    }
  }
  if (!cols.length) return;
  // A hand-typed correction pushes the same delta to Shopify a sale would,
  // otherwise every manual fix silently widens the gap with the store.
  const before = await db()
    .prepare(`SELECT ${BUCKET_COLS.join(", ")} FROM seed_stock WHERE item_id = ? AND location = ?`)
    .bind(itemId, loc)
    .first<Record<string, number>>();
  const stmts: D1PreparedStatement[] = [
    db()
      .prepare(
        `INSERT INTO seed_stock (item_id, location, ${cols.join(", ")})
         VALUES (?, ?, ${cols.map(() => "?").join(", ")})
         ON CONFLICT(item_id, location) DO UPDATE SET ${cols
           .map((c) => `${c} = excluded.${c}`)
           .join(", ")}, updated_at = datetime('now')`,
      )
      .bind(itemId, loc, ...vals),
  ];
  cols.forEach((col, i) => {
    const delta = vals[i] - (before?.[col] ?? 0);
    if (delta !== 0) stmts.push(pushQueueStmt(itemId, SIZE_OF_COL[col] ?? "", delta, "stock-edit"));
  });
  await db().batch(stmts);
}

// Outbound Shopify sync: queue the store-side delta atomically with the
// stock change. Drained from the Durable Object (egress lives there, see
// drainShopifyPushQueue in shopify.server.ts). Only gifts, manual sales and
// hand corrections queue; synced online orders are skipped so the store
// never gets double-adjusted.
function pushQueueStmt(
  itemId: number,
  size: string,
  delta: number,
  reason: string,
): D1PreparedStatement {
  // A "physical only" item (kept out of the store on purpose) never queues.
  return db()
    .prepare(
      "INSERT INTO shopify_push_queue (item_id, size, delta, reason) SELECT ?, ?, ?, ? WHERE COALESCE((SELECT web_status FROM seed_items WHERE id = ?), 'listed') <> 'physical_only'",
    )
    .bind(itemId, normSize(size), delta, reason, itemId);
}

/** A sale that came from the store: the store already knows about it. */
export function isSyncedSale(sale: { note?: string | null; pay_method?: string | null; order_ref?: string | null }): boolean {
  if (typeof sale.note === "string" && sale.note.startsWith("Shopify ")) return true;
  return sale.pay_method === "shopify" && /^#\d/.test(sale.order_ref ?? "");
}

// Relative bucket adjustment at one location, signed (returns, corrections).
export async function adjustStock(
  itemId: number,
  location: string,
  size: string,
  delta: number,
): Promise<void> {
  if (!delta) return;
  await adjustStockStmt(itemId, normLocation(location), size, delta).run();
}

// Add stock at a location (new shipment / allocation): relative, not absolute.
export async function receiveStock(
  itemId: number,
  location: string,
  size: string,
  qty: number,
): Promise<void> {
  if (qty < 1) return;
  await db().batch([
    adjustStockStmt(itemId, normLocation(location), size, qty),
    pushQueueStmt(itemId, size, qty, "receive"),
  ]);
}

// Move qty of one size between the two locations, in one batch. Stock in
// the store does not change (same total), so nothing is queued.
export async function transferStock(
  itemId: number,
  from: string,
  to: string,
  size: string,
  qty: number,
): Promise<void> {
  const src = normLocation(from);
  const dst = normLocation(to);
  if (src === dst || qty < 1) return;
  await db().batch([
    adjustStockStmt(itemId, src, size, -qty),
    adjustStockStmt(itemId, dst, size, qty),
  ]);
}

export async function deleteItem(id: number): Promise<void> {
  // Gifts and sales keep their item_label snapshot; detach so stock ops stop applying.
  await db().batch([
    db().prepare("UPDATE seed_gifts SET item_id = NULL WHERE item_id = ?").bind(id),
    db().prepare("UPDATE seed_sales SET item_id = NULL WHERE item_id = ?").bind(id),
    db().prepare("DELETE FROM seed_stock WHERE item_id = ?").bind(id),
    db().prepare("DELETE FROM shopify_push_queue WHERE item_id = ?").bind(id),
    db().prepare("DELETE FROM seed_items WHERE id = ?").bind(id),
  ]);
}

async function bucketAt(itemId: number, location: string, size: string): Promise<number> {
  const col = stockCol(size);
  const row = await db()
    .prepare(`SELECT ${col} AS v FROM seed_stock WHERE item_id = ? AND location = ?`)
    .bind(itemId, location)
    .first<{ v: number }>();
  return row?.v ?? 0;
}

export async function addGift(input: {
  itemId: number;
  person: string;
  handle: string;
  kind: string;
  qty: number;
  size: string;
  location: string;
  status: string;
  note: string;
  givenAt: string;
}): Promise<{ label: string; stockLeft: number } | null> {
  const item = await db()
    .prepare("SELECT id, name, size FROM seed_items WHERE id = ?")
    .bind(input.itemId)
    .first<{ id: number; name: string; size: string }>();
  if (!item) return null;
  const label = item.size ? `${item.name} (${item.size})` : item.name;
  const size = normSize(input.size);
  const loc = normLocation(input.location);
  const before = await bucketAt(item.id, loc, size);
  await db().batch([
    db()
      .prepare(
        `INSERT INTO seed_gifts (item_id, item_label, person, handle, kind, qty, size, location, status, note, given_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        item.id,
        label,
        input.person,
        input.handle,
        input.kind,
        input.qty,
        size,
        loc,
        GIFT_STATUSES.has(input.status) ? input.status : "given",
        input.note,
        input.givenAt,
      ),
    adjustStockStmt(item.id, loc, size, -input.qty),
    pushQueueStmt(item.id, size, -input.qty, "gift"),
  ]);
  return { label, stockLeft: before - input.qty };
}

// qty/size edits move stock between buckets AT THE LINE'S LOCATION: restore
// the old (size, qty), deduct the new (size, qty). Shared by gifts and sales.
function bucketMoveStmts(
  itemId: number | null,
  location: string,
  oldSize: string,
  oldQty: number,
  newSize: string,
  newQty: number,
): D1PreparedStatement[] {
  if (itemId === null) return [];
  if (stockCol(oldSize) === stockCol(newSize) && oldQty === newQty) return [];
  const loc = normLocation(location);
  return [
    adjustStockStmt(itemId, loc, oldSize, oldQty),
    adjustStockStmt(itemId, loc, newSize, -newQty),
  ];
}

export async function updateGift(
  id: number,
  patch: {
    person?: string;
    handle?: string;
    kind?: string;
    qty?: number;
    size?: string;
    status?: string;
    note?: string;
    given_at?: string;
  },
): Promise<void> {
  const sets: string[] = [];
  const vals: (string | number)[] = [];
  for (const key of ["person", "handle", "note", "given_at"] as const) {
    const val = patch[key];
    if (typeof val === "string") {
      sets.push(`${key} = ?`);
      vals.push(val);
    }
  }
  // kind accepts the presets OR any custom label the partners type themselves.
  if (typeof patch.kind === "string" && patch.kind.trim()) {
    sets.push("kind = ?");
    vals.push(patch.kind.trim().slice(0, 30));
  }
  if (typeof patch.status === "string" && GIFT_STATUSES.has(patch.status)) {
    sets.push("status = ?");
    vals.push(patch.status);
  }
  const stmts: D1PreparedStatement[] = [];
  const qtyChange = typeof patch.qty === "number" && patch.qty > 0;
  const sizeChange = typeof patch.size === "string";
  if (qtyChange || sizeChange) {
    const current = await db()
      .prepare("SELECT item_id, qty, size, location FROM seed_gifts WHERE id = ?")
      .bind(id)
      .first<{ item_id: number | null; qty: number; size: string; location: string }>();
    if (current) {
      const newQty = qtyChange ? Math.trunc(patch.qty as number) : current.qty;
      const newSize = sizeChange ? normSize(patch.size as string) : current.size;
      if (qtyChange) {
        sets.push("qty = ?");
        vals.push(newQty);
      }
      if (sizeChange) {
        sets.push("size = ?");
        vals.push(newSize);
      }
      stmts.push(...bucketMoveStmts(current.item_id, current.location, current.size, current.qty, newSize, newQty));
      if (current.item_id !== null && (normSize(current.size) !== normSize(newSize) || current.qty !== newQty)) {
        stmts.push(pushQueueStmt(current.item_id, current.size, current.qty, "gift-edit"));
        stmts.push(pushQueueStmt(current.item_id, newSize, -newQty, "gift-edit"));
      }
    }
  }
  if (!sets.length) return;
  sets.push("updated_at = datetime('now')");
  stmts.unshift(
    db()
      .prepare(`UPDATE seed_gifts SET ${sets.join(", ")} WHERE id = ?`)
      .bind(...vals, id),
  );
  await db().batch(stmts);
}

export async function deleteGift(id: number): Promise<void> {
  const gift = await db()
    .prepare("SELECT item_id, qty, size, location FROM seed_gifts WHERE id = ?")
    .bind(id)
    .first<{ item_id: number | null; qty: number; size: string; location: string }>();
  if (!gift) return;
  const stmts = [db().prepare("DELETE FROM seed_gifts WHERE id = ?").bind(id)];
  if (gift.item_id !== null) {
    stmts.push(adjustStockStmt(gift.item_id, normLocation(gift.location), gift.size, gift.qty));
    stmts.push(pushQueueStmt(gift.item_id, gift.size, gift.qty, "gift-del"));
  }
  await db().batch(stmts);
}

// Persist a manual row order (0..n-1 per grouped row). Table name is from a
// fixed whitelist: it gets interpolated into SQL.
export async function setPositions(
  table: "seed_gifts" | "seed_sales",
  orders: { ids: number[]; position: number }[],
): Promise<void> {
  const stmts: D1PreparedStatement[] = [];
  for (const order of orders) {
    if (!order.ids.length) continue;
    stmts.push(
      db()
        .prepare(`UPDATE ${table} SET position = ? WHERE id IN (${order.ids.map(() => "?").join(",")})`)
        .bind(order.position, ...order.ids),
    );
  }
  if (stmts.length) await db().batch(stmts);
}

// ---- Sales: same stock rules as gifts ----

// Running totals for today's pop-up sales: the board message shows the
// event's live score after every sale.
export async function popupTodayTotals(): Promise<{ count: number; revenue: number }> {
  const row = await db()
    .prepare(
      "SELECT COALESCE(SUM(qty), 0) AS c, COALESCE(SUM(qty * price), 0) AS r FROM seed_sales WHERE channel = 'popup' AND ship_status <> 'cancelled' AND sold_at = date('now')",
    )
    .first<{ c: number; r: number }>();
  return { count: row?.c ?? 0, revenue: row?.r ?? 0 };
}

export async function addSale(input: {
  itemId: number;
  buyer: string;
  buyerPhone?: string;
  buyerEmail?: string;
  buyerAddress?: string;
  qty: number;
  size: string;
  location: string;
  price: number;
  payMethod?: string;
  channel?: string;
  note: string;
  soldAt: string;
  orderRef?: string;
  delivery?: string;
  /** Who handled the sale ('' | avia | lior). The API passes the actor. */
  handledBy?: string;
}): Promise<{ label: string; stockLeft: number } | null> {
  const item = await db()
    .prepare("SELECT id, name, size FROM seed_items WHERE id = ?")
    .bind(input.itemId)
    .first<{ id: number; name: string; size: string }>();
  if (!item) return null;
  const label = item.size ? `${item.name} (${item.size})` : item.name;
  const size = normSize(input.size);
  const loc = normLocation(input.location);
  const before = await bucketAt(item.id, loc, size);
  const delivery = ["", "ship", "pickup", "hand"].includes(input.delivery ?? "") ? (input.delivery ?? "") : "";
  const insert = db()
    .prepare(
      `INSERT INTO seed_sales (item_id, item_label, buyer, buyer_phone, buyer_email, buyer_address, qty, size, location, price, pay_method, channel, note, sold_at, order_ref, delivery, handled_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      item.id,
      label,
      input.buyer,
      input.buyerPhone ?? "",
      input.buyerEmail ?? "",
      input.buyerAddress ?? "",
      input.qty,
      size,
      loc,
      input.price,
      PAY_METHODS.has(input.payMethod ?? "") ? (input.payMethod ?? "") : "",
      SALE_CHANNELS.has(input.channel ?? "") ? (input.channel ?? "") : "",
      input.note,
      input.soldAt,
      (input.orderRef ?? "").slice(0, 40),
      delivery,
      normHandledBy(input.handledBy),
    );
  await db().batch([
    insert,
    adjustStockStmt(item.id, loc, size, -input.qty),
    pushQueueStmt(item.id, size, -input.qty, "sale"),
  ]);
  return { label, stockLeft: before - input.qty };
}

export async function updateSale(
  id: number,
  patch: {
    buyer?: string;
    buyer_phone?: string;
    buyer_email?: string;
    buyer_address?: string;
    qty?: number;
    size?: string;
    price?: number;
    ship_status?: string;
    pay_method?: string;
    note?: string;
    sold_at?: string;
    channel?: string;
    delivery?: string;
    handled_by?: string;
  },
): Promise<void> {
  const sets: string[] = [];
  const vals: (string | number)[] = [];
  for (const key of ["buyer", "buyer_phone", "buyer_email", "buyer_address", "note", "sold_at"] as const) {
    const val = patch[key];
    if (typeof val === "string") {
      sets.push(`${key} = ?`);
      vals.push(val);
    }
  }
  if (typeof patch.channel === "string" && SALE_CHANNELS.has(patch.channel)) {
    sets.push("channel = ?");
    vals.push(patch.channel);
  }
  if (typeof patch.delivery === "string" && ["", "ship", "pickup", "hand"].includes(patch.delivery)) {
    sets.push("delivery = ?");
    vals.push(patch.delivery);
  }
  if (typeof patch.handled_by === "string") {
    sets.push("handled_by = ?");
    vals.push(normHandledBy(patch.handled_by));
  }
  if (typeof patch.ship_status === "string" && SHIP_STATUSES.has(patch.ship_status)) {
    sets.push("ship_status = ?");
    vals.push(patch.ship_status);
  }
  // Cancelling puts the units back on the shelf (and un-cancelling takes them
  // again), mirroring deleteSale's restore, including the Shopify push guard:
  // a sale that CAME from the store is restocked there by the refund itself.
  const cancelStmts: D1PreparedStatement[] = [];
  if (typeof patch.ship_status === "string" && SHIP_STATUSES.has(patch.ship_status)) {
    const before = await db()
      .prepare("SELECT item_id, qty, size, location, note, pay_method, order_ref, ship_status FROM seed_sales WHERE id = ?")
      .bind(id)
      .first<{
        item_id: number | null;
        qty: number;
        size: string;
        location: string;
        note: string;
        pay_method: string;
        order_ref: string;
        ship_status: string;
      }>();
    const wasCancelled = before?.ship_status === "cancelled";
    const nowCancelled = patch.ship_status === "cancelled";
    if (before && before.item_id !== null && wasCancelled !== nowCancelled) {
      const delta = nowCancelled ? before.qty : -before.qty;
      cancelStmts.push(adjustStockStmt(before.item_id, normLocation(before.location), before.size, delta));
      if (!isSyncedSale(before)) {
        cancelStmts.push(pushQueueStmt(before.item_id, before.size, delta, nowCancelled ? "sale-cancel" : "sale-uncancel"));
      }
    }
  }
  if (typeof patch.pay_method === "string" && PAY_METHODS.has(patch.pay_method)) {
    sets.push("pay_method = ?");
    vals.push(patch.pay_method);
  }
  if (typeof patch.price === "number" && Number.isFinite(patch.price) && patch.price >= 0) {
    sets.push("price = ?");
    vals.push(patch.price);
  }
  const stmts: D1PreparedStatement[] = [];
  const qtyChange = typeof patch.qty === "number" && patch.qty > 0;
  const sizeChange = typeof patch.size === "string";
  if (qtyChange || sizeChange) {
    const current = await db()
      .prepare("SELECT item_id, qty, size, location, note, pay_method, order_ref FROM seed_sales WHERE id = ?")
      .bind(id)
      .first<{
        item_id: number | null;
        qty: number;
        size: string;
        location: string;
        note: string;
        pay_method: string;
        order_ref: string;
      }>();
    if (current) {
      const newQty = qtyChange ? Math.trunc(patch.qty as number) : current.qty;
      const newSize = sizeChange ? normSize(patch.size as string) : current.size;
      if (qtyChange) {
        sets.push("qty = ?");
        vals.push(newQty);
      }
      if (sizeChange) {
        sets.push("size = ?");
        vals.push(newSize);
      }
      stmts.push(...bucketMoveStmts(current.item_id, current.location, current.size, current.qty, newSize, newQty));
      if (
        current.item_id !== null &&
        !isSyncedSale(current) &&
        (normSize(current.size) !== normSize(newSize) || current.qty !== newQty)
      ) {
        stmts.push(pushQueueStmt(current.item_id, current.size, current.qty, "sale-edit"));
        stmts.push(pushQueueStmt(current.item_id, newSize, -newQty, "sale-edit"));
      }
    }
  }
  if (!sets.length) return;
  sets.push("updated_at = datetime('now')");
  stmts.push(...cancelStmts);
  stmts.unshift(
    db()
      .prepare(`UPDATE seed_sales SET ${sets.join(", ")} WHERE id = ?`)
      .bind(...vals, id),
  );
  await db().batch(stmts);
}

export async function deleteSale(id: number): Promise<void> {
  const sale = await db()
    .prepare("SELECT item_id, qty, size, location, note, pay_method, order_ref, ship_status FROM seed_sales WHERE id = ?")
    .bind(id)
    .first<{
      item_id: number | null;
      qty: number;
      size: string;
      location: string;
      note: string;
      pay_method: string;
      order_ref: string;
      ship_status: string;
    }>();
  if (!sale) return;
  const stmts = [db().prepare("DELETE FROM seed_sales WHERE id = ?").bind(id)];
  // A cancelled line already gave its units back.
  if (sale.item_id !== null && sale.ship_status !== "cancelled") {
    stmts.push(adjustStockStmt(sale.item_id, normLocation(sale.location), sale.size, sale.qty));
    if (!isSyncedSale(sale)) stmts.push(pushQueueStmt(sale.item_id, sale.size, sale.qty, "sale-del"));
  }
  await db().batch(stmts);
}

// ---- Text helpers for Hobi and the digests ----

const LOCATION_HE_SHORT: Record<string, string> = { avia: "אצל אביה", lior: "אצל ליאור" };

/** Stock summary as plain lines, per item and location, for the assistant
 *  and the daily digest. Totals across sizes. */
export async function stockDigest(): Promise<string> {
  const { items } = await getSeeding();
  if (!items.length) return "אין פריטים במלאי.";
  const sum = (r: StockRow) => r.qty + r.qty_xs + r.qty_s + r.qty_m + r.qty_l + r.qty_xl + r.qty_xxl;
  const lines = items.map((i) => {
    const total = i.stock.reduce((a, r) => a + sum(r), 0);
    const parts = LOCATIONS.map((loc) => {
      const row = i.stock.find((r) => r.location === loc);
      return `${LOCATION_HE_SHORT[loc]} ${row ? sum(row) : 0}`;
    });
    return `- ${i.name}${i.size ? ` (${i.size})` : ""} [${i.collection}]: ${total} (${parts.join(", ")}) · נמכרו ${i.sold} · חולקו ${i.given}`;
  });
  return lines.join("\n");
}

const csvCell = (v: unknown): string => {
  const s = v === null || v === undefined ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** Sales ledger as CSV (UTF-8, comma), newest first. */
export async function salesCsv(): Promise<string> {
  const { sales } = await getSeeding();
  const head = ["id", "sold_at", "buyer", "buyer_phone", "buyer_email", "item", "size", "qty", "price", "total", "pay_method", "ship_status", "channel", "location", "handled_by", "order_ref", "delivery", "note"];
  const rows = sales.map((s) =>
    [s.id, s.sold_at, s.buyer, s.buyer_phone, s.buyer_email, s.item_label, s.size, s.qty, s.price, s.price * s.qty, s.pay_method, s.ship_status, s.channel, s.location, s.handled_by, s.order_ref, s.delivery, s.note]
      .map(csvCell)
      .join(","),
  );
  return [head.join(","), ...rows].join("\n");
}

/** Stock matrix as CSV: one row per item × location. */
export async function stockCsv(): Promise<string> {
  const { items } = await getSeeding();
  const head = ["item_id", "name", "collection", "price", "unit_cost", "location", ...BUCKET_COLS, "total"];
  const rows: string[] = [];
  for (const i of items) {
    for (const loc of LOCATIONS) {
      const r = i.stock.find((x) => x.location === loc);
      const buckets = BUCKET_COLS.map((c) => r?.[c] ?? 0);
      rows.push([i.id, i.name, i.collection, i.price, i.unit_cost, loc, ...buckets, buckets.reduce((a, b) => a + b, 0)].map(csvCell).join(","));
    }
  }
  return [head.join(","), ...rows].join("\n");
}
