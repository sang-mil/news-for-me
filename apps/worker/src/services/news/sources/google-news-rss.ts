import { XMLParser } from "fast-xml-parser";
import type { CollectedNewsItem, NewsSearchInput, NewsSource } from "../types";

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

export function buildGoogleNewsQuery(
  topicName: string,
  includeKeywords: string[],
  excludeKeywords: string[]
): string {
  const positives = [topicName, ...includeKeywords]
    .map(safeQueryTerm)
    .filter(Boolean)
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

export async function searchGoogleNewsRss(
  query: string,
  excludeKeywords: string[]
): Promise<CollectedNewsItem[]> {
  const url = new URL("https://news.google.com/rss/search");
  url.searchParams.set("q", query);
  url.searchParams.set("hl", "ko");
  url.searchParams.set("gl", "KR");
  url.searchParams.set("ceid", "KR:ko");

  const response = await fetch(url.toString(), {
    headers: {
      Accept: "application/rss+xml, application/xml, text/xml;q=0.9, */*;q=0.8",
      "User-Agent": "NewsForMe/0.1 RSS reader"
    }
  });

  if (!response.ok) {
    throw new Error(`Google News RSS returned HTTP ${response.status}.`);
  }

  const xml = await response.text();
  if (xml.length > 2_000_000) {
    throw new Error("News RSS response exceeded the 2 MB safety limit.");
  }

  const parsed = parser.parse(xml) as {
    rss?: { channel?: { item?: unknown | unknown[] } };
  };
  const rawItems = parsed.rss?.channel?.item;
  if (!rawItems) return [];

  const items = Array.isArray(rawItems) ? rawItems : [rawItems];
  const excluded = excludeKeywords
    .map((keyword) => keyword.toLocaleLowerCase())
    .filter(Boolean);
  const collected: CollectedNewsItem[] = [];

  for (const raw of items) {
    if (!raw || typeof raw !== "object") continue;
    const item = raw as Record<string, unknown>;
    const title = asText(item.title);
    const rawLink = asText(item.link);
    const sourceName = asText(item.source) || null;
    const pubDate = asText(item.pubDate);
    const excerpt = cleanExcerpt(asText(item.description));

    if (!title || !rawLink) continue;

    let parsedLink: URL;
    try {
      parsedLink = new URL(rawLink);
    } catch {
      continue;
    }
    if (parsedLink.protocol !== "https:") continue;

    const searchable = `${title} ${sourceName ?? ""} ${excerpt ?? ""}`.toLocaleLowerCase();
    if (excluded.some((keyword) => searchable.includes(keyword))) continue;

    const timestamp = pubDate ? Date.parse(pubDate) : Number.NaN;
    collected.push({
      title: title.slice(0, 500),
      url: parsedLink.toString(),
      sourceName: sourceName?.slice(0, 200) ?? null,
      publishedAt: Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null,
      excerpt,
      provider: "google-news-rss"
    });

    if (collected.length >= 10) break;
  }

  return collected;
}

export const googleNewsRssSource: NewsSource = {
  id: "google-news-rss",
  async search(input: NewsSearchInput): Promise<CollectedNewsItem[]> {
    const query = buildGoogleNewsQuery(
      input.topicName,
      input.includeKeywords,
      input.excludeKeywords
    );
    return searchGoogleNewsRss(query, input.excludeKeywords);
  }
};
