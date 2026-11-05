import type { CollectedNewsItem, NewsSearchInput, NewsSourceSearchResult } from "../types";
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
): Promise<NewsSourceSearchResult> {
  const terms = [...new Set([
    ...splitTerms(input.topicName),
    ...input.includeKeywords.flatMap(splitTerms)
  ])].filter((term) => term.length >= 2).slice(0, 6);
  if (terms.length === 0) return { items: [], diagnostics: { fetchedCount: 0, acceptedCount: 0, rejected: { emptyQuery: 1 } } };

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
  const rejected: Record<string, number> = {
    missingRepository: 0, invalidUrl: 0, topicMismatch: 0, excludedKeyword: 0
  };
  const repositories = payload.items ?? [];

  for (const repository of repositories) {
    const fullName = repository.full_name?.trim();
    const articleUrl = repository.html_url?.trim();
    if (!fullName || !articleUrl) {
      rejected.missingRepository += 1;
      continue;
    }

    let parsedUrl: URL;
    try { parsedUrl = new URL(articleUrl); } catch {
      rejected.invalidUrl += 1;
      continue;
    }
    if (parsedUrl.protocol !== "https:" || parsedUrl.hostname !== "github.com") {
      rejected.invalidUrl += 1;
      continue;
    }

    const description = repository.description?.trim() ?? "";
    const searchable = `${fullName} ${description} ${repository.language ?? ""}`.toLocaleLowerCase();
    if (!matchesTopicRelevance(input, searchable)) {
      rejected.topicMismatch += 1;
      continue;
    }
    if (excluded.some((keyword) => searchable.includes(keyword))) {
      rejected.excludedKeyword += 1;
      continue;
    }

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

  const rejectedCounts = Object.fromEntries(Object.entries(rejected).filter(([, count]) => count > 0));
  console.info("[NewsForMe][RSS] GitHub search completed", {
    query, returned: repositories.length, accepted: results.length, rejected: rejectedCounts
  });
  return {
    items: results,
    diagnostics: {
      fetchedCount: repositories.length,
      acceptedCount: results.length,
      rejected: rejectedCounts
    }
  };
}
