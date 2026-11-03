-- Extend article records into source-agnostic content records.
-- Preserve existing rows and backfill their provider from metadata_json.

ALTER TABLE articles ADD COLUMN provider TEXT NOT NULL DEFAULT 'unknown';
ALTER TABLE articles ADD COLUMN content_type TEXT NOT NULL DEFAULT 'article' CHECK (content_type IN ('article', 'repository', 'discussion', 'video', 'social_post', 'webpage'));
ALTER TABLE articles ADD COLUMN body_content TEXT;
ALTER TABLE articles ADD COLUMN engagement_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(engagement_json));
ALTER TABLE articles ADD COLUMN external_id TEXT;

UPDATE articles SET provider = COALESCE(json_extract(metadata_json, '$.provider'), 'unknown') WHERE provider = 'unknown';

CREATE INDEX idx_articles_provider_published ON articles(provider, published_at DESC);
CREATE INDEX idx_articles_content_type_published ON articles(content_type, published_at DESC);
CREATE INDEX idx_articles_provider_external_id ON articles(provider, external_id) WHERE external_id IS NOT NULL;
