-- Link Better Auth's verified Google identity to the existing News for Me app user.
-- This does not modify or delete existing topics, saved articles, notes, tags, or delivery logs.
ALTER TABLE users ADD COLUMN auth_user_id TEXT;

CREATE UNIQUE INDEX idx_users_auth_user_id_unique
  ON users(auth_user_id)
  WHERE auth_user_id IS NOT NULL;
