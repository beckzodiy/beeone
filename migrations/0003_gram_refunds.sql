-- Fallback checkout message (when Telegram refuses widgets), payer address, and refunds the admin sends by hand.
ALTER TABLE orders ADD COLUMN gram_pay_message_id INTEGER;
ALTER TABLE orders ADD COLUMN gram_payer_address TEXT;
CREATE TABLE IF NOT EXISTS gram_refunds (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id        INTEGER,                 -- NULL for a payment that matched no order
  to_address      TEXT NOT NULL,
  amount_nanotons TEXT NOT NULL,
  reason          TEXT NOT NULL,
  source_tx_hash  TEXT,                    -- the incoming payment being refunded
  status          TEXT NOT NULL DEFAULT 'pending', -- pending | sent
  tx_hash         TEXT,                    -- the outgoing refund, seen on-chain
  created_at      TEXT DEFAULT CURRENT_TIMESTAMP,
  sent_at         TEXT
);
