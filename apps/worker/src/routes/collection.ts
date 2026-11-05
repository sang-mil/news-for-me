import type { CollectionJobMessage } from "../services/news/types";
import {
  createCollectionRun,
  getCollectionRun,
  getTopicForCollection,
  listTopicArticles
} from "../db/repositories/news";
import { jsonResponse } from "../lib/http";
import { clearTopicFeed } from "../db/repositories/personalization";

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
  const clearMatch = url.pathname.match(/^\/api\/topics\/([^/]+)\/articles\/clear$/);
  const runMatch = url.pathname.match(/^\/api\/topics\/([^/]+)\/collection-runs\/([^/]+)$/);
  const topicIdRaw = collectMatch?.[1] ?? articlesMatch?.[1] ?? clearMatch?.[1] ?? runMatch?.[1];

  if (!topicIdRaw) return jsonResponse({ error: "Not Found" }, 404, allowedOrigin);

  let topicId: string;
  try {
    topicId = decodeURIComponent(topicIdRaw);
  } catch {
    return jsonResponse({ error: "Invalid topic ID." }, 400, allowedOrigin);
  }

  const topic = await getTopicForCollection(db, topicId);
  if (!topic) {
    return jsonResponse({ error: "Topic not found or inactive." }, 404, allowedOrigin);
  }

  if (collectMatch && request.method === "POST") {
    let payload: unknown = {};
    try {
      const rawBody = await request.text();
      if (rawBody.trim()) payload = JSON.parse(rawBody);
    } catch {
      return jsonResponse({ error: "Request body must contain valid JSON." }, 400, allowedOrigin);
    }
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      return jsonResponse({ error: "Request body must be a JSON object." }, 400, allowedOrigin);
    }
    const requestedMax = (payload as { maxArticles?: unknown }).maxArticles;
    const maxArticles = requestedMax === undefined ? 10 : requestedMax;
    if (!Number.isInteger(maxArticles) || (maxArticles as number) < 5 || (maxArticles as number) > 30) {
      return jsonResponse({ error: "maxArticles must be an integer between 5 and 30." }, 400, allowedOrigin);
    }
    const runId = await createCollectionRun(db, topicId);
    const message: CollectionJobMessage = { runId, topicId, userId, maxArticles: maxArticles as number };
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

  if (clearMatch && request.method === "POST") {
    await clearTopicFeed(db, userId, topicId);
    return jsonResponse({ ok: true }, 200, allowedOrigin);
  }

  if (articlesMatch && request.method === "GET") {
    const requestedLimit = Number(url.searchParams.get("limit") ?? "20");
    const limit = Number.isFinite(requestedLimit)
      ? Math.min(50, Math.max(1, Math.floor(requestedLimit)))
      : 20;
    const articles = await listTopicArticles(db, topicId, userId, limit);
    return jsonResponse({ data: articles }, 200, allowedOrigin);
  }

  if (runMatch && request.method === "GET") {
    let runId: string;
    try {
      runId = decodeURIComponent(runMatch[2]);
    } catch {
      return jsonResponse({ error: "Invalid collection run ID." }, 400, allowedOrigin);
    }
    const run = await getCollectionRun(db, topicId, runId);
    return run
      ? jsonResponse({ data: run }, 200, allowedOrigin)
      : jsonResponse({ error: "Collection run not found." }, 404, allowedOrigin);
  }

  return jsonResponse({ error: "Method not allowed." }, 405, allowedOrigin);
}
