# News collection sources and diagnostics

## Active sources

| Source | Authentication | Purpose | Notes |
| --- | --- | --- | --- |
| Google News RSS | None | Korean Google News RSS search | Retries transient HTTP 429/5xx responses up to two times after the first request. Google may still return an HTML interstitial or HTTP 503. |
| Bing News RSS | None | News search RSS | When the first query returns fewer than requested, it retries with the topic-only query and merges non-duplicate results. This is an unofficial RSS surface and may change. |
| GDELT DOC API | None | Additional global news articles | Searches the last seven days across multilingual coverage. Uses topic/include terms first, then the topic-only query if the target is not reached. It does not discard a valid content-level match solely because the headline omits the term. |
| YouTube Data API | Existing YouTube integration or Worker secret | Related video results | Video results count toward the requested collection maximum. |
| GitHub Search | Public API | Repository discovery for software/technology topics | Skipped for unrelated topics. |
| V2EX Public API | Public API | Developer discussions for software/technology topics | Skipped for unrelated topics. |
| X / Threads | Existing access tokens | Social posts | Skipped when the corresponding token is unavailable. |

The collector requests up to the configured maximum from each eligible source, merges results in round-robin order, canonicalizes URLs, removes cross-source duplicates, and stops at the requested maximum. If all providers together do not return enough unique relevant items, the run completes with a shortfall count instead of pretending the target was reached.

## YouTube Data API retention

YouTube API search results are tracked with a provider-data refresh timestamp. A video returned by a later YouTube search refreshes that timestamp and its provider metadata. Video title/description metadata is excluded from AI summarization and interest-profile analysis. Migration 0011 also removes previously stored Naver Search API results and their dependent saved/feed records. Existing YouTube-derived summaries, behavior events, and generated interest profiles are cleared; interest profiles can be rebuilt from non-YouTube signals. Rows that have not been refreshed for 29 days are removed, including dependent feed links and saved-item metadata. The hourly Worker cleanup uses a one-day safety margin against the 30-day YouTube API data retention limit.

Set `YOUTUBE_API_KEY` only when YouTube collection is intentionally enabled. The API source is skipped when the key is unavailable.

## Reading collection diagnostics

The collection run's diagnostic text is shown below the topic's latest collection status. It includes:

- Requested count, actual unique collection count, and shortfall.
- Per-source fetched and accepted counts.
- Rejection counters such as `topicMismatch`, `excludedKeyword`, `invalidUrl`, `missingTitle`, and `duplicateAcrossQueries`, plus observations such as `titleNotMatched` for GDELT body-level matches.
- Cross-source duplicate and invalid URL counts.
- Provider request failures and sources skipped because credentials or topic eligibility are missing.

A source that returns a plain item array (rather than structured diagnostics) is counted as accepted, but does not claim to know its internal rejection reasons.

## Operational notes

- Provider results are external and can be unavailable, rate-limited, or inconsistent. The collector should never promise an exact count when enough unique results do not exist.
- Google RSS transient errors are retried, but permanent errors are surfaced with HTTP status and a short response preview.
- Bing and GDELT broaden their query when the initial search is insufficient. GDELT searches article content, so a headline that omits the query term is recorded as an observation rather than rejected.
- The app's topic relevance and exclusion filters remain the final gate for every source. When a source has results but few are accepted, inspect `topicMismatch` and `excludedKeyword` before loosening filters.
