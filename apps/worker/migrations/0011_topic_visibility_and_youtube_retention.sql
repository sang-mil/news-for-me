-- Make topics private by default and track the latest YouTube API data refresh.
-- Existing shared topics become private after this migration.
ALTER TABLE topics ADD COLUMN is_public INTEGER NOT NULL DEFAULT 0
  CHECK (is_public IN (0, 1));

CREATE INDEX idx_topics_public_created
  ON topics(is_public, created_at DESC);

ALTER TABLE articles ADD COLUMN provider_data_refreshed_at TEXT;

-- Existing YouTube API rows start their retention period from their original fetch.
UPDATE articles
SET provider_data_refreshed_at = fetched_at
WHERE provider = 'youtube-data-api';

CREATE INDEX idx_articles_provider_data_retention
  ON articles(provider, provider_data_refreshed_at);

-- Remove previously generated AI summaries based on YouTube API data.
DELETE FROM summaries
WHERE article_id IN (SELECT id FROM articles WHERE provider = 'youtube-data-api');
