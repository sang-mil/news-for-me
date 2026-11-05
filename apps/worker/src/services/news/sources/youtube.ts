import type { CollectedNewsItem, NewsSearchInput, NewsSource, NewsSourceSearchResult } from "../types";
import { matchesTopicRelevance } from "../relevance";

interface YouTubeSearchItem {
  id?: { kind?: string; videoId?: string };
  snippet?: {
    title?: string;
    description?: string;
    publishedAt?: string;
    channelId?: string;
    channelTitle?: string;
    thumbnails?: { high?: { url?: string }; medium?: { url?: string }; default?: { url?: string } };
  };
}
interface YouTubeSearchResponse {
  items?: YouTubeSearchItem[];
  error?: { message?: string; errors?: Array<{ reason?: string }> };
}
function splitTerms(value: string): string[] {
  return value.split(/[,，;；|]+/)
    .map((term) => term.replace(/["\\]/g, " ").replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim())
    .filter(Boolean);
}
export function buildYouTubeSearchQuery(input: NewsSearchInput): string {
  const positiveTerms = [...new Set([...splitTerms(input.topicName), ...input.includeKeywords.flatMap(splitTerms)])].slice(0, 8);
  const negativeTerms = [...new Set(input.excludeKeywords.flatMap(splitTerms))].slice(0, 5);
  const positiveQuery = positiveTerms.length > 1 ? positiveTerms.map((term) => '"' + term + '"').join(" | ") : positiveTerms[0] ?? "";
  return [positiveQuery, ...negativeTerms.map((term) => "-" + term)].filter(Boolean).join(" ").slice(0, 450);
}
function safeThumbnail(item: YouTubeSearchItem): string | null {
  const candidate = item.snippet?.thumbnails?.high?.url ?? item.snippet?.thumbnails?.medium?.url ?? item.snippet?.thumbnails?.default?.url;
  if (!candidate) return null;
  try {
    const url = new URL(candidate);
    return url.protocol === "https:" && url.hostname === "i.ytimg.com" ? url.toString() : null;
  } catch { return null; }
}
export function createYouTubeVideosSource(apiKey: string): NewsSource {
  return {
    id: "youtube-data-api",
    contentType: "video",
    async search(input: NewsSearchInput): Promise<NewsSourceSearchResult> {
      const query = buildYouTubeSearchQuery(input);
      if (!query) return { items: [], diagnostics: { fetchedCount: 0, acceptedCount: 0, rejected: { emptyQuery: 1 } } };
      const url = new URL("https://www.googleapis.com/youtube/v3/search");
      url.searchParams.set("part", "snippet");
      url.searchParams.set("type", "video");
      url.searchParams.set("q", query);
      url.searchParams.set("maxResults", String(Math.min(30, Math.max(1, input.maxResults ?? 10))));
      url.searchParams.set("order", "relevance");
      url.searchParams.set("regionCode", "KR");
      url.searchParams.set("relevanceLanguage", "ko");
      url.searchParams.set("safeSearch", "moderate");
      url.searchParams.set("key", apiKey);
      const response = await fetch(url.toString(), { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(12_000) });
      if (!response.ok) {
        let detail = "";
        try {
          const payload = await response.json() as YouTubeSearchResponse;
          detail = payload.error?.message ?? payload.error?.errors?.[0]?.reason ?? "";
        } catch { /* Never log the request URL; it contains the API key. */ }
        throw new Error("YouTube Data API returned HTTP " + response.status + (detail ? ": " + detail.slice(0, 180) : ""));
      }
      const payload = await response.json() as YouTubeSearchResponse;
      const excluded = input.excludeKeywords.map((term) => term.toLocaleLowerCase()).filter(Boolean);
      const results: CollectedNewsItem[] = [];
      const rejected: Record<string, number> = {
        invalidVideo: 0, missingTitle: 0, topicMismatch: 0, excludedKeyword: 0
      };
      for (const video of payload.items ?? []) {
        const videoId = video.id?.videoId?.trim();
        const snippet = video.snippet;
        const title = snippet?.title?.trim() ?? "";
        if (video.id?.kind !== "youtube#video" || !videoId) {
          rejected.invalidVideo += 1;
          continue;
        }
        if (!title) {
          rejected.missingTitle += 1;
          continue;
        }
        const description = snippet?.description?.trim() ?? "";
        const channelTitle = snippet?.channelTitle?.trim() ?? "YouTube";
        const searchable = (title + " " + description + " " + channelTitle).toLocaleLowerCase();
        if (!matchesTopicRelevance(input, searchable)) {
          rejected.topicMismatch += 1;
          continue;
        }
        if (excluded.some((term) => searchable.includes(term))) {
          rejected.excludedKeyword += 1;
          continue;
        }
        const timestamp = snippet?.publishedAt ? Date.parse(snippet.publishedAt) : Number.NaN;
        results.push({
          title: title.slice(0, 500),
          url: "https://www.youtube.com/watch?v=" + encodeURIComponent(videoId),
          sourceName: ("YouTube · " + channelTitle).slice(0, 200),
          publishedAt: Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null,
          excerpt: description.slice(0, 2000) || null,
          provider: "youtube-data-api",
          contentType: "video",
          author: channelTitle,
          imageUrl: safeThumbnail(video),
          externalId: videoId,
          metadata: { channelId: snippet?.channelId ?? null, channelTitle }
        });
        if (results.length >= (input.maxResults ?? 10)) break;
      }
      const rejectedCounts = Object.fromEntries(Object.entries(rejected).filter(([, count]) => count > 0));
      console.info("[NewsForMe][YouTube] search completed", {
        returned: payload.items?.length ?? 0,
        accepted: results.length,
        rejected: rejectedCounts,
        queryTerms: query
      });
      return {
        items: results,
        diagnostics: {
          fetchedCount: payload.items?.length ?? 0,
          acceptedCount: results.length,
          rejected: rejectedCounts
        }
      };
    }
  };
}
