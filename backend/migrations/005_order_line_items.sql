-- order line items
-- Runs once per database, after every lower-numbered migration. Once it has
-- run anywhere, don't edit it: add another migration instead.

-- What each order contains, from the same Shopify order payloads the sync and
-- order webhooks already receive. Product details only: line item
-- `properties` (custom text such as engravings) are left out, since they can
-- hold personal data.
CREATE TABLE order_line_items (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  order_id INT NOT NULL,
  shopify_line_item_id VARCHAR(100) NOT NULL,
  shopify_variant_id VARCHAR(100),          -- NULL for custom items and deleted products
  title VARCHAR(255) NOT NULL,              -- product title at the time of the order
  variant_title VARCHAR(255),               -- e.g. "Large / Blue"
  sku VARCHAR(255),
  quantity INT NOT NULL,
  fulfillable_quantity INT,                 -- how many are still to ship
  price DECIMAL(10,2),                      -- per unit
  FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE,
  UNIQUE KEY uniq_order_line (order_id, shopify_line_item_id)
);

-- When the line items were last saved. NULL for orders synced before this
-- table existed: the order detail view fetches those from Shopify once.
ALTER TABLE orders ADD COLUMN line_items_synced_at TIMESTAMP NULL;
