# Cloudflare 운영 배포 및 Google 로그인

이 문서는 News for Me를 Cloudflare Pages + Pages Functions + Workers + D1 + Queues로 운영하는 절차입니다.

## 운영 구조

- Pages: React/Vite 화면 정적 호스팅
- Pages Functions: /api/*를 Worker Service Binding으로 전달. 브라우저 기준 API와 Google OAuth 쿠키는 같은 출처를 사용
- Worker: 뉴스 수집·요약·스크랩·태그·뉴스레터 API
- D1: 사용자, 관심 주제, 기사, 요약, 스크랩, Better Auth 세션/계정
- Queues: RSS 수집 후 비동기 AI 요약
- Cron: 주간 미스크랩 기사 정리

운영에서는 ALLOW_DEV_AUTH를 절대 설정하지 않습니다. 이메일 확인이 완료된 Google 계정은 각각 별도의 앱 사용자로 가입할 수 있습니다. Google OAuth 앱이 Testing 상태라면 Google Auth Platform의 Test users에 허용할 계정을 등록해야 합니다.

## 중요한 데이터 보존 규칙

첫 Google 로그인에서 LEGACY_USER_ID에 기존 D1 users.id를 지정하면, Google에서 검증된 이메일과 기존 users.email이 일치할 때만 해당 행에 Google 인증 ID를 연결합니다. 기존 users.id는 바꾸지 않으므로 관심 주제·스크랩·메모·태그·발송 로그가 유지됩니다. 이메일이 일치하지 않으면 기존 계정은 건드리지 않고 신규 사용자를 생성합니다. 이 레거시 연결은 다른 신규 계정에 기존 데이터를 할당하는 용도로 사용할 수 없습니다.

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

현재 Gmail 발송에 쓰는 Google OAuth Client ID/Secret을 로그인에도 재사용합니다. Better Auth 로그인은 기본 Google 프로필 권한만 사용하고, Gmail Refresh Token은 뉴스레터 메일 발송용으로 별도 유지합니다.

OAuth 동의 화면이 아직 Testing이라면 Google Auth Platform의 Test users에 로그인할 각 테스트 계정을 추가하세요. 이 상태에서 gmail.send 권한으로 발급한 Gmail Refresh Token은 7일 후 만료될 수 있습니다. 이는 Google 로그인 세션과 별개의 문제이며, 정기 뉴스레터 발송을 운영하려면 브랜딩·게시 및 필요한 Google 검증을 마친 뒤 Gmail Refresh Token을 새로 발급해야 합니다.

## 2. Cloudflare 리소스 생성

**기존 로컬 데이터를 운영 DB로 옮길 계획이라면, 반드시 D1 ID를 바꾸기 전에 로컬 DB를 먼저 내보내세요.** Wrangler 로컬 D1은 설정의 database_id에 연결되므로 운영 ID로 교체한 뒤에는 기존 로컬 DB 대신 새 로컬 저장소를 바라볼 수 있습니다.

PowerShell에서 Worker 디렉터리로 이동해 내보냅니다.

~~~powershell
Set-Location C:\dev\news-for-me\apps\worker
New-Item -ItemType Directory -Force ..\..\.local-backups | Out-Null
npx wrangler d1 export news-for-me-db --local --no-schema --output ..\..\.local-backups\news-for-me-local-data.sql
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
npx wrangler d1 execute news-for-me-db --remote --file ..\..\.local-backups\news-for-me-local-data.sql
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
npx wrangler secret put INTEGRATION_ENCRYPTION_KEY
npx wrangler secret put GOOGLE_CLIENT_ID
npx wrangler secret put GOOGLE_CLIENT_SECRET
npx wrangler secret put LEGACY_USER_ID
npx wrangler secret put AUTH_MIGRATION_TOKEN
npx wrangler secret put GEMINI_API_KEY_1
npx wrangler secret put GEMINI_API_KEY_2
npx wrangler secret put OPENROUTER_API_KEY
npx wrangler secret put GOOGLE_REFRESH_TOKEN
npx wrangler secret put GMAIL_SENDER
~~~

BETTER_AUTH_SECRET, AUTH_MIGRATION_TOKEN, INTEGRATION_ENCRYPTION_KEY는 각각 별도의 강한 랜덤 값이어야 합니다. INTEGRATION_ENCRYPTION_KEY는 Base64로 인코딩된 32바이트 값이어야 하며, 키를 분실하거나 임의로 교체하면 기존 사용자 API 키를 복호화할 수 없습니다. GOOGLE_CLIENT_ID/SECRET은 위에서 지정한 OAuth Client와 일치해야 합니다.

PowerShell에서 암호화 키를 한 번 생성합니다. 출력된 값을 안전한 비밀 저장소에 백업하고, Worker Secret 등록 프롬프트와 로컬 apps/worker/.dev.vars에 동일한 값을 사용하세요.

~~~powershell
$rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
$bytes = New-Object byte[] 32
$rng.GetBytes($bytes)
$integrationKey = [Convert]::ToBase64String($bytes)
$rng.Dispose()
$integrationKey
~~~

같은 D1 데이터를 읽는 모든 Worker 환경은 동일한 키를 사용해야 합니다.

GMAIL_SENDER와 GOOGLE_REFRESH_TOKEN은 서버 공용 Gmail 발신 연동입니다. 발신 주소는 GMAIL_SENDER로 고정되지만, 뉴스레터 화면에서 로그인한 사용자가 수신 주소를 별도로 입력할 수 있습니다. 수신 주소가 발신 주소나 로그인 이메일과 같을 필요는 없습니다. 현재는 로그인한 사용자가 한 번에 한 명의 수신자에게 직접 발송하는 방식이며, 사용자별 Gmail OAuth 연결은 별도 작업입니다.

LEGACY_USER_ID는 데이터를 이전한 경우 기존 운영 D1의 users.id입니다. 값이 틀리면 첫 로그인 데이터 연결이 실패합니다.

Gemini, OpenRouter, YouTube, X, Threads 키는 설정 화면에서 사용자별로 등록할 수 있습니다. 기존 Worker Secret 값은 개인 키를 등록하지 않은 사용자를 위한 서버 기본값으로 남겨둘 수 있습니다. OpenRouter를 서버 기본값으로 제공하지 않는다면 OPENROUTER_API_KEY 등록은 생략할 수 있습니다.

GEMINI_PROJECT_SLOT_1과 GEMINI_PROJECT_SLOT_2는 Secret이 아닌 일반 변수로 등록하세요. 두 Gemini 키가 같은 Google Cloud 프로젝트에서 발급됐다면 같은 슬롯 이름을 쓰고, 서로 다른 프로젝트라면 각 프로젝트를 구분하는 고유한 라벨을 사용합니다. 로컬 .dev.vars.example의 google-project-a/b는 예시 문자열일 뿐 실제 프로젝트 구성을 반영하지 않습니다.

일반 변수 BETTER_AUTH_URL과 ALLOWED_ORIGIN은 Worker Wrangler 설정에 들어 있습니다.

- BETTER_AUTH_URL=https://news-for-me.pages.dev
- ALLOWED_ORIGIN=https://news-for-me.pages.dev

GMAIL_SENDER는 Worker 대시보드의 Variables 또는 Secret로 등록합니다. 이 값은 발신 주소로 사용됩니다. 수신 주소는 화면에서 사용자가 입력하며, 서버에서 이메일 형식과 단일 수신자 여부를 다시 검증합니다. 실제 발송 전 화면에 최종 수신 주소를 표시하고 확인을 받습니다.

## 사용자별 API 연동 설정

`INTEGRATION_ENCRYPTION_KEY`를 Worker Secret으로 설정한 뒤 마이그레이션을 적용하고 Worker를 배포하세요. 로그인한 사용자는 앱의 `연동 설정`에서 Gemini, OpenRouter, Threads, X, YouTube 키를 개별 등록·교체·삭제하고 연결 테스트를 실행할 수 있습니다. API 키 원문은 다시 조회할 수 없으며, Worker에서 AES-256-GCM으로 암호화한 뒤 D1에 저장합니다. 사용자별 키가 서버 기본 Worker Secret보다 우선하며, 저장된 연동을 비활성화하면 해당 사용자의 서버 기본 키 fallback도 차단됩니다.

X 연결 테스트는 최근 검색 API를 호출할 수 있으므로 X API 사용량 또는 비용이 발생할 수 있습니다. YouTube 연결 테스트도 소량의 quota를 사용합니다.

### D1에서 user_integrations 테이블이 없다고 나오는 경우

API 키 저장 시 `D1_ERROR: no such table: user_integrations`가 발생하면 Worker가 연결된 운영 D1에 `0007_user_integrations.sql` 마이그레이션이 적용되지 않았거나, Worker의 DB 바인딩이 다른 D1을 가리키는 것입니다. API 키를 다시 입력해도 해결되지 않습니다.

저장소 루트의 PowerShell에서 아래 배포 스크립트를 실행할 수 있습니다.

~~~powershell
Set-Location C:\dev\news-for-me
.\scripts\Deploy-NewsForMe-Worker.ps1
~~~

스크립트는 `apps/worker/wrangler.jsonc`의 DB 바인딩 이름과 ID를 먼저 보여주고, 원격 D1 백업을 `.local-backups`에 저장한 뒤 마이그레이션 목록을 출력합니다. 목록에서 `0001`~`0006`이 적용되었고 `0007_user_integrations.sql`만 대기 중인지 직접 확인한 경우에만 `APPLY-PENDING`을 입력하세요. 스크립트는 테이블 존재 여부를 검증하기 전에는 Worker를 배포하지 않습니다.

직접 수동으로 진행하려면 Worker 폴더에서 먼저 다음 명령을 실행합니다.

~~~powershell
Set-Location C:\dev\news-for-me\apps\worker
npx wrangler d1 migrations list news-for-me-db --remote
~~~

`0001`~`0006`이 적용되었고 `0007_user_integrations.sql`만 대기 중인 것을 확인한 후에만 적용합니다.

~~~powershell
npx wrangler d1 migrations apply news-for-me-db --remote
npx wrangler d1 execute news-for-me-db --remote --command "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'user_integrations';"
~~~

마지막 조회 결과에 `user_integrations`가 나와야 합니다. 결과가 없거나 마이그레이션 목록에는 0007이 이미 적용된 것으로 나오면 추가 SQL을 임의로 실행하지 마세요. `apps/worker/wrangler.jsonc`의 `d1_databases[0].database_id`와 Cloudflare Dashboard의 D1 데이터베이스 ID, Worker의 `DB` 바인딩이 모두 같은지 확인해야 합니다.


## 서버 기본 뉴스 수집 소스 (선택)

개별 사용자가 키를 등록하지 않은 경우를 위해 기존 Worker Secret을 공유 기본값으로 남겨둘 수 있습니다. 사용자가 개인 키를 저장한 서비스는 해당 키를 우선 사용합니다.

~~~powershell
npx wrangler secret put YOUTUBE_API_KEY
npx wrangler secret put X_BEARER_TOKEN
npx wrangler secret put THREADS_ACCESS_TOKEN
~~~

두 값은 로컬 `.dev.vars` 또는 Cloudflare Worker Secret으로만 관리하고 프론트엔드 변수나 저장소에 넣지 마세요. YouTube Data API `search.list`의 기본 할당량은 100회/일입니다. X는 현재 게시물 읽기 리소스당 과금되며 공개 단가는 게시물 1건당 USD 0.005입니다. X 최근 검색 API는 요청당 최소 10개 결과를 요구하므로, X 개발자 콘솔에서 사용 한도와 지출 한도를 설정하세요.

GitHub 저장소와 V2EX는 개발/기술 관련 주제에서만 검색합니다. 뉴스, YouTube, X 결과는 주제명 또는 포함 키워드와 실제 텍스트가 일치하는 경우에만 저장됩니다.

Threads는 Meta Threads API `keyword_search`를 사용합니다. Meta 앱에서 Threads API 사용 사례를 설정하고 OAuth 사용자 토큰에 `threads_basic` 및 승인된 `threads_keyword_search` 권한을 요청하세요. 공개 게시물 키워드 검색은 Meta 앱 검토 승인이 필요할 수 있으며, 승인 전에는 공개 검색 결과가 제한될 수 있습니다. 토큰은 프론트엔드에 전달하지 말고 Worker Secret `THREADS_ACCESS_TOKEN`으로만 저장하세요. 사용자 액세스 토큰의 만료 시점을 관리하고 만료 전에 갱신해야 합니다.

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
- 로그인은 이메일 확인이 완료된 Google 계정에서 가능하며, 기존 D1 사용자 데이터는 기존 이메일과 일치할 때만 자동 연결됩니다.
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

앱 데이터와 Gemini, OpenRouter, Threads, X, YouTube 연동 키는 사용자별로 분리됩니다. Gmail 발송은 서버 공용 OAuth Refresh Token과 GMAIL_SENDER를 사용하며, 로그인한 사용자는 자신의 뉴스 브리핑을 원하는 단일 수신 주소로 발송할 수 있습니다. 발신 주소와 로그인 이메일이 같을 필요는 없습니다. 사용자별 Gmail OAuth 연결은 별도 작업입니다.
