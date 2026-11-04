# AI Routing

## Gemini model discovery and priority

The settings API reads the models available to the current user's Gemini API key
from `GET /v1beta/models` and keeps models that support `generateContent`.
Text-oriented Gemini and Gemma models that support generateContent are offered for news summaries.

The selected model is a priority, not an exclusive model lock:
1. Try the selected model first.
2. Try the legacy configured fallback model next, if it is eligible.
3. Try the remaining eligible models returned by the API catalog.

By default, automatic fallback is limited to models currently identified as
Free Tier in the official Gemini pricing table. Models with paid or unknown
pricing can be included only after the user explicitly enables
`allowPaidGemini`. The Gemini model catalog does not include account-specific
pricing metadata, so the app deliberately treats unknown models as not free.

The current conservative Free Tier allowlist is maintained in
`apps/worker/src/services/ai/gemini-models.ts` and must be reviewed whenever
Google changes model availability or pricing.

## Provider and key order

1. The user's saved Gemini key (or platform Gemini key 1 when no user key is saved):
   selected model, eligible catalog models, then safe fallback defaults if
   catalog discovery is temporarily unavailable.
2. Platform Gemini key 2 when configured and eligible. A 429 response skips
   a second key in the same or unknown Google Cloud project, but the router
   continues trying other eligible model IDs with the first key.
3. OpenRouter using the configured model, defaulting to `openrouter/free`.

Gemini quotas are project-scoped and can also be model-specific. Changing
models does not merge quotas or bypass project-wide limits; it only lets the
router use another model's available quota when that model has capacity.
Set the same `GEMINI_PROJECT_SLOT_1` and `GEMINI_PROJECT_SLOT_2` when both
platform keys belong to one project.

OpenRouter defaults to `openrouter/free`. Other model IDs are blocked unless
`OPENROUTER_ALLOW_PAID=true`. Free OpenRouter models are rate limited.

The RSS source currently supplies article title and excerpt metadata, not the
full article body. Summaries must not invent facts beyond those fields.

Summaries are stored in D1 table `summaries` using prompt version `v1`.
Provider attempts are recorded in `api_attempt_logs`. Existing summaries are
skipped on queue retries to avoid repeated AI calls.
