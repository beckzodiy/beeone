-- Adds GRAM (TON) payment support to an already-deployed database.
-- schema.sql already has these for fresh installs; this file is for the
-- existing production D1 database, where CREATE TABLE IF NOT EXISTS won't
-- add columns to a table that already exists.
--
-- Apply once with:
--   npx wrangler d1 execute mommy-knows-db --remote --file=migrations/0001_gram_payments.sql
-- Running it a second time will fail on "duplicate column name" — that's
-- expected and means it already applied.

ALTER TABLE orders ADD COLUMN payment_method TEXT NOT NULL DEFAULT 'cod';
ALTER TABLE orders ADD COLUMN payment_status TEXT;
ALTER TABLE orders ADD COLUMN gram_invoice_code TEXT;
ALTER TABLE orders ADD COLUMN gram_amount_nanotons TEXT;
ALTER TABLE orders ADD COLUMN gram_rate_aed REAL;
ALTER TABLE orders ADD COLUMN quote_expires_at TEXT;
ALTER TABLE orders ADD COLUMN gram_claimed_msg_hash TEXT;
ALTER TABLE orders ADD COLUMN paid_amount_nanotons TEXT;
ALTER TABLE orders ADD COLUMN tx_hash TEXT;
ALTER TABLE orders ADD COLUMN paid_at TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_gram_code ON orders(gram_invoice_code) WHERE gram_invoice_code IS NOT NULL;

CREATE TABLE IF NOT EXISTS gram_poll_state (
  id        INTEGER PRIMARY KEY CHECK (id = 1),
  last_lt   TEXT,
  last_hash TEXT
);
INSERT OR IGNORE INTO gram_poll_state (id, last_lt, last_hash) VALUES (1, NULL, NULL);
