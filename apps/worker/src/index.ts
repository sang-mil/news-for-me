import type { ApiHealthResponse } from "@news-for-me/shared";
import { handleTopicsRequest } from "./routes/topics";
import { handleCollectionRequest } from "./routes/collection";
import { handleScrapsRequest } from "./routes/scraps";
import { cleanupUnScrapedNews } from "./services/maintenance/article-cleanup";
import { ensureDevelopmentUser } from "./lib/dev-user";
import { jsonResponse } from "./lib/http";
import { handleNewsCollectionQueue } from "./queues/consumers/news-collection";
import type { AIEnvironment } from "./services/ai/types";
import type { CollectionJobMessage } from "./services/news/types";

interface Env extends AIEnvironment {
  DB: D1Database;
  NEWS_QUEUE: Queue<CollectionJobMessage>;
  ALLOWED_ORIGIN?: string;
  DEV_USER_ID?: string;
  DEV_USER_EMAIL?: string;
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

    const isScrapsApi =
      url.pathname === "/api/scraps" ||
      url.pathname.startsWith("/api/scraps/") ||
      url.pathname === "/api/tags" ||
      url.pathname.startsWith("/api/tags/") ||
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
      let userId: string | null;
      try {
        userId = await ensureDevelopmentUser(env.DB, env);
      } catch {
        return jsonResponse({ error: "Could not initialize the local development user." }, 503, allowedOrigin);
      }

      if (!userId) {
        return jsonResponse(
          {
            error: "Authentication is not configured. Set DEV_USER_ID and DEV_USER_EMAIL in apps/worker/.dev.vars for local development. Production authentication must be implemented before public deployment."
          },
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
