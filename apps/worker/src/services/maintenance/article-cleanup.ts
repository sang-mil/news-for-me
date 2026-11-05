export interface UnsavedNewsCleanupResult {
  summariesDeleted: number;
  topicArticleLinksDeleted: number;
  articlesDeleted: number;
}

/**
 * Remove each topic/article link that its owner has not saved.
 * An article remains if any user saved it or any saved user's topic link remains.
 * D1 batch executes the statements transactionally and in order.
 */
export async function cleanupUnScrapedNews(
  db: D1Database
): Promise<UnsavedNewsCleanupResult> {
  const results = await db.batch([
    db.prepare(`
      DELETE FROM summaries
      WHERE EXISTS (
        SELECT 1
        FROM topic_articles ta
        INNER JOIN topics t ON t.id = ta.topic_id
        WHERE ta.topic_id = summaries.topic_id
          AND ta.article_id = summaries.article_id
          AND NOT EXISTS (
            SELECT 1
            FROM article_saves s
            WHERE s.user_id = t.user_id
              AND s.article_id = ta.article_id
          )
      )
    `),
    db.prepare(`
      DELETE FROM topic_articles
      WHERE NOT EXISTS (
        SELECT 1
        FROM topics t
        INNER JOIN article_saves s
          ON s.user_id = t.user_id
         AND s.article_id = topic_articles.article_id
        WHERE t.id = topic_articles.topic_id
      )
    `),
    db.prepare(`
      DELETE FROM articles
      WHERE NOT EXISTS (
        SELECT 1 FROM topic_articles ta
        WHERE ta.article_id = articles.id
      )
      AND NOT EXISTS (
        SELECT 1 FROM article_saves s
        WHERE s.article_id = articles.id
      )
    `)
  ]);

  return {
    summariesDeleted: results[0]?.meta.changes ?? 0,
    topicArticleLinksDeleted: results[1]?.meta.changes ?? 0,
    articlesDeleted: results[2]?.meta.changes ?? 0
  };
}

export interface ExpiredYouTubeDataCleanupResult {
  behaviorEventsDeleted: number;
  savedItemsDeleted: number;
  personalFeedLinksDeleted: number;
  topicArticleLinksDeleted: number;
  articlesDeleted: number;
}

/** Delete YouTube API data before its 30-day retention limit. */
export async function cleanupExpiredYouTubeData(
  db: D1Database,
  now = new Date().toISOString()
): Promise<ExpiredYouTubeDataCleanupResult> {
  const expired = "provider = 'youtube-data-api' AND provider_data_refreshed_at IS NOT NULL " +
    "AND julianday(provider_data_refreshed_at) <= julianday(?, '-29 days')";
  const results = await db.batch([
    db.prepare("DELETE FROM article_user_events WHERE article_id IN (SELECT id FROM articles WHERE " + expired + ")").bind(now),
    db.prepare("DELETE FROM article_saves WHERE article_id IN (SELECT id FROM articles WHERE " + expired + ")").bind(now),
    db.prepare("DELETE FROM user_topic_articles WHERE article_id IN (SELECT id FROM articles WHERE " + expired + ")").bind(now),
    db.prepare("DELETE FROM topic_articles WHERE article_id IN (SELECT id FROM articles WHERE " + expired + ")").bind(now),
    db.prepare("DELETE FROM articles WHERE " + expired).bind(now)
  ]);
  return {
    behaviorEventsDeleted: results[0]?.meta.changes ?? 0,
    savedItemsDeleted: results[1]?.meta.changes ?? 0,
    personalFeedLinksDeleted: results[2]?.meta.changes ?? 0,
    topicArticleLinksDeleted: results[3]?.meta.changes ?? 0,
    articlesDeleted: results[4]?.meta.changes ?? 0
  };
}