-- rate limit events
-- Runs once per database, after every lower-numbered migration. Once it has
-- run anywhere, don't edit it: add another migration instead.

-- Sign-in and sign-up limits (src/services/rateLimit.js): one row per counted
-- event. subject is a keyed hash of the email or IP address, never the value
-- itself. Rows older than a day are pruned by the job worker.
CREATE TABLE rate_limit_events (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  bucket VARCHAR(40) NOT NULL,       -- which limit, e.g. login-fail:account
  subject CHAR(64) NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_bucket_subject (bucket, subject, created_at),
  INDEX idx_created (created_at)
);
