import type { InterestProfile } from "@news-for-me/shared";
import { getInterestProfile, recordArticleEvent } from "../db/repositories/personalization";
import { getUserIntegration } from "../services/integrations";
import { refreshInterestProfile } from "../services/ai/interest-profile";
import type { AIEnvironment } from "../services/ai/types";
import { jsonResponse } from "../lib/http";

interface PersonalizationEnvironment extends AIEnvironment {
  DB: D1Database;
  INTEGRATION_ENCRYPTION_KEY?: string;
}

async function resolveUserAIEnvironment(
  env: PersonalizationEnvironment,
  userId: string
): Promise<AIEnvironment> {
  const ai: AIEnvironment = { ...env };
  if (!env.INTEGRATION_ENCRYPTION_KEY?.trim()) return ai;

  const saved = await getUserIntegration(
    env.DB, userId, "gemini", env.INTEGRATION_ENCRYPTION_KEY
  );
  if (!saved) return ai;

  ai.GEMINI_API_KEY_1 = saved.config.enabled === false ? undefined : saved.credentials.secret;
  ai.GEMINI_API_KEY_2 = undefined;
  ai.GEMINI_MODEL_PRIMARY = saved.config.modelPrimary ?? env.GEMINI_MODEL_PRIMARY;
  ai.GEMINI_MODEL_FALLBACK = saved.config.modelFallback ?? env.GEMINI_MODEL_FALLBACK;
  ai.GEMINI_ALLOW_PAID_MODELS = saved.config.allowPaidGemini === true ? "true" : "false";
  return ai;
}

async function handleArticleOpen(
  request: Request,
  db: D1Database,
  userId: string,
  allowedOrigin: string
): Promise<Response> {
  const url = new URL(request.url);
  const match = url.pathname.match(/^\/api\/articles\/([^/]+)\/open$/);
  if (!match || request.method !== "GET") {
    return jsonResponse({ error: "Not Found" }, 404, allowedOrigin);
  }

  let articleId: string;
  try { articleId = decodeURIComponent(match[1]); }
  catch { return jsonResponse({ error: "Invalid article ID." }, 400, allowedOrigin); }

  const topicId = url.searchParams.get("topicId");
  const row = topicId
    ? await db.prepare(`
        SELECT a.canonical_url
        FROM articles a
        INNER JOIN topic_articles ta ON ta.article_id = a.id
        WHERE a.id = ? AND ta.topic_id = ?
        LIMIT 1
      `).bind(articleId, topicId).first<{ canonical_url: string }>()
    : await db.prepare(`
        SELECT a.canonical_url
        FROM articles a
        INNER JOIN article_saves s ON s.article_id = a.id
        WHERE a.id = ? AND s.user_id = ?
        LIMIT 1
      `).bind(articleId, userId).first<{ canonical_url: string }>();

  if (!row) return jsonResponse({ error: "Article not found." }, 404, allowedOrigin);

  let destination: URL;
  try {
    destination = new URL(row.canonical_url);
    if (destination.protocol !== "https:" && destination.protocol !== "http:") {
      throw new Error("Unsupported protocol");
    }
  } catch {
    return jsonResponse({ error: "Article URL is invalid." }, 502, allowedOrigin);
  }

  await recordArticleEvent(db, userId, articleId, topicId, "opened");
  return new Response(null, {
    status: 302,
    headers: {
      "Location": destination.toString(),
      "Cache-Control": "no-store",
      "Referrer-Policy": "strict-origin-when-cross-origin"
    }
  });
}

export async function handlePersonalizationRequest(
  request: Request,
  env: PersonalizationEnvironment,
  userId: string,
  allowedOrigin: string
): Promise<Response> {
  const path = new URL(request.url).pathname;

  if (path.startsWith("/api/articles/")) {
    return handleArticleOpen(request, env.DB, userId, allowedOrigin);
  }

  if (path === "/api/interest-profile" && request.method === "GET") {
    const data: InterestProfile = await getInterestProfile(env.DB, userId);
    return jsonResponse({ data }, 200, allowedOrigin);
  }

  if (path === "/api/interest-profile/refresh" && request.method === "POST") {
    try {
      const aiEnvironment = await resolveUserAIEnvironment(env, userId);
      const data = await refreshInterestProfile(env.DB, userId, aiEnvironment, true);
      return jsonResponse({ data }, 200, allowedOrigin);
    } catch (error) {
      return jsonResponse({
        error: error instanceof Error ? error.message : "관심사 프로필을 갱신하지 못했습니다."
      }, 502, allowedOrigin);
    }
  }

  return jsonResponse({ error: "Not Found" }, 404, allowedOrigin);
}
