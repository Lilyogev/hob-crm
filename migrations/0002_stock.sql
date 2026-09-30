-- hob stock (מלאי): items, stock per location, gifts log, sales ledger and the
-- outbound Shopify push queue that stock changes write to. Additive only,
-- no business numbers.

-- Catalog item. collection is free text ('main' by default): the list on
-- screen is the distinct values in this table. unit_cost = what one unit
-- cost to make (for margin), price = list price. web_status 'listed' =
-- should exist in the store; 'physical_only' = kept out of the store on
-- purpose (web_reason says why) and never pushed to Shopify.
CREATE TABLE IF NOT EXISTS seed_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  size TEXT NOT NULL DEFAULT '',
  price REAL NOT NULL DEFAULT 0,
  unit_cost REAL NOT NULL DEFAULT 0,
  collection TEXT NOT NULL DEFAULT 'main',
  image TEXT NOT NULL DEFAULT '',
  web_status TEXT NOT NULL DEFAULT 'listed',   -- listed | physical_only
  web_reason TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Physical stock: one row per (item, location) with the size matrix.
-- location = 'avia' | 'lior' (src/lib/partners.ts LOCATIONS). qty = the
-- no-size bucket (caps, unsorted). Buckets may go negative: the UI shows it
-- in red so a counting mistake is visible instead of silently clamped.
CREATE TABLE IF NOT EXISTS seed_stock (
  item_id INTEGER NOT NULL,
  location TEXT NOT NULL,
  qty INTEGER NOT NULL DEFAULT 0,
  qty_xs INTEGER NOT NULL DEFAULT 0,
  qty_s INTEGER NOT NULL DEFAULT 0,
  qty_m INTEGER NOT NULL DEFAULT 0,
  qty_l INTEGER NOT NULL DEFAULT 0,
  qty_xl INTEGER NOT NULL DEFAULT 0,
  qty_xxl INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (item_id, location)
);

-- Gifts (influencers, friends, collabs). A line decrements the size bucket at
-- its location; item_label is a snapshot so the log stays readable after the
-- item is deleted. status: promised | given | story | posted.
CREATE TABLE IF NOT EXISTS seed_gifts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id INTEGER,
  item_label TEXT NOT NULL DEFAULT '',
  person TEXT NOT NULL,
  handle TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL DEFAULT 'influencer',
  qty INTEGER NOT NULL DEFAULT 1,
  size TEXT NOT NULL DEFAULT '',
  location TEXT NOT NULL DEFAULT 'avia',
  status TEXT NOT NULL DEFAULT 'given',
  note TEXT NOT NULL DEFAULT '',
  given_at TEXT NOT NULL DEFAULT '',            -- YYYY-MM-DD
  position INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_seed_gifts_item ON seed_gifts (item_id);

-- Sales ledger: one row per order line. price = unit price in ILS.
-- pay_method: '' | shopify | bit | cash | transfer. channel: '' (store /
-- manual) | popup | archive. ship_status: recorded | packed | shipped |
-- delivered | cancelled. order_ref = the Shopify order name (#1234) or a
-- manual merge key; delivery: '' | ship | pickup | hand.
-- handled_by: who handled the sale ('' | avia | lior); defaults to the
-- partner who logged it.
CREATE TABLE IF NOT EXISTS seed_sales (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id INTEGER,
  item_label TEXT NOT NULL DEFAULT '',
  buyer TEXT NOT NULL DEFAULT '',
  buyer_phone TEXT NOT NULL DEFAULT '',
  buyer_email TEXT NOT NULL DEFAULT '',
  buyer_address TEXT NOT NULL DEFAULT '',
  qty INTEGER NOT NULL DEFAULT 1,
  size TEXT NOT NULL DEFAULT '',
  location TEXT NOT NULL DEFAULT 'avia',
  price REAL NOT NULL DEFAULT 0,
  ship_status TEXT NOT NULL DEFAULT 'recorded',
  pay_method TEXT NOT NULL DEFAULT '',
  channel TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  sold_at TEXT NOT NULL DEFAULT '',             -- YYYY-MM-DD ('' = use created_at)
  order_ref TEXT NOT NULL DEFAULT '',
  delivery TEXT NOT NULL DEFAULT '',
  handled_by TEXT NOT NULL DEFAULT '',
  position INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_seed_sales_order_ref ON seed_sales (order_ref);
CREATE INDEX IF NOT EXISTS idx_seed_sales_item ON seed_sales (item_id);
CREATE INDEX IF NOT EXISTS idx_seed_sales_sold_at ON seed_sales (sold_at);

-- Outbound Shopify stock sync. Every gift / manual sale / hand-typed stock
-- correction queues its delta here atomically (seeding.server.ts); the
-- Durable Object drains it (shopify.server.ts). Store orders that were synced
-- in never queue, so the store is not adjusted twice.
CREATE TABLE IF NOT EXISTS shopify_push_queue (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id INTEGER NOT NULL,
  size TEXT NOT NULL DEFAULT '',
  delta INTEGER NOT NULL,
  reason TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Which location a Shopify order ships from (stock is deducted there).
INSERT OR IGNORE INTO settings (key, value) VALUES ('shopify_stock_location', 'avia');
