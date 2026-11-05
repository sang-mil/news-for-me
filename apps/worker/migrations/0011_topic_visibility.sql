-- Existing topics become private unless their owner explicitly shares them.
ALTER TABLE topics ADD COLUMN is_public INTEGER NOT NULL DEFAULT 0
  CHECK (is_public IN (0, 1));

CREATE INDEX idx_topics_public_created
  ON topics(is_public, created_at DESC);
