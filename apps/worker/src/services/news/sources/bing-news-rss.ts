import { XMLParser } from "fast-xml-parser";
import type { CollectedNewsItem, NewsSearchInput } from "../types";

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

function safeTerm(value: string): string {
  return value
    .replace(/["\\]/g, " ")
    .replace(/[\r\n]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function buildBingNewsQuery(input: NewsSearchInput): string {
  const terms = [...new Set([input.topicName, ...input.includeKeywords]
    .map(safeTerm)
    .filter(Boolean))]
    .slice(0, 8);

  return terms.length > 1
    ? terms.map((term) => `"${term}"`).join(" OR ")
    : terms[0] ?? "";
}

function resolveArticleUrl(rawLink: string): URL | null {
  try {
    const link = new URL(rawLink);
    if (link.protocol !== "https:") return null;

    // Bing RSS commonly wraps publisher links in /news/apiclick.aspx?url=...
    const target = link.searchParams.get("url");
    if (target) {
      const article = new URL(target, link);
      if (article.protocol !== "https:" || article.username || article.password) return null;
      return article;
    }

    if (link.username || link.password) return null;
    return link;
  } catch {
    return null;
  }
}

export async function searchBingNewsRss(
  input: NewsSearchInput
): Promise<CollectedNewsItem[]> {
  const query = buildBingNewsQuery(input);
  if (!query) throw new Error("Bing News RSS query was empty.");

  const url = new URL("https://www.bing.com/news/search");
  url.searchParams.set("q", query);
  url.searchParams.set("format", "rss");
  url.searchParams.set("setmkt", "ko-KR");

  let response: Response;
  try {
    response = await fetch(url.toString(), {
      headers: {
        Accept: "application/rss+xml, application/xml, text/xml;q=0.9, */*;q=0.8",
        "User-Agent": "NewsForMe/0.1 (+https://news-for-me.pages.dev)"
      },
      signal: AbortSignal.timeout(12_000)
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : "Unknown fetch error";
    throw new Error(`Bing News RSS request failed before receiving a response: ${detail.slice(0, 300)}`);
  }

  if (!response.ok) {
    const contentType = response.headers.get("content-type") ?? "unknown";
    const retryAfter = response.headers.get("retry-after") ?? "not provided";
    let bodyPreview = "";
    try {
      bodyPreview = (await response.text()).replace(/\s+/g, " ").trim().slice(0, 300);
    } catch {
      bodyPreview = "response body could not be read";
    }
    throw new Error(
      `Bing News RSS returned HTTP ${response.status}; content-type=${contentType}; retry-after=${retryAfter}; body=${bodyPreview || "empty"}`
    );
  }

  const xml = await response.text();
  if (xml.length > 2_000_000) {
    throw new Error("Bing News RSS response exceeded the 2 MB safety limit.");
  }
  if (!xml.trim().startsWith("<?xml") && !xml.includes("<rss")) {
    throw new Error("Bing News RSS returned a non-RSS response.");
  }

  let parsed: { rss?: { channel?: { item?: unknown | unknown[] } } };
  try {
    parsed = parser.parse(xml) as typeof parsed;
  } catch (error) {
    const detail = error instanceof Error ? error.message : "XML parse failed";
    throw new Error(`Bing News RSS XML parsing failed: ${detail.slice(0, 250)}`);
  }

  const rawItems = parsed.rss?.channel?.item;
  if (!rawItems) return [];

  const excluded = input.excludeKeywords
    .map((keyword) => keyword.toLocaleLowerCase())
    .filter(Boolean);
  const collected: CollectedNewsItem[] = [];
  const rawList = Array.isArray(rawItems) ? rawItems : [rawItems];

  for (const raw of rawList) {
    if (!raw || typeof raw !== "object") continue;
    const item = raw as Record<string, unknown>;
    const title = asText(item.title);
    const rawLink = asText(item.link);
    const articleUrl = resolveArticleUrl(rawLink);
    if (!title || !articleUrl) continue;

    const sourceName = asText(item.source) || articleUrl.hostname.replace(/^www\./i, "");
    const excerpt = cleanExcerpt(asText(item.description));
    const searchable = `${title} ${sourceName} ${excerpt ?? ""}`.toLocaleLowerCase();
    if (excluded.some((keyword) => searchable.includes(keyword.toLocaleLowerCase()))) continue;

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

    if (collected.length >= 10) break;
  }

  return collected;
}
