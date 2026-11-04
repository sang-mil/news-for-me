-- User-level article behavior, feed state, and Gemini-generated Markdown interests.
CREATE TABLE article_user_events (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    article_id TEXT,
    article_title TEXT NOT NULL,
    source_name TEXT,
    topic_id TEXT,
    topic_name TEXT,
    event_type TEXT NOT NULL
        CHECK (event_type IN ('opened', 'saved', 'unsaved')),
    created_at TEXT NOT NULL DEFAULT
        (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (article_id) REFERENCES articles(id) ON DELETE SET NULL,
    FOREIGN KEY (topic_id) REFERENCES topics(id) ON DELETE SET NULL
);

CREATE INDEX idx_article_user_events_user_created
    ON article_user_events(user_id, created_at DESC);

CREATE INDEX idx_article_user_events_user_type
    ON article_user_events(user_id, event_type, created_at DESC);

CREATE TABLE user_interest_profiles (
    user_id TEXT PRIMARY KEY,
    markdown TEXT NOT NULL,
    search_keywords_json TEXT NOT NULL DEFAULT '[]'
        CHECK (json_valid(search_keywords_json)),
    exclude_keywords_json TEXT NOT NULL DEFAULT '[]'
        CHECK (json_valid(exclude_keywords_json)),
    analyzed_event_count INTEGER NOT NULL DEFAULT 0,
    analyzed_at TEXT NOT NULL DEFAULT
        (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    model_name TEXT,
    updated_at TEXT NOT NULL DEFAULT
        (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE user_topic_feed_state (
    user_id TEXT NOT NULL,
    topic_id TEXT NOT NULL,
    cleared_at TEXT NOT NULL DEFAULT
        (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    PRIMARY KEY (user_id, topic_id),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (topic_id) REFERENCES topics(id) ON DELETE CASCADE
);
