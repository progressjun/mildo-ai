/**
 * team 도메인 진입점 (docs/SAAS_SPEC.md §4) — routes: /api 아래 Fastify 플러그인, jobs: 잡 · 스케줄 등록.
 * 코어(domains.ts)가 import한다. 이 파일의 export 이름과 형태를 바꾸지 말 것.
 *
 * 초대(invites.ts) · 구성원(members.ts) · 비밀번호 · 세션(account.ts) · 감사 로그 조회(auditLog.ts).
 * 잡 타입은 없다(§6). 스케줄 'team.cleanup'(매일 04:17 KST)이 만료된 세션 · 재설정 토큰을 지운다(여러 워커에서 돌아도 멱등).
 */
import type { FastifyPluginAsync } from 'fastify';
import type { JobRegistry } from '../domains';
import type { Queryable } from '../db/pool';
import { inviteRoutes } from './invites';
import { memberRoutes } from './members';
import { accountRoutes } from './account';
import { auditRoutes } from './auditLog';

export const routes: FastifyPluginAsync = async (app) => {
  await app.register(inviteRoutes);
  await app.register(memberRoutes);
  await app.register(accountRoutes);
  await app.register(auditRoutes);
};

/** 만료 하루 지난 세션 · 만료 7일 지난 재설정 토큰 삭제 (초대는 감사 근거로 남긴다) */
export async function cleanupExpired(q: Queryable): Promise<{ sessions: number; resets: number }> {
  const s = await q.query(`DELETE FROM sessions WHERE expires_at < now() - interval '1 day'`);
  const r = await q.query(`DELETE FROM password_resets WHERE expires_at < now() - interval '7 days'`);
  return { sessions: s.rowCount, resets: r.rowCount };
}

export function jobs(reg: JobRegistry): void {
  reg.schedule('team.cleanup', '17 4 * * *', async (ctx) => {
    await cleanupExpired(ctx.db);
  });
}
