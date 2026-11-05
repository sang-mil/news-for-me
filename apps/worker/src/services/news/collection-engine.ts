import type {
  CollectionEngineResult, CollectedNewsItem, NewsSearchInput, NewsSource, SourceFailure
} from "./types";

function canonicalizeUrl(value: string): string | null {
  try {
    const url = new URL(value);
    if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username || url.password) return null;
    url.hash = "";
    for (const key of [...url.searchParams.keys()]) {
      const normalized = key.toLowerCase();
      if (normalized.startsWith("utm_") || ["gclid", "fbclid", "mc_cid", "mc_eid"].includes(normalized)) url.searchParams.delete(key);
    }
    return url.toString();
  } catch { return null; }
}

function roundRobin(
  batches: Array<{ items: CollectedNewsItem[] }>,
  limit: number
): { items: CollectedNewsItem[]; duplicateCount: number; invalidUrlCount: number } {
  const result: CollectedNewsItem[] = [];
  const seen = new Set<string>();
  const cursors = batches.map(() => 0);
  let duplicateCount = 0;
  let invalidUrlCount = 0;

  while (result.length < limit) {
    let addedInRound = false;
    for (let index = 0; index < batches.length && result.length < limit; index += 1) {
      const batch = batches[index];
      while (cursors[index] < batch.items.length) {
        const item = batch.items[cursors[index]++];
        const canonicalUrl = canonicalizeUrl(item.url);
        if (!canonicalUrl) {
          invalidUrlCount += 1;
          continue;
        }
        if (seen.has(canonicalUrl)) {
          duplicateCount += 1;
          continue;
        }
        seen.add(canonicalUrl);
        result.push({ ...item, url: canonicalUrl });
        addedInRound = true;
        break;
      }
    }
    if (!addedInRound) break;
  }

  return { items: result, duplicateCount, invalidUrlCount };
}

export async function collectFromSources(
  sources: NewsSource[],
  input: NewsSearchInput,
  maxArticles: number
): Promise<CollectionEngineResult> {
  const limit = Math.min(30, Math.max(5, Math.floor(maxArticles)));
  const settled = await Promise.allSettled(sources.map((source) => source.search({ ...input, maxResults: limit })));
  const batches: Array<{ items: CollectedNewsItem[] }> = [];
  const failures: SourceFailure[] = [];
  const sourceCounts: Record<string, number> = {};
  const sourceDiagnostics: CollectionEngineResult["sourceDiagnostics"] = {};

  settled.forEach((result, index) => {
    const source = sources[index];
    if (result.status === "fulfilled") {
      const value = result.value;
      const items = Array.isArray(value) ? value : value.items;
      const diagnostics = Array.isArray(value) ? null : value.diagnostics ?? null;
      const normalizedItems = items.map((item) => ({
        ...item,
        provider: item.provider || source.id,
        contentType: item.contentType || source.contentType
      }));
      batches.push({ items: normalizedItems });
      sourceCounts[source.id] = normalizedItems.length;
      sourceDiagnostics[source.id] = diagnostics;
      console.info("[NewsForMe][Collection] source completed", {
        source: source.id,
        contentType: source.contentType,
        articlesFound: normalizedItems.length,
        diagnostics
      });
    } else {
      const message = result.reason instanceof Error ? result.reason.message : String(result.reason);
      failures.push({ sourceId: source.id, message: message.slice(0, 300) });
      sourceCounts[source.id] = 0;
      sourceDiagnostics[source.id] = null;
      console.warn("[NewsForMe][Collection] source failed", { source: source.id, error: message });
    }
  });

  if (failures.length === sources.length) {
    throw new Error("All collection sources failed: " + failures.map((item) => item.sourceId + ": " + item.message).join(" | "));
  }

  const merged = roundRobin(batches, limit);
  const candidateCount = Object.values(sourceCounts).reduce((total, count) => total + count, 0);
  return {
    items: merged.items,
    failures,
    sourceCounts,
    sourceDiagnostics,
    mergeDiagnostics: {
      candidateCount,
      uniqueCount: merged.items.length,
      duplicateCount: merged.duplicateCount,
      invalidUrlCount: merged.invalidUrlCount
    }
  };
}
