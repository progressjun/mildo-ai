-- devops (520–539): 로그인 실패 잠금(http/security.ts loginLockState) 조회 인덱스
-- 비밀번호 재설정(auth.password_reset)도 실패 횟수를 새로 세는 기준점이 된다 — 계정별 최근 재설정 시각을 빠르게 찾는다.
-- 스키마 이름을 하드코딩하지 않는다. 여러 번 실행해도 안전하다(IF NOT EXISTS).
CREATE INDEX IF NOT EXISTS audit_password_reset ON audit_log (user_id, at DESC) WHERE action = 'auth.password_reset';
