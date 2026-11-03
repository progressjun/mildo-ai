# MILDO OS — 수면밀도 전용 퍼포먼스 AX 에이전트

프로그레스미디어가 「수면밀도 2027 퍼포먼스 마케팅 제안」(2026.11)에서 제안한 **MILDO OS**(Board · Watch · Lab · Alert · Flow)와 자체 AI 엔진 5종(Pro-board · AD Pilot · GFA Control v1 · VisualTune OS · SearchTuneOS)을 실제로 작동하는 하나의 웹 툴로 구현했습니다. 여기에 전 모듈 데이터를 도구로 읽고 판단 근거를 정리하는 **MILDO Agent**(신규)를 더했습니다.

경쟁 PT의 라이브 데모 15분(제안서 부록 p.60)과 RFP 필수 제출물 「대시보드 · 자동 알림 실제 화면, 리포트 샘플」을 그대로 시연할 수 있게 설계했습니다.

> 화면의 성과 수치는 **시연용 테스트 데이터(TEST DATA)** 입니다. RFP 명시 사항(RFP), 제안서 기준값(제안서 p.xx), AI 결과(AI 해석)는 출처 태그로 구분합니다.

## 모듈 구성

| 화면 | 제안서 | RFP 요청 · 평가 항목 | 주요 기능 |
| --- | --- | --- | --- |
| 커맨드 센터 | p.3–5, p.22–23 | 전체 | 어제 KPI · 지금 처리할 것 · 데이터 시간표 진행 · MILDO OS 맵 · '신혼 매트리스' 작동 시나리오 실행 · 라이브 데모 런처 |
| MILDO Agent | 신규 | 전체 | 전 모듈 엔진을 tool use로 호출하는 AI 에이전트, 확정 팩트 / 반복 관측 패턴 / AI 해석 분리 답변, AI 미연결 시 규칙 엔진 답변 |
| MILDO Board | p.12–13 | [1순위] 대시보드 (25%) | 매체 통합 성과 · 판매 채널 실매출 · 키워드 성과 필터 · 예산 소진/예상 마감 · 시간대 히트맵 |
| AD Pilot · GFA Control | p.14–16 | [1순위] SA 키워드 자동화 (25%) | 입찰 · 예산 조정 후보 → 승인 · 기록 · 롤백, SAFETY 상한, GFA 위임 범위별 승인 라우팅 |
| 리포트 · 데이터 시간표 | p.17–20 | [1순위] 리포팅 · 데이터 시간표 (25%) | 일 · 주 · 월 · 이슈 리포트 자동 생성 + AE 코멘트 · 코멘트 단위 피드백, 07:00–17:00 시간표, SA 업무 절감 실측 |
| MILDO Watch | p.24–25 | [2순위] 선제 트래킹 · 아카이빙 (20%) | 매체 변동 감지 → 영향 진단 → 실행안 → 테스트 → 랩업, 경쟁 6개사 오가닉 · 페이드 아카이브 |
| MILDO Lab | p.26–28, p.36 | [2순위] 신규 키워드 발굴 · 테스트 (20%) | 48개 검색 진입점 생성, 키워드 테스트 판정(확장/유지/제외), 테스트 카드, VisualTune 소재 테스트, 검수 에이전트 |
| SearchTuneOS · GEO | p.29 | [2순위] GEO & AI 대응 (10%) | AI 질의별 브랜드 언급 · 인용 진단, Claude 라이브 진단, 제품페이지 SEO · 구조화 데이터 진단, AEO FAQ + JSON-LD |
| 매출 성장 | p.30–42 | 매출 성장 고도화 (20%) | 타겟 그룹 · SA 캠페인 구조, 한계 ROAS 기반 예산 재배분, DA→SA 기여 3방법, 브랜드스토어 · 자사몰 퍼널, 신규 매체 · 코프로모션 |
| MILDO Flow | p.31, p.53 | 운영 안정성 · 협업 | 요청 · 승인 · 반영 이력 한 화면, 프로모션 오픈 전 자동 점검, 프로모션별 리포트 |
| MILDO Alert | p.43–50 | [기본 요건] 크리티컬 이슈 탐지 (20%) | 24시간 이상 감지(동요일 · 동시간 기준선), P1/P2/P3 SLA, 주말 당번 · 연휴 전날 점검, 계정 · 결제 · 권한 점검, 조치 보고서 |
| 전담 TF · 온보딩 · 계약 | p.51–59 | 인력 · 백업 · 온보딩 (15%), 비용 (10%) | 7인 TF · 1:1 백업 · 휴가 시뮬레이터, 90일 온보딩 간트, 수수료 계산기, RFP 커버리지 맵 |

## 실행

```bash
npm install
```

```bash
npm run dev
```

브라우저에서 표시된 주소(기본 http://localhost:5173)를 엽니다. 라이브 데모는 상단 **라이브 데모 15분** 버튼으로 시작합니다(구간이 바뀌면 해당 화면으로 자동 이동).

## AI 연결 방식

| 모드 | 조건 | 동작 |
| --- | --- | --- |
| claude.ai | claude.ai 아티팩트로 열었을 때 | 보는 사람의 Claude 계정으로 동작, API 키 불필요 (`claude.use("sample")`, 도구 호출 포함) |
| API 키 | 로컬 · 사내 배포에서 설정 → API 키 입력 | Anthropic SDK로 브라우저에서 직접 호출 (기본 모델 `claude-opus-5-5`, adaptive thinking, 서버측 refusal fallback) |
| MILDO 서버 | 서버 모드(MILDO OS Cloud)에서 서버에 `ANTHROPIC_API_KEY`가 있을 때 | 서버가 조직 키로 호출(브라우저에 키 없음), 워크스페이스 월 토큰 한도 · 사용량 기록 |
| 규칙 엔진 | 연결 없음 | 모든 기능이 규칙 기반 엔진으로 동작하고, AI 해석 패널은 같은 형식(팩트/패턴/해석)의 규칙 결과를 표시 |

API 키는 해당 브라우저의 localStorage에만 저장됩니다. 외부 공개 배포에서는 브라우저 직접 호출 대신 서버 모드(아래 MILDO OS Cloud — 조직 키로 서버가 호출)를 씁니다.

## 빌드 · 배포

```bash
npm run build
```

```bash
npm run build:single
```

`build:single`은 `dist-single/index.html` 한 파일로 묶습니다(Claude 아티팩트 · 사내 공유용). 빌드 후 `scripts/postbuild-single.mjs`가 번들 안의 U+FFFD 문자를 JS 이스케이프로 바꿉니다(아티팩트 업로드 검사 대응).

## 자동화 스크립트 (서버 · 크론)

```bash
npm run sentinel
```

MILDO Alert 탐지 규칙을 돌려 결과를 출력합니다. `-- --send`와 `SLACK_WEBHOOK_URL`로 P1/P2를 메신저로 보내고, `-- --live-bizmoney`와 `NAVER_SA_API_KEY` · `NAVER_SA_SECRET` · `NAVER_SA_CUSTOMER_ID`로 네이버 SA 비즈머니 실잔액을 점검합니다.

```bash
npm run keywords
```

제안서 p.36의 48개 검색 진입점(제품 1 × 문제 4 × 상황 4 × 비교 3)을 CSV로 출력합니다. `-- --volume`이면 네이버 키워드 도구로 월간 검색량을 붙입니다.

`scripts/naver-searchad.ts`는 네이버 검색광고 API 서명(HMAC-SHA256) · 캠페인/광고그룹/키워드 · 통계 · 비즈머니 · 키워드 도구 호출을 담은 커넥터입니다. 실계정 연결 전 API 문서로 엔드포인트와 필드를 확인해야 합니다.

## 검증

```bash
npm run typecheck
```

```bash
npm test
```

테스트는 모듈별 엔진(규칙 · 판정 · 시드 시나리오 탐지, 데이터를 바꾸면 결과가 바뀌는지 확인), 에이전트 도구 계약(이름 · 32KB 이하 결과 · 브리프 구조), 화면 렌더 스모크로 구성됩니다. `src/modules/registry.test.ts`는 전 모듈 도구 · 브리프 계약과 '준비 중' 모듈이 없는지를 검사합니다.

### 브라우저 기능 점검 (E2E)

```bash
npm run e2e
```

단일 파일 빌드를 만든 뒤 `qa/e2e/`의 6개 점검 묶음(공통 · 커맨드 센터 · Agent / Board · 리포트 / AD Pilot · Flow / Alert · TF / Lab · Watch / GEO · 매출 성장)을 실제 Chromium에서 실행합니다. 모든 버튼 · 입력 · 탭 · 다운로드 · 복사, 모듈 간 흐름(요청 → Flow 승인 · 반영 · 롤백 → 원래 화면 반영), 새로고침 후 유지와 초기화를 확인합니다. claude.ai 런타임(`sample` · `downloads`)은 `qa/e2e/harness.cjs`의 모의 런타임으로 대체해 정상 응답 · 동의 거부 · 사용량 제한 · 응답 중단 · 중지 · 다운로드 거절을 재현합니다(계약 요약 `qa/e2e/CONTRACT.md`). 특정 묶음만: `npm run e2e -- adpilot-flow`. 로그는 `qa/logs/`에 남습니다. 외부 API(네이버 검색광고 실호출 · Slack 발송 · Anthropic API 키 모드)는 키가 필요해 점검 범위에서 제외되며, 키가 없을 때 외부 요청이 나가지 않는지만 확인합니다.

## 구조

```
src/
  core/      타입 · 스토어(승인 이력 · 이슈 · 코멘트) · 셀렉터(공통 집계) · 유틸 · 라우터
  data/      RFP · 제안서 기준 상수(장표 번호 포함) · 테스트 데이터 생성기
  ai/        Claude 연결 계층(아티팩트 / SDK / 규칙 엔진) · 에이전트 지시문
  ui/        공용 컴포넌트 · SVG 차트 · 마크다운 · AI 해석 패널
  app/       셸 · 라이브 데모 바 · 설정 · 알림
  modules/   화면별 모듈 (View · engine · engine.test · agent 도구)
scripts/     센티널 CLI · 키워드 CLI · 네이버 검색광고 API 커넥터 · 단일 파일 빌드 후처리 · 로컬 DB · 클라우드 스모크
server/      MILDO OS Cloud 서버 (Fastify · PostgreSQL · 잡 큐 · 커넥터 · 도메인별 API · 마이그레이션)
deploy/      Docker · compose · 환경변수 예시 · 백업 · 키 회전 도구
qa/          브라우저 기능 점검(E2E) 6개 묶음 · claude.ai 모의 런타임 하네스
docs/        SPEC.md 모듈별 구현 명세 · SAAS_SPEC.md 서버 명세 · OPERATIONS.md 운영 문서
```

## 데이터 교체 (실연동)

서버 모드에서는 아래 MILDO OS Cloud의 커넥터 · CSV 업로드가 이 작업을 합니다. 모든 화면은 `Dataset`(`src/core/types.ts`) 하나를 읽습니다. 온보딩 기간에 Pro-board 수집기가 매체 API · 판매 채널 파일을 날짜 · 채널 · 키워드 · 상품 키로 표준화해 같은 형태로 채우면, 탐지 · 판정 · 리포트 로직은 그대로 실데이터에서 작동합니다. 탐지 기준값(급변 ±50%, 목표 ROAS 등)은 제안서대로 초기값이며 온보딩 중 오탐률을 보며 조정합니다.

## MILDO OS Cloud (SaaS 서버 모드)

같은 화면을 실제 운영 도구로 쓰기 위한 서버(`server/`)가 함께 들어 있습니다. 서버가 붙으면 화면은 로그인 · 팀 · 실데이터로 동작하고, 서버가 없으면(claude.ai 아티팩트 · `file:`) 지금처럼 데모로 동작합니다.

| 영역 | 서버가 하는 일 |
| --- | --- |
| 계정 · 권한 | 조직 → 워크스페이스 → 멤버십(owner · admin · pm · ae · client · viewer), 세션 쿠키 + CSRF, 초대 링크, 비밀번호 변경 · 재설정, 세션 목록 · 강제 종료, 로그인 잠금, 감사 로그(필터 · CSV) |
| 데이터 수집 | 커넥터별 매일 07:00 재수집(매체 최근 3일 · 판매 채널 최근 14일) · 매시 10분 당일 시간대 수집 · 백필(31일 묶음), CSV · TSV 업로드(한글 헤더 · 미리보기), 품질 점검, 출처 우선순위로 `Dataset` 구성 |
| 매체 반영 | Flow 승인을 거친 변경만 커넥터로 반영. 커넥션 쓰기 모드 기본값 `dry_run`(보낼 요청만 기록), `live`는 owner · admin이 확인 문구 입력 후 전환. 반영 전 가드(일 조정 폭 · 최대 입찰가 · 승인 주체 · 일괄 변경 · 계정 잔액), 부분 실패 되돌림, 롤백 |
| 24시간 감지 | 10분마다 서버에서 이상 감지(데모 데이터 이슈는 TEST DATA로 표시), 매분 SLA 에스컬레이션, Slack · 메일 · 웹훅(서명 · SSRF 차단) 발송 이력 |
| 리포트 · 성과 증명 | 일간 08:00 · 주간 월 10:00 · 월간 셋째 영업일 · 이슈 · 월간 가치 리포트 자동 생성 · 발송, 변경 전후 7일 + 통제군 차분 추정(80% 구간) · 손실 회피 추정 · 절감 시간 → 회수 배수(전제 · 신뢰도 표시) |
| AI | 조직 키(`ANTHROPIC_API_KEY`)로 서버가 Claude를 호출(브라우저에 키 없음), 월 토큰 한도 · 사용량 기록 |
| 설정 | 워크스페이스별 목표 · 예산 배분 · SAFETY · 위임 범위 · 시간표 · SLA · 당번 · 사용 모듈 · AI 한도 · 성과 증명 기준(구독료는 owner만) |

관리 화면은 메뉴 '07 관리 · 연동'(데이터 연결 · 팀 · 권한 · 감사 로그 · 알림 설정 · 성과 증명 · 워크스페이스 설정)에 있습니다.

### 커넥터 현황

모든 커넥터는 공식 문서 기준으로 구현했고, 문서 형식의 응답으로 테스트했습니다. **실계정 호출 검증은 아직 없습니다**(`verifiedLive: false` — 화면에 '실계정 연결 전 확인 필요'로 표시). 첫 연결 때 dry_run으로 요청 내용을 확인한 뒤 live로 바꾸는 순서를 권장합니다(`docs/OPERATIONS.md` 점검표).

| 커넥터 | 수집 | 반영 |
| --- | --- | --- |
| 네이버 검색광고 | 일별 · 시간대 · 키워드 · 캠페인 · 비즈머니 | 입찰가 · 일 예산 · ON/OFF · 테스트 키워드 등록 |
| Google Ads | 일별 · 시간대 · 키워드 · 검색어 · 캠페인 | 입찰가 · 일 예산 · 상태 |
| Meta 광고 | 일별 · 시간대 · 캠페인 · 계정 | 일 예산 · 상태 |
| 카카오모먼트 | 일별 · 시간대 · 캠페인 · 계정 | 일 예산 · 상태 |
| 네이버 GFA | 일별 · 시간대 · 캠페인 · 광고 세트 | 일 예산 · 광고 세트 ON/OFF |
| 네이버 브랜드스토어(커머스 API) · 쿠팡 Wing · 카페24 | 일별 주문 · 매출(취소 · 반품 제외) · 상품 · 옵션 · 재고 · 할인 | — |
| 오늘의집 | 공개 판매자 API 미확인 → 판매 채널 일별 CSV(`sales_daily`, 채널 ohouse) | — |

검색어(네이버 SA) · 방문 · 상세 · 장바구니(네이버 커머스 · 쿠팡)처럼 API가 주지 않는 지표는 CSV 템플릿으로 채웁니다.

### 로컬 실행

```bash
npm run pg:dev
```

```bash
npm run db:seed
```

```bash
npm run server:dev
```

```bash
npm run worker:dev
```

```bash
npm run dev
```

`pg:dev`는 로컬 PostgreSQL 16(소켓 `/tmp`, 포트 55432)을 띄웁니다. `db:seed`는 데모 워크스페이스와 개발용 계정(owner@mildo.local / MildoOwner#2027, pm@ · ae@ · client@ 같은 형식)을 만들고, `SEED_DEMO_DATA=true`면 120일 데모 데이터 수집 잡을 넣습니다(워커가 처리). 화면은 Vite 개발 서버(5173)가 `/api`를 8080 서버로 넘깁니다.

### 운영 배포

`deploy/`의 Dockerfile · docker-compose(앱 · 워커 · PostgreSQL · 야간 백업 · 선택 Caddy TLS)로 단일 VM에 올립니다. 환경변수는 `deploy/.env.example`, 첫 배포 · live 전환 점검표 · 백업/복구 · 키 회전 · 모니터링(`/api/health`, `/api/ready`) · 장애 대응은 `docs/OPERATIONS.md`에 있습니다. 실제 운영에 필요한 것은 서버(또는 VM) · 도메인 · PostgreSQL · 매체/판매 채널 API 자격증명 · SMTP · Anthropic API 키입니다.

### 서버 검증

```bash
npm run test:server
```

```bash
npm run smoke:cloud
```

`test:server`는 실제 PostgreSQL 임시 스키마에서 도메인별 테스트(권한 · 테넌트 격리 · 입력 검증 · 감사 · 잡)를 돌립니다. `smoke:cloud`는 새 DB 생성 → 마이그레이션 · 시드 → 서버 · 워커 기동 → 데모 백필 → 로그인 · CSRF · Dataset · SSE · 권한 · 보안 헤더 · 종료까지 15단계를 확인하고 DB를 지웁니다(`SMOKE_RUNTIME=dist`면 빌드 번들로). 명세는 `docs/SAAS_SPEC.md`입니다.

## 보안 · 기밀

RFP와 제공 자료는 제안서 제출 외 용도로 활용 · 유출할 수 없습니다(RFP 기타 유의 사항). 이 저장소는 비공개로 유지하세요.
