import type { CollectedNewsItem, NewsSearchInput, NewsSource } from "../types";
import { matchesTopicRelevance } from "../relevance";

interface ThreadsPost {
  id?: string;
  media_type?: string;
  permalink?: string;
  username?: string;
  text?: string;
  timestamp?: string;
  shortcode?: string;
  has_replies?: boolean;
  topic_tag?: string;
}
interface ThreadsSearchResponse {
  data?: ThreadsPost[];
  error?: { message?: string; type?: string; code?: number; error_subcode?: number };
  paging?: { cursors?: { before?: string; after?: string } };
}

function splitTerms(value: string): string[] {
  return value.split(/[,，;；|]+/)
    .map((term) => term.replace(/["\\]/g, " ").replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

/** Threads keyword_search accepts one q expression; use the main topic, falling back to an include term. */
export function buildThreadsSearchQuery(input: NewsSearchInput): string {
  const topic = splitTerms(input.topicName)[0];
  const include = input.includeKeywords.flatMap(splitTerms)[0];
  return (topic || include || "").slice(0, 250);
}

export function createThreadsPostsSource(accessToken: string): NewsSource {
  return {
    id: "threads-api",
    contentType: "social_post",
    async search(input: NewsSearchInput): Promise<CollectedNewsItem[]> {
      const query = buildThreadsSearchQuery(input);
      if (!query) return [];

      const url = new URL("https://graph.threads.net/v1.0/keyword_search");
      url.searchParams.set("q", query);
      url.searchParams.set("search_type", "RECENT");
      url.searchParams.set("search_mode", "KEYWORD");
      url.searchParams.set("limit", String(Math.min(50, Math.max(10, input.maxResults ?? 10))));
      url.searchParams.set(
        "fields",
        "id,media_type,permalink,username,text,timestamp,shortcode,has_replies,topic_tag"
      );

      const response = await fetch(url.toString(), {
        headers: {
          Authorization: "Bearer " + accessToken,
          Accept: "application/json"
        },
        signal: AbortSignal.timeout(12_000)
      });
      if (!response.ok) {
        let detail = "";
        try {
          const payload = await response.json() as ThreadsSearchResponse;
          detail = payload.error?.message ?? "";
        } catch { /* Never expose the access token. */ }
        throw new Error("Threads API keyword search returned HTTP " + response.status +
          (detail ? ": " + detail.slice(0, 180) : ""));
      }

      const payload = await response.json() as ThreadsSearchResponse;
      if (payload.error) {
        throw new Error("Threads API keyword search failed: " +
          (payload.error.message ?? "unknown API error").slice(0, 180));
      }

      const excluded = input.excludeKeywords.flatMap(splitTerms)
        .map((term) => term.toLocaleLowerCase());
      const results: CollectedNewsItem[] = [];

      for (const post of payload.data ?? []) {
        const id = post.id?.trim();
        const text = post.text?.trim() ?? "";
        if (!id || !text || !post.permalink) continue;
        let permalink: URL;
        try { permalink = new URL(post.permalink); } catch { continue; }
        if (permalink.protocol !== "https:" || !["threads.com", "www.threads.com", "threads.net", "www.threads.net"].includes(permalink.hostname)) continue;

        const username = post.username?.trim() ?? "";
        const searchable = [text, username, post.topic_tag ?? ""].join(" ").toLocaleLowerCase();
        if (!matchesTopicRelevance(input, searchable)) continue;
        if (excluded.some((term) => term && searchable.includes(term))) continue;

        const timestamp = post.timestamp ? Date.parse(post.timestamp) : Number.NaN;
        results.push({
          title: text.replace(/\s+/g, " ").slice(0, 500),
          url: permalink.toString(),
          sourceName: "Threads",
          publishedAt: Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null,
          excerpt: text.slice(0, 2000),
          provider: "threads-api",
          contentType: "social_post",
          author: username ? "@" + username : null,
          externalId: id,
          engagement: { hasReplies: post.has_replies ?? false },
          metadata: {
            mediaType: post.media_type ?? null,
            shortcode: post.shortcode ?? null,
            topicTag: post.topic_tag ?? null
          }
        });
        if (results.length >= (input.maxResults ?? 10)) break;
      }

      console.info("[NewsForMe][Threads] keyword search completed", {
        returned: payload.data?.length ?? 0,
        accepted: results.length,
        query
      });
      return results;
    }
  };
}
