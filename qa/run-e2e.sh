#!/usr/bin/env bash
# MILDO OS 기능 점검 (브라우저 E2E) — 단일 파일 빌드를 만들고 6개 점검 묶음을 순서대로 실행한다.
# claude.ai 런타임(sample · downloads)은 qa/e2e/harness.cjs의 모의 런타임으로 대체한다 (계약 요약: qa/e2e/CONTRACT.md).
# 필요: Playwright + Chromium (전역 설치 시 NODE_PATH로 찾는다). 사용: npm run e2e   (특정 묶음만: npm run e2e -- adpilot-flow)
set -u
cd "$(dirname "$0")/.."
export NODE_PATH="${NODE_PATH:-$(npm root -g)}"
npm run -s build:single || exit 1
HTML="$(pwd)/dist-single/index.html"
SUITES=(global-home-agent board-reports adpilot-flow alert-ops lab-watch geo-growth)
[ $# -gt 0 ] && SUITES=("$@")
mkdir -p qa/logs
fail=0
for s in "${SUITES[@]}"; do
  log="qa/logs/$s.log"
  start=$(date +%s)
  node "qa/e2e/$s.e2e.cjs" "$HTML" > "$log" 2>&1
  code=$?
  p=$(grep -c '^PASS' "$log"); f=$(grep -c '^FAIL' "$log")
  echo "$s: exit=$code PASS=$p FAIL=$f ($(( $(date +%s) - start ))s) → $log"
  [ $code -ne 0 ] && fail=1
done
exit $fail
