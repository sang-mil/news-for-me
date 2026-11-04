import test from "node:test";
import assert from "node:assert/strict";
import { testCredential } from "../../apps/worker/src/routes/integrations.ts";

test("OpenRouter validation authenticates against the private current-key endpoint", async () => {
  const originalFetch = globalThis.fetch;
  let requestedUrl = "";
  let authorization = "";
  globalThis.fetch = async (input, init) => {
    requestedUrl = String(input);
    authorization = new Headers(init?.headers).get("Authorization") ?? "";
    return new Response(JSON.stringify({ data: { label: "sk-or-...123" } }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  };

  try {
    await testCredential("openrouter", "sk-or-test-key");
    assert.equal(requestedUrl, "https://openrouter.ai/api/v1/key");
    assert.equal(authorization, "Bearer sk-or-test-key");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("OpenRouter validation rejects an invalid key", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(
    JSON.stringify({ error: { message: "Invalid API key" } }),
    { status: 401, headers: { "Content-Type": "application/json" } }
  );

  try {
    await assert.rejects(
      () => testCredential("openrouter", "sk-or-invalid"),
      /HTTP 401/
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
