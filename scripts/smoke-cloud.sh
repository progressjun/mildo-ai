#!/usr/bin/env bash
# MILDO OS Cloud 통합 스모크 (로컬 · CI)
#   새 DB 생성 → 마이그레이션 · 시드(데모 데이터 · 데모 역할 계정) → 서버 · 워커를 시험 포트로 기동 → /api/health 대기
#   → 데모 백필 잡 처리(db CLI run-jobs + 워커) → /api/ready(워커 자체 하트비트 포함) → curl 로그인(쿠키 · CSRF)
#   → /api/w/<ws>/dataset 날짜 수 확인 → SSE 연결(hello 이벤트 · 보안 헤더) → 두 역할 권한 확인(client 거부 · owner 허용)
#   → 보안 헤더 · CSRF 거부 · 로그아웃 → 프로세스 종료(우아한 종료 시간 확인) → DB 삭제.
#   실패하면 어느 단계에서 왜 멈췄는지와 서버 · 워커 로그 끝부분을 보여 주고 0이 아닌 코드로 끝난다.
#
# 사용:  bash scripts/smoke-cloud.sh                 (로컬 PostgreSQL: npm run pg:dev)
#        SMOKE_RUNTIME=dist bash scripts/smoke-cloud.sh   (npm run server:build 뒤 번들로 실행 — CI)
# 환경변수:
#   SMOKE_ADMIN_URL     DB를 만들고 지울 관리 접속 URL (기본 postgres://mildo@/postgres?host=/tmp&port=55432)
#   SMOKE_RUNTIME       tsx(기본: 소스 실행) | dist(server/dist 번들)
#   SMOKE_PORT          API 포트 (기본 18080)
#   SMOKE_DB            만들고 지울 DB 이름 (기본 mildo_smoke_<시각>_<pid>, 영문 소문자 · 숫자 · _만)
#   SMOKE_EXPECT_DATES  Dataset 날짜 수 기대값 (기본 120 — src/data/demo.ts와 같은 기간)
#   SMOKE_TIMEOUT       잡 처리 대기 최대 초 (기본 240)
#   SMOKE_SCHEDULER     워커 스케줄 on|off (기본 off: 결과를 결정적으로)
#   SMOKE_KEEP=1        끝나도 DB · 로그 폴더를 남긴다 (디버깅)
#   STATIC_DIR          서빙할 프런트 빌드 폴더 (기본 dist). index.html이 있으면 화면 CSP · 캐시 헤더까지 확인한다
set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

ADMIN_URL="${SMOKE_ADMIN_URL:-postgres://mildo@/postgres?host=/tmp&port=55432}"
RUNTIME="${SMOKE_RUNTIME:-tsx}"
PORT="${SMOKE_PORT:-18080}"
EXPECT_DATES="${SMOKE_EXPECT_DATES:-120}"
STATIC="${STATIC_DIR:-dist}"
TIMEOUT="${SMOKE_TIMEOUT:-240}"
BASE="http://127.0.0.1:$PORT"
DB="${SMOKE_DB:-mildo_smoke_$(date +%s)_$$}"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/mildo-smoke.XXXXXX")"
JAR="$WORK/cookies.txt"
OWNER_EMAIL="smoke-owner@mildo.local"
OWNER_PASSWORD="SmokeOwner#2027"
# 데모 역할 계정 (db/cli.ts seed, SEED_DEMO_USERS=true) — 권한 거부 확인용
CLIENT_EMAIL="client@mildo.local"
CLIENT_PASSWORD="MildoClient#2027"
SERVER_PID=""
WORKER_PID=""
DB_CREATED=0
STEP="준비"
STEP_N=0
STEP_TOTAL=15
START_TS=$(date +%s)

c_red=$'\e[31m'; c_grn=$'\e[32m'; c_dim=$'\e[2m'; c_off=$'\e[0m'
[ -t 1 ] || { c_red=""; c_grn=""; c_dim=""; c_off=""; }

step() { STEP_N=$((STEP_N + 1)); STEP="$1"; echo "▶ [$STEP_N/$STEP_TOTAL] $1"; }
ok() { echo "  ${c_grn}✓${c_off} $*"; }
info() { echo "  ${c_dim}$*${c_off}"; }

show_logs() {
  for f in server worker cli; do
    if [ -s "$WORK/$f.log" ]; then
      echo "  ── $f 로그 (마지막 25줄) ──"
      tail -n 25 "$WORK/$f.log" | sed 's/^/  │ /'
    fi
  done
}

fail() {
  echo "${c_red}✗ 실패 단계: [$STEP_N/$STEP_TOTAL] $STEP${c_off}"
  echo "  원인: $*"
  show_logs
  exit 1
}

on_err() {
  local code=$? line=$1
  trap - ERR
  fail "예상치 못한 명령 실패 (종료 코드 $code, smoke-cloud.sh ${line}행)"
}
trap 'on_err $LINENO' ERR

stop_proc() { # pid name → 종료까지 걸린 초를 출력, 15초 넘으면 강제 종료하고 1 반환
  local pid=$1 i
  [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null || { echo 0; return 0; }
  kill -TERM "$pid" 2>/dev/null || true
  for i in $(seq 1 150); do
    kill -0 "$pid" 2>/dev/null || { echo $(( (i + 9) / 10 )); return 0; }
    sleep 0.1
  done
  kill -KILL "$pid" 2>/dev/null || true
  echo 15
  return 1
}

cleanup() {
  local code=$?
  trap - ERR
  set +e
  [ -n "$SERVER_PID" ] && kill -0 "$SERVER_PID" 2>/dev/null && stop_proc "$SERVER_PID" >/dev/null
  [ -n "$WORKER_PID" ] && kill -0 "$WORKER_PID" 2>/dev/null && stop_proc "$WORKER_PID" >/dev/null
  if [ "${SMOKE_KEEP:-0}" = "1" ]; then
    echo "  SMOKE_KEEP=1 — DB $DB · 로그 $WORK 를 남겼습니다"
  else
    [ "$DB_CREATED" = "1" ] && pg_admin "DROP DATABASE IF EXISTS \"$DB\" WITH (FORCE)" >/dev/null 2>&1
    rm -rf "$WORK"
  fi
  if [ "$code" = "0" ]; then
    echo "${c_grn}스모크 통과${c_off} ($(( $(date +%s) - START_TS ))초)"
  fi
  exit "$code"
}
trap cleanup EXIT

# 관리 접속으로 SQL 한 문장 (psql 없이 node + pg)
pg_admin() {
  node -e '
    const pg = require("pg");
    const c = new pg.Client({ connectionString: process.argv[1] });
    c.connect().then(() => c.query(process.argv[2])).then((r) => { if (r.rows?.length) console.log(JSON.stringify(r.rows)); return c.end(); })
      .catch((e) => { console.error(e.message); process.exit(1); });' "$ADMIN_URL" "$1"
}
# 시험 DB에서 SQL 한 문장 → 첫 행 첫 값
pg_val() {
  node -e '
    const pg = require("pg");
    const c = new pg.Client({ connectionString: process.argv[1] });
    c.connect().then(() => c.query(process.argv[2])).then((r) => { const row = r.rows[0]; console.log(row ? Object.values(row)[0] ?? "" : ""); return c.end(); })
      .catch((e) => { console.error(e.message); process.exit(1); });' "$DB_URL" "$1"
}
# JSON 파일에서 값 꺼내기: jget <파일> '<d를 쓰는 식>'
jget() {
  node -e '
    const fs = require("fs");
    let d; try { d = JSON.parse(fs.readFileSync(process.argv[1], "utf8")); } catch { console.log(""); process.exit(0); }
    const v = new Function("d", "return (" + process.argv[2] + ")")(d);
    console.log(v === undefined || v === null ? "" : typeof v === "object" ? JSON.stringify(v) : String(v));' "$1" "$2"
}
# http <메서드> <경로> [JSON 본문] [추가 curl 인자...] → $WORK/resp.json · $WORK/resp.h, HTTP_CODE
http() {
  local method=$1 path=$2 body=${3:-}
  shift 3 2>/dev/null || shift $#
  local args=(-sS -o "$WORK/resp.json" -D "$WORK/resp.h" -w '%{http_code}' -X "$method" -b "$JAR" -c "$JAR" --max-time 30)
  [ -n "$body" ] && args+=(-H 'content-type: application/json' --data "$body")
  HTTP_CODE=$(curl "${args[@]}" "$@" "$BASE$path" 2>"$WORK/curl.err" || echo "000")
}
header() { grep -i "^$1:" "$WORK/resp.h" | head -1 | cut -d: -f2- | tr -d '\r' | sed 's/^ *//'; }

run_cli() { # cli 명령 → $WORK/cli.log
  if [ "$RUNTIME" = "dist" ]; then node server/dist/cli.mjs "$@" >>"$WORK/cli.log" 2>&1; else node_modules/.bin/tsx server/src/db/cli.ts "$@" >>"$WORK/cli.log" 2>&1; fi
}

# ─────────────────────────────────────────────
step "사전 확인 (node · curl · 의존성 · 실행 파일 · 포트)"
[[ "$DB" =~ ^[a-z_][a-z0-9_]{0,62}$ ]] || fail "SMOKE_DB 이름은 영문 소문자 · 숫자 · _만 쓸 수 있습니다: $DB"
command -v node >/dev/null || fail "node가 없습니다 (Node 22 필요)"
command -v curl >/dev/null || fail "curl이 없습니다"
[ -d node_modules/pg ] || fail "node_modules가 없습니다 — npm ci를 먼저 실행하세요"
case "$RUNTIME" in
  dist) for f in index worker cli; do [ -f "server/dist/$f.mjs" ] || fail "server/dist/$f.mjs가 없습니다 — npm run server:build를 먼저 실행하세요"; done
        SERVER_CMD=(node server/dist/index.mjs); WORKER_CMD=(node server/dist/worker.mjs) ;;
  tsx)  [ -x node_modules/.bin/tsx ] || fail "tsx가 없습니다 — npm ci (dev 의존성 포함)"
        SERVER_CMD=(node_modules/.bin/tsx server/src/index.ts); WORKER_CMD=(node_modules/.bin/tsx server/src/worker.ts) ;;
  *) fail "SMOKE_RUNTIME은 tsx 또는 dist여야 합니다 (지금: $RUNTIME)" ;;
esac
if curl -s -o /dev/null --max-time 2 "$BASE/api/health"; then fail "포트 $PORT에 이미 다른 서버가 떠 있습니다 — SMOKE_PORT로 바꾸세요"; fi
ok "runtime=$RUNTIME · port=$PORT · 작업 폴더 $WORK"

# ─────────────────────────────────────────────
step "새 데이터베이스 생성 ($DB)"
pg_admin "SELECT 1" >/dev/null 2>"$WORK/cli.log" || fail "관리 접속 실패: $(tail -1 "$WORK/cli.log") — PostgreSQL이 떠 있는지(npm run pg:dev), SMOKE_ADMIN_URL=$ADMIN_URL 확인"
pg_admin "CREATE DATABASE \"$DB\"" >/dev/null 2>"$WORK/cli.log" || fail "CREATE DATABASE 실패: $(tail -1 "$WORK/cli.log")"
DB_CREATED=1
# postgres://user@/postgres?host=/tmp 처럼 호스트가 빈 소켓 URL도 있으므로 URL 파서 대신 경로 부분만 바꾼다
DB_URL=$(node -e '
  const m = process.argv[1].match(/^(postgres(?:ql)?:\/\/[^/?]*)(\/[^?]*)?(\?.*)?$/);
  if (!m) { console.error("SMOKE_ADMIN_URL 형식을 알 수 없습니다"); process.exit(1); }
  console.log(m[1] + "/" + process.argv[2] + (m[3] || ""));' "$ADMIN_URL" "$DB") || fail "SMOKE_ADMIN_URL 형식을 알 수 없습니다: $ADMIN_URL"

ok "생성 완료"

# 서버 · 워커 · CLI 공통 환경 (프로덕션 설정 경로로 실행: 필수 비밀값 검사까지 거친다)
export NODE_ENV=production
export DATABASE_URL="$DB_URL"
ENCRYPTION_KEY="$(node -e 'console.log(require("crypto").randomBytes(32).toString("base64"))')"
SESSION_SECRET="$(node -e 'console.log(require("crypto").randomBytes(48).toString("base64"))')"
export ENCRYPTION_KEY SESSION_SECRET
export SECURE_COOKIES=false
export APP_URL="$BASE"
export PORT HOST=127.0.0.1
export LOG_LEVEL=warn
export STATIC_DIR="$STATIC"
export MIGRATE_ON_START=false
export SEED_OWNER_EMAIL="$OWNER_EMAIL" SEED_OWNER_PASSWORD="$OWNER_PASSWORD" SEED_OWNER_NAME="스모크 owner"
export SEED_DEMO_DATA=true SEED_DEMO_USERS=true
unset ANTHROPIC_API_KEY SMTP_HOST || true

# ─────────────────────────────────────────────
step "마이그레이션 · 시드 (owner + 데모 역할 계정 + 데모 커넥션 · 백필 잡 예약)"
run_cli migrate || fail "마이그레이션 실패: $(tail -3 "$WORK/cli.log" | tr '\n' ' ')"
run_cli seed || fail "시드 실패: $(tail -3 "$WORK/cli.log" | tr '\n' ' ')"
MIGS=$(pg_val "SELECT count(*) FROM schema_migrations")
FILES=0
for f in server/migrations/[0-9][0-9][0-9]_*.sql; do [ -e "$f" ] && FILES=$((FILES + 1)); done
[ "$MIGS" = "$FILES" ] || fail "마이그레이션 $MIGS개 적용 · 파일 $FILES개 — 개수가 다릅니다"
BACKFILL=$(pg_val "SELECT count(*) FROM jobs WHERE type = 'ingest.backfill'")
[ "$BACKFILL" -ge 1 ] || fail "시드가 데모 백필 잡(ingest.backfill)을 만들지 않았습니다"
ok "마이그레이션 $MIGS개 · 백필 잡 $BACKFILL건 대기"

# ─────────────────────────────────────────────
step "서버 · 워커 기동"
"${SERVER_CMD[@]}" >"$WORK/server.log" 2>&1 &
SERVER_PID=$!
SCHEDULER="${SMOKE_SCHEDULER:-off}" WORKER_ID="smoke-worker" "${WORKER_CMD[@]}" >"$WORK/worker.log" 2>&1 &
WORKER_PID=$!
ok "server pid $SERVER_PID · worker pid $WORKER_PID"

# ─────────────────────────────────────────────
step "/api/health 대기 (최대 60초)"
for i in $(seq 1 120); do
  kill -0 "$SERVER_PID" 2>/dev/null || fail "서버 프로세스가 시작 중에 종료됐습니다"
  if curl -s --max-time 2 "$BASE/api/health" 2>/dev/null | grep -q '"ok":true'; then break; fi
  [ "$i" = "120" ] && fail "60초 안에 /api/health가 응답하지 않았습니다"
  sleep 0.5
done
kill -0 "$WORKER_PID" 2>/dev/null || fail "워커 프로세스가 시작 중에 종료됐습니다"
ok "응답 $(curl -s "$BASE/api/health")"

# ─────────────────────────────────────────────
step "데모 백필 잡 처리 (db CLI run-jobs + 워커, 최대 ${TIMEOUT}초)"
run_cli run-jobs || fail "run-jobs 실패: $(tail -3 "$WORK/cli.log" | tr '\n' ' ')"
info "$(grep '잡 .*건 처리' "$WORK/cli.log" | tail -1)"
deadline=$(( $(date +%s) + TIMEOUT ))
while :; do
  PENDING=$(pg_val "SELECT count(*) FROM jobs WHERE status IN ('queued','running') AND run_at <= now()")
  [ "$PENDING" = "0" ] && break
  [ "$(date +%s)" -ge "$deadline" ] && fail "${TIMEOUT}초가 지나도 처리되지 않은 잡 $PENDING건: $(pg_val "SELECT string_agg(type || ':' || status, ', ') FROM jobs WHERE status IN ('queued','running')")"
  sleep 1
done
FAILED=$(pg_val "SELECT count(*) FROM jobs WHERE status = 'failed'")
RETRY=$(pg_val "SELECT count(*) FROM jobs WHERE status = 'queued' AND last_error IS NOT NULL")
[ "$FAILED" = "0" ] || fail "최종 실패 잡 $FAILED건: $(pg_val "SELECT string_agg(type || ' → ' || left(last_error, 160), ' | ') FROM jobs WHERE status = 'failed'")"
[ "$RETRY" = "0" ] || fail "재시도 대기 중인 잡 $RETRY건 (실패 후 백오프): $(pg_val "SELECT string_agg(type || ' → ' || left(last_error, 160), ' | ') FROM jobs WHERE status = 'queued' AND last_error IS NOT NULL")"
BF=$(pg_val "SELECT status FROM jobs WHERE type = 'ingest.backfill' ORDER BY id LIMIT 1")
[ "$BF" = "done" ] || fail "데모 백필 잡 상태가 done이 아닙니다: $BF"
ok "처리 완료: $(pg_val "SELECT string_agg(type || ' ' || n, ', ') FROM (SELECT type, count(*) n FROM jobs GROUP BY type ORDER BY type) x")"

# ─────────────────────────────────────────────
step "/api/ready (DB · 마이그레이션 · 워커 하트비트)"
http GET /api/ready ""
[ "$HTTP_CODE" = "200" ] || fail "/api/ready HTTP $HTTP_CODE: $(jget "$WORK/resp.json" 'd.notes')"
READY=$(jget "$WORK/resp.json" 'd.status')
[ "$READY" = "ready" ] || fail "/api/ready status=$READY · 근거: $(jget "$WORK/resp.json" 'd.notes')"
ok "ready · 워커 $(jget "$WORK/resp.json" 'd.checks.worker.workers.map(w => w.id + (w.cli ? "(CLI)" : "")).join(", ")')"
# 워커 프로세스 자체 하트비트(worker.ts, 60초마다)가 보여야 한다 — CLI(run-jobs) 처리 기록만으로는 ready가 아니다
[ "$(jget "$WORK/resp.json" 'd.checks.worker.workers.some(w => w.id === "smoke-worker" && !w.cli)')" = "true" ] \
  || fail "/api/ready에 워커(smoke-worker) 하트비트가 없습니다: $(jget "$WORK/resp.json" 'd.checks.worker.workers')"
[ -n "$(jget "$WORK/resp.json" 'd.checks.worker.lastHeartbeatAt')" ] || fail "/api/ready worker.lastHeartbeatAt이 비어 있습니다"
# 외부(공인 IP)에는 판정만 — 워커 이름 · 워크스페이스 수가 나가지 않아야 한다
http GET /api/ready "" -H 'x-forwarded-for: 203.0.113.50'
[ "$(jget "$WORK/resp.json" 'd.detail')" = "summary" ] || fail "외부 IP의 /api/ready가 요약(detail=summary)이 아닙니다: $(jget "$WORK/resp.json" 'd.detail')"
[ "$(jget "$WORK/resp.json" 'd.checks.worker.workers.length')" = "0" ] || fail "외부 IP의 /api/ready에 워커 이름이 보입니다"
ok "외부 IP에는 판정만 (detail=summary, status=$(jget "$WORK/resp.json" 'd.status'))"

# ─────────────────────────────────────────────
step "로그인 (curl 쿠키 저장소 + CSRF)"
http POST /api/auth/login "{\"email\":\"$OWNER_EMAIL\",\"password\":\"$OWNER_PASSWORD\"}"
[ "$HTTP_CODE" = "200" ] || fail "로그인 HTTP $HTTP_CODE: $(jget "$WORK/resp.json" 'd.error && d.error.message')"
CSRF=$(jget "$WORK/resp.json" 'd.csrfToken')
[ -n "$CSRF" ] || fail "로그인 응답에 csrfToken이 없습니다"
grep -q mildo_sid "$JAR" || fail "세션 쿠키(mildo_sid)가 저장되지 않았습니다"
http GET /api/auth/me ""
[ "$HTTP_CODE" = "200" ] || fail "/api/auth/me HTTP $HTTP_CODE"
WS=$(jget "$WORK/resp.json" 'd.workspaces[0] && d.workspaces[0].id')
ROLE=$(jget "$WORK/resp.json" 'd.workspaces[0] && d.workspaces[0].role')
[ -n "$WS" ] || fail "내 워크스페이스가 없습니다"
[ "$ROLE" = "owner" ] || fail "시드 owner의 역할이 owner가 아닙니다: $ROLE"
ok "워크스페이스 $WS · 역할 $ROLE"

# ─────────────────────────────────────────────
step "CSRF: 토큰 없는 쓰기 요청은 403"
http POST /api/auth/logout "{}"
[ "$HTTP_CODE" = "403" ] || fail "x-csrf-token 없이 POST했는데 HTTP $HTTP_CODE (403이어야 함)"
[ "$(jget "$WORK/resp.json" 'd.error.code')" = "csrf" ] || fail "403 오류 코드가 csrf가 아닙니다"
ok "거부됨 (code=csrf)"

# ─────────────────────────────────────────────
step "Dataset 확인 (GET /api/w/:ws/dataset — 날짜 ${EXPECT_DATES}개)"
http GET "/api/w/$WS/dataset" ""
[ "$HTTP_CODE" = "200" ] || fail "dataset HTTP $HTTP_CODE: $(jget "$WORK/resp.json" 'd.error && d.error.message')"
NDATES=$(jget "$WORK/resp.json" 'Array.isArray(d.dates) ? d.dates.length : -1')
FIRST=$(jget "$WORK/resp.json" 'd.dates && d.dates[0]')
LAST=$(jget "$WORK/resp.json" 'd.dates && d.dates[d.dates.length - 1]')
TODAY=$(jget "$WORK/resp.json" 'd.today')
NMEDIA=$(jget "$WORK/resp.json" '(d.mediaDaily || []).length')
MODE=$(jget "$WORK/resp.json" 'd.meta && d.meta.mode')
[ "$NDATES" = "$EXPECT_DATES" ] || fail "dates ${NDATES}개 (기대 ${EXPECT_DATES}개, 범위 $FIRST ~ $LAST, today=$TODAY) — warehouse/dataset.ts 기간 계산 확인"
[ "$LAST" = "$TODAY" ] || fail "dates 마지막 날($LAST)이 today($TODAY)가 아닙니다"
[ "$NMEDIA" -gt 0 ] || fail "mediaDaily가 비어 있습니다 (데모 백필 결과가 웨어하우스에 없음)"
[ "$MODE" = "demo" ] || fail "meta.mode=$MODE (데모 데이터만 있으므로 demo여야 함)"
ok "dates $NDATES개 ($FIRST ~ $LAST) · mediaDaily $NMEDIA행 · meta.mode=$MODE"

# ─────────────────────────────────────────────
step "SSE 연결 (GET /api/w/:ws/events — hello 이벤트 · 보안 헤더 · 요청 id)"
# --max-time으로 3초 뒤 끊는다(SSE는 끝나지 않는 응답이라 curl 종료 코드 28은 정상)
curl -sS -N --max-time 3 -b "$JAR" -D "$WORK/sse.h" -o "$WORK/sse.txt" "$BASE/api/w/$WS/events" 2>/dev/null || true
grep -q '^event: hello' "$WORK/sse.txt" || fail "SSE 응답에 hello 이벤트가 없습니다: $(head -c 200 "$WORK/sse.txt")"
grep -qi '^content-type: text/event-stream' "$WORK/sse.h" || fail "SSE content-type이 text/event-stream이 아닙니다"
for h in x-request-id x-content-type-options content-security-policy; do
  grep -qi "^$h:" "$WORK/sse.h" || fail "SSE 응답에 $h 헤더가 없습니다 (hijack 응답 헤더 누락)"
done
ok "hello 수신 · 헤더 확인"

# ─────────────────────────────────────────────
step "권한 (두 역할: client는 감사 로그 거부 · owner는 허용)"
OWNER_JAR="$JAR"
JAR="$WORK/client-cookies.txt"
http POST /api/auth/login "{\"email\":\"$CLIENT_EMAIL\",\"password\":\"$CLIENT_PASSWORD\"}"
[ "$HTTP_CODE" = "200" ] || fail "client 로그인 HTTP $HTTP_CODE: $(jget "$WORK/resp.json" 'd.error && d.error.message')"
http GET /api/auth/me ""
CROLE=$(jget "$WORK/resp.json" 'd.workspaces[0] && d.workspaces[0].role')
[ "$CROLE" = "client" ] || fail "데모 client 계정의 역할이 client가 아닙니다: $CROLE"
http GET "/api/w/$WS/audit" ""
[ "$HTTP_CODE" = "403" ] || fail "client가 감사 로그(configure 권한)를 조회했는데 HTTP $HTTP_CODE (403이어야 함)"
DENY_MSG=$(jget "$WORK/resp.json" 'd.error && d.error.message')
http GET "/api/w/$WS/dataset" ""
[ "$HTTP_CODE" = "200" ] || fail "client의 Dataset 조회(read)가 HTTP $HTTP_CODE"
JAR="$OWNER_JAR"
# auth=1: 워크스페이스 구성원의 계정 기록(로그인 등, workspace_id 없음)도 함께 (team 도메인 audit API)
http GET "/api/w/$WS/audit?auth=1" ""
[ "$HTTP_CODE" = "200" ] || fail "owner의 감사 로그 조회가 HTTP $HTTP_CODE"
[ "$(jget "$WORK/resp.json" 'Array.isArray(d.entries) && d.entries.some(e => e.action === "auth.login")')" = "true" ] || fail "감사 로그에 auth.login 기록이 없습니다"
ok "client 거부(403: $DENY_MSG) · client 읽기 허용 · owner 감사 로그 조회 허용"

# ─────────────────────────────────────────────
step "보안 헤더"
http GET /api/health ""
for h in content-security-policy x-content-type-options x-frame-options x-request-id permissions-policy cross-origin-opener-policy; do
  [ -n "$(header "$h")" ] || fail "/api/health 응답에 $h 헤더가 없습니다"
done
[ "$(header content-security-policy)" = "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'" ] || fail "/api 응답 CSP가 API용(default-src 'none')이 아닙니다: $(header content-security-policy)"
if [ -f "$STATIC/index.html" ]; then
  http GET / ""
  [ "$HTTP_CODE" = "200" ] || fail "/ (index.html) HTTP $HTTP_CODE"
  CSP=$(header content-security-policy)
  for d in "default-src 'self'" "script-src 'self'" "connect-src 'self'" "frame-ancestors 'none'" "object-src 'none'"; do
    echo "$CSP" | grep -qF "$d" || fail "/ 응답 CSP에 $d 가 없습니다: $CSP"
  done
  echo "$CSP" | grep -q "unsafe-eval" && fail "/ 응답 CSP에 unsafe-eval이 있습니다"
  [ "$(header cache-control)" = "no-cache" ] || fail "index.html cache-control이 no-cache가 아닙니다: $(header cache-control)"
  ASSET=$(grep -o 'src="/assets/[^"]*\.js"' "$WORK/resp.json" | head -1 | sed 's/^src="//; s/"$//')
  if [ -n "$ASSET" ]; then
    http GET "$ASSET" ""
    [ "$HTTP_CODE" = "200" ] || fail "$ASSET HTTP $HTTP_CODE"
    echo "$(header cache-control)" | grep -q immutable || fail "해시 자산 $ASSET 의 cache-control이 immutable이 아닙니다: $(header cache-control)"
  fi
  ok "API · 정적 화면 헤더 확인 ($STATIC 서빙 · 자산 ${ASSET:-없음})"
else
  ok "API 헤더 확인 ($STATIC/index.html 없음 — 정적 화면 CSP는 건너뜀)"
fi

# ─────────────────────────────────────────────
step "로그아웃 (CSRF 헤더 포함) → 세션 종료"
http POST /api/auth/logout "{}" -H "x-csrf-token: $CSRF"
[ "$HTTP_CODE" = "200" ] || fail "로그아웃 HTTP $HTTP_CODE"
http GET /api/auth/me ""
[ "$HTTP_CODE" = "401" ] || fail "로그아웃 뒤 /api/auth/me가 HTTP $HTTP_CODE (401이어야 함)"
ok "세션 종료 확인"

# ─────────────────────────────────────────────
step "우아한 종료 (SIGTERM → 15초 안에 종료)"
T_SERVER=$(stop_proc "$SERVER_PID") || fail "서버가 SIGTERM 뒤 15초 안에 끝나지 않아 강제 종료했습니다"
SERVER_PID=""
T_WORKER=$(stop_proc "$WORKER_PID") || fail "워커가 SIGTERM 뒤 15초 안에 끝나지 않아 강제 종료했습니다"
WORKER_PID=""
ok "서버 ${T_SERVER}초 · 워커 ${T_WORKER}초"
