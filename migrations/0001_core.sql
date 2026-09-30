-- hob CRM core: settings, users, sessions, rate limits, tasks board, reminders,
-- notifications, Hobi's chat. Additive only. No password, secret or real
-- number ever goes in a migration (users are created with scripts/create-user.mjs).

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Two partners, both owners. key = 'avia' | 'lior' (see src/lib/partners.ts).
-- pass_hash = pbkdf2-sha256$<iterations>$<saltHex>$<hashHex>.
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  key TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  pass_hash TEXT NOT NULL DEFAULT '',
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- One random token per login; the cookie is the token. Logout deletes the row.
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen TEXT NOT NULL DEFAULT (datetime('now')),
  ua TEXT NOT NULL DEFAULT ''
);

-- Login brute-force protection: failed attempts per client IP.
CREATE TABLE IF NOT EXISTS login_attempts (
  ip TEXT PRIMARY KEY,
  fails INTEGER NOT NULL DEFAULT 0,
  window_start TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Generic per-key rate limiting for the public routes.
CREATE TABLE IF NOT EXISTS rate_limits (
  key TEXT PRIMARY KEY,
  hits INTEGER NOT NULL DEFAULT 0,
  window_start TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Tasks board (Monday style). A group is a lane inside a view:
-- view = 'shared' | 'avia' | 'lior'. Owner on a task = '' | avia | lior | both.
CREATE TABLE IF NOT EXISTS board_groups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  view TEXT NOT NULL DEFAULT 'shared',
  title TEXT NOT NULL,
  color TEXT NOT NULL DEFAULT '#579bfc',
  position INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  group_id INTEGER NOT NULL,
  title TEXT NOT NULL,
  notes TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'not_started',   -- not_started | working | stuck | done | archived
  priority TEXT NOT NULL DEFAULT '',            -- '' | high | medium | low
  owner TEXT NOT NULL DEFAULT '',               -- '' | avia | lior | both
  due_date TEXT NOT NULL DEFAULT '',            -- YYYY-MM-DD or ''
  position INTEGER NOT NULL DEFAULT 0,
  created_by TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_tasks_group ON tasks (group_id, position);

INSERT OR IGNORE INTO board_groups (id, view, title, color, position) VALUES
  (1, 'shared', 'משותף',       '#cab641', 1),
  (2, 'shared', 'מעקב משותף',  '#7f5347', 2),
  (3, 'avia',   'אביה',        '#a25ddc', 3),
  (4, 'avia',   'מעקב אביה',   '#bb3354', 4),
  (5, 'lior',   'ליאור',       '#579bfc', 5),
  (6, 'lior',   'מעקב ליאור',  '#0086c0', 6),
  (7, 'shared', 'השבוע',       '#00c875', 7);

-- Timed reminders ("תזכירי לי מחר ב-10"). fire_at is UTC ISO.
CREATE TABLE IF NOT EXISTS reminders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id INTEGER NOT NULL DEFAULT 1,
  fire_at TEXT NOT NULL,
  text TEXT NOT NULL,
  done INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Web Push: one subscription per device; the push carries no payload, the
-- service worker pulls the latest row of push_outbox.
CREATE TABLE IF NOT EXISTS push_subs (
  endpoint TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL DEFAULT 0,
  ua TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_ok_at TEXT
);
CREATE TABLE IF NOT EXISTS push_outbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  url TEXT NOT NULL DEFAULT '/?tab=hobi',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Notification gate log (quiet hours, daily cap, dedupe per topic).
CREATE TABLE IF NOT EXISTS notify_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  level TEXT NOT NULL,                    -- now | morning | weekly | silent
  topic TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  url TEXT NOT NULL DEFAULT '/?tab=hobi',
  status TEXT NOT NULL,                   -- sent | held | dropped | logged
  reason TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  sent_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_notify_log_status ON notify_log(status, created_at);
CREATE INDEX IF NOT EXISTS idx_notify_log_topic ON notify_log(topic, created_at);

-- Hobi's chat. chat_id 1 = the board thread. kind '' = a real turn the model
-- reads as history; 'note' = a board notification (text typed by strangers:
-- signups, buyers) shown in the chat but never sent to the model.
CREATE TABLE IF NOT EXISTS assistant_chat (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id INTEGER NOT NULL DEFAULT 1,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  content TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT '',
  actor TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_assistant_chat_chat ON assistant_chat (chat_id, id);

-- Actions Hobi holds for confirmation (a voice command that changes money,
-- stock or shipping). 15-minute TTL.
CREATE TABLE IF NOT EXISTS assistant_pending (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tool TEXT NOT NULL,
  input TEXT NOT NULL,
  summary TEXT NOT NULL,
  actor TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending',   -- pending | executing | done | failed | cancelled | expired
  result TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL DEFAULT (datetime('now', '+15 minutes'))
);

-- Facts Hobi remembers ("remember" tool) and the brand context she reads.
CREATE TABLE IF NOT EXISTS brand_memory (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  fact TEXT NOT NULL,
  actor TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Defaults. Only structure, never a business number.
INSERT OR IGNORE INTO settings (key, value) VALUES
  ('brand_name', 'House of Bais'),
  ('assistant_name', 'הובי'),
  ('brand_context', ''),
  ('owner_context', ''),
  ('shop_domain', ''),
  ('store_url', ''),
  ('collab_domain', ''),
  ('collab_discount_pct', '10'),
  ('collab_commission_pct', '10'),
  ('vat_exempt', '1'),
  ('fee_rates', '{"shopify":0.024}');
