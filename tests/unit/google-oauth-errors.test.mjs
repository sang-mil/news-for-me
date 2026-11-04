import test from "node:test";
import assert from "node:assert/strict";
import { describeGoogleOAuthRefreshFailure } from "../../apps/worker/src/services/email/oauth-errors.ts";

test("invalid_client identifies the Client ID and Client Secret pair", () => {
  const message = describeGoogleOAuthRefreshFailure(401, "invalid_client", "Unauthorized");
  assert.match(message, /HTTP 401, invalid_client/);
  assert.match(message, /GOOGLE_CLIENT_ID/);
  assert.match(message, /GOOGLE_CLIENT_SECRET/);
  assert.match(message, /동일한 OAuth 클라이언트/);
});

test("invalid_grant distinguishes refresh token pairing and revocation", () => {
  const message = describeGoogleOAuthRefreshFailure(400, "invalid_grant", "Bad Request");
  assert.match(message, /HTTP 400, invalid_grant/);
  assert.match(message, /GOOGLE_REFRESH_TOKEN/);
  assert.match(message, /폐기·만료/);
});

test("unknown token errors retain status and diagnostic guidance", () => {
  const message = describeGoogleOAuthRefreshFailure(503, undefined, undefined);
  assert.match(message, /HTTP 503, unknown_error/);
  assert.match(message, /GOOGLE_CLIENT_ID/);
});
