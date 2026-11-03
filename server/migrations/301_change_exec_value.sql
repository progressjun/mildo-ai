-- changes 도메인 (번호 대역 300–349): 매체 쓰기 1건이 설정한 값.
-- 다음 수집 전에는 웨어하우스 값이 우리 live 반영 이전 값이라, 다음 요청의 '매체 현재 값'(롤백 복원값 · 재배분 감액 기준)은
-- 마지막 live 쓰기의 값(매체 적용값이 있으면 그 값)으로 본다. 다시 실행해도 안전하게(IF NOT EXISTS), 스키마 이름 없이.
ALTER TABLE change_executions ADD COLUMN IF NOT EXISTS op_after jsonb;
CREATE INDEX IF NOT EXISTS change_executions_target ON change_executions (workspace_id, connection_id, target_external_id, finished_at DESC) WHERE mode = 'live' AND ok;
