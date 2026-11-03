/**
 * DB CLI: npm run db:migrate | db:seed [-- --run-jobs] | db:user -- <email> <name> <role> <password> | reset-link <email>
 * 시드 계정은 환경변수 SEED_OWNER_EMAIL / SEED_OWNER_PASSWORD (없으면 개발용 기본값, 프로덕션에서는 필수).
 *
 * reset-link <email>: 운영자용 계정 복구 — 활성 계정의 비밀번호 재설정 링크(60분 · 1회용, 이전 링크 무효)를 발급해 표준 출력에 찍는다.
 *   SMTP가 없거나 소유자 · 관리자가 모두 로그인할 수 없을 때 쓴다(워크스페이스 관리자는 팀 화면에서 발급할 수 있다).
 *   감사 로그에 'auth.password_reset_issue'(actor cli)로 남는다. 링크는 로그 · 감사에 남기지 않는다 — 본인에게만 전달할 것.
 */
import { loadConfig } from '../config';
import { createDb } from './pool';
import { migrate } from './migrate';
import { seed } from './seed';
import { drain } from '../jobs/queue';
import { registerAllJobs } from '../domains';
import { passwordProblem } from '../lib/crypto';
import { one } from './pool';
import { audit } from '../audit/audit';
import { RESET_TTL_MINUTES, issueResetToken, normalizeEmail, resetLink } from '../team/service';

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const config = loadConfig();
  const db = createDb(config.databaseUrl, { max: 4 });
  try {
    if (cmd === 'migrate') {
      const a = await migrate(db);
      console.log(a.length ? `적용: ${a.join(', ')}` : '적용할 마이그레이션 없음');
    } else if (cmd === 'seed') {
      await migrate(db);
      const prod = config.env === 'production';
      const ownerEmail = process.env.SEED_OWNER_EMAIL ?? (prod ? '' : 'owner@mildo.local');
      const ownerPw = process.env.SEED_OWNER_PASSWORD ?? (prod ? '' : 'MildoOwner#2027');
      if (!ownerEmail || !ownerPw) throw new Error('SEED_OWNER_EMAIL · SEED_OWNER_PASSWORD가 필요합니다');
      const p = passwordProblem(ownerPw);
      if (p) throw new Error(`SEED_OWNER_PASSWORD: ${p}`);
      const users = [{ email: ownerEmail, name: process.env.SEED_OWNER_NAME ?? '운영 책임자', password: ownerPw, role: 'owner' as const }];
      if (!prod || process.env.SEED_DEMO_USERS === 'true') {
        users.push(
          { email: 'pm@mildo.local', name: '김PM', password: 'MildoPm#2027', role: 'pm' as never },
          { email: 'ae@mildo.local', name: '이AE', password: 'MildoAe#2027', role: 'ae' as never },
          { email: 'client@mildo.local', name: '수면밀도 담당자', password: 'MildoClient#2027', role: 'client' as never },
        );
      }
      const r = await seed(db, { users, demoData: process.env.SEED_DEMO_DATA !== 'false' });
      console.log(`워크스페이스 ${r.workspaceId} · 사용자 ${Object.keys(r.users).join(', ')}`);
      if (rest.includes('--run-jobs')) {
        registerAllJobs();
        const n = await drain(db, config, { log: (m) => console.log('[job]', m) });
        console.log(`잡 ${n}건 처리`);
      }
    } else if (cmd === 'user') {
      const [email, name, role, password] = rest;
      if (!email || !name || !role || !password) throw new Error('사용법: db:user -- <email> <name> <role> <password>');
      await migrate(db);
      const r = await seed(db, { users: [{ email, name, role: role as never, password }] });
      console.log(`사용자 ${email} (${role}) → 워크스페이스 ${r.workspaceId}`);
    } else if (cmd === 'reset-link') {
      const [email] = rest;
      if (!email) throw new Error('사용법: tsx server/src/db/cli.ts reset-link <email>');
      const u = await one<{ id: string; name: string; status: string }>(db, 'SELECT id, name, status FROM users WHERE lower(email) = $1', [normalizeEmail(email)]);
      if (!u) throw new Error(`계정을 찾을 수 없습니다: ${email}`);
      if (u.status !== 'active') throw new Error('비활성 계정입니다. 팀 화면에서 재활성화한 뒤 다시 발급해 주세요');
      const issued = await db.tx(async (q) => {
        const tok = await issueResetToken(q, u.id, null);
        await audit(q, { workspaceId: null, userId: u.id, actor: 'cli', action: 'auth.password_reset_issue', targetType: 'user', targetId: u.id, detail: { via: 'cli' } });
        return tok;
      });
      console.log(`${u.name}(${normalizeEmail(email)}) 비밀번호 재설정 링크 — ${RESET_TTL_MINUTES}분 동안 한 번만 쓸 수 있습니다 (만료 ${issued.expiresAt}). 본인에게만 전달하세요.`);
      console.log(resetLink(config, issued.token));
    } else if (cmd === 'run-jobs') {
      registerAllJobs();
      const n = await drain(db, config, { log: (m) => console.log('[job]', m) });
      console.log(`잡 ${n}건 처리`);
    } else {
      console.log('명령: migrate | seed [--run-jobs] | user <email> <name> <role> <password> | reset-link <email> | run-jobs');
    }
  } finally {
    await db.end();
  }
}

main().catch((e) => {
  console.error(e.message ?? e);
  process.exit(1);
});
