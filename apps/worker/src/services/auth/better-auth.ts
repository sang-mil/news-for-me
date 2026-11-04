import { betterAuth } from "better-auth";

export interface BetterAuthEnvironment {
  DB: D1Database;
  BETTER_AUTH_SECRET?: string;
  BETTER_AUTH_URL?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  ALLOWED_ORIGIN?: string;
}

export function isBetterAuthConfigured(env: BetterAuthEnvironment): boolean {
  return Boolean(
    env.BETTER_AUTH_SECRET?.trim() &&
    env.BETTER_AUTH_URL?.trim() &&
    env.GOOGLE_CLIENT_ID?.trim() &&
    env.GOOGLE_CLIENT_SECRET?.trim()
  );
}

export function createAuth(env: BetterAuthEnvironment) {
  const baseURL = env.BETTER_AUTH_URL?.trim();
  const secret = env.BETTER_AUTH_SECRET?.trim();
  const clientId = env.GOOGLE_CLIENT_ID?.trim();
  const clientSecret = env.GOOGLE_CLIENT_SECRET?.trim();

  if (!baseURL || !secret || !clientId || !clientSecret) {
    throw new Error(
      "Google authentication is not configured. Set BETTER_AUTH_SECRET, BETTER_AUTH_URL, GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET."
    );
  }

  const trustedOrigins = [
    baseURL,
    ...(env.ALLOWED_ORIGIN ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean)
  ];

  return betterAuth({
    database: env.DB,
    secret,
    baseURL,
    trustedOrigins,
    socialProviders: {
      google: {
        clientId,
        clientSecret
      }
    },
    emailAndPassword: {
      enabled: false
    },
    session: {
      expiresIn: 60 * 60 * 24 * 30,
      updateAge: 60 * 60 * 24 * 7
    }
  });
}
