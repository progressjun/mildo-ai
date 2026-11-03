-- reports-impact 도메인 (docs/SAAS_SPEC.md §4 reports-impact · 번호 대역 400–449)
-- 리포트 보관함 보조 열 · 예약 생성 중복 방지 · 성과 증명 장부 보조 열. 스키마 이름을 하드코딩하지 않는다. 다시 실행해도 안전하게(IF NOT EXISTS).

-- ---------- 리포트 보관함 ----------
-- 구조화된 리포트 (섹션 · 블록 · 규칙 엔진 해석) — 화면이 마크다운 대신 표로 그릴 때 쓴다
ALTER TABLE reports ADD COLUMN IF NOT EXISTS doc jsonb;
-- 코멘트 범위 (comments.target = reports:<scope>:<sectionId>) — 일간 · 주간은 종류, 월간은 대상 월, 이슈는 이슈별
ALTER TABLE reports ADD COLUMN IF NOT EXISTS scope text;
-- 생성 계기: schedule(예약) · incident(P1 감지) · manual(화면에서 생성)
ALTER TABLE reports ADD COLUMN IF NOT EXISTS trigger text NOT NULL DEFAULT 'manual';
-- 예약 생성 중복 방지 키 (daily:2026-11-01 · weekly:2026-10-26 · monthly:2026-10 · value:2026-10 · issue:<이슈 id>)
ALTER TABLE reports ADD COLUMN IF NOT EXISTS dedupe_key text;
-- 이슈 리포트의 이슈 id
ALTER TABLE reports ADD COLUMN IF NOT EXISTS ref_id text;
-- 데이터 출처 (Dataset.meta.mode: demo · live · mixed) · 데이터 기준 시각 — TEST DATA 표기 근거
ALTER TABLE reports ADD COLUMN IF NOT EXISTS data_mode text;
ALTER TABLE reports ADD COLUMN IF NOT EXISTS data_as_of text;
ALTER TABLE reports ADD COLUMN IF NOT EXISTS created_by uuid REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE reports ADD COLUMN IF NOT EXISTS delivered_at timestamptz;

CREATE UNIQUE INDEX IF NOT EXISTS reports_dedupe ON reports (workspace_id, dedupe_key) WHERE dedupe_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS reports_ws_type ON reports (workspace_id, type, generated_at DESC);
CREATE INDEX IF NOT EXISTS reports_ws_ref ON reports (workspace_id, ref_id) WHERE ref_id IS NOT NULL;

-- ---------- 성과 증명 장부 ----------
-- 귀속 월 (KST 'YYYY-MM') — 변경은 반영 월, 사고는 감지 월, 자동화는 집계 월
ALTER TABLE impact_ledger ADD COLUMN IF NOT EXISTS month text;
-- 사유 · 대상 · 화면 이동 경로 등 표시 보조 정보 (비밀값 없음)
ALTER TABLE impact_ledger ADD COLUMN IF NOT EXISTS detail jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE impact_ledger ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

CREATE INDEX IF NOT EXISTS impact_ledger_ws_month ON impact_ledger (workspace_id, month, source_type);
CREATE INDEX IF NOT EXISTS impact_ledger_ws_status ON impact_ledger (workspace_id, source_type, status);
