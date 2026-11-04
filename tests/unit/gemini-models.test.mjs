import test from "node:test";
import assert from "node:assert/strict";
import {
  FREE_TIER_GEMINI_MODEL_IDS,
  listGeminiModels,
  parseGeminiModelCatalog,
  resolveGeminiModelOrder
} from "../../apps/worker/src/services/ai/gemini-models.ts";

test("Gemini catalog keeps only text-generation language models", () => {
  const models = parseGeminiModelCatalog({
    models: [
      { name: "models/gemini-3.8-flash", displayName: "Gemini 3.8 Flash", supportedGenerationMethods: ["generateContent"], inputTokenLimit: 1000 },
      { name: "models/gemma-4-26b-it", supportedGenerationMethods: ["generateContent"] },
      { name: "models/text-embedding-004", supportedGenerationMethods: ["embedContent"] },
      { name: "models/gemini-3.8-flash-tts", supportedGenerationMethods: ["generateContent"] },
      { name: "models/gemini-3.8-live", supportedGenerationMethods: ["generateContent"] },
      { name: "models/imagen-4", supportedGenerationMethods: ["generateContent"] },
      { name: "models/gemini-no-generate", supportedGenerationMethods: ["countTokens"] }
    ]
  });

  assert.deepEqual(models.map((model) => model.id), ["gemini-3.8-flash", "gemma-4-26b-it"]);
  assert.equal(models[0].isFreeTier, true);
  assert.equal(models[0].inputTokenLimit, 1000);
  assert.equal(models[1].isFreeTier, true);
});

test("preferred model only changes order; remaining free models remain fallbacks", () => {
  const models = parseGeminiModelCatalog({
    models: [
      { name: "models/gemini-3.8-flash", supportedGenerationMethods: ["generateContent"] },
      { name: "models/gemini-3.5-flash", supportedGenerationMethods: ["generateContent"] },
      { name: "models/gemini-3.5-flash-lite", supportedGenerationMethods: ["generateContent"] },
      { name: "models/gemini-4-argon", supportedGenerationMethods: ["generateContent"] }
    ]
  });

  const order = resolveGeminiModelOrder(models, "gemini-3.5-flash", undefined, false);
  assert.deepEqual(order, [
    "gemini-3.5-flash",
    "gemini-3.5-flash-lite",
    "gemini-3.8-flash"
  ]);
  assert.equal(order.includes("gemini-4-argon"), false);
});

test("legacy fallback remains second priority and paid models require explicit opt-in", () => {
  const models = parseGeminiModelCatalog({
    models: [
      { name: "models/gemini-3.8-flash", supportedGenerationMethods: ["generateContent"] },
      { name: "models/gemini-4-argon", supportedGenerationMethods: ["generateContent"] }
    ]
  });

  assert.deepEqual(
    resolveGeminiModelOrder(models, "gemini-3.8-flash", "gemini-4-argon", false),
    ["gemini-3.8-flash"]
  );
  assert.deepEqual(
    resolveGeminiModelOrder(models, "gemini-4-argon", "gemini-3.8-flash", true),
    ["gemini-4-argon", "gemini-3.8-flash"]
  );
});

test("model list uses the supplied API key and follows catalog pagination", async () => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (input, init) => {
    requests.push({ url: new URL(String(input)), key: new Headers(init?.headers).get("x-goog-api-key") });
    if (requests.length === 1) {
      return new Response(JSON.stringify({
        models: [{ name: "models/gemini-3.8-flash", supportedGenerationMethods: ["generateContent"] }],
        nextPageToken: "next-page"
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    return new Response(JSON.stringify({
      models: [{ name: "models/gemini-3.5-flash-lite", supportedGenerationMethods: ["generateContent"] }]
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  };

  try {
    const models = await listGeminiModels("test-gemini-key");
    assert.equal(requests.length, 2);
    assert.equal(requests[0].key, "test-gemini-key");
    assert.equal(requests[1].url.searchParams.get("pageToken"), "next-page");
    assert.deepEqual(models.map((model) => model.id), [
      "gemini-3.5-flash-lite",
      "gemini-3.8-flash"
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("empty catalog keeps the conservative free-tier fallback", () => {
  assert.deepEqual(resolveGeminiModelOrder([], "unknown-model", undefined, false), [...FREE_TIER_GEMINI_MODEL_IDS]);
});

test("paid-only catalog is not called when paid models are disabled", () => {
  const models = parseGeminiModelCatalog({
    models: [{ name: "models/gemini-4-argon", supportedGenerationMethods: ["generateContent"] }]
  });
  assert.deepEqual(resolveGeminiModelOrder(models, undefined, undefined, false), []);
});
