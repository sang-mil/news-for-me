# AI Routing

Default Gemini models:
- Primary: `gemini-3.8-flash`
- Fallback: `gemini-3.5-flash-lite`

Provider order:
1. Gemini key 1 / primary model
2. Gemini key 1 / fallback model
3. Gemini key 2 / primary and fallback models, if eligible
4. OpenRouter

Gemini quotas apply per Google Cloud project, not per API key. Set the same
`GEMINI_PROJECT_SLOT_1` and `GEMINI_PROJECT_SLOT_2` when both keys belong to
one project. After a 429 in the same or unknown project, the router will not
try the second key as a quota workaround.

OpenRouter defaults to `openrouter/free`. Other model IDs are blocked unless
`OPENROUTER_ALLOW_PAID=true`. Free OpenRouter models are rate limited.

The RSS source currently supplies article title and excerpt metadata, not the
full article body. Summaries must not invent facts beyond those fields.

Summaries are stored in D1 table `summaries` using prompt version `v1`.
Provider attempts are recorded in `api_attempt_logs`. Existing summaries are
skipped on queue retries to avoid repeated AI calls.