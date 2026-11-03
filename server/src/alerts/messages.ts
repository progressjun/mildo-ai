/**
 * 알림 메시지 — 형식 구현은 src/modules/notify/message.ts(순수 함수, 화면 미리보기와 공용).
 * 서버에서는 발송 시각을 서버 시계(lib/time.ts)로 넣는다.
 */
import { buildMessage as build, type Message, type MessageInput } from '@/modules/notify/message';
import { nowMs } from '../lib/time';

export * from '@/modules/notify/message';

export function buildMessage(m: MessageInput): Message {
  return build({ ...m, sentAtMs: m.sentAtMs ?? nowMs() });
}
