# MILDO OS Cloud 운영 가이드

배포 · 설정 · 백업 · 복구 · 모니터링 · 비밀값 회전 · 장애 대응을 한곳에 정리한 운영 문서다. 대상은 서버를 맡는 운영 담당(엔지니어 · PM)이다.
기능 명세는 `docs/SAAS_SPEC.md`, 배포 파일은 `deploy/`, 보안 · 레디니스 구현은 `server/src/http/security.ts`에 있다.

표기 원칙: 명령은 그대로 복사해 실행할 수 있게 적고, 확인되지 않은 것은 '확인 필요' 또는 '자동화되지 않음'으로 적는다.

---

## 구성

```
                         인터넷 (HTTPS 443)
                               │
                 ┌─────────────▼──────────────┐
                 │ proxy  (Caddy, --profile tls)│  TLS 자동 발급 · X-Forwarded-For 추가 · X-Request-Id 부여
                 └─────────────┬──────────────┘
                               │ http://app:8080   (VM 안에서는 127.0.0.1:8080으로도 접속)
 ┌─────────────────────────────▼─────────────────────────────┐
 │ app  node server/dist/index.mjs                            │
 │   /api/*      Fastify API (세션 쿠키 · CSRF · 권한 · 감사)    │
 │   /api/w/:ws/events   SSE (변경 알림 실시간 전달)            │
 │   /           빌드된 프런트(dist) — 같은 오리진에서 서빙      │
 │   보안 헤더 · CSP · 속도 제한 · /api/health · /api/ready     │
 └───────┬─────────────────────────────▲─────────────────────┘
         │ SQL                          │ LISTEN mildo_events (NOTIFY로 변경 알림)
 ┌───────▼──────────────────────────────┴──────┐      ┌──────────────────────────────┐
 │ db  PostgreSQL 16 (볼륨 pgdata)              │◄─────┤ worker  node server/dist/worker.mjs │
 │   업무 데이터 · 웨어하우스(wh_*) · 잡 큐(jobs)  │ SQL  │   잡 큐 처리(SKIP LOCKED) · 스케줄(KST) │
 │   감사 로그 · 세션 · 암호화된 자격증명         │      │   수집 · 감지 · SLA · 알림 · 반영       │
 └───────▲──────────────────────────────────────┘      └───────────────┬──────────────┘
         │ pg_dump (매일 03:30 KST)                                     │ HTTPS
 ┌───────┴──────────────┐                         매체 · 판매 채널 API · Slack · SMTP · Anthropic
 │ backup (볼륨 backups) │
 └──────────────────────┘
 migrate  node server/dist/cli.mjs migrate — 배포마다 한 번 실행하고 끝나는 컨테이너 (app · worker보다 먼저)
```

- 이미지 하나(`deploy/Dockerfile`)로 migrate · app · worker를 모두 돌린다. 컨테이너는 비root(uid 10001), 루트 파일시스템 읽기 전용, 모든 커널 권한 제거로 실행한다.
- app과 worker는 DB로만 대화한다. 잡은 `jobs` 테이블, 실시간 알림은 PostgreSQL NOTIFY → app의 SSE.
- 워커 스케줄(KST): `ingest.daily` 07:00 전일 확정 수집, `ingest.intraday` 매시 10분 당일 시간대, `alerts.scan` · `changes.sweep` 10분마다, `alerts.sla` 1분마다, `team.cleanup` 04:17. 리포트 · 성과 측정 스케줄은 해당 도메인이 등록한다.

---

## 첫 배포 (단일 VM + docker compose)

### 준비물

- VM: 2 vCPU · 4 GB RAM · SSD 40 GB 이상 (워크스페이스 10개 · 매체 5개 · 400일 백필 기준 여유 있음). Ubuntu 22.04/24.04 권장.
- Docker Engine 24 이상, Docker Compose v2.24 이상 (`docker compose version`).
- 도메인 하나 (예: `ops.example.com`)의 A/AAAA 레코드가 VM을 가리킬 것, 방화벽에서 80 · 443만 열 것 (8080 · 5432는 열지 않는다).
- 메일 발송용 SMTP 계정(초대 · 비밀번호 재설정 · 주간 리포트), Anthropic API 키(AI 기능), Slack Incoming Webhook(알림) — 없어도 기동은 된다.

### 설치

```bash
git clone <저장소 URL> mildo-ai && cd mildo-ai/deploy
cp .env.example .env && chmod 600 .env

# 비밀값 생성 후 .env에 넣는다
openssl rand -base64 32                     # → ENCRYPTION_KEY
openssl rand -base64 48 | tr -d '\n'; echo  # → SESSION_SECRET
openssl rand -hex 24                        # → POSTGRES_PASSWORD (URL에 들어가므로 영숫자만)
```

`.env`에서 최소한 `APP_URL` · `ENCRYPTION_KEY` · `SESSION_SECRET` · `POSTGRES_PASSWORD` · `SEED_OWNER_EMAIL` · `SEED_OWNER_PASSWORD` · `APP_DOMAIN` · `ACME_EMAIL`을 채운다.
`ENCRYPTION_KEY`는 비밀번호 관리자에 따로 보관한다. 잃어버리면 저장된 매체 · 판매 채널 자격증명과 알림 웹훅을 복구할 수 없다(다시 입력해야 한다).

```bash
docker compose --profile tls up -d --build   # db → migrate → app · worker · backup · proxy(Caddy)
docker compose ps                            # app (healthy), db (healthy), backup (healthy), migrate (exited 0)
curl -s http://127.0.0.1:8080/api/ready      # status: ready 또는 degraded(아래 '모니터링')
```

- HTTPS 없이 사내망에서 먼저 시험할 때는 `--profile tls`를 빼고 `.env`에 `SECURE_COOKIES=false`(시험 한정), `APP_URL=http://<VM IP>:8080`, `APP_BIND=0.0.0.0`, `TRUST_PROXY_HOPS=0`을 둔다. 운영 전환 전 반드시 되돌린다.
- 호스트에 이미 nginx 등 리버스 프록시가 있으면 Caddy 대신 그 프록시에서 `127.0.0.1:8080`으로 넘긴다. SSE를 위해 버퍼링을 끈다(nginx: `proxy_buffering off; proxy_read_timeout 1h;`). 프록시가 하나면 `TRUST_PROXY_HOPS=1`(기본값)이 맞다.
  nginx는 기본으로 X-Forwarded-For를 붙이지 않는다. `proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;`를 반드시 넣는다. 빠지면 모든 사용자가 프록시 IP 하나로 묶여 속도 제한(IP당 분당 600회)을 함께 쓰고 로그인 잠금의 '익숙한 IP' 판정도 틀어진다. 요청 추적 id를 이으려면 `proxy_set_header X-Request-Id $request_id;`.
- 사내 SSL 검사 프록시 때문에 이미지 빌드의 `npm ci`가 인증서 오류로 실패하면, 그 CA 파일을 `deploy/` 안에 두고 `.env`에 `EXTRA_CA_FILE=./corp-ca.crt`를 넣는다(빌드에만 쓰이고 이미지에는 남지 않는다).

### 관리형 PostgreSQL을 쓸 때

AWS RDS · Google Cloud SQL · NCP Cloud DB for PostgreSQL 등 PostgreSQL 16을 만들고(확장 `pgcrypto` 불필요 — `gen_random_uuid()`는 PG13부터 기본 제공), `.env`의 `DATABASE_URL`에 넣는다.

```bash
# .env:  DATABASE_URL=postgres://mildo:<비밀번호>@<호스트>:5432/mildo?sslmode=require
docker compose -f docker-compose.yml -f docker-compose.managed-db.yml --profile tls up -d --build
```

로컬 `db` · `backup` 컨테이너는 뜨지 않는다. 백업은 관리형 서비스의 자동 백업 · 시점 복구(PITR)를 켜고, 보관 기간을 7일 이상으로 둔다(아래 '백업 · 복구').
마이그레이션 사용자에게 스키마 생성 권한(테이블 · 인덱스 · 함수 · 트리거)이 있어야 한다. 일반적으로 DB 소유자 계정을 쓴다.

### CI가 만든 이미지로 배포할 때

`.github/workflows/ci.yml`의 docker 작업은 이미지를 빌드 · 기동 점검만 하고 레지스트리에 올리지 않는다(레지스트리 정보가 없어서). 레지스트리를 정하면 `.env`에 `MILDO_IMAGE=<레지스트리>/mildo-os-cloud:<태그>`를 넣고 `docker compose pull && docker compose up -d`로 배포한다.

---

## 환경변수

`deploy/.env.example`에 모든 항목이 설명과 함께 있다. 요약:

| 변수 | 필수 | 기본값 | 설명 |
| --- | --- | --- | --- |
| `APP_URL` | O | `http://localhost:8080` | 외부 접속 주소. 초대 · 재설정 링크와 알림 메시지에 들어간다 |
| `DATABASE_URL` | 프로덕션 O | compose가 `POSTGRES_*`로 생성 | PostgreSQL 접속 URL |
| `ENCRYPTION_KEY` | 프로덕션 O | 개발용 고정 키(프로덕션 거부) | 자격증명 암호화(AES-256-GCM) 키, base64 32바이트 |
| `SESSION_SECRET` | 프로덕션 O | 개발용 값 | 쿠키 서명용, 32자 이상 |
| `SESSION_TTL_HOURS` | - | 336 | 로그인 유지 시간 |
| `SECURE_COOKIES` | - | 프로덕션 true | false면 HSTS도 꺼진다. HTTPS 없는 시험에서만 false |
| `PORT` · `HOST` | - | 8080 · 0.0.0.0 | 컨테이너 안 리슨 주소 |
| `STATIC_DIR` | - | 프로덕션 `dist` | 프런트 빌드 폴더. 비우면 API만 |
| `LOG_LEVEL` | - | info | fatal · error · warn · info · debug · trace · silent |
| `MIGRATE_ON_START` | - | true (compose는 false) | 시작 시 마이그레이션. compose에서는 migrate 서비스가 맡는다 |
| `WORKER_ID` | - | `worker-<호스트명>`(compose) | 하트비트 · 잡 잠금 표시 |
| `WORKER_CONCURRENCY` | - | 2 | 워커 동시 처리 잡 수 |
| `SCHEDULER` | - | on | off면 이 워커는 스케줄을 돌리지 않는다 |
| `ANTHROPIC_API_KEY` · `ANTHROPIC_MODEL` | - | 없음 · `claude-opus-5-5` | 서버 AI 호출. 키는 브라우저로 내려가지 않는다 |
| `SMTP_HOST` · `SMTP_PORT` · `SMTP_SECURE` · `SMTP_USER` · `SMTP_PASS` · `SMTP_FROM` | - | 없음 · 587 · false | 메일. `SMTP_HOST`가 비면 메일을 보내지 않는다 |
| `SEED_OWNER_EMAIL` · `SEED_OWNER_PASSWORD` · `SEED_OWNER_NAME` | 시드 시 O | - | 첫 owner 계정 |
| `SEED_DEMO_DATA` | - | true(CLI) · false(.env.example) | 데모 커넥션 + TEST DATA 120일 백필 |
| `SEED_DEMO_USERS` | - | 프로덕션 false | pm · ae · client 데모 계정 |
| `API_RATE_LIMIT_MAX` · `API_RATE_LIMIT_WINDOW_SEC` | - | 600 · 60 | /api 전역 속도 제한(IP당, IPv6는 /64). SSE 제외. 0 = 끔 |
| `AUTH_RATE_LIMIT_MAX` | - | 20 | 로그인 · 재설정 · 초대 수락 IP당 분당 |
| `LOGIN_FAIL_MAX` · `LOGIN_FAIL_WINDOW_MIN` | - | 10 · 15 | 같은 이메일 실패 잠금(성공 로그인 · 비밀번호 재설정 뒤 새로 셈, 최근 30일 성공 IP는 그 IP의 실패만 셈) |
| `TRUST_PROXY_HOPS` | - | 1 | 앞단 프록시 수(클라이언트 IP 판정). 직접 노출이면 0 |
| `CSP_CONNECT_SRC_EXTRA` | - | 없음 | CSP connect-src에 더할 https/wss 출처 |
| `READY_WORKER_STALE_MIN` | - | 15 | 워커 활동이 이보다 오래되면 /api/ready degraded |
| `READY_TOKEN` | - | 없음 | 외부에서 /api/ready 세부 항목을 볼 때 `x-ready-token` 헤더 값(16자 이상). 없으면 세부 항목은 내부망에만 |
| `SLOW_REQUEST_MS` | - | 3000 | 느린 요청 warn 로그 기준 |
| `POSTGRES_DB` · `POSTGRES_USER` · `POSTGRES_PASSWORD` | 로컬 DB O | mildo · mildo · - | compose db 서비스 |
| `MILDO_IMAGE` · `APP_BIND` · `APP_PORT` · `SKIP_TYPECHECK` · `EXTRA_CA_FILE` | - | - | compose 전용 |
| `APP_DOMAIN` · `ACME_EMAIL` | tls 프로필 O | - | Caddy 인증서 발급 |
| `BACKUP_TIME` · `BACKUP_KEEP_DAYS` · `RETENTION_ENABLED` | - | 03:30 · 14 · false | 야간 백업 · 보관 정리 |

`.env`를 바꾼 뒤에는 `docker compose up -d`로 컨테이너를 다시 만든다(`restart`만으로는 env_file이 다시 읽히지 않는다).

---

## 첫 owner 계정 · 팀

```bash
cd deploy
docker compose run --rm --no-deps app node server/dist/cli.mjs seed
# → "워크스페이스 <id> · 사용자 owner@example.com"
```

- 시드는 조직 · 워크스페이스(기본 슬러그 `mildo`, 브랜드 수면밀도) · owner 계정을 만든다. 여러 번 실행해도 같은 워크스페이스에 덮어쓴다(비밀번호는 바꾸지 않는다 — 기존 계정은 이름 · 역할만 갱신).
- 시연용으로 TEST DATA가 필요하면 한 번만 `-e SEED_DEMO_DATA=true`를 붙인다. 데모 커넥션이 만들어지고 워커가 120일치 테스트 데이터를 채운다. 화면에는 TEST DATA로 표시된다.
- 로그인한 뒤 비밀번호를 바꾸고(비밀번호 변경 API `POST /api/auth/password` — team 도메인), `.env`의 `SEED_OWNER_PASSWORD`를 지운다.
- 나머지 구성원은 화면의 '07 관리 · 연동 → 팀 · 권한'에서 초대한다(토큰 링크, `SMTP_HOST`가 없으면 화면에 링크가 표시된다). 역할 표는 `docs/SAAS_SPEC.md` §2.
- CLI로 사용자를 바로 만들어야 할 때: `docker compose run --rm --no-deps app node server/dist/cli.mjs user <email> <이름> <역할> <비밀번호>`.

---

## 데이터 소스 연결

화면 '07 관리 · 연동 → 데이터 연결'에서 커넥션을 만든다. 권한: 보기 read, 만들기 · 수정 configure(pm 이상), 수집 실행 operate.

- 매체 API(네이버 검색광고 · Google Ads · Meta · 카카오모먼트)와 판매 채널 API(네이버 커머스 · 쿠팡 · 카페24)는 공식 문서대로 구현했지만 **실계정 호출 검증 전**이다. 화면에 '실계정 연결 전 확인 필요'가 붙어 있다. 첫 연결 때는 '연결 테스트' 결과와 첫 수집(전일 1일치) 숫자를 매체 관리 화면의 같은 날짜 숫자와 맞춰 본다. 다르면 커넥션을 끄고 CSV로 운영하면서 이슈를 남긴다.
- 공개 API 근거가 없는 채널(네이버 GFA · 오늘의집)은 CSV 업로드로 받는다. 템플릿은 화면에서 내려받는다(`GET /api/uploads/templates/<template>.csv`).
- 자격증명은 저장 즉시 `ENCRYPTION_KEY`로 암호화되고, 화면 · API · 로그 · 감사 기록에는 앞 4자리와 길이만 보인다.
- 수집 일정: 매일 07:00 전일 확정, 매시 10분 당일 시간대. 연결 직후에는 '수집' 버튼으로 백필(최대 400일, 매체 보관 한도 이내)을 돌린다.
- 같은 매체에 출처가 여럿이면 api > csv > demo 순으로 하나만 쓴다. 실데이터가 들어오기 시작하면 데모 커넥션은 끄거나 지운다(화면 출처 표시가 TEST DATA → LIVE DATA로 바뀐다).
- 수집 결과 · 품질 경고(누락 날짜 · 중복 · 음수 · 급변 · 합계 불일치)는 같은 화면의 수집 현황에서 본다.

---

## 매체 반영을 live로 바꾸기 (점검표)

커넥션의 쓰기 모드(`connections.write_mode`)는 `off` · `dry_run`(기본) · `live`다. dry_run은 보낼 요청을 변경 요청의 실행 기록에만 남기고 매체로 보내지 않는다. live로 바꾸는 권한은 admin · owner(`live_write`)뿐이다.

live 전환 전에 아래를 모두 확인한다.

- 이 커넥션으로 dry_run 반영을 최소 3건 해 보고, 변경 요청 상세의 실행 기록(보낼 요청 본문 · 대상 id · 값)이 매체 관리 화면에서 직접 바꿀 때와 같은지 사람이 확인했다.
- 연결 테스트가 성공했고, 수집 숫자가 매체 화면과 맞는다(위 '데이터 소스 연결').
- 워크스페이스 설정의 SAFETY 값(일일 변경 상한 — 기본 20%, 최대 입찰가, 최소 전환 수, 이상 감지 시 보류)이 이 광고주 기준으로 맞다.
- 위임 범위 · 승인 등급(AE · PM · CLIENT)이 계약서와 맞고, 승인할 사람이 팀에 초대되어 있다.
- 알림 채널(Slack · 메일)이 테스트 발송에 성공했고, 반영 실패 · 대량 변경 경고를 받을 사람이 지정되어 있다.
- 당일 백업이 있다(`docker compose exec backup ls -l /backups`).
- 첫 live 반영은 업무 시간에, 영향이 작은 대상 1건(예: 저예산 키워드 입찰가 10원)으로 한다. 반영 후 매체 화면에서 값을 확인하고, 롤백까지 한 번 해 본다.
- 감사 로그에서 `connection` 쓰기 모드 변경 · `change` 반영 · 롤백 기록이 남았는지 확인한다.

문제가 보이면 즉시 쓰기 모드를 `dry_run`(또는 `off`)으로 되돌린다. 이미 실행 중인 잡도 실행 직전에 쓰기 모드를 다시 확인하므로 live가 아니면 보내지 않는다.

---

## 백업 · 복구

### 자동 백업 (로컬 db 사용 시)

`backup` 서비스가 매일 `BACKUP_TIME`(KST 03:30)에 `pg_dump -Fc`로 `backups` 볼륨에 `mildo-<날짜시각>.dump`를 만들고, `pg_restore --list`로 읽히는지 확인한 뒤, `BACKUP_KEEP_DAYS`(14일) 지난 파일을 지운다. 컨테이너가 시작될 때 24시간 안의 덤프가 없으면 바로 하나 만든다. 최근 26시간 안의 덤프가 없으면 컨테이너가 unhealthy가 된다.

```bash
docker compose run --rm backup --once                      # 지금 한 번
docker compose exec backup ls -lh /backups                 # 목록
docker compose cp backup:/backups/mildo-20261103-033000.dump ./   # VM으로 꺼내기
```

**외부 보관은 자동화되어 있지 않다.** 같은 VM의 볼륨에만 있으면 VM을 잃을 때 같이 잃는다. 호스트 cron으로 다른 저장소(S3 · NCP Object Storage · 사내 NAS)에 복사한다. 예:

```bash
# /etc/cron.d/mildo-backup-offsite — 매일 04:30 KST(서버 시간대에 맞춰 조정)
30 4 * * * root docker run --rm -v mildo_backups:/b:ro -v /root/.config/rclone:/config/rclone rclone/rclone copy /b remote:mildo-backups --max-age 48h
```

덤프 안의 자격증명은 그 시점의 `ENCRYPTION_KEY`로 암호화되어 있다. **키를 회전한 뒤에도 옛 키를 백업 보관 기간 동안 함께 보관한다**(옛 덤프를 복원하면 옛 키가 필요하다).

### 관리형 DB

서비스의 자동 백업 · 시점 복구를 켠다. 추가로 주 1회 논리 덤프를 외부에 둔다:

```bash
docker run --rm -e PGPASSWORD postgres:16 pg_dump "postgres://mildo@<호스트>:5432/mildo?sslmode=require" -Fc > mildo-$(date +%Y%m%d).dump
```

### 복원 (안전한 방법: 새 DB에 복원 → 확인 → 교체)

```bash
cd deploy
docker compose stop app worker                       # 쓰기 중지
docker compose exec db createdb -U mildo mildo_restore
docker compose run --rm --entrypoint bash backup -c \
  'pg_restore --no-owner --no-privileges -d mildo_restore /backups/mildo-20261103-033000.dump'
# 확인: 테이블 · 최근 데이터
docker compose exec db psql -U mildo -d mildo_restore -c "SELECT count(*) FROM workspaces" -c "SELECT max(date) FROM wh_media_daily"
# 교체 (기존 DB는 mildo_broken으로 남겨 둔다)
docker compose exec db psql -U mildo -d postgres -c "ALTER DATABASE mildo RENAME TO mildo_broken" -c "ALTER DATABASE mildo_restore RENAME TO mildo"
docker compose up -d                                  # migrate가 빠진 마이그레이션을 적용한 뒤 app · worker 기동
curl -s http://127.0.0.1:8080/api/ready
```

- 같은 DB에 덮어써야 하면 `pg_restore --clean --if-exists --no-owner -d mildo <파일>`을 쓴다(되돌릴 수 없으니 먼저 현재 상태를 `--once`로 덤프해 둔다).
- 복원 시점 이후의 변경(반영 · 이슈 · 코멘트)은 사라진다. 매체에는 그 사이 live 반영이 남아 있을 수 있으니 감사 로그 덤프나 매체 변경 이력과 대조한다.
- 복원 훈련을 분기마다 한 번 한다(새 DB에 복원 → 로그인 → Dataset 확인 → 지움).

---

## 비밀값 회전

### ENCRYPTION_KEY (자격증명 암호화 키) — 도구 있음, 앱 중지 필요

`deploy/tools/rotate-encryption-key.mjs`가 현재 스키마의 `*_enc` 컬럼(지금은 `connections.credentials_enc`, `notification_channels.config_enc`)을 한 트랜잭션에서 옛 키로 풀고 새 키로 다시 암호화한다. 옛 키로 풀리지 않는 값이 하나라도 있으면 아무것도 바꾸지 않고 멈춘다. 다시 실행해도 안전하다(이미 새 키로 풀리는 값은 건너뛴다). 무중단 회전(두 키 동시 지원)은 구현되어 있지 않아 **app · worker를 잠시 멈춰야 한다**(수 초 ~ 수십 초).

```bash
cd deploy
OLD=$(grep '^ENCRYPTION_KEY=' .env | cut -d= -f2-)
NEW=$(openssl rand -base64 32)        # 새 키를 비밀번호 관리자에 먼저 저장
docker compose run --rm backup --once                 # 회전 전 백업
docker compose stop app worker
docker compose run --rm --no-deps -e ENCRYPTION_KEY_OLD="$OLD" -e ENCRYPTION_KEY_NEW="$NEW" app node deploy/tools/rotate-encryption-key.mjs           # 점검(변경 없음)
docker compose run --rm --no-deps -e ENCRYPTION_KEY_OLD="$OLD" -e ENCRYPTION_KEY_NEW="$NEW" app node deploy/tools/rotate-encryption-key.mjs --apply   # 적용
sed -i "s|^ENCRYPTION_KEY=.*|ENCRYPTION_KEY=$NEW|" .env
docker compose up -d app worker
```

확인: 데이터 연결 화면에서 커넥션 하나를 '연결 테스트', 알림 채널 하나를 '테스트 발송'. 옛 키는 백업 보관 기간(기본 14일 + 외부 보관 기간)이 지날 때까지 지우지 않는다.
새로 암호화 컬럼을 추가하는 도메인은 컬럼 이름을 `*_enc`, 형식을 `lib/crypto.ts`의 `encryptSecret`(`v1:`)으로 맞춰야 이 도구가 함께 회전한다. jsonb 안에 넣은 암호문은 대상이 아니다.

### SESSION_SECRET

로그인 세션은 DB에 해시로 저장한 랜덤 토큰이라 이 값과 무관하다. 이 값은 서명 쿠키에만 쓰인다. `.env`에서 바꾸고 `docker compose up -d app`. 모든 사용자를 강제로 로그아웃시켜야 하면(계정 유출 의심):

```bash
docker compose exec db psql -U mildo -d mildo -c "DELETE FROM sessions"
```

### POSTGRES_PASSWORD

```bash
NEWPW=$(openssl rand -hex 24)
docker compose exec db psql -U mildo -d postgres -c "ALTER USER mildo PASSWORD '$NEWPW'"
sed -i "s|^POSTGRES_PASSWORD=.*|POSTGRES_PASSWORD=$NEWPW|" .env
docker compose up -d       # app · worker · backup이 새 비밀번호로 다시 접속
```

### 그 밖의 비밀값

`ANTHROPIC_API_KEY` · `SMTP_PASS`는 `.env`를 바꾸고 `docker compose up -d app worker`. 매체 · 판매 채널 자격증명과 Slack 웹훅은 화면에서 다시 입력한다(저장 시 자동 암호화, 감사 로그에는 '변경됨'만 남는다).

---

## 모니터링

### 헬스 · 레디니스

| 엔드포인트 | 용도 | 판정 |
| --- | --- | --- |
| `GET /api/health` | 살아 있음(Docker HEALTHCHECK · 프런트 서버 모드 감지) | DB `SELECT 1` 성공 시 200 `{ ok: true, version, time }` |
| `GET /api/ready` | 서비스 가능 여부 · 운영 상태 | 아래 |

`/api/ready` 응답(내부망 · 토큰, `detail: "full"`):

```json
{
  "ok": true,
  "status": "ready",
  "version": "1.0.0",
  "time": "2026-11-03T00:00:00.000Z",
  "detail": "full",
  "checks": {
    "db": { "ok": true, "latencyMs": 2 },
    "migrations": { "ok": true, "expected": 8, "applied": 8, "pending": [], "unknownApplied": [] },
    "worker": {
      "ok": true, "status": "ok", "staleAfterMin": 15,
      "lastActivityAt": "…", "lastFinishedAt": "…", "lastHeartbeatAt": "…", "activityAgeSec": 42,
      "runningJobs": 0, "queuedDue": 0, "overdueJobs": 0, "failedJobs24h": 0, "activeWorkspaces": 1,
      "workers": [{ "id": "worker-3f2a9c", "lastSeenAt": "…", "jobsSeen": 1520, "lastJobType": "alerts.scan" }],
      "basis": "…판정 기준…"
    }
  },
  "notes": []
}
```

- 공개 범위: 클라이언트 IP(`TRUST_PROXY_HOPS` 기준)가 루프백 · 사설망(10/8 · 172.16/12 · 192.168/16 · fc00::/7 등)이거나 `x-ready-token` 헤더가 `READY_TOKEN`과 같을 때만 위 세부 항목을 준다. 그 밖(인터넷의 외부 감시 등)에는 같은 모양에 판정만 담은 요약(`detail: "summary"`)을 준다 — `status` · `ok` · 각 검사의 `ok` · 워커 `status` · 마이그레이션 개수만 남기고 워커 이름 · 활성 워크스페이스 수 · 잡 수 · 파일 이름 · DB 오류 문구는 비운다(0 · 빈 목록). HTTP 상태 코드는 같다.
- `not_ready`(HTTP 503): DB에 연결할 수 없거나 적용되지 않은 마이그레이션이 있다. 로드밸런서는 이 인스턴스를 빼야 한다.
- `degraded`(HTTP 200): API는 정상이지만 워커가 의심스럽다. 수집 · 감지 · 알림 · 반영이 멈췄을 수 있으니 바로 확인한다.
- `ready`(HTTP 200): 정상.
- 워커 판정: 워커 코드는 따로 하트비트를 쓰지 않으므로, `520_ops_heartbeat.sql`의 트리거가 워커가 잡을 집거나(running) 끝낼(done · failed) 때마다 `worker_heartbeats`에 워커별 마지막 시각을 남긴다. 활성 워크스페이스가 있으면 스케줄 잡이 최소 10분마다 생기므로, 최근 `READY_WORKER_STALE_MIN`(15분) 안에 잡 처리 기록이 없으면 `stale`, 처리 기록이 한 번도 없으면 `no_activity`, 실행 시각이 5분 넘게 지난 대기 잡이 있는데 최근 5분 처리 기록이 없으면 `stalled`(셋 다 degraded)로 본다. 활동은 최근인데 잡이 밀려 있으면 `busy`(정상 범위, 메모에 표시). 활성 워크스페이스가 없으면 `idle`(판정 보류).
- 반례: 모든 워크스페이스가 일시 중지(suspended)면 스케줄 잡이 없어 `idle`로 보인다. 워커가 살아 있어도 스케줄을 끈(`SCHEDULER=off`) 워커만 있으면 잡이 생기지 않아 `stale`이 된다.

외부 감시(UptimeRobot · Better Stack · 사내 Zabbix 등)는 두 가지를 건다. `https://<도메인>/api/health` 200 확인(1분), `https://<도메인>/api/ready` 본문에 `"status":"ready"` 포함 확인(5분). 외부에서 세부 근거까지 받아야 하면 `.env`에 `READY_TOKEN=$(openssl rand -hex 24)`를 두고 감시 요청에 `x-ready-token` 헤더를 붙인다. 판정조차 외부에 보이기 싫으면 `deploy/Caddyfile`의 주석을 풀어 사내 IP만 허용한다.
- 최근 24시간 최종 실패 수(`failedJobs24h`)는 워커가 실행하다 실패한 잡만 센다. 커넥션 · 업로드 삭제로 대기 중에 취소된 잡(`locked_by`가 비어 있는 failed)은 세지 않는다.

### 잡 · 수집 · 알림 실패 조회

```bash
alias mpsql='docker compose exec -T db psql -U mildo -d mildo'

# 최근 24시간 최종 실패 잡 (locked_by가 빈 행은 커넥션 · 업로드 삭제로 대기 중 취소된 것)
mpsql -c "SELECT id, type, workspace_id, attempts, locked_by, finished_at, left(last_error, 200) AS error FROM jobs WHERE status = 'failed' AND finished_at > now() - interval '24 hours' ORDER BY finished_at DESC"
# 실패 후 재시도 대기 중(지수 백오프: 1 · 2 · 4 · 8분 …)
mpsql -c "SELECT type, count(*), max(attempts) AS max_attempts, min(run_at) AS next_run FROM jobs WHERE status = 'queued' AND last_error IS NOT NULL GROUP BY type"
# 밀린 잡 (실행 시각이 5분 넘게 지남)
mpsql -c "SELECT type, count(*), min(run_at) FROM jobs WHERE status = 'queued' AND run_at < now() - interval '5 minutes' GROUP BY type"
# 오래 잠긴 잡 (워커 비정상 종료 — 워커가 15분 뒤 자동 회수)
mpsql -c "SELECT id, type, locked_by, locked_at FROM jobs WHERE status = 'running' AND locked_at < now() - interval '15 minutes'"
# 워커 하트비트
mpsql -c "SELECT worker_id, last_seen_at, jobs_seen, last_job_type, last_status FROM worker_heartbeats ORDER BY last_seen_at DESC"
# 수집 실패 · 부분 성공
mpsql -c "SELECT r.started_at, c.provider, c.label, r.job, r.status, left(r.error, 200) FROM ingest_runs r LEFT JOIN connections c ON c.id = r.connection_id WHERE r.status IN ('failed','partial') ORDER BY r.started_at DESC LIMIT 20"
# 알림 발송 실패
mpsql -c "SELECT at, channel_id, event, ref_id, detail FROM notifications WHERE status = 'failed' ORDER BY at DESC LIMIT 20"
# 실패 잡 하나 다시 실행 (원인을 고친 뒤)
mpsql -c "UPDATE jobs SET status = 'queued', attempts = 0, run_at = now(), finished_at = NULL WHERE id = <잡 id> AND status = 'failed'"
```

### 로그

- app은 JSON 구조화 로그(pino)를 낸다. 요청마다 `requestId`가 붙고 응답 헤더 `x-request-id`와 같다(Caddy가 붙인 값을 이어 쓴다). 사용자가 오류 화면을 캡처해 보내면 그 id로 찾는다: `docker compose logs app | grep <requestId>`.
- 쿠키 · Authorization · CSRF 헤더는 app 로그와 Caddy 로그 양쪽에서 지운다.
- `SLOW_REQUEST_MS`(3초)보다 오래 걸린 요청은 `느린 요청` warn 로그로 남는다.
- 컨테이너 로그는 서비스마다 20 MB × 5개로 돌려 쓴다(디스크 보호). 오래 보관하려면 로그 수집기(Loki · CloudWatch 등)로 보낸다.

### 디스크 · 자원

```bash
docker system df
docker compose exec db psql -U mildo -d mildo -c "SELECT relname, pg_size_pretty(pg_total_relation_size(relid)) FROM pg_catalog.pg_statio_user_tables ORDER BY pg_total_relation_size(relid) DESC LIMIT 10"
```

---

## 업그레이드

마이그레이션은 앞으로만 간다(되돌리는 마이그레이션이 없다). 그래서 업그레이드 전 백업이 되돌리기 수단이다.

```bash
cd mildo-ai && git fetch && git log --oneline HEAD..origin/main      # 바뀌는 내용 확인 (server/migrations 새 파일 여부)
cd deploy
docker compose run --rm backup --once                                  # 백업
git pull
docker compose build                                                   # 새 이미지 (타입 검사 포함)
docker compose up -d                                                   # migrate가 새 마이그레이션 적용 → app · worker 교체
docker compose logs migrate                                            # "적용: …" 확인
curl -s http://127.0.0.1:8080/api/ready                                # ready 확인
```

- app이 교체되는 몇 초 동안 요청이 실패할 수 있다(단일 인스턴스). 업무 시간을 피하고, 반영 · 수집 스케줄(07:00, 매시 10분) 직전도 피한다.
- 워커는 SIGTERM을 받으면 진행 중인 잡을 마치고 끝난다(최대 90초 대기 후 강제 종료). 강제 종료된 잡은 15분 뒤 다른 워커가 다시 집는다.
- 프런트는 index.html을 캐시하지 않고(no-cache) 해시가 붙은 자산만 1년 캐시하므로, 배포 직후 새로고침하면 새 화면이 뜬다. 이미 열린 탭은 다음 화면 이동 때 옛 자산이 없어 오류가 날 수 있다 — 새로고침 안내.
- 실패 시 되돌리기: 이전 이미지 태그로 `MILDO_IMAGE`를 돌리고 `docker compose up -d`. 새 마이그레이션이 이미 적용됐으면 옛 앱이 새 스키마와 맞지 않을 수 있으므로(/api/ready의 `unknownApplied`에 표시), 업그레이드 전 백업을 위의 '복원' 절차로 되돌린다.
- 여러 app 인스턴스를 둘 때는 migrate를 반드시 한 번만 실행한다(동시 실행 잠금이 없다 — 알려진 한계).

---

## 장애 대응

공통: 먼저 `docker compose ps`, `curl -s http://127.0.0.1:8080/api/ready`, `docker compose logs --tail=200 <서비스>`. 고객 영향이 있으면 PM에게 바로 알리고, 원인 · 조치 · 재발 방지를 이슈 보고서로 남긴다.

**API가 응답하지 않음 (/api/health 실패)**
- `docker compose ps app` — restarting이면 `docker compose logs app`에서 시작 실패 원인(환경변수 누락: "환경변수 … 필요", 키 형식 오류, DB 접속 실패)을 본다.
- DB 문제면 아래 항목. 디스크가 가득 찼으면 `docker system df`, 오래된 이미지 정리 `docker image prune`.
- 급하면 `docker compose up -d app`로 다시 만든다.

**DB 다운 · 연결 실패 (/api/ready not_ready, db.ok=false)**
- `docker compose logs db`. 디스크 부족, 메모리 부족(OOM), 비밀번호 불일치(`POSTGRES_PASSWORD`를 바꾸고 ALTER USER를 안 함)가 흔하다.
- 볼륨 손상이면 '복원' 절차.

**마이그레이션 미적용 (not_ready, migrations.pending)**
- `docker compose logs migrate`에서 실패한 SQL을 본다. 고친 이미지로 `docker compose up -d`. 실패한 마이그레이션은 트랜잭션이라 반쯤 적용되지 않는다.

**워커 멈춤 (degraded, worker.status = stale · stalled · no_activity)**
- `docker compose ps worker`, `docker compose logs --tail=200 worker`.
- 살아 있는데 처리를 안 하면 `docker compose restart worker`. 같은 잡이 계속 실패하면 위 '잡 실패 조회'로 원인을 찾는다.
- 밀린 잡이 많으면 일시적으로 `docker compose up -d --scale worker=2`. 잡은 `SKIP LOCKED`로 나눠 가지므로 같은 잡을 두 워커가 동시에 처리하지 않고, 워크스페이스별 스케줄 잡은 dedupe 키로 중복 생성을 막도록 되어 있다.
- 멈춘 동안 놓친 수집은 다음 스케줄이 따라잡지 못할 수 있다(매시 수집은 당일만). 화면 '데이터 연결'에서 해당 기간을 수동 수집한다. 놓친 감지 · SLA 알림은 재발송되지 않으니 이슈 화면을 직접 확인한다.

**매체 수집 실패 (ingest_runs failed, 화면 수집 현황 오류)**
- 오류 메시지가 인증 실패(401 · 403 · 토큰 만료)면 매체에서 키 · 토큰을 다시 발급해 커넥션에 입력한다. 429면 매체 호출 한도 — 다음 회차에 자동 재시도된다.
- 매체 API가 응답 형식을 바꾼 경우(정규화 실패) 해당 커넥션을 끄고 CSV로 운영하며 개발팀에 이슈를 남긴다.

**잘못된 live 반영**
- 변경 요청 화면에서 해당 건을 롤백(이전 값 반영)한다. 커넥션 쓰기 모드를 즉시 `dry_run`으로 내린다.
- 감사 로그 · 변경 요청 실행 기록(보낸 요청 · 응답)을 이슈 보고서에 붙인다. 같은 시간대 다른 반영도 확인한다.

**429가 많이 남 (속도 제한)**
- 정상 사용자가 막히면 대부분 클라이언트 IP 판정 문제다. 프록시 뒤인데 `TRUST_PROXY_HOPS=0`이면 모든 사용자가 프록시 IP 하나로 묶인다(→ 1). 프록시가 두 단(CDN + Caddy)이면 2.
- 실제 공격이면 앞단(Caddy · 방화벽 · CDN)에서 IP를 막는다. 한도는 프로세스 메모리에서 세므로 app을 재시작하면 초기화된다.

**사용자가 로그인 잠김 (429 login_locked)**
- 같은 이메일로 15분 안에 10회 실패하면 잠긴다(감사 로그 `auth.login_locked`, `detail.scope`가 account면 계정 전체 기준 · ip면 그 IP 기준). 창이 지나면 자동으로 풀린다.
- 비밀번호 재설정을 마치면(감사 `auth.password_reset`) 실패 수를 새로 센다 — 본인이면 재설정을 안내한다. 최근 30일 안에 로그인에 성공한 IP(평소 쓰는 사무실 · 집)에서는 다른 곳에서 쌓인 실패로 잠기지 않는다(그 IP의 실패만 센다). 그래서 남이 일부러 실패를 쌓아도 본인은 평소 장소에서 로그인할 수 있다.
- 급히 풀어야 하면 본인 확인 뒤 비밀번호 재설정 메일을 보낸다(재설정을 마치면 바로 풀린다). 감사 로그를 지워서 풀지 않는다.
- 반복되면 표적 공격일 수 있다: `mpsql -c "SELECT at, ip, actor FROM audit_log WHERE action IN ('auth.login_failed','auth.login_locked') AND at > now() - interval '1 day' ORDER BY at DESC LIMIT 50"`로 IP를 보고 앞단에서 막는다.

**ENCRYPTION_KEY 분실 · 불일치**
- 증상: 커넥션 테스트 · 수집이 '알 수 없는 암호문' 또는 복호화 오류로 실패. 복구 방법은 없다. 올바른 키를 찾거나(비밀번호 관리자 · 이전 .env 백업), 모든 커넥션 자격증명과 알림 채널을 다시 입력한다.

**화면이 실시간으로 갱신되지 않음 (SSE)**
- 프록시가 응답을 버퍼링하면 이벤트가 늦게 온다. Caddy 설정은 `flush_interval -1`. nginx면 `proxy_buffering off`. 회사 방화벽이 긴 연결을 끊으면 브라우저가 자동으로 다시 붙는다(25초마다 ping).

**숫자가 이상함 (고객 문의)**
- 화면 출처 표시가 TEST DATA인지 LIVE DATA인지 먼저 본다. 데모 커넥션이 남아 실데이터 없는 매체에 테스트 데이터가 섞여 있을 수 있다.
- 수집 현황의 품질 경고와 매체 화면 숫자를 같은 날짜로 대조한다. 판정(이상 감지 · 성과 증명)은 기준값과 표본 수를 함께 확인한다.

---

## 데이터 보관

| 데이터 | 보관 | 정리 방법 |
| --- | --- | --- |
| 웨어하우스(wh_*) · 변경 요청 · 이슈 · 코멘트 · 리포트 · 성과 장부 | 계약 기간 동안 | 계약 종료 시 워크스페이스 단위로 삭제(아래) |
| 감사 로그 | 기본 무기한 | 규정이 있으면 `deploy/tools/retention.sql`의 주석 줄을 풀어 기간 지정 |
| 잡 기록 | 성공 62일 · 실패 90일 | `retention.sql` (월간 리포트가 지난달 전체를 볼 수 있게 62일) |
| 로그인 세션 | 만료 후 1일 | `retention.sql` (team 도메인 정리 스케줄도 일부 정리) |
| 비밀번호 재설정 토큰 · 끝난 초대 | 7일 · 90일 | `retention.sql` |
| 알림 발송 이력 | 180일 | `retention.sql` |
| 수집 실행 이력 | 400일 | `retention.sql` |
| DB 백업 | 14일(`BACKUP_KEEP_DAYS`) + 외부 보관 정책 | backup 서비스 |
| 컨테이너 로그 | 서비스당 최대 100 MB | Docker json-file 회전 |

`retention.sql`은 기본으로 돌지 않는다. `.env`에 `RETENTION_ENABLED=true`를 두면 야간 백업 성공 뒤 실행된다. 수동: `docker compose exec -T db psql -U mildo -d mildo -v ON_ERROR_STOP=1 -f - < tools/retention.sql`.

워크스페이스 삭제(계약 종료): 먼저 그 워크스페이스만 덤프해 고객에게 전달하거나 보관한 뒤 지운다. 거의 모든 테이블이 `workspace_id`로 `ON DELETE CASCADE` 연결되어 있다.

```bash
mpsql -c "UPDATE workspaces SET status = 'archived' WHERE slug = '<슬러그>'"          # 먼저 보관 처리(로그인 목록에서 사라짐)
mpsql -c "DELETE FROM workspaces WHERE slug = '<슬러그>'"                              # 보관 기간 후 영구 삭제
```

---

## 보안 메모

- 네트워크: 밖으로 여는 포트는 80 · 443(Caddy)뿐이다. app은 127.0.0.1:8080, db는 내부 네트워크에만 있다.
- 컨테이너: 비root(uid 10001), 읽기 전용 루트 파일시스템(/tmp만 tmpfs), `no-new-privileges`, 커널 권한 전부 제거. 코드 파일은 root 소유라 앱이 스스로 바꿀 수 없다.
- 헤더(`server/src/http/security.ts`): 화면 응답 CSP `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com data:; img-src 'self' data: blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'`, API 응답 CSP `default-src 'none'`, `X-Frame-Options: DENY`, `nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, `Permissions-Policy`(카메라 · 마이크 · 위치 · 결제 등 차단), `Cross-Origin-Opener-Policy` · `Cross-Origin-Resource-Policy: same-origin`, API 응답 `Cache-Control: no-store`, `SECURE_COOKIES=true`일 때 HSTS 1년. 정적 파일은 index.html(304 재검증 응답 포함) no-cache, 해시가 붙은 `/assets/*`만 1년 immutable.
- CSP 점검 결과(2026-11-02, 서버 모드 · Chromium · 로그인 뒤 주요 화면 순회): 차단으로 깨지는 기능은 없고, 위반 보고 1건이 남아 있다 — zod 4가 설정 검사(`src/data/config.ts`, 워크스페이스 설정 적용) 때 JIT 가능 여부를 `new Function("")`으로 시험하면서 `script-src` eval 보고를 낸다. 예외는 zod가 삼키고 일반 검사로 돌아가므로 동작은 같다. 프런트에서 `z.config({ jitless: true })`를 켜면 사라진다(해당 도메인에 요청함). CSP에 `'unsafe-eval'`을 더하지 않는다.
- 경로 판정: 속도 제한 · 로그인 잠금 · API 헤더는 원시 URL 문자열이 아니라 라우터가 고른 라우트(`/api/auth/login`, `/api/w/:ws/events` 등)로 판정한다. `/%61pi/…`처럼 인코딩하거나 `#…`을 붙여 같은 라우트를 불러도 같은 제한을 받는다.
- CSP 때문에 브라우저에서 외부 API를 직접 부르는 기능(예: AI 설정의 '브라우저에서 Anthropic 직접 호출')은 서버 모드에서 막힌다. 서버 모드 AI는 서버 키로 호출하므로 필요 없다. 꼭 써야 하면 `CSP_CONNECT_SRC_EXTRA=https://api.anthropic.com`.
- 인증: 세션 쿠키 httpOnly · SameSite=Lax · Secure, 쓰기 요청 CSRF 토큰, 비밀번호 scrypt, 로그인 IP당 분당 10회(라우트) + 로그인 계열(로그인 · 재설정 요청 · 재설정 토큰 확인 · 재설정 · 초대 수락) IP당 분당 20회 + 같은 이메일 15분 10회 실패 잠금(재설정 뒤 초기화, 최근 성공 IP는 그 IP 실패만). 감사 로그에 로그인 성공 · 실패 · 잠금이 남는다.
- '익숙한 IP' 판정: 이번 요청의 IP는 `TRUST_PROXY_HOPS` 기준으로 고르고(꾸민 X-Forwarded-For 앞부분을 믿지 않음), 감사 로그에 남은 성공 로그인 IP(`req.ip`)와 같을 때만 인정한다. 둘이 다르게 잡히는 환경(사용자 쪽 프록시가 X-Forwarded-For를 붙이는 사내망 등)에서는 익숙한 IP로 인정되지 않고 계정 전체 기준으로 센다 — 잠금이 느슨해지는 방향은 아니다.
- 비밀값: 자격증명 · 웹훅 URL은 AES-256-GCM으로 DB에 저장, 화면 · 로그 · 감사에는 마스킹. `.env`는 `chmod 600`, git에 올리지 않는다.
- 클라이언트 IP: `TRUST_PROXY_HOPS`만큼의 프록시만 믿는다. 앱을 프록시 없이 직접 노출하면서 1로 두면 클라이언트가 X-Forwarded-For를 꾸며 속도 제한을 피할 수 있다(→ 0).
- 알려진 한계
  - 속도 제한 카운터는 프로세스 메모리에 있어 app 인스턴스마다 따로 센다(로그인 실패 잠금은 DB 기준이라 공유된다).
  - Fastify `trustProxy: true`가 고정이라 `req.ip`(감사 로그의 ip)는 X-Forwarded-For 맨 앞 값이다. 프록시 뒤에서는 정확하지만 직접 노출하면 꾸며질 수 있다.
  - 마이그레이션 동시 실행 잠금이 없다(migrate 서비스 하나로 운영).
  - ENCRYPTION_KEY 회전은 짧은 중지가 필요하다. 외부 백업 복사는 자동화되어 있지 않다.
  - 매체 · 판매 채널 커넥터는 실계정 검증 전이다(화면 표시).
- 취약점 점검: CI가 `npm audit --omit=dev`를 참고용으로 돌린다. 운영 이미지는 월 1회 이상 다시 빌드해 기반 이미지(node:22-bookworm-slim, postgres:16, caddy:2) 보안 패치를 받는다.

---

## 로컬 점검 · CI

- 서버 테스트(실제 PostgreSQL): `npm run pg:dev && npm run test:server`. 보안 · 레디니스 · 키 회전 도구: `npx vitest run --config vitest.server.config.ts server/test/security.test.ts`.
- 통합 스모크: `bash scripts/smoke-cloud.sh` — 새 DB → 마이그레이션 · 시드 → 서버 · 워커 → 데모 백필 → `/api/ready` → curl 로그인(쿠키 · CSRF) → Dataset 날짜 수 → 보안 헤더 → 로그아웃 → 우아한 종료 → DB 삭제. 실패하면 멈춘 단계와 로그 끝부분을 보여 준다. 번들로 돌리려면 `npm run server:build && SMOKE_RUNTIME=dist bash scripts/smoke-cloud.sh`.
- CI(`.github/workflows/ci.yml`): 타입 검사 · 프런트 테스트 · 빌드(vite · 단일 파일 · 서버 번들), 서버 테스트(postgres:16 서비스), 통합 스모크, 브라우저 E2E(데모 모드), 이미지 빌드 + compose 기동 점검을 push · PR마다 돌린다.
