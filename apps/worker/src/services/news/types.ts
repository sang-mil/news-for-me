export type NewsContentType = "article" | "repository" | "discussion" | "video" | "social_post" | "webpage";

export interface CollectedNewsItem {
  title: string;
  url: string;
  sourceName: string | null;
  publishedAt: string | null;
  excerpt: string | null;
  provider: string;
  contentType?: NewsContentType;
  author?: string | null;
  bodyContent?: string | null;
  imageUrl?: string | null;
  language?: string | null;
  externalId?: string | null;
  engagement?: Record<string, number | string | boolean | null>;
  metadata?: Record<string, unknown>;
}

export interface StoredCollectedArticle { articleId: string; item: CollectedNewsItem; }
export interface TopicForCollection { id: string; user_id: string; name: string; description: string | null; include_keywords_json: string; exclude_keywords_json: string; }
export interface NewsSearchInput { topicName: string; includeKeywords: string[]; excludeKeywords: string[]; maxResults?: number; }
export interface SourceSearchDiagnostics {
  fetchedCount: number;
  acceptedCount: number;
  rejected: Record<string, number>;
  attempts?: string[];
}
export interface NewsSourceSearchResult {
  items: CollectedNewsItem[];
  diagnostics?: SourceSearchDiagnostics;
}
export interface NewsSource {
  id: string;
  contentType: NewsContentType;
  search(input: NewsSearchInput): Promise<CollectedNewsItem[] | NewsSourceSearchResult>;
}
export interface CollectionJobMessage { runId: string; topicId: string; userId: string; maxArticles?: number; }
export interface SourceFailure { sourceId: string; message: string; }
export interface CollectionEngineResult {
  items: CollectedNewsItem[];
  failures: SourceFailure[];
  sourceCounts: Record<string, number>;
  sourceDiagnostics: Record<string, SourceSearchDiagnostics | null>;
  mergeDiagnostics: {
    candidateCount: number;
    uniqueCount: number;
    duplicateCount: number;
    invalidUrlCount: number;
  };
}
