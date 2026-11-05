import type {
  CollectedNewsItem, NewsSearchInput, NewsSource, NewsSourceSearchResult
} from "../types";
import { matchesTopicRelevance } from "../relevance.ts";

interface GdeltArticle {
  url?: string;
  title?: string;
  seendate?: string;
  domain?: string;
  language?: string;
  sourcecountry?: string;
  socialimage?: string;
}
interface GdeltResponse {
  articles?: GdeltArticle[];
}

function splitTerms(value: string): string[] {
  return value.split(/[,，;；|]+/)
    .map((term) => term.replace(/["\\\r\n]/g, " ").replace(/\s+/g, " ").trim().slice(0, 80))
    .filter((term) => term.length >= 2);
}

function buildQuery(terms: string[], excluded: string[]): string {
  const positive = terms.length > 1
    ? `(${terms.map((term) => `"${term}"`).join(" OR ")})`
    : `"${terms[0] ?? ""}"`;
  const negatives = excluded.slice(0, 5).map((term) => `-"${term}"`);
  return [positive, ...negatives].filter(Boolean).join(" ");
}

export function buildGdeltQueries(input: NewsSearchInput): string[] {
  const topicTerms = [...new Set(splitTerms(input.topicName))];
  const includeTerms = [...new Set(input.includeKeywords.flatMap(splitTerms))];
  const allTerms = [...new Set([...topicTerms, ...includeTerms])].slice(0, 8);
  const excluded = [...new Set(input.excludeKeywords.flatMap(splitTerms))];
  const candidates = [
    buildQuery(allTerms, excluded),
    buildQuery(topicTerms, excluded)
  ].filter((query) => query !== '"" sourcelang:Korean');
  return [...new Set(candidates)];
}

function parseGdeltDate(value: string | undefined): string | null {
  if (!value) return null;
  const compact = value.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z?$/);
  const normalized = compact
    ? `${compact[1]}-${compact[2]}-${compact[3]}T${compact[4]}:${compact[5]}:${compact[6]}Z`
    : value;
  const timestamp = Date.parse(normalized);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

function safeArticleUrl(value: string | undefined): URL | null {
  try {
    const url = new URL(value ?? "");
    if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username || url.password) return null;
    return url;
  } catch { return null; }
}

interface GdeltAttempt {
  queryVariant: "topic-and-keywords" | "topic-only";
  rawCount: number;
  acceptedCount: number;
  rejected: Record<string, number>;
  titleNotMatched: number;
}

async function fetchGdeltQuery(
  query: string,
  queryVariant: GdeltAttempt["queryVariant"],
  input: NewsSearchInput,
  maxResults: number
): Promise<{ items: CollectedNewsItem[]; attempt: GdeltAttempt }> {
  const url = new URL("https://api.gdeltproject.org/api/v2/doc/doc");
  url.searchParams.set("query", query);
  url.searchParams.set("mode", "ArtList");
  url.searchParams.set("format", "json");
  url.searchParams.set("maxrecords", String(Math.min(250, Math.max(10, maxResults * 3))));
  url.searchParams.set("timespan", "7d");
  url.searchParams.set("sort", "HybridRel");

  const response = await fetch(url.toString(), {
    headers: {
      Accept: "application/json",
      "User-Agent": "NewsForMe/0.2 (+https://news-for-me.pages.dev)"
    },
    signal: AbortSignal.timeout(12_000)
  });
  const contentType = response.headers.get("content-type") ?? "unknown";
  const body = await response.text();
  if (!response.ok) {
    throw new Error(`GDELT DOC API returned HTTP ${response.status}; content-type=${contentType}; body=${body.replace(/\s+/g, " ").slice(0, 180)}`);
  }
  if (body.length > 2_000_000) throw new Error("GDELT response exceeded the 2 MB safety limit.");
  if (!contentType.includes("json") && !body.trim().startsWith("{")) {
    throw new Error(`GDELT DOC API returned a non-JSON response; content-type=${contentType}; body=${body.replace(/\s+/g, " ").slice(0, 180)}`);
  }

  let payload: GdeltResponse;
  try {
    payload = JSON.parse(body) as GdeltResponse;
  } catch {
    throw new Error("GDELT DOC API returned malformed JSON.");
  }
  if (!Array.isArray(payload.articles)) {
    throw new Error("GDELT DOC API response did not contain an articles array.");
  }

  const rejected: Record<string, number> = {
    missingTitle: 0,
    missingUrl: 0,
    invalidUrl: 0,
    excludedKeyword: 0
  };
  let titleNotMatched = 0;
  const excluded = input.excludeKeywords.map((term) => term.toLocaleLowerCase()).filter(Boolean);
  const items: CollectedNewsItem[] = [];

  for (const article of payload.articles) {
    const title = article.title?.trim() ?? "";
    if (!title) {
      rejected.missingTitle += 1;
      continue;
    }
    if (!article.url?.trim()) {
      rejected.missingUrl += 1;
      continue;
    }
    const articleUrl = safeArticleUrl(article.url);
    if (!articleUrl) {
      rejected.invalidUrl += 1;
      continue;
    }
    const searchable = `${title} ${article.domain ?? ""}`.toLocaleLowerCase();
    // GDELT searches article text, not just the headline. Keep a valid provider match
    // even when the keyword appears only in the article body.
    if (!matchesTopicRelevance(input, searchable)) titleNotMatched += 1;
    if (excluded.some((keyword) => searchable.includes(keyword))) {
      rejected.excludedKeyword += 1;
      continue;
    }

    items.push({
      title: title.slice(0, 500),
      url: articleUrl.toString(),
      sourceName: article.domain?.trim().slice(0, 200) || articleUrl.hostname.replace(/^www\./i, ""),
      publishedAt: parseGdeltDate(article.seendate),
      excerpt: null,
      provider: "gdelt-news",
      language: article.language?.toLocaleLowerCase() === "korean" ? "ko" : null,
      imageUrl: article.socialimage?.startsWith("https://") ? article.socialimage : null,
      metadata: {
        sourceCountry: article.sourcecountry ?? null,
        sourceLanguage: article.language ?? null
      }
    });
    if (items.length >= maxResults) break;
  }

  return {
    items,
    attempt: {
      queryVariant,
      rawCount: payload.articles.length,
      acceptedCount: items.length,
      rejected: Object.fromEntries(Object.entries(rejected).filter(([, count]) => count > 0)),
      titleNotMatched
    }
  };
}

export async function searchGdeltNews(
  input: NewsSearchInput,
  maxResults = input.maxResults ?? 10
): Promise<NewsSourceSearchResult> {
  const queries = buildGdeltQueries(input);
  if (!queries.length) {
    return { items: [], diagnostics: { fetchedCount: 0, acceptedCount: 0, rejected: { emptyQuery: 1 } } };
  }

  const attempts: GdeltAttempt[] = [];
  const items: CollectedNewsItem[] = [];
  const seen = new Set<string>();
  const variants: GdeltAttempt["queryVariant"][] =
    queries.length > 1 ? ["topic-and-keywords", "topic-only"] : ["topic-and-keywords"];

  for (let index = 0; index < queries.length; index += 1) {
    const result = await fetchGdeltQuery(queries[index], variants[index], input, maxResults);
    attempts.push(result.attempt);
    for (const item of result.items) {
      if (seen.has(item.url)) continue;
      seen.add(item.url);
      items.push(item);
      if (items.length >= maxResults) break;
    }
    if (items.length >= maxResults) break;
  }

  const rejected: Record<string, number> = {};
  for (const attempt of attempts) {
    for (const [reason, count] of Object.entries(attempt.rejected)) {
      rejected[reason] = (rejected[reason] ?? 0) + count;
    }
  }
  const duplicateCount = attempts.reduce((sum, attempt) => sum + attempt.acceptedCount, 0) - items.length;
  if (duplicateCount > 0) rejected.duplicateAcrossQueries = duplicateCount;
  const titleNotMatchedCount = attempts.reduce((sum, attempt) => sum + (attempt as GdeltAttempt & { titleNotMatched?: number }).titleNotMatched!, 0);

  return {
    items,
    diagnostics: {
      fetchedCount: attempts.reduce((sum, attempt) => sum + attempt.rawCount, 0),
      acceptedCount: items.length,
      rejected,
      observations: titleNotMatchedCount > 0 ? { titleNotMatched: titleNotMatchedCount } : {},
      attempts: attempts.map((attempt) => `${attempt.queryVariant}: raw=${attempt.rawCount}, accepted=${attempt.acceptedCount}`)
    }
  };
}

export const gdeltNewsSource: NewsSource = {
  id: "gdelt-news",
  contentType: "article",
  search: (input) => searchGdeltNews(input, input.maxResults ?? 10)
};
