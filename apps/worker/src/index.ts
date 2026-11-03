import type { ApiHealthResponse } from "@news-for-me/shared";
import { handleTopicsRequest } from "./routes/topics";
import { handleCollectionRequest } from "./routes/collection";
import { handleScrapsRequest } from "./routes/scraps";
import { handleNewsletterRequest } from "./routes/newsletter";
import type { GmailEnvironment } from "./services/email/types";
import { createAuth, isBetterAuthConfigured } from "./services/auth/better-auth";
import { resolveAppIdentity } from "./lib/authentication";
import { handleAuthMigration } from "./routes/auth-migration";
import { cleanupUnScrapedNews } from "./services/maintenance/article-cleanup";
import { ensureDevelopmentUser } from "./lib/dev-user";
import { jsonResponse } from "./lib/http";
import { handleNewsCollectionQueue } from "./queues/consumers/news-collection";
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
  AUTH_ALLOWED_EMAIL?: string;
  LEGACY_USER_ID?: string;
  AUTH_MIGRATION_TOKEN?: string;
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
      return handleAuthMigration(request, env);
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

    const isNewsletterApi =
      url.pathname === "/api/newsletter/preview" ||
      url.pathname === "/api/newsletter/send-test";

    const isScrapsApi =
      url.pathname === "/api/scraps" ||
      url.pathname.startsWith("/api/scraps/") ||
      url.pathname === "/api/tags" ||
      url.pathname.startsWith("/api/tags/") ||
      /^\\/api\\/topics\\/[^/]+\\/articles\\/[^/]+\\/scrap$/.test(url.pathname);

    const isTopicsApi =
      url.pathname === "/api/topics" ||
      url.pathname.startsWith("/api/topics/");

    if (isNewsletterApi || isScrapsApi || isTopicsApi) {
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

      if (isNewsletterApi) {
        try {
          return await handleNewsletterRequest(
            request,
            env,
            identity.userId,
            identity.email,
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
        if (/^\\/api\\/topics\\/[^/]+\\/(collect|articles|collection-runs\\/[^/]+)$/.test(url.pathname)) {
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
    if (controller.cron !== "0 15 * * 0") {
      console.log("Ignoring unrecognized scheduled event", controller.cron);
      return;
    }

    console.log("Starting weekly unsaved-news cleanup", new Date(controller.scheduledTime).toISOString());
    const result = await cleanupUnScrapedNews(env.DB);
    console.log("Weekly unsaved-news cleanup completed", result);
  }
};

