interface DevelopmentUserConfig {
  DEV_USER_ID?: string;
  DEV_USER_EMAIL?: string;
}

export async function ensureDevelopmentUser(
  db: D1Database,
  env: DevelopmentUserConfig
): Promise<string | null> {
  const userId = env.DEV_USER_ID?.trim();
  const email = env.DEV_USER_EMAIL?.trim().toLowerCase();

  // These values are loaded from apps/worker/.dev.vars locally.
  // Do not configure them in production; replace this with real authentication.
  if (!userId || !email) return null;

  await db.prepare(`
    INSERT OR IGNORE INTO users (id, email, display_name)
    VALUES (?, ?, 'Local Developer')
  `).bind(userId, email).run();

  const existing = await db
    .prepare("SELECT id FROM users WHERE id = ? AND email = ? LIMIT 1")
    .bind(userId, email)
    .first<{ id: string }>();

  return existing?.id ?? null;
}
