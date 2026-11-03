-- changes 도메인 (docs/SAAS_SPEC.md §4 changes · 번호 대역 300–349)
-- 변경 요청 실행 상태 · 반영 시각 · 실행 시도 기록. 스키마 이름을 하드코딩하지 않는다. 다시 실행해도 안전하게(IF NOT EXISTS).

-- 실행 중 표시: { attemptId, phase: apply|retry|rollback, since, by: { userId, name }, label, note, timedOut?, plan? }
-- null이 아니면 다른 반영 · 롤백 · 보류 요청을 409로 막는다(중복 반영 방지). 처리가 끝나면 null로 되돌린다.
ALTER TABLE change_requests ADD COLUMN IF NOT EXISTS exec_pending jsonb;
-- 반영 · 롤백 시각 (성과 증명 장부의 반영 전후 비교 · 일 누적 조정 폭 계산 기준)
ALTER TABLE change_requests ADD COLUMN IF NOT EXISTS applied_at timestamptz;
ALTER TABLE change_requests ADD COLUMN IF NOT EXISTS rolled_back_at timestamptz;
-- 낙관적 동시성 표시 (변경마다 +1)
ALTER TABLE change_requests ADD COLUMN IF NOT EXISTS version int NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS change_requests_ws_status ON change_requests (workspace_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS change_requests_ws_target ON change_requests (workspace_id, target_id, kind);
CREATE INDEX IF NOT EXISTS change_requests_pending ON change_requests (workspace_id) WHERE exec_pending IS NOT NULL;

-- 매체 반영 시도 기록 — dry_run · live · 기록만 · 실패 · 롤백 · 보상(되돌림)까지 한 줄씩. 요청 · 응답은 비밀값을 가린 요약만 저장한다.
CREATE TABLE IF NOT EXISTS change_executions (
  id bigserial PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  change_id text NOT NULL,
  attempt_id text NOT NULL,
  phase text NOT NULL CHECK (phase IN ('apply', 'retry', 'rollback', 'compensate')),
  mode text NOT NULL CHECK (mode IN ('none', 'dry_run', 'live')),
  ok boolean NOT NULL,
  connection_id uuid,
  provider text,
  target_external_id text,
  request jsonb,
  response jsonb,
  error text,
  applied_value jsonb,
  actor text NOT NULL,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS change_executions_change ON change_executions (workspace_id, change_id, id DESC);
