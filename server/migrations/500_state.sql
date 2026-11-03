-- platform(state) 도메인: 코멘트 작성자 역할 · 해결 이력, 조회 인덱스 (docs/SAAS_SPEC.md §4 platform, §6 platform(state))
-- 스키마 이름을 하드코딩하지 않는다. 여러 번 적용해도 안전하게(IF NOT EXISTS).

-- 작성 시점의 멤버십 역할 (프런트 표시 역할 '담당 AE' · 'PM' · '수면밀도' 매핑에 쓴다)
ALTER TABLE comments ADD COLUMN IF NOT EXISTS author_role text;
ALTER TABLE comments ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE comments ADD COLUMN IF NOT EXISTS resolved_at timestamptz;
ALTER TABLE comments ADD COLUMN IF NOT EXISTS resolved_by uuid REFERENCES users(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS comments_ws_at ON comments (workspace_id, at);
CREATE INDEX IF NOT EXISTS comments_ws_target ON comments (workspace_id, target);
