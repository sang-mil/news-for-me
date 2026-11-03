$ErrorActionPreference = "Stop"
$ProjectRoot = (Get-Location).Path

function Write-Utf8BomFile {
    param(
        [Parameter(Mandatory = $true)][string]$RelativePath,
        [Parameter(Mandatory = $true)][string]$Content,
        [switch]$NewOnly
    )

    $target = Join-Path $ProjectRoot $RelativePath
    $parent = Split-Path -Parent $target
    if (-not (Test-Path -LiteralPath $parent)) {
        New-Item -ItemType Directory -Path $parent -Force | Out-Null
    }
    if ($NewOnly -and (Test-Path -LiteralPath $target)) {
        throw "새 파일이어야 하지만 이미 존재합니다: $RelativePath"
    }
    $encoding = New-Object System.Text.UTF8Encoding($true)
    [System.IO.File]::WriteAllText($target, $Content, $encoding)
    Write-Host "[WRITE] $RelativePath" -ForegroundColor Green
}

function Backup-File {
    param([string]$RelativePath)
    $source = Join-Path $ProjectRoot $RelativePath
    if (-not (Test-Path -LiteralPath $source -PathType Leaf)) {
        throw "필수 파일을 찾을 수 없습니다: $RelativePath"
    }
    $relativeBackup = ".local-backups\personal-archive-$(Get-Date -Format 'yyyyMMdd-HHmmss')\$RelativePath"
    $destination = Join-Path $ProjectRoot $relativeBackup
    $destinationParent = Split-Path -Parent $destination
    New-Item -ItemType Directory -Path $destinationParent -Force | Out-Null
    Copy-Item -LiteralPath $source -Destination $destination -Force
    Write-Host "[BACKUP] $RelativePath" -ForegroundColor DarkCyan
}

Write-Host "==============================================" -ForegroundColor Cyan
Write-Host " News-for-me Personal Archive Upgrade" -ForegroundColor Cyan
Write-Host "==============================================" -ForegroundColor Cyan

$requiredFiles = @(
    "apps\web\src\App.tsx",
    "apps\web\src\lib\api.ts",
    "apps\web\src\styles\index.css",
    "packages\shared\src\index.ts",
    "apps\worker\src\index.ts",
    "apps\worker\src\routes\scraps.ts",
    "apps\worker\src\db\repositories\scraps.ts",
    "apps\worker\migrations\0003_article_saves.sql"
)
foreach ($file in $requiredFiles) {
    if (-not (Test-Path -LiteralPath (Join-Path $ProjectRoot $file) -PathType Leaf)) {
        throw "필수 파일이 없습니다. 프로젝트 루트에서 실행했는지 확인하세요: $file"
    }
}

$migrationPath = Join-Path $ProjectRoot "apps\worker\migrations\0004_personal_archive.sql"
if (Test-Path -LiteralPath $migrationPath) {
    throw "0004_personal_archive.sql이 이미 존재합니다. 중복 마이그레이션을 막기 위해 중단합니다."
}

$targets = @(
    "apps\web\src\App.tsx",
    "apps\web\src\lib\api.ts",
    "apps\web\src\styles\index.css",
    "packages\shared\src\index.ts",
    "apps\worker\src\index.ts",
    "apps\worker\src\routes\scraps.ts",
    "apps\worker\src\db\repositories\scraps.ts"
)
foreach ($file in $targets) { Backup-File $file }

# 1. D1 migration. updated_at is backfilled from saved_at because SQLite
# ALTER TABLE ADD COLUMN does not allow a non-constant expression default.
$migration = @'
-- Personal archive: memo and user-owned tags for saved news.
ALTER TABLE article_saves ADD COLUMN note TEXT;
ALTER TABLE article_saves ADD COLUMN updated_at TEXT;

UPDATE article_saves
SET updated_at = saved_at
WHERE updated_at IS NULL;

CREATE TABLE user_tags (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    name TEXT NOT NULL,
    color TEXT NOT NULL DEFAULT '#64748b',
    created_at TEXT NOT NULL DEFAULT
        (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    UNIQUE (user_id, id),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX idx_user_tags_user_name
    ON user_tags(user_id, name COLLATE NOCASE);

CREATE TABLE article_save_tags (
    user_id TEXT NOT NULL,
    article_id TEXT NOT NULL,
    tag_id TEXT NOT NULL,
    added_at TEXT NOT NULL DEFAULT
        (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    PRIMARY KEY (user_id, article_id, tag_id),
    FOREIGN KEY (user_id, article_id)
        REFERENCES article_saves(user_id, article_id) ON DELETE CASCADE,
    FOREIGN KEY (user_id, tag_id)
        REFERENCES user_tags(user_id, id) ON DELETE CASCADE
);

CREATE INDEX idx_article_save_tags_tag
    ON article_save_tags(user_id, tag_id);
'@
Write-Utf8BomFile "apps\worker\migrations\0004_personal_archive.sql" $migration -NewOnly

# 2. Shared types
$shared = @'
export interface ApiHealthResponse {
  ok: boolean;
  service: "news-for-me-api";
  timestamp: string;
  database: "connected";
}

export interface Topic {
  id: string;
  name: string;
  description: string | null;
  includeKeywords: string[];
  excludeKeywords: string[];
  isActive: boolean;
  lastCollectedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface TopicInput {
  name: string;
  description?: string | null;
  includeKeywords?: string[];
  excludeKeywords?: string[];
}

export interface TopicListResponse { data: Topic[]; }
export interface TopicResponse { data: Topic; }
export interface ApiErrorResponse { error: string; details?: string[]; }
export type CollectionStatus = "queued" | "running" | "completed" | "failed";

export interface NewsArticle {
  id: string;
  title: string;
  canonicalUrl: string;
  sourceName: string | null;
  publishedAt: string | null;
  fetchedAt: string;
  contentExcerpt: string | null;
}

export interface CollectionRun {
  id: string;
  topicId: string;
  status: CollectionStatus;
  articlesFound: number;
  errorMessage: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
}

export interface CollectionStartResponse {
  data: { runId: string; status: "queued"; };
}
export interface CollectionRunResponse { data: CollectionRun; }
export interface NewsArticleListResponse { data: NewsArticle[]; }

export interface SavedNewsTag {
  id: string;
  name: string;
  color: string;
  createdAt: string;
}

export interface SavedNewsArticle extends NewsArticle {
  savedAt: string;
  note: string | null;
  updatedAt: string;
  tags: SavedNewsTag[];
}
'@
Write-Utf8BomFile "packages\shared\src\index.ts" $shared

# 3. Scrap repository with per-user memo and tag persistence.
$repository = @'
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
    INNER JOIN topics t ON t.id = ta.topic_id
    WHERE a.id = ? AND ta.topic_id = ? AND t.user_id = ?
  `).bind(userId, articleId, topicId, userId).run();

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
'@
Write-Utf8BomFile "apps\worker\src\db\repositories\scraps.ts" $repository

# 4. Scrap/tag routes.
$routes = @'
import type { SavedNewsArticle, SavedNewsTag } from "@news-for-me/shared";
import { jsonResponse } from "../lib/http";
import {
  createUserTag,
  deleteUserTag,
  listSavedArticles,
  listUserTags,
  removeSavedArticle,
  replaceSavedArticleTags,
  saveArticleForUser,
  updateSavedArticleNote,
  updateUserTag
} from "../db/repositories/scraps";

async function readJson(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const value: unknown = await request.json();
    return value && typeof value === "object" && !Array.isArray(value)
      ? value as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function validTagName(value: unknown): value is string {
  return typeof value === "string" && value.trim().length >= 1 && value.trim().length <= 30;
}

function validColor(value: unknown): value is string {
  return typeof value === "string" && /^#[0-9a-fA-F]{6}$/.test(value);
}

export async function handleScrapsRequest(
  request: Request,
  db: D1Database,
  userId: string,
  allowedOrigin: string
): Promise<Response> {
  const url = new URL(request.url);

  if (url.pathname === "/api/scraps" && request.method === "GET") {
    const requestedLimit = Number(url.searchParams.get("limit") ?? "100");
    const limit = Number.isFinite(requestedLimit)
      ? Math.min(200, Math.max(1, Math.floor(requestedLimit)))
      : 100;
    const data: SavedNewsArticle[] = await listSavedArticles(db, userId, limit);
    return jsonResponse({ data }, 200, allowedOrigin);
  }

  if (url.pathname === "/api/tags" && request.method === "GET") {
    const data: SavedNewsTag[] = await listUserTags(db, userId);
    return jsonResponse({ data }, 200, allowedOrigin);
  }

  if (url.pathname === "/api/tags" && request.method === "POST") {
    const body = await readJson(request);
    const name = body?.name;
    if (!validTagName(name)) {
      return jsonResponse({ error: "Tag name must contain 1–30 characters." }, 400, allowedOrigin);
    }
    const colorValue = body?.color === undefined ? "#64748b" : body.color;
    if (!validColor(colorValue)) {
      return jsonResponse({ error: "Tag color must be a six-digit hex color." }, 400, allowedOrigin);
    }
    try {
      const data = await createUserTag(db, userId, name.trim(), colorValue);
      return jsonResponse({ data }, 201, allowedOrigin);
    } catch {
      return jsonResponse({ error: "A tag with this name already exists." }, 409, allowedOrigin);
    }
  }

  const tagMatch = url.pathname.match(/^\/api\/tags\/([^/]+)$/);
  if (tagMatch && request.method === "PATCH") {
    let tagId: string;
    try { tagId = decodeURIComponent(tagMatch[1]); }
    catch { return jsonResponse({ error: "Invalid tag ID." }, 400, allowedOrigin); }

    const body = await readJson(request);
    if (!body) return jsonResponse({ error: "Invalid JSON body." }, 400, allowedOrigin);
    const name = body.name === undefined ? null : body.name;
    const color = body.color === undefined ? null : body.color;
    if (name !== null && !validTagName(name)) {
      return jsonResponse({ error: "Tag name must contain 1–30 characters." }, 400, allowedOrigin);
    }
    if (color !== null && !validColor(color)) {
      return jsonResponse({ error: "Tag color must be a six-digit hex color." }, 400, allowedOrigin);
    }
    if (name === null && color === null) {
      return jsonResponse({ error: "Provide a tag name or color to update." }, 400, allowedOrigin);
    }
    try {
      const data = await updateUserTag(
        db, userId, tagId,
        typeof name === "string" ? name.trim() : null,
        typeof color === "string" ? color : null
      );
      return data
        ? jsonResponse({ data }, 200, allowedOrigin)
        : jsonResponse({ error: "Tag not found." }, 404, allowedOrigin);
    } catch {
      return jsonResponse({ error: "A tag with this name already exists." }, 409, allowedOrigin);
    }
  }

  if (tagMatch && request.method === "DELETE") {
    let tagId: string;
    try { tagId = decodeURIComponent(tagMatch[1]); }
    catch { return jsonResponse({ error: "Invalid tag ID." }, 400, allowedOrigin); }
    await deleteUserTag(db, userId, tagId);
    return jsonResponse({ ok: true }, 200, allowedOrigin);
  }

  const noteMatch = url.pathname.match(/^\/api\/scraps\/([^/]+)\/note$/);
  if (noteMatch && request.method === "PATCH") {
    let articleId: string;
    try { articleId = decodeURIComponent(noteMatch[1]); }
    catch { return jsonResponse({ error: "Invalid article ID." }, 400, allowedOrigin); }
    const body = await readJson(request);
    if (!body || typeof body.note !== "string" || body.note.length > 5000) {
      return jsonResponse({ error: "Note must be a string up to 5000 characters." }, 400, allowedOrigin);
    }
    const note = body.note.trim() || null;
    const data = await updateSavedArticleNote(db, userId, articleId, note);
    return data
      ? jsonResponse({ data }, 200, allowedOrigin)
      : jsonResponse({ error: "Saved article not found." }, 404, allowedOrigin);
  }

  const articleTagsMatch = url.pathname.match(/^\/api\/scraps\/([^/]+)\/tags$/);
  if (articleTagsMatch && request.method === "PUT") {
    let articleId: string;
    try { articleId = decodeURIComponent(articleTagsMatch[1]); }
    catch { return jsonResponse({ error: "Invalid article ID." }, 400, allowedOrigin); }
    const body = await readJson(request);
    if (!body || !Array.isArray(body.tagIds) || body.tagIds.length > 20 ||
        !body.tagIds.every((id) => typeof id === "string" && id.length <= 100)) {
      return jsonResponse({ error: "tagIds must be an array of up to 20 tag IDs." }, 400, allowedOrigin);
    }
    const tagIds = [...new Set(body.tagIds as string[])];
    const ok = await replaceSavedArticleTags(db, userId, articleId, tagIds);
    if (!ok) {
      return jsonResponse({ error: "Saved article or one of the tags was not found." }, 404, allowedOrigin);
    }
    const data = await listSavedArticles(db, userId, 200);
    const article = data.find((item) => item.id === articleId);
    return article
      ? jsonResponse({ data: article }, 200, allowedOrigin)
      : jsonResponse({ error: "Saved article not found." }, 404, allowedOrigin);
  }

  const saveMatch = url.pathname.match(/^\/api\/topics\/([^/]+)\/articles\/([^/]+)\/scrap$/);
  if (saveMatch && request.method === "POST") {
    let topicId: string;
    let articleId: string;
    try {
      topicId = decodeURIComponent(saveMatch[1]);
      articleId = decodeURIComponent(saveMatch[2]);
    } catch {
      return jsonResponse({ error: "Invalid topic or article ID." }, 400, allowedOrigin);
    }
    const saved = await saveArticleForUser(db, userId, topicId, articleId);
    if (!saved) {
      return jsonResponse({ error: "Article not found in one of your topics." }, 404, allowedOrigin);
    }
    return jsonResponse({ data: saved }, 201, allowedOrigin);
  }

  const removeMatch = url.pathname.match(/^\/api\/scraps\/([^/]+)$/);
  if (removeMatch && request.method === "DELETE") {
    let articleId: string;
    try { articleId = decodeURIComponent(removeMatch[1]); }
    catch { return jsonResponse({ error: "Invalid article ID." }, 400, allowedOrigin); }
    await removeSavedArticle(db, userId, articleId);
    return jsonResponse({ ok: true }, 200, allowedOrigin);
  }

  return jsonResponse({ error: "Not Found" }, 404, allowedOrigin);
}
'@
Write-Utf8BomFile "apps\worker\src\routes\scraps.ts" $routes

# 5. Patch Worker routing and CORS without replacing the worker/queue handlers.
$indexPath = Join-Path $ProjectRoot "apps\worker\src\index.ts"
$indexContent = Get-Content -LiteralPath $indexPath -Raw -Encoding UTF8
$oldMethods = '"Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",'
$newMethods = '"Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",'
if ($indexContent.Contains($oldMethods)) {
    $indexContent = $indexContent.Replace($oldMethods, $newMethods)
} elseif (-not $indexContent.Contains($newMethods)) {
    throw "Worker CORS method declaration could not be located."
}
$oldScrapsCondition = 'url.pathname.startsWith("/api/scraps/") ||'
$newScrapsCondition = 'url.pathname.startsWith("/api/scraps/") ||' + [Environment]::NewLine +
    '      url.pathname === "/api/tags" ||' + [Environment]::NewLine +
    '      url.pathname.startsWith("/api/tags/") ||'
if ($indexContent.Contains($oldScrapsCondition)) {
    $indexContent = $indexContent.Replace($oldScrapsCondition, $newScrapsCondition)
} elseif (-not ($indexContent.Contains('url.pathname === "/api/tags"') -and $indexContent.Contains('url.pathname.startsWith("/api/tags/")'))) {
    throw "Worker scraps API routing condition could not be located."
}
$encoding = New-Object System.Text.UTF8Encoding($true)
[System.IO.File]::WriteAllText($indexPath, $indexContent, $encoding)
Write-Host "[PATCH] apps\worker\src\index.ts" -ForegroundColor Green

# 6. API client
$apiClient = @'
import type {
  ApiHealthResponse,
  CollectionRun,
  CollectionStartResponse,
  NewsArticle,
  SavedNewsArticle,
  SavedNewsTag,
  Topic,
  TopicInput,
  TopicListResponse,
  TopicResponse
} from "@news-for-me/shared";

const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL ?? "").replace(/\/$/, "");

interface ErrorPayload { error?: string; details?: string[]; }

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  headers.set("Accept", "application/json");
  if (init?.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  const response = await fetch(`${API_BASE_URL}${path}`, { ...init, headers });
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const errorPayload = payload as ErrorPayload | null;
    const detail = errorPayload?.details?.join(" ");
    throw new Error([errorPayload?.error ?? `Request failed (${response.status})`, detail].filter(Boolean).join(" "));
  }
  return payload as T;
}

export async function getApiHealth(): Promise<ApiHealthResponse> {
  return request<ApiHealthResponse>("/api/health");
}
export async function listTopics(): Promise<Topic[]> {
  const response = await request<TopicListResponse>("/api/topics");
  return response.data;
}
export async function createTopic(input: TopicInput): Promise<Topic> {
  const response = await request<TopicResponse>("/api/topics", { method: "POST", body: JSON.stringify(input) });
  return response.data;
}
export async function updateTopic(id: string, input: Partial<TopicInput>): Promise<Topic> {
  const response = await request<TopicResponse>(`/api/topics/${encodeURIComponent(id)}`, {
    method: "PATCH", body: JSON.stringify(input)
  });
  return response.data;
}
export async function deleteTopic(id: string): Promise<void> {
  await request<{ ok: boolean }>(`/api/topics/${encodeURIComponent(id)}`, { method: "DELETE" });
}
export async function collectTopic(id: string): Promise<string> {
  const response = await request<CollectionStartResponse>(`/api/topics/${encodeURIComponent(id)}/collect`, { method: "POST" });
  return response.data.runId;
}
export async function getCollectionRun(topicId: string, runId: string): Promise<CollectionRun> {
  const response = await request<{ data: CollectionRun }>(
    `/api/topics/${encodeURIComponent(topicId)}/collection-runs/${encodeURIComponent(runId)}`
  );
  return response.data;
}
export async function listTopicArticles(topicId: string, limit = 20): Promise<NewsArticle[]> {
  const response = await request<{ data: NewsArticle[] }>(
    `/api/topics/${encodeURIComponent(topicId)}/articles?limit=${limit}`
  );
  return response.data;
}
export async function listScraps(limit = 100): Promise<SavedNewsArticle[]> {
  const response = await request<{ data: SavedNewsArticle[] }>(`/api/scraps?limit=${limit}`);
  return response.data;
}
export async function saveArticle(topicId: string, articleId: string): Promise<SavedNewsArticle> {
  const response = await request<{ data: SavedNewsArticle }>(
    `/api/topics/${encodeURIComponent(topicId)}/articles/${encodeURIComponent(articleId)}/scrap`,
    { method: "POST" }
  );
  return response.data;
}
export async function unsaveArticle(articleId: string): Promise<void> {
  await request<{ ok: boolean }>(`/api/scraps/${encodeURIComponent(articleId)}`, { method: "DELETE" });
}
export async function listTags(): Promise<SavedNewsTag[]> {
  const response = await request<{ data: SavedNewsTag[] }>("/api/tags");
  return response.data;
}
export async function createTag(name: string, color: string): Promise<SavedNewsTag> {
  const response = await request<{ data: SavedNewsTag }>("/api/tags", {
    method: "POST", body: JSON.stringify({ name, color })
  });
  return response.data;
}
export async function updateTag(tagId: string, input: { name?: string; color?: string }): Promise<SavedNewsTag> {
  const response = await request<{ data: SavedNewsTag }>(`/api/tags/${encodeURIComponent(tagId)}`, {
    method: "PATCH", body: JSON.stringify(input)
  });
  return response.data;
}
export async function deleteTag(tagId: string): Promise<void> {
  await request<{ ok: boolean }>(`/api/tags/${encodeURIComponent(tagId)}`, { method: "DELETE" });
}
export async function updateScrapNote(articleId: string, note: string): Promise<SavedNewsArticle> {
  const response = await request<{ data: SavedNewsArticle }>(`/api/scraps/${encodeURIComponent(articleId)}/note`, {
    method: "PATCH", body: JSON.stringify({ note })
  });
  return response.data;
}
export async function replaceScrapTags(articleId: string, tagIds: string[]): Promise<SavedNewsArticle> {
  const response = await request<{ data: SavedNewsArticle }>(`/api/scraps/${encodeURIComponent(articleId)}/tags`, {
    method: "PUT", body: JSON.stringify({ tagIds })
  });
  return response.data;
}
'@
Write-Utf8BomFile "apps\web\src\lib\api.ts" $apiClient

# 7. Updated React app: keep topic CRUD/collection and add archive notes/tags/search.
$app = @'
import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import type {
  ApiHealthResponse, CollectionRun, NewsArticle, SavedNewsArticle,
  SavedNewsTag, Topic, TopicInput
} from "@news-for-me/shared";
import {
  collectTopic, createTopic, deleteTopic, getApiHealth, getCollectionRun,
  listTopicArticles, listScraps, listTags, listTopics, updateTopic,
  saveArticle, unsaveArticle, updateScrapNote, replaceScrapTags,
  createTag, deleteTag, updateTag
} from "./lib/api";

type ApiStatus = "checking" | "online" | "offline";
interface TopicFormState {
  name: string;
  description: string;
  includeKeywords: string;
  excludeKeywords: string;
}
const EMPTY_FORM: TopicFormState = { name: "", description: "", includeKeywords: "", excludeKeywords: "" };

function splitKeywords(value: string): string[] {
  return [...new Set(value.split(/[，,\n]/).map((item) => item.trim()).filter(Boolean))];
}
function toInput(form: TopicFormState): TopicInput {
  return {
    name: form.name.trim(),
    description: form.description.trim() || null,
    includeKeywords: splitKeywords(form.includeKeywords),
    excludeKeywords: splitKeywords(form.excludeKeywords)
  };
}
function formatDate(value: string | null): string {
  if (!value) return "날짜 정보 없음";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "날짜 정보 없음";
  return new Intl.DateTimeFormat("ko-KR", {
    year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit"
  }).format(date);
}
function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}

export default function App() {
  const [status, setStatus] = useState<ApiStatus>("checking");
  const [health, setHealth] = useState<ApiHealthResponse | null>(null);
  const [topics, setTopics] = useState<Topic[]>([]);
  const [articlesByTopic, setArticlesByTopic] = useState<Record<string, NewsArticle[]>>({});
  const [scraps, setScraps] = useState<SavedNewsArticle[]>([]);
  const [tags, setTags] = useState<SavedNewsTag[]>([]);
  const [noteDrafts, setNoteDrafts] = useState<Record<string, string>>({});
  const [tagDrafts, setTagDrafts] = useState<Record<string, string[]>>({});
  const [archiveQuery, setArchiveQuery] = useState("");
  const [archiveTagFilter, setArchiveTagFilter] = useState("all");
  const [newTagName, setNewTagName] = useState("");
  const [newTagColor, setNewTagColor] = useState("#64748b");
  const [busyArchiveId, setBusyArchiveId] = useState<string | null>(null);
  const [expandedTopicId, setExpandedTopicId] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [collectingTopicId, setCollectingTopicId] = useState<string | null>(null);
  const [collectionRuns, setCollectionRuns] = useState<Record<string, CollectionRun>>({});
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [form, setForm] = useState<TopicFormState>(EMPTY_FORM);
  const [editingId, setEditingId] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setIsLoading(true);
    setError("");
    try {
      const [apiHealth, topicList, savedArticles, userTags] = await Promise.all([
        getApiHealth(), listTopics(), listScraps(), listTags()
      ]);
      setHealth(apiHealth);
      setStatus("online");
      setTopics(topicList);
      setScraps(savedArticles);
      setTags(userTags);
    } catch (err) {
      setStatus("offline");
      setHealth(null);
      setError(err instanceof Error ? err.message : "데이터를 불러오지 못했습니다.");
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  function resetForm() {
    setForm(EMPTY_FORM);
    setEditingId(null);
  }
  function startEdit(topic: Topic) {
    setEditingId(topic.id);
    setForm({
      name: topic.name,
      description: topic.description ?? "",
      includeKeywords: topic.includeKeywords.join(", "),
      excludeKeywords: topic.excludeKeywords.join(", ")
    });
    setNotice("");
    setError("");
    document.getElementById("topic-form")?.scrollIntoView({ behavior: "smooth", block: "center" });
  }
  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setIsSaving(true);
    setError("");
    setNotice("");
    try {
      const input = toInput(form);
      if (editingId) {
        await updateTopic(editingId, input);
        setNotice("관심 항목을 수정했어요.");
      } else {
        await createTopic(input);
        setNotice("새 관심 항목을 등록했어요.");
      }
      resetForm();
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "저장에 실패했습니다.");
    } finally {
      setIsSaving(false);
    }
  }
  async function handleDelete(topic: Topic) {
    if (!window.confirm(`'${topic.name}' 관심 항목을 삭제할까요?`)) return;
    setError(""); setNotice("");
    try {
      await deleteTopic(topic.id);
      if (editingId === topic.id) resetForm();
      setTopics((current) => current.filter((item) => item.id !== topic.id));
      setArticlesByTopic((current) => {
        const next = { ...current }; delete next[topic.id]; return next;
      });
      setNotice(`'${topic.name}' 항목을 삭제했어요.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "삭제에 실패했습니다.");
    }
  }
  async function loadArticles(topicId: string) {
    setExpandedTopicId(topicId);
    try {
      const articles = await listTopicArticles(topicId);
      setArticlesByTopic((current) => ({ ...current, [topicId]: articles }));
    } catch (err) {
      setError(err instanceof Error ? err.message : "뉴스 목록을 불러오지 못했습니다.");
    }
  }
  async function reloadScraps() {
    const saved = await listScraps();
    setScraps(saved);
    return saved;
  }
  async function handleToggleScrap(topicId: string, article: NewsArticle) {
    setError(""); setNotice("");
    const alreadySaved = scraps.some((item) => item.id === article.id);
    try {
      if (alreadySaved) {
        await unsaveArticle(article.id);
        setNotice("스크랩을 해제했어요. 다음 주간 정리 대상이 됩니다.");
      } else {
        await saveArticle(topicId, article.id);
        setNotice("뉴스를 스크랩 보관함에 저장했어요.");
      }
      await reloadScraps();
    } catch (err) {
      setError(err instanceof Error ? err.message : "스크랩 처리에 실패했습니다.");
    }
  }
  async function handleRemoveScrap(articleId: string) {
    setError(""); setNotice("");
    try {
      await unsaveArticle(articleId);
      await reloadScraps();
      setNotice("스크랩을 해제했어요. 다음 주간 정리 대상이 됩니다.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "스크랩 해제에 실패했습니다.");
    }
  }
  async function handleSaveNote(articleId: string) {
    setBusyArchiveId(articleId); setError(""); setNotice("");
    try {
      await updateScrapNote(articleId, noteDrafts[articleId] ?? "");
      await reloadScraps();
      setNotice("개인 메모를 저장했어요.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "메모 저장에 실패했습니다.");
    } finally {
      setBusyArchiveId(null);
    }
  }
  async function handleApplyTags(articleId: string, currentTags: SavedNewsTag[]) {
    setBusyArchiveId(articleId); setError(""); setNotice("");
    try {
      const selected = tagDrafts[articleId] ?? currentTags.map((tag) => tag.id);
      await replaceScrapTags(articleId, selected);
      await reloadScraps();
      setNotice("뉴스 태그를 저장했어요.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "태그 저장에 실패했습니다.");
    } finally {
      setBusyArchiveId(null);
    }
  }
  async function handleCreateTag(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(""); setNotice("");
    try {
      await createTag(newTagName.trim(), newTagColor);
      setTags(await listTags());
      setNewTagName("");
      setNotice("새 태그를 만들었어요.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "태그 생성에 실패했습니다.");
    }
  }
  async function handleRenameTag(tag: SavedNewsTag) {
    const nextName = window.prompt("새 태그 이름을 입력하세요.", tag.name);
    if (nextName === null || !nextName.trim() || nextName.trim() === tag.name) return;
    try {
      await updateTag(tag.id, { name: nextName.trim() });
      setTags(await listTags());
      await reloadScraps();
      setNotice("태그 이름을 변경했어요.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "태그 이름 변경에 실패했습니다.");
    }
  }
  async function handleDeleteTag(tag: SavedNewsTag) {
    if (!window.confirm(`'${tag.name}' 태그를 삭제할까요? 연결된 뉴스의 태그 지정도 해제됩니다.`)) return;
    try {
      await deleteTag(tag.id);
      setTags(await listTags());
      await reloadScraps();
      setTagDrafts((current) => Object.fromEntries(
        Object.entries(current).map(([articleId, ids]) => [articleId, ids.filter((id) => id !== tag.id)])
      ));
      setNotice(`'${tag.name}' 태그를 삭제했어요.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "태그 삭제에 실패했습니다.");
    }
  }
  async function handleCollect(topic: Topic) {
    setCollectingTopicId(topic.id); setError(""); setNotice("");
    try {
      const runId = await collectTopic(topic.id);
      setNotice(`'${topic.name}' 뉴스 수집 작업을 대기열에 등록했어요.`);
      for (let attempt = 0; attempt < 20; attempt += 1) {
        await wait(1500);
        const run = await getCollectionRun(topic.id, runId);
        setCollectionRuns((current) => ({ ...current, [topic.id]: run }));
        if (run.status === "completed") {
          const articles = await listTopicArticles(topic.id);
          setArticlesByTopic((current) => ({ ...current, [topic.id]: articles }));
          setExpandedTopicId(topic.id);
          setTopics(await listTopics());
          setNotice(`'${topic.name}' 수집 완료: ${run.articlesFound}개 기사를 확인했어요.`);
          return;
        }
        if (run.status === "failed") throw new Error(run.errorMessage ?? "뉴스 수집에 실패했습니다.");
      }
      setNotice(`'${topic.name}' 수집 작업이 아직 진행 중이에요. 잠시 후 다시 확인해 주세요.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "뉴스 수집 요청에 실패했습니다.");
    } finally {
      setCollectingTopicId(null);
    }
  }

  const filteredScraps = useMemo(() => {
    const query = archiveQuery.trim().toLocaleLowerCase();
    return scraps.filter((article) => {
      const matchesQuery = !query || [
        article.title, article.sourceName ?? "", article.contentExcerpt ?? "", article.note ?? "",
        ...article.tags.map((tag) => tag.name)
      ].some((value) => value.toLocaleLowerCase().includes(query));
      const matchesTag = archiveTagFilter === "all" || article.tags.some((tag) => tag.id === archiveTagFilter);
      return matchesQuery && matchesTag;
    });
  }, [scraps, archiveQuery, archiveTagFilter]);

  return (
    <main className="page-shell">
      <header className="topbar">
        <a className="brand" href="/" aria-label="News for Me 홈">
          <span className="brand-mark">N</span><span>News for Me</span>
        </a>
        <div className={`connection-status ${status}`}>
          <span className="status-light" />
          {status === "checking" ? "연결 확인 중" : status === "online" ? "로컬 API 연결됨" : "API 연결 확인 필요"}
        </div>
      </header>

      <section className="intro-section">
        <div className="eyebrow">PERSONAL NEWS WORKSPACE</div>
        <h1>관심 있는 소식만,<br /><span>놓치지 않도록.</span></h1>
        <p className="intro-copy">관심 주제를 등록하고 뉴스를 수집하세요. 스크랩한 기사는 개인 메모와 태그를 붙여 나만의 뉴스 아카이브로 보관할 수 있습니다.</p>
        <div className="intro-meta">
          <span className="meta-icon">✳</span>
          <span>D1 데이터베이스에 자동 저장됩니다.</span>
          {health && <span className="meta-time">API 확인 {new Date(health.timestamp).toLocaleTimeString("ko-KR")}</span>}
        </div>
      </section>

      {(error || notice) && (
        <div className={`feedback ${error ? "feedback-error" : "feedback-success"}`} role="status">
          <span>{error || notice}</span>
          <button type="button" className="feedback-close" onClick={() => { setError(""); setNotice(""); }} aria-label="알림 닫기">×</button>
        </div>
      )}

      <section className="scraps-section">
        <div className="section-heading archive-heading">
          <div><div className="section-kicker">PERSONAL ARCHIVE</div><h2>스크랩 보관함 <span className="count-badge">{scraps.length}개</span></h2></div>
          <form className="archive-create-tag" onSubmit={(event) => void handleCreateTag(event)}>
            <input aria-label="새 태그 이름" value={newTagName} onChange={(event) => setNewTagName(event.target.value)} maxLength={30} placeholder="새 태그 이름" required />
            <input aria-label="태그 색상" type="color" value={newTagColor} onChange={(event) => setNewTagColor(event.target.value)} />
            <button type="submit" disabled={!newTagName.trim()}>태그 추가</button>
          </form>
        </div>

        <div className="archive-tools">
          <input className="archive-search" value={archiveQuery} onChange={(event) => setArchiveQuery(event.target.value)} placeholder="제목, 출처, 메모, 태그 검색" aria-label="스크랩 뉴스 검색" />
          <select value={archiveTagFilter} onChange={(event) => setArchiveTagFilter(event.target.value)} aria-label="태그 필터">
            <option value="all">모든 태그</option>
            {tags.map((tag) => <option key={tag.id} value={tag.id}>{tag.name}</option>)}
          </select>
        </div>

        {tags.length > 0 && (
          <div className="archive-tag-manager">
            <span className="archive-tool-label">내 태그</span>
            {tags.map((tag) => (
              <span className="archive-managed-tag" key={tag.id}>
                <span className="archive-tag-dot" style={{ backgroundColor: tag.color }} />{tag.name}
                <button type="button" onClick={() => void handleRenameTag(tag)} aria-label={`${tag.name} 태그 이름 변경`}>✎</button>
                <button type="button" onClick={() => void handleDeleteTag(tag)} aria-label={`${tag.name} 태그 삭제`}>×</button>
              </span>
            ))}
          </div>
        )}

        {scraps.length === 0 ? (
          <div className="scraps-empty">아직 스크랩한 뉴스가 없어요. 보관하고 싶은 기사에서 ☆ 스크랩을 눌러주세요.</div>
        ) : filteredScraps.length === 0 ? (
          <div className="scraps-empty">검색 조건에 맞는 뉴스가 없습니다.</div>
        ) : (
          <div className="scraps-list">
            {filteredScraps.map((article) => {
              const selectedTagIds = tagDrafts[article.id] ?? article.tags.map((tag) => tag.id);
              return (
                <article className="scrap-card archive-card" key={article.id}>
                  <div className="scrap-card-content">
                    <a href={article.canonicalUrl} target="_blank" rel="noreferrer">{article.title}</a>
                    <div className="article-meta">{article.sourceName ?? "출처 미상"} · 발행 {formatDate(article.publishedAt)} · 스크랩 {formatDate(article.savedAt)}</div>
                    {article.contentExcerpt && <p>{article.contentExcerpt}</p>}
                  </div>

                  <div className="archive-editor">
                    <label className="archive-tool-label" htmlFor={`note-${article.id}`}>개인 메모</label>
                    <textarea
                      id={`note-${article.id}`}
                      className="archive-note"
                      rows={3}
                      maxLength={5000}
                      placeholder="이 뉴스에서 기억할 점이나 나중에 확인할 내용을 기록하세요."
                      value={noteDrafts[article.id] ?? article.note ?? ""}
                      onChange={(event) => setNoteDrafts((current) => ({ ...current, [article.id]: event.target.value }))}
                    />
                    <div className="archive-editor-actions">
                      <span className="archive-char-count">{(noteDrafts[article.id] ?? article.note ?? "").length}/5000</span>
                      <button type="button" className="archive-save-button" disabled={busyArchiveId === article.id} onClick={() => void handleSaveNote(article.id)}>
                        메모 저장
                      </button>
                    </div>

                    <div className="archive-tool-label">태그</div>
                    {tags.length === 0 ? (
                      <p className="archive-hint">위에서 태그를 먼저 만들어 주세요.</p>
                    ) : (
                      <div className="archive-tag-choices">
                        {tags.map((tag) => (
                          <label className="archive-tag-choice" key={tag.id}>
                            <input
                              type="checkbox"
                              checked={selectedTagIds.includes(tag.id)}
                              onChange={(event) => setTagDrafts((current) => {
                                const base = current[article.id] ?? article.tags.map((item) => item.id);
                                const next = event.target.checked
                                  ? [...base, tag.id]
                                  : base.filter((id) => id !== tag.id);
                                return { ...current, [article.id]: next };
                              })}
                            />
                            <span className="archive-tag-dot" style={{ backgroundColor: tag.color }} />{tag.name}
                          </label>
                        ))}
                      </div>
                    )}
                    <div className="archive-editor-actions">
                      <span className="archive-hint">현재 {article.tags.length}개 태그</span>
                      <button type="button" className="archive-save-button" disabled={busyArchiveId === article.id} onClick={() => void handleApplyTags(article.id, article.tags)}>
                        태그 저장
                      </button>
                    </div>
                    {article.tags.length > 0 && (
                      <div className="archive-current-tags">
                        {article.tags.map((tag) => <span className="archive-tag-pill" key={tag.id} style={{ borderColor: tag.color, color: tag.color }}>{tag.name}</span>)}
                      </div>
                    )}
                  </div>

                  <button type="button" className="scrap-button is-scrapped" onClick={() => void handleRemoveScrap(article.id)}>
                    ★ 스크랩 해제
                  </button>
                </article>
              );
            })}
          </div>
        )}
      </section>

      <section className="workspace-grid">
        <section className="topics-section">
          <div className="section-heading">
            <div><div className="section-kicker">YOUR TOPICS</div><h2>관심 항목</h2></div>
            <span className="count-badge">{topics.length}개</span>
          </div>

          {isLoading ? (
            <div className="empty-state"><div className="loading-spinner" /><p>관심 항목을 불러오는 중입니다.</p></div>
          ) : topics.length === 0 ? (
            <div className="empty-state"><div className="empty-symbol">✳</div><h3>아직 등록된 관심 항목이 없어요.</h3><p>오른쪽에서 첫 번째 관심 주제를 추가해 보세요.</p></div>
          ) : (
            <div className="topic-list">
              {topics.map((topic) => {
                const run = collectionRuns[topic.id];
                const articles = articlesByTopic[topic.id];
                return (
                  <article className="topic-card" key={topic.id}>
                    <div className="topic-card-main">
                      <div className="topic-card-title-row"><h3>{topic.name}</h3><span className="topic-date">{formatDate(topic.createdAt)}</span></div>
                      {topic.description && <p className="topic-description">{topic.description}</p>}
                      <div className="keyword-groups">
                        {topic.includeKeywords.length > 0 && <div className="keyword-row"><span className="keyword-label">포함</span>{topic.includeKeywords.map((keyword) => <span className="keyword-chip" key={`in-${keyword}`}>{keyword}</span>)}</div>}
                        {topic.excludeKeywords.length > 0 && <div className="keyword-row"><span className="keyword-label excluded">제외</span>{topic.excludeKeywords.map((keyword) => <span className="keyword-chip keyword-chip-muted" key={`out-${keyword}`}>{keyword}</span>)}</div>}
                        {topic.includeKeywords.length === 0 && topic.excludeKeywords.length === 0 && <span className="keyword-hint">키워드 조건 없음</span>}
                      </div>
                      {run && <div className="collection-status">최근 수집 작업: {run.status} · {run.articlesFound}건</div>}
                      {expandedTopicId === topic.id && (
                        <div className="article-list">
                          <div className="article-list-heading">최근 수집 기사</div>
                          {!articles || articles.length === 0 ? <p className="article-empty">저장된 기사가 없습니다. 뉴스 수집을 실행해 보세요.</p> : articles.map((article) => {
                            const isScrapped = scraps.some((saved) => saved.id === article.id);
                            return (
                              <div className="article-item article-item-with-action" key={article.id}>
                                <div className="article-item-content">
                                  <a href={article.canonicalUrl} target="_blank" rel="noreferrer">{article.title}</a>
                                  <div className="article-meta">{article.sourceName ?? "출처 미상"} · {formatDate(article.publishedAt)}</div>
                                  {article.contentExcerpt && <p>{article.contentExcerpt}</p>}
                                </div>
                                <button type="button" className={`scrap-button ${isScrapped ? "is-scrapped" : ""}`} onClick={() => void handleToggleScrap(topic.id, article)}>
                                  {isScrapped ? "★ 스크랩 해제" : "☆ 스크랩"}
                                </button>
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </div>
                    <div className="topic-actions topic-actions-column">
                      <button type="button" className="icon-button collect-button" onClick={() => void handleCollect(topic)} disabled={collectingTopicId !== null || status !== "online"}>{collectingTopicId === topic.id ? "수집 중…" : "뉴스 수집"}</button>
                      <button type="button" className="icon-button" onClick={() => void loadArticles(topic.id)}>기사 보기</button>
                      <button type="button" className="icon-button" onClick={() => startEdit(topic)}>수정</button>
                      <button type="button" className="icon-button danger" onClick={() => void handleDelete(topic)}>삭제</button>
                    </div>
                  </article>
                );
              })}
            </div>
          )}
        </section>

        <aside className="form-section" id="topic-form">
          <div className="section-heading form-heading">
            <div><div className="section-kicker">{editingId ? "EDIT TOPIC" : "NEW TOPIC"}</div><h2>{editingId ? "항목 수정" : "새 항목 추가"}</h2></div>
            {editingId && <button type="button" className="text-button" onClick={resetForm}>취소</button>}
          </div>
          <form onSubmit={(event) => void handleSubmit(event)} className="topic-form">
            <label className="field-label" htmlFor="topic-name">관심 주제 <span>*</span></label>
            <input id="topic-name" className="text-input" type="text" maxLength={80} placeholder="예: OpenAI, NVIDIA, 게임 산업" value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} required />
            <label className="field-label" htmlFor="topic-description">설명 <span className="optional">선택</span></label>
            <textarea id="topic-description" className="text-input textarea" maxLength={500} rows={3} placeholder="어떤 소식에 관심이 있는지 적어주세요." value={form.description} onChange={(event) => setForm({ ...form, description: event.target.value })} />
            <label className="field-label" htmlFor="include-keywords">포함 키워드 <span className="optional">선택 · 쉼표로 구분</span></label>
            <input id="include-keywords" className="text-input" type="text" placeholder="신제품, 실적, AI 모델" value={form.includeKeywords} onChange={(event) => setForm({ ...form, includeKeywords: event.target.value })} />
            <label className="field-label" htmlFor="exclude-keywords">제외 키워드 <span className="optional">선택 · 쉼표로 구분</span></label>
            <input id="exclude-keywords" className="text-input" type="text" placeholder="주가 전망, 광고" value={form.excludeKeywords} onChange={(event) => setForm({ ...form, excludeKeywords: event.target.value })} />
            <p className="field-help">키워드는 각각 최대 20개까지 등록할 수 있어요.</p>
            <button className="submit-button" type="submit" disabled={isSaving || status !== "online"}>{isSaving ? "저장 중…" : editingId ? "변경사항 저장" : "관심 항목 등록"}<span aria-hidden="true">→</span></button>
          </form>
          <div className="privacy-note"><span>⌑</span> 현재는 로컬 개발용 사용자 데이터로 저장됩니다.</div>
        </aside>
      </section>
      <footer className="footer"><span>News for Me</span><span>YOUR PERSONAL AI NEWS BRIEFING</span></footer>
    </main>
  );
}
'@
Write-Utf8BomFile "apps\web\src\App.tsx" $app

# 8. Add archive styles without replacing existing styles.
$cssPath = Join-Path $ProjectRoot "apps\web\src\styles\index.css"
$css = @'

/* Personal archive */
.archive-heading { align-items: flex-start; gap: 18px; flex-wrap: wrap; }
.archive-create-tag { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.archive-create-tag input[type="text"], .archive-create-tag input:not([type]) { min-width: 150px; padding: 10px 12px; border: 1px solid #e2e8f0; border-radius: 9px; background: #fff; color: #172033; }
.archive-create-tag input[type="color"] { width: 38px; height: 38px; padding: 3px; border: 1px solid #e2e8f0; border-radius: 8px; background: #fff; cursor: pointer; }
.archive-create-tag button, .archive-save-button { border: 0; border-radius: 9px; padding: 10px 14px; color: #fff; background: #315fe8; font-weight: 700; cursor: pointer; }
.archive-create-tag button:disabled, .archive-save-button:disabled { opacity: .55; cursor: wait; }
.archive-tools { display: flex; gap: 10px; margin: 18px 0; }
.archive-search { flex: 1; min-width: 0; padding: 12px 14px; border: 1px solid #e2e8f0; border-radius: 10px; background: #fff; color: #172033; }
.archive-tools select { min-width: 150px; padding: 10px 12px; border: 1px solid #e2e8f0; border-radius: 10px; background: #fff; color: #172033; }
.archive-tag-manager { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin: 12px 0 18px; }
.archive-tool-label { display: block; margin: 0 0 7px; color: #526075; font-size: 12px; font-weight: 800; }
.archive-managed-tag { display: inline-flex; align-items: center; gap: 6px; padding: 5px 8px; border: 1px solid #e2e8f0; border-radius: 20px; background: #fff; color: #475569; font-size: 12px; }
.archive-managed-tag button { border: 0; padding: 0 2px; background: transparent; color: #94a3b8; font-size: 17px; cursor: pointer; }
.archive-tag-dot { display: inline-block; width: 9px; height: 9px; flex: 0 0 9px; border-radius: 50%; }
.archive-card { display: flex; flex-direction: column; align-items: stretch; gap: 14px; }
.archive-editor { padding-top: 14px; border-top: 1px solid #edf0f4; }
.archive-note { width: 100%; min-height: 76px; resize: vertical; padding: 11px 12px; border: 1px solid #e2e8f0; border-radius: 9px; color: #172033; background: #fbfcfe; font: inherit; font-size: 13px; line-height: 1.6; }
.archive-editor-actions { display: flex; justify-content: space-between; align-items: center; gap: 10px; margin: 8px 0 13px; }
.archive-char-count, .archive-hint { color: #94a3b8; font-size: 11px; }
.archive-tag-choices { display: flex; flex-wrap: wrap; gap: 8px 12px; margin: 8px 0; }
.archive-tag-choice { display: inline-flex; align-items: center; gap: 6px; color: #526075; font-size: 12px; cursor: pointer; }
.archive-tag-choice input { accent-color: #315fe8; }
.archive-current-tags { display: flex; flex-wrap: wrap; gap: 6px; }
.archive-tag-pill { display: inline-flex; align-items: center; padding: 4px 9px; border: 1px solid; border-radius: 20px; background: #fff; font-size: 11px; font-weight: 700; }
@media (max-width: 640px) {
  .archive-tools { flex-direction: column; }
  .archive-tools select { width: 100%; }
  .archive-heading { flex-direction: column; }
  .archive-create-tag { width: 100%; }
  .archive-create-tag input[type="text"], .archive-create-tag input:not([type]) { flex: 1; min-width: 0; }
}
'@
$existingCss = Get-Content -LiteralPath $cssPath -Raw -Encoding UTF8
if (-not $existingCss.Contains("/* Personal archive */")) {
    [System.IO.File]::WriteAllText($cssPath, $existingCss + $css, $encoding)
    Write-Host "[APPEND] apps\web\src\styles\index.css" -ForegroundColor Green
} else {
    throw "Personal archive styles already exist; refusing to append duplicates."
}

Write-Host "`n==============================================" -ForegroundColor Cyan
Write-Host " Personal archive files updated successfully" -ForegroundColor Green
Write-Host "==============================================" -ForegroundColor Cyan
Write-Host "Next: apply migration 0004 locally, then run typechecks and build."
