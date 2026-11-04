import { jsonResponse } from "../lib/http";
import {
  getUserIntegration,
  isIntegrationProvider,
  listUserIntegrationStatuses,
  removeUserIntegration,
  saveUserIntegration,
  updateUserIntegrationTestStatus,
  type IntegrationConfig,
  type IntegrationProvider
} from "../services/integrations";

interface IntegrationRouteEnvironment {
  DB: D1Database;
  INTEGRATION_ENCRYPTION_KEY?: string;
  GEMINI_API_KEY_1?: string;
  GEMINI_API_KEY_2?: string;
  OPENROUTER_API_KEY?: string;
  THREADS_ACCESS_TOKEN?: string;
  X_BEARER_TOKEN?: string;
  YOUTUBE_API_KEY?: string;
}

function platformDefaults(env: IntegrationRouteEnvironment): Record<IntegrationProvider, boolean> {
  return {
    gemini: Boolean(env.GEMINI_API_KEY_1?.trim() || env.GEMINI_API_KEY_2?.trim()),
    openrouter: Boolean(env.OPENROUTER_API_KEY?.trim()),
    threads: Boolean(env.THREADS_ACCESS_TOKEN?.trim()),
    x: Boolean(env.X_BEARER_TOKEN?.trim()),
    youtube: Boolean(env.YOUTUBE_API_KEY?.trim())
  };
}

function parseConfig(value: unknown): IntegrationConfig {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  const input = value as Record<string, unknown>;
  return {
    enabled: input.enabled !== false,
    ...(typeof input.modelPrimary === "string" ? { modelPrimary: input.modelPrimary.trim() } : {}),
    ...(typeof input.modelFallback === "string" ? { modelFallback: input.modelFallback.trim() } : {}),
    ...(typeof input.model === "string" ? { model: input.model.trim() } : {}),
    ...(typeof input.allowPaid === "boolean" ? { allowPaid: input.allowPaid } : {}),
    ...(typeof input.projectSlot === "string" ? { projectSlot: input.projectSlot.trim() } : {})
  };
}

function credentialLabel(provider: IntegrationProvider): string {
  if (provider === "threads") return "accessToken";
  if (provider === "x") return "bearerToken";
  if (provider === "youtube") return "apiKey";
  return "apiKey";
}

function credentialValue(provider: IntegrationProvider, input: Record<string, unknown>): string | null {
  const field = credentialLabel(provider);
  const value = input.credential ?? input[field];
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || value.length > 8192) {
    throw new Error("인증 정보는 8,192자 이하의 문자열이어야 합니다.");
  }
  return value.trim();
}

async function readResponseOk(response: Response): Promise<void> {
  if (!response.ok) throw new Error("연결 실패 (HTTP " + response.status + "). 키와 API 권한을 확인하세요.");
}

async function testCredential(
  provider: IntegrationProvider,
  secret: string
): Promise<void> {
  const headers: Record<string, string> = { Accept: "application/json" };
  let url = "";

  if (provider === "gemini") {
    url = "https://generativelanguage.googleapis.com/v1beta/models?pageSize=1";
    headers["x-goog-api-key"] = secret;
  } else if (provider === "openrouter") {
    url = "https://openrouter.ai/api/v1/models";
    headers.Authorization = "Bearer " + secret;
  } else if (provider === "threads") {
    url = "https://graph.threads.net/v1.0/keyword_search?q=news&search_type=RECENT&search_mode=KEYWORD&limit=10&fields=id";
    headers.Authorization = "Bearer " + secret;
  } else if (provider === "x") {
    const query = new URLSearchParams({ query: "from:twitterapi -is:retweet", max_results: "10" });
    url = "https://api.x.com/2/tweets/search/recent?" + query.toString();
    headers.Authorization = "Bearer " + secret;
  } else {
    const query = new URLSearchParams({ part: "id", id: "dQw4w9WgXcQ", key: secret });
    url = "https://www.googleapis.com/youtube/v3/videos?" + query.toString();
  }

  let response: Response;
  try {
    response = await fetch(url, { headers, signal: AbortSignal.timeout(12000) });
  } catch {
    throw new Error("외부 서비스에 연결하지 못했습니다. 잠시 후 다시 시도하세요.");
  }
  await readResponseOk(response);
}

export async function handleIntegrationsRequest(
  request: Request,
  env: IntegrationRouteEnvironment,
  userId: string,
  allowedOrigin: string
): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "");
  if (path === "/api/integrations" && request.method === "GET") {
    const data = await listUserIntegrationStatuses(env.DB, userId, platformDefaults(env));
    return jsonResponse({ data }, 200, allowedOrigin);
  }

  const match = path.match(/^\/api\/integrations\/([^/]+)(?:\/(test))?$/);
  if (!match) return jsonResponse({ error: "Not Found" }, 404, allowedOrigin);

  let providerName: string;
  try {
    providerName = decodeURIComponent(match[1]);
  } catch {
    return jsonResponse({ error: "잘못된 연동 제공자입니다." }, 400, allowedOrigin);
  }
  if (!isIntegrationProvider(providerName)) {
    return jsonResponse({ error: "지원하지 않는 연동 제공자입니다." }, 404, allowedOrigin);
  }
  const provider = providerName;
  const isTest = match[2] === "test";

  if (request.method === "DELETE" && !isTest) {
    await removeUserIntegration(env.DB, userId, provider);
    return jsonResponse({ ok: true }, 200, allowedOrigin);
  }

  if (request.method !== "PUT" && !(request.method === "POST" && isTest)) {
    return jsonResponse({ error: "Method not allowed." }, 405, allowedOrigin);
  }

  if (!env.INTEGRATION_ENCRYPTION_KEY?.trim()) {
    return jsonResponse(
      { error: "서버 암호화 키가 설정되지 않았습니다. 관리자에게 INTEGRATION_ENCRYPTION_KEY 설정을 요청하세요." },
      503,
      allowedOrigin
    );
  }

  if (request.method === "PUT") {
    const input = await request.json().catch(() => null) as Record<string, unknown> | null;
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      return jsonResponse({ error: "요청 본문이 올바르지 않습니다." }, 400, allowedOrigin);
    }
    try {
      const config = parseConfig(input.config);
      const credential = credentialValue(provider, input);
      await saveUserIntegration(
        env.DB, userId, provider, env.INTEGRATION_ENCRYPTION_KEY, credential, config
      );
      const data = await listUserIntegrationStatuses(env.DB, userId, platformDefaults(env));
      return jsonResponse({ data: data.find((item) => item.provider === provider) }, 200, allowedOrigin);
    } catch (error) {
      return jsonResponse(
        { error: error instanceof Error ? error.message : "연동 정보를 저장하지 못했습니다." },
        400,
        allowedOrigin
      );
    }
  }

  try {
    const integration = await getUserIntegration(
      env.DB, userId, provider, env.INTEGRATION_ENCRYPTION_KEY
    );
    const secret = integration?.credentials.secret;
    if (!secret) return jsonResponse({ error: "먼저 이 서비스의 API 키 또는 토큰을 저장하세요." }, 400, allowedOrigin);
    if (integration.config.enabled === false) {
      return jsonResponse({ error: "비활성화된 연동입니다. 먼저 사용 설정을 켜세요." }, 400, allowedOrigin);
    }
    await testCredential(provider, secret);
    await updateUserIntegrationTestStatus(env.DB, userId, provider, "connected");
    return jsonResponse({ data: { ok: true, provider, message: "연결이 확인되었습니다." } }, 200, allowedOrigin);
  } catch (error) {
    await updateUserIntegrationTestStatus(env.DB, userId, provider, "error");
    const message = error instanceof Error ? error.message : "연결 테스트에 실패했습니다.";
    return jsonResponse({ error: message }, 502, allowedOrigin);
  }
}
