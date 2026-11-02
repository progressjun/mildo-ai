#!/usr/bin/env bash
# 로컬 개발 · 테스트용 PostgreSQL 16 (소켓 /tmp, 포트 55432, 사용자 mildo, trust 인증). 이미 떠 있으면 그대로 둔다.
set -euo pipefail
PGBIN="${PGBIN:-$(ls -d /usr/lib/postgresql/*/bin 2>/dev/null | sort -V | tail -1)}"
DATA="${PGDATA_DIR:-/var/lib/postgresql/mildo-dev}"
PORT="${PGPORT_DEV:-55432}"
if ! pg_isready -h /tmp -p "$PORT" >/dev/null 2>&1; then
if [ ! -f "$DATA/PG_VERSION" ]; then
  mkdir -p "$DATA"; chown postgres:postgres "$DATA"; chmod 700 "$DATA"
  su postgres -s /bin/bash -c "$PGBIN/initdb -D $DATA -U mildo --auth=trust -E UTF8 --locale=C.UTF-8 >/dev/null"
fi
su postgres -s /bin/bash -c "$PGBIN/pg_ctl -D $DATA -o '-p $PORT -k /tmp' -l $DATA/log start" >/dev/null
for i in $(seq 1 20); do pg_isready -h /tmp -p "$PORT" >/dev/null 2>&1 && break; sleep 0.5; done
fi
for db in mildo_dev mildo_test; do
  psql -h /tmp -p "$PORT" -U mildo -d postgres -tc "SELECT 1 FROM pg_database WHERE datname='$db'" | grep -q 1 || psql -h /tmp -p "$PORT" -U mildo -d postgres -c "CREATE DATABASE $db" >/dev/null
done
echo "PostgreSQL 준비 (/tmp:$PORT) · DB mildo_dev, mildo_test"
