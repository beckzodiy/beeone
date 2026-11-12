-- Money is stored in fils (1 AED = 100 fils) to avoid float errors.
CREATE TABLE IF NOT EXISTS users (
  id           INTEGER PRIMARY KEY,          -- Telegram user id
  username     TEXT,
  first_name   TEXT,
  referred_by  TEXT,                         -- agent code (first-touch, permanent)
  created_at   TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS agents (
  code        TEXT PRIMARY KEY,
  user_id     INTEGER UNIQUE NOT NULL,
  name        TEXT,
  created_at  TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS orders (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id        INTEGER,                    -- NULL for orders from plain website (outside Telegram)
  customer_name  TEXT NOT NULL,
  phone          TEXT NOT NULL,
  address        TEXT NOT NULL,
  note           TEXT,
  items          TEXT NOT NULL,              -- JSON [{id,name,qty,price}]
  total          INTEGER NOT NULL,           -- fils
  agent_code     TEXT,
  commission     INTEGER NOT NULL DEFAULT 0, -- fils, counted only when status = 'delivered'
  status         TEXT NOT NULL DEFAULT 'pending', -- pending | confirmed | delivered | cancelled
  created_at     TEXT DEFAULT (datetime('now')),

  -- GRAM (TON) payment. NULL/'cod' fields mean a normal cash-on-delivery order.
  payment_method        TEXT NOT NULL DEFAULT 'cod', -- cod | gram
  payment_status        TEXT,                        -- NULL for cod; else awaiting|paid|expired|underpaid|overpaid|duplicate|late|unmatched
  gram_invoice_code     TEXT,                         -- unique on-chain comment identifying this order
  gram_amount_nanotons  TEXT,                         -- locked quote, nanotons as decimal string
  gram_rate_aed         REAL,                         -- AED per 1 GRAM at quote time, for audit
  quote_expires_at      TEXT,                         -- ISO datetime, quote valid until
  gram_claimed_msg_hash TEXT,                         -- msg_hash Telegram reported (untrusted, cross-check only)
  gram_widget_message_id INTEGER,                     -- the checkout widget message in the customer's chat
  paid_amount_nanotons  TEXT,                         -- actual amount matched on-chain
  tx_hash               TEXT,                         -- matched transaction hash (verified via TON API)
  paid_at               TEXT
);
CREATE INDEX IF NOT EXISTS idx_orders_agent ON orders(agent_code);
CREATE INDEX IF NOT EXISTS idx_orders_user  ON orders(user_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_gram_code ON orders(gram_invoice_code) WHERE gram_invoice_code IS NOT NULL;

CREATE TABLE IF NOT EXISTS payouts (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_code  TEXT NOT NULL,
  amount      INTEGER NOT NULL,              -- fils
  created_at  TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS clicks (
  agent_code  TEXT NOT NULL,
  day         TEXT NOT NULL,
  count       INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (agent_code, day)
);

-- Single-row cursor for incremental GRAM payment polling (see migrations/0001_gram_payments.sql).
CREATE TABLE IF NOT EXISTS gram_poll_state (
  id        INTEGER PRIMARY KEY CHECK (id = 1),
  last_lt   TEXT,
  last_hash TEXT
);
INSERT OR IGNORE INTO gram_poll_state (id, last_lt, last_hash) VALUES (1, NULL, NULL);
