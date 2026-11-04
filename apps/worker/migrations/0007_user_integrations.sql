-- Store per-user provider credentials as application-encrypted ciphertext.
-- The encryption key is a Worker secret and is never stored in D1.
CREATE TABLE user_integrations (
  user_id TEXT NOT NULL,
  provider TEXT NOT NULL
    CHECK (provider IN ('gemini', 'openrouter', 'threads', 'x', 'youtube')),
  credentials_encrypted TEXT,
  config_json TEXT NOT NULL DEFAULT '{}'
    CHECK (json_valid(config_json)),
  status TEXT NOT NULL DEFAULT 'saved'
    CHECK (status IN ('saved', 'connected', 'error')),
  last_validated_at TEXT,
  created_at TEXT NOT NULL DEFAULT
    (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT
    (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (user_id, provider),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX idx_user_integrations_provider
  ON user_integrations(provider);
