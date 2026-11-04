-- One-time newsletter deliveries requested by a signed-in user.
CREATE TABLE newsletter_schedules (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  recipient_email TEXT NOT NULL,
  scheduled_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'scheduled'
    CHECK (status IN ('scheduled', 'sending', 'sent', 'failed', 'cancelled')),
  delivery_id TEXT,
  error_message TEXT,
  sent_at TEXT,
  created_at TEXT NOT NULL DEFAULT
    (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT
    (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (delivery_id) REFERENCES delivery_logs(id) ON DELETE SET NULL
);

CREATE INDEX idx_newsletter_schedules_due
  ON newsletter_schedules(status, scheduled_at);

CREATE INDEX idx_newsletter_schedules_user_created
  ON newsletter_schedules(user_id, created_at DESC);
