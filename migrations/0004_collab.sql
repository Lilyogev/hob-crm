-- Influencer collab program (משפיענים). Additive only, no seeded rows: the
-- first campaign row is created lazily by the app (structure only, no
-- numbers). Percentages, domains and the store URL live in `settings`
-- (collab_domain, store_url, collab_discount_pct, collab_commission_pct).

-- One active campaign at a time: the copy the public invite page shows.
CREATE TABLE IF NOT EXISTS collab_campaigns (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  product_name TEXT NOT NULL DEFAULT '',
  product_value INTEGER NOT NULL DEFAULT 0,
  asks TEXT NOT NULL DEFAULT '["רילס אחד","סטורי עם תיוג"]',   -- JSON list
  brief TEXT NOT NULL DEFAULT '',
  sizes TEXT NOT NULL DEFAULT '["S","M","L","XL"]',            -- JSON list
  colors TEXT NOT NULL DEFAULT '[]',                            -- JSON list
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Optional fixed products per campaign (a link may offer one fixed product
-- instead of a pick from real stock). Empty sizes = one-size.
CREATE TABLE IF NOT EXISTS collab_products (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  campaign_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  value INTEGER NOT NULL DEFAULT 0,
  image TEXT NOT NULL DEFAULT '',
  sizes TEXT NOT NULL DEFAULT '[]',
  colors TEXT NOT NULL DEFAULT '[]',
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Personal invite links (/c/<token>). product_id NULL = she picks from
-- stock (up to `picks` items). discount_code = her personal store code;
-- code_ended_at '' = active. handled_by = which partner runs this collab.
CREATE TABLE IF NOT EXISTS collab_links (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  token TEXT NOT NULL UNIQUE,
  campaign_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  instagram TEXT NOT NULL DEFAULT '',
  product_id INTEGER,
  picks INTEGER NOT NULL DEFAULT 1,
  views INTEGER NOT NULL DEFAULT 0,
  discount_code TEXT NOT NULL DEFAULT '',
  sale_clicks INTEGER NOT NULL DEFAULT 0,
  personal_note TEXT NOT NULL DEFAULT '',
  is_generic INTEGER NOT NULL DEFAULT 0,
  gender TEXT NOT NULL DEFAULT '',               -- '' | m | f
  commission_paid REAL NOT NULL DEFAULT 0,
  combines_ok INTEGER NOT NULL DEFAULT 0,
  code_ended_at TEXT NOT NULL DEFAULT '',
  handled_by TEXT NOT NULL DEFAULT '',           -- '' | avia | lior
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_collab_links_campaign ON collab_links (campaign_id, id);
CREATE INDEX IF NOT EXISTS idx_collab_links_code ON collab_links (discount_code);

-- Signups from the public page. status: pending → signed → sent → posted → done.
-- items = JSON of picked stock items when more than one; item_id = first pick.
CREATE TABLE IF NOT EXISTS collab_signups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  link_id INTEGER,
  campaign_id INTEGER NOT NULL,
  full_name TEXT NOT NULL,
  instagram TEXT NOT NULL DEFAULT '',
  phone TEXT NOT NULL DEFAULT '',
  email TEXT NOT NULL DEFAULT '',
  size TEXT NOT NULL DEFAULT '',
  color TEXT NOT NULL DEFAULT '',
  product TEXT NOT NULL DEFAULT '',
  item_id INTEGER NOT NULL DEFAULT 0,
  items TEXT NOT NULL DEFAULT '',
  gift_logged INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending',
  status_at TEXT NOT NULL DEFAULT (datetime('now')),
  reel_url TEXT NOT NULL DEFAULT '',
  reel_views INTEGER NOT NULL DEFAULT 0,
  file_received INTEGER NOT NULL DEFAULT 0,
  address TEXT NOT NULL DEFAULT '',
  city TEXT NOT NULL DEFAULT '',
  apt TEXT NOT NULL DEFAULT '',
  floor TEXT NOT NULL DEFAULT '',
  is_private INTEGER NOT NULL DEFAULT 0,
  zip TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_collab_signups_campaign ON collab_signups (campaign_id, id);
CREATE INDEX IF NOT EXISTS idx_collab_signups_link ON collab_signups (link_id);

-- Sales attribution: an order paid with her code = her sale. order_key is
-- UNIQUE so a webhook retry never counts twice.
CREATE TABLE IF NOT EXISTS collab_sales (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  link_id INTEGER NOT NULL,
  order_key TEXT NOT NULL UNIQUE,
  order_name TEXT NOT NULL DEFAULT '',
  total REAL NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_collab_sales_link ON collab_sales (link_id, id);

-- Outreach list, kept by hand: who to approach, where the talk stands, the
-- next step and a free-text log (JSON [{at, text}]).
-- status: candidate | to_contact | contacted | talking | agreed | package_sent
--         | received | done | linked | rejected (archive, blocks duplicates)
CREATE TABLE IF NOT EXISTS collab_prospects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  instagram TEXT NOT NULL DEFAULT '',
  followers INTEGER NOT NULL DEFAULT 0,
  gender TEXT NOT NULL DEFAULT '',               -- '' | m | f
  niche TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  personal TEXT NOT NULL DEFAULT '',             -- the personal line on her invite page
  status TEXT NOT NULL DEFAULT 'to_contact',
  link_id INTEGER,
  next_step TEXT NOT NULL DEFAULT '',
  followup_date TEXT NOT NULL DEFAULT '',        -- YYYY-MM-DD or ''
  size TEXT NOT NULL DEFAULT '',
  log TEXT NOT NULL DEFAULT '[]',
  handled_by TEXT NOT NULL DEFAULT '',           -- '' | avia | lior
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_collab_prospects_status ON collab_prospects (status, followers DESC);
CREATE INDEX IF NOT EXISTS idx_collab_prospects_followup ON collab_prospects (followup_date);
