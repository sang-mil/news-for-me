import type { AIProviderName, ArticleSummaryOutput } from "../../services/ai/types";

export interface SummaryToSave extends ArticleSummaryOutput {
  provider: AIProviderName;
  model: string;
}

export async function findUnsummarizedArticleIds(
  db: D1Database,
  topicId: string,
  articleIds: string[],
  promptVersion: string
): Promise<string[]> {
  const ids = [...new Set(articleIds)];
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => "?").join(", ");
  const result = await db.prepare(`
    SELECT article_id FROM summaries
    WHERE topic_id = ? AND prompt_version = ?
      AND article_id IN (${placeholders})
  `).bind(topicId, promptVersion, ...ids).all<{ article_id: string }>();
  const done = new Set(result.results.map((row) => row.article_id));
  return ids.filter((id) => !done.has(id));
}

export async function saveArticleSummaries(
  db: D1Database,
  topicId: string,
  summaries: SummaryToSave[],
  promptVersion: string
): Promise<void> {
  if (summaries.length === 0) return;
  const statements = summaries.map((item) => db.prepare(`
    INSERT INTO summaries (
      id, topic_id, article_id, summary, detailed_summary,
      key_points_json, insight, importance, model_provider, model_name,
      prompt_version
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(topic_id, article_id, prompt_version) DO UPDATE SET
      summary = excluded.summary,
      detailed_summary = excluded.detailed_summary,
      key_points_json = excluded.key_points_json,
      insight = excluded.insight,
      importance = excluded.importance,
      model_provider = excluded.model_provider,
      model_name = excluded.model_name,
      created_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  `).bind(
    crypto.randomUUID(), topicId, item.articleId, item.summary,
    item.detailedSummary, JSON.stringify(item.keyPoints), item.insight,
    item.importance, item.provider, item.model, promptVersion
  ));
  await db.batch(statements);
}