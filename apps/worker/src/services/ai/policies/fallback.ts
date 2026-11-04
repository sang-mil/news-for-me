import type { AIEnvironment, ArticleSummaryOutput } from "../types";
import { AIProviderError } from "../types";
import { callGemini } from "../providers/gemini";
import { GeminiModelCatalogError, listGeminiModels, resolveGeminiModelOrder, type GeminiModelOption } from "../gemini-models";
import { callOpenRouter } from "../providers/openrouter";

export interface RoutedSummaryResult {
  summaries: ArticleSummaryOutput[];
  provider: "gemini" | "openrouter";
  model: string;
}

async function logAttempt(
  db: D1Database,
  runId: string,
  provider: "gemini" | "openrouter",
  model: string,
  keySlot: string,
  number: number,
  status: "success" | "failed",
  httpStatus: number,
  errorCode: string | null,
  errorMessage: string | null,
  latencyMs: number,
  retryAfter: number | null
): Promise<void> {
  try {
    await db.prepare(`
      INSERT INTO api_attempt_logs (
        id, run_id, provider, model_name, key_slot, attempt_number,
        status, http_status, error_code, error_message,
        latency_ms, retry_after_seconds
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      crypto.randomUUID(), runId, provider, model, keySlot, number,
      status, httpStatus, errorCode, errorMessage?.slice(0, 700) ?? null,
      latencyMs, retryAfter
    ).run();
  } catch (error) {
    console.error("Could not save AI attempt log", error);
  }
}

function parseResponse(text: string, expectedIds: Set<string>): ArticleSummaryOutput[] {
  let source = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
  const start = source.indexOf("{");
  const end = source.lastIndexOf("}");
  if (start >= 0 && end > start) source = source.slice(start, end + 1);

  let value: unknown;
  try { value = JSON.parse(source); }
  catch { throw new AIProviderError("AI response was not valid JSON", 502, "invalid_json"); }

  if (typeof value !== "object" || value === null || !("summaries" in value) ||
      !Array.isArray((value as { summaries?: unknown }).summaries)) {
    throw new AIProviderError("AI response did not contain summaries[]", 502, "invalid_schema");
  }

  const summaries: ArticleSummaryOutput[] = [];
  const seen = new Set<string>();
  for (const raw of (value as { summaries: unknown[] }).summaries) {
    if (typeof raw !== "object" || raw === null) continue;
    const row = raw as Record<string, unknown>;
    const articleId = typeof row.articleId === "string" ? row.articleId : "";
    if (!expectedIds.has(articleId) || seen.has(articleId)) continue;
    const summary = typeof row.summary === "string" ? row.summary.trim().slice(0, 1200) : "";
    const detailedSummary = typeof row.detailedSummary === "string"
      ? row.detailedSummary.trim().slice(0, 3000) : "";
    const insight = typeof row.insight === "string" ? row.insight.trim().slice(0, 1200) : "";
    const keyPoints = Array.isArray(row.keyPoints)
      ? row.keyPoints.filter((x): x is string => typeof x === "string")
          .map((x) => x.trim().slice(0, 350)).filter(Boolean).slice(0, 5)
      : [];
    const importance = ["urgent", "high", "normal", "low"].includes(String(row.importance))
      ? String(row.importance) as ArticleSummaryOutput["importance"] : "normal";
    if (!summary || !detailedSummary) continue;
    summaries.push({ articleId, summary, detailedSummary, keyPoints, insight, importance });
    seen.add(articleId);
  }

  if (summaries.length !== expectedIds.size) {
    throw new AIProviderError(
      `AI returned ${summaries.length} of ${expectedIds.size} expected summaries`,
      502,
      "incomplete_json"
    );
  }
  return summaries;
}

export async function routeSummaryRequest(
  env: AIEnvironment,
  db: D1Database,
  runId: string,
  prompt: string,
  expectedIds: Set<string>
): Promise<RoutedSummaryResult> {
  const allowPaidGemini = env.GEMINI_ALLOW_PAID_MODELS?.trim().toLowerCase() === "true";
  const keys = [
    { key: env.GEMINI_API_KEY_1?.trim(), slot: "gemini-key-1", project: env.GEMINI_PROJECT_SLOT_1?.trim() || null },
    { key: env.GEMINI_API_KEY_2?.trim(), slot: "gemini-key-2", project: env.GEMINI_PROJECT_SLOT_2?.trim() || null }
  ].filter((x): x is { key: string; slot: string; project: string | null } => Boolean(x.key));

  const project1 = env.GEMINI_PROJECT_SLOT_1?.trim();
  const project2 = env.GEMINI_PROJECT_SLOT_2?.trim();
  const sameOrUnknownProject = !project1 || !project2 || project1 === project2;

  let attempt = 0;
  let skipKey2AfterQuota = false;
  const invalidKeys = new Set<string>();
  let lastError: AIProviderError | null = null;

  // For each eligible key, prefer the selected Gemini model then walk the discovered model catalog.
  for (const key of keys) {
    if (key.slot === "gemini-key-2" && skipKey2AfterQuota) continue;
    if (invalidKeys.has(key.slot)) continue;

    let availableModels: GeminiModelOption[] = [];
    try {
      availableModels = await listGeminiModels(key.key);
    } catch (error) {
      const catalogError = error instanceof GeminiModelCatalogError
        ? error
        : new GeminiModelCatalogError(
            error instanceof Error ? error.message : "Gemini model catalog error",
            503,
            "catalog_error"
          );
      const failure = new AIProviderError(
        catalogError.message,
        catalogError.status,
        catalogError.code
      );
      lastError = failure;
      attempt++;
      await logAttempt(db, runId, "gemini", "models.list", key.slot, attempt,
        "failed", failure.status, failure.code, failure.message, 0, null);
      if (failure.status === 401 || failure.status === 403) invalidKeys.add(key.slot);
      if (failure.status === 429 && sameOrUnknownProject) skipKey2AfterQuota = true;
      console.warn("Gemini model discovery failed", key.slot, failure.status, failure.code);
    }
    if (invalidKeys.has(key.slot)) continue;

    const models = resolveGeminiModelOrder(
      availableModels,
      env.GEMINI_MODEL_PRIMARY,
      env.GEMINI_MODEL_FALLBACK,
      allowPaidGemini
    );
    for (const model of models) {
      attempt++;
      const started = Date.now();
      try {
        const response = await callGemini(key.key, model, prompt);
        const summaries = parseResponse(response.text, expectedIds);
        await logAttempt(db, runId, "gemini", response.model, key.slot, attempt,
          "success", 200, null, null, Date.now() - started, null);
        return { summaries, provider: "gemini", model: response.model };
      } catch (error) {
        const failure = error instanceof AIProviderError
          ? error
          : new AIProviderError(error instanceof Error ? error.message : "Unknown error", 503, "unknown_error");
        lastError = failure;
        await logAttempt(db, runId, "gemini", model, key.slot, attempt,
          "failed", failure.status, failure.code, failure.message,
          Date.now() - started, failure.retryAfterSeconds);
        if (failure.status === 401 || failure.status === 403) invalidKeys.add(key.slot);
        if (failure.status === 429 && sameOrUnknownProject) skipKey2AfterQuota = true;
        console.warn("Gemini fallback", key.slot, model, failure.status, failure.code);
      }
    }
  }

  const openRouterKey = env.OPENROUTER_API_KEY?.trim();
  if (openRouterKey) {
    const model = env.OPENROUTER_MODEL?.trim() || "openrouter/free";
    const isFree = model === "openrouter/free" || model.endsWith(":free");
    const allowPaid = env.OPENROUTER_ALLOW_PAID?.trim().toLowerCase() === "true";
    if (isFree || allowPaid) {
      attempt++;
      const started = Date.now();
      try {
        const response = await callOpenRouter(
          openRouterKey, model, prompt,
          env.OPENROUTER_SITE_URL, env.OPENROUTER_APP_TITLE || "News for Me"
        );
        const summaries = parseResponse(response.text, expectedIds);
        await logAttempt(db, runId, "openrouter", response.model, "openrouter-key-1",
          attempt, "success", 200, null, null, Date.now() - started, null);
        return { summaries, provider: "openrouter", model: response.model };
      } catch (error) {
        const failure = error instanceof AIProviderError
          ? error
          : new AIProviderError(error instanceof Error ? error.message : "Unknown error", 503, "unknown_error");
        lastError = failure;
        await logAttempt(db, runId, "openrouter", model, "openrouter-key-1",
          attempt, "failed", failure.status, failure.code, failure.message,
          Date.now() - started, failure.retryAfterSeconds);
      }
    } else {
      console.warn("OpenRouter paid model blocked. Set OPENROUTER_ALLOW_PAID=true to enable it explicitly.");
    }
  }

  throw new Error(lastError
    ? `All AI providers failed: ${lastError.code} (${lastError.status})`
    : "No usable AI provider is configured.");
}