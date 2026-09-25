-- decision feedback
-- Runs once per database, after every lower-numbered migration. Once it has
-- run anywhere, don't edit it: add another migration instead.

-- The seller's thumbs up or down on a decision: was the agent's call right?
-- Rated decisions give the agent an accuracy figure. The note is the
-- seller's own words (e.g. what it should have done), so it's redacted and
-- exported with the decision text.
ALTER TABLE decisions
  ADD COLUMN feedback ENUM('up', 'down') NULL,
  ADD COLUMN feedback_note VARCHAR(500) NULL,
  ADD COLUMN feedback_at TIMESTAMP NULL;
