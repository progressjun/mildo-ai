-- data 도메인 (connectors · ingest · warehouse) 추가 스키마 — docs/SAAS_SPEC.md §4 data
-- 001_core.sql의 connections · ingest_runs · uploads · wh_* 위에 얹는다. 스키마 이름을 하드코딩하지 않는다.

-- 업로드: 원본 CSV(가져오기 완료 후 비움) · 고정 매체/채널 · 가져온 시각
ALTER TABLE uploads ADD COLUMN IF NOT EXISTS content text;
ALTER TABLE uploads ADD COLUMN IF NOT EXISTS channel text;
ALTER TABLE uploads ADD COLUMN IF NOT EXISTS imported_at timestamptz;
CREATE INDEX IF NOT EXISTS uploads_ws ON uploads (workspace_id, created_at DESC);

-- 수집 실행: 업로드 연결 · 웨어하우스 출처 키 · 실행 계기(schedule/manual/seed/upload) · 테이블별 건수
ALTER TABLE ingest_runs ADD COLUMN IF NOT EXISTS upload_id uuid REFERENCES uploads(id) ON DELETE CASCADE;
ALTER TABLE ingest_runs ADD COLUMN IF NOT EXISTS source text;
ALTER TABLE ingest_runs ADD COLUMN IF NOT EXISTS triggered_by text NOT NULL DEFAULT 'schedule';
ALTER TABLE ingest_runs ADD COLUMN IF NOT EXISTS stats jsonb NOT NULL DEFAULT '{}'::jsonb;
CREATE INDEX IF NOT EXISTS ingest_runs_conn ON ingest_runs (connection_id, started_at DESC);

-- 데모 커넥션은 워크스페이스당 하나 (웨어하우스 출처 키 'demo' 공유)
CREATE UNIQUE INDEX IF NOT EXISTS connections_one_demo ON connections (workspace_id) WHERE provider = 'demo';

-- Dataset 빌더 조회 (엔티티 종류별 · 기간별)
CREATE INDEX IF NOT EXISTS wh_entities_ws_type ON wh_entities (workspace_id, entity_type);
CREATE INDEX IF NOT EXISTS wh_media_hourly_ws_date ON wh_media_hourly (workspace_id, date);
CREATE INDEX IF NOT EXISTS wh_keyword_daily_ws_date ON wh_keyword_daily (workspace_id, date);
CREATE INDEX IF NOT EXISTS wh_search_term_daily_ws_date ON wh_search_term_daily (workspace_id, date);
