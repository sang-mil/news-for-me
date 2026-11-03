# Cloudflare 운영 배포 및 Google 로그인

이 문서는 News for Me를 Cloudflare Pages + Pages Functions + Workers + D1 + Queues로 운영하는 절차입니다.

## 운영 구조

- Pages: React/Vite 화면 정적 호스팅
- Pages Functions: /api/*를 Worker Service Binding으로 전달. 브라우저 기준 API와 Google OAuth 쿠키는 같은 출처를 사용
- Worker: 뉴스 수집·요약·스크랩·태그·뉴스레터 API
- D1: 사용자, 관심 주제, 기사, 요약, 스크랩, Better Auth 세션/계정
- Queues: RSS 수집 후 비동기 AI 요약
- Cron: 주간 미스크랩 기사 정리

운영에서는 ALLOW_DEV_AUTH를 절대 설정하지 않습니다. Google에서 이메일 확인이 끝난 AUTH_ALLOWED_EMAIL 계정만 앱 데이터에 접근할 수 있습니다.

## 중요한 데이터 보존 규칙

첫 Google 로그인에서 LEGACY_USER_ID에 기존 D1 users.id를 지정하면, 해당 행에 Google 인증 ID를 연결합니다. 기존 users.id는 바꾸지 않습니다. 따라서 그 ID를 참조하는 관심 주제·스크랩·메모·태그·발송 로그가 유지됩니다.

첫 로그인 때 users.email은 Google에서 확인된 이메일로 갱신됩니다. 이 이메일이 다른 사용자 행에서 이미 사용 중이면 연결을 중단합니다. 데이터를 삭제하거나 다른 계정으로 합치지 않습니다.

운영 D1을 만들기 전에 로컬 D1 백업을 보관하세요. 새 운영 DB가 빈 상태라면 로컬 데이터를 내보내서 이전한 후 인증을 연결해야 합니다.

## 1. Google OAuth 앱 설정

Google Cloud Console에서 News for Me가 사용하는 프로젝트의 OAuth 2.0 Web application Client를 선택합니다.

Authorized JavaScript origins:

~~~text
https://news-for-me.pages.dev
~~~

Authorized redirect URIs:

~~~text
https://news-for-me.pages.dev/api/auth/callback/google
~~~

추후 Cloudflare Pages에 커스텀 도메인을 연결하면 두 항목을 커스텀 도메인으로 바꾸고, Worker의 BETTER_AUTH_URL과 ALLOWED_ORIGIN도 동일한 도메인으로 변경합니다.

현재 Gmail 발송에 쓰는 Google OAuth Client ID/Secret을 로그인에도 재사용합니다. Better Auth 로그인은 기본 Google 프로필 권한만 사용하고, Gmail Refresh Token은 테스트 메일 발송용으로 별도 유지합니다.

OAuth 동의 화면이 아직 Testing이라면 Google Auth Platform의 Test users에 AUTH_ALLOWED_EMAIL 계정을 추가하세요. 이 상태에서 gmail.send 권한으로 발급한 Gmail Refresh Token은 7일 후 만료될 수 있습니다. 이는 Google 로그인 세션과 별개의 문제이며, 정기 뉴스레터 발송을 운영하려면 브랜딩·게시 및 필요한 Google 검증을 마친 뒤 Gmail Refresh Token을 새로 발급해야 합니다.

## 2. Cloudflare 리소스 생성

**기존 로컬 데이터를 운영 DB로 옮길 계획이라면, 반드시 D1 ID를 바꾸기 전에 로컬 DB를 먼저 내보내세요.** Wrangler 로컬 D1은 설정의 database_id에 연결되므로 운영 ID로 교체한 뒤에는 기존 로컬 DB 대신 새 로컬 저장소를 바라볼 수 있습니다.

PowerShell에서 Worker 디렉터리로 이동해 내보냅니다.

~~~powershell
Set-Location C:\dev\news-for-me\apps\worker
npx wrangler d1 export news-for-me-db --local --no-schema --output .\local-news-data.sql
~~~

내보낸 SQL을 열어 users와 앱 데이터의 INSERT 문만 포함되어 있는지 확인하세요. 이 파일은 비밀값은 아니지만 개인 뉴스/메모가 포함될 수 있으므로 Git에 올리지 마세요.

PowerShell에서 저장소 루트로 이동합니다.

~~~powershell
Set-Location C:\dev\news-for-me
~~~

Cloudflare에 로그인합니다.

~~~powershell
npx wrangler login
~~~

운영 D1을 생성합니다.

~~~powershell
npx wrangler d1 create news-for-me-db
~~~

출력된 database_id를 복사해 apps/worker/wrangler.jsonc의 d1_databases[0].database_id를 교체합니다. 저장소에 있던 00000000-0000-4000-8000-000000000001은 로컬 개발용 placeholder입니다. 운영에 그대로 쓰면 안 됩니다.

Queue 두 개를 생성합니다.

~~~powershell
npx wrangler queues create news-for-me-collection
npx wrangler queues create news-for-me-collection-dlq
~~~

운영 Worker에 스키마를 적용합니다.

~~~powershell
Set-Location C:\dev\news-for-me\apps\worker
npx wrangler d1 migrations apply news-for-me-db --remote
~~~

이 명령은 D1의 테이블/인덱스만 생성합니다. 기존 로컬 기사는 자동 복사되지 않습니다.

## 3. 기존 로컬 데이터 이전

로컬 내보내기 파일이 앞 단계에서 준비되어 있다면 운영 DB로 가져옵니다.

이 SQL을 운영 DB에 적용합니다.

~~~powershell
npx wrangler d1 execute news-for-me-db --remote --file .\local-news-data.sql
~~~

내보내기 SQL이 users와 앱 데이터 INSERT만 포함하는지 먼저 열어 확인하세요. 운영 DB의 테이블 생성은 앞 단계의 migration으로 수행한 상태여야 합니다. SQL을 확인하지 않고 운영 DB에 실행하지 마세요.

기존 데이터를 이전하지 않을 계획이라면 이 단계는 건너뛸 수 있습니다. 다만 LEGACY_USER_ID도 설정하지 않습니다.

## 4. 운영 Worker 비밀값 설정

Worker 디렉터리에서 실행합니다.

~~~powershell
Set-Location C:\dev\news-for-me\apps\worker
~~~

필요한 비밀값을 하나씩 등록합니다. 명령을 실행하면 터미널에서 값을 입력하라는 메시지가 표시됩니다.

~~~powershell
npx wrangler secret put BETTER_AUTH_SECRET
npx wrangler secret put GOOGLE_CLIENT_ID
npx wrangler secret put GOOGLE_CLIENT_SECRET
npx wrangler secret put AUTH_ALLOWED_EMAIL
npx wrangler secret put LEGACY_USER_ID
npx wrangler secret put AUTH_MIGRATION_TOKEN
npx wrangler secret put GEMINI_API_KEY_1
npx wrangler secret put GEMINI_API_KEY_2
npx wrangler secret put OPENROUTER_API_KEY
npx wrangler secret put GOOGLE_REFRESH_TOKEN
npx wrangler secret put GMAIL_SENDER
~~~

BETTER_AUTH_SECRET과 AUTH_MIGRATION_TOKEN은 각각 별도의 강한 랜덤 값이어야 합니다. GOOGLE_CLIENT_ID/SECRET은 위에서 지정한 OAuth Client와 일치해야 합니다.

AUTH_ALLOWED_EMAIL은 로그인할 Google 계정 이메일입니다. GMAIL_SENDER도 같은 주소여야 테스트 뉴스레터를 보낼 수 있습니다.

LEGACY_USER_ID는 데이터를 이전한 경우 기존 운영 D1의 users.id입니다. 값이 틀리면 첫 로그인 데이터 연결이 실패합니다.

OpenRouter를 사용하지 않는다면 OPENROUTER_API_KEY 등록은 생략할 수 있습니다. GMAIL_SENDER는 로그인 허용 주소(AUTH_ALLOWED_EMAIL)와 동일하게 설정합니다.

GEMINI_PROJECT_SLOT_1과 GEMINI_PROJECT_SLOT_2는 Secret이 아닌 일반 변수로 등록하세요. 두 Gemini 키가 같은 Google Cloud 프로젝트에서 발급됐다면 같은 슬롯 이름을 쓰고, 서로 다른 프로젝트라면 각 프로젝트를 구분하는 고유한 라벨을 사용합니다. 로컬 .dev.vars.example의 google-project-a/b는 예시 문자열일 뿐 실제 프로젝트 구성을 반영하지 않습니다.

일반 변수 BETTER_AUTH_URL과 ALLOWED_ORIGIN은 Worker Wrangler 설정에 들어 있습니다.

- BETTER_AUTH_URL=https://news-for-me.pages.dev
- ALLOWED_ORIGIN=https://news-for-me.pages.dev

GMAIL_SENDER는 Worker 대시보드의 Variables 또는 Secret로 등록합니다. 코드상 테스트 발송 수신자는 로그인한 이메일로 고정되어 있으며, 다른 주소를 클라이언트가 지정할 수 없습니다.

## 5. Worker 배포

~~~powershell
Set-Location C:\dev\news-for-me\apps\worker
npx wrangler deploy
~~~

Worker 설정의 workers_dev: false는 Worker의 공개 workers.dev 주소를 비활성화합니다. Pages Service Binding을 통해서만 호출하게 하기 위한 설정입니다.

## 6. Pages 배포

저장소 루트에서 의존성을 설치하고 빌드합니다.

~~~powershell
Set-Location C:\dev\news-for-me
npm install
npm run typecheck:web
npm run typecheck:api
npm run build
~~~

이후 Pages 프로젝트를 생성합니다(이미 존재하면 생략).

~~~powershell
npx wrangler pages project create news-for-me --production-branch main
~~~

Pages 디렉터리에서 배포합니다.

~~~powershell
Set-Location C:\dev\news-for-me\apps\web
npx wrangler pages deploy .\dist --project-name news-for-me
~~~

Pages Wrangler 설정에는 NEWS_API Service Binding이 선언되어 있습니다. 이 binding이 news-for-me-api Worker를 가리키므로 /api/* 요청이 같은 도메인으로 전달됩니다. Dashboard를 사용할 경우 Pages 프로젝트 > Settings > Bindings > Service binding에서 변수명 NEWS_API, Worker news-for-me-api를 설정하고 재배포해야 합니다.

## 7. Better Auth D1 테이블 생성

Worker와 Pages가 배포된 후 Pages 도메인으로 보호된 일회성 마이그레이션 endpoint를 호출합니다.

AUTH_MIGRATION_TOKEN에 등록한 값을 PowerShell 변수에 넣고 실행합니다.

~~~powershell
$token = Read-Host "AUTH_MIGRATION_TOKEN"

Invoke-RestMethod `
  -Method Post `
  -Uri "https://news-for-me.pages.dev/api/_internal/auth-migrate" `
  -Headers @{ Authorization = "Bearer $token" }
~~~

성공하면 Better Auth D1 schema is ready.가 반환됩니다. 이 endpoint는 강한 토큰이 없으면 404를 반환합니다. 마이그레이션이 끝난 다음 Cloudflare에서 AUTH_MIGRATION_TOKEN Secret을 삭제하거나 교체하는 것을 권장합니다.

## 8. Google 로그인을 위한 마지막 확인

- Pages URL이 실제로 https://news-for-me.pages.dev인지 확인합니다.
- Pages Function이 /api/* 경로를 Worker에 전달하는지 확인합니다.
- Google OAuth redirect URI가 https://news-for-me.pages.dev/api/auth/callback/google인지 확인합니다.
- Worker의 BETTER_AUTH_URL과 ALLOWED_ORIGIN이 실제 Pages 도메인과 일치해야 합니다.
- 운영 Worker에는 ALLOW_DEV_AUTH를 등록하지 않습니다.
- AUTH_ALLOWED_EMAIL과 Google 로그인 이메일이 일치해야 합니다.
- 기존 데이터가 있으면 LEGACY_USER_ID가 정확해야 합니다.

로그인 성공 후 GET /api/me에서 authenticated: true를 확인하고, 기존 관심 주제와 스크랩·메모·태그가 나타나는지 확인하세요.

## 9. 로컬 개발

로컬 .dev.vars에는 다음 개발 인증 변수를 유지합니다.

~~~dotenv
DEV_USER_ID=기존_로컬_사용자_ID
DEV_USER_EMAIL=기존_로컬_이메일
ALLOW_DEV_AUTH=true
ALLOWED_ORIGIN=http://127.0.0.1:5173,http://localhost:5173
BETTER_AUTH_URL=http://127.0.0.1:8787
~~~

.dev.vars.example은 예시 파일입니다. 로컬 .dev.vars에 위 값을 넣어야 하며 운영 Cloudflare 변수로 복사하지 않습니다.

## 알려진 배포 전제

현재 앱은 단일 소유자 구성으로 제한되어 있습니다. AUTH_ALLOWED_EMAIL은 한 계정만 허용하며, 여러 사람이 사용하는 공개 서비스로 확장할 때는 이 제한과 뉴스레터 수신자/예약 설정을 사용자별 구조로 변경해야 합니다.
