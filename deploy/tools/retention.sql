-- MILDO OS Cloud 보관 기간 정리 (docs/OPERATIONS.md '데이터 보관').
-- 실행: backup 서비스에서 RETENTION_ENABLED=true면 야간 백업 뒤 자동, 수동은
--   docker compose exec -T db psql -U mildo -d mildo -v ON_ERROR_STOP=1 -f - < deploy/tools/retention.sql
-- 지우는 것은 운영 부산물뿐이다. 고객 데이터(웨어하우스 wh_*, 변경 요청, 이슈, 리포트, 성과 장부)와 감사 로그는 지우지 않는다.
-- 기간을 바꾸려면 아래 interval 값을 고친다.

BEGIN;

-- 끝난 잡: 성공 62일, 최종 실패 90일 (실패 원인 추적용으로 더 오래)
-- 성공 잡을 62일 남기는 이유: 월간 리포트 · 성과 증명(익월 3영업일 생성)이 지난달 전체 기간의 자동화 건수를 볼 수 있게.
-- 더 오래 필요한 집계는 jobs가 아니라 ingest_runs · reports · incidents · impact_ledger에서 센다.
DELETE FROM jobs WHERE status = 'done' AND finished_at < now() - interval '62 days';
DELETE FROM jobs WHERE status = 'failed' AND finished_at < now() - interval '90 days';

-- 만료된 로그인 세션 · 비밀번호 재설정 토큰 · 끝난 초대
DELETE FROM sessions WHERE expires_at < now() - interval '1 day';
DELETE FROM password_resets WHERE expires_at < now() - interval '7 days';
DELETE FROM invites WHERE (accepted_at IS NOT NULL OR revoked_at IS NOT NULL OR expires_at < now()) AND created_at < now() - interval '90 days';

-- 알림 발송 이력 180일, 수집 실행 이력 400일(백필 한도와 같게)
DELETE FROM notifications WHERE at < now() - interval '180 days';
DELETE FROM ingest_runs WHERE finished_at IS NOT NULL AND started_at < now() - interval '400 days';

-- 30일 넘게 보이지 않은 워커 하트비트(교체된 컨테이너)
DELETE FROM worker_heartbeats WHERE last_seen_at < now() - interval '30 days';

-- 감사 로그는 기본으로 지우지 않는다. 계약 · 내부 규정상 기간이 정해져 있으면 아래 줄의 주석을 풀고 기간을 맞춘다.
-- DELETE FROM audit_log WHERE at < now() - interval '3 years';

COMMIT;
