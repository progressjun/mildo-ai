-- team 도메인 (docs/SAAS_SPEC.md §4 team, 번호 대역 100–149)
-- 초대 발송 · 수락 · 취소 기록, 재설정 토큰 · 세션 정리용 인덱스, 감사 로그 필터 · 커서 페이지 인덱스.
-- 스키마 이름을 하드코딩하지 않는다 (테스트는 파일마다 임시 스키마).

ALTER TABLE invites ADD COLUMN IF NOT EXISTS accepted_by uuid REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE invites ADD COLUMN IF NOT EXISTS revoked_by uuid REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE invites ADD COLUMN IF NOT EXISTS revoke_reason text;
ALTER TABLE invites ADD COLUMN IF NOT EXISTS mail_sent_at timestamptz;
ALTER TABLE invites ADD COLUMN IF NOT EXISTS mail_error text;
ALTER TABLE invites ADD COLUMN IF NOT EXISTS send_count int NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS invites_ws_created ON invites (workspace_id, created_at DESC);
CREATE INDEX IF NOT EXISTS invites_ws_email ON invites (workspace_id, lower(email));

ALTER TABLE password_resets ADD COLUMN IF NOT EXISTS ip text;
CREATE INDEX IF NOT EXISTS password_resets_user ON password_resets (user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS sessions_expires ON sessions (expires_at);

-- 감사 로그: 커서(before=id) 페이지 · 작업 접두어(LIKE 'x.%') · 사용자 필터
CREATE INDEX IF NOT EXISTS audit_ws_id ON audit_log (workspace_id, id DESC);
CREATE INDEX IF NOT EXISTS audit_ws_action ON audit_log (workspace_id, action text_pattern_ops, id DESC);
CREATE INDEX IF NOT EXISTS audit_user_id ON audit_log (user_id, id DESC);
