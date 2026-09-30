-- hob finance (כספים): expense journal, manual income, budgets per category,
-- receipt photos, drop-simulator scenarios and clearer settlements.
-- Additive only. No seeded categories, amounts or business numbers: the
-- partners add their own categories, and a budget of 0 means "not set".

-- One expense. payer = 'avia' | 'lior' (from her own pocket) | 'business'.
-- paid_from is only meaningful for the business: '' | bank | bit | cash.
-- vat / tax_id are read off a photographed receipt; 0 / '' when typed by hand.
CREATE TABLE IF NOT EXISTS fin_expenses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  date TEXT NOT NULL,                        -- YYYY-MM-DD
  payer TEXT NOT NULL DEFAULT 'business',
  category TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  amount REAL NOT NULL,
  paid_from TEXT NOT NULL DEFAULT '',
  vat REAL NOT NULL DEFAULT 0,
  tax_id TEXT NOT NULL DEFAULT '',
  created_by TEXT NOT NULL DEFAULT '',       -- '' | avia | lior | hobi
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_fin_expenses_date ON fin_expenses (date);
CREATE INDEX IF NOT EXISTS idx_fin_expenses_category ON fin_expenses (category);

-- Income typed by hand (a wholesale order, a pop-up day, anything the sales
-- ledger does not carry). Store orders live in seed_sales and are summed
-- separately; the two are added together on screen.
-- source: '' | shopify | popup | wholesale | other. handled_by: '' | avia | lior.
CREATE TABLE IF NOT EXISTS fin_income (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  date TEXT NOT NULL,                        -- YYYY-MM-DD
  amount REAL NOT NULL,
  source TEXT NOT NULL DEFAULT '',
  handled_by TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  created_by TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_fin_income_date ON fin_income (date);

-- Expense categories with an optional budget. The category list is whatever
-- rows exist here (the partners add them); amount 0 = no budget set.
CREATE TABLE IF NOT EXISTS fin_budgets (
  category TEXT PRIMARY KEY,
  amount REAL NOT NULL DEFAULT 0,
  position INTEGER NOT NULL DEFAULT 0
);

-- Receipt photos. Bytes live in R2 (STORAGE); only the key is here and it is
-- never handed to the browser (/api/receipt streams behind the cookie).
-- expense_id NULL = photographed before its expense was logged; the next
-- expense from the same chat claims it (claimPendingReceipt).
CREATE TABLE IF NOT EXISTS fin_receipts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  expense_id INTEGER,
  r2_key TEXT NOT NULL,
  mime TEXT NOT NULL DEFAULT 'image/jpeg',
  source TEXT NOT NULL DEFAULT 'board',      -- board | hobi
  chat_id TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_fin_receipts_expense ON fin_receipts (expense_id);

-- Saved drop scenarios (the simulator's DropSim JSON, round-tripped as is),
-- shared between the partners instead of living in one phone's localStorage.
CREATE TABLE IF NOT EXISTS fin_scenarios (
  name TEXT PRIMARY KEY,
  data TEXT NOT NULL,
  position INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Clearer payouts. A store sale is not bank money until the clearer pays
-- out: one row = one deposit that landed. net = what the bank statement
-- shows, gross = how much of the open store sales it closes, and the
-- difference is the clearer's fee. gross is fixed at insert time so a sale
-- logged late never rewrites an old settlement.
CREATE TABLE IF NOT EXISTS fin_settlements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  date TEXT NOT NULL,                        -- YYYY-MM-DD, the day it landed
  provider TEXT NOT NULL DEFAULT 'shopify',
  net REAL NOT NULL DEFAULT 0,
  gross REAL NOT NULL DEFAULT 0,
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_fin_settlements_date ON fin_settlements (date);

-- Every settlement add / delete is journaled, so a deleted deposit is still
-- in the history (with who did it and why it was allowed despite a doubt).
CREATE TABLE IF NOT EXISTS fin_settlement_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  settlement_id INTEGER,
  action TEXT NOT NULL,                      -- add | delete
  data TEXT NOT NULL DEFAULT '{}',
  actor TEXT NOT NULL DEFAULT '',
  reason TEXT NOT NULL DEFAULT '',
  at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_fin_settlement_log_sid ON fin_settlement_log (settlement_id);
