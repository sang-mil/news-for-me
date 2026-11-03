-- News for Me: Initial database schema

CREATE TABLE users (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL COLLATE NOCASE UNIQUE,
    display_name TEXT,
    timezone TEXT NOT NULL DEFAULT 'Asia/Seoul',
    digest_enabled INTEGER NOT NULL DEFAULT 1
        CHECK (digest_enabled IN (0, 1)),
    digest_frequency TEXT NOT NULL DEFAULT 'daily'
        CHECK (digest_frequency IN ('daily', 'weekly')),
    delivery_time TEXT NOT NULL DEFAULT '08:00',
    created_at TEXT NOT NULL DEFAULT
        (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at TEXT NOT NULL DEFAULT
        (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE topics (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    name TEXT NOT NULL,
    description TEXT,
    include_keywords_json TEXT NOT NULL DEFAULT '[]'
        CHECK (json_valid(include_keywords_json)),
    exclude_keywords_json TEXT NOT NULL DEFAULT '[]'
        CHECK (json_valid(exclude_keywords_json)),
    is_active INTEGER NOT NULL DEFAULT 1
        CHECK (is_active IN (0, 1)),
    last_collected_at TEXT,
    created_at TEXT NOT NULL DEFAULT
        (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at TEXT NOT NULL DEFAULT
        (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    UNIQUE (user_id, name)
);

CREATE TABLE articles (
    id TEXT PRIMARY KEY,
    canonical_url TEXT NOT NULL UNIQUE,
    url_hash TEXT UNIQUE,
    title TEXT NOT NULL,
    source_name TEXT,
    author TEXT,
    published_at TEXT,
    fetched_at TEXT NOT NULL DEFAULT
        (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    content_excerpt TEXT,
    image_url TEXT,
    language TEXT NOT NULL DEFAULT 'ko',
    metadata_json TEXT NOT NULL DEFAULT '{}'
        CHECK (json_valid(metadata_json))
);

CREATE TABLE topic_articles (
    topic_id TEXT NOT NULL,
    article_id TEXT NOT NULL,
    relevance_score REAL
        CHECK (
            relevance_score IS NULL OR
            (relevance_score >= 0 AND relevance_score <= 1)
        ),
    match_reason TEXT,
    linked_at TEXT NOT NULL DEFAULT
        (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    PRIMARY KEY (topic_id, article_id),
    FOREIGN KEY (topic_id) REFERENCES topics(id) ON DELETE CASCADE,
    FOREIGN KEY (article_id) REFERENCES articles(id) ON DELETE CASCADE
);

CREATE TABLE summaries (
    id TEXT PRIMARY KEY,
    topic_id TEXT NOT NULL,
    article_id TEXT NOT NULL,
    summary TEXT NOT NULL,
    detailed_summary TEXT,
    key_points_json TEXT NOT NULL DEFAULT '[]'
        CHECK (json_valid(key_points_json)),
    insight TEXT,
    importance TEXT NOT NULL DEFAULT 'normal'
        CHECK (importance IN ('urgent', 'high', 'normal', 'low')),
    model_provider TEXT NOT NULL,
    model_name TEXT NOT NULL,
    prompt_version TEXT NOT NULL DEFAULT 'v1',
    created_at TEXT NOT NULL DEFAULT
        (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    FOREIGN KEY (topic_id, article_id)
        REFERENCES topic_articles(topic_id, article_id)
        ON DELETE CASCADE,
    UNIQUE (topic_id, article_id, prompt_version)
);

CREATE TABLE collection_runs (
    id TEXT PRIMARY KEY,
    topic_id TEXT NOT NULL,
    trigger_source TEXT NOT NULL DEFAULT 'manual'
        CHECK (trigger_source IN ('manual', 'cron')),
    status TEXT NOT NULL DEFAULT 'queued'
        CHECK (status IN ('queued', 'running', 'completed', 'failed')),
    articles_found INTEGER NOT NULL DEFAULT 0,
    error_message TEXT,
    started_at TEXT,
    finished_at TEXT,
    created_at TEXT NOT NULL DEFAULT
        (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    FOREIGN KEY (topic_id) REFERENCES topics(id) ON DELETE CASCADE
);

CREATE TABLE delivery_logs (
    id TEXT PRIMARY KEY,
    user_id TEXT,
    channel TEXT NOT NULL DEFAULT 'email'
        CHECK (channel IN ('email')),
    recipient_email TEXT NOT NULL,
    subject TEXT,
    status TEXT NOT NULL DEFAULT 'queued'
        CHECK (
            status IN ('queued', 'sending', 'sent', 'failed', 'skipped')
        ),
    provider TEXT,
    external_message_id TEXT,
    idempotency_key TEXT NOT NULL UNIQUE,
    retry_count INTEGER NOT NULL DEFAULT 0,
    error_message TEXT,
    scheduled_for TEXT,
    sent_at TEXT,
    created_at TEXT NOT NULL DEFAULT
        (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
);

CREATE TABLE api_attempt_logs (
    id TEXT PRIMARY KEY,
    run_id TEXT,
    provider TEXT NOT NULL,
    model_name TEXT NOT NULL,
    key_slot TEXT,
    attempt_number INTEGER NOT NULL DEFAULT 1,
    status TEXT NOT NULL
        CHECK (status IN ('success', 'failed')),
    http_status INTEGER,
    error_code TEXT,
    error_message TEXT,
    latency_ms INTEGER,
    retry_after_seconds INTEGER,
    created_at TEXT NOT NULL DEFAULT
        (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    FOREIGN KEY (run_id) REFERENCES collection_runs(id) ON DELETE SET NULL
);

-- Query performance indexes

CREATE INDEX idx_topics_user_active
    ON topics(user_id, is_active);

CREATE INDEX idx_articles_published
    ON articles(published_at DESC);

CREATE INDEX idx_articles_fetched
    ON articles(fetched_at DESC);

CREATE INDEX idx_topic_articles_article
    ON topic_articles(article_id);

CREATE INDEX idx_summaries_topic_created
    ON summaries(topic_id, created_at DESC);

CREATE INDEX idx_collection_runs_topic_created
    ON collection_runs(topic_id, created_at DESC);

CREATE INDEX idx_delivery_user_created
    ON delivery_logs(user_id, created_at DESC);

CREATE INDEX idx_delivery_status_scheduled
    ON delivery_logs(status, scheduled_for);

CREATE INDEX idx_api_attempt_provider_created
    ON api_attempt_logs(provider, created_at DESC);
