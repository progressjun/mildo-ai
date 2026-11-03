-- settings 도메인 (docs/SAAS_SPEC.md §4 settings) — 워크스페이스 설정 버전 · 마지막 변경 정보 · 설정 이력 조회 인덱스.
-- 설정 값 자체는 workspaces.config(jsonb, 001_core)에 바꾼 항목만 저장한다. 이력은 audit_log(target_type = 'workspace_config')에서 읽는다.
-- 스키마 이름을 하드코딩하지 않는다. 여러 번 실행해도 안전하게 IF NOT EXISTS를 쓴다.

ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS config_version integer NOT NULL DEFAULT 0;
ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS config_updated_at timestamptz;
ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS config_updated_by uuid REFERENCES users(id) ON DELETE SET NULL;

-- 설정 이력 (GET /api/w/:ws/config/history) · 온보딩 '목표 · 예산 확인' 여부
CREATE INDEX IF NOT EXISTS audit_ws_target_id ON audit_log (workspace_id, target_type, id DESC);
