# MILDO OS Cloud — SaaS 구현 명세

목표: 월 500만원 이상을 내도 아깝지 않은 마케팅 운영 SaaS. 기존 MILDO OS(10개 모듈 · MILDO Agent, 클라이언트 전용 데모)를
**실데이터 연동 · 매체 반영 · 24시간 운영 · 다중 사용자 · 성과 증명**을 갖춘 서버 제품으로 만든다.

가치 판단 기준(사용자 원칙): CAC · CPA · ROAS · CVR · 볼륨 · 확장성. 모든 판정에 전제 조건 · 수치 기준 · 반례를 붙이고,
확정 팩트 / 반복 관측 패턴 / AI 해석을 섞지 않는다. 화면 문구는 번호 매기기 없이, 감정 표현 없이.

## 0. 전제와 정직성 규칙

- 매체 · 판매 채널 실계정 자격증명은 이 개발 환경에 없다. 커넥터는 **공식 API 문서대로 구현**하고, 문서에서 만든 응답 픽스처로 단위 테스트한다.
  실호출 검증 전 커넥터는 화면 · 문서에 '실계정 연결 전 확인 필요'로 표기한다. 문서에서 확인하지 못한 엔드포인트 · 필드는 지어내지 말고 TODO와 근거 부족을 적는다.
- 매체 반영(write-back)의 기본값은 **dry_run**(호출 내용을 기록만 하고 보내지 않음). 워크스페이스 관리자가 커넥션별로 live를 켜야 실제 호출한다.
- 데모(artifact · 정적 호스팅) 모드는 지금과 똑같이 동작해야 한다. 기존 단위 테스트 948개 · E2E 916개 항목(`npm test`, `npm run e2e`)이 계속 통과해야 한다.

## 1. 구조

```
src/            프런트엔드 (React) — 기존 모듈 + src/saas/(서버 모드 플랫폼) + 관리 모듈(src/modules/<admin id>/)
server/
  migrations/   NNN_*.sql (파일명 순서로 적용). 001_core.sql = 기반 스키마. 도메인별 추가 마이그레이션 번호 대역은 §4
  src/
    config.ts           환경변수
    db/                 pool.ts(쿼리 · 트랜잭션) · migrate.ts(러너) · cli.ts(migrate/seed)
    lib/                crypto(비밀번호 scrypt · 비밀값 AES-256-GCM) · errors · time(KST) · ids · validate
    http/app.ts         buildApp() — Fastify 인스턴스(쿠키 · CSRF · 보안 헤더 · 에러 처리 · 요청 컨텍스트 · 도메인 플러그인 등록)
    auth/ tenancy/ audit/ events/ jobs/     ← 기반(코어)
    connectors/ ingest/ warehouse/          ← 데이터
    changes/ alerts/ reports/ impact/ ai/ settings/ team/   ← 도메인
    domains.ts          도메인 플러그인 · 잡 등록 목록 (코어가 소유, 도메인은 자기 index.ts만 채운다)
    index.ts            API 서버 시작 (프로덕션: dist 정적 파일도 서빙)
    worker.ts           워커 시작 (잡 큐 · 스케줄러)
  test/               서버 테스트 헬퍼 (실제 PostgreSQL)
deploy/              Dockerfile · docker-compose · 운영 문서
```

- 서버는 프런트의 순수 엔진을 그대로 import한다(`@/modules/alert/engine`, `@/modules/adpilot/engine`, `@/modules/flow/engine`, `@/modules/reports/engine`, `@/data/constants` 등).
  React · DOM · window를 쓰는 파일은 서버에서 import 금지.
- 런타임: Node 22, TypeScript, Fastify 5, pg, zod 4, croner, nodemailer. 개발 실행은 tsx, 배포는 esbuild 번들(`server/dist`).
- DB: PostgreSQL 16. 로컬 개발 · 테스트 인스턴스: 소켓 `/tmp`, 포트 `55432`, 사용자 `mildo`(trust). 꺼져 있으면 `npm run pg:dev`로 켠다.
  - 개발 DB: `postgres://mildo@/mildo_dev?host=/tmp&port=55432`
  - 테스트 DB: `postgres://mildo@/mildo_test?host=/tmp&port=55432` (테스트 파일마다 임시 스키마를 만들고 지운다 — `server/test/db.ts`)

## 2. 데이터 모델 (001_core.sql 요약)

테넌시: organizations → workspaces(브랜드 단위, `config jsonb`) → memberships(user × workspace × role).
역할: `owner` `admin` `pm` `ae` `client`(광고주 담당자) `viewer`.

| 역할 | 읽기 | 변경 요청 생성 | 승인 가능 등급 | 커넥션 · 설정 | 팀 관리 | live 반영 켜기 |
| --- | --- | --- | --- | --- | --- | --- |
| viewer | O | - | - | - | - | - |
| client | O | O(의견 · 요청) | AE · PM · CLIENT | - | - | - |
| ae | O | O | AE | 읽기 | - | - |
| pm | O | O | AE · PM | O | - | - |
| admin | O | O | AE · PM | O | O | O |
| owner | O | O | AE · PM · CLIENT | O | O | O |

프런트 store의 `role`(데모 3역할)로 매핑: ae·viewer → '담당 AE', pm·admin·owner → 'PM', client → '수면밀도'.
서버 모드에서는 역할 선택 드롭다운을 숨기고 실제 멤버십 역할을 쓴다. 쓰기 권한은 **서버가** 최종 판정한다.

웨어하우스(`wh_*`) = 프런트 `Dataset`(src/core/types.ts)과 1:1. 출처(`source`: 커넥션 id 또는 'csv:<업로드 id>' · 'demo')가 키에 포함되고,
Dataset 빌더가 (날짜 × 매체/채널)마다 우선순위가 가장 높은 출처 하나를 고른다(api > csv > demo).

운영: `change_requests`(ChangeRequest + execution), `incidents`(Incident 문서), `comments`, `notification_channels`, `notifications`,
`reports`, `impact_ledger`, `ai_usage`, `workspace_state`(모듈 로컬 입력의 서버 보관), `audit_log`, `jobs`, `ingest_runs`, `uploads`, `connections`.

## 3. 공통 계약

### HTTP
- 모든 API는 `/api` 아래. 워크스페이스 범위 API는 `/api/w/:ws/...` (`:ws` = workspace id).
- 인증: 세션 쿠키 `mildo_sid`(httpOnly). 쓰기 요청(POST/PUT/PATCH/DELETE)은 헤더 `x-csrf-token` = 쿠키 `mildo_csrf` 값이어야 한다.
- 라우트 안에서: `const ctx = await req.workspace('ae')` → 로그인 · 멤버십 · 최소 역할 확인 후 `{ user, workspace, role }`. 실패 시 401/403.
  로그인만 필요하면 `req.requireUser()`.
- 에러 응답: `{ error: { code, message } }` (message는 한국어). `HttpError(status, code, message)`를 던진다.
- 검증: 요청 본문은 zod 스키마로 파싱(`parseBody(schema, req.body)`).
- 모든 상태 변경은 `audit(...)`로 남긴다(누가 · 언제 · 무엇을 · 이전 → 이후).
- 변경 알림: `publish(ws, { type, id })` → PostgreSQL NOTIFY → 서버가 SSE(`GET /api/w/:ws/events`)로 같은 워크스페이스 접속자에게 전달.
  type: `change` `incident` `comment` `dataset` `connection` `report` `config` `state`.

### 잡 · 스케줄
- `registerJob(type, handler)` / `enqueue(db, { type, workspaceId, payload, runAt?, dedupeKey? })` — DB 큐(SKIP LOCKED), 실패 시 지수 백오프 재시도.
- `registerSchedule(name, cronExpr, fn)` — 워커에서 croner로 실행(KST). 스케줄 함수는 보통 활성 워크스페이스마다 잡을 enqueue한다.
- 시간은 `lib/time.ts`의 KST 헬퍼만 쓴다(`kstNow()`, `kstToday()`, `kstHour()`).

### 커넥터 (`server/src/connectors/types.ts`)
`ConnectorDef`: `provider` · `kind`('media'|'sales') · `media`(MediaId|SalesChannelId) · `credentialsSchema`(zod) · `settingsSchema` ·
`test(ctx)` · `fetch(ctx, range)` → 표준 레코드(`NormalizedBatch`) · `capabilities`(읽기 범위, 쓰기 가능 종류) · `apply?(ctx, change)` → 매체 반영.
`ctx`는 복호화된 자격증명, 설정, `http`(재시도 · 타임아웃 · 요청 로그가 붙은 fetch 래퍼), `log`, `dryRun` 여부를 담는다.
**커넥터는 DB에 직접 쓰지 않는다** — 수집 파이프라인(ingest)이 `NormalizedBatch`를 웨어하우스에 쓴다.

### 프런트 서버 모드
- `src/saas/mode.ts` `detectMode()` → `'demo' | 'server'`. claude.ai 아티팩트 · file: · `/api/health` 실패 → demo.
- `src/saas/api.ts` `api(path, { method, body })` — 쿠키 포함, CSRF 헤더 자동, 실패 시 `ApiError`.
- 서버 모드에서 store는 서버가 원본: Dataset · changes · incidents · comments를 API에서 읽고, 액션(addChange · updateChange · addIncident · updateIncident · comment)은 API로 보낸 뒤 결과로 갱신, SSE 이벤트로 다른 사용자 변경을 반영. 데모 모드 동작은 그대로.
- 관리 모듈(그룹 `admin`, 메뉴 '07 관리 · 연동'): `connections` 데이터 연결 · `team` 팀 · 권한 · `audit` 감사 로그 · `notify` 알림 설정 · `impact` 성과 증명 · `workspace` 워크스페이스 설정.
  데모 모드에서는 각 화면이 '서버 연결 시 실제로 동작' 안내와 함께 예시 상태를 읽기 전용으로 보여 준다(PT 시연용).
  각 관리 모듈도 agent.ts에 도구 ≥1개 · 오프라인 브리프 ≥1개를 둔다(registry.test.ts가 '준비 중' 모듈 0개를 검사).

## 4. 도메인별 요구사항 · 파일 소유

마이그레이션 번호 대역: team 100–149 · data(ingest/warehouse/connectors) 200–299 · changes 300–349 · alerts 350–399 · reports/impact 400–449 · ai 450–479 · settings 480–499 · platform 500–519 · devops 520–539.
각 도메인은 `server/src/<domain>/index.ts`의 `routes`(Fastify 플러그인) · `jobs`(잡 · 스케줄 등록 함수)를 채운다. `domains.ts`는 고치지 않는다.

**platform (프런트 플랫폼)** — 소유: `src/saas/**`, `src/core/store.tsx`, `src/app/**`, `src/ui/primitives.tsx`(Src 라벨), `src/ai/**`는 ai 도메인 소유이므로 제외.
로그인 화면(`#login`이 아니라 셸 밖 전체 화면), 세션 · 워크스페이스 전환, store 서버 동기화(초기 로드 · 액션 → API · SSE 반영 · 낙관적 갱신 후 실패 시 되돌림),
데이터 출처 표시(TEST DATA ↔ LIVE DATA: Dataset 메타의 출처에 따라), 서버 모드에서 클라이언트 쪽 이상 감지 · Flow 시연 이력 적재 끄기, 역할 드롭다운 숨김,
모듈 로컬 저장(`localStorage` 'mildo-os/*' 키)을 `workspace_state`로 동기화, 서버 연결 상태 · 데이터 기준 시각 표시.

**team** — 소유: `server/src/team/**`, `src/modules/team/**`, `src/modules/audit/**`. 초대(토큰 링크) · 수락 · 역할 변경 · 비활성화 · 비밀번호 변경/재설정(메일 링크) · 세션 목록/강제 종료 · 감사 로그 조회(필터 · CSV) · 마지막 owner 보호.

**data** — 소유: `server/src/connectors/{registry.ts,http.ts,credentials.ts,csv/**,demo/**}`, `server/src/ingest/**`, `server/src/warehouse/**`, `src/modules/connections/**`.
커넥션 CRUD(자격증명 암호화 저장 · 마스킹 표시) · 연결 테스트 · 수동/예약 수집(07:00 전일 확정 · 매시 10분 당일 시간대) · 백필(최대 400일) ·
CSV/XLSX가 아닌 CSV · TSV 업로드와 열 매핑(매체 일별 · 시간대 · 판매 채널 · 키워드 · 검색어 템플릿 다운로드) · 데이터 품질 검사(누락 날짜 · 중복 · 음수 · 전일 대비 급변 · 매체 합계 vs 키워드 합계) ·
수집 현황(ingest_runs) · Dataset 빌더(`buildDataset(db, wsId, { today, hour })` → src/core/types.ts Dataset, 메타: 출처별 최신 시각 · 출처 종류 live/csv/demo) ·
데모 커넥터(현재 날짜 기준으로 기존 생성기 데이터를 만든다 — 체험 · 시연용).

**connectors-media** — 소유: `server/src/connectors/{naver-sa,google-ads,meta,kakao-moment,naver-gfa}/**`.
네이버 검색광고(통계 · 키워드 · 캠페인 · 비즈머니 · 입찰가/일예산/ON-OFF 반영), Google Ads(REST, GAQL searchStream, OAuth 갱신 토큰 · 예산 · 키워드 입찰 반영),
Meta Marketing API(insights · 광고세트 예산 · 상태 반영), 카카오모먼트(보고서 · 예산 · 상태), 네이버 GFA(공개 API 확인이 안 되면 CSV 전용 + 근거 명시).
공식 문서 URL을 각 파일 머리에 적고, 응답 픽스처로 정규화 · 서명 · 반영 요청 형식을 테스트한다.

**connectors-sales** — 소유: `server/src/connectors/{naver-commerce,coupang,cafe24,ohouse}/**`.
네이버 커머스 API(브랜드스토어 주문 · 상품 · 재고), 쿠팡 Wing Open API(HMAC 서명 · 주문 · 상품), 카페24(자사몰 주문 · 상품 · 재고, OAuth), 오늘의집(공개 API 근거 없으면 CSV 템플릿).

**changes** — 소유: `server/src/changes/**`. 변경 요청 저장 · 상태 전이(Flow 규칙 — `@/modules/flow/engine`의 권한 · 가능 액션을 서버에서 재사용) ·
반영 실행기(반영 전 검증: `@/modules/adpilot/engine`의 validateAdpilotExecution · validateGfaExecution, 일일 변경 상한 20%, 최대 입찰가 · 대상 커넥션 쓰기 모드 확인 → 커넥터 `apply` 호출 또는 dry_run 기록) ·
롤백(이전 값 반영) · 대량 변경 가드(`detectBulkChange`) · 감사 · 이벤트 · API(`/api/w/:ws/changes`).

**alerts** — 소유: `server/src/alerts/**`, `src/modules/notify/**`. 서버 24시간 감지(수집 직후 + 10분마다, `@/modules/alert/engine`의 detectIncidents 재사용, 결정적 id로 중복 방지),
이슈 저장 · 갱신 API, SLA 타이머(P1 인지 15분 · 1차 조치 30분 · 결과 2시간 — 초과 시 백업 · PM 에스컬레이션), 주말 · 공휴일 당번,
알림 채널(Slack Incoming Webhook · 이메일 SMTP · 일반 웹훅, 등급 · 이벤트 필터, 테스트 발송) · 발송 이력.

**reports-impact** — 소유: `server/src/reports/**`, `server/src/impact/**`, `src/modules/impact/**`.
리포트 자동 생성 · 발송(일간 08:00 메신저 · 주간 월 10:00 메일 · 월간 익월 3영업일 · 이슈 즉시 — `@/modules/reports/engine` 재사용) · 보관함 API.
성과 증명 장부: 반영된 변경마다 반영 전 7일 vs 후 7일, 같은 매체 · 의도의 미변경 키워드를 대조군으로 증분 추정(신뢰구간 · 표본 부족 표시),
사고 방지(탐지 → 조치 시간 × 시간당 평균 매출로 추정 손실 회피, 추정임을 표기), 업무 절감(자동 수집 · 리포트 · 탐지 건수 × 제안서 기준 소요시간),
월간 가치 리포트(구독료 대비 회수 배수, 전제 · 반례 포함).

**ai** — 소유: `server/src/ai/**`, `src/ai/**`. 서버 키로 Anthropic API 호출(키는 서버 환경변수만), SSE 스트리밍, 도구는 프런트에서 실행하는 왕복 루프,
워크스페이스별 월 사용 한도 · 사용량 기록, 모델 기본 `claude-opus-5-5`, AI 모드 'server' 추가(서버 모드 기본).

**settings** — 소유: `server/src/settings/**`, `src/modules/workspace/**`, `src/data/config.ts`(신규).
워크스페이스 설정 스키마(zod) — 브랜드명 · 연 예산 · 매체 배분 · 목표 ROAS/CPA · SAFETY(일일 상한 · 최소 전환 · 이상 보류) · 위임 범위 · 데이터 시간표 · SLA · 경쟁사 · SKU 진입점 · TF · 당번 · 사용 모듈.
기본값 = 현재 constants.ts(수면밀도). `applyWorkspaceConfig(cfg)`가 constants의 내보낸 객체를 제자리 갱신(프런트 로드 시 · 서버 엔진 실행 직전). 설정 변경 이력 · 감사.

**devops** — 소유: `deploy/**`, `.github/workflows/**`, `server/src/http/security.ts`(신규). Dockerfile(멀티 스테이지) · docker-compose(app · worker · postgres) · `.env.example` ·
CI(타입 검사 · 단위 · 서버 테스트(postgres 서비스) · 빌드) · 운영 문서(배포 · 백업 · 복구 · 모니터링 · 비밀값 회전) · 헬스/레디니스 · 구조화 로그 · 우아한 종료 · 로그인 속도 제한.

## 5. 품질 기준 (모든 도메인)

- `npx tsc --noEmit -p tsconfig.json` 오류 0 (자기 파일 기준), `npx vitest run`(프런트 948+) 통과, `npm run test:server`(자기 테스트) 통과.
- 서버 테스트는 실제 PostgreSQL로: 권한(역할별 허용 · 거부), 테넌트 격리(다른 워크스페이스 데이터 접근 403/404), 입력 검증, 감사 기록, 이벤트 발행을 검사한다.
- 비밀값(자격증명 · 웹훅 URL · SMTP 비밀번호 · API 키)은 DB에 암호화 저장, API 응답 · 로그 · 감사 상세에 평문 금지(마스킹).
- 외부 호출은 `connectors/http.ts` 래퍼(타임아웃 · 재시도 · 레이트 리밋 · 요청 로그 마스킹)를 쓰고, 테스트에서는 가짜 fetch를 주입한다. 테스트 중 실제 네트워크 호출 금지.
- 화면 문구: 번호 매기기 없이, 판정에는 기준값을 옆에, 추정은 추정이라고, 데모 데이터는 TEST DATA로.

## 6. API 계약 (도메인 간 · 프런트 ↔ 서버) — 형식을 바꾸면 안 된다

모든 응답은 JSON. 목록은 `{ items }`가 아니라 아래에 적힌 키를 쓴다. `:ws` = workspace id.

| 담당 | 메서드 · 경로 | 권한 | 요청 → 응답 |
| --- | --- | --- | --- |
| core | POST /api/auth/login · POST /api/auth/logout · GET /api/auth/me | - | me: `{ user, csrfToken, workspaces[{ id, slug, name, brand_name, status, role, permissions, demoRole }] }` |
| core | GET /api/w/:ws | read | `{ workspace(config 포함), role, permissions, demoRole }` |
| core | GET /api/w/:ws/events (SSE) | read | event 이름 = type, data = `{ ws, type, id?, at }` |
| team | POST /api/w/:ws/invites `{ email, role }` · GET /api/w/:ws/invites · DELETE /api/w/:ws/invites/:id | manage_team | `{ invite, link }` (메일 발송 실패 시에도 link 반환) |
| team | GET /api/invites/:token · POST /api/invites/:token/accept `{ name, password }` | - | 수락 시 로그인 세션 쿠키 발급 |
| team | GET /api/w/:ws/members · PATCH /api/w/:ws/members/:userId `{ role }` · DELETE /api/w/:ws/members/:userId | read / manage_team | `{ members }` · 마지막 owner 보호 |
| team | POST /api/auth/password `{ current, next }` · POST /api/auth/password-reset `{ email }` · POST /api/auth/password-reset/confirm `{ token, password }` · GET/DELETE /api/auth/sessions[/:id] | 로그인 / - | 재설정 링크: `${APP_URL}/?reset=<token>`, 초대 링크: `${APP_URL}/?invite=<token>` |
| team | GET /api/w/:ws/audit?action=&userId=&from=&to=&before= · GET /api/w/:ws/audit.csv | configure | `{ entries, nextBefore }` |
| data | GET /api/connectors/catalog | 로그인 | `{ providers[{ provider, kind, channel, label, docsUrl, verifiedLive, credentialFields, capabilities }] }` |
| data | GET/POST /api/w/:ws/connections · PATCH/DELETE /api/w/:ws/connections/:id · POST …/:id/test · POST …/:id/sync `{ from?, to? }` | read / configure / operate | `{ connections }` (자격증명은 마스킹), write_mode='live'는 live_write |
| data | GET /api/w/:ws/ingest/runs · GET /api/w/:ws/ingest/quality | read | `{ runs }` · `{ issues }` |
| data | POST /api/w/:ws/uploads `{ template, filename, content(CSV 텍스트), mapping?, dryRun? }` · GET /api/uploads/templates/:template.csv | operate | `{ upload, preview, issues }` |
| data | GET /api/w/:ws/dataset?today=&hour= | read | `Dataset`(src/core/types.ts, `meta` 포함) |
| changes | GET /api/w/:ws/changes · POST /api/w/:ws/changes `{ change }`(클라이언트 id 허용) · PATCH /api/w/:ws/changes/:id `{ patch, action, note? }` | read / request / 상태 전이별 승인 권한 | `{ changes }` · `{ change }` — 서버가 상태 전이 · 권한 · 실행(반영 · 롤백)을 판정하고 실제 결과(예: held)를 돌려준다 |
| alerts | GET /api/w/:ws/incidents · POST /api/w/:ws/incidents `{ incident }` · PATCH /api/w/:ws/incidents/:id `{ patch, action }` · POST /api/w/:ws/alerts/scan | read / operate | `{ incidents }` · `{ incident }` · `{ found, created }` |
| alerts | GET/POST /api/w/:ws/notify/channels · PATCH/DELETE …/:id · POST …/:id/test · GET /api/w/:ws/notify/log | read / configure | 채널 설정 값은 마스킹 |
| reports | GET /api/w/:ws/reports · GET /api/w/:ws/reports/:id · POST /api/w/:ws/reports/generate `{ type }` · POST /api/w/:ws/reports/:id/deliver | read / operate | `{ reports }` · `{ report }` |
| impact | GET /api/w/:ws/impact/summary?month=YYYY-MM · GET /api/w/:ws/impact/ledger | read | `{ summary }` · `{ entries }` |
| ai | POST /api/w/:ws/ai/messages `{ messages, tools?, maxTokens?, purpose? }` (SSE) · GET /api/w/:ws/ai/usage | request(=AI 사용) / read | SSE: `text`(delta) · `tool_use`(id, name, input) · `done`(stop_reason, usage) · `error` |
| settings | GET /api/w/:ws/config · PUT /api/w/:ws/config `{ config }` · GET /api/w/:ws/config/history | read / configure | `{ config, defaults }` |
| platform(state) | GET /api/w/:ws/comments · POST `{ comment }` · PATCH /api/w/:ws/comments/:id `{ resolved }` | read / comment | `{ comments }` · `{ comment }` |
| platform(state) | GET /api/w/:ws/state · PUT /api/w/:ws/state/:key `{ value }` | read / comment | `{ state: Record<key, value> }` |

잡 타입 계약: `ingest.daily` · `ingest.intraday` · `ingest.backfill` `{ connectionId, days }` · `ingest.upload` (data) → 성공 시 `alerts.scan`을 enqueue(alerts가 구현) · `dataset` 이벤트 발행.
`alerts.scan` · `alerts.sla` · `notify.send` `{ channelId, event, refId, payload }` (alerts) · `reports.generate` `{ type }` · `impact.measure` (reports-impact) · `changes.execute` `{ changeId }` (changes).
다른 도메인 테이블에 직접 써야 할 때(예: changes가 대량 변경 이슈 생성)는 해당 테이블 스키마(001_core.sql)대로 `ON CONFLICT DO NOTHING`으로 넣고 `publish`한다.

프런트 연결 계약: platform이 워크스페이스가 정해지면 `applyWorkspaceConfig(workspace.config)`(settings) · `configureServerAi({ workspaceId })`(ai, src/ai/claude.ts)를 호출한다.
`config.modules?: string[]`가 있으면 셸은 그 모듈만 메뉴에 보인다. AI 모드 'auto'는 서버 모드에서 'server' 백엔드를 고른다.

## 7. 구현 기준 확장 (§6 계약과 호환되는 추가분)

§6의 경로 · 권한 · 응답 키는 그대로이고, 구현하면서 아래 경로 · 필드가 추가됐다(모두 추가형 — 기존 호출을 깨지 않는다). 전체 목록은 각 도메인 `index.ts` · 라우트 파일의 머리 주석이 기준이다.

| 도메인 | 추가 경로 · 필드 |
| --- | --- |
| platform | GET /api/ready (DB · 마이그레이션 · 워커 하트비트 · 스케줄러, 외부 IP는 판정만) · DELETE /api/w/:ws/state/* |
| team | POST /api/w/:ws/invites/:id/resend · POST /api/auth/password-reset/check `{ token }` (토큰을 URL에 싣지 않음) · DELETE /api/auth/sessions (다른 기기 모두) · GET /api/w/:ws/audit/facets · PATCH /members/:userId는 `{ title?, status? }`도 받고 `{ member, members }` 반환 · 초대 응답 `mail: { sent, reason? }` · 스케줄 `team.cleanup` 04:17 |
| data | POST /api/w/:ws/connections/:id/oauth/cafe24/start → `{ url }` · GET /api/oauth/cafe24/callback (서명 · 1회용 state) · CSV 전용 제공자(오늘의집) 커넥션 생성은 400 `csv_only` · 카탈로그 `csvOnly` · 판매 채널 일 재수집 14일 |
| changes | GET /api/w/:ws/changes/:id/executions (시도별 기록) · GET /api/w/:ws/changes/:id/preflight (상태 변경 없는 점검) · 응답 `executing`, `execution.plan/results/verifiedLive` · 409 `approver_changed` · apply에 웨어하우스 대상 정보 `entity` 전달 · live 키워드 등록 롤백(이번에 만든 키워드만 OFF) |
| alerts | GET /api/w/:ws/alerts/runs (감지 실행 기록) · GET /api/w/:ws/alerts/policy (SLA · 당번 체계) · 이벤트 'notify' · 데모 데이터 이슈 `isTest` · 다른 도메인이 직접 넣은 이슈의 통지(alerts.sla 접수 단계) · fanOutGeneric `body`(메일 전문) |
| reports-impact | GET /api/w/:ws/reports/schedule · GET /api/w/:ws/impact/ledger.csv · POST /api/w/:ws/impact/measure |
| settings | GET /api/w/:ws/config/onboarding · POST /api/w/:ws/config/review · `offHoursMode` · `ai` · `billing.monthlyFee`(owner만) · `impact.contributionMargin/hourlyCost` |
| ai | POST /ai/messages 본문 `tier?` · done 이벤트 `content`(thinking 서명 포함 — 다음 라운드에 그대로 회신) · GET /ai/usage 확장 필드(daily · byUser(configure) · remaining · basis 등) |
