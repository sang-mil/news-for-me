# User integrations acceptance checks

Run the automated encryption unit tests and the existing typecheck/build scripts before reviewing the feature.

## Automated tests

- npm run test:unit
- npm run typecheck:web
- npm run typecheck:api
- npm run build

## D1 and Worker setup

1. Back up the target D1 database.
2. Generate one persistent Base64-encoded 32-byte value and set it as the Worker secret INTEGRATION_ENCRYPTION_KEY.
3. Apply migration 0007_user_integrations.sql to the intended D1 database.
4. Deploy the Worker with the same encryption key in every environment that reads that database.
5. Do not rotate or delete the encryption key without first re-encrypting every stored credential.

## Multi-user isolation

1. Sign in with Google account A and create a topic.
2. Sign out and sign in with Google account B.
3. Confirm account B has no access to account A's topics, saved items, tags, or integration status.
4. Save a provider credential for account A; confirm account B does not see it.
5. Confirm a verified email matching the legacy D1 user preserves the existing users.id and its related data.
6. Confirm a different verified email creates a new user and cannot claim the legacy user's row.

## Provider settings

For each provider (Gemini, OpenRouter, Threads, X, YouTube):

1. Save a personal credential and a provider configuration.
2. Reload the page; confirm the credential is masked and not returned by the API.
3. Run the connection test and verify the status timestamp changes.
4. Disable the integration and run a collection; confirm that provider is skipped for this user, even when a server default secret exists.
5. Re-enable it and confirm the personal credential overrides the server default.
6. Delete the personal credential and confirm the UI reports the configured server default, if present.

X validation performs a recent-search request and may incur provider usage charges. YouTube validation consumes API quota. Use test credentials and review the provider billing/usage console.

## Queue and AI pipeline

1. Create a topic under account A and start a collection.
2. Confirm the Queue message contains only the existing job identifiers and does not contain API credentials.
3. Confirm the consumer resolves the integration using job.userId.
4. Confirm personal Gemini/OpenRouter settings are used for summaries.
5. Confirm a user's disabled or missing provider configuration does not change another user's pipeline.
6. Confirm RSS, Bing News, GitHub (technology topics), and V2EX (technology topics) continue working without user API keys.

## Known scope boundary

Gmail still uses the existing server-level OAuth refresh token and sender. User-specific Gmail OAuth is not part of this change.
