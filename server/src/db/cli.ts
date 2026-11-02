/**
 * DB CLI: npm run db:migrate | db:seed [-- --run-jobs] | db:user -- <email> <name> <role> <password>
 * 시드 계정은 환경변수 SEED_OWNER_EMAIL / SEED_OWNER_PASSWORD (없으면 개발용 기본값, 프로덕션에서는 필수).
 */
import { loadConfig } from '../config';
import { createDb } from './pool';
import { migrate } from './migrate';
import { seed } from './seed';
import { drain } from '../jobs/queue';
import { registerAllJobs } from '../domains';
import { passwordProblem } from '../lib/crypto';

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
    } else if (cmd === 'run-jobs') {
      registerAllJobs();
      const n = await drain(db, config, { log: (m) => console.log('[job]', m) });
      console.log(`잡 ${n}건 처리`);
    } else {
      console.log('명령: migrate | seed [--run-jobs] | user <email> <name> <role> <password> | run-jobs');
    }
  } finally {
    await db.end();
  }
}

main().catch((e) => {
  console.error(e.message ?? e);
  process.exit(1);
});
