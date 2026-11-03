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