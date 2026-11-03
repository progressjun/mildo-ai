-- data 도메인: OAuth 인증 코드 흐름(카페24)의 state 1회용 기록 — server/src/connectors/oauth.ts
-- state 토큰 자체는 HMAC 서명(세션 비밀값) + 10분 만료로 위조 · 만료를 막고, 이 표는 같은 state의 재사용(콜백 재전송 · 뒤로 가기)을 막는다.
-- 원문 nonce가 아니라 SHA-256만 저장한다. 만료가 지난 행은 콜백 처리 때 지운다. 스키마 이름을 하드코딩하지 않는다.
CREATE TABLE IF NOT EXISTS oauth_state_uses (
  nonce_hash text PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  connection_id uuid,
  user_id uuid,
  used_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS oauth_state_uses_exp ON oauth_state_uses (expires_at);
