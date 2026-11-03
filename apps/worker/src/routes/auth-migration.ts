import { getMigrations } from "better-auth/db/migration";
import { createAuth, type BetterAuthEnvironment } from "../services/auth/better-auth";
import { jsonResponse } from "../lib/http";

interface MigrationEnvironment extends BetterAuthEnvironment {
  AUTH_MIGRATION_TOKEN?: string;
}

export async function handleAuthMigration(
  request: Request,
  env: MigrationEnvironment,
  allowedOrigin: string
): Promise<Response> {
  if (request.method !== "POST") {
    return new Response("Not Found", { status: 404 });
  }

  const expected = env.AUTH_MIGRATION_TOKEN?.trim();
  const supplied = request.headers.get("Authorization") ?? "";
  if (!expected || supplied !== `Bearer ${expected}`) {
    return new Response("Not Found", { status: 404 });
  }

  if (!env.BETTER_AUTH_SECRET?.trim() ||
      !env.BETTER_AUTH_URL?.trim() ||
      !env.GOOGLE_CLIENT_ID?.trim() ||
      !env.GOOGLE_CLIENT_SECRET?.trim() ||
      !env.AUTH_ALLOWED_EMAIL?.trim()) {
    return jsonResponse({ error: "Google authentication configuration is incomplete." }, 503, allowedOrigin);
  }

  try {
    const auth = createAuth(env);
    const migrations = await getMigrations(auth.options);
    const pendingTables = migrations.toBeCreated.length;
    const pendingColumns = migrations.toBeAdded.length;
    await migrations.runMigrations();

    return jsonResponse({
      ok: true,
      pendingTables,
      pendingColumns,
      message: "Better Auth D1 schema is ready."
    }, 200, allowedOrigin);
  } catch (error) {
    console.error("Better Auth migration failed:", error);
    return jsonResponse({
      error: "Better Auth database migration failed.",
      details: error instanceof Error ? [error.message.slice(0, 300)] : []
    }, 500, allowedOrigin);
  }
}
