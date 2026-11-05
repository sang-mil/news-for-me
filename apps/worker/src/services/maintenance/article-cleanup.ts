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

export interface YouTubeApiRetentionResult {
  summariesDeleted: number;
  interestProfilesDeleted: number;
  eventsDeleted: number;
  articlesDeleted: number;
}

/**
 * Delete YouTube Data API records before the 30-calendar-day policy limit.
 * The one-day safety margin accounts for cron delays and processing time.
 * User saves cascade with the article so API-derived video metadata is not retained.
 */
export async function cleanupExpiredYouTubeApiData(
  db: D1Database
): Promise<YouTubeApiRetentionResult> {
  const expiredVideos = `
    SELECT id
    FROM articles
    WHERE provider = 'youtube-data-api'
      AND julianday(fetched_at) <= julianday('now', '-29 days')
  `;

  const results = await db.batch([
    db.prepare(`
      DELETE FROM summaries
      WHERE article_id IN (${expiredVideos})
    `),
    db.prepare(`
      DELETE FROM user_interest_profiles
      WHERE user_id IN (
        SELECT DISTINCT user_id
        FROM article_user_events
        WHERE article_id IN (${expiredVideos})
      )
    `),
    db.prepare(`
      DELETE FROM article_user_events
      WHERE article_id IN (${expiredVideos})
    `),
    db.prepare(`
      DELETE FROM articles
      WHERE provider = 'youtube-data-api'
        AND julianday(fetched_at) <= julianday('now', '-29 days')
    `)
  ]);

  return {
    summariesDeleted: results[0]?.meta.changes ?? 0,
    interestProfilesDeleted: results[1]?.meta.changes ?? 0,
    eventsDeleted: results[2]?.meta.changes ?? 0,
    articlesDeleted: results[3]?.meta.changes ?? 0
  };
}
