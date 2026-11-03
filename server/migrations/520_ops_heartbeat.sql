-- devops (520–539): 운영 상태 확인용 워커 하트비트 · 조회 인덱스
-- 스키마 이름을 하드코딩하지 않는다 (테스트는 파일마다 임시 스키마). 여러 번 실행해도 안전하게 IF NOT EXISTS · OR REPLACE를 쓴다.
--
-- 워커 하트비트: worker.ts를 고치지 않고 jobs 행의 상태 변화(잡을 집어 갈 때 · 끝낼 때)에서 워커 생존 시각을 파생한다.
--   jobs.locked_by = '<WORKER_ID>#<레인 번호>' (jobs/queue.ts claim) → worker_id = '#' 앞부분.
--   DB CLI(run-jobs · seed --run-jobs)는 'drain'으로 기록된다.
-- 잡이 하나도 없는 시간에는 하트비트가 갱신되지 않는다 — /api/ready는 활성 워크스페이스가 있는데
-- 15분(READY_WORKER_STALE_MIN) 동안 잡 처리 흔적이 없으면 degraded로 본다 (스케줄 잡이 10분 간격으로 생기므로).

CREATE TABLE IF NOT EXISTS worker_heartbeats (
  worker_id text PRIMARY KEY,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  last_job_id bigint,
  last_job_type text,
  last_status text,
  jobs_seen bigint NOT NULL DEFAULT 0
);

CREATE OR REPLACE FUNCTION mildo_worker_heartbeat() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  -- 하트비트 기록이 실패해도 잡 처리는 계속되어야 한다 (예외를 삼킨다)
  BEGIN
    INSERT INTO worker_heartbeats (worker_id, last_seen_at, last_job_id, last_job_type, last_status, jobs_seen)
    VALUES (left(split_part(NEW.locked_by, '#', 1), 200), now(), NEW.id, NEW.type, NEW.status, 1)
    ON CONFLICT (worker_id) DO UPDATE
      SET last_seen_at = now(),
          last_job_id = EXCLUDED.last_job_id,
          last_job_type = EXCLUDED.last_job_type,
          last_status = EXCLUDED.last_status,
          jobs_seen = worker_heartbeats.jobs_seen + 1;
  EXCEPTION WHEN OTHERS THEN
    NULL;
  END;
  RETURN NULL;
END
$$;

DROP TRIGGER IF EXISTS jobs_worker_heartbeat ON jobs;
CREATE TRIGGER jobs_worker_heartbeat
  AFTER UPDATE OF status ON jobs
  FOR EACH ROW
  WHEN (NEW.locked_by IS NOT NULL AND NEW.status IN ('running', 'done', 'failed'))
  EXECUTE FUNCTION mildo_worker_heartbeat();

-- /api/ready · 운영 조회: 최근 끝난 잡, 최근 실패 잡
CREATE INDEX IF NOT EXISTS jobs_finished_recent ON jobs (finished_at DESC) WHERE finished_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS jobs_failed_recent ON jobs (finished_at DESC) WHERE status = 'failed';

-- 로그인 실패 잠금(http/security.ts): 이메일별 최근 실패 · 성공 조회
CREATE INDEX IF NOT EXISTS audit_login_failed ON audit_log (lower(actor), at DESC) WHERE action = 'auth.login_failed';
CREATE INDEX IF NOT EXISTS audit_login_ok ON audit_log (user_id, at DESC) WHERE action = 'auth.login';
