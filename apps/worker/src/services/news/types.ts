export interface TopicForCollection {
  id: string;
  user_id: string;
  name: string;
  description: string | null;
  include_keywords_json: string;
  exclude_keywords_json: string;
}

export interface CollectedNewsItem {
  title: string;
  url: string;
  sourceName: string | null;
  publishedAt: string | null;
  excerpt: string | null;
  provider: string;
}

export interface StoredCollectedArticle {
  articleId: string;
  item: CollectedNewsItem;
}

export interface NewsSearchInput {
  topicName: string;
  includeKeywords: string[];
  excludeKeywords: string[];
  maxResults?: number;
}

export interface NewsSource {
  id: string;
  search(input: NewsSearchInput): Promise<CollectedNewsItem[]>;
}

export interface CollectionJobMessage {
  runId: string;
  topicId: string;
  userId: string;
  maxArticles?: number;
}