import type {
  CollectedNewsItem, NewsSearchInput, NewsSource, NewsSourceSearchResult
} from "../types";
import { matchesTopicRelevance } from "../relevance.ts";

interface NaverNewsItem {
  title?: string;
  originallink?: string;
  link?: string;
  description?: string;
  pubDate?: string;
}
interface NaverNewsResponse {
  items?: NaverNewsItem[];
  total?: number;
  errorMessage?: string;
}

function splitTerms(value: string): string[] {
  return value.split(/[,，;；|]+/)
    .map((term) => term.replace(/["\\\r\n]/g, " ").replace(/\s+/g, " ").trim().slice(0, 80))
    .filter((term) => term.length >= 2);
}

function stripHtml(value: string): string {
  return value
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&#x27;/gi, "'")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/\s+/g, " ")
    .trim();
}

function safeArticleUrl(primary: string | undefined, fallback: string | undefined): URL | null {
  for (const candidate of [primary, fallback]) {
    if (!candidate) continue;
    try {
      const url = new URL(candidate);
      if ((url.protocol === "https:" || url.protocol === "http:") && !url.username && !url.password) {
        return url;
      }
    } catch { /* Try the alternate Naver URL field. */ }
  }
  return null;
}

function buildNaverQueries(input: NewsSearchInput): string[] {
  const terms = [...new Set([
    ...splitTerms(input.topicName),
    ...input.includeKeywords.flatMap(splitTerms)
  ])];
  return terms.slice(0, 5);
}

export async function searchNaverNews(
  input: NewsSearchInput,
  clientId: string,
  clientSecret: string,
  maxResults = input.maxResults ?? 10
): Promise<NewsSourceSearchResult> {
  if (!clientId.trim() || !clientSecret.trim()) {
    throw new Error("Naver News API requires NAVER_CLIENT_ID and NAVER_CLIENT_SECRET.");
  }

  const queries = buildNaverQueries(input);
  if (queries.length === 0) {
    return { items: [], diagnostics: { fetchedCount: 0, acceptedCount: 0, rejected: { emptyQuery: 1 } } };
  }

  const items: CollectedNewsItem[] = [];
  const seen = new Set<string>();
  const rejected: Record<string, number> = {
    missingTitle: 0,
    missingUrl: 0,
    invalidUrl: 0,
    topicMismatch: 0,
    excludedKeyword: 0,
    duplicateAcrossQueries: 0
  };
  let fetchedCount = 0;
  const attempts: string[] = [];
  const excluded = input.excludeKeywords.map((term) => term.toLocaleLowerCase()).filter(Boolean);

  for (const query of queries) {
    if (items.length >= maxResults) break;
    const url = new URL("https://openapi.naver.com/v1/search/news.json");
    url.searchParams.set("query", query);
    url.searchParams.set("display", String(Math.min(100, Math.max(10, maxResults * 3))));
    url.searchParams.set("start", "1");
    url.searchParams.set("sort", "date");

    const response = await fetch(url.toString(), {
      headers: {
        Accept: "application/json",
        "X-Naver-Client-Id": clientId,
        "X-Naver-Client-Secret": clientSecret
      },
      signal: AbortSignal.timeout(12_000)
    });
    if (!response.ok) {
      let detail = "";
      try {
        const payload = await response.json() as NaverNewsResponse;
        detail = payload.errorMessage ?? "";
      } catch { /* Do not include request headers or credentials in diagnostics. */ }
      throw new Error(`Naver News Search API returned HTTP ${response.status}${detail ? `: ${detail.slice(0, 160)}` : ""}`);
    }

    const payload = await response.json() as NaverNewsResponse;
    const rawItems = Array.isArray(payload.items) ? payload.items : [];
    fetchedCount += rawItems.length;
    let acceptedInAttempt = 0;

    for (const raw of rawItems) {
      const title = stripHtml(raw.title ?? "");
      if (!title) {
        rejected.missingTitle += 1;
        continue;
      }

      if (!raw.originallink && !raw.link) {
        rejected.missingUrl += 1;
        continue;
      }
      const articleUrl = safeArticleUrl(raw.originallink, raw.link);
      if (!articleUrl) {
        rejected.invalidUrl += 1;
        continue;
      }

      const description = stripHtml(raw.description ?? "");
      const searchable = `${title} ${description} ${articleUrl.hostname}`.toLocaleLowerCase();
      if (!matchesTopicRelevance(input, searchable)) {
        rejected.topicMismatch += 1;
        continue;
      }
      if (excluded.some((keyword) => searchable.includes(keyword))) {
        rejected.excludedKeyword += 1;
        continue;
      }

      const canonicalUrl = articleUrl.toString();
      if (seen.has(canonicalUrl)) {
        rejected.duplicateAcrossQueries += 1;
        continue;
      }
      seen.add(canonicalUrl);
      const timestamp = raw.pubDate ? Date.parse(raw.pubDate) : Number.NaN;
      items.push({
        title: title.slice(0, 500),
        url: canonicalUrl,
        sourceName: articleUrl.hostname.replace(/^www\./i, "").slice(0, 200),
        publishedAt: Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null,
        excerpt: description.slice(0, 2000) || null,
        provider: "naver-news-api",
        language: "ko"
      });
      acceptedInAttempt += 1;
      if (items.length >= maxResults) break;
    }
    attempts.push(`"${query}": raw=${rawItems.length}, accepted=${acceptedInAttempt}`);
  }

  const rejectedCounts = Object.fromEntries(
    Object.entries(rejected).filter(([, count]) => count > 0)
  );
  return {
    items,
    diagnostics: {
      fetchedCount,
      acceptedCount: items.length,
      rejected: rejectedCounts,
      attempts
    }
  };
}

export function createNaverNewsSource(clientId: string, clientSecret: string): NewsSource {
  return {
    id: "naver-news-api",
    contentType: "article",
    search: (input) => searchNaverNews(input, clientId, clientSecret, input.maxResults ?? 10)
  };
}
