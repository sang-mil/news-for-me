import type { NewsletterArticle } from "../../services/email/types";

interface NewsletterArticleRow {
  article_id: string;
  topic_name: string;
  title: string;
  canonical_url: string;
  source_name: string | null;
  published_at: string | null;
  summary: string;
  detailed_summary: string | null;
  key_points_json: string;
  insight: string | null;
  importance: NewsletterArticle["importance"];
  model_provider: string;
  model_name: string;
  is_saved: number;
}

function parseKeyPoints(value: string): string[] {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === "string").slice(0, 8)
      : [];
  } catch {
    return [];
  }
}

export async function listRecentNewsletterArticles(
  db: D1Database,
  userId: string,
  periodDays = 7,
  limit = 25
): Promise<NewsletterArticle[]> {
  const safeDays = Math.min(30, Math.max(1, Math.floor(periodDays)));
  const safeLimit = Math.min(40, Math.max(1, Math.floor(limit)));

  const result = await db.prepare(`
    SELECT
      a.id AS article_id,
      t.name AS topic_name,
      a.title,
      a.canonical_url,
      a.source_name,
      a.published_at,
      s.summary,
      s.detailed_summary,
      s.key_points_json,
      s.insight,
      s.importance,
      s.model_provider,
      s.model_name,
      CASE WHEN saved.article_id IS NULL THEN 0 ELSE 1 END AS is_saved
    FROM summaries s
    INNER JOIN topics t ON t.id = s.topic_id
    INNER JOIN articles a ON a.id = s.article_id
    LEFT JOIN article_saves saved
      ON saved.user_id = t.user_id AND saved.article_id = a.id
    WHERE t.user_id = ?
      AND t.is_active = 1
      AND julianday(s.created_at) >= julianday('now', '-' || ? || ' days')
    ORDER BY
      CASE s.importance
        WHEN 'urgent' THEN 0
        WHEN 'high' THEN 1
        WHEN 'normal' THEN 2
        ELSE 3
      END,
      COALESCE(a.published_at, s.created_at) DESC
    LIMIT ?
  `).bind(userId, safeDays, safeLimit).all<NewsletterArticleRow>();

  // One article can be linked to multiple topics. Keep the highest-ranked row once.
  const unique = new Map<string, NewsletterArticle>();
  for (const row of result.results) {
    if (unique.has(row.article_id)) continue;
    unique.set(row.article_id, {
      articleId: row.article_id,
      topicName: row.topic_name,
      title: row.title,
      canonicalUrl: row.canonical_url,
      sourceName: row.source_name,
      publishedAt: row.published_at,
      summary: row.summary,
      detailedSummary: row.detailed_summary,
      keyPoints: parseKeyPoints(row.key_points_json),
      insight: row.insight,
      importance: row.importance,
      modelProvider: row.model_provider,
      modelName: row.model_name,
      isSaved: row.is_saved === 1
    });
  }
  return [...unique.values()];
}
