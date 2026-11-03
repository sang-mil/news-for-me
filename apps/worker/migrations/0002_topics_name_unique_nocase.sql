-- Enforce case-insensitive topic names per user (e.g. OpenAI == openai).
CREATE UNIQUE INDEX IF NOT EXISTS idx_topics_user_name_nocase
ON topics(user_id, name COLLATE NOCASE);
