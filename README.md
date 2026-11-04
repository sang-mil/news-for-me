# News for Me

관심 주제를 기준으로 뉴스, 개발 프로젝트, 커뮤니티 토론, YouTube 영상을 수집하고, Gemini 기반 AI 요약을 만든 뒤 개인 뉴스 아카이브와 이메일 브리핑으로 관리하는 뉴스룸입니다.

## 주요 기능

- 관심 주제 및 포함/제외 키워드 관리
- Google News RSS 및 Bing News RSS 수집
- GitHub 저장소와 V2EX 토론은 개발·기술 주제에서만 수집
- YouTube 동영상, X 게시물, Threads 게시물 수집(각 API 토큰 설정 시 선택 활성화)
- 주제/포함 키워드가 제목·본문에 실제로 일치하지 않는 결과는 제외
- Cloudflare Queues 기반 비동기 AI 요약
- 관심 주제별 기사 목록
- 스크랩, 개인 메모, 사용자 태그와 검색/필터
- 최근 AI 요약 뉴스레터 미리보기와 로그인 이메일로 Gmail 즉시 발송
- Google OAuth 다중 사용자 로그인과 사용자별 D1 데이터 분리
- Gemini, OpenRouter, Threads, X, YouTube API 키의 사용자별 설정 및 AES-GCM 암호화 저장
- 매주 미스크랩 뉴스 정리

## 기술 구성

- Frontend: React, Vite, TypeScript
- API: Cloudflare Workers
- Hosting/API proxy: Cloudflare Pages + Pages Functions Service Binding
- Database: Cloudflare D1
- Background jobs: Cloudflare Queues
- AI: Gemini / OpenRouter
- Email: Gmail API

## Local development

~~~powershell
npm install
~~~

Copy `apps/worker/.dev.vars.example` to `apps/worker/.dev.vars`, then fill in the local developer ID/email and API credentials. Set a persistent Base64-encoded 32-byte `INTEGRATION_ENCRYPTION_KEY` before saving per-user credentials. Keep `ALLOW_DEV_AUTH=true` only in the local `.dev.vars` file.

YouTube collection is optional. Enable YouTube Data API v3 in a Google Cloud project, create an API key, and add `YOUTUBE_API_KEY` to `apps/worker/.dev.vars`. Restrict the key to the YouTube Data API v3 and keep it out of source control. Without this key, other collection sources continue to work normally.

X post collection is also optional. Each signed-in user can save an X API Bearer Token in Settings → Service integrations. The Worker `X_BEARER_TOKEN` secret remains available as a shared server default for users who have not saved a personal key. X uses pay-per-usage billing and post reads are currently listed at USD 0.005 per returned post; a recent-search call requires at least 10 results, so control usage and set a spending limit in the X Developer Console. Without the token, X is shown as skipped in collection diagnostics.

Threads collection is optional. Each signed-in user can save a Threads user access token in Settings → Service integrations. Create a Meta app with the Threads use case and obtain a user token with `threads_basic` and the approved `threads_keyword_search` permission. The Worker `THREADS_ACCESS_TOKEN` secret remains available as a shared server default. Public keyword search is subject to Meta App Review; without approval, public search may be restricted to the authorized account's own content. Keep the token server-side and refresh/replace it before it expires.

GitHub and V2EX are only queried for software/developer/technology topics to avoid filling unrelated topics (for example, sports) with repository links. All active sources also pass a topic/include-keyword relevance check before their results are stored.

~~~powershell
npm run typecheck:web
npm run typecheck:api
npm run build
npm run dev
~~~

## Production deployment

Read [Cloudflare deployment and Google authentication](docs/deployment/cloudflare-google-auth.md) before creating remote resources. Production uses Google sign-in; the local development identity flag must never be configured in Cloudflare.

For production YouTube collection, add the key as a Worker secret:

~~~powershell
npx wrangler secret put YOUTUBE_API_KEY --config .\apps\worker\wrangler.jsonc
npx wrangler secret put X_BEARER_TOKEN --config .\apps\worker\wrangler.jsonc
~~~

## Security notes

- Never commit `.dev.vars`, OAuth secrets, API keys, refresh tokens, encryption keys, or migration tokens.
- User API credentials are encrypted with AES-256-GCM before being stored in D1. Back up `INTEGRATION_ENCRYPTION_KEY` securely; losing it makes saved user credentials permanently unreadable.
- Gemini, OpenRouter, Threads, X, and YouTube user credentials are isolated by application user ID. User-saved credentials override server defaults; disabling a saved integration disables that provider for that user.
- Production app APIs require a verified Google identity.
- The first Google sign-in links the configured legacy D1 user only when the verified Google email matches that existing user's email; otherwise a new app user is created.
- Public deployment requires production D1/Queue resources and Google OAuth callback configuration.
