import type {
  ApiHealthResponse,
  CollectionRun,
  CollectionStartResponse,
  NewsArticle,
  SavedNewsArticle,
  SavedNewsTag,
  Topic,
  TopicInput,
  TopicListResponse,
  TopicResponse,
  InterestProfile
} from "@news-for-me/shared";

const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL ?? "").replace(/\/$/, "");

interface ErrorPayload { error?: string; details?: string[]; }

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  headers.set("Accept", "application/json");
  if (init?.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  const response = await fetch(`${API_BASE_URL}${path}`, {
    ...init,
    headers,
    credentials: "same-origin"
  });
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const errorPayload = payload as ErrorPayload | null;
    const detail = errorPayload?.details?.join(" ");
    console.error("[NewsForMe][API] request failed", {
      path,
      method: init?.method ?? "GET",
      status: response.status,
      statusText: response.statusText,
      error: errorPayload?.error ?? null,
      details: errorPayload?.details ?? null,
      observedAt: new Date().toISOString()
    });
    throw new Error([errorPayload?.error ?? `Request failed (${response.status})`, detail].filter(Boolean).join(" "));
  }
  return payload as T;
}

export interface CurrentUserResponse {
  authenticated: boolean;
  isDevelopment: boolean;
  user: { id: string; email: string; name: string } | null;
}

export async function getCurrentUser(): Promise<CurrentUserResponse> {
  return request<CurrentUserResponse>("/api/me");
}

export async function getApiHealth(): Promise<ApiHealthResponse> {
  return request<ApiHealthResponse>("/api/health");
}
export async function listTopics(page=1,limit=5): Promise<TopicListResponse> {
  return request<TopicListResponse>(`/api/topics?page=${page}&limit=${limit}`);
}
export async function createTopic(input: TopicInput): Promise<Topic> {
  const response = await request<TopicResponse>("/api/topics", { method: "POST", body: JSON.stringify(input) });
  return response.data;
}
export async function updateTopic(id: string, input: Partial<TopicInput>): Promise<Topic> {
  const response = await request<TopicResponse>(`/api/topics/${encodeURIComponent(id)}`, {
    method: "PATCH", body: JSON.stringify(input)
  });
  return response.data;
}
export async function deleteTopic(id: string): Promise<void> {
  await request<{ ok: boolean }>(`/api/topics/${encodeURIComponent(id)}`, { method: "DELETE" });
}
export async function collectTopic(id: string, maxArticles = 10): Promise<string> {
  const response = await request<CollectionStartResponse>(`/api/topics/${encodeURIComponent(id)}/collect`, {
    method: "POST", body: JSON.stringify({ maxArticles })
  });
  return response.data.runId;
}
export async function getCollectionRun(topicId: string, runId: string): Promise<CollectionRun> {
  const response = await request<{ data: CollectionRun }>(
    `/api/topics/${encodeURIComponent(topicId)}/collection-runs/${encodeURIComponent(runId)}`
  );
  return response.data;
}
export async function clearTopicArticles(topicId: string): Promise<void> {
  await request<{ ok: boolean }>(
    `/api/topics/${encodeURIComponent(topicId)}/articles/clear`,
    { method: "POST", body: "{}" }
  );
}
export function articleOpenUrl(articleId: string, topicId?: string): string {
  const query = topicId ? `?topicId=${encodeURIComponent(topicId)}` : "";
  return `/api/articles/${encodeURIComponent(articleId)}/open${query}`;
}
export async function getInterestProfile(): Promise<InterestProfile> {
  const response = await request<{ data: InterestProfile }>("/api/interest-profile");
  return response.data;
}
export async function refreshInterestProfile(): Promise<InterestProfile> {
  const response = await request<{ data: InterestProfile }>("/api/interest-profile/refresh", {
    method: "POST",
    body: "{}"
  });
  return response.data;
}
export async function listTopicArticles(topicId: string, limit = 20): Promise<NewsArticle[]> {
  const response = await request<{ data: NewsArticle[] }>(
    `/api/topics/${encodeURIComponent(topicId)}/articles?limit=${limit}`
  );
  return response.data;
}
export async function listScraps(limit = 100): Promise<SavedNewsArticle[]> {
  const response = await request<{ data: SavedNewsArticle[] }>(`/api/scraps?limit=${limit}`);
  return response.data;
}
export async function saveArticle(topicId: string, articleId: string): Promise<SavedNewsArticle> {
  const response = await request<{ data: SavedNewsArticle }>(
    `/api/topics/${encodeURIComponent(topicId)}/articles/${encodeURIComponent(articleId)}/scrap`,
    { method: "POST" }
  );
  return response.data;
}
export async function unsaveArticle(articleId: string): Promise<void> {
  await request<{ ok: boolean }>(`/api/scraps/${encodeURIComponent(articleId)}`, { method: "DELETE" });
}
export async function listTags(): Promise<SavedNewsTag[]> {
  const response = await request<{ data: SavedNewsTag[] }>("/api/tags");
  return response.data;
}
export async function createTag(name: string, color: string): Promise<SavedNewsTag> {
  const response = await request<{ data: SavedNewsTag }>("/api/tags", {
    method: "POST", body: JSON.stringify({ name, color })
  });
  return response.data;
}
export async function updateTag(tagId: string, input: { name?: string; color?: string }): Promise<SavedNewsTag> {
  const response = await request<{ data: SavedNewsTag }>(`/api/tags/${encodeURIComponent(tagId)}`, {
    method: "PATCH", body: JSON.stringify(input)
  });
  return response.data;
}
export async function deleteTag(tagId: string): Promise<void> {
  await request<{ ok: boolean }>(`/api/tags/${encodeURIComponent(tagId)}`, { method: "DELETE" });
}
export async function updateScrapNote(articleId: string, note: string): Promise<SavedNewsArticle> {
  const response = await request<{ data: SavedNewsArticle }>(`/api/scraps/${encodeURIComponent(articleId)}/note`, {
    method: "PATCH", body: JSON.stringify({ note })
  });
  return response.data;
}
export async function replaceScrapTags(articleId: string, tagIds: string[]): Promise<SavedNewsArticle> {
  const response = await request<{ data: SavedNewsArticle }>(`/api/scraps/${encodeURIComponent(articleId)}/tags`, {
    method: "PUT", body: JSON.stringify({ tagIds })
  });
  return response.data;
}

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
export interface GeminiModelOption {
  id: string;
  displayName: string;
  isFreeTier: boolean;
  inputTokenLimit?: number;
  outputTokenLimit?: number;
}

export async function getGeminiModels(): Promise<GeminiModelOption[]> {
  const response = await request<{ data: GeminiModelOption[] }>("/api/integrations/gemini/models");
  return response.data;
}

export async function listIntegrations(): Promise<IntegrationStatus[]> {
  const response = await request<{ data: IntegrationStatus[] }>("/api/integrations");
  return response.data;
}
export async function saveIntegration(
  provider: IntegrationProvider,
  credential: string,
  config: IntegrationConfig
): Promise<IntegrationStatus> {
  const response = await request<{ data: IntegrationStatus }>("/api/integrations/" + provider, {
    method: "PUT",
    body: JSON.stringify({ credential, config })
  });
  return response.data;
}
export async function testIntegration(provider: IntegrationProvider): Promise<void> {
  await request<{ data: { ok: boolean } }>("/api/integrations/" + provider + "/test", { method: "POST", body: "{}" });
}

export interface NewsletterPreview {
  subject: string;
  html: string;
  text: string;
  articleCount: number;
  periodDays: number;
  generatedAt: string;
}
export interface NewsletterSendResult {
  ok: boolean;
  deliveryId: string;
  recipient: string;
  messageId: string | null;
  articleCount: number;
}
export async function getNewsletterPreview(): Promise<NewsletterPreview> {
  const response = await request<{ data: NewsletterPreview }>("/api/newsletter/preview");
  return response.data;
}
export async function sendNewsletterNow(recipient: string): Promise<NewsletterSendResult> {
  const response = await request<{ data: NewsletterSendResult }>("/api/newsletter/send-test", {
    method: "POST",
    body: JSON.stringify({ confirm: true, recipient })
  });
  return response.data;
}

export async function removeIntegration(provider: IntegrationProvider): Promise<void> {
  await request<{ ok: boolean }>("/api/integrations/" + provider, { method: "DELETE" });
}


export type NewsletterScheduleStatus = "scheduled" | "sending" | "sent" | "failed" | "cancelled";
export interface NewsletterSchedule {
  id: string;
  recipientEmail: string;
  scheduledAt: string;
  status: NewsletterScheduleStatus;
  createdAt: string;
  sentAt: string | null;
  errorMessage: string | null;
}
export interface NewsletterScheduleCreateResult {
  id: string;
  recipientEmail: string;
  scheduledAt: string;
  status: "scheduled";
}
export async function listNewsletterSchedules(): Promise<NewsletterSchedule[]> {
  const response = await request<{ data: NewsletterSchedule[] }>("/api/newsletter/schedules");
  return response.data;
}
export async function scheduleNewsletter(
  recipient: string,
  scheduledAt: string
): Promise<NewsletterScheduleCreateResult> {
  const response = await request<{ data: NewsletterScheduleCreateResult }>("/api/newsletter/schedules", {
    method: "POST",
    body: JSON.stringify({ confirm: true, recipient, scheduledAt })
  });
  return response.data;
}
export async function cancelNewsletterSchedule(id: string): Promise<void> {
  await request<{ data: { ok: boolean; id: string } }>(
    `/api/newsletter/schedules/${encodeURIComponent(id)}`,
    { method: "DELETE" }
  );
}
