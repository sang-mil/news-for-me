import type { SavedNewsArticle, SavedNewsTag } from "@news-for-me/shared";

interface SavedArticleRow {
  id: string;
  title: string;
  canonical_url: string;
  source_name: string | null;
  published_at: string | null;
  fetched_at: string;
  content_excerpt: string | null;
  saved_at: string;
  note: string | null;
  updated_at: string;
}

interface TagRow {
  id: string;
  name: string;
  color: string;
  created_at: string;
}

interface ArticleTagRow extends TagRow {
  article_id: string;
}

function toTag(row: TagRow): SavedNewsTag {
  return {
    id: row.id,
    name: row.name,
    color: row.color,
    createdAt: row.created_at
  };
}

function toSavedArticle(row: SavedArticleRow, tags: SavedNewsTag[] = []): SavedNewsArticle {
  return {
    id: row.id,
    title: row.title,
    canonicalUrl: row.canonical_url,
    sourceName: row.source_name,
    publishedAt: row.published_at,
    fetchedAt: row.fetched_at,
    contentExcerpt: row.content_excerpt,
    savedAt: row.saved_at,
    note: row.note,
    updatedAt: row.updated_at,
    tags
  };
}

async function attachTags(
  db: D1Database,
  userId: string,
  rows: SavedArticleRow[]
): Promise<SavedNewsArticle[]> {
  if (rows.length === 0) return [];
  const articleIds = new Set(rows.map((row) => row.id));
  const tagResult = await db.prepare(`
    SELECT ast.article_id, t.id, t.name, t.color, t.created_at
    FROM article_save_tags ast
    INNER JOIN user_tags t
      ON t.id = ast.tag_id AND t.user_id = ast.user_id
    WHERE ast.user_id = ?
    ORDER BY t.name COLLATE NOCASE
  `).bind(userId).all<ArticleTagRow>();

  const tagsByArticle = new Map<string, SavedNewsTag[]>();
  for (const row of tagResult.results) {
    if (!articleIds.has(row.article_id)) continue;
    const current = tagsByArticle.get(row.article_id) ?? [];
    current.push(toTag(row));
    tagsByArticle.set(row.article_id, current);
  }

  return rows.map((row) => toSavedArticle(row, tagsByArticle.get(row.id) ?? []));
}

export async function listSavedArticles(
  db: D1Database,
  userId: string,
  limit = 100
): Promise<SavedNewsArticle[]> {
  const result = await db.prepare(`
    SELECT a.id, a.title, a.canonical_url, a.source_name,
      a.published_at, a.fetched_at, a.content_excerpt,
      s.saved_at, s.note, s.updated_at
    FROM article_saves s
    INNER JOIN articles a ON a.id = s.article_id
    WHERE s.user_id = ?
    ORDER BY s.saved_at DESC
    LIMIT ?
  `).bind(userId, limit).all<SavedArticleRow>();

  return attachTags(db, userId, result.results);
}

export async function saveArticleForUser(
  db: D1Database,
  userId: string,
  topicId: string,
  articleId: string
): Promise<SavedNewsArticle | null> {
  await db.prepare(`
    INSERT OR IGNORE INTO article_saves (user_id, article_id, updated_at)
    SELECT ?, a.id, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    FROM articles a
    INNER JOIN topic_articles ta ON ta.article_id = a.id
    WHERE a.id = ? AND ta.topic_id = ?
  `).bind(userId, articleId, topicId).run();

  const row = await db.prepare(`
    SELECT a.id, a.title, a.canonical_url, a.source_name,
      a.published_at, a.fetched_at, a.content_excerpt,
      s.saved_at, s.note, s.updated_at
    FROM article_saves s
    INNER JOIN articles a ON a.id = s.article_id
    WHERE s.user_id = ? AND s.article_id = ?
    LIMIT 1
  `).bind(userId, articleId).first<SavedArticleRow>();

  if (!row) return null;
  const [article] = await attachTags(db, userId, [row]);
  return article ?? null;
}

export async function removeSavedArticle(
  db: D1Database,
  userId: string,
  articleId: string
): Promise<void> {
  await db.prepare(`
    DELETE FROM article_saves
    WHERE user_id = ? AND article_id = ?
  `).bind(userId, articleId).run();
}

export async function updateSavedArticleNote(
  db: D1Database,
  userId: string,
  articleId: string,
  note: string | null
): Promise<SavedNewsArticle | null> {
  await db.prepare(`
    UPDATE article_saves
    SET note = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE user_id = ? AND article_id = ?
  `).bind(note, userId, articleId).run();

  const row = await db.prepare(`
    SELECT a.id, a.title, a.canonical_url, a.source_name,
      a.published_at, a.fetched_at, a.content_excerpt,
      s.saved_at, s.note, s.updated_at
    FROM article_saves s
    INNER JOIN articles a ON a.id = s.article_id
    WHERE s.user_id = ? AND s.article_id = ?
    LIMIT 1
  `).bind(userId, articleId).first<SavedArticleRow>();

  if (!row) return null;
  const [article] = await attachTags(db, userId, [row]);
  return article ?? null;
}

export async function listUserTags(
  db: D1Database,
  userId: string
): Promise<SavedNewsTag[]> {
  const result = await db.prepare(`
    SELECT id, name, color, created_at
    FROM user_tags
    WHERE user_id = ?
    ORDER BY name COLLATE NOCASE
  `).bind(userId).all<TagRow>();
  return result.results.map(toTag);
}

export async function createUserTag(
  db: D1Database,
  userId: string,
  name: string,
  color: string
): Promise<SavedNewsTag> {
  const id = `tag_${crypto.randomUUID()}`;
  await db.prepare(`
    INSERT INTO user_tags (id, user_id, name, color)
    VALUES (?, ?, ?, ?)
  `).bind(id, userId, name, color).run();

  const row = await db.prepare(`
    SELECT id, name, color, created_at
    FROM user_tags WHERE id = ? AND user_id = ?
  `).bind(id, userId).first<TagRow>();
  if (!row) throw new Error("Created tag could not be read.");
  return toTag(row);
}

export async function updateUserTag(
  db: D1Database,
  userId: string,
  tagId: string,
  name: string | null,
  color: string | null
): Promise<SavedNewsTag | null> {
  await db.prepare(`
    UPDATE user_tags
    SET name = COALESCE(?, name), color = COALESCE(?, color)
    WHERE id = ? AND user_id = ?
  `).bind(name, color, tagId, userId).run();

  const row = await db.prepare(`
    SELECT id, name, color, created_at
    FROM user_tags WHERE id = ? AND user_id = ?
  `).bind(tagId, userId).first<TagRow>();
  return row ? toTag(row) : null;
}

export async function deleteUserTag(
  db: D1Database,
  userId: string,
  tagId: string
): Promise<void> {
  await db.prepare(`
    DELETE FROM user_tags WHERE id = ? AND user_id = ?
  `).bind(tagId, userId).run();
}

export async function replaceSavedArticleTags(
  db: D1Database,
  userId: string,
  articleId: string,
  tagIds: string[]
): Promise<boolean> {
  const saved = await db.prepare(`
    SELECT 1 AS ok FROM article_saves
    WHERE user_id = ? AND article_id = ? LIMIT 1
  `).bind(userId, articleId).first<{ ok: number }>();
  if (!saved) return false;

  if (tagIds.length > 0) {
    const placeholders = tagIds.map(() => "?").join(", ");
    const ownedTags = await db.prepare(`
      SELECT id FROM user_tags
      WHERE user_id = ? AND id IN (${placeholders})
    `).bind(userId, ...tagIds).all<{ id: string }>();
    if (ownedTags.results.length !== tagIds.length) return false;
  }

  const statements: D1PreparedStatement[] = [
    db.prepare(`DELETE FROM article_save_tags WHERE user_id = ? AND article_id = ?`)
      .bind(userId, articleId),
    ...tagIds.map((tagId) => db.prepare(`
      INSERT INTO article_save_tags (user_id, article_id, tag_id)
      VALUES (?, ?, ?)
    `).bind(userId, articleId, tagId))
  ];
  await db.batch(statements);
  return true;
}