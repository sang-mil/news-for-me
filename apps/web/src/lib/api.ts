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
  TopicResponse
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
export async function listTopics(): Promise<Topic[]> {
  const response = await request<TopicListResponse>("/api/topics");
  return response.data;
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
export async function collectTopic(id: string): Promise<string> {
  const response = await request<CollectionStartResponse>(`/api/topics/${encodeURIComponent(id)}/collect`, { method: "POST" });
  return response.data.runId;
}
export async function getCollectionRun(topicId: string, runId: string): Promise<CollectionRun> {
  const response = await request<{ data: CollectionRun }>(
    `/api/topics/${encodeURIComponent(topicId)}/collection-runs/${encodeURIComponent(runId)}`
  );
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