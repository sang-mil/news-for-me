export interface GeminiModelOption {
  id: string;
  displayName: string;
  isFreeTier: boolean;
  inputTokenLimit?: number;
  outputTokenLimit?: number;
}

interface GeminiModelApiItem {
  name?: unknown;
  displayName?: unknown;
  supportedGenerationMethods?: unknown;
  inputTokenLimit?: unknown;
  outputTokenLimit?: unknown;
}

interface GeminiModelListResponse {
  models?: unknown;
  nextPageToken?: unknown;
  error?: { message?: unknown; status?: unknown };
}

export class GeminiModelCatalogError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code: string
  ) {
    super(message);
    this.name = "GeminiModelCatalogError";
  }
}

// Google's model catalog does not expose account pricing metadata. Keep this
// conservative allowlist in sync with the official Gemini API pricing page.
export const FREE_TIER_GEMINI_MODEL_IDS = [
  "gemini-3.8-flash",
  "gemini-3.5-flash",
  "gemini-3.5-flash-lite",
  "gemini-3.1-flash-lite",
  "gemini-2.5-flash",
  "gemini-2.5-flash-lite"
] as const;

const FREE_MODEL_SET = new Set<string>(FREE_TIER_GEMINI_MODEL_IDS);
const EXCLUDED_MODEL_PATTERN = /(embedding|tts|image|audio|live|transcri|veo|imagen|lyria|robotics|computer-use)/i;

function positiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? value
    : undefined;
}

export function parseGeminiModelCatalog(value: unknown): GeminiModelOption[] {
  if (typeof value !== "object" || value === null || !("models" in value)) return [];
  const rawModels = (value as GeminiModelListResponse).models;
  if (!Array.isArray(rawModels)) return [];

  const models = new Map<string, GeminiModelOption>();
  for (const raw of rawModels) {
    if (typeof raw !== "object" || raw === null) continue;
    const item = raw as GeminiModelApiItem;
    if (typeof item.name !== "string") continue;

    const id = item.name.replace(/^models\//, "").trim();
    if (!/^(gemini|gemma)-[a-z0-9][a-z0-9._-]*$/i.test(id)) continue;
    if (EXCLUDED_MODEL_PATTERN.test(id)) continue;
    if (!Array.isArray(item.supportedGenerationMethods) ||
        !item.supportedGenerationMethods.includes("generateContent")) continue;

    models.set(id, {
      id,
      displayName: typeof item.displayName === "string" && item.displayName.trim()
        ? item.displayName.trim()
        : id,
      isFreeTier: FREE_MODEL_SET.has(id),
      ...(positiveInteger(item.inputTokenLimit) ? { inputTokenLimit: positiveInteger(item.inputTokenLimit) } : {}),
      ...(positiveInteger(item.outputTokenLimit) ? { outputTokenLimit: positiveInteger(item.outputTokenLimit) } : {})
    });
  }

  return [...models.values()].sort((a, b) => a.id.localeCompare(b.id));
}

export async function listGeminiModels(apiKey: string): Promise<GeminiModelOption[]> {
  const models = new Map<string, GeminiModelOption>();
  let pageToken: string | undefined;

  for (let page = 0; page < 5; page += 1) {
    const url = new URL("https://generativelanguage.googleapis.com/v1beta/models");
    url.searchParams.set("pageSize", "1000");
    if (pageToken) url.searchParams.set("pageToken", pageToken);

    let response: Response;
    try {
      response = await fetch(url.toString(), {
        method: "GET",
        headers: { Accept: "application/json", "x-goog-api-key": apiKey },
        signal: AbortSignal.timeout(12000)
      });
    } catch (error) {
      throw new GeminiModelCatalogError(
        error instanceof Error ? error.message : "Gemini model catalog network error",
        503,
        "network_error"
      );
    }

    const payload = await response.json().catch(() => null) as GeminiModelListResponse | null;
    if (!response.ok) {
      throw new GeminiModelCatalogError(
        (typeof payload?.error?.message === "string"
          ? payload.error.message
          : `Gemini model catalog HTTP ${response.status}`).slice(0, 700),
        response.status,
        typeof payload?.error?.status === "string" ? payload.error.status : `http_${response.status}`
      );
    }

    for (const model of parseGeminiModelCatalog(payload)) models.set(model.id, model);

    pageToken = typeof payload?.nextPageToken === "string" && payload.nextPageToken
      ? payload.nextPageToken
      : undefined;
    if (!pageToken) break;
  }

  return [...models.values()].sort((a, b) => a.id.localeCompare(b.id));
}

export function resolveGeminiModelOrder(
  availableModels: GeminiModelOption[],
  preferredModel: string | undefined,
  legacyFallbackModel: string | undefined,
  allowPaidModels: boolean
): string[] {
  const eligible = availableModels.filter((model) => allowPaidModels || model.isFreeTier);
  const eligibleIds = new Set(eligible.map((model) => model.id));
  const ordered = [
    preferredModel?.trim(),
    legacyFallbackModel?.trim(),
    ...eligible.map((model) => model.id)
  ].filter((model): model is string => Boolean(model && eligibleIds.has(model)));

  // If discovery is unavailable or the API returns an empty catalog, keep a
  // small, known-free fallback set so a transient catalog issue does not stop summaries.
  if (ordered.length === 0 && !allowPaidModels) {
    return [...FREE_TIER_GEMINI_MODEL_IDS];
  }
  return [...new Set(ordered)];
}
