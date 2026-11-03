/**
 * 메일 발송 — SMTP 설정(SMTP_HOST 등)이 있으면 nodemailer로 보내고, 없으면 보내지 않고 사유를 돌려준다.
 * 테스트(NODE_ENV=test)에서는 실제 발송 없이 메모리 보낸편지함에 쌓는다(getTestOutbox).
 */
import nodemailer, { type Transporter } from 'nodemailer';
import type { AppConfig } from '../config';

export interface Mail { to: string | string[]; subject: string; text: string; html?: string }
export interface MailResult { sent: boolean; reason?: string; messageId?: string }

const outbox: (Mail & { at: string })[] = [];
export const getTestOutbox = () => outbox;
export const clearTestOutbox = () => { outbox.length = 0; };

let transporter: Transporter | null = null;
let transporterKey = '';

export const SMTP_NOT_CONFIGURED = 'SMTP가 설정되지 않았습니다 (SMTP_HOST)';

/** 테스트(NODE_ENV=test) 전용: SMTP가 없는 서버를 흉내 낸다 — false면 mailConfigured · sendMail이 미설정처럼 동작한다 */
let testMailConfigured = true;
export function setTestMailConfigured(v: boolean): void {
  testMailConfigured = v;
}

/**
 * 이 서버가 메일을 보낼 수 있게 설정되어 있는지 — 서버 전역 설정 사실이라 화면에 알려도 계정 존재 여부가 드러나지 않는다.
 * false면 '메일을 보냈다'고 안내하지 않는다(비밀번호 재설정 화면 · 팀 화면의 재설정 링크 발급).
 */
export function mailConfigured(config: AppConfig): boolean {
  return config.env === 'test' ? testMailConfigured : !!config.smtp;
}

export async function sendMail(config: AppConfig, mail: Mail): Promise<MailResult> {
  if (config.env === 'test') {
    if (!testMailConfigured) return { sent: false, reason: SMTP_NOT_CONFIGURED };
    outbox.push({ ...mail, at: new Date().toISOString() });
    return { sent: true, messageId: `test-${outbox.length}` };
  }
  if (!config.smtp) return { sent: false, reason: SMTP_NOT_CONFIGURED };
  const key = JSON.stringify(config.smtp);
  if (!transporter || key !== transporterKey) {
    transporter = nodemailer.createTransport({
      host: config.smtp.host,
      port: config.smtp.port,
      secure: config.smtp.secure,
      auth: config.smtp.user ? { user: config.smtp.user, pass: config.smtp.pass ?? '' } : undefined,
    });
    transporterKey = key;
  }
  try {
    const info = await transporter.sendMail({ from: config.smtp.from, to: mail.to, subject: mail.subject, text: mail.text, html: mail.html });
    return { sent: true, messageId: info.messageId };
  } catch (e) {
    return { sent: false, reason: (e as Error).message };
  }
}
