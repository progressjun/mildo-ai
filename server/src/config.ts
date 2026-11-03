/**
 * 환경변수 설정 — 서버 · 워커 공통. 비밀값은 환경변수로만 받는다(코드 · DB 평문 저장 금지).
 * .env.example(deploy/)에 모든 항목과 설명이 있다.
 */
export interface AppConfig {
  env: 'development' | 'test' | 'production';
  port: number;
  host: string;
  /** 외부에서 접속하는 기준 URL (초대 · 비밀번호 재설정 링크, 알림 메시지 링크) */
  appUrl: string;
  databaseUrl: string;
  /** 세션 서명 · CSRF에 쓰지 않음(세션은 랜덤 토큰 + SHA-256) — 쿠키 서명용 */
  sessionSecret: string;
  /** 자격증명 암호화 키: base64 32바이트 */
  encryptionKey: string;
  sessionTtlHours: number;
  secureCookies: boolean;
  /** 프로덕션: 빌드된 프런트(dist)를 같은 오리진에서 서빙 */
  staticDir: string | null;
  anthropicApiKey: string | null;
  anthropicModel: string;
  smtp: { host: string; port: number; secure: boolean; user: string | null; pass: string | null; from: string } | null;
  /** 워커 식별자 (잡 잠금 표시) */
  workerId: string;
  logLevel: 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace' | 'silent';
}

function req(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (v === undefined || v === '') throw new Error(`환경변수 ${name}이(가) 필요합니다`);
  return v;
}

const DEV_KEY = Buffer.alloc(32, 7).toString('base64'); // 개발 · 테스트 전용 고정 키 (프로덕션에서는 거부)

export function loadConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  const env = (process.env.NODE_ENV === 'production' ? 'production' : process.env.NODE_ENV === 'test' ? 'test' : 'development') as AppConfig['env'];
  const prod = env === 'production';
  const encryptionKey = prod ? req('ENCRYPTION_KEY') : process.env.ENCRYPTION_KEY || DEV_KEY;
  if (Buffer.from(encryptionKey, 'base64').length !== 32) throw new Error('ENCRYPTION_KEY는 base64로 인코딩한 32바이트여야 합니다');
  const smtpHost = process.env.SMTP_HOST;
  const cfg: AppConfig = {
    env,
    port: Number(process.env.PORT ?? 8080),
    host: process.env.HOST ?? '0.0.0.0',
    appUrl: (process.env.APP_URL ?? 'http://localhost:8080').replace(/\/$/, ''),
    databaseUrl: prod ? req('DATABASE_URL') : process.env.DATABASE_URL ?? 'postgres://mildo@/mildo_dev?host=/tmp&port=55432',
    sessionSecret: prod ? req('SESSION_SECRET') : process.env.SESSION_SECRET ?? 'dev-session-secret-change-me-0123456789',
    encryptionKey,
    sessionTtlHours: Number(process.env.SESSION_TTL_HOURS ?? 24 * 14),
    secureCookies: process.env.SECURE_COOKIES ? process.env.SECURE_COOKIES === 'true' : prod,
    staticDir: process.env.STATIC_DIR ?? (prod ? 'dist' : null),
    anthropicApiKey: process.env.ANTHROPIC_API_KEY || null,
    anthropicModel: process.env.ANTHROPIC_MODEL ?? 'claude-opus-5-5',
    smtp: smtpHost
      ? {
          host: smtpHost,
          port: Number(process.env.SMTP_PORT ?? 587),
          secure: process.env.SMTP_SECURE === 'true',
          user: process.env.SMTP_USER || null,
          pass: process.env.SMTP_PASS || null,
          from: process.env.SMTP_FROM ?? 'MILDO OS <no-reply@localhost>',
        }
      : null,
    // '#'은 잡 잠금 표기(<워커>#<레인>) 구분자라 워커 id에 쓰지 않는다 (하트비트가 두 줄로 갈라짐)
    workerId: (process.env.WORKER_ID ?? `worker-${process.pid}`).replace(/#/g, '_'),
    logLevel: (process.env.LOG_LEVEL as AppConfig['logLevel']) ?? (env === 'test' ? 'silent' : 'info'),
    ...overrides,
  };
  if (prod && cfg.sessionSecret.length < 32) throw new Error('SESSION_SECRET은 32자 이상이어야 합니다');
  if (prod && encryptionKey === DEV_KEY) throw new Error('프로덕션에서 개발용 ENCRYPTION_KEY를 쓸 수 없습니다');
  return cfg;
}
