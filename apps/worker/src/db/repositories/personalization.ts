import type { InterestProfile } from "@news-for-me/shared";

export type ArticleEventType = "opened" | "saved" | "unsaved";

interface ProfileRow {
  markdown: string;
  search_keywords_json: string;
  exclude_keywords_json: string;
  analyzed_event_count: number;
  analyzed_at: string;
  model_name: string | null;
}

interface CountRow { count: number; }

export interface BehaviorEventSignal {
  eventType: ArticleEventType;
  title: string;
  sourceName: string | null;
  topicName: string | null;
  eventCount: number;
  latestAt: string;
}

export interface SavedArticleSignal {
  title: string;
  sourceName: string | null;
  note: string | null;
  tags: string[];
}

function parseStringArray(value: string | null | undefined): string[] {
  try {
    const parsed: unknown = JSON.parse(value ?? "[]");
    return Array.isArray(parsed)
      ? [...new Set(parsed.filter((item): item is string => typeof item === "string")
          .map((item) => item.trim()).filter(Boolean))]
      : [];
  } catch {
    return [];
  }
}

export async function recordArticleEvent(
  db: D1Database,
  userId: string,
  articleId: string,
  topicId: string | null,
  eventType: ArticleEventType
): Promise<void> {
  const article = await db.prepare(
    "SELECT title, source_name, provider FROM articles WHERE id = ? LIMIT 1"
  ).bind(articleId).first<{ title: string; source_name: string | null; provider: string }>();
  if (!article || article.provider === "youtube-data-api") return;

  let topicName: string | null = null;
  if (topicId) {
    const topic = await db.prepare(
      "SELECT name FROM topics WHERE id = ? LIMIT 1"
    ).bind(topicId).first<{ name: string }>();
    topicName = topic?.name ?? null;
  }

  await db.prepare(`
    INSERT INTO article_user_events (
      id, user_id, article_id, article_title, source_name,
      topic_id, topic_name, event_type
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    crypto.randomUUID(), userId, articleId, article.title, article.source_name,
    topicId, topicName, eventType
  ).run();
}

export async function getInterestProfile(
  db: D1Database,
  userId: string
): Promise<InterestProfile> {
  const [row, count] = await Promise.all([
    db.prepare(`
      SELECT markdown, search_keywords_json, exclude_keywords_json,
        analyzed_event_count, analyzed_at, model_name
      FROM user_interest_profiles
      WHERE user_id = ?
      LIMIT 1
    `).bind(userId).first<ProfileRow>(),
    db.prepare(
      "SELECT COUNT(*) AS count FROM article_user_events WHERE user_id = ? AND (article_id IS NULL OR article_id NOT IN (SELECT id FROM articles WHERE provider = 'youtube-data-api'))"
    ).bind(userId).first<CountRow>()
  ]);

  return {
    markdown: row?.markdown ?? null,
    searchKeywords: parseStringArray(row?.search_keywords_json),
    excludeKeywords: parseStringArray(row?.exclude_keywords_json),
    analyzedEventCount: row?.analyzed_event_count ?? 0,
    totalEventCount: count?.count ?? 0,
    analyzedAt: row?.analyzed_at ?? null,
    modelName: row?.model_name ?? null
  };
}

export async function getUserBehaviorSignals(
  db: D1Database,
  userId: string
): Promise<{ events: BehaviorEventSignal[]; savedArticles: SavedArticleSignal[] }> {
  const [events, saved] = await Promise.all([
    db.prepare(`
      SELECT event_type, article_title, source_name, topic_name,
        COUNT(*) AS event_count, MAX(created_at) AS latest_at
      FROM article_user_events
      WHERE user_id = ?
        AND (article_id IS NULL OR article_id NOT IN (
          SELECT id FROM articles WHERE provider = 'youtube-data-api'
        ))
      GROUP BY event_type, article_title, source_name, topic_name
      ORDER BY latest_at DESC
      LIMIT 80
    `).bind(userId).all<{
      event_type: ArticleEventType;
      article_title: string;
      source_name: string | null;
      topic_name: string | null;
      event_count: number;
      latest_at: string;
    }>(),
    db.prepare(`
      SELECT a.title, a.source_name, s.note,
        GROUP_CONCAT(DISTINCT tags.name) AS tag_names
      FROM article_saves s
      INNER JOIN articles a ON a.id = s.article_id
      LEFT JOIN article_save_tags ast
        ON ast.user_id = s.user_id AND ast.article_id = s.article_id
      LEFT JOIN user_tags tags
        ON tags.user_id = ast.user_id AND tags.id = ast.tag_id
      WHERE s.user_id = ?
        AND a.provider <> 'youtube-data-api'
      GROUP BY a.id, a.title, a.source_name, s.note, s.saved_at
      ORDER BY s.saved_at DESC
      LIMIT 30
    `).bind(userId).all<{
      title: string;
      source_name: string | null;
      note: string | null;
      tag_names: string | null;
    }>()
  ]);

  return {
    events: events.results.map((row) => ({
      eventType: row.event_type,
      title: row.article_title,
      sourceName: row.source_name,
      topicName: row.topic_name,
      eventCount: row.event_count,
      latestAt: row.latest_at
    })),
    savedArticles: saved.results.map((row) => ({
      title: row.title,
      sourceName: row.source_name,
      note: row.note,
      tags: row.tag_names ? row.tag_names.split(",").filter(Boolean) : []
    }))
  };
}

export async function saveInterestProfile(
  db: D1Database,
  userId: string,
  profile: {
    markdown: string;
    searchKeywords: string[];
    excludeKeywords: string[];
    analyzedEventCount: number;
    modelName: string;
  }
): Promise<void> {
  await db.prepare(`
    INSERT INTO user_interest_profiles (
      user_id, markdown, search_keywords_json, exclude_keywords_json,
      analyzed_event_count, analyzed_at, model_name, updated_at
    ) VALUES (?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), ?,
      strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    ON CONFLICT(user_id) DO UPDATE SET
      markdown = excluded.markdown,
      search_keywords_json = excluded.search_keywords_json,
      exclude_keywords_json = excluded.exclude_keywords_json,
      analyzed_event_count = excluded.analyzed_event_count,
      analyzed_at = excluded.analyzed_at,
      model_name = excluded.model_name,
      updated_at = excluded.updated_at
  `).bind(
    userId, profile.markdown, JSON.stringify(profile.searchKeywords),
    JSON.stringify(profile.excludeKeywords), profile.analyzedEventCount,
    profile.modelName
  ).run();
}

export async function clearTopicFeed(
  db: D1Database,
  userId: string,
  topicId: string
): Promise<void> {
  await db.prepare(`
    INSERT INTO user_topic_feed_state (user_id, topic_id, cleared_at)
    VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    ON CONFLICT(user_id, topic_id) DO UPDATE SET
      cleared_at = excluded.cleared_at
  `).bind(userId, topicId).run();
}
