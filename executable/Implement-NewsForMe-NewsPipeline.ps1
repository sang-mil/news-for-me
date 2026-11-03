$ErrorActionPreference = 'Stop'
$ProjectRoot = 'C:\dev\news-for-me'
if (-not (Test-Path -LiteralPath $ProjectRoot -PathType Container)) {
    throw "프로젝트 폴더를 찾을 수 없습니다: $ProjectRoot"
}
Set-Location $ProjectRoot

$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$backupRoot = Join-Path $ProjectRoot ".local-backups\news-pipeline-$stamp"

function Write-ProjectFile {
    param(
        [Parameter(Mandatory = $true)][string]$RelativePath,
        [Parameter(Mandatory = $true)][string]$Content
    )

    $destination = Join-Path $ProjectRoot $RelativePath
    $parent = Split-Path -Parent $destination
    if (-not (Test-Path -LiteralPath $parent)) {
        New-Item -ItemType Directory -Path $parent -Force | Out-Null
    }

    if (Test-Path -LiteralPath $destination -PathType Leaf) {
        $backupPath = Join-Path $backupRoot $RelativePath
        $backupParent = Split-Path -Parent $backupPath
        if (-not (Test-Path -LiteralPath $backupParent)) {
            New-Item -ItemType Directory -Path $backupParent -Force | Out-Null
        }
        Copy-Item -LiteralPath $destination -Destination $backupPath -Force
        Write-Host "[BACKUP] $RelativePath" -ForegroundColor Yellow
    }

    # Windows PowerShell 5.1 compatibility: Set-Content -Encoding UTF8 writes a BOM.
    Set-Content -LiteralPath $destination -Value $Content -Encoding utf8
    Write-Host "[WRITE]  $RelativePath" -ForegroundColor Green
}

$requiredFiles = @(
    'apps\worker\wrangler.jsonc',
    'apps\worker\src\index.ts',
    'apps\worker\src\lib\dev-user.ts',
    'apps\worker\src\lib\http.ts',
    'apps\worker\src\db\repositories\topics.ts',
    'apps\worker\src\routes\topics.ts',
    'apps\web\src\App.tsx',
    'apps\web\src\main.tsx',
    'apps\web\src\lib\api.ts',
    'packages\shared\src\index.ts'
)
foreach ($relative in $requiredFiles) {
    if (-not (Test-Path -LiteralPath (Join-Path $ProjectRoot $relative) -PathType Leaf)) {
        throw "필수 파일이 없습니다. 현재 프로젝트 버전을 확인하세요: $relative"
    }
}

Write-ProjectFile 'apps/worker/wrangler.jsonc' @'
{
  "$schema": "../../node_modules/wrangler/config-schema.json",
  "name": "news-for-me-api",
  "main": "src/index.ts",
  "compatibility_date": "2026-11-02",
  "observability": {
    "enabled": true
  },
  "vars": {
    "ALLOWED_ORIGIN": "http://127.0.0.1:5173"
  },
  "d1_databases": [
    {
      "binding": "DB",
      "database_name": "news-for-me-db",
      "database_id": "00000000-0000-4000-8000-000000000001",
      "migrations_dir": "migrations"
    }
  ],
  "queues": {
    "producers": [
      {
        "binding": "NEWS_QUEUE",
        "queue": "news-for-me-collection"
      }
    ],
    "consumers": [
      {
        "queue": "news-for-me-collection",
        "max_batch_size": 5,
        "max_batch_timeout": 1,
        "max_retries": 3,
        "dead_letter_queue": "news-for-me-collection-dlq"
      },
      {
        "queue": "news-for-me-collection-dlq",
        "max_batch_size": 5,
        "max_batch_timeout": 1,
        "max_retries": 3
      }
    ]
  }
}
'@

Write-ProjectFile 'packages/shared/src/index.ts' @'
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

export interface TopicListResponse {
  data: Topic[];
}

export interface TopicResponse {
  data: Topic;
}

export interface ApiErrorResponse {
  error: string;
  details?: string[];
}

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
  data: {
    runId: string;
    status: "queued";
  };
}

export interface CollectionRunResponse {
  data: CollectionRun;
}

export interface NewsArticleListResponse {
  data: NewsArticle[];
}
'@

Write-ProjectFile 'apps/worker/src/services/news/types.ts' @'
export interface TopicForCollection {
  id: string;
  user_id: string;
  name: string;
  description: string | null;
  include_keywords_json: string;
  exclude_keywords_json: string;
}

export interface CollectedNewsItem {
  title: string;
  url: string;
  sourceName: string | null;
  publishedAt: string | null;
  excerpt: string | null;
  provider: string;
}

export interface NewsSearchInput {
  topicName: string;
  includeKeywords: string[];
  excludeKeywords: string[];
}

export interface NewsSource {
  id: string;
  search(input: NewsSearchInput): Promise<CollectedNewsItem[]>;
}

export interface CollectionJobMessage {
  runId: string;
  topicId: string;
  userId: string;
}
'@

Write-ProjectFile 'apps/worker/src/services/news/sources/google-news-rss.ts' @'
import { XMLParser } from "fast-xml-parser";
import type { CollectedNewsItem, NewsSearchInput, NewsSource } from "../types";

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  textNodeName: "#text",
  parseTagValue: false,
  trimValues: true
});

function asText(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number") return String(value);
  if (value && typeof value === "object" && "#text" in value) {
    const text = (value as { "#text"?: unknown })["#text"];
    return typeof text === "string" ? text.trim() : "";
  }
  return "";
}

function cleanExcerpt(value: string): string | null {
  const cleaned = value
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned ? cleaned.slice(0, 2000) : null;
}

function safeQueryTerm(value: string): string {
  return value.replace(/["\\]/g, " ").replace(/\s+/g, " ").trim();
}

export function buildGoogleNewsQuery(
  topicName: string,
  includeKeywords: string[],
  excludeKeywords: string[]
): string {
  const positives = [topicName, ...includeKeywords]
    .map(safeQueryTerm)
    .filter(Boolean)
    .slice(0, 8)
    .map((term) => `"${term}"`);

  const positiveQuery = positives.length > 1
    ? `(${positives.join(" OR ")})`
    : positives[0] ?? `"${safeQueryTerm(topicName)}"`;

  const negatives = excludeKeywords
    .map(safeQueryTerm)
    .filter(Boolean)
    .slice(0, 5)
    .map((term) => `-"${term}"`);

  return [positiveQuery, ...negatives, "when:7d"].join(" ");
}

export async function searchGoogleNewsRss(
  query: string,
  excludeKeywords: string[]
): Promise<CollectedNewsItem[]> {
  const url = new URL("https://news.google.com/rss/search");
  url.searchParams.set("q", query);
  url.searchParams.set("hl", "ko");
  url.searchParams.set("gl", "KR");
  url.searchParams.set("ceid", "KR:ko");

  const response = await fetch(url.toString(), {
    headers: {
      Accept: "application/rss+xml, application/xml, text/xml;q=0.9, */*;q=0.8",
      "User-Agent": "NewsForMe/0.1 RSS reader"
    }
  });

  if (!response.ok) {
    throw new Error(`Google News RSS returned HTTP ${response.status}.`);
  }

  const xml = await response.text();
  if (xml.length > 2_000_000) {
    throw new Error("News RSS response exceeded the 2 MB safety limit.");
  }

  const parsed = parser.parse(xml) as {
    rss?: { channel?: { item?: unknown | unknown[] } };
  };
  const rawItems = parsed.rss?.channel?.item;
  if (!rawItems) return [];

  const items = Array.isArray(rawItems) ? rawItems : [rawItems];
  const excluded = excludeKeywords
    .map((keyword) => keyword.toLocaleLowerCase())
    .filter(Boolean);
  const collected: CollectedNewsItem[] = [];

  for (const raw of items) {
    if (!raw || typeof raw !== "object") continue;
    const item = raw as Record<string, unknown>;
    const title = asText(item.title);
    const rawLink = asText(item.link);
    const sourceName = asText(item.source) || null;
    const pubDate = asText(item.pubDate);
    const excerpt = cleanExcerpt(asText(item.description));

    if (!title || !rawLink) continue;

    let parsedLink: URL;
    try {
      parsedLink = new URL(rawLink);
    } catch {
      continue;
    }
    if (parsedLink.protocol !== "https:") continue;

    const searchable = `${title} ${sourceName ?? ""} ${excerpt ?? ""}`.toLocaleLowerCase();
    if (excluded.some((keyword) => searchable.includes(keyword))) continue;

    const timestamp = pubDate ? Date.parse(pubDate) : Number.NaN;
    collected.push({
      title: title.slice(0, 500),
      url: parsedLink.toString(),
      sourceName: sourceName?.slice(0, 200) ?? null,
      publishedAt: Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null,
      excerpt,
      provider: "google-news-rss"
    });

    if (collected.length >= 10) break;
  }

  return collected;
}

export const googleNewsRssSource: NewsSource = {
  id: "google-news-rss",
  async search(input: NewsSearchInput): Promise<CollectedNewsItem[]> {
    const query = buildGoogleNewsQuery(
      input.topicName,
      input.includeKeywords,
      input.excludeKeywords
    );
    return searchGoogleNewsRss(query, input.excludeKeywords);
  }
};
'@

Write-ProjectFile 'apps/worker/src/db/repositories/news.ts' @'
import type { CollectionRun, NewsArticle } from "@news-for-me/shared";
import type { CollectionJobMessage, TopicForCollection } from "../../services/news/types";

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
  userId: string,
  topicId: string
): Promise<TopicForCollection | null> {
  return db.prepare(`
    SELECT id, user_id, name, description,
      include_keywords_json, exclude_keywords_json
    FROM topics
    WHERE id = ? AND user_id = ? AND is_active = 1
    LIMIT 1
  `).bind(topicId, userId).first<TopicForCollection>();
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
  userId: string,
  topicId: string,
  runId: string
): Promise<CollectionRun | null> {
  const row = await db.prepare(`
    SELECT cr.id, cr.topic_id, cr.status, cr.articles_found,
      cr.error_message, cr.started_at, cr.finished_at, cr.created_at
    FROM collection_runs cr
    INNER JOIN topics t ON t.id = cr.topic_id
    WHERE cr.id = ? AND cr.topic_id = ? AND t.user_id = ?
    LIMIT 1
  `).bind(runId, topicId, userId).first<CollectionRunRow>();
  return row ? toCollectionRun(row) : null;
}

export async function listTopicArticles(
  db: D1Database,
  userId: string,
  topicId: string,
  limit = 20
): Promise<NewsArticle[]> {
  const result = await db.prepare(`
    SELECT a.id, a.title, a.canonical_url, a.source_name,
      a.published_at, a.fetched_at, a.content_excerpt
    FROM articles a
    INNER JOIN topic_articles ta ON ta.article_id = a.id
    INNER JOIN topics t ON t.id = ta.topic_id
    WHERE ta.topic_id = ? AND t.user_id = ?
    ORDER BY COALESCE(a.published_at, a.fetched_at) DESC
    LIMIT ?
  `).bind(topicId, userId, limit).all<ArticleRow>();

  return result.results.map((row) => ({
    id: row.id,
    title: row.title,
    canonicalUrl: row.canonical_url,
    sourceName: row.source_name,
    publishedAt: row.published_at,
    fetchedAt: row.fetched_at,
    contentExcerpt: row.content_excerpt
  }));
}

export async function storeCollectedArticles(
  db: D1Database,
  job: CollectionJobMessage,
  items: Array<{
    title: string;
    url: string;
    sourceName: string | null;
    publishedAt: string | null;
    excerpt: string | null;
  }>
): Promise<void> {
  const statements: D1PreparedStatement[] = [];

  for (const item of items) {
    const canonicalUrl = new URL(item.url);
    canonicalUrl.hash = "";
    for (const key of [...canonicalUrl.searchParams.keys()]) {
      if (
        key.toLowerCase().startsWith("utm_") ||
        ["gclid", "fbclid", "mc_cid", "mc_eid"].includes(key.toLowerCase())
      ) {
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

    statements.push(db.prepare(`
      INSERT OR IGNORE INTO articles (
        id, canonical_url, url_hash, title, source_name,
        published_at, content_excerpt, language, metadata_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'ko', ?)
    `).bind(
      articleId,
      normalizedUrl,
      urlHash,
      item.title,
      item.sourceName,
      item.publishedAt,
      item.excerpt,
      JSON.stringify({ provider: item.provider })
    ));

    statements.push(db.prepare(`
      INSERT OR IGNORE INTO topic_articles (topic_id, article_id, match_reason)
      VALUES (?, ?, 'Google News RSS keyword search')
    `).bind(job.topicId, articleId));
  }

  statements.push(db.prepare(`
    UPDATE collection_runs
    SET status = 'completed', articles_found = ?, error_message = NULL,
      finished_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE id = ? AND topic_id = ?
  `).bind(items.length, job.runId, job.topicId));

  statements.push(db.prepare(`
    UPDATE topics
    SET last_collected_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
      updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE id = ? AND user_id = ?
  `).bind(job.topicId, job.userId));

  await db.batch(statements);
}

export async function markCollectionStarted(
  db: D1Database,
  runId: string
): Promise<void> {
  await db.prepare(`
    UPDATE collection_runs
    SET status = 'running', started_at = COALESCE(started_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
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
      error_message = COALESCE(error_message, 'Queue retry limit reached.'),
      finished_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE id = ?
  `).bind(runId).run();
}
'@

Write-ProjectFile 'apps/worker/src/routes/collection.ts' @'
import type { CollectionJobMessage } from "../services/news/types";
import {
  createCollectionRun,
  getCollectionRun,
  getTopicForCollection,
  listTopicArticles
} from "../db/repositories/news";
import { jsonResponse } from "../lib/http";

interface CollectionEnv {
  NEWS_QUEUE: Queue<CollectionJobMessage>;
}

export async function handleCollectionRequest(
  request: Request,
  db: D1Database,
  queue: CollectionEnv["NEWS_QUEUE"],
  userId: string,
  allowedOrigin: string
): Promise<Response> {
  const url = new URL(request.url);
  const collectMatch = url.pathname.match(/^\/api\/topics\/([^/]+)\/collect$/);
  const articlesMatch = url.pathname.match(/^\/api\/topics\/([^/]+)\/articles$/);
  const runMatch = url.pathname.match(/^\/api\/topics\/([^/]+)\/collection-runs\/([^/]+)$/);
  const topicIdRaw = collectMatch?.[1] ?? articlesMatch?.[1] ?? runMatch?.[1];

  if (!topicIdRaw) return jsonResponse({ error: "Not Found" }, 404, allowedOrigin);

  let topicId: string;
  try {
    topicId = decodeURIComponent(topicIdRaw);
  } catch {
    return jsonResponse({ error: "Invalid topic ID." }, 400, allowedOrigin);
  }

  const topic = await getTopicForCollection(db, userId, topicId);
  if (!topic) {
    return jsonResponse({ error: "Topic not found or inactive." }, 404, allowedOrigin);
  }

  if (collectMatch && request.method === "POST") {
    const runId = await createCollectionRun(db, topicId);
    const message: CollectionJobMessage = { runId, topicId, userId };
    try {
      await queue.send(message);
    } catch (error) {
      const detail = error instanceof Error ? error.message : "Queue unavailable";
      await db.prepare(`
        UPDATE collection_runs
        SET status = 'failed', error_message = ?,
          finished_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        WHERE id = ?
      `).bind(detail.slice(0, 1000), runId).run();
      return jsonResponse({ error: "Could not enqueue the collection job." }, 503, allowedOrigin);
    }
    return jsonResponse({ data: { runId, status: "queued" } }, 202, allowedOrigin);
  }

  if (articlesMatch && request.method === "GET") {
    const requestedLimit = Number(url.searchParams.get("limit") ?? "20");
    const limit = Number.isFinite(requestedLimit)
      ? Math.min(50, Math.max(1, Math.floor(requestedLimit)))
      : 20;
    const articles = await listTopicArticles(db, userId, topicId, limit);
    return jsonResponse({ data: articles }, 200, allowedOrigin);
  }

  if (runMatch && request.method === "GET") {
    let runId: string;
    try {
      runId = decodeURIComponent(runMatch[2]);
    } catch {
      return jsonResponse({ error: "Invalid collection run ID." }, 400, allowedOrigin);
    }
    const run = await getCollectionRun(db, userId, topicId, runId);
    return run
      ? jsonResponse({ data: run }, 200, allowedOrigin)
      : jsonResponse({ error: "Collection run not found." }, 404, allowedOrigin);
  }

  return jsonResponse({ error: "Method not allowed." }, 405, allowedOrigin);
}
'@

Write-ProjectFile 'apps/worker/src/queues/consumers/news-collection.ts' @'
import {
  getTopicForCollection,
  markCollectionDeadLettered,
  markCollectionRetrying,
  markCollectionStarted,
  storeCollectedArticles
} from "../../db/repositories/news";
import { googleNewsRssSource } from "../../services/news/sources/google-news-rss";
import type { CollectionJobMessage } from "../../services/news/types";

interface CollectionConsumerEnv {
  DB: D1Database;
}

function parseKeywords(value: string): string[] {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === "string")
      : [];
  } catch {
    return [];
  }
}

async function processCollectionJob(
  job: CollectionJobMessage,
  env: CollectionConsumerEnv
): Promise<void> {
  await markCollectionStarted(env.DB, job.runId);

  const topic = await getTopicForCollection(env.DB, job.userId, job.topicId);
  if (!topic) throw new Error("Topic no longer exists or is inactive.");

  const includeKeywords = parseKeywords(topic.include_keywords_json);
  const excludeKeywords = parseKeywords(topic.exclude_keywords_json);
  const items = await googleNewsRssSource.search({
    topicName: topic.name,
    includeKeywords,
    excludeKeywords
  });

  await storeCollectedArticles(env.DB, job, items);
}

export async function handleNewsCollectionQueue(
  batch: MessageBatch<CollectionJobMessage>,
  env: CollectionConsumerEnv
): Promise<void> {
  const isDeadLetterQueue = batch.queue === "news-for-me-collection-dlq";

  for (const message of batch.messages) {
    if (isDeadLetterQueue) {
      try {
        await markCollectionDeadLettered(env.DB, message.body.runId);
        console.error("News collection moved to dead-letter queue", message.body.runId);
        message.ack();
      } catch (error) {
        console.error("Could not finalize dead-lettered collection", error);
        message.retry({ delaySeconds: 30 });
      }
      continue;
    }

    try {
      await processCollectionJob(message.body, env);
      message.ack();
      console.log("News collection completed", message.body.runId);
    } catch (error) {
      const detail = error instanceof Error ? error.message : "Unknown collection error";
      try {
        await markCollectionRetrying(env.DB, message.body.runId, detail);
      } catch (dbError) {
        console.error("Could not record collection retry state", dbError);
      }
      console.error("News collection failed; queue will retry", message.body.runId, detail);
      message.retry({ delaySeconds: 5 });
    }
  }
}
'@

Write-ProjectFile 'apps/worker/src/index.ts' @'
import type { ApiHealthResponse } from "@news-for-me/shared";
import { handleTopicsRequest } from "./routes/topics";
import { handleCollectionRequest } from "./routes/collection";
import { ensureDevelopmentUser } from "./lib/dev-user";
import { jsonResponse } from "./lib/http";
import { handleNewsCollectionQueue } from "./queues/consumers/news-collection";
import type { CollectionJobMessage } from "./services/news/types";

interface Env {
  DB: D1Database;
  NEWS_QUEUE: Queue<CollectionJobMessage>;
  ALLOWED_ORIGIN?: string;
  DEV_USER_ID?: string;
  DEV_USER_EMAIL?: string;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const allowedOrigin = env.ALLOWED_ORIGIN ?? "http://127.0.0.1:5173";
    const origin = request.headers.get("Origin");

    if (origin && origin !== allowedOrigin) {
      return new Response("Origin not allowed", { status: 403 });
    }

    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": allowedOrigin,
          "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, Authorization",
          "Access-Control-Max-Age": "86400",
          "Vary": "Origin"
        }
      });
    }

    const url = new URL(request.url);

    if (url.pathname === "/api/health" && request.method === "GET") {
      try {
        const result = await env.DB.prepare("SELECT 1 AS ok").first<{ ok: number }>();
        if (result?.ok !== 1) throw new Error("D1 health check failed");
        const response: ApiHealthResponse = {
          ok: true,
          service: "news-for-me-api",
          timestamp: new Date().toISOString(),
          database: "connected"
        };
        return jsonResponse(response, 200, allowedOrigin);
      } catch {
        return jsonResponse(
          { ok: false, service: "news-for-me-api", database: "unavailable", error: "Database connection failed" },
          503,
          allowedOrigin
        );
      }
    }

    if (url.pathname.startsWith("/api/topics/")) {
      let userId: string | null;
      try {
        userId = await ensureDevelopmentUser(env.DB, env);
      } catch {
        return jsonResponse({ error: "Could not initialize the local development user." }, 503, allowedOrigin);
      }

      if (!userId) {
        return jsonResponse(
          { error: "Authentication is not configured. Set DEV_USER_ID and DEV_USER_EMAIL in apps/worker/.dev.vars for local development. Production authentication must be implemented before public deployment." },
          503,
          allowedOrigin
        );
      }

      try {
        if (/^\/api\/topics\/[^/]+\/(collect|articles|collection-runs\/[^/]+)$/.test(url.pathname)) {
          return await handleCollectionRequest(request, env.DB, env.NEWS_QUEUE, userId, allowedOrigin);
        }
        return await handleTopicsRequest(request, env.DB, userId, allowedOrigin);
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown database error";
        console.error("Topics API error:", message);
        return jsonResponse({ error: "An internal error occurred while processing the request." }, 500, allowedOrigin);
      }
    }

    return jsonResponse({ error: "Not Found" }, 404, allowedOrigin);
  },

  async queue(batch: MessageBatch<CollectionJobMessage>, env: Env): Promise<void> {
    await handleNewsCollectionQueue(batch, env);
  }
};
'@

Write-ProjectFile 'apps/web/src/lib/api.ts' @'
import type {
  ApiHealthResponse,
  CollectionRun,
  CollectionStartResponse,
  NewsArticle,
  Topic,
  TopicInput,
  TopicListResponse,
  TopicResponse
} from "@news-for-me/shared";

const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL ?? "").replace(/\/$/, "");

interface ErrorPayload {
  error?: string;
  details?: string[];
}

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
    method: "PATCH",
    body: JSON.stringify(input)
  });
  return response.data;
}

export async function deleteTopic(id: string): Promise<void> {
  await request<{ ok: boolean }>(`/api/topics/${encodeURIComponent(id)}`, { method: "DELETE" });
}

export async function collectTopic(id: string): Promise<string> {
  const response = await request<CollectionStartResponse>(`/api/topics/${encodeURIComponent(id)}/collect`, {
    method: "POST"
  });
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
'@

Write-ProjectFile 'apps/web/src/App.tsx' @'
import { useCallback, useEffect, useState, type FormEvent } from "react";
import type { ApiHealthResponse, CollectionRun, NewsArticle, Topic, TopicInput } from "@news-for-me/shared";
import {
  collectTopic,
  createTopic,
  deleteTopic,
  getApiHealth,
  getCollectionRun,
  listTopicArticles,
  listTopics,
  updateTopic
} from "./lib/api";

type ApiStatus = "checking" | "online" | "offline";

interface TopicFormState {
  name: string;
  description: string;
  includeKeywords: string;
  excludeKeywords: string;
}

const EMPTY_FORM: TopicFormState = {
  name: "",
  description: "",
  includeKeywords: "",
  excludeKeywords: ""
};

function splitKeywords(value: string): string[] {
  return [...new Set(value.split(/[,\n]/).map((item) => item.trim()).filter(Boolean))];
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
      const [apiHealth, topicList] = await Promise.all([getApiHealth(), listTopics()]);
      setHealth(apiHealth);
      setStatus("online");
      setTopics(topicList);
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
    setError("");
    setNotice("");
    try {
      await deleteTopic(topic.id);
      if (editingId === topic.id) resetForm();
      setTopics((current) => current.filter((item) => item.id !== topic.id));
      setArticlesByTopic((current) => {
        const next = { ...current };
        delete next[topic.id];
        return next;
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

  async function handleCollect(topic: Topic) {
    setCollectingTopicId(topic.id);
    setError("");
    setNotice("");
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
        if (run.status === "failed") {
          throw new Error(run.errorMessage ?? "뉴스 수집에 실패했습니다.");
        }
      }
      setNotice(`'${topic.name}' 수집 작업이 아직 진행 중이에요. 잠시 후 다시 확인해 주세요.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "뉴스 수집 요청에 실패했습니다.");
    } finally {
      setCollectingTopicId(null);
    }
  }

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
        <p className="intro-copy">관심 주제를 등록하고 뉴스 수집을 실행하세요. 최신 기사와 출처를 모아 개인 뉴스 브리핑의 기반을 만듭니다.</p>
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

      <section className="workspace-grid">
        <section className="topics-section">
          <div className="section-heading">
            <div><div className="section-kicker">YOUR TOPICS</div><h2>관심 항목</h2></div>
            <span className="count-badge">{topics.length}개</span>
          </div>

          {isLoading ? (
            <div className="empty-state"><div className="loading-spinner" /><p>관심 항목을 불러오는 중입니다.</p></div>
          ) : topics.length === 0 ? (
            <div className="empty-state">
              <div className="empty-symbol">✳</div>
              <h3>아직 등록된 관심 항목이 없어요.</h3>
              <p>오른쪽에서 첫 번째 관심 주제를 추가해 보세요.</p>
            </div>
          ) : (
            <div className="topic-list">
              {topics.map((topic) => {
                const run = collectionRuns[topic.id];
                const articles = articlesByTopic[topic.id];
                return (
                  <article className="topic-card" key={topic.id}>
                    <div className="topic-card-main">
                      <div className="topic-card-title-row">
                        <h3>{topic.name}</h3><span className="topic-date">{formatDate(topic.createdAt)}</span>
                      </div>
                      {topic.description && <p className="topic-description">{topic.description}</p>}
                      <div className="keyword-groups">
                        {topic.includeKeywords.length > 0 && (
                          <div className="keyword-row"><span className="keyword-label">포함</span>{topic.includeKeywords.map((keyword) => <span className="keyword-chip" key={`in-${keyword}`}>{keyword}</span>)}</div>
                        )}
                        {topic.excludeKeywords.length > 0 && (
                          <div className="keyword-row"><span className="keyword-label excluded">제외</span>{topic.excludeKeywords.map((keyword) => <span className="keyword-chip keyword-chip-muted" key={`out-${keyword}`}>{keyword}</span>)}</div>
                        )}
                        {topic.includeKeywords.length === 0 && topic.excludeKeywords.length === 0 && <span className="keyword-hint">키워드 조건 없음</span>}
                      </div>
                      {run && <div className="collection-status">최근 수집 작업: {run.status} · {run.articlesFound}건</div>}
                      {expandedTopicId === topic.id && (
                        <div className="article-list">
                          <div className="article-list-heading">최근 수집 기사</div>
                          {!articles || articles.length === 0 ? (
                            <p className="article-empty">저장된 기사가 없습니다. 뉴스 수집을 실행해 보세요.</p>
                          ) : articles.map((article) => (
                            <div className="article-item" key={article.id}>
                              <a href={article.canonicalUrl} target="_blank" rel="noreferrer">{article.title}</a>
                              <div className="article-meta">{article.sourceName ?? "출처 미상"} · {formatDate(article.publishedAt)}</div>
                              {article.contentExcerpt && <p>{article.contentExcerpt}</p>}
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                    <div className="topic-actions topic-actions-column">
                      <button type="button" className="icon-button collect-button" onClick={() => void handleCollect(topic)} disabled={collectingTopicId !== null || status !== "online"}>
                        {collectingTopicId === topic.id ? "수집 중…" : "뉴스 수집"}
                      </button>
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

            <button className="submit-button" type="submit" disabled={isSaving || status !== "online"}>
              {isSaving ? "저장 중…" : editingId ? "변경사항 저장" : "관심 항목 등록"}<span aria-hidden="true">→</span>
            </button>
          </form>
          <div className="privacy-note"><span>⌑</span> 현재는 로컬 개발용 사용자 데이터로 저장됩니다.</div>
        </aside>
      </section>

      <footer className="footer"><span>News for Me</span><span>YOUR PERSONAL AI NEWS BRIEFING</span></footer>
    </main>
  );
}
'@

Write-ProjectFile 'apps/web/src/styles/news.css' @'
.collection-status {
  margin-top: 11px;
  color: #68758b;
  font-size: 10px;
}
.topic-actions-column {
  flex-direction: column;
  align-items: stretch;
  min-width: 76px;
}
.topic-actions-column .icon-button {
  padding: 7px 8px;
  border: 1px solid #e8ebf2;
  border-radius: 7px;
  white-space: nowrap;
}
.topic-actions-column .collect-button {
  color: #fff;
  background: #365ee9;
  border-color: #365ee9;
}
.topic-actions-column .collect-button:disabled {
  opacity: .55;
  cursor: wait;
}
.article-list {
  display: grid;
  gap: 12px;
  margin-top: 16px;
  padding-top: 13px;
  border-top: 1px solid #edf0f4;
}
.article-list-heading {
  color: #3b4962;
  font-size: 11px;
  font-weight: 800;
}
.article-empty {
  margin: 0;
  color: #929baa;
  font-size: 11px;
}
.article-item {
  display: grid;
  gap: 5px;
}
.article-item a {
  color: #273b67;
  font-size: 12px;
  line-height: 1.6;
  font-weight: 700;
  text-decoration: none;
}
.article-item a:hover {
  color: #365ee9;
  text-decoration: underline;
}
.article-meta {
  color: #939cab;
  font-size: 10px;
}
.article-item p {
  margin: 0;
  color: #778295;
  font-size: 11px;
  line-height: 1.6;
}
@media (max-width: 560px) {
  .topic-actions-column { flex-direction: column; }
}
'@

# Add the news-specific stylesheet import without replacing the existing base stylesheet.
$appEntry = Join-Path $ProjectRoot 'apps\web\src\main.tsx'
$appEntryText = Get-Content -LiteralPath $appEntry -Raw
if ($appEntryText -notmatch 'styles/news\.css') {
    $appEntryText = 'import "./styles/news.css";' + [Environment]::NewLine + $appEntryText
    Write-ProjectFile 'apps/web/src/main.tsx' $appEntryText
}

Write-Host ''
Write-Host 'News collection pipeline files created.' -ForegroundColor Green
Write-Host 'Next: npm install fast-xml-parser --workspace @news-for-me/worker' -ForegroundColor Cyan
Write-Host 'Then: run the local D1 migration only if one is added in a future version.' -ForegroundColor Cyan
Write-Host "Backups: $backupRoot" -ForegroundColor Yellow
