import type { CollectedNewsItem, NewsSearchInput, NewsSourceSearchResult } from "../types";

interface V2exTopic {
  id?: number;
  title?: string;
  url?: string;
  content?: string;
  content_rendered?: string;
  created?: number;
  last_modified?: number;
  node?: { title?: string; name?: string };
  member?: { username?: string };
  replies?: number;
}

function termsFor(input: NewsSearchInput): string[] {
  return [...new Set([
    ...input.topicName.split(/[,，;；|]+/),
    ...input.includeKeywords
  ].map((term) => term.trim().toLocaleLowerCase()).filter(Boolean))].slice(0, 10);
}

function stripHtml(value: string): string {
  return value.replace(/<[^>]+>/g, " ").replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&").replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">").replace(/&quot;/gi, '"')
    .replace(/\s+/g, " ").trim();
}

export async function searchV2exTopics(
  input: NewsSearchInput,
  maxResults = input.maxResults ?? 10
): Promise<NewsSourceSearchResult> {
  const endpoints = [
    "https://www.v2ex.com/api/topics/hot.json",
    "https://www.v2ex.com/api/topics/latest.json"
  ];
  const responses = await Promise.allSettled(endpoints.map(async (endpoint) => {
    const response = await fetch(endpoint, {
      headers: { Accept: "application/json", "User-Agent": "NewsForMe/0.1 (+https://news-for-me.pages.dev)" },
      signal: AbortSignal.timeout(10_000)
    });
    if (!response.ok) throw new Error(`V2EX returned HTTP ${response.status}`);
    return await response.json() as V2exTopic[];
  }));

  const topics = responses.flatMap((result) => result.status === "fulfilled" ? result.value : []);
  if (topics.length === 0 && responses.every((result) => result.status === "rejected")) {
    throw new Error("V2EX hot/latest topic endpoints are unavailable.");
  }

  const terms = termsFor(input);
  const excluded = input.excludeKeywords.map((term) => term.toLocaleLowerCase()).filter(Boolean);
  const seen = new Set<number>();
  const items: CollectedNewsItem[] = [];
  const rejected: Record<string, number> = {
    invalidTopic: 0, topicMismatch: 0, excludedKeyword: 0, duplicateTopic: 0
  };

  for (const topic of topics) {
    if (typeof topic.id !== "number") {
      rejected.invalidTopic += 1;
      continue;
    }
    if (seen.has(topic.id)) {
      rejected.duplicateTopic += 1;
      continue;
    }
    seen.add(topic.id);
    const title = topic.title?.trim() ?? "";
    const content = stripHtml(topic.content_rendered ?? topic.content ?? "");
    const node = topic.node?.title ?? topic.node?.name ?? "V2EX";
    const searchable = `${title} ${content} ${node}`.toLocaleLowerCase();
    if (!terms.some((term) => searchable.includes(term))) {
      rejected.topicMismatch += 1;
      continue;
    }
    if (excluded.some((term) => searchable.includes(term))) {
      rejected.excludedKeyword += 1;
      continue;
    }

    const url = topic.url?.startsWith("https://www.v2ex.com/t/")
      ? topic.url
      : `https://www.v2ex.com/t/${topic.id}`;
    const timestamp = typeof topic.last_modified === "number" ? topic.last_modified * 1000
      : typeof topic.created === "number" ? topic.created * 1000 : Number.NaN;

    items.push({
      title: `V2EX: ${title}`,
      url,
      sourceName: `V2EX · ${node}`,
      publishedAt: Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null,
      excerpt: content.slice(0, 2000) || null,
      provider: "v2ex-public-api",
      contentType: "discussion",
      externalId: String(topic.id),
      author: topic.member?.username ?? null,
      engagement: { replies: typeof topic.replies === "number" ? topic.replies : null }
    });
    if (items.length >= maxResults) break;
  }

  if (responses.some((result) => result.status === "rejected")) {
    rejected.endpointFailure = responses.filter((result) => result.status === "rejected").length;
  }
  const rejectedCounts = Object.fromEntries(Object.entries(rejected).filter(([, count]) => count > 0));
  console.info("[NewsForMe][RSS] V2EX search completed", {
    candidates: topics.length, matched: items.length, rejected: rejectedCounts, queryTerms: terms
  });
  return {
    items,
    diagnostics: {
      fetchedCount: topics.length,
      acceptedCount: items.length,
      rejected: rejectedCounts,
      attempts: endpoints.map((endpoint, index) => `${endpoint.includes("hot") ? "hot" : "latest"}=${responses[index].status}`)
    }
  };
}
