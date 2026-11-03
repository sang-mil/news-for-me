-- Personal archive: memo and user-owned tags for saved news.
ALTER TABLE article_saves ADD COLUMN note TEXT;
ALTER TABLE article_saves ADD COLUMN updated_at TEXT;

UPDATE article_saves
SET updated_at = saved_at
WHERE updated_at IS NULL;

CREATE TABLE user_tags (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    name TEXT NOT NULL,
    color TEXT NOT NULL DEFAULT '#64748b',
    created_at TEXT NOT NULL DEFAULT
        (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    UNIQUE (user_id, id),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX idx_user_tags_user_name
    ON user_tags(user_id, name COLLATE NOCASE);

CREATE TABLE article_save_tags (
    user_id TEXT NOT NULL,
    article_id TEXT NOT NULL,
    tag_id TEXT NOT NULL,
    added_at TEXT NOT NULL DEFAULT
        (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    PRIMARY KEY (user_id, article_id, tag_id),
    FOREIGN KEY (user_id, article_id)
        REFERENCES article_saves(user_id, article_id) ON DELETE CASCADE,
    FOREIGN KEY (user_id, tag_id)
        REFERENCES user_tags(user_id, id) ON DELETE CASCADE
);

CREATE INDEX idx_article_save_tags_tag
    ON article_save_tags(user_id, tag_id);