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
  created_at     TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_orders_agent ON orders(agent_code);
CREATE INDEX IF NOT EXISTS idx_orders_user  ON orders(user_id);

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
