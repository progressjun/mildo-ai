/**
 * MILDO Alert 센티널 CLI — 서버/크론에서 탐지 규칙을 돌려 메신저로 알림을 보낸다.
 *
 *   npm run sentinel                 # 테스트 데이터로 탐지 결과 출력
 *   npm run sentinel -- --json       # JSON 출력
 *   SLACK_WEBHOOK_URL=... npm run sentinel -- --send   # P1/P2를 메신저(Slack Incoming Webhook)로 전송
 *   NAVER_SA_API_KEY=... NAVER_SA_SECRET=... NAVER_SA_CUSTOMER_ID=... npm run sentinel -- --live-bizmoney
 *                                    # 네이버 SA 비즈머니 실잔액으로 계정 · 결제 P1 점검 추가
 *
 * 크론 예시 (5분 간격, 24시간 감지): 5-59/5 * * * *  cd /opt/mildo-os && npm run -s sentinel -- --send
 */
import { generateDemoData } from '../src/data/demo';
import { detectIncidents } from '../src/modules/alert/engine';
import { SLA } from '../src/data/constants';
import type { Incident } from '../src/core/types';
import { credentialsFromEnv, naverSa } from './naver-searchad';

const args = new Set(process.argv.slice(2));

function line(i: Incident): string {
  const delta = i.deltaPct !== undefined && Number.isFinite(i.deltaPct) ? ` (기준 대비 ${i.deltaPct > 0 ? '+' : ''}${i.deltaPct.toFixed(0)}%)` : '';
  return `[${i.severity}] ${i.title}${delta}${i.isTest ? ' · TEST DATA' : ''}`;
}

export function toMessengerText(i: Incident): string {
  const sla = SLA[i.severity];
  return [
    `*${i.severity} · ${i.title}*${i.isTest ? '  _(테스트 데이터)_' : ''}`,
    `감지 ${i.detectedAt.slice(0, 16).replace('T', ' ')} · 경로 ${i.detectPath}`,
    i.metric ? `지표 ${i.metric}: 관측 ${i.observed ?? '-'} / 기준 ${i.baseline ?? '-'}` : '',
    i.causeCandidates.length ? `원인 후보: ${i.causeCandidates.join(' · ')}` : '',
    i.autoActions.length ? `자동 조치: ${i.autoActions.join(' · ')}` : '',
    `SLA: 인지 ${sla.label.ack} · 1차 조치 ${sla.label.action} · 결과 보고 ${sla.label.report}`,
    i.assignee ? `담당 ${i.assignee}${i.backup ? ` · 백업 ${i.backup}` : ''}` : '',
  ].filter(Boolean).join('\n');
}

async function main() {
  const data = generateDemoData();
  const incidents = detectIncidents(data);

  if (args.has('--live-bizmoney')) {
    const cred = credentialsFromEnv();
    if (!cred) {
      console.error('NAVER_SA_API_KEY / NAVER_SA_SECRET / NAVER_SA_CUSTOMER_ID 환경변수가 필요합니다.');
      process.exitCode = 2;
    } else {
      const { bizmoney } = await naverSa.bizmoney(cred);
      const avg = data.accounts.find((a) => a.media === 'naver_sa')?.avgDailySpend ?? 0;
      console.log(`네이버 SA 비즈머니 실잔액 ${bizmoney.toLocaleString('ko-KR')}원 · 일 평균 소진(설정값) ${avg.toLocaleString('ko-KR')}원`);
      if (avg > 0 && bizmoney < avg) console.log('→ P1 계정 · 결제: 잔액 1일치 미만');
    }
  }

  if (args.has('--json')) {
    console.log(JSON.stringify(incidents, null, 2));
  } else {
    console.log(`MILDO Alert · ${data.today} ${data.currentHour}:30 기준 · 이슈 ${incidents.length}건`);
    for (const i of incidents) console.log(`  ${line(i)}`);
  }

  if (args.has('--send')) {
    const url = process.env.SLACK_WEBHOOK_URL;
    if (!url) {
      console.error('SLACK_WEBHOOK_URL 환경변수가 없어 전송하지 않았습니다.');
      process.exitCode = 2;
      return;
    }
    const urgent = incidents.filter((i) => i.severity !== 'P3');
    for (const i of urgent) {
      const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: toMessengerText(i) }) });
      console.log(`  전송 ${res.ok ? '완료' : `실패(${res.status})`}: ${line(i)}`);
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
