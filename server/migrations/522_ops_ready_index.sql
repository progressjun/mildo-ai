-- devops (520–539): /api/ready 스케줄러 판정 조회 인덱스 (http/security.ts checkWorker)
-- 예약 감지 잡(alerts.scan, payload.trigger = 'schedule')이 마지막으로 생긴 시각을 jobs 전체를 훑지 않고 찾는다.
-- 잡 종류별 최근 생성 조회(운영 SQL: docs/OPERATIONS.md '잡 · 수집 · 알림 실패 조회')에도 쓰인다.
-- 스키마 이름을 하드코딩하지 않는다. 여러 번 실행해도 안전하다(IF NOT EXISTS).
CREATE INDEX IF NOT EXISTS jobs_type_created ON jobs (type, created_at DESC);
