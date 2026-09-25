-- daily summary late orders
-- Runs once per database, after every lower-numbered migration. Once it has
-- run anywhere, don't edit it: add another migration instead.

-- The daily summary and late-order alerts, both off until the seller turns
-- them on in Settings. Times are in the seller's own time zone.
ALTER TABLE sellers
  ADD COLUMN timezone VARCHAR(64) NULL,                        -- IANA name, e.g. Asia/Manila; NULL = UTC
  ADD COLUMN summary_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN summary_hour TINYINT NOT NULL DEFAULT 8,          -- local hour it's sent (0-23)
  ADD COLUMN summary_sent_on DATE NULL,                        -- local date of the last one sent
  ADD COLUMN late_alerts_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN late_after_hours SMALLINT NOT NULL DEFAULT 24;    -- a paid order unshipped this long is late

-- When a late-order alert named this order, so it's only named once.
ALTER TABLE orders ADD COLUMN late_alerted_at TIMESTAMP NULL;
