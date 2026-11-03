import type { CollectedNewsItem, NewsSearchInput, NewsSource } from "../types";
import { matchesTopicRelevance } from "../relevance";

interface XPost {
  id?: string;
  text?: string;
  created_at?: string;
  lang?: string;
  author_id?: string;
  public_metrics?: {
    like_count?: number;
    repost_count?: number;
    reply_count?: number;
    quote_count?: number;
    bookmark_count?: number;
  };
}
interface XUser { id?: string; name?: string; username?: string; }
interface XSearchResponse {
  data?: XPost[];
  includes?: { users?: XUser[] };
  errors?: Array<{ message?: string; detail?: string; title?: string }>;
}

function splitTerms(value: string): string[] {
  return value.split(/[,，;；|]+/)
    .map((term) => term.replace(/["\\]/g, " ").replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

export function buildXSearchQuery(input: NewsSearchInput): string {
  const positive = [...new Set([
    ...splitTerms(input.topicName),
    ...input.includeKeywords.flatMap(splitTerms)
  ])].slice(0, 8);
  const negative = [...new Set(input.excludeKeywords.flatMap(splitTerms))].slice(0, 5);
  const positiveQuery = positive.length > 1
    ? "(" + positive.map((term) => '"' + term + '"').join(" OR ") + ")"
    : positive[0] ?? "";
  return [positiveQuery, ...negative.map((term) => "-" + term), "-is:retweet"]
    .filter(Boolean).join(" ").slice(0, 1000);
}

export function createXPostsSource(bearerToken: string): NewsSource {
  return {
    id: "x-api",
    contentType: "social_post",
    async search(input: NewsSearchInput): Promise<CollectedNewsItem[]> {
      const query = buildXSearchQuery(input);
      if (!query) return [];
      const requested = Math.min(100, Math.max(10, input.maxResults ?? 10));
      const url = new URL("https://api.x.com/2/tweets/search/recent");
      url.searchParams.set("query", query);
      // X's recent-search endpoint requires at least 10 results per request.
      url.searchParams.set("max_results", String(requested));
      url.searchParams.set("sort_order", "relevancy");
      url.searchParams.set("tweet.fields", "id,text,created_at,lang,public_metrics,author_id");
      url.searchParams.set("expansions", "author_id");
      url.searchParams.set("user.fields", "id,name,username");

      const response = await fetch(url.toString(), {
        headers: { Authorization: "Bearer " + bearerToken, Accept: "application/json" },
        signal: AbortSignal.timeout(12_000)
      });
      if (!response.ok) {
        let detail = "";
        try {
          const payload = await response.json() as XSearchResponse;
          detail = payload.errors?.map((item) => item.detail ?? item.message ?? item.title ?? "")
            .filter(Boolean).join("; ") ?? "";
        } catch { /* Never expose the bearer token. */ }
        throw new Error("X API recent search returned HTTP " + response.status +
          (detail ? ": " + detail.slice(0, 180) : ""));
      }

      const payload = await response.json() as XSearchResponse;
      const users = new Map((payload.includes?.users ?? [])
        .filter((user) => user.id && user.username)
        .map((user) => [user.id as string, user]));
      const results: CollectedNewsItem[] = [];
      const excluded = input.excludeKeywords.flatMap(splitTerms)
        .map((term) => term.toLocaleLowerCase());

      for (const post of payload.data ?? []) {
        const id = post.id?.trim();
        const text = post.text?.trim() ?? "";
        if (!id || !text) continue;
        const user = post.author_id ? users.get(post.author_id) : undefined;
        const author = user?.username ? "@" + user.username : "X 사용자";
        if (!matchesTopicRelevance(input, text + " " + author)) continue;
        const searchable = text.toLocaleLowerCase();
        if (excluded.some((term) => term && searchable.includes(term))) continue;
        const timestamp = post.created_at ? Date.parse(post.created_at) : Number.NaN;
        const username = user?.username;
        results.push({
          title: text.replace(/\s+/g, " ").slice(0, 500),
          url: username
            ? "https://x.com/" + encodeURIComponent(username) + "/status/" + encodeURIComponent(id)
            : "https://x.com/i/web/status/" + encodeURIComponent(id),
          sourceName: "X",
          publishedAt: Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null,
          excerpt: text.slice(0, 2000),
          provider: "x-api",
          contentType: "social_post",
          author,
          language: post.lang ?? null,
          externalId: id,
          engagement: {
            likes: post.public_metrics?.like_count ?? 0,
            reposts: post.public_metrics?.repost_count ?? 0,
            replies: post.public_metrics?.reply_count ?? 0,
            quotes: post.public_metrics?.quote_count ?? 0,
            bookmarks: post.public_metrics?.bookmark_count ?? 0
          }
        });
        if (results.length >= (input.maxResults ?? 10)) break;
      }
      console.info("[NewsForMe][X] recent search completed", {
        returned: payload.data?.length ?? 0,
        accepted: results.length,
        query
      });
      return results;
    }
  };
}
