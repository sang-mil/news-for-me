-- User-specific saved news. Saved articles are retained by weekly cleanup.
CREATE TABLE article_saves (
    user_id TEXT NOT NULL,
    article_id TEXT NOT NULL,
    saved_at TEXT NOT NULL DEFAULT
        (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    PRIMARY KEY (user_id, article_id),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (article_id) REFERENCES articles(id) ON DELETE CASCADE
);

CREATE INDEX idx_article_saves_user_saved
    ON article_saves(user_id, saved_at DESC);

CREATE INDEX idx_article_saves_article
    ON article_saves(article_id);