#!/usr/bin/env bash
# 야간 PostgreSQL 백업 (docker compose의 backup 서비스, postgres:16 이미지에서 실행).
#   매일 BACKUP_TIME(KST, 기본 03:30)에 pg_dump -Fc → /backups/mildo-<날짜시각>.dump, BACKUP_KEEP_DAYS(기본 14)일 지난 파일 삭제.
#   시작할 때 24시간 안의 덤프가 없으면 바로 한 번 뜬다. 덤프마다 pg_restore --list로 읽히는지 확인한다.
#   RETENTION_ENABLED=true면 백업 성공 뒤 /tools/retention.sql(보관 기간 정리)을 실행한다.
#   한 번만: docker compose run --rm backup --once
# 접속 정보: PGHOST · PGPORT · PGDATABASE · PGUSER · PGPASSWORD (compose가 넣는다)
set -euo pipefail

DIR="${BACKUP_DIR:-/backups}"
AT="${BACKUP_TIME:-03:30}"
KEEP="${BACKUP_KEEP_DAYS:-14}"
mkdir -p "$DIR"

log() { echo "[backup $(date '+%Y-%m-%d %H:%M:%S %Z')] $*"; }

run_backup() {
  local ts out size
  ts="$(date +%Y%m%d-%H%M%S)"
  out="$DIR/mildo-$ts.dump"
  log "시작: $PGDATABASE@$PGHOST → $out"
  if ! pg_dump --format=custom --compress=6 --no-owner --no-privileges --file="$out.partial"; then
    rm -f "$out.partial"
    log "실패: pg_dump 오류"
    return 1
  fi
  if ! pg_restore --list "$out.partial" > /dev/null; then
    rm -f "$out.partial"
    log "실패: 덤프를 읽을 수 없음 (pg_restore --list)"
    return 1
  fi
  mv "$out.partial" "$out"
  ln -sfn "$(basename "$out")" "$DIR/latest.dump"
  size="$(du -h "$out" | cut -f1)"
  find "$DIR" -maxdepth 1 -name 'mildo-*.dump' -mtime +"$KEEP" -print -delete | sed 's/^/[backup] 보관 기간 지나 삭제: /' || true
  log "완료: $out ($size, 보관 ${KEEP}일)"
  if [ "${RETENTION_ENABLED:-false}" = "true" ] && [ -f /tools/retention.sql ]; then
    if psql -v ON_ERROR_STOP=1 -q -f /tools/retention.sql; then log "보관 기간 정리 완료"; else log "보관 기간 정리 실패 (백업은 정상)"; fi
  fi
}

if [ "${1:-}" = "--once" ]; then
  run_backup
  exit $?
fi

until pg_isready -q; do
  log "DB 대기 중"
  sleep 5
done

if ! find "$DIR" -maxdepth 1 -name 'mildo-*.dump' -mmin -1440 | grep -q .; then
  log "24시간 안의 덤프가 없어 지금 한 번 뜹니다"
  run_backup || log "시작 백업 실패 — 다음 예약 시각에 다시 시도"
fi

while true; do
  now="$(date +%s)"
  target="$(date -d "today $AT" +%s)"
  [ "$target" -le "$now" ] && target="$(date -d "tomorrow $AT" +%s)"
  log "다음 백업: $(date -d "@$target" '+%Y-%m-%d %H:%M %Z')"
  sleep $(( target - now ))
  run_backup || log "백업 실패 — 내일 다시 시도 (docker compose logs backup 확인)"
done
