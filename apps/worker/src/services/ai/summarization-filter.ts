export interface ArticleForSummarization {
  articleId: string;
  item: { provider: string };
}

export function selectSummarizableArticles<T extends ArticleForSummarization>(
  storedArticles: T[]
): T[] {
  const unique = new Map<string, T>();
  for (const article of storedArticles) {
    if (article.item.provider !== "youtube-data-api") {
      unique.set(article.articleId, article);
    }
  }
  return [...unique.values()];
}
