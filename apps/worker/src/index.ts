import type { ApiHealthResponse } from "@news-for-me/shared";
import { handleTopicsRequest } from "./routes/topics";
import { handleCollectionRequest } from "./routes/collection";
import { handleScrapsRequest } from "./routes/scraps";
import { handleNewsletterRequest } from "./routes/newsletter";
import { processDueNewsletterSchedules } from "./services/email/newsletter-scheduler";
import type { GmailEnvironment } from "./services/email/types";
import { createAuth, isBetterAuthConfigured } from "./services/auth/better-auth";
import { resolveAppIdentity } from "./lib/authentication";
import { handleAuthMigration } from "./routes/auth-migration";
import { handleIntegrationsRequest } from "./routes/integrations";
import { handlePersonalizationRequest } from "./routes/personalization";
import { cleanupExpiredYouTubeApiData, cleanupUnScrapedNews } from "./services/maintenance/article-cleanup";
import { jsonResponse } from "./lib/http";
import { handleNewsCollectionQueue } from "./queues/consumers/news-collection";
import { createCollectionRun, listDailyCollectionTargets } from "./db/repositories/news";
import type { AIEnvironment } from "./services/ai/types";
import type { CollectionJobMessage } from "./services/news/types";

interface Env extends AIEnvironment, GmailEnvironment {
  DB: D1Database;
  NEWS_QUEUE: Queue<CollectionJobMessage>;
  ALLOWED_ORIGIN?: string;
  DEV_USER_ID?: string;
  DEV_USER_EMAIL?: string;
  ALLOW_DEV_AUTH?: string;
  BETTER_AUTH_SECRET?: string;
  BETTER_AUTH_URL?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  LEGACY_USER_ID?: string;
  AUTH_MIGRATION_TOKEN?: string;
  INTEGRATION_ENCRYPTION_KEY?: string;
  YOUTUBE_API_KEY?: string;
  X_BEARER_TOKEN?: string;
  THREADS_ACCESS_TOKEN?: string;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const allowedOrigins = (env.ALLOWED_ORIGIN ?? "http://127.0.0.1:5173")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean);

    const origin = request.headers.get("Origin");

    const allowedOrigin =
      origin && allowedOrigins.includes(origin)
        ? origin
        : allowedOrigins[0] ?? "http://127.0.0.1:5173";

    if (origin && !allowedOrigins.includes(origin)) {
      return new Response("Origin not allowed", { status: 403 });
    }

    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": allowedOrigin,
          "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, Authorization",
          "Access-Control-Max-Age": "86400",
          "Vary": "Origin"
        }
      });
    }

    const url = new URL(request.url);

    if (url.pathname === "/api/_internal/auth-migrate") {
      return handleAuthMigration(request, env, allowedOrigin);
    }

    if (url.pathname.startsWith("/api/auth/")) {
      if (!isBetterAuthConfigured(env)) {
        return jsonResponse(
          { error: "Google 로그인 설정이 필요합니다. BETTER_AUTH_SECRET, BETTER_AUTH_URL, GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET을 확인하세요." },
          503,
          allowedOrigin
        );
      }
      return createAuth(env).handler(request);
    }

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
          {
            ok: false,
            service: "news-for-me-api",
            database: "unavailable",
            error: "Database connection failed"
          },
          503,
          allowedOrigin
        );
      }
    }

    if (url.pathname === "/api/me" && request.method === "GET") {
      try {
        const identity = await resolveAppIdentity(request, env);
        return jsonResponse(
          identity
            ? {
                authenticated: true,
                isDevelopment: identity.isDevelopment,
                user: { id: identity.userId, email: identity.email, name: identity.name }
              }
            : { authenticated: false, isDevelopment: false, user: null },
          200,
          allowedOrigin
        );
      } catch (error) {
        console.error("Identity resolution failed:", error);
        return jsonResponse({ error: "로그인 상태를 확인하지 못했습니다." }, 500, allowedOrigin);
      }
    }

    const isPersonalizationApi =
      url.pathname === "/api/interest-profile" ||
      url.pathname.startsWith("/api/interest-profile/") ||
      url.pathname.startsWith("/api/articles/");
    const isIntegrationsApi = url.pathname === "/api/integrations" || url.pathname.startsWith("/api/integrations/");

    const isNewsletterApi =
      url.pathname === "/api/newsletter/preview" ||
      url.pathname === "/api/newsletter/send-test" ||
      url.pathname === "/api/newsletter/schedules" ||
      url.pathname.startsWith("/api/newsletter/schedules/");

    const isScrapsApi =
      url.pathname === "/api/scraps" ||
      url.pathname.startsWith("/api/scraps/") ||
      url.pathname === "/api/tags" ||
      url.pathname.startsWith("/api/tags/") ||
      /^\/api\/topics\/[^/]+\/articles\/[^/]+\/scrap$/.test(url.pathname);

    const isTopicsApi =
      url.pathname === "/api/topics" ||
      url.pathname.startsWith("/api/topics/");

    if (isPersonalizationApi || isIntegrationsApi || isNewsletterApi || isScrapsApi || isTopicsApi) {
      let identity;
      try {
        identity = await resolveAppIdentity(request, env);
      } catch (error) {
        console.error("Authentication lookup failed:", error);
        return jsonResponse({ error: "인증 정보를 확인하지 못했습니다. 로그인 상태를 새로고침해 주세요." }, 503, allowedOrigin);
      }

      if (!identity) {
        return jsonResponse(
          { error: "로그인이 필요합니다.", code: "AUTH_REQUIRED" },
          401,
          allowedOrigin
        );
      }

      if (isPersonalizationApi) {
        try {
          return await handlePersonalizationRequest(request, env, identity.userId, allowedOrigin);
        } catch (error) {
          console.error("Personalization API error:", error);
          return jsonResponse({ error: "개인화 데이터를 처리하지 못했습니다." }, 500, allowedOrigin);
        }
      }

      if (isIntegrationsApi) {
        try {
          return await handleIntegrationsRequest(request, env, identity.userId, allowedOrigin);
        } catch (error) {
          console.error("Integrations API error:", error instanceof Error ? error.message : "Unknown error");
          return jsonResponse({ error: "연동 설정을 처리하지 못했습니다." }, 500, allowedOrigin);
        }
      }

      if (isNewsletterApi) {
        try {
          return await handleNewsletterRequest(
            request,
            env,
            identity.userId,
            allowedOrigin
          );
        } catch (error) {
          const detail = error instanceof Error ? error.message : "Unknown newsletter error";
          console.error("Newsletter API error:", detail);
          return jsonResponse({ error: "뉴스레터 처리 중 오류가 발생했습니다." }, 500, allowedOrigin);
        }
      }

      if (isScrapsApi) {
        try {
          return await handleScrapsRequest(request, env.DB, identity.userId, allowedOrigin);
        } catch (error) {
          console.error("Scraps API error:", error);
          return jsonResponse({ error: "An internal error occurred while processing saved news." }, 500, allowedOrigin);
        }
      }

      try {
        if (/^\/api\/topics\/[^/]+\/(collect|articles(?:\/clear)?|collection-runs\/[^/]+)$/.test(url.pathname)) {
          return await handleCollectionRequest(
            request,
            env.DB,
            env.NEWS_QUEUE,
            identity.userId,
            allowedOrigin
          );
        }
        return await handleTopicsRequest(request, env.DB, identity.userId, allowedOrigin);
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
  },

  async scheduled(controller: ScheduledController, env: Env): Promise<void> {
    if (controller.cron === "* * * * *") {
      const result = await processDueNewsletterSchedules(env.DB, env, controller.scheduledTime);
      if (result.examined || result.staleFailed) {
        console.log("Newsletter schedule check completed", result);
      }
      return;
    }

    if (controller.cron === "0 23 * * *") {
      const targets = await listDailyCollectionTargets(env.DB);
      let queued = 0;
      let failed = 0;
      for (const target of targets) {
        const runId = await createCollectionRun(env.DB, target.topicId, "cron");
        try {
          await env.NEWS_QUEUE.send({
            runId,
            topicId: target.topicId,
            userId: target.userId,
            maxArticles: 10
          });
          queued += 1;
        } catch (error) {
          failed += 1;
          const detail = error instanceof Error ? error.message : "Queue unavailable";
          await env.DB.prepare(`
            UPDATE collection_runs
            SET status = 'failed', error_message = ?,
              finished_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
            WHERE id = ?
          `).bind(detail.slice(0, 1000), runId).run();
          console.error("Daily topic collection could not be queued", {
            topicId: target.topicId,
            error: detail
          });
        }
      }
      console.log("Daily topic collection scheduled", { total: targets.length, queued, failed });
      return;
    }

    if (controller.cron === "0 * * * *") {
      const result = await cleanupExpiredYouTubeApiData(env.DB);
      if (result.articlesDeleted || result.eventsDeleted || result.summariesDeleted) {
        console.log("YouTube API retention cleanup completed", result);
      }
      return;
    }

    if (controller.cron === "0 15 * * SUN") {
      console.log("Starting weekly unsaved-news cleanup", new Date(controller.scheduledTime).toISOString());
      const result = await cleanupUnScrapedNews(env.DB);
      console.log("Weekly unsaved-news cleanup completed", result);
      return;
    }

    console.log("Ignoring unrecognized scheduled event", controller.cron);
  }
};

