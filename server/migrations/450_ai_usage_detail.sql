-- ai 도메인 (450–479): AI 사용량 기록 상세
-- ai_usage.input_tokens = 이번 호출의 전체 입력 토큰(캐시 미적용 + 캐시 쓰기 + 캐시 읽기). 월 한도는 input_tokens + output_tokens 합으로 판정한다.
-- 아래 열은 같은 호출의 내역 · 결과 표시용이다. 메시지 본문은 어디에도 저장하지 않는다.
ALTER TABLE ai_usage ADD COLUMN IF NOT EXISTS cache_read_tokens int NOT NULL DEFAULT 0;
ALTER TABLE ai_usage ADD COLUMN IF NOT EXISTS cache_creation_tokens int NOT NULL DEFAULT 0;
-- ok · error · cancelled
ALTER TABLE ai_usage ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'ok';
ALTER TABLE ai_usage ADD COLUMN IF NOT EXISTS stop_reason text;
ALTER TABLE ai_usage ADD COLUMN IF NOT EXISTS error_code text;
ALTER TABLE ai_usage ADD COLUMN IF NOT EXISTS duration_ms int;
-- Anthropic 응답의 request-id (지원 문의용, 비밀값 아님)
ALTER TABLE ai_usage ADD COLUMN IF NOT EXISTS request_id text;
-- 실제로 응답한 모델 (서버 측 대체 모델이 응답했으면 그 모델)
ALTER TABLE ai_usage ADD COLUMN IF NOT EXISTS served_model text;
CREATE INDEX IF NOT EXISTS ai_usage_ws_user ON ai_usage (workspace_id, user_id, at DESC);
