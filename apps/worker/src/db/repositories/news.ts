import type { CollectionRun, NewsArticle } from "@news-for-me/shared";
import type {
  CollectedNewsItem,
  CollectionJobMessage,
  StoredCollectedArticle,
  TopicForCollection
} from "../../services/news/types";

interface CollectionRunRow {
  id: string;
  topic_id: string;
  status: CollectionRun["status"];
  articles_found: number;
  error_message: string | null;
  started_at: string | null;
  finished_at: string | null;
  created_at: string;
}

interface ArticleRow {
  id: string;
  title: string;
  canonical_url: string;
  source_name: string | null;
  published_at: string | null;
  fetched_at: string;
  content_excerpt: string | null;
  provider: string;
  content_type: NewsArticle["contentType"];
  author: string | null;
  body_content: string | null;
  image_url: string | null;
  language: string | null;
  engagement_json: string;
}

function toCollectionRun(row: CollectionRunRow): CollectionRun {
  return {
    id: row.id,
    topicId: row.topic_id,
    status: row.status,
    articlesFound: row.articles_found,
    errorMessage: row.error_message,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    createdAt: row.created_at
  };
}

export async function getTopicForCollection(
  db: D1Database,
  topicId: string
): Promise<TopicForCollection | null> {
  return db.prepare(`
    SELECT id, user_id, name, description,
      include_keywords_json, exclude_keywords_json
    FROM topics
    WHERE id = ? AND is_active = 1
    LIMIT 1
  `).bind(topicId).first<TopicForCollection>();
}

export async function createCollectionRun(
  db: D1Database,
  topicId: string
): Promise<string> {
  const runId = crypto.randomUUID();
  await db.prepare(`
    INSERT INTO collection_runs (id, topic_id, trigger_source, status)
    VALUES (?, ?, 'manual', 'queued')
  `).bind(runId, topicId).run();
  return runId;
}

export async function getCollectionRun(
  db: D1Database,
  topicId: string,
  runId: string
): Promise<CollectionRun | null> {
  const row = await db.prepare(`
    SELECT cr.id, cr.topic_id, cr.status, cr.articles_found,
      cr.error_message, cr.started_at, cr.finished_at, cr.created_at
    FROM collection_runs cr
    INNER JOIN topics t ON t.id = cr.topic_id
    WHERE cr.id = ? AND cr.topic_id = ?
    LIMIT 1
  `).bind(runId, topicId).first<CollectionRunRow>();
  return row ? toCollectionRun(row) : null;
}

export async function listTopicArticles(
  db: D1Database,
  topicId: string,
  userId: string,
  limit = 20
): Promise<NewsArticle[]> {
  const result = await db.prepare(`
    SELECT a.id, a.title, a.canonical_url, a.source_name,
      a.published_at, a.fetched_at, a.content_excerpt, a.provider,
      a.content_type, a.author, a.body_content, a.image_url, a.language,
      a.engagement_json
    FROM articles a
    INNER JOIN topic_articles ta ON ta.article_id = a.id
    INNER JOIN topics t ON t.id = ta.topic_id
    WHERE ta.topic_id = ?
      AND ta.linked_at > COALESCE((
        SELECT cleared_at FROM user_topic_feed_state
        WHERE user_id = ? AND topic_id = ?
      ), '1970-01-01T00:00:00.000Z')
      AND NOT EXISTS (
        SELECT 1 FROM article_user_events e
        WHERE e.user_id = ? AND e.article_id = a.id AND e.event_type = 'opened'
      )
      AND NOT EXISTS (
        SELECT 1 FROM article_saves saved
        WHERE saved.user_id = ? AND saved.article_id = a.id
      )
    ORDER BY COALESCE(a.published_at, a.fetched_at) DESC
    LIMIT ?
  `).bind(topicId, userId, topicId, userId, userId, limit).all<ArticleRow>();

  return result.results.map((row) => ({
    id: row.id,
    title: row.title,
    canonicalUrl: row.canonical_url,
    sourceName: row.source_name,
    publishedAt: row.published_at,
    fetchedAt: row.fetched_at,
    contentExcerpt: row.content_excerpt,
    provider: row.provider,
    contentType: row.content_type,
    author: row.author,
    bodyContent: row.body_content,
    imageUrl: row.image_url,
    language: row.language,
    engagement: JSON.parse(row.engagement_json) as Record<string, number | string | boolean | null>
  }));
}

export async function storeCollectedArticles(
  db: D1Database,
  job: CollectionJobMessage,
  items: CollectedNewsItem[],
  collectionNote: string | null = null
): Promise<StoredCollectedArticle[]> {
  const statements: D1PreparedStatement[] = [];
  const stored: StoredCollectedArticle[] = [];
  const seen = new Set<string>();

  for (const item of items) {
    const canonicalUrl = new URL(item.url);
    canonicalUrl.hash = "";
    for (const key of [...canonicalUrl.searchParams.keys()]) {
      const lower = key.toLowerCase();
      if (lower.startsWith("utm_") ||
          ["gclid", "fbclid", "mc_cid", "mc_eid"].includes(lower)) {
        canonicalUrl.searchParams.delete(key);
      }
    }

    const normalizedUrl = canonicalUrl.toString();
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(normalizedUrl)
    );
    const urlHash = Array.from(new Uint8Array(digest))
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
    const articleId = `article_${urlHash.slice(0, 40)}`;

    if (!seen.has(articleId)) {
      stored.push({ articleId, item });
      seen.add(articleId);
    }

    statements.push(db.prepare(`
      INSERT OR IGNORE INTO articles (
        id, canonical_url, url_hash, title, source_name,
        published_at, content_excerpt, language, metadata_json, provider,
        content_type, author, body_content, image_url, engagement_json, external_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      articleId, normalizedUrl, urlHash, item.title, item.sourceName,
      item.publishedAt, item.excerpt, item.language ?? "ko",
      JSON.stringify({ provider: item.provider, ...(item.metadata ?? {}) }),
      item.provider, item.contentType ?? "article", item.author ?? null,
      item.bodyContent ?? null, item.imageUrl ?? null,
      JSON.stringify(item.engagement ?? {}), item.externalId ?? null
    ));

    statements.push(db.prepare(`
      INSERT OR IGNORE INTO topic_articles (topic_id, article_id, match_reason)
      VALUES (?, ?, 'News RSS keyword search')
    `).bind(job.topicId, articleId));
  }

  statements.push(db.prepare(`
    UPDATE collection_runs
    SET status = 'completed', articles_found = ?, error_message = ?,
      finished_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE id = ? AND topic_id = ?
  `).bind(items.length, collectionNote?.slice(0, 950) ?? null, job.runId, job.topicId));

  statements.push(db.prepare(`
    UPDATE topics
    SET last_collected_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
      updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE id = ?
  `).bind(job.topicId));

  await db.batch(statements);
  return stored;
}

export async function markCollectionStarted(
  db: D1Database,
  runId: string
): Promise<void> {
  await db.prepare(`
    UPDATE collection_runs
    SET status = 'running',
      started_at = COALESCE(started_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      error_message = NULL
    WHERE id = ?
  `).bind(runId).run();
}

export async function markCollectionRetrying(
  db: D1Database,
  runId: string,
  errorMessage: string
): Promise<void> {
  await db.prepare(`
    UPDATE collection_runs
    SET status = 'queued', error_message = ?, finished_at = NULL
    WHERE id = ?
  `).bind(`Retry pending: ${errorMessage}`.slice(0, 1000), runId).run();
}

export async function markCollectionDeadLettered(
  db: D1Database,
  runId: string
): Promise<void> {
  await db.prepare(`
    UPDATE collection_runs
    SET status = 'failed',
      error_message = CASE
        WHEN error_message IS NULL OR error_message = ''
          THEN 'Queue retry limit reached.'
        WHEN substr(error_message, 1, 15) = 'Retry pending: '
          THEN 'Queue retry limit reached. Last error: ' || substr(error_message, 16, 800)
        ELSE 'Queue retry limit reached. Last error: ' || substr(error_message, 1, 800)
      END,
      finished_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE id = ?
  `).bind(runId).run();
}