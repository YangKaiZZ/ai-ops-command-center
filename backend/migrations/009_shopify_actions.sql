-- shopify actions
-- Runs once per database, after every lower-numbered migration. Once it has
-- run anywhere, don't edit it: add another migration instead.

-- Holding and fulfilling orders in Shopify from here (services/orderActions.js).
-- With auto_hold on, an order the agent says HOLD is put on hold in Shopify
-- by itself. Off until the seller turns it on in Settings.
ALTER TABLE sellers ADD COLUMN auto_hold BOOLEAN NOT NULL DEFAULT FALSE;

-- Every hold, release and fulfillment tried from here, by the seller or the
-- agent, and whether Shopify took it.
CREATE TABLE order_actions (
  id INT AUTO_INCREMENT PRIMARY KEY,
  seller_id INT NOT NULL,
  order_id INT NOT NULL,
  action VARCHAR(16) NOT NULL,              -- hold, release or fulfill
  source VARCHAR(8) NOT NULL,               -- seller or agent
  fulfillment_order_id VARCHAR(100) NULL,   -- Shopify's id, the number only
  reason VARCHAR(32) NULL,                  -- a hold's reason, e.g. HIGH_RISK_OF_FRAUD
  note VARCHAR(255) NULL,                   -- a hold's note, or a fulfillment's tracking number
  ok BOOLEAN NOT NULL,
  error VARCHAR(500) NULL,                  -- why Shopify refused, when it did
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (seller_id) REFERENCES sellers(id) ON DELETE CASCADE,
  FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE,
  INDEX idx_order_created (order_id, created_at)
);
