-- data 도메인: 커넥션별 대기 · 실행 중 수집 잡 조회 (GET /api/w/:ws/connections의 pendingJobs, 커넥션 삭제 시 대기 잡 취소)
-- 001_core.sql의 jobs 위에 얹는 부분 인덱스. 스키마 이름을 하드코딩하지 않는다.
CREATE INDEX IF NOT EXISTS jobs_conn_active ON jobs ((payload->>'connectionId')) WHERE status IN ('queued', 'running');
