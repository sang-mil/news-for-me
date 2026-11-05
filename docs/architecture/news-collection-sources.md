# News collection sources and diagnostics

## Active sources

| Source | Authentication | Purpose | Notes |
| --- | --- | --- | --- |
| Google News RSS | None | Korean Google News RSS search | Retries transient HTTP 429/5xx responses up to two times after the first request. Google may still return an HTML interstitial or HTTP 503. |
| Bing News RSS | None | News search RSS | When the first query returns fewer than requested, it retries with the topic-only query and merges non-duplicate results. This is an unofficial RSS surface and may change. |
| GDELT DOC API | None | Additional global news articles | Searches the last seven days across multilingual coverage. Uses topic/include terms first, then the topic-only query if the target is not reached. It does not discard a valid content-level match solely because the headline omits the term. |
| Naver News Search API | Naver application credentials | Korean news search | Optional. Enable by adding both Worker secrets below. Uses one query per topic/include term, up to five terms. |
| YouTube Data API | Existing YouTube integration or Worker secret | Related video results | Video results count toward the requested collection maximum. |
| GitHub Search | Public API | Repository discovery for software/technology topics | Skipped for unrelated topics. |
| V2EX Public API | Public API | Developer discussions for software/technology topics | Skipped for unrelated topics. |
| X / Threads | Existing access tokens | Social posts | Skipped when the corresponding token is unavailable. |

The collector requests up to the configured maximum from each eligible source, merges results in round-robin order, canonicalizes URLs, removes cross-source duplicates, and stops at the requested maximum. If all providers together do not return enough unique relevant items, the run completes with a shortfall count instead of pretending the target was reached.

## Enable Naver News Search

Naver's official News Search API requires a registered application and the `X-Naver-Client-Id` and `X-Naver-Client-Secret` request headers. The documented endpoint returns JSON or XML and supports up to 100 results per request. Its documented search API daily call limit is 25,000 requests.

Create an application and enable Search API access in the Naver Developers console. Then, from the repository root in PowerShell, set the two Cloudflare Worker secrets:

```powershell
npx wrangler secret put NAVER_CLIENT_ID --config apps/worker/wrangler.jsonc
npx wrangler secret put NAVER_CLIENT_SECRET --config apps/worker/wrangler.jsonc
```

Paste each value only into the Wrangler prompt. Do not put credentials in `wrangler.jsonc`, GitHub source files, or frontend environment variables. The secrets persist across Worker deployments. Once both secrets are configured, the next collection run automatically includes `naver-news-api`.

If credentials are absent, Naver is listed as skipped in the collection diagnostics. GDELT is enabled without any additional configuration, so it can be used immediately after deployment.

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
- Bing, GDELT, and Naver broaden their query when the initial search is insufficient. GDELT searches article content, so a headline that omits the query term is recorded as an observation rather than rejected. Naver searches topic/include variants separately and merges unique links.
- The app's topic relevance and exclusion filters remain the final gate for every source. When a source has results but few are accepted, inspect `topicMismatch` and `excludedKeyword` before loosening filters.
