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

export async function sendMail(config: AppConfig, mail: Mail): Promise<MailResult> {
  if (config.env === 'test') {
    outbox.push({ ...mail, at: new Date().toISOString() });
    return { sent: true, messageId: `test-${outbox.length}` };
  }
  if (!config.smtp) return { sent: false, reason: 'SMTP가 설정되지 않았습니다 (SMTP_HOST)' };
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
