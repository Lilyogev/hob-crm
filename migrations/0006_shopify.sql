-- Shopify integration (see SHOPIFY.md). Additive only, no business numbers.
--
-- seed_variant_map: which Shopify variant each (item, size) of the stock
-- module maps to. Built by "מפה מוצרים" (shopify_map) from live store data.
-- The outbound queue (shopify_push_queue) and settings.shopify_stock_location
-- live in 0002_stock.sql, next to the code that writes them.
CREATE TABLE IF NOT EXISTS seed_variant_map (
  item_id INTEGER NOT NULL,
  size TEXT NOT NULL DEFAULT '',
  variant_id TEXT NOT NULL,
  inventory_item_id TEXT NOT NULL,
  variant_title TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (item_id, size)
);

-- Structural default: the push to the store stays off until a successful
-- "מפה מוצרים" run flips it to '1'. shopify_location_id is cached by the code.
INSERT OR IGNORE INTO settings (key, value) VALUES ('shopify_push_enabled', '0');
