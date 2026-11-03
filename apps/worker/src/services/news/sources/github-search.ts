import type { CollectedNewsItem, NewsSearchInput } from "../types";
import { matchesTopicRelevance } from "../relevance";

interface GitHubRepository {
  full_name?: string;
  html_url?: string;
  description?: string | null;
  language?: string | null;
  stargazers_count?: number;
  updated_at?: string;
}

interface GitHubSearchResponse {
  items?: GitHubRepository[];
}

function splitTerms(value: string): string[] {
  return value.split(/[,，;；|]+/)
    .map((term) => term.replace(/["\\]/g, " ").replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

export async function searchGitHubRepositories(
  input: NewsSearchInput,
  maxResults = input.maxResults ?? 10
): Promise<CollectedNewsItem[]> {
  const terms = [...new Set([
    ...splitTerms(input.topicName),
    ...input.includeKeywords.flatMap(splitTerms)
  ])].filter((term) => term.length >= 2).slice(0, 6);
  if (terms.length === 0) return [];

  const query = `${terms.map((term) => `"${term}"`).join(" OR ")} in:name,description`;
  const url = new URL("https://api.github.com/search/repositories");
  url.searchParams.set("q", query);
  url.searchParams.set("sort", "updated");
  url.searchParams.set("order", "desc");
  url.searchParams.set("per_page", String(Math.min(30, Math.max(5, maxResults))));

  const response = await fetch(url.toString(), {
    headers: {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "NewsForMe/0.1 (+https://news-for-me.pages.dev)"
    },
    signal: AbortSignal.timeout(10_000)
  });
  if (!response.ok) {
    const detail = (await response.text()).replace(/\s+/g, " ").slice(0, 180);
    throw new Error(`GitHub repository search returned HTTP ${response.status}: ${detail}`);
  }

  const payload = await response.json() as GitHubSearchResponse;
  const excluded = input.excludeKeywords.map((term) => term.toLocaleLowerCase()).filter(Boolean);
  const results: CollectedNewsItem[] = [];

  for (const repository of payload.items ?? []) {
    const fullName = repository.full_name?.trim();
    const articleUrl = repository.html_url?.trim();
    if (!fullName || !articleUrl) continue;

    let parsedUrl: URL;
    try { parsedUrl = new URL(articleUrl); } catch { continue; }
    if (parsedUrl.protocol !== "https:" || parsedUrl.hostname !== "github.com") continue;

    const description = repository.description?.trim() ?? "";
    const searchable = `${fullName} ${description} ${repository.language ?? ""}`.toLocaleLowerCase();
    if (!matchesTopicRelevance(input, searchable)) continue;
    if (excluded.some((keyword) => searchable.includes(keyword))) continue;

    const timestamp = repository.updated_at ? Date.parse(repository.updated_at) : Number.NaN;
    const stars = typeof repository.stargazers_count === "number" && Number.isFinite(repository.stargazers_count)
      ? repository.stargazers_count
      : 0;
    const details = [
      repository.language ? `언어: ${repository.language}` : null,
      `Stars: ${stars.toLocaleString("en-US")}`
    ].filter(Boolean).join(" · ");

    results.push({
      title: `GitHub: ${fullName}`,
      url: parsedUrl.toString(),
      sourceName: "GitHub",
      publishedAt: Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null,
      excerpt: [description, details].filter(Boolean).join(" · ").slice(0, 2000) || null,
      provider: "github-search",
      contentType: "repository",
      externalId: fullName,
      language: repository.language ?? null,
      engagement: { stars, updatedAt: repository.updated_at ?? null }
    });
    if (results.length >= maxResults) break;
  }

  console.info("[NewsForMe][RSS] GitHub search completed", {
    query, returned: payload.items?.length ?? 0, accepted: results.length
  });
  return results;
}
