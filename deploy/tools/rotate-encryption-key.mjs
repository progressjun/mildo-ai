#!/usr/bin/env node
/**
 * ENCRYPTION_KEY 회전 도구 — 암호화 컬럼을 옛 키로 풀고 새 키로 다시 암호화한다 (docs/OPERATIONS.md '비밀값 회전').
 *
 * 대상: 현재 스키마에서 이름이 `*_enc`인 text 컬럼 전부(예: connections.credentials_enc, notification_channels.config_enc)
 *       중 값이 server/src/lib/crypto.ts 형식('v1:<iv>:<tag>:<암호문>', AES-256-GCM)인 행.
 * 동작: 한 트랜잭션 안에서 행을 잠그고(FOR UPDATE) 옛 키로 복호화 → 새 키로 암호화 → 새 키로 다시 풀어 원문과 같은지 확인 → 저장.
 *       옛 키로 풀리지 않는 행이 하나라도 있으면 아무것도 바꾸지 않고 중단한다. 이미 새 키로 풀리는 행은 건너뛴다(재실행 안전).
 *
 * 사용 (앱 · 워커를 멈춘 상태에서):
 *   ENCRYPTION_KEY_OLD=<옛 키> ENCRYPTION_KEY_NEW=<새 키> DATABASE_URL=postgres://... node deploy/tools/rotate-encryption-key.mjs          # 점검만 (변경 없음)
 *   ENCRYPTION_KEY_OLD=<옛 키> ENCRYPTION_KEY_NEW=<새 키> DATABASE_URL=postgres://... node deploy/tools/rotate-encryption-key.mjs --apply  # 적용
 *   docker compose: docker compose run --rm --no-deps -e ENCRYPTION_KEY_OLD -e ENCRYPTION_KEY_NEW app node deploy/tools/rotate-encryption-key.mjs --apply
 * 출력에 비밀값 · 키는 나오지 않는다(개수만).
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';

/** base64 32바이트 키 확인 */
export function checkKey(b64, name = 'key') {
  if (typeof b64 !== 'string' || !b64) throw new Error(`${name}이(가) 비어 있습니다`);
  if (Buffer.from(b64, 'base64').length !== 32) throw new Error(`${name}은(는) base64로 인코딩한 32바이트여야 합니다 (openssl rand -base64 32)`);
  return b64;
}

/** lib/crypto.ts encryptSecret과 같은 형식 */
export function encryptV1(plain, keyB64) {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', Buffer.from(keyB64, 'base64'), iv);
  const enc = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return `v1:${iv.toString('base64')}:${c.getAuthTag().toString('base64')}:${enc.toString('base64')}`;
}

/** lib/crypto.ts decryptSecret과 같은 형식 — 키가 틀리면 예외 */
export function decryptV1(blob, keyB64) {
  const [v, ivB64, tagB64, dataB64] = String(blob).split(':');
  if (v !== 'v1' || !ivB64 || !tagB64 || dataB64 === undefined) throw new Error('알 수 없는 암호문 형식');
  const d = createDecipheriv('aes-256-gcm', Buffer.from(keyB64, 'base64'), Buffer.from(ivB64, 'base64'));
  d.setAuthTag(Buffer.from(tagB64, 'base64'));
  return Buffer.concat([d.update(Buffer.from(dataB64, 'base64')), d.final()]).toString('utf8');
}

const ident = (s) => `"${String(s).replace(/"/g, '""')}"`;

/** 현재 스키마의 `*_enc` text 컬럼 */
export async function findEncryptedColumns(q) {
  const r = await q.query(
    `SELECT table_name, column_name FROM information_schema.columns
      WHERE table_schema = current_schema() AND column_name LIKE '%\\_enc' ESCAPE '\\' AND data_type = 'text'
      ORDER BY table_name, column_name`,
  );
  return r.rows.map((x) => ({ table: x.table_name, column: x.column_name }));
}

/**
 * 키 회전 본체 — 호출한 쪽의 트랜잭션 안에서 실행한다(q는 같은 연결).
 * @returns {{ applied: boolean, columns: object[], totals: { rows: number, rotated: number, alreadyNew: number, skipped: number, failed: number } }}
 */
export async function rotateEncryptionKey(q, { oldKey, newKey, apply = false, columns } = {}) {
  checkKey(oldKey, 'ENCRYPTION_KEY_OLD');
  checkKey(newKey, 'ENCRYPTION_KEY_NEW');
  if (oldKey === newKey) throw new Error('옛 키와 새 키가 같습니다');
  const cols = columns ?? (await findEncryptedColumns(q));
  const report = [];
  const totals = { rows: 0, rotated: 0, alreadyNew: 0, skipped: 0, failed: 0 };
  const updates = [];
  for (const { table, column } of cols) {
    const rows = (await q.query(
      `SELECT ctid::text AS ctid, ${ident(column)} AS v FROM ${ident(table)} WHERE ${ident(column)} IS NOT NULL${apply ? ' FOR UPDATE' : ''}`,
    )).rows;
    const c = { table, column, rows: rows.length, rotated: 0, alreadyNew: 0, skipped: 0, failed: 0 };
    for (const row of rows) {
      const v = String(row.v);
      if (!v.startsWith('v1:')) {
        c.skipped++;
        continue;
      }
      let plain;
      try {
        plain = decryptV1(v, oldKey);
      } catch {
        try {
          decryptV1(v, newKey);
          c.alreadyNew++;
        } catch {
          c.failed++;
        }
        continue;
      }
      const next = encryptV1(plain, newKey);
      if (decryptV1(next, newKey) !== plain) throw new Error(`${table}.${column}: 재암호화 검증 실패`);
      updates.push({ table, column, ctid: row.ctid, next });
      c.rotated++;
    }
    for (const k of ['rows', 'rotated', 'alreadyNew', 'skipped', 'failed']) totals[k] += c[k];
    report.push(c);
  }
  if (totals.failed > 0) {
    const where = report.filter((c) => c.failed).map((c) => `${c.table}.${c.column} ${c.failed}행`).join(', ');
    const err = new Error(`옛 키로도 새 키로도 풀리지 않는 값이 있어 중단했습니다 (${where}). ENCRYPTION_KEY_OLD가 지금 쓰는 키인지 확인하세요`);
    err.report = { applied: false, columns: report, totals };
    throw err;
  }
  if (apply) {
    for (const u of updates) {
      await q.query(`UPDATE ${ident(u.table)} SET ${ident(u.column)} = $1 WHERE ctid = $2::tid`, [u.next, u.ctid]);
    }
  }
  return { applied: apply, columns: report, totals };
}

async function main() {
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');
  const schemaArg = args.find((a) => a.startsWith('--schema='));
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL이 필요합니다');
  const oldKey = process.env.ENCRYPTION_KEY_OLD;
  const newKey = process.env.ENCRYPTION_KEY_NEW;
  checkKey(oldKey, 'ENCRYPTION_KEY_OLD');
  checkKey(newKey, 'ENCRYPTION_KEY_NEW');
  const { default: pg } = await import('pg');
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    if (schemaArg) await client.query(`SET search_path TO ${ident(schemaArg.slice('--schema='.length))}`);
    await client.query('BEGIN');
    let r;
    try {
      r = await rotateEncryptionKey(client, { oldKey, newKey, apply });
      await client.query(apply ? 'COMMIT' : 'ROLLBACK');
    } catch (e) {
      await client.query('ROLLBACK').catch(() => undefined);
      if (e.report) for (const c of e.report.columns) console.log(`  ${c.table}.${c.column}: 행 ${c.rows} · 실패 ${c.failed}`);
      throw e;
    }
    for (const c of r.columns) {
      console.log(`  ${c.table}.${c.column}: 행 ${c.rows} · 재암호화 ${c.rotated} · 이미 새 키 ${c.alreadyNew} · 형식 다름(건너뜀) ${c.skipped}`);
    }
    const t = r.totals;
    console.log(apply
      ? `적용 완료: ${t.rotated}개 값을 새 키로 바꿨습니다. 이제 .env의 ENCRYPTION_KEY를 새 키로 바꾸고 app · worker를 다시 시작하세요`
      : `점검만 했습니다(변경 없음): 재암호화 대상 ${t.rotated}개 · 이미 새 키 ${t.alreadyNew}개. 적용하려면 --apply를 붙이세요`);
  } finally {
    await client.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error(`[rotate-encryption-key] ${e.message ?? e}`);
    process.exit(1);
  });
}
