export type IntegrationProvider = "gemini" | "openrouter" | "threads" | "x" | "youtube";

export interface IntegrationConfig {
  enabled?: boolean;
  modelPrimary?: string;
  modelFallback?: string;
  model?: string;
  allowPaid?: boolean;
  allowPaidGemini?: boolean;
  projectSlot?: string;
}

export interface IntegrationStatus {
  provider: IntegrationProvider;
  configured: boolean;
  enabled: boolean;
  status: "not_configured" | "saved" | "connected" | "error";
  config: IntegrationConfig;
  lastValidatedAt: string | null;
  platformDefaultAvailable: boolean;
}

export interface IntegrationCredentials {
  secret: string;
}

interface IntegrationRow {
  provider: IntegrationProvider;
  credentials_encrypted: string | null;
  config_json: string;
  status: IntegrationStatus["status"];
  last_validated_at: string | null;
}

const PROVIDERS: IntegrationProvider[] = ["gemini", "openrouter", "threads", "x", "youtube"];

export function isIntegrationProvider(value: string): value is IntegrationProvider {
  return PROVIDERS.includes(value as IntegrationProvider);
}

function decodeBase64(value: string): Uint8Array {
  const normalized = value.trim().replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(normalized);
  const result = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) result[index] = binary.charCodeAt(index);
  return result;
}

function encodeBase64(value: Uint8Array): string {
  let binary = "";
  for (let index = 0; index < value.length; index += 1) binary += String.fromCharCode(value[index]);
  return btoa(binary);
}

async function importEncryptionKey(value: string): Promise<CryptoKey> {
  let raw: Uint8Array;
  try {
    raw = decodeBase64(value);
  } catch {
    throw new Error("INTEGRATION_ENCRYPTION_KEY must be a Base64-encoded 32-byte key.");
  }
  if (raw.byteLength !== 32) {
    throw new Error("INTEGRATION_ENCRYPTION_KEY must decode to exactly 32 bytes.");
  }
  return crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

export async function encryptIntegrationCredentials(
  credentials: IntegrationCredentials,
  encryptionKey: string,
  context: string
): Promise<string> {
  const key = await importEncryptionKey(encryptionKey);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = new TextEncoder().encode(JSON.stringify(credentials));
  const additionalData = new TextEncoder().encode(context);
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData }, key, plaintext);
  const combined = new Uint8Array(iv.byteLength + ciphertext.byteLength);
  combined.set(iv, 0);
  combined.set(new Uint8Array(ciphertext), iv.byteLength);
  return encodeBase64(combined);
}

export async function decryptIntegrationCredentials(
  encrypted: string,
  encryptionKey: string,
  context: string
): Promise<IntegrationCredentials> {
  const key = await importEncryptionKey(encryptionKey);
  const combined = decodeBase64(encrypted);
  if (combined.byteLength <= 12) throw new Error("Stored integration credential is invalid.");
  const iv = combined.slice(0, 12);
  const ciphertext = combined.slice(12);
  const additionalData = new TextEncoder().encode(context);
  const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv, additionalData }, key, ciphertext);
  const value: unknown = JSON.parse(new TextDecoder().decode(plaintext));
  if (typeof value !== "object" || value === null || typeof (value as { secret?: unknown }).secret !== "string") {
    throw new Error("Stored integration credential has an invalid format.");
  }
  return value as IntegrationCredentials;
}

function parseConfig(value: string): IntegrationConfig {
  try {
    const parsed: unknown = JSON.parse(value);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) return parsed as IntegrationConfig;
  } catch {
    // A malformed preference must not prevent a user's other integrations from loading.
  }
  return {};
}

export async function getUserIntegration(
  db: D1Database,
  userId: string,
  provider: IntegrationProvider,
  encryptionKey: string
): Promise<{ credentials: IntegrationCredentials; config: IntegrationConfig } | null> {
  const row = await db.prepare(
    "SELECT credentials_encrypted, config_json FROM user_integrations WHERE user_id = ? AND provider = ? LIMIT 1"
  ).bind(userId, provider).first<{ credentials_encrypted: string | null; config_json: string }>();
  if (!row) return null;
  if (!row.credentials_encrypted) throw new Error("Integration is configured without encrypted credentials.");
  const credentials = await decryptIntegrationCredentials(
    row.credentials_encrypted, encryptionKey, "news-for-me:user-integration:" + userId + ":" + provider
  );
  return { credentials, config: parseConfig(row.config_json) };
}

export async function listUserIntegrationStatuses(
  db: D1Database,
  userId: string,
  platformDefaults: Record<IntegrationProvider, boolean>
): Promise<IntegrationStatus[]> {
  const result = await db.prepare(
    "SELECT provider, credentials_encrypted, config_json, status, last_validated_at " +
    "FROM user_integrations WHERE user_id = ?"
  ).bind(userId).all<IntegrationRow>();
  const rows = new Map((result.results ?? []).map((row) => [row.provider, row]));
  return PROVIDERS.map((provider) => {
    const row = rows.get(provider);
    const config = row ? parseConfig(row.config_json) : {};
    const configured = Boolean(row?.credentials_encrypted);
    return {
      provider,
      configured,
      enabled: config.enabled !== false,
      status: row?.status ?? "not_configured",
      config,
      lastValidatedAt: row?.last_validated_at ?? null,
      platformDefaultAvailable: platformDefaults[provider]
    };
  });
}

export async function saveUserIntegration(
  db: D1Database,
  userId: string,
  provider: IntegrationProvider,
  encryptionKey: string,
  secret: string | null,
  config: IntegrationConfig
): Promise<void> {
  const existing = await db.prepare(
    "SELECT credentials_encrypted FROM user_integrations WHERE user_id = ? AND provider = ? LIMIT 1"
  ).bind(userId, provider).first<{ credentials_encrypted: string | null }>();
  const trimmedSecret = secret?.trim() ?? "";
  if (!trimmedSecret && !existing?.credentials_encrypted) {
    throw new Error("API 키 또는 토큰을 입력하세요.");
  }
  const encrypted = trimmedSecret
    ? await encryptIntegrationCredentials(
        { secret: trimmedSecret }, encryptionKey, "news-for-me:user-integration:" + userId + ":" + provider
      )
    : existing?.credentials_encrypted ?? null;
  const safeConfig: IntegrationConfig = {
    enabled: config.enabled !== false,
    ...(config.modelPrimary ? { modelPrimary: config.modelPrimary.slice(0, 120) } : {}),
    ...(config.modelFallback ? { modelFallback: config.modelFallback.slice(0, 120) } : {}),
    ...(config.model ? { model: config.model.slice(0, 160) } : {}),
    ...(typeof config.allowPaid === "boolean" ? { allowPaid: config.allowPaid } : {}),
    ...(typeof config.allowPaidGemini === "boolean" ? { allowPaidGemini: config.allowPaidGemini } : {}),
    ...(config.projectSlot ? { projectSlot: config.projectSlot.slice(0, 120) } : {})
  };
  await db.prepare(
    "INSERT INTO user_integrations (user_id, provider, credentials_encrypted, config_json, status) " +
    "VALUES (?, ?, ?, ?, 'saved') " +
    "ON CONFLICT(user_id, provider) DO UPDATE SET " +
    "credentials_encrypted = excluded.credentials_encrypted, config_json = excluded.config_json, " +
    "status = 'saved', last_validated_at = NULL, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')"
  ).bind(userId, provider, encrypted, JSON.stringify(safeConfig)).run();
}

export async function removeUserIntegration(
  db: D1Database,
  userId: string,
  provider: IntegrationProvider
): Promise<void> {
  await db.prepare("DELETE FROM user_integrations WHERE user_id = ? AND provider = ?")
    .bind(userId, provider).run();
}

export async function updateUserIntegrationTestStatus(
  db: D1Database,
  userId: string,
  provider: IntegrationProvider,
  status: "connected" | "error"
): Promise<void> {
  await db.prepare(
    "UPDATE user_integrations SET status = ?, last_validated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), " +
    "updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE user_id = ? AND provider = ?"
  ).bind(status, userId, provider).run();
}

export async function resolveUserIntegrationSecret(
  db: D1Database,
  userId: string,
  provider: IntegrationProvider,
  encryptionKey: string
): Promise<{ secret: string; config: IntegrationConfig } | null> {
  const value = await getUserIntegration(db, userId, provider, encryptionKey);
  if (!value || value.config.enabled === false) return null;
  return { secret: value.credentials.secret, config: value.config };
}

export async function testIntegrationCredential(
  provider: IntegrationProvider,
  secret: string
): Promise<void> {
  const headers: Record<string, string> = { Accept: "application/json" };
  let url = "";

  if (provider === "gemini") {
    url = "https://generativelanguage.googleapis.com/v1beta/models?pageSize=1";
    headers["x-goog-api-key"] = secret;
  } else if (provider === "openrouter") {
    // The model catalog is public; this endpoint verifies the supplied key.
    url = "https://openrouter.ai/api/v1/key";
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
  if (!response.ok) {
    throw new Error("연결 실패 (HTTP " + response.status + "). 키와 API 권한을 확인하세요.");
  }
}
