param(
    [string]$ProjectRoot = (Get-Location).Path
)

$ErrorActionPreference = "Stop"
$Utf8Bom = New-Object System.Text.UTF8Encoding -ArgumentList $true

$ProjectRoot = (Resolve-Path -LiteralPath $ProjectRoot).Path
$WorkerRoot = Join-Path $ProjectRoot "apps\worker"
$WebRoot = Join-Path $ProjectRoot "apps\web"
$BackupRoot = Join-Path $ProjectRoot ".local-backups\scraps-$(Get-Date -Format 'yyyyMMdd-HHmmss')"
New-Item -ItemType Directory -Path $BackupRoot -Force | Out-Null

function Get-ProjectPath {
    param([string]$RelativePath)
    return Join-Path $ProjectRoot $RelativePath
}

function Backup-ProjectFile {
    param([string]$RelativePath)
    $source = Get-ProjectPath $RelativePath
    if (-not (Test-Path -LiteralPath $source -PathType Leaf)) {
        throw "Required file not found: $RelativePath"
    }
    $destination = Join-Path $BackupRoot $RelativePath
    $destinationDirectory = Split-Path -Parent $destination
    New-Item -ItemType Directory -Path $destinationDirectory -Force | Out-Null
    Copy-Item -LiteralPath $source -Destination $destination -Force
}

function Write-NewProjectFile {
    param(
        [string]$RelativePath,
        [string]$Content
    )
    $destination = Get-ProjectPath $RelativePath
    if (Test-Path -LiteralPath $destination) {
        throw "Refusing to overwrite existing file: $RelativePath"
    }
    $directory = Split-Path -Parent $destination
    New-Item -ItemType Directory -Path $directory -Force | Out-Null
    [System.IO.File]::WriteAllText($destination, $Content, $Utf8Bom)
    Write-Host "[CREATE] $RelativePath" -ForegroundColor Green
}

function Replace-ExactlyOnce {
    param(
        [string]$Content,
        [string]$OldText,
        [string]$NewText,
        [string]$Description
    )
    $count = [regex]::Matches($Content, [regex]::Escape($OldText)).Count
    if ($count -ne 1) {
        throw "Expected exactly one match for '$Description'; found $count. No further changes will be made."
    }
    return $Content.Replace($OldText, $NewText)
}

function Update-ProjectFile {
    param(
        [string]$RelativePath,
        [string]$Content
    )
    $destination = Get-ProjectPath $RelativePath
    [System.IO.File]::WriteAllText($destination, $Content, $Utf8Bom)
    Write-Host "[UPDATE] $RelativePath" -ForegroundColor Cyan
}

$requiredFiles = @(
    "apps\web\src\App.tsx",
    "apps\web\src\lib\api.ts",
    "apps\web\src\styles\index.css",
    "packages\shared\src\index.ts",
    "apps\worker\src\index.ts",
    "apps\worker\wrangler.jsonc"
)
foreach ($file in $requiredFiles) {
    if (-not (Test-Path -LiteralPath (Get-ProjectPath $file) -PathType Leaf)) {
        throw "Required project file not found: $file"
    }
}

$newFiles = @(
    "apps\worker\migrations\0003_article_saves.sql",
    "apps\worker\src\db\repositories\scraps.ts",
    "apps\worker\src\routes\scraps.ts",
    "apps\worker\src\services\maintenance\article-cleanup.ts"
)
foreach ($file in $newFiles) {
    if (Test-Path -LiteralPath (Get-ProjectPath $file)) {
        throw "New target file already exists; refusing to overwrite: $file"
    }
}

# Back up every existing file that this script updates.
foreach ($file in $requiredFiles) {
    Backup-ProjectFile $file
}

# 1. Shared response type.
$sharedPath = Get-ProjectPath "packages\shared\src\index.ts"
$shared = [System.IO.File]::ReadAllText($sharedPath, [System.Text.Encoding]::UTF8)
$shared = $shared -replace "`r`n", "`n"
if ($shared -notmatch 'export interface SavedNewsArticle') {
    $shared += @'

export interface SavedNewsArticle extends NewsArticle {
  savedAt: string;
}
'@
    Update-ProjectFile "packages\shared\src\index.ts" $shared
}
else {
    Write-Host "[SKIP] SavedNewsArticle already exists" -ForegroundColor Yellow
}

# 2. D1 migration: user-specific article saves.
$migration = @'
-- User-specific saved news. Saved articles are retained by weekly cleanup.
CREATE TABLE article_saves (
    user_id TEXT NOT NULL,
    article_id TEXT NOT NULL,
    saved_at TEXT NOT NULL DEFAULT
        (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    PRIMARY KEY (user_id, article_id),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (article_id) REFERENCES articles(id) ON DELETE CASCADE
);

CREATE INDEX idx_article_saves_user_saved
    ON article_saves(user_id, saved_at DESC);

CREATE INDEX idx_article_saves_article
    ON article_saves(article_id);
'@
Write-NewProjectFile "apps\worker\migrations\0003_article_saves.sql" $migration

# 3. Repository for saved news.
$scrapRepository = @'
import type { SavedNewsArticle } from "@news-for-me/shared";

interface SavedArticleRow {
  id: string;
  title: string;
  canonical_url: string;
  source_name: string | null;
  published_at: string | null;
  fetched_at: string;
  content_excerpt: string | null;
  saved_at: string;
}

function toSavedNewsArticle(row: SavedArticleRow): SavedNewsArticle {
  return {
    id: row.id,
    title: row.title,
    canonicalUrl: row.canonical_url,
    sourceName: row.source_name,
    publishedAt: row.published_at,
    fetchedAt: row.fetched_at,
    contentExcerpt: row.content_excerpt,
    savedAt: row.saved_at
  };
}

export async function listSavedArticles(
  db: D1Database,
  userId: string,
  limit = 100
): Promise<SavedNewsArticle[]> {
  const result = await db.prepare(`
    SELECT a.id, a.title, a.canonical_url, a.source_name,
      a.published_at, a.fetched_at, a.content_excerpt, s.saved_at
    FROM article_saves s
    INNER JOIN articles a ON a.id = s.article_id
    WHERE s.user_id = ?
    ORDER BY s.saved_at DESC
    LIMIT ?
  `).bind(userId, limit).all<SavedArticleRow>();

  return result.results.map(toSavedNewsArticle);
}

export async function saveArticleForUser(
  db: D1Database,
  userId: string,
  topicId: string,
  articleId: string
): Promise<SavedNewsArticle | null> {
  // Only allow saving an article that is visible through one of this user's topics.
  await db.prepare(`
    INSERT OR IGNORE INTO article_saves (user_id, article_id)
    SELECT ?, a.id
    FROM articles a
    INNER JOIN topic_articles ta ON ta.article_id = a.id
    INNER JOIN topics t ON t.id = ta.topic_id
    WHERE a.id = ? AND ta.topic_id = ? AND t.user_id = ?
  `).bind(userId, articleId, topicId, userId).run();

  const row = await db.prepare(`
    SELECT a.id, a.title, a.canonical_url, a.source_name,
      a.published_at, a.fetched_at, a.content_excerpt, s.saved_at
    FROM article_saves s
    INNER JOIN articles a ON a.id = s.article_id
    WHERE s.user_id = ? AND s.article_id = ?
    LIMIT 1
  `).bind(userId, articleId).first<SavedArticleRow>();

  return row ? toSavedNewsArticle(row) : null;
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
'@
Write-NewProjectFile "apps\worker\src\db\repositories\scraps.ts" $scrapRepository

# 4. HTTP routes for saved news.
$scrapRoute = @'
import type { SavedNewsArticle } from "@news-for-me/shared";
import { jsonResponse } from "../lib/http";
import {
  listSavedArticles,
  removeSavedArticle,
  saveArticleForUser
} from "../db/repositories/scraps";

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

  const saveMatch = url.pathname.match(
    /^\/api\/topics\/([^/]+)\/articles\/([^/]+)\/scrap$/
  );

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
      return jsonResponse(
        { error: "Article not found in one of your topics." },
        404,
        allowedOrigin
      );
    }

    return jsonResponse({ data: saved }, 201, allowedOrigin);
  }

  const removeMatch = url.pathname.match(/^\/api\/scraps\/([^/]+)$/);
  if (removeMatch && request.method === "DELETE") {
    let articleId: string;
    try {
      articleId = decodeURIComponent(removeMatch[1]);
    } catch {
      return jsonResponse({ error: "Invalid article ID." }, 400, allowedOrigin);
    }

    await removeSavedArticle(db, userId, articleId);
    return jsonResponse({ ok: true }, 200, allowedOrigin);
  }

  return jsonResponse({ error: "Not Found" }, 404, allowedOrigin);
}
'@
Write-NewProjectFile "apps\worker\src\routes\scraps.ts" $scrapRoute

# 5. Weekly cleanup service. Cleanup is per-topic-owner, not global per article.
$cleanupService = @'
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
'@
Write-NewProjectFile "apps\worker\src\services\maintenance\article-cleanup.ts" $cleanupService

# 6. Update API entrypoint with saved-news routes and scheduled cleanup.
$indexPath = Get-ProjectPath "apps\worker\src\index.ts"
$index = [System.IO.File]::ReadAllText($indexPath, [System.Text.Encoding]::UTF8)
$index = $index -replace "`r`n", "`n"
$oldIndexImports = @'
import { handleCollectionRequest } from "./routes/collection";
'@
$newIndexImports = @'
import { handleCollectionRequest } from "./routes/collection";
import { handleScrapsRequest } from "./routes/scraps";
import { cleanupUnScrapedNews } from "./services/maintenance/article-cleanup";
'@
$index = Replace-ExactlyOnce $index $oldIndexImports $newIndexImports 'scraps route imports'

$oldRouteAnchor = @'
    if (url.pathname === "/api/topics" || url.pathname.startsWith("/api/topics/")) {
'@
$newRouteAnchor = @'
    const isScrapsApi =
      url.pathname === "/api/scraps" ||
      url.pathname.startsWith("/api/scraps/") ||
      /^\/api\/topics\/[^/]+\/articles\/[^/]+\/scrap$/.test(url.pathname);

    if (isScrapsApi) {
      let userId: string | null;
      try {
        userId = await ensureDevelopmentUser(env.DB, env);
      } catch {
        return jsonResponse({ error: "Could not initialize the local development user." }, 503, allowedOrigin);
      }

      if (!userId) {
        return jsonResponse(
          { error: "Authentication is not configured. Set DEV_USER_ID and DEV_USER_EMAIL in apps/worker/.dev.vars for local development." },
          503,
          allowedOrigin
        );
      }

      try {
        return await handleScrapsRequest(request, env.DB, userId, allowedOrigin);
      } catch (error) {
        console.error("Scraps API error:", error);
        return jsonResponse({ error: "An internal error occurred while processing saved news." }, 500, allowedOrigin);
      }
    }

    if (url.pathname === "/api/topics" || url.pathname.startsWith("/api/topics/")) {
'@
$index = Replace-ExactlyOnce $index $oldRouteAnchor $newRouteAnchor 'scraps API dispatch'

$oldTail = @'
  async queue(batch: MessageBatch<CollectionJobMessage>, env: Env): Promise<void> {
    await handleNewsCollectionQueue(batch, env);
  }
};
'@
$newTail = @'
  async queue(batch: MessageBatch<CollectionJobMessage>, env: Env): Promise<void> {
    await handleNewsCollectionQueue(batch, env);
  },

  async scheduled(controller: ScheduledController, env: Env): Promise<void> {
    if (controller.cron !== "0 15 * * 0") {
      console.log("Ignoring unrecognized scheduled event", controller.cron);
      return;
    }

    console.log("Starting weekly unsaved-news cleanup", new Date(controller.scheduledTime).toISOString());
    const result = await cleanupUnScrapedNews(env.DB);
    console.log("Weekly unsaved-news cleanup completed", result);
  }
};
'@
$index = Replace-ExactlyOnce $index $oldTail $newTail 'scheduled handler'
Update-ProjectFile "apps\worker\src\index.ts" $index

# 7. Add weekly Monday 00:00 KST trigger (Sunday 15:00 UTC).
$wranglerPath = Get-ProjectPath "apps\worker\wrangler.jsonc"
$wranglerText = [System.IO.File]::ReadAllText($wranglerPath, [System.Text.Encoding]::UTF8)
$config = $wranglerText | ConvertFrom-Json
if (-not $config.PSObject.Properties['triggers']) {
    $config | Add-Member -MemberType NoteProperty -Name triggers -Value ([pscustomobject]@{ crons = @("0 15 * * 0") })
}
else {
    if (-not $config.triggers.PSObject.Properties['crons']) {
        $config.triggers | Add-Member -MemberType NoteProperty -Name crons -Value @("0 15 * * 0")
    }
    else {
        $config.triggers.crons = @("0 15 * * 0")
    }
}
$wranglerUpdated = $config | ConvertTo-Json -Depth 100
Update-ProjectFile "apps\worker\wrangler.jsonc" $wranglerUpdated

# 8. Update frontend API imports and add scrap API calls.
$apiPath = Get-ProjectPath "apps\web\src\lib\api.ts"
$api = [System.IO.File]::ReadAllText($apiPath, [System.Text.Encoding]::UTF8)
$api = $api -replace "`r`n", "`n"
$api = Replace-ExactlyOnce $api '  NewsArticle,' "  NewsArticle,`r`n  SavedNewsArticle," 'SavedNewsArticle import'
$api += @'

export async function listScraps(limit = 100): Promise<SavedNewsArticle[]> {
  const response = await request<{ data: SavedNewsArticle[] }>(
    `/api/scraps?limit=${limit}`
  );
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
  await request<{ ok: boolean }>(
    `/api/scraps/${encodeURIComponent(articleId)}`,
    { method: "DELETE" }
  );
}
'@
Update-ProjectFile "apps\web\src\lib\api.ts" $api

# 9. Update React UI while preserving existing topic and collection flows.
$appPath = Get-ProjectPath "apps\web\src\App.tsx"
$app = [System.IO.File]::ReadAllText($appPath, [System.Text.Encoding]::UTF8)
$app = $app -replace "`r`n", "`n"
$app = Replace-ExactlyOnce $app 'import type { ApiHealthResponse, CollectionRun, NewsArticle, Topic, TopicInput } from "@news-for-me/shared";' 'import type { ApiHealthResponse, CollectionRun, NewsArticle, SavedNewsArticle, Topic, TopicInput } from "@news-for-me/shared";' 'SavedNewsArticle type import'
$oldAppApiImports = @'
  listTopicArticles,
  listTopics,
  updateTopic
} from "./lib/api";
'@
$newAppApiImports = @'
  listTopicArticles,
  listScraps,
  listTopics,
  updateTopic,
  saveArticle,
  unsaveArticle
} from "./lib/api";
'@
$app = Replace-ExactlyOnce $app $oldAppApiImports $newAppApiImports 'scraps API imports'

$oldScrapState = @'
  const [articlesByTopic, setArticlesByTopic] = useState<Record<string, NewsArticle[]>>({});
'@
$newScrapState = @'
  const [articlesByTopic, setArticlesByTopic] = useState<Record<string, NewsArticle[]>>({});
  const [scraps, setScraps] = useState<SavedNewsArticle[]>([]);
'@
$app = Replace-ExactlyOnce $app $oldScrapState $newScrapState 'scraps state'
$app = Replace-ExactlyOnce $app '      const [apiHealth, topicList] = await Promise.all([getApiHealth(), listTopics()]);' '      const [apiHealth, topicList, savedArticles] = await Promise.all([getApiHealth(), listTopics(), listScraps()]);' 'load scraps with initial refresh'
$app = Replace-ExactlyOnce $app '      setTopics(topicList);' "      setTopics(topicList);`r`n      setScraps(savedArticles);" 'set initial scraps state'

$insertBeforeCollect = @'
  async function handleCollect(topic: Topic) {
'@
$scrapHandlers = @'
  async function handleToggleScrap(topicId: string, article: NewsArticle) {
    setError("");
    setNotice("");
    const alreadySaved = scraps.some((item) => item.id === article.id);
    try {
      if (alreadySaved) {
        await unsaveArticle(article.id);
        setNotice("스크랩을 해제했어요. 다음 주간 정리 대상이 됩니다.");
      } else {
        await saveArticle(topicId, article.id);
        setNotice("뉴스를 스크랩 보관함에 저장했어요.");
      }
      setScraps(await listScraps());
    } catch (err) {
      setError(err instanceof Error ? err.message : "스크랩 처리에 실패했습니다.");
    }
  }

  async function handleRemoveScrap(articleId: string) {
    setError("");
    setNotice("");
    try {
      await unsaveArticle(articleId);
      setScraps((current) => current.filter((item) => item.id !== articleId));
      setNotice("스크랩을 해제했어요. 다음 주간 정리 대상이 됩니다.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "스크랩 해제에 실패했습니다.");
    }
  }

  async function handleCollect(topic: Topic) {
'@
$app = Replace-ExactlyOnce $app $insertBeforeCollect $scrapHandlers 'scrap UI handlers'

$oldArticleRendering = @'
                          ) : articles.map((article) => (
                            <div className="article-item" key={article.id}>
                              <a href={article.canonicalUrl} target="_blank" rel="noreferrer">{article.title}</a>
                              <div className="article-meta">{article.sourceName ?? "출처 미상"} · {formatDate(article.publishedAt)}</div>
                              {article.contentExcerpt && <p>{article.contentExcerpt}</p>}
                            </div>
                          ))}
'@
$newArticleRendering = @'
                          ) : articles.map((article) => {
                            const isScrapped = scraps.some((saved) => saved.id === article.id);
                            return (
                              <div className="article-item article-item-with-action" key={article.id}>
                                <div className="article-item-content">
                                  <a href={article.canonicalUrl} target="_blank" rel="noreferrer">{article.title}</a>
                                  <div className="article-meta">{article.sourceName ?? "출처 미상"} · {formatDate(article.publishedAt)}</div>
                                  {article.contentExcerpt && <p>{article.contentExcerpt}</p>}
                                </div>
                                <button
                                  type="button"
                                  className={`scrap-button ${isScrapped ? "is-scrapped" : ""}`}
                                  onClick={() => void handleToggleScrap(topic.id, article)}
                                >
                                  {isScrapped ? "★ 스크랩 해제" : "☆ 스크랩"}
                                </button>
                              </div>
                            );
                          })}
'@
$app = Replace-ExactlyOnce $app $oldArticleRendering $newArticleRendering 'article card scrap button'

$oldWorkspaceAnchor = @'
      <section className="workspace-grid">
'@
$newWorkspaceAnchor = @'
      <section className="scraps-section">
        <div className="section-heading">
          <div><div className="section-kicker">SAVED NEWS</div><h2>스크랩 보관함</h2></div>
          <span className="count-badge">{scraps.length}개</span>
        </div>
        {scraps.length === 0 ? (
          <div className="scraps-empty">아직 스크랩한 뉴스가 없어요. 보관하고 싶은 기사에서 ☆ 스크랩을 눌러주세요.</div>
        ) : (
          <div className="scraps-list">
            {scraps.map((article) => (
              <article className="scrap-card" key={article.id}>
                <div className="scrap-card-content">
                  <a href={article.canonicalUrl} target="_blank" rel="noreferrer">{article.title}</a>
                  <div className="article-meta">
                    {article.sourceName ?? "출처 미상"} · 발행 {formatDate(article.publishedAt)} · 스크랩 {formatDate(article.savedAt)}
                  </div>
                  {article.contentExcerpt && <p>{article.contentExcerpt}</p>}
                </div>
                <button type="button" className="scrap-button is-scrapped" onClick={() => void handleRemoveScrap(article.id)}>
                  ★ 스크랩 해제
                </button>
              </article>
            ))}
          </div>
        )}
      </section>

      <section className="workspace-grid">
'@
$app = Replace-ExactlyOnce $app $oldWorkspaceAnchor $newWorkspaceAnchor 'scrap archive section'
Update-ProjectFile "apps\web\src\App.tsx" $app

# 10. Append styles without replacing the current design.
$cssPath = Get-ProjectPath "apps\web\src\styles\index.css"
$css = [System.IO.File]::ReadAllText($cssPath, [System.Text.Encoding]::UTF8)
$css = $css -replace "`r`n", "`n"
if ($css -notmatch '/\* News for Me scraps feature \*/') {
    $css += @'

/* News for Me scraps feature */
.scraps-section {
  margin: 0 0 34px;
  padding: 24px;
  border: 1px solid #e7ebf1;
  border-radius: 18px;
  background: #fff;
  box-shadow: 0 12px 40px rgb(30 50 80 / 4%);
}

.scraps-empty {
  padding: 22px 16px;
  border: 1px dashed #d9e0ea;
  border-radius: 12px;
  color: #7b8799;
  font-size: 13px;
  text-align: center;
}

.scraps-list {
  display: grid;
  gap: 12px;
  margin-top: 18px;
}

.scrap-card,
.article-item-with-action {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
}

.scrap-card {
  padding: 16px;
  border: 1px solid #e8edf3;
  border-radius: 12px;
}

.scrap-card-content,
.article-item-content {
  min-width: 0;
  flex: 1;
}

.scrap-card-content > a,
.article-item-content > a {
  color: #172033;
  font-weight: 700;
  line-height: 1.6;
  text-decoration: none;
}

.scrap-card-content > a:hover,
.article-item-content > a:hover {
  color: #315fe8;
  text-decoration: underline;
}

.scrap-card-content > p,
.article-item-content > p {
  margin: 8px 0 0;
  color: #6b7688;
  font-size: 13px;
  line-height: 1.7;
}

.scrap-button {
  flex: 0 0 auto;
  border: 1px solid #dbe3ef;
  border-radius: 9px;
  padding: 8px 11px;
  color: #315fe8;
  background: #f5f8ff;
  font-size: 12px;
  font-weight: 700;
  cursor: pointer;
}

.scrap-button:hover {
  border-color: #315fe8;
  background: #edf2ff;
}

.scrap-button.is-scrapped {
  color: #946200;
  border-color: #f0dfad;
  background: #fff9e8;
}

.article-item-with-action {
  align-items: center;
}

@media (max-width: 600px) {
  .scraps-section { padding: 16px; }
  .scrap-card,
  .article-item-with-action { flex-direction: column; align-items: stretch; }
  .scrap-button { align-self: flex-start; }
}
'@
    Update-ProjectFile "apps\web\src\styles\index.css" $css
}
else {
    Write-Host "[SKIP] Scrap styles already exist" -ForegroundColor Yellow
}

Write-Host "" 
Write-Host "Scraps feature files created and existing files updated." -ForegroundColor Green
Write-Host "Backup directory: $BackupRoot" -ForegroundColor Cyan
Write-Host "Next: apply migration 0003 locally, then run typechecks/build." -ForegroundColor Yellow
