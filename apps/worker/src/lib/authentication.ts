import type { BetterAuthEnvironment } from "../services/auth/better-auth";
import { createAuth, isBetterAuthConfigured } from "../services/auth/better-auth";
import { ensureDevelopmentUser } from "./dev-user";

export interface AppIdentity {
  userId: string;
  email: string;
  name: string;
  isDevelopment: boolean;
}

interface AppUserLinkRow {
  id: string;
  auth_user_id: string | null;
}

export type IdentityEnvironment = BetterAuthEnvironment & {
  ALLOW_DEV_AUTH?: string;
  DEV_USER_ID?: string;
  DEV_USER_EMAIL?: string;
  LEGACY_USER_ID?: string;
};

async function linkAuthUserToAppUser(
  db: D1Database,
  authUser: { id: string; email: string; name: string },
  legacyUserId?: string
): Promise<string> {
  const linked = await db.prepare(
    "SELECT id FROM users WHERE auth_user_id = ? LIMIT 1"
  ).bind(authUser.id).first<{ id: string }>();
  if (linked) return linked.id;

  // Existing accounts are linked only when the verified Google email matches.
  const existingByEmail = await db.prepare(
    "SELECT id, auth_user_id FROM users WHERE email = ? COLLATE NOCASE LIMIT 1"
  ).bind(authUser.email).first<AppUserLinkRow>();

  if (existingByEmail) {
    if (existingByEmail.auth_user_id && existingByEmail.auth_user_id !== authUser.id) {
      throw new Error("This application account is already linked to another Google identity.");
    }
    await db.prepare(
      "UPDATE users SET auth_user_id = ?, display_name = COALESCE(NULLIF(display_name, ''), ?), " +
      "updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') " +
      "WHERE id = ? AND (auth_user_id IS NULL OR auth_user_id = ?)"
    ).bind(authUser.id, authUser.name || authUser.email, existingByEmail.id, authUser.id).run();
    const linkedAfterUpdate = await db.prepare(
      "SELECT id FROM users WHERE auth_user_id = ? LIMIT 1"
    ).bind(authUser.id).first<{ id: string }>();
    if (!linkedAfterUpdate) throw new Error("Could not link the Google identity to the existing News for Me account.");
    return linkedAfterUpdate.id;
  }

  // LEGACY_USER_ID is a one-time migration hint, never a global account assignment.
  // The verified email must match the legacy row before its existing data can be linked.
  if (legacyUserId?.trim()) {
    const legacyUser = await db.prepare(
      "SELECT id, email, auth_user_id FROM users WHERE id = ? LIMIT 1"
    ).bind(legacyUserId.trim()).first<{ id: string; email: string; auth_user_id: string | null }>();
    if (legacyUser && legacyUser.email.trim().toLowerCase() === authUser.email &&
        (!legacyUser.auth_user_id || legacyUser.auth_user_id === authUser.id)) {
      await db.prepare(
        "UPDATE users SET auth_user_id = ?, display_name = COALESCE(NULLIF(display_name, ''), ?), " +
        "updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') " +
        "WHERE id = ? AND (auth_user_id IS NULL OR auth_user_id = ?)"
      ).bind(authUser.id, authUser.name || authUser.email, legacyUser.id, authUser.id).run();
      const migrated = await db.prepare(
        "SELECT id FROM users WHERE auth_user_id = ? LIMIT 1"
      ).bind(authUser.id).first<{ id: string }>();
      if (migrated) return migrated.id;
    }
  }

  const appUserId = crypto.randomUUID();
  try {
    await db.prepare(
      "INSERT INTO users (id, email, display_name, auth_user_id) VALUES (?, ?, ?, ?)"
    ).bind(appUserId, authUser.email, authUser.name || authUser.email, authUser.id).run();
  } catch (error) {
    const concurrentLink = await db.prepare(
      "SELECT id FROM users WHERE auth_user_id = ? LIMIT 1"
    ).bind(authUser.id).first<{ id: string }>();
    if (concurrentLink) return concurrentLink.id;
    throw error;
  }
  return appUserId;
}

export async function resolveAppIdentity(
  request: Request,
  env: IdentityEnvironment
): Promise<AppIdentity | null> {
  if (isBetterAuthConfigured(env)) {
    const auth = createAuth(env);
    const session = await auth.api.getSession({ headers: request.headers });

    if (session?.user) {
      const email = session.user.email.trim().toLowerCase();
      if (!email || !session.user.emailVerified) return null;

      const userId = await linkAuthUserToAppUser(
        env.DB,
        {
          id: session.user.id,
          email,
          name: session.user.name?.trim() || email
        },
        env.LEGACY_USER_ID
      );

      return {
        userId,
        email,
        name: session.user.name?.trim() || email,
        isDevelopment: false
      };
    }
  }

  // Local-only fallback. Production configuration never enables this flag.
  if (env.ALLOW_DEV_AUTH === "true") {
    const userId = await ensureDevelopmentUser(env.DB, env);
    const email = env.DEV_USER_EMAIL?.trim().toLowerCase() ?? "";
    if (!userId || !email) return null;
    return {
      userId,
      email,
      name: "Local Developer",
      isDevelopment: true
    };
  }

  return null;
}
