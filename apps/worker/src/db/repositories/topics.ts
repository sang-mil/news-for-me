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
}

function parseStringArray(value: string): string[] {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === "string")
      : [];
  } catch {
    return [];
  }
}

function toTopic(row: TopicRow): Topic {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    includeKeywords: parseStringArray(row.include_keywords_json),
    excludeKeywords: parseStringArray(row.exclude_keywords_json),
    isActive: row.is_active === 1,
    lastCollectedAt: row.last_collected_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

const SELECT_COLUMNS = `
  id, name, description, include_keywords_json,
  exclude_keywords_json, is_active, last_collected_at,
  created_at, updated_at
`;

export async function listTopics(
  db: D1Database,
  userId: string
): Promise<Topic[]> {
  const result = await db
    .prepare(`SELECT ${SELECT_COLUMNS} FROM topics WHERE user_id = ? ORDER BY created_at DESC`)
    .bind(userId)
    .all<TopicRow>();

  return result.results.map(toTopic);
}

export async function getTopic(
  db: D1Database,
  userId: string,
  topicId: string
): Promise<Topic | null> {
  const row = await db
    .prepare(`SELECT ${SELECT_COLUMNS} FROM topics WHERE user_id = ? AND id = ? LIMIT 1`)
    .bind(userId, topicId)
    .first<TopicRow>();

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
      id, user_id, name, description,
      include_keywords_json, exclude_keywords_json
    ) VALUES (?, ?, ?, ?, ?, ?)
  `).bind(
    id,
    userId,
    input.name,
    input.description,
    JSON.stringify(input.includeKeywords),
    JSON.stringify(input.excludeKeywords)
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

  if (assignments.length === 0) return getTopic(db, userId, topicId);

  assignments.push("updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')");
  values.push(userId, topicId);

  await db.prepare(`
    UPDATE topics
    SET ${assignments.join(", ")}
    WHERE user_id = ? AND id = ?
  `).bind(...values).run();

  return getTopic(db, userId, topicId);
}

export async function deleteTopic(
  db: D1Database,
  userId: string,
  topicId: string
): Promise<boolean> {
  const result = await db
    .prepare("DELETE FROM topics WHERE user_id = ? AND id = ?")
    .bind(userId, topicId)
    .run();

  return (result.meta.changes ?? 0) > 0;
}
