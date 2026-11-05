import type { Topic, TopicInput } from "@news-for-me/shared";

interface TopicRow {
  id: string;
  name: string;
  description: string | null;
  include_keywords_json: string;
  exclude_keywords_json: string;
  is_active: number;
  last_collected_at: string | null;
  created_at: string;
  updated_at: string;
  creator_name: string;
  is_owner: number;
  is_public: number;
}

function parseStringArray(value: string): string[] {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function toTopic(row: TopicRow): Topic {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    isPublic: row.is_public === 1,
    includeKeywords: parseStringArray(row.include_keywords_json),
    excludeKeywords: parseStringArray(row.exclude_keywords_json),
    isActive: row.is_active === 1,
    lastCollectedAt: row.last_collected_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    createdByName: row.creator_name || "사용자",
    isOwner: row.is_owner === 1
  };
}

const SELECT_COLUMNS = `
  t.id, t.name, t.description, t.include_keywords_json, t.exclude_keywords_json,
  t.is_active, t.last_collected_at, t.created_at, t.updated_at, t.is_public,
  COALESCE(NULLIF(u.display_name, ''), '사용자') AS creator_name,
  CASE WHEN t.user_id = ? THEN 1 ELSE 0 END AS is_owner
`;

export interface TopicListResult {
  topics: Topic[];
  totalCount: number;
  ownedCount: number;
}

export async function listTopics(
  db: D1Database,
  userId: string,
  page = 1,
  limit = 5
): Promise<TopicListResult> {
  const offset = (page - 1) * limit;
  const [result, total, owned] = await Promise.all([
    db.prepare(`SELECT ${SELECT_COLUMNS}
      FROM topics t
      LEFT JOIN users u ON u.id = t.user_id
      WHERE t.user_id = ? OR t.is_public = 1
      ORDER BY t.created_at DESC, t.id DESC
      LIMIT ? OFFSET ?`).bind(userId, userId, limit, offset).all<TopicRow>(),
    db.prepare("SELECT COUNT(*) AS count FROM topics WHERE user_id = ? OR is_public = 1")
      .bind(userId).first<{ count: number }>(),
    db.prepare("SELECT COUNT(*) AS count FROM topics WHERE user_id = ?")
      .bind(userId).first<{ count: number }>()
  ]);

  return {
    topics: result.results.map(toTopic),
    totalCount: total?.count ?? 0,
    ownedCount: owned?.count ?? 0
  };
}

export async function getTopic(
  db: D1Database,
  viewerUserId: string,
  topicId: string
): Promise<Topic | null> {
  const row = await db.prepare(`SELECT ${SELECT_COLUMNS}
    FROM topics t
    LEFT JOIN users u ON u.id = t.user_id
    WHERE t.id = ? AND (t.user_id = ? OR t.is_public = 1)
    LIMIT 1`).bind(viewerUserId, topicId, viewerUserId).first<TopicRow>();

  return row ? toTopic(row) : null;
}

export async function createTopic(
  db: D1Database,
  userId: string,
  input: Required<TopicInput>
): Promise<Topic> {
  const id = crypto.randomUUID();
  await db.prepare(`
    INSERT INTO topics (
      id, user_id, name, description, include_keywords_json, exclude_keywords_json, is_public
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `).bind(
    id,
    userId,
    input.name,
    input.description,
    JSON.stringify(input.includeKeywords),
    JSON.stringify(input.excludeKeywords),
    input.isPublic ? 1 : 0
  ).run();

  const topic = await getTopic(db, userId, id);
  if (!topic) throw new Error("Created topic could not be loaded");
  return topic;
}

export async function updateTopic(
  db: D1Database,
  userId: string,
  topicId: string,
  input: Partial<TopicInput>
): Promise<Topic | null> {
  const assignments: string[] = [];
  const values: unknown[] = [];

  if (input.name !== undefined) {
    assignments.push("name = ?");
    values.push(input.name);
  }
  if (input.description !== undefined) {
    assignments.push("description = ?");
    values.push(input.description);
  }
  if (input.includeKeywords !== undefined) {
    assignments.push("include_keywords_json = ?");
    values.push(JSON.stringify(input.includeKeywords));
  }
  if (input.excludeKeywords !== undefined) {
    assignments.push("exclude_keywords_json = ?");
    values.push(JSON.stringify(input.excludeKeywords));
  }
  if (input.isPublic !== undefined) {
    assignments.push("is_public = ?");
    values.push(input.isPublic ? 1 : 0);
  }

  if (assignments.length === 0) return getTopic(db, userId, topicId);

  assignments.push("updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')");
  values.push(userId, topicId);

  const result = await db.prepare(`
    UPDATE topics
    SET ${assignments.join(", ")}
    WHERE user_id = ? AND id = ?
  `).bind(...values).run();

  if ((result.meta.changes ?? 0) === 0) return null;
  return getTopic(db, userId, topicId);
}

export async function deleteTopic(
  db: D1Database,
  userId: string,
  topicId: string
): Promise<boolean> {
  const result = await db.prepare(
    "DELETE FROM topics WHERE user_id = ? AND id = ?"
  ).bind(userId, topicId).run();

  return (result.meta.changes ?? 0) > 0;
}
