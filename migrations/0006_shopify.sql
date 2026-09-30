-- Shopify integration (see SHOPIFY.md). Additive only, no business numbers.
--
-- seed_variant_map: which Shopify variant each (item, size) of the stock
-- module maps to. Built by "מפה מוצרים" (shopify_map) from live store data.
-- shopify_push_queue: pending store-side inventory deltas, written by the
-- stock module atomically with every manual stock change and drained from
-- the Durable Object (the only place with egress). Push runs only after a
-- successful map set settings.shopify_push_enabled = '1'.
CREATE TABLE IF NOT EXISTS seed_variant_map (
  item_id INTEGER NOT NULL,
  size TEXT NOT NULL DEFAULT '',
  variant_id TEXT NOT NULL,
  inventory_item_id TEXT NOT NULL,
  variant_title TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (item_id, size)
);

CREATE TABLE IF NOT EXISTS shopify_push_queue (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id INTEGER NOT NULL,
  size TEXT NOT NULL DEFAULT '',
  delta INTEGER NOT NULL,
  reason TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Structural defaults. shop_domain / store_url live in 0001_core.sql.
-- shopify_stock_location: which partner's stock a store order leaves from
-- ('avia' | 'lior', see src/lib/partners.ts). shopify_location_id is cached
-- by the code after the first map run.
INSERT OR IGNORE INTO settings (key, value) VALUES
  ('shopify_stock_location', 'avia'),
  ('shopify_push_enabled', '0');
