/**
 * reports 도메인 외부 의존성 — 테스트에서 바꿔 끼운다 (실제 네트워크 · SMTP 없이).
 *   const restore = setReportDepsForTest({ emailSender: fakeMail, directSender: fakeSend, queueAvailable: () => false });
 *
 *  - buildDataset: 웨어하우스 → Dataset (data 도메인)
 *  - emailSender: 메일 채널 — 리포트 마크다운 전문을 본문으로 직접 보낸다 (notify.send 잡은 본문을 2,900자로 자르므로)
 *  - directSender: notify.send 잡이 없는 환경(alerts 도메인 미등록)에서 Slack · 웹훅으로 바로 보낼 때
 *  - queueAvailable: notify.send 잡으로 보낼 수 있는지 — 워커가 alerts 잡을 등록했는지 (API 서버 프로세스는 잡을 등록하지 않으므로 '등록 목록이 비어 있음'은 워커가 처리한다고 본다)
 */
import { buildDataset } from '../warehouse/dataset';
import { sendMail } from '../lib/mailer';
import { registeredJobTypes } from '../jobs/queue';
import { sendToChannel } from '../alerts/deliver';

export interface ReportDeps {
  buildDataset: typeof buildDataset;
  emailSender: typeof sendMail;
  directSender: typeof sendToChannel;
  queueAvailable: () => boolean;
}

export const deps: ReportDeps = {
  buildDataset,
  emailSender: sendMail,
  directSender: sendToChannel,
  queueAvailable: () => {
    const types = registeredJobTypes();
    return types.length === 0 || types.includes('notify.send');
  },
};

export function setReportDepsForTest(patch: Partial<ReportDeps>): () => void {
  const prev = { ...deps };
  Object.assign(deps, patch);
  return () => {
    Object.assign(deps, prev);
  };
}
