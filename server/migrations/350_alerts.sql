-- alerts 도메인 (docs/SAAS_SPEC.md §4 alerts) — 알림 채널 보조 열 · 발송 이력 보조 열 · 감지 실행 기록.
-- 스키마 이름을 하드코딩하지 않는다. 다시 실행해도 안전하도록 IF NOT EXISTS를 쓴다.

-- ---------- 알림 채널 ----------
ALTER TABLE notification_channels ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE notification_channels ADD COLUMN IF NOT EXISTS created_by uuid REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE notification_channels ADD COLUMN IF NOT EXISTS last_test_at timestamptz;
-- 마지막 발송 결과 (sent · failed · skipped) · 사유 — 비밀값을 넣지 않는다
ALTER TABLE notification_channels ADD COLUMN IF NOT EXISTS last_status text;
ALTER TABLE notification_channels ADD COLUMN IF NOT EXISTS last_error text;
ALTER TABLE notification_channels ADD COLUMN IF NOT EXISTS last_sent_at timestamptz;
CREATE INDEX IF NOT EXISTS notification_channels_ws ON notification_channels (workspace_id, created_at);

-- ---------- 발송 이력 ----------
-- 잡 하나(notify.send) = 이력 한 줄. 재시도할 때마다 같은 줄의 상태 · 시도 횟수를 갱신한다.
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS job_id bigint;
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS attempts int NOT NULL DEFAULT 1;
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS channel_type text;
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS severity text;
CREATE UNIQUE INDEX IF NOT EXISTS notifications_job ON notifications (job_id) WHERE job_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS notifications_ws_channel ON notifications (workspace_id, channel_id, at DESC);

-- ---------- 감지 실행 기록 (24시간 감지가 실제로 돌았는지 증명) ----------
CREATE TABLE IF NOT EXISTS alert_scan_runs (
  id bigserial PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  trigger text NOT NULL,               -- schedule · ingest · manual · job
  status text NOT NULL CHECK (status IN ('ok', 'warning', 'failed')),
  found int NOT NULL DEFAULT 0,
  created int NOT NULL DEFAULT 0,
  cleared int NOT NULL DEFAULT 0,      -- 이번 실행에서 '더 이상 감지되지 않음'으로 표시한 건수
  notified int NOT NULL DEFAULT 0,     -- 발송 잡을 만든 건수
  data_today date,
  data_hour smallint,
  data_mode text,                      -- Dataset.meta.mode (demo · live · mixed)
  warning text,
  duration_ms int,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);
CREATE INDEX IF NOT EXISTS alert_scan_runs_ws ON alert_scan_runs (workspace_id, started_at DESC);

-- 이슈 조회: 해결 시각 역순 (최근 해결 500건)
CREATE INDEX IF NOT EXISTS incidents_ws_resolved ON incidents (workspace_id, resolved_at DESC) WHERE status = 'resolved';
