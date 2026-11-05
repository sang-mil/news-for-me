import { XMLParser } from "fast-xml-parser";
import type {
  CollectedNewsItem, NewsSearchInput, SourceSearchDiagnostics
} from "../types";
import { matchesTopicRelevance } from "../relevance";

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  textNodeName: "#text",
  parseTagValue: false,
  trimValues: true
});

interface BingAttemptDiagnostic {
  queryVariant: "topic-and-keywords" | "topic-only";
  rssItemCount: number;
  acceptedCount: number;
  missingTitleCount: number;
  missingLinkCount: number;
  invalidUrlCount: number;
  topicMismatchCount: number;
  excludedCount: number;
  channelKeys: string[];
}

export interface BingNewsSearchResult {
  items: CollectedNewsItem[];
  diagnostics: BingAttemptDiagnostic[];
  sourceDiagnostics: SourceSearchDiagnostics;
}

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

function safeTerm(value: string): string {
  return value
    .replace(/["\\]/g, " ")
    .replace(/[\r\n]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 100);
}

function splitTopicTerms(value: string): string[] {
  return value.split(/[,，;；|]+/).map(safeTerm).filter(Boolean);
}

/** Search broadly first, then fall back to the topic alone if the first pass is short. */
export function buildBingNewsQueries(input: NewsSearchInput): string[] {
  const topicTerms = [...new Set(splitTopicTerms(input.topicName))];
  const includeTerms = [...new Set(input.includeKeywords.map(safeTerm).filter(Boolean))];
  const allTerms = [...new Set([...topicTerms, ...includeTerms])];
  const toQuery = (terms: string[]) => terms
    .filter(Boolean)
    .map((term) => `"${term.replace(/"/g, "")}"`)
    .join(" OR ");

  const queries = [toQuery(allTerms), toQuery(topicTerms)].filter(Boolean);
  return [...new Set(queries)];
}

function resolveArticleUrl(rawLink: string): URL | null {
  try {
    const link = new URL(rawLink);
    if (link.protocol !== "https:" || link.username || link.password) return null;
    const target = link.searchParams.get("url");
    if (target) {
      const article = new URL(target, link);
      if (
        (article.protocol !== "https:" && article.protocol !== "http:") ||
        article.username ||
        article.password
      ) return null;
      return article;
    }
    return link;
  } catch { return null; }
}

function canonicalizeUrl(value: string): string {
  const url = new URL(value);
  url.hash = "";
  for (const key of [...url.searchParams.keys()]) {
    if (key.toLowerCase().startsWith("utm_") || ["gclid", "fbclid", "mc_cid", "mc_eid"].includes(key.toLowerCase())) {
      url.searchParams.delete(key);
    }
  }
  return url.toString();
}

async function fetchBingNewsQuery(
  query: string,
  queryVariant: BingAttemptDiagnostic["queryVariant"],
  input: NewsSearchInput,
  maxResults: number
): Promise<{ items: CollectedNewsItem[]; diagnostic: BingAttemptDiagnostic }> {
  const url = new URL("https://www.bing.com/news/search");
  url.searchParams.set("q", query);
  url.searchParams.set("format", "rss");
  url.searchParams.set("setmkt", "ko-KR");

  let response: Response;
  try {
    response = await fetch(url.toString(), {
      headers: {
        Accept: "application/rss+xml, application/xml, text/xml;q=0.9, */*;q=0.8",
        "User-Agent": "NewsForMe/0.2 (+https://news-for-me.pages.dev)"
      },
      signal: AbortSignal.timeout(12_000)
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : "Unknown fetch error";
    throw new Error(`Bing News RSS request failed before receiving a response: ${detail.slice(0, 240)}`);
  }

  if (!response.ok) {
    const contentType = response.headers.get("content-type") ?? "unknown";
    const retryAfter = response.headers.get("retry-after") ?? "not provided";
    let bodyPreview = "";
    try {
      bodyPreview = (await response.text()).replace(/\s+/g, " ").trim().slice(0, 200);
    } catch {
      bodyPreview = "response body could not be read";
    }
    throw new Error(
      `Bing News RSS returned HTTP ${response.status}; content-type=${contentType}; retry-after=${retryAfter}; body=${bodyPreview || "empty"}`
    );
  }

  const contentType = response.headers.get("content-type") ?? "unknown";
  const xml = await response.text();
  if (xml.length > 2_000_000) {
    throw new Error("Bing News RSS response exceeded the 2 MB safety limit.");
  }
  if (!xml.trim().startsWith("<?xml") && !xml.includes("<rss")) {
    throw new Error(
      `Bing News RSS returned a non-RSS response; content-type=${contentType}; body=${xml.replace(/\s+/g, " ").trim().slice(0, 180)}`
    );
  }

  let parsed: { rss?: { channel?: { item?: unknown | unknown[]; [key: string]: unknown } } };
  try {
    parsed = parser.parse(xml) as typeof parsed;
  } catch (error) {
    const detail = error instanceof Error ? error.message : "XML parse failed";
    throw new Error(`Bing News RSS XML parsing failed: ${detail.slice(0, 200)}`);
  }

  const channel = parsed.rss?.channel;
  if (!channel) {
    const rootKeys = Object.keys(parsed as Record<string, unknown>).slice(0, 8).join(", ") || "none";
    throw new Error(`Bing News RSS XML had an unexpected structure; root elements: ${rootKeys}`);
  }

  const channelKeys = Object.keys(channel).slice(0, 12);
  const rawItems = channel.item;
  const rawList = rawItems ? (Array.isArray(rawItems) ? rawItems : [rawItems]) : [];
  const excluded = input.excludeKeywords.map((keyword) => keyword.toLocaleLowerCase()).filter(Boolean);
  const collected: CollectedNewsItem[] = [];
  let missingTitleCount = 0;
  let missingLinkCount = 0;
  let invalidUrlCount = 0;
  let topicMismatchCount = 0;
  let excludedCount = 0;

  for (const raw of rawList) {
    if (!raw || typeof raw !== "object") continue;
    const item = raw as Record<string, unknown>;
    const title = asText(item.title);
    const rawLink = asText(item.link);
    if (!title) {
      missingTitleCount += 1;
      continue;
    }
    if (!rawLink) {
      missingLinkCount += 1;
      continue;
    }

    const articleUrl = resolveArticleUrl(rawLink);
    if (!articleUrl) {
      invalidUrlCount += 1;
      continue;
    }

    const sourceName = asText(item["News:Source"] ?? item.source)
      || articleUrl.hostname.replace(/^www\./i, "");
    const excerpt = cleanExcerpt(asText(item.description));
    const searchable = `${title} ${sourceName} ${excerpt ?? ""}`.toLocaleLowerCase();
    if (!matchesTopicRelevance(input, searchable)) {
      topicMismatchCount += 1;
      continue;
    }
    if (excluded.some((keyword) => searchable.includes(keyword))) {
      excludedCount += 1;
      continue;
    }

    const publishedText = asText(item.pubDate);
    const timestamp = publishedText ? Date.parse(publishedText) : Number.NaN;
    collected.push({
      title: title.slice(0, 500),
      url: articleUrl.toString(),
      sourceName: sourceName.slice(0, 200),
      publishedAt: Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null,
      excerpt,
      provider: "bing-news-rss"
    });
    if (collected.length >= maxResults) break;
  }

  const diagnostic: BingAttemptDiagnostic = {
    queryVariant,
    rssItemCount: rawList.length,
    acceptedCount: collected.length,
    missingTitleCount,
    missingLinkCount,
    invalidUrlCount,
    topicMismatchCount,
    excludedCount,
    channelKeys
  };

  console.info("[NewsForMe][RSS] Bing News RSS response parsed", {
    httpStatus: response.status,
    contentType,
    responseBytes: new TextEncoder().encode(xml).length,
    ...diagnostic
  });

  return { items: collected, diagnostic };
}

export async function searchBingNewsRss(
  input: NewsSearchInput,
  maxResults = input.maxResults ?? 10
): Promise<BingNewsSearchResult> {
  const queries = buildBingNewsQueries(input);
  if (queries.length === 0) throw new Error("Bing News RSS query was empty.");

  const diagnostics: BingAttemptDiagnostic[] = [];
  const items: CollectedNewsItem[] = [];
  const seen = new Set<string>();
  const variants: BingAttemptDiagnostic["queryVariant"][] =
    queries.length > 1
      ? ["topic-and-keywords", "topic-only"]
      : ["topic-and-keywords"];

  for (let index = 0; index < queries.length; index += 1) {
    const result = await fetchBingNewsQuery(queries[index], variants[index], input, maxResults);
    diagnostics.push(result.diagnostic);
    for (const item of result.items) {
      const normalizedUrl = canonicalizeUrl(item.url);
      if (seen.has(normalizedUrl)) continue;
      seen.add(normalizedUrl);
      items.push({ ...item, url: normalizedUrl });
      if (items.length >= maxResults) break;
    }
    if (items.length >= maxResults) break;
  }

  const rejected: Record<string, number> = {
    missingTitle: diagnostics.reduce((sum, item) => sum + item.missingTitleCount, 0),
    missingLink: diagnostics.reduce((sum, item) => sum + item.missingLinkCount, 0),
    invalidUrl: diagnostics.reduce((sum, item) => sum + item.invalidUrlCount, 0),
    topicMismatch: diagnostics.reduce((sum, item) => sum + item.topicMismatchCount, 0),
    excludedKeyword: diagnostics.reduce((sum, item) => sum + item.excludedCount, 0)
  };
  const duplicateCount = diagnostics.reduce((sum, item) => sum + item.acceptedCount, 0) - items.length;
  if (duplicateCount > 0) rejected.duplicateAcrossQueries = duplicateCount;
  const rejectedCounts = Object.fromEntries(Object.entries(rejected).filter(([, count]) => count > 0));

  console.info("[NewsForMe][RSS] Bing News RSS search completed", {
    requested: maxResults,
    fetched: diagnostics.reduce((sum, item) => sum + item.rssItemCount, 0),
    accepted: items.length,
    rejected: rejectedCounts,
    attempts: diagnostics.map((item) => item.queryVariant)
  });

  return {
    items,
    diagnostics,
    sourceDiagnostics: {
      fetchedCount: diagnostics.reduce((sum, item) => sum + item.rssItemCount, 0),
      acceptedCount: items.length,
      rejected: rejectedCounts,
      attempts: diagnostics.map((item) => `${item.queryVariant}: rss=${item.rssItemCount}, accepted=${item.acceptedCount}`)
    }
  };
}
