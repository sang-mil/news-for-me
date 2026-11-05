import { XMLParser } from "fast-xml-parser";
import type {
  CollectedNewsItem, NewsSearchInput, NewsSource, NewsSourceSearchResult
} from "../types";
import { matchesTopicRelevance } from "../relevance.ts";

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  textNodeName: "#text",
  parseTagValue: false,
  trimValues: true
});

function asText(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number") return String(value);
  if (value && typeof value === "object" && "#text" in value) {
    const text = (value as { "#text"?: unknown })["#text"];
    return typeof text === "string" ? text.trim() : "";
  }
  return "";
}

function cleanExcerpt(value: string): string | null {
  const cleaned = value
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned ? cleaned.slice(0, 2000) : null;
}

function safeQueryTerm(value: string): string {
  return value.replace(/["\\]/g, " ").replace(/\s+/g, " ").trim();
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export function buildGoogleNewsQuery(
  topicName: string,
  includeKeywords: string[],
  excludeKeywords: string[]
): string {
  const topicTerms = topicName.split(/[,，;；|]+/).map(safeQueryTerm).filter(Boolean);
  const positives = [...new Set([...topicTerms, ...includeKeywords.map(safeQueryTerm).filter(Boolean)])]
    .slice(0, 8)
    .map((term) => `"${term}"`);

  const positiveQuery = positives.length > 1
    ? `(${positives.join(" OR ")})`
    : positives[0] ?? `"${safeQueryTerm(topicName)}"`;

  const negatives = excludeKeywords
    .map(safeQueryTerm)
    .filter(Boolean)
    .slice(0, 5)
    .map((term) => `-"${term}"`);

  return [positiveQuery, ...negatives, "when:7d"].join(" ");
}

async function fetchGoogleNewsRss(url: string): Promise<Response> {
  const retryableStatuses = new Set([429, 500, 502, 503, 504]);
  let lastError = "Unknown fetch error";

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    let response: Response | null = null;
    try {
      response = await fetch(url, {
        headers: {
          Accept: "application/rss+xml, application/xml, text/xml;q=0.9, */*;q=0.8",
          "User-Agent": "NewsForMe/0.2 (+https://news-for-me.pages.dev)"
        },
        signal: AbortSignal.timeout(12_000)
      });
    } catch (error) {
      lastError = error instanceof Error ? error.message : "Unknown fetch error";
    }

    if (response?.ok) return response;
    const shouldRetry = !response || retryableStatuses.has(response.status);
    if (!shouldRetry || attempt === 3) {
      if (!response) {
        throw new Error(`Google News RSS request failed after ${attempt} attempt(s): ${lastError.slice(0, 240)}`);
      }
      const contentType = response.headers.get("content-type") ?? "unknown";
      const retryAfter = response.headers.get("retry-after") ?? "not provided";
      let bodyPreview = "";
      try {
        bodyPreview = (await response.text()).replace(/\s+/g, " ").trim().slice(0, 240);
      } catch {
        bodyPreview = "response body could not be read";
      }
      throw new Error(
        `Google News RSS returned HTTP ${response.status} after ${attempt} attempt(s); content-type=${contentType}; retry-after=${retryAfter}; body=${bodyPreview || "empty"}`
      );
    }

    const retryAfterSeconds = response?.headers.get("retry-after");
    const retryAfterMs = retryAfterSeconds && /^\d+$/.test(retryAfterSeconds)
      ? Math.min(1500, Number(retryAfterSeconds) * 1000)
      : 0;
    await wait(Math.max(retryAfterMs, 350 * attempt));
  }

  throw new Error(`Google News RSS request failed: ${lastError.slice(0, 240)}`);
}

export async function searchGoogleNewsRss(
  query: string,
  input: NewsSearchInput,
  maxResults = 10
): Promise<NewsSourceSearchResult> {
  const url = new URL("https://news.google.com/rss/search");
  url.searchParams.set("q", query);
  url.searchParams.set("hl", "ko");
  url.searchParams.set("gl", "KR");
  url.searchParams.set("ceid", "KR:ko");

  const response = await fetchGoogleNewsRss(url.toString());
  const xml = await response.text();
  if (xml.length > 2_000_000) {
    throw new Error("News RSS response exceeded the 2 MB safety limit.");
  }

  const parsed = parser.parse(xml) as {
    rss?: { channel?: { item?: unknown | unknown[] } };
  };
  const rawItems = parsed.rss?.channel?.item;
  const items = rawItems ? (Array.isArray(rawItems) ? rawItems : [rawItems]) : [];
  const rejected: Record<string, number> = {
    invalidItem: 0,
    missingTitle: 0,
    missingLink: 0,
    invalidUrl: 0,
    topicMismatch: 0,
    excludedKeyword: 0
  };
  const excluded = input.excludeKeywords.map((keyword) => keyword.toLocaleLowerCase()).filter(Boolean);
  const collected: CollectedNewsItem[] = [];

  for (const raw of items) {
    if (!raw || typeof raw !== "object") {
      rejected.invalidItem += 1;
      continue;
    }
    const item = raw as Record<string, unknown>;
    const title = asText(item.title);
    const rawLink = asText(item.link);
    const sourceName = asText(item.source) || null;
    const pubDate = asText(item.pubDate);
    const excerpt = cleanExcerpt(asText(item.description));

    if (!title) {
      rejected.missingTitle += 1;
      continue;
    }
    if (!rawLink) {
      rejected.missingLink += 1;
      continue;
    }

    let parsedLink: URL;
    try {
      parsedLink = new URL(rawLink);
    } catch {
      rejected.invalidUrl += 1;
      continue;
    }
    if (parsedLink.protocol !== "https:" || parsedLink.username || parsedLink.password) {
      rejected.invalidUrl += 1;
      continue;
    }

    const searchable = `${title} ${sourceName ?? ""} ${excerpt ?? ""}`.toLocaleLowerCase();
    if (!matchesTopicRelevance(input, searchable)) {
      rejected.topicMismatch += 1;
      continue;
    }
    if (excluded.some((keyword) => searchable.includes(keyword))) {
      rejected.excludedKeyword += 1;
      continue;
    }

    const timestamp = pubDate ? Date.parse(pubDate) : Number.NaN;
    collected.push({
      title: title.slice(0, 500),
      url: parsedLink.toString(),
      sourceName: sourceName?.slice(0, 200) ?? null,
      publishedAt: Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null,
      excerpt,
      provider: "google-news-rss"
    });

    if (collected.length >= maxResults) break;
  }

  const rejectedCounts = Object.fromEntries(
    Object.entries(rejected).filter(([, count]) => count > 0)
  );
  return {
    items: collected,
    diagnostics: {
      fetchedCount: items.length,
      acceptedCount: collected.length,
      rejected: rejectedCounts
    }
  };
}

export const googleNewsRssSource: NewsSource = {
  id: "google-news-rss",
  contentType: "article",
  async search(input: NewsSearchInput): Promise<NewsSourceSearchResult> {
    const query = buildGoogleNewsQuery(
      input.topicName,
      input.includeKeywords,
      input.excludeKeywords
    );
    return searchGoogleNewsRss(query, input, input.maxResults ?? 10);
  }
};
