export interface ApiHealthResponse {
  ok: boolean;
  service: "news-for-me-api";
  timestamp: string;
  database: "connected";
}

export interface Topic {
  id: string;
  name: string;
  description: string | null;
  includeKeywords: string[];
  excludeKeywords: string[];
  isActive: boolean;
  lastCollectedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface TopicInput {
  name: string;
  description?: string | null;
  includeKeywords?: string[];
  excludeKeywords?: string[];
}

export interface TopicListResponse { data: Topic[]; }
export interface TopicResponse { data: Topic; }
export interface ApiErrorResponse { error: string; details?: string[]; }
export type CollectionStatus = "queued" | "running" | "completed" | "failed";

export interface NewsArticle {
  id: string;
  title: string;
  canonicalUrl: string;
  sourceName: string | null;
  publishedAt: string | null;
  fetchedAt: string;
  contentExcerpt: string | null;
}

export interface CollectionRun {
  id: string;
  topicId: string;
  status: CollectionStatus;
  articlesFound: number;
  errorMessage: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
}

export interface CollectionStartResponse {
  data: { runId: string; status: "queued"; };
}

export interface CollectionRequest {
  maxArticles?: number;
}
export interface CollectionRunResponse { data: CollectionRun; }
export interface NewsArticleListResponse { data: NewsArticle[]; }

export interface SavedNewsTag {
  id: string;
  name: string;
  color: string;
  createdAt: string;
}

export interface SavedNewsArticle extends NewsArticle {
  savedAt: string;
  note: string | null;
  updatedAt: string;
  tags: SavedNewsTag[];
}