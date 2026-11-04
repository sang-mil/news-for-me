-- Shared topic listing with creator-owned writes.
-- SQLite serializes writes; this trigger makes the per-account cap atomic.
CREATE TRIGGER enforce_topic_limit_before_insert
BEFORE INSERT ON topics
WHEN (SELECT COUNT(*) FROM topics WHERE user_id=NEW.user_id)>=3
BEGIN
  SELECT RAISE(ABORT,'TOPIC_LIMIT_REACHED');
END;
