-- password resets
-- Runs once per database, after every lower-numbered migration. Once it has
-- run anywhere, don't edit it: add another migration instead.

-- Emailed reset links (src/services/passwordReset.js). Only the token's hash
-- is stored, so a copy of the database can't be used to take over accounts.
-- A token works once and expires after an hour; expired rows are pruned.
CREATE TABLE password_resets (
  id INT AUTO_INCREMENT PRIMARY KEY,
  seller_id INT NOT NULL,
  token_hash CHAR(64) NOT NULL UNIQUE,
  expires_at TIMESTAMP NOT NULL,
  used_at TIMESTAMP NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (seller_id) REFERENCES sellers(id) ON DELETE CASCADE,
  INDEX idx_seller (seller_id),
  INDEX idx_expires (expires_at)
);

-- Sign-in tokens issued before this moment stop working (set on a password
-- reset), so a stolen 7-day token can't outlive the password change.
ALTER TABLE sellers ADD COLUMN password_changed_at TIMESTAMP NULL;
