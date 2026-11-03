/**
 * devops: 보안 헤더(hijack 스트림 포함) · 요청 id(Fastify reqId와 같은 값) · 정적 파일 캐시(304 포함) · /api/ready(외부 요약 · 내부 세부) ·
 * 워커 하트비트(worker.ts 하트비트 · 트리거 · CLI 제외) · 스케줄러 판정 · 속도 제한(키 상한) · 경로 인코딩 우회 차단 ·
 * 로그인 잠금(익숙한 IP · 재설정 후 초기화) · SSE · AI 스트림 우아한 종료 · 키 회전 도구
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTestApp, TEST_PASSWORD, type TestApp } from './app';
import {
  API_CSP, HSTS, PERMISSIONS_POLICY, SHUTDOWN_AI_EVENT, WindowLimiter, appCsp, clientIp, decodedPath, isInternalIp, loginLockState, parseCspSources, rateKeyOf,
  readiness, requestIdFor, routePath, securityOptionsFromEnv, securityPlugin, summarizeReadiness,
} from '../src/http/security';
import { registerAllJobs } from '../src/domains';
import { runScheduleNow, scheduleContext } from '../src/jobs/scheduler';
import { request as httpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import { sha256 } from '../src/lib/ids';
import { _resetJobsForTest, claim, drain, enqueue, registerJob, runJob } from '../src/jobs/queue';
import { decryptSecret, encryptSecret } from '../src/lib/crypto';
import { rotateEncryptionKey, findEncryptedColumns } from '../../deploy/tools/rotate-encryption-key.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

async function withEnv<T>(vars: Record<string, string>, fn: () => Promise<T>): Promise<T> {
  const prev: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(vars)) {
    prev[k] = process.env[k];
    process.env[k] = v;
  }
  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

let t: TestApp;
beforeAll(async () => {
  t = await createTestApp();
});
afterAll(async () => {
  await t?.close();
});

describe('보안 헤더 (API)', () => {
  it('JSON API 응답: CSP(API) · nosniff · frame · referrer · permissions · COOP · CORP · no-store · 요청 id', async () => {
    const r = await t.anon().get('/api/health');
    expect(r.status).toBe(200);
    const h = r.headers;
    expect(h['content-security-policy']).toBe(API_CSP);
    expect(h['x-content-type-options']).toBe('nosniff');
    expect(h['x-frame-options']).toBe('DENY');
    expect(h['referrer-policy']).toBe('strict-origin-when-cross-origin');
    expect(h['permissions-policy']).toBe(PERMISSIONS_POLICY);
    expect(h['cross-origin-opener-policy']).toBe('same-origin');
    expect(h['cross-origin-resource-policy']).toBe('same-origin');
    expect(h['cache-control']).toBe('no-store');
    expect(String(h['x-request-id'])).toMatch(UUID);
    // secureCookies=false(테스트 기본)에서는 HSTS를 보내지 않는다
    expect(h['strict-transport-security']).toBeUndefined();
  });

  it('오류 응답(401 · 404)에도 헤더가 붙는다', async () => {
    const a = await t.anon().get(`/api/w/${t.ws}`);
    expect(a.status).toBe(401);
    expect(a.headers['content-security-policy']).toBe(API_CSP);
    expect(a.headers['x-frame-options']).toBe('DENY');
    const b = await t.anon().get('/api/does-not-exist');
    expect(b.status).toBe(404);
    expect(b.headers['x-content-type-options']).toBe('nosniff');
  });

  it('요청 id: 프록시가 준 형식이 맞는 값은 이어 쓰고, 이상한 값은 새로 만든다', async () => {
    const ok = await t.anon().raw({ method: 'GET', url: '/api/health', headers: { 'x-request-id': 'edge-req-0001:abc' } });
    expect(ok.headers['x-request-id']).toBe('edge-req-0001:abc');
    const bad = await t.anon().raw({ method: 'GET', url: '/api/health', headers: { 'x-request-id': 'bad id <script>' } });
    expect(String(bad.headers['x-request-id'])).toMatch(UUID);
    const two = await Promise.all([t.anon().get('/api/health'), t.anon().get('/api/health')]);
    expect(two[0].headers['x-request-id']).not.toBe(two[1].headers['x-request-id']);
    // 길이 규칙은 app.ts genReqId와 같다(8~64자) — 65자는 이어 쓰지 않는다(Fastify reqId와 어긋나지 않게)
    const id64 = 'a'.repeat(64);
    expect((await t.anon().raw({ method: 'GET', url: '/api/health', headers: { 'x-request-id': id64 } })).headers['x-request-id']).toBe(id64);
    const long = await t.anon().raw({ method: 'GET', url: '/api/health', headers: { 'x-request-id': 'a'.repeat(65) } });
    expect(String(long.headers['x-request-id'])).toMatch(UUID);
  });

  it('요청 id = Fastify 요청 id (로그의 reqId와 응답 헤더가 같은 값)', async () => {
    const mini = Fastify({ genReqId: () => 'gen-req-0001-abcdef' });
    mini.decorate('ctx', { db: t.db, config: t.config, events: t.events });
    await mini.register(securityPlugin);
    mini.get('/api/whoami', async (req) => ({ id: req.id, requestId: req.requestId }));
    await mini.ready();
    try {
      const r = await mini.inject({ method: 'GET', url: '/api/whoami' });
      expect(r.json()).toEqual({ id: 'gen-req-0001-abcdef', requestId: 'gen-req-0001-abcdef' });
      expect(r.headers['x-request-id']).toBe('gen-req-0001-abcdef');
    } finally {
      await mini.close();
    }
    expect(requestIdFor({ headers: { 'x-request-id': ['edge-0000-1111', 'x'] }, id: 'other-id-000' })).toBe('edge-0000-1111');
    expect(requestIdFor({ headers: {}, id: 'req-1' })).toMatch(UUID); // Fastify 기본 id(req-1)는 형식이 짧아 새로 만든다
  });

  it('reply.hijack()으로 직접 쓰는 스트림(SSE)에도 보안 헤더 · 요청 id가 실린다', async () => {
    const mini = Fastify();
    mini.decorate('ctx', { db: t.db, config: { ...t.config, secureCookies: true }, events: t.events });
    await mini.register(securityPlugin);
    mini.get('/api/w/:ws/events', async (_req, reply) => {
      reply.hijack();
      reply.raw.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache, no-transform' });
      reply.raw.end('event: hello\ndata: {}\n\n');
    });
    await mini.ready();
    try {
      const r = await mini.inject({ method: 'GET', url: '/api/w/abc/events', headers: { 'x-request-id': 'sse-req-0001' } });
      expect(r.statusCode).toBe(200);
      expect(r.headers['x-request-id']).toBe('sse-req-0001');
      expect(r.headers['content-security-policy']).toBe(API_CSP);
      expect(r.headers['x-content-type-options']).toBe('nosniff');
      expect(r.headers['x-frame-options']).toBe('DENY');
      expect(r.headers['strict-transport-security']).toBe(HSTS);
      // 라우트가 정한 값은 그대로(원시 헤더보다 writeHead 값이 우선)
      expect(r.headers['cache-control']).toBe('no-cache, no-transform');
      expect(r.headers['content-type']).toContain('text/event-stream');
    } finally {
      await mini.close();
    }
  });

  it('라우트가 정한 cache-control은 덮어쓰지 않는다 (no-store는 기본값일 때만)', async () => {
    const mini = Fastify();
    mini.decorate('ctx', { db: t.db, config: t.config, events: t.events });
    await mini.register(securityPlugin);
    mini.get('/api/template.csv', async (_req, reply) => reply.header('cache-control', 'public, max-age=60').type('text/csv').send('a,b'));
    mini.get('/api/plain', async () => ({ ok: true }));
    await mini.ready();
    try {
      const a = await mini.inject({ method: 'GET', url: '/api/template.csv' });
      expect(a.headers['cache-control']).toBe('public, max-age=60');
      expect(a.headers['content-security-policy']).toBe(API_CSP);
      const b = await mini.inject({ method: 'GET', url: '/api/plain' });
      expect(b.headers['cache-control']).toBe('no-store');
    } finally {
      await mini.close();
    }
  });
});

describe('보안 헤더 (서빙하는 프런트)', () => {
  let s: TestApp;
  let dir: string;
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'mildo-static-'));
    mkdirSync(join(dir, 'assets'));
    writeFileSync(join(dir, 'index.html'), '<!doctype html><html><head><script type="module" src="/assets/index-AbCd12_x.js"></script></head><body><div id="root"></div></body></html>');
    writeFileSync(join(dir, 'assets', 'index-AbCd12_x.js'), 'console.log(1)');
    writeFileSync(join(dir, 'robots.txt'), 'User-agent: *');
    s = await createTestApp({ config: { staticDir: dir, secureCookies: true } });
  });
  afterAll(async () => {
    await s?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('index.html: 명세의 CSP 지시어 전부 · no-cache · HSTS(secureCookies)', async () => {
    const r = await s.anon().get('/');
    expect(r.status).toBe(200);
    expect(String(r.headers['content-type'])).toContain('text/html');
    const csp = String(r.headers['content-security-policy']);
    expect(csp).toBe(appCsp());
    for (const d of [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
      "font-src 'self' https://fonts.gstatic.com data:",
      "img-src 'self' data: blob:",
      "connect-src 'self'",
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "form-action 'self'",
    ]) expect(csp).toContain(d);
    expect(csp).not.toContain('unsafe-eval');
    expect(r.headers['cache-control']).toBe('no-cache');
    expect(r.headers['strict-transport-security']).toBe(HSTS);
    expect(r.headers['x-frame-options']).toBe('DENY');
  });

  it('해시가 붙은 자산은 1년 immutable, 그 밖의 파일은 정적 플러그인 기본값', async () => {
    const a = await s.anon().get('/assets/index-AbCd12_x.js');
    expect(a.status).toBe(200);
    expect(a.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    expect(a.headers['content-security-policy']).toBe(appCsp());
    const robots = await s.anon().get('/robots.txt');
    expect(robots.status).toBe(200);
    expect(robots.headers['cache-control']).not.toContain('immutable');
  });

  it('재검증(304)에도 index.html은 no-cache, 해시 자산은 immutable — 정적 플러그인 기본값(1시간)이 저장본 수명을 늘리지 않는다', async () => {
    const first = await s.app.inject({ method: 'GET', url: '/' });
    expect(first.headers.etag).toBeTruthy();
    const again = await s.app.inject({ method: 'GET', url: '/', headers: { 'if-none-match': String(first.headers.etag) } });
    expect(again.statusCode).toBe(304);
    expect(again.headers['cache-control']).toBe('no-cache');
    const deep = await s.app.inject({ method: 'GET', url: '/deep/link', headers: { 'if-none-match': String(first.headers.etag) } });
    expect(deep.statusCode).toBe(304);
    expect(deep.headers['cache-control']).toBe('no-cache');
    const asset = await s.app.inject({ method: 'GET', url: '/assets/index-AbCd12_x.js' });
    const asset304 = await s.app.inject({ method: 'GET', url: '/assets/index-AbCd12_x.js', headers: { 'if-none-match': String(asset.headers.etag) } });
    expect(asset304.statusCode).toBe(304);
    expect(asset304.headers['cache-control']).toBe('public, max-age=31536000, immutable');
  });

  it('해시 라우팅 폴백(index.html)도 같은 CSP · no-cache, API 404는 JSON', async () => {
    const r = await s.anon().get('/some/deep/link');
    expect(r.status).toBe(200);
    expect(r.headers['content-security-policy']).toBe(appCsp());
    expect(r.headers['cache-control']).toBe('no-cache');
    const api = await s.anon().get('/api/nope');
    expect(api.status).toBe(404);
    expect(api.json.error.code).toBe('not_found');
    expect(api.headers['content-security-policy']).toBe(API_CSP);
    expect(api.headers['strict-transport-security']).toBe(HSTS);
  });
});

describe('/api/ready · 워커 하트비트', () => {
  it('처음(잡 처리 기록 없음, 활성 워크스페이스 1개): DB · 마이그레이션 정상, 워커 no_activity → degraded(200)', async () => {
    const r = await t.anon().get('/api/ready');
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ ok: true, status: 'degraded' });
    expect(typeof r.json.version).toBe('string');
    expect(Date.parse(r.json.time)).not.toBeNaN();
    expect(r.json.checks.db.ok).toBe(true);
    expect(r.json.checks.db.latencyMs).toBeGreaterThanOrEqual(0);
    const m = r.json.checks.migrations;
    expect(m.ok).toBe(true);
    expect(m.pending).toEqual([]);
    expect(m.applied).toBe(m.expected);
    expect(m.expected).toBeGreaterThanOrEqual(2);
    const w = r.json.checks.worker;
    expect(w).toMatchObject({ ok: false, status: 'no_activity', staleAfterMin: 15, activeWorkspaces: 1, overdueJobs: 0, lastActivityAt: null });
    expect(w.basis).toContain('15분');
    expect(r.json.notes.join(' ')).toContain('워커');
    expect(r.headers['cache-control']).toBe('no-store');
  });

  it('잡을 처리하면 하트비트가 남고 ready가 된다 (worker_id = locked_by의 # 앞부분)', async () => {
    _resetJobsForTest();
    registerJob('test.ops.noop', async () => ({ ok: true }));
    registerJob('test.ops.fail', async () => {
      throw new Error('의도한 실패');
    });
    await enqueue(t.db, { type: 'test.ops.noop', workspaceId: t.ws });
    expect(await drain(t.db, t.config, { types: ['test.ops.noop'] })).toBe(1);
    const hb = await t.db.query<{ worker_id: string; jobs_seen: number; last_status: string }>('SELECT worker_id, jobs_seen, last_status FROM worker_heartbeats');
    expect(hb.rows).toEqual([{ worker_id: 'drain', jobs_seen: 2, last_status: 'done' }]); // running + done

    // DB CLI(run-jobs = drain)가 처리한 기록만 있으면 워커가 떠 있다는 근거가 아니다 → 여전히 no_activity(degraded)
    const cliOnly = await t.anon().get('/api/ready');
    expect(cliOnly.json.status).toBe('degraded');
    expect(cliOnly.json.checks.worker).toMatchObject({ status: 'no_activity', lastActivityAt: null, lastHeartbeatAt: null });
    expect(Date.parse(cliOnly.json.checks.worker.lastFinishedAt)).not.toBeNaN(); // 큐는 움직였다(참고 값)
    expect(cliOnly.json.checks.worker.workers).toEqual([expect.objectContaining({ id: 'drain', cli: true })]);
    expect(cliOnly.json.notes.join(' ')).toContain('DB CLI run-jobs 처리 기록만');

    // 워커 레인 이름(worker-1#0)은 # 앞부분으로 묶는다 · 최종 실패도 하트비트
    await enqueue(t.db, { type: 'test.ops.fail', workspaceId: t.ws, maxAttempts: 1 });
    const job = await claim(t.db, 'worker-7#1', ['test.ops.fail']);
    expect(await runJob(t.db, t.config, job!, () => undefined)).toBe('failed');
    const w7 = await t.db.query<{ jobs_seen: number; last_status: string; last_job_type: string }>(`SELECT jobs_seen, last_status, last_job_type FROM worker_heartbeats WHERE worker_id = 'worker-7'`);
    expect(w7.rows[0]).toEqual({ jobs_seen: 2, last_status: 'failed', last_job_type: 'test.ops.fail' });

    // 대기 중 취소(커넥션 · 업로드 삭제)는 워커 실패가 아니다 — locked_by 없는 failed는 세지 않는다
    await t.db.query(`INSERT INTO jobs (type, workspace_id, status, finished_at, last_error) VALUES ('test.ops.canceled', $1, 'failed', now(), '커넥션 삭제로 취소')`, [t.ws]);

    const r = await t.anon().get('/api/ready');
    expect(r.status).toBe(200);
    expect(r.json.status).toBe('ready');
    expect(r.json.detail).toBe('full');
    const w = r.json.checks.worker;
    expect(w.status).toBe('ok');
    expect(w.ok).toBe(true);
    expect(w.failedJobs24h).toBe(1);
    expect(w.workers.map((x: { id: string }) => x.id).sort()).toEqual(['drain', 'worker-7']);
    expect(w.workers.find((x: { id: string }) => x.id === 'worker-7').cli).toBe(false);
    expect(Date.parse(w.lastActivityAt)).not.toBeNaN();
    expect(r.json.notes.join(' ')).toContain('최종 실패 1건');
  });

  it('워커 프로세스가 60초마다 쓰는 하트비트(worker.ts)만 있어도 생존으로 본다 — 잡이 없는 한가한 시간', async () => {
    // 잡 기록 · 트리거 하트비트를 모두 오래된 것으로 만든다
    await t.db.query(`UPDATE jobs SET finished_at = now() - interval '2 hours', locked_at = now() - interval '2 hours'`);
    await t.db.query(`UPDATE worker_heartbeats SET last_seen_at = now() - interval '2 hours'`);
    const before = await t.anon().get('/api/ready');
    expect(before.json.checks.worker.status).toBe('stale');
    // worker.ts의 하트비트 SQL 그대로
    await t.db.query(
      `INSERT INTO worker_heartbeats (worker_id, last_seen_at, last_status) VALUES ($1, now(), 'idle')
       ON CONFLICT (worker_id) DO UPDATE SET last_seen_at = now()`,
      ['worker-idle-host'],
    );
    const r = await t.anon().get('/api/ready');
    expect(r.json.status).toBe('ready');
    expect(r.json.checks.worker).toMatchObject({ status: 'ok', ok: true });
    expect(r.json.checks.worker.activityAgeSec).toBeLessThan(60);
    expect(r.json.checks.worker.lastHeartbeatAt).toBe(r.json.checks.worker.lastActivityAt);
    expect(r.json.checks.worker.basis).toContain('60초마다');
    // 같은 하트비트 행이라도 CLI 이름(drain)이면 세지 않는다
    await t.db.query(`DELETE FROM worker_heartbeats WHERE worker_id = 'worker-idle-host'`);
    await t.db.query(`UPDATE worker_heartbeats SET last_seen_at = now() WHERE worker_id = 'drain'`);
    expect((await t.anon().get('/api/ready')).json.checks.worker.status).toBe('stale');
    await t.db.query(`UPDATE worker_heartbeats SET last_seen_at = now(), first_seen_at = now()`);
    await t.db.query(`UPDATE jobs SET finished_at = now() WHERE finished_at IS NOT NULL`);
  });

  it('재시도(실패 → 대기열 복귀)는 하트비트를 늘리지 않고 잡 처리를 막지 않는다', async () => {
    let calls = 0;
    registerJob('test.ops.flaky', async () => {
      calls++;
      if (calls === 1) throw new Error('일시 오류');
      return { ok: true };
    });
    const id = await enqueue(t.db, { type: 'test.ops.flaky', workspaceId: t.ws });
    const before = (await t.db.query<{ n: number }>(`SELECT jobs_seen AS n FROM worker_heartbeats WHERE worker_id = 'drain'`)).rows[0].n;
    const j = await claim(t.db, 'drain', ['test.ops.flaky']);
    expect(await runJob(t.db, t.config, j!, () => undefined)).toBe('retry');
    const mid = (await t.db.query<{ n: number }>(`SELECT jobs_seen AS n FROM worker_heartbeats WHERE worker_id = 'drain'`)).rows[0].n;
    expect(mid).toBe(before + 1); // claim(running)만 센다
    await t.db.query('UPDATE jobs SET run_at = now() WHERE id = $1', [id]);
    await drain(t.db, t.config, { types: ['test.ops.flaky'] });
    expect((await t.db.query<{ status: string }>('SELECT status FROM jobs WHERE id = $1', [id])).rows[0].status).toBe('done');
  });

  it('밀린 잡이 있는데 5분 넘게 큐가 움직이지 않으면 stalled, 오래 조용하면 stale (둘 다 degraded)', async () => {
    await t.db.query(`UPDATE jobs SET finished_at = now() - interval '40 minutes', locked_at = now() - interval '40 minutes'`);
    await t.db.query(`UPDATE worker_heartbeats SET last_seen_at = now() - interval '40 minutes'`);
    const overdue = await enqueue(t.db, { type: 'test.ops.noop', workspaceId: t.ws, runAt: new Date(Date.now() - 10 * 60_000) });
    const a = await t.anon().get('/api/ready');
    expect(a.status).toBe(200);
    expect(a.json.status).toBe('degraded');
    expect(a.json.checks.worker).toMatchObject({ status: 'stalled', overdueJobs: 1, ok: false });
    expect(a.json.checks.worker.activityAgeSec).toBeGreaterThanOrEqual(39 * 60);
    expect(a.json.notes.join(' ')).toContain('대기 잡 1건');

    // 하트비트 타이머가 살아 있어도(이벤트 루프는 돌지만 잡 레인이 멈춤) 큐가 안 움직이면 stalled — 하트비트가 멈춤을 가리지 않는다
    await t.db.query(`UPDATE worker_heartbeats SET last_seen_at = now()`);
    const hung = await t.anon().get('/api/ready');
    expect(hung.json.checks.worker.status).toBe('stalled');
    expect(hung.json.status).toBe('degraded');

    await t.db.query('DELETE FROM jobs WHERE id = $1', [overdue]);
    await t.db.query(`UPDATE worker_heartbeats SET last_seen_at = now() - interval '40 minutes'`);
    const b = await t.anon().get('/api/ready');
    expect(b.json.checks.worker.status).toBe('stale');
    expect(b.json.status).toBe('degraded');

    // 큐가 최근에 움직였으면 밀린 잡이 있어도 busy(정상 범위)
    await t.db.query(`UPDATE worker_heartbeats SET last_seen_at = now()`);
    await t.db.query(`UPDATE jobs SET finished_at = now() WHERE id = (SELECT max(id) FROM jobs WHERE status = 'done')`);
    const again = await enqueue(t.db, { type: 'test.ops.noop', workspaceId: t.ws, runAt: new Date(Date.now() - 10 * 60_000) });
    const c = await t.anon().get('/api/ready');
    expect(c.json.checks.worker.status).toBe('busy');
    expect(c.json.status).toBe('ready');

    // 긴 잡이 레인을 차지(실행 중 · 15분 안에 잡음)하고 하트비트가 살아 있으면 큐가 멈춰 보여도 busy
    await t.db.query(`UPDATE jobs SET finished_at = now() - interval '40 minutes' WHERE finished_at IS NOT NULL`);
    const long = await enqueue(t.db, { type: 'test.ops.long', workspaceId: t.ws });
    await t.db.query(`UPDATE jobs SET status = 'running', locked_by = 'worker-9#0', locked_at = now() - interval '8 minutes' WHERE id = $1`, [long]);
    const d = await t.anon().get('/api/ready');
    expect(d.json.checks.worker).toMatchObject({ status: 'busy', runningJobs: 1, stuckJobs: 0 });

    // 15분 넘게 잠긴 잡만 남았으면(워커가 회수하지 못함) stalled + 메모
    await t.db.query(`UPDATE jobs SET locked_at = now() - interval '20 minutes' WHERE id = $1`, [long]);
    const e = await t.anon().get('/api/ready');
    expect(e.json.checks.worker).toMatchObject({ status: 'stalled', stuckJobs: 1 });
    expect(e.json.notes.join(' ')).toContain('15분 넘게 잠긴 실행 중 잡 1건');
    await t.db.query('DELETE FROM jobs WHERE id = ANY($1)', [[again, long]]);
    await t.db.query(`DELETE FROM worker_heartbeats WHERE worker_id = 'worker-9'`);
    await t.db.query(`UPDATE jobs SET finished_at = now() WHERE finished_at IS NOT NULL`);
    expect((await t.anon().get('/api/ready')).json.checks.worker.status).toBe('ok');
  });

  it('스케줄러: 워커는 살아 있는데 예약 감지 잡(alerts.scan)이 25분 넘게 안 생기면 no_scheduler(degraded) — 실제 alerts.scan 스케줄로 회복', async () => {
    // 워커 · 워크스페이스가 판정 기간보다 오래 떠 있었던 상황
    await t.db.query(`UPDATE worker_heartbeats SET first_seen_at = now() - interval '2 hours', last_seen_at = now()`);
    await t.db.query(`UPDATE workspaces SET created_at = now() - interval '2 hours'`);
    const a = await t.anon().get('/api/ready');
    expect(a.json.status).toBe('degraded');
    expect(a.json.checks.worker).toMatchObject({ status: 'no_scheduler', ok: false, lastScheduledAt: null, schedulerStaleAfterMin: 25 });
    expect(a.json.notes.join(' ')).toContain('SCHEDULER=on');

    // 갓 뜬 워커(첫 하트비트가 25분 안)면 첫 예약 시각 전이라 판정을 미룬다
    await t.db.query(`UPDATE worker_heartbeats SET first_seen_at = now() - interval '3 minutes'`);
    expect((await t.anon().get('/api/ready')).json.checks.worker.status).toBe('ok');
    await t.db.query(`UPDATE worker_heartbeats SET first_seen_at = now() - interval '2 hours'`);

    // 수동 감지(trigger가 schedule이 아님)는 스케줄러 생존 근거가 아니다
    const manual = await enqueue(t.db, { type: 'alerts.scan', workspaceId: t.ws, payload: { trigger: 'manual' } });
    expect((await t.anon().get('/api/ready')).json.checks.worker.status).toBe('no_scheduler');
    await t.db.query('DELETE FROM jobs WHERE id = $1', [manual]);

    // alerts 도메인의 실제 스케줄 함수가 만드는 잡으로 판정한다 (잡 계약: type alerts.scan · payload.trigger 'schedule')
    registerAllJobs();
    await runScheduleNow('alerts.scan', scheduleContext(t.db, t.config));
    const b = await t.anon().get('/api/ready');
    expect(b.json.status).toBe('ready');
    expect(b.json.checks.worker.status).toBe('ok');
    expect(Date.parse(b.json.checks.worker.lastScheduledAt)).not.toBeNaN();

    // 오래된 예약 잡만 있으면 다시 no_scheduler
    await t.db.query(`UPDATE jobs SET created_at = now() - interval '40 minutes' WHERE type = 'alerts.scan'`);
    expect((await t.anon().get('/api/ready')).json.checks.worker.status).toBe('no_scheduler');
    await t.db.query(`DELETE FROM jobs WHERE type = 'alerts.scan'`);
    await t.db.query(`UPDATE worker_heartbeats SET first_seen_at = now()`);
    expect((await t.anon().get('/api/ready')).json.checks.worker.status).toBe('ok');
  });

  it('외부 IP에는 판정만(워커 이름 · 워크스페이스 수 · 파일명 · 오류 문구 없음), 내부망 · READY_TOKEN에는 세부 항목', async () => {
    const ext = await t.anon().raw({ method: 'GET', url: '/api/ready', headers: { 'x-forwarded-for': '203.0.113.77' } });
    expect(ext.status).toBe(200);
    expect(ext.json.detail).toBe('summary');
    expect(ext.json.status).toBe('ready');
    expect(ext.json.checks.worker).toMatchObject({ ok: true, status: 'ok', workers: [], activeWorkspaces: 0, lastActivityAt: null });
    expect(ext.json.checks.migrations).toMatchObject({ ok: true, pending: [] });
    expect(ext.json.checks.migrations.applied).toBe(ext.json.checks.migrations.expected);
    expect(ext.json.checks.migrations.expected).toBeGreaterThanOrEqual(2);
    expect(ext.body).not.toContain('worker-7');
    expect(ext.body).not.toContain('.sql');
    // 사설망 IP(프록시 뒤 사내 감시)는 세부 항목
    const lan = await t.anon().raw({ method: 'GET', url: '/api/ready', headers: { 'x-forwarded-for': '10.20.30.40' } });
    expect(lan.json.detail).toBe('full');
    expect(lan.json.checks.worker.workers.length).toBeGreaterThan(0);
    // 꾸민 XFF 앞부분(사설 IP)은 믿지 않는다 — 프록시 1단이 붙인 마지막 값이 공인 IP면 요약
    const spoof = await t.anon().raw({ method: 'GET', url: '/api/ready', headers: { 'x-forwarded-for': '10.0.0.1, 203.0.113.78' } });
    expect(spoof.json.detail).toBe('summary');

    const token = 'ready-token-0123456789abcdef';
    const mini = await withEnv({ READY_TOKEN: token }, async () => {
      const m = Fastify();
      m.decorate('ctx', { db: t.db, config: t.config, events: t.events });
      await m.register(securityPlugin);
      await m.ready();
      return m;
    });
    try {
      const xff = { 'x-forwarded-for': '203.0.113.79' };
      const no = await mini.inject({ method: 'GET', url: '/api/ready', headers: xff });
      expect(no.json().detail).toBe('summary');
      const bad = await mini.inject({ method: 'GET', url: '/api/ready', headers: { ...xff, 'x-ready-token': `${token}x` } });
      expect(bad.json().detail).toBe('summary');
      const yes = await mini.inject({ method: 'GET', url: '/api/ready', headers: { ...xff, 'x-ready-token': token } });
      expect(yes.json().detail).toBe('full');
      expect(yes.json().checks.worker.activeWorkspaces).toBe(1);
    } finally {
      await mini.close();
    }
  });

  it('요약 응답은 not_ready여도 오류 문구를 싣지 않는다', () => {
    const full = {
      ok: false, status: 'not_ready' as const, version: '1', time: new Date().toISOString(),
      checks: {
        db: { ok: false, latencyMs: null, error: 'password authentication failed for user "mildo" at 10.0.0.5' },
        migrations: { ok: false, expected: 9, applied: 0, pending: ['001_core.sql'], unknownApplied: [], error: 'x' },
        worker: { ok: false, status: 'unknown' as const, staleAfterMin: 15, schedulerStaleAfterMin: 25, lastActivityAt: '2026-11-03T00:00:00.000Z', lastFinishedAt: null,
          lastHeartbeatAt: null, activityAgeSec: 9, lastScheduledAt: '2026-11-03T00:00:00.000Z', runningJobs: 2, queuedDue: 0, overdueJobs: 0, stuckJobs: 1, failedJobs24h: 3, activeWorkspaces: 12,
          workers: [{ id: 'worker-secret-host', lastSeenAt: '2026-11-03T00:00:00.000Z', jobsSeen: 1, lastJobType: 'x', cli: false }], basis: 'b', error: 'e' },
      },
      notes: ['DB: 연결할 수 없습니다 (password authentication failed ... 10.0.0.5)'],
    };
    const s = summarizeReadiness(full);
    expect(s).toMatchObject({ ok: false, status: 'not_ready', detail: 'summary' });
    const text = JSON.stringify(s);
    expect(text).not.toContain('10.0.0.5');
    expect(text).not.toContain('001_core');
    expect(text).not.toContain('worker-secret-host');
    expect(text).not.toContain('2026-11-03T00:00:00');
    expect(s.checks.worker).toMatchObject({ activeWorkspaces: 0, stuckJobs: 0, runningJobs: 0, workers: [], lastScheduledAt: null, status: 'unknown', ok: false });
    expect(s.notes).toHaveLength(1);
  });

  it('적용되지 않은 마이그레이션이 있으면 not_ready(503)', async () => {
    await t.db.query(`DELETE FROM schema_migrations WHERE name = '520_ops_heartbeat.sql'`);
    try {
      const r = await t.anon().get('/api/ready');
      expect(r.status).toBe(503);
      expect(r.json).toMatchObject({ ok: false, status: 'not_ready' });
      expect(r.json.checks.migrations.pending).toEqual(['520_ops_heartbeat.sql']);
      expect(r.json.notes.join(' ')).toContain('마이그레이션');
    } finally {
      await t.db.query(`INSERT INTO schema_migrations (name) VALUES ('520_ops_heartbeat.sql') ON CONFLICT DO NOTHING`);
    }
    expect((await t.anon().get('/api/ready')).status).toBe(200);
  });

  it('DB에 연결할 수 없으면 not_ready (예외 없이 보고)', async () => {
    const broken = { query: async () => { throw new Error('connect ECONNREFUSED'); } };
    const r = await readiness(broken as never, { version: 'x' });
    expect(r.status).toBe('not_ready');
    expect(r.ok).toBe(false);
    expect(r.checks.db).toMatchObject({ ok: false });
    expect(r.checks.db.error).toContain('ECONNREFUSED');
    expect(r.checks.worker.status).toBe('unknown');
    const slow = { query: () => new Promise(() => undefined) };
    const s = await readiness(slow as never, { timeoutMs: 50 });
    expect(s.status).toBe('not_ready');
    expect(s.checks.db.error).toContain('시간 초과');
  });

  it('활성 워크스페이스가 없으면 idle (판정 보류, ready)', async () => {
    const empty = { rows: [] as unknown[], rowCount: 0 };
    const fake = {
      query: async (sql: string) => {
        if (sql.startsWith('SELECT 1')) return { rows: [{ '?column?': 1 }], rowCount: 1 };
        if (sql.includes('schema_migrations')) return { rows: [{ name: '001_core.sql' }], rowCount: 1 };
        if (sql.includes('worker_heartbeats')) return empty;
        return { rows: [{ last_finished: null, last_locked: null, running: 0, queued_due: 0, overdue: 0, failed24h: 0, active_ws: 0, db_now: new Date() }], rowCount: 1 };
      },
    };
    const dir = mkdtempSync(join(tmpdir(), 'mildo-mig-'));
    writeFileSync(join(dir, '001_core.sql'), '-- x');
    try {
      const r = await readiness(fake as never, { migrationsDir: dir });
      expect(r.status).toBe('ready');
      expect(r.checks.worker.status).toBe('idle');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('속도 제한 · 로그인 잠금 (환경변수로 낮춘 한도)', () => {
  let r: TestApp;
  beforeAll(async () => {
    r = await withEnv({ API_RATE_LIMIT_MAX: '5', API_RATE_LIMIT_WINDOW_SEC: '60', AUTH_RATE_LIMIT_MAX: '2', LOGIN_FAIL_MAX: '3', LOGIN_FAIL_WINDOW_MIN: '15' }, () => createTestApp());
  });
  afterAll(async () => {
    await r?.close();
  });
  const from = (ip: string, url: string, method = 'GET', payload?: unknown) => r.anon().raw({ method, url, payload, headers: { 'x-forwarded-for': ip } });

  it('IP당 한도를 넘으면 429 + 한국어 메시지 + retry-after, 다른 IP는 영향 없음', async () => {
    for (let i = 0; i < 5; i++) {
      const ok = await from('203.0.113.10', '/api/health');
      expect(ok.status).toBe(200);
      expect(ok.headers['x-ratelimit-limit']).toBe('5');
      expect(ok.headers['x-ratelimit-remaining']).toBe(String(4 - i));
    }
    const over = await from('203.0.113.10', '/api/health');
    expect(over.status).toBe(429);
    expect(over.json.error.code).toBe('rate_limited');
    expect(over.json.error.message).toMatch(/요청이 너무 많습니다\. \d+초 후 다시 시도해 주세요/);
    expect(Number(over.headers['retry-after'])).toBeGreaterThan(0);
    expect(over.headers['content-security-policy']).toBe(API_CSP);
    expect((await from('203.0.113.11', '/api/health')).status).toBe(200);
  });

  it('SSE(/api/w/:ws/events)와 /api 밖 경로는 전역 한도에서 빠진다', async () => {
    for (let i = 0; i < 6; i++) await from('203.0.113.20', '/api/health');
    expect((await from('203.0.113.20', '/api/health')).status).toBe(429);
    const sse = await from('203.0.113.20', `/api/w/${r.ws}/events`);
    expect(sse.status).toBe(401); // 한도가 아니라 인증으로 판정
    const page = await from('203.0.113.20', '/');
    expect(page.status).toBe(404);
  });

  it('IPv6는 /64 단위로 센다', async () => {
    for (let i = 0; i < 5; i++) expect((await from(`2001:db8:1:2::${i + 1}`, '/api/health')).status).toBe(200);
    expect((await from('2001:db8:1:2:ffff::9', '/api/health')).status).toBe(429);
    expect((await from('2001:db8:1:3::1', '/api/health')).status).toBe(200);
  });

  it('로그인 전 쓰기 엔드포인트는 IP당 분당 2회 (AUTH_RATE_LIMIT_MAX)', async () => {
    const ip = '192.0.2.50';
    const a = await from(ip, '/api/auth/password-reset', 'POST', { email: 'x@test.local' });
    const b = await from(ip, '/api/auth/password-reset', 'POST', { email: 'x@test.local' });
    expect([a.status, b.status]).not.toContain(429);
    const c = await from(ip, '/api/auth/password-reset', 'POST', { email: 'x@test.local' });
    expect(c.status).toBe(429);
    expect(c.json.error.message).toContain('로그인 · 인증 요청이 너무 많습니다');
  });

  it('같은 이메일 3회 실패 → 올바른 비밀번호도 429 login_locked (IP를 바꿔도) · 감사 기록 · 다른 계정은 영향 없음', async () => {
    let n = 0;
    const login = (email: string, password: string) => from(`198.51.100.${++n}`, '/api/auth/login', 'POST', { email, password });
    for (let i = 0; i < 3; i++) expect((await login('viewer@test.local', 'Wrong#Pass123')).status).toBe(401);
    const locked = await login('VIEWER@test.local', TEST_PASSWORD);
    expect(locked.status).toBe(429);
    expect(locked.json.error.code).toBe('login_locked');
    expect(locked.json.error.message).toContain('로그인 실패가 15분 안에 3회에 이르러');
    expect(Number(locked.headers['retry-after'])).toBeGreaterThan(0);
    expect(locked.headers['set-cookie']).toBeUndefined();
    const logs = await r.db.query<{ actor: string; detail: { failures: number } }>(`SELECT actor, detail FROM audit_log WHERE action = 'auth.login_locked'`);
    expect(logs.rows).toHaveLength(1);
    expect(logs.rows[0].detail.failures).toBe(3);
    expect((await login('ae@test.local', TEST_PASSWORD)).status).toBe(200);
  });

  it('성공 로그인 뒤에는 실패 횟수를 새로 센다', async () => {
    let n = 0;
    const login = (password: string) => from(`198.51.101.${++n}`, '/api/auth/login', 'POST', { email: 'pm@test.local', password });
    expect((await login('Wrong#Pass123')).status).toBe(401);
    expect((await login('Wrong#Pass123')).status).toBe(401);
    expect((await login(TEST_PASSWORD)).status).toBe(200);
    expect((await login('Wrong#Pass123')).status).toBe(401);
    expect((await login('Wrong#Pass123')).status).toBe(401);
    expect((await login(TEST_PASSWORD)).status).toBe(200);
  });

  it('같은 라우트를 다른 글자로 불러도(/%61pi/… · %6cogin · #) 전역 한도 · API 헤더 · 로그인 잠금을 피하지 못한다', async () => {
    // 전역 한도: /%61pi/health는 라우터가 /api/health로 보낸다
    for (let i = 0; i < 5; i++) {
      const ok = await from('203.0.113.30', '/%61pi/health');
      expect(ok.status).toBe(200);
      expect(ok.headers['content-security-policy']).toBe(API_CSP);
      expect(ok.headers['cache-control']).toBe('no-store');
    }
    expect((await from('203.0.113.30', '/api/health')).status).toBe(429);

    // 로그인 잠금: 인코딩한 경로로 실패를 쌓아도 같은 계정으로 센다
    let n = 0;
    const loginAt = (url: string, password: string) => from(`198.51.102.${++n}`, url, 'POST', { email: 'owner@test.local', password });
    for (let i = 0; i < 3; i++) expect((await loginAt('/api/auth/%6cogin', 'Wrong#Pass123')).status).toBe(401);
    const enc = await loginAt('/api/auth/%6cogin', TEST_PASSWORD);
    expect(enc.status).toBe(429);
    expect(enc.json.error.code).toBe('login_locked');
    const hash = await loginAt('/api/auth/login#x', TEST_PASSWORD);
    expect(hash.status).toBe(429);
    const plain = await loginAt('/api/auth/login?next=1', TEST_PASSWORD);
    expect(plain.status).toBe(429);

    // 로그인 계열 IP 한도(2회)도 인코딩으로 피하지 못한다
    const ip = '192.0.2.60';
    for (let i = 0; i < 2; i++) expect((await from(ip, '/api/auth/%70assword-reset', 'POST', { email: 'x@test.local' })).status).not.toBe(429);
    const third = await from(ip, '/api/auth/password-reset', 'POST', { email: 'x@test.local' });
    expect(third.status).toBe(429);
    expect(third.json.error.message).toContain('로그인 · 인증 요청이 너무 많습니다');
  });

  it('최근 로그인에 성공한 IP에서는 다른 곳의 실패로 잠기지 않는다 (같은 IP의 실패는 그대로 막힘)', async () => {
    const email = 'admin@test.local';
    const home = '198.51.103.10';
    expect((await from(home, '/api/auth/login', 'POST', { email, password: TEST_PASSWORD })).status).toBe(200);
    // 공격자: 다른 IP들에서 실패 3회 → 처음 보는 IP는 잠김
    for (let i = 0; i < 3; i++) expect((await from(`198.51.104.${i + 1}`, '/api/auth/login', 'POST', { email, password: 'Wrong#Pass123' })).status).toBe(401);
    const stranger = await from('198.51.104.50', '/api/auth/login', 'POST', { email, password: TEST_PASSWORD });
    expect(stranger.status).toBe(429);
    expect(stranger.json.error.code).toBe('login_locked');
    // 본인: 평소 IP에서는 로그인된다 (성공하면 계정 실패 수도 새로 센다)
    expect((await from(home, '/api/auth/login', 'POST', { email, password: TEST_PASSWORD })).status).toBe(200);
    expect((await loginLockState(r.db, email, '198.51.104.51', { windowMin: 15, max: 3 })).accountFailures).toBe(0);

    // 평소 IP라도 그 IP에서 실패가 한도를 넘으면 잠긴다 (같은 사무실 IP에서의 대입 차단)
    const uid = r.userIds.admin;
    for (let i = 0; i < 3; i++) {
      await r.db.query(`INSERT INTO audit_log (workspace_id, user_id, actor, action, ip) VALUES (NULL, $1, $2, 'auth.login_failed', $3)`, [uid, email, home]);
    }
    const st = await loginLockState(r.db, email, home, { windowMin: 15, max: 3 });
    expect(st).toMatchObject({ locked: true, scope: 'ip', knownIp: true, failures: 3 });
    expect(st.retryAfterSec).toBeGreaterThan(14 * 60);
    const other = await loginLockState(r.db, email, '198.51.104.52', { windowMin: 15, max: 3 });
    expect(other).toMatchObject({ locked: true, scope: 'account', knownIp: false });
    const logs = await r.db.query<{ detail: { scope: string } }>(`SELECT detail FROM audit_log WHERE action = 'auth.login_locked' AND actor = $1`, [email]);
    expect(logs.rows.map((x) => x.detail.scope)).toEqual(['account']);
  });

  it('잠긴 계정도 비밀번호 재설정을 마치면 새로 센다 (잠금 안내 문구대로 풀린다)', async () => {
    const email = 'client@test.local';
    let n = 0;
    const login = (password: string) => from(`198.51.105.${++n}`, '/api/auth/login', 'POST', { email, password });
    for (let i = 0; i < 3; i++) expect((await login('Wrong#Pass123')).status).toBe(401);
    const locked = await login(TEST_PASSWORD);
    expect(locked.status).toBe(429);
    expect(locked.json.error.message).toContain('비밀번호 재설정');

    const token = 'reset_token_for_lock_test_0123456789';
    await r.db.query(`INSERT INTO password_resets (token_hash, user_id, expires_at) VALUES ($1, $2, now() + interval '1 hour')`, [sha256(token), r.userIds.client]);
    const NEXT = 'NewClient#Pass2028';
    const done = await from('198.51.105.200', '/api/auth/password-reset/confirm', 'POST', { token, password: NEXT });
    expect(done.status).toBe(200);
    expect((await login(NEXT)).status).toBe(200);
  });

  it('잠금 해제 시각: 실패가 한도보다 많으면 (n - max + 1)번째로 오래된 실패가 창에서 빠질 때', async () => {
    const email = 'nobody-lock@test.local';
    const ago = [14, 10, 5, 1]; // 분 전
    for (const m of ago) {
      await r.db.query(`INSERT INTO audit_log (workspace_id, actor, action, ip, at) VALUES (NULL, $1, 'auth.login_failed', '192.0.2.99', now() - make_interval(mins => $2))`, [email, m]);
    }
    const st = await loginLockState(r.db, email, '192.0.2.99', { windowMin: 15, max: 3 });
    // 계정이 없으면 '익숙한 IP'도 없다 → 계정 기준 4회, 2번째로 오래된 실패(10분 전)가 빠지는 5분 뒤 풀림
    expect(st).toMatchObject({ locked: true, scope: 'account', knownIp: false, failures: 4 });
    expect(st.retryAfterSec).toBeGreaterThan(4 * 60);
    expect(st.retryAfterSec).toBeLessThanOrEqual(5 * 60 + 1);
  });
});

describe('느린 요청 로그', () => {
  it('경로는 라우트 패턴으로 남겨 경로 속 토큰이 로그에 남지 않는다', async () => {
    const lines: string[] = [];
    const stream = { write: (l: string) => { lines.push(l); } };
    const m = await withEnv({ SLOW_REQUEST_MS: '1' }, async () => {
      const f = Fastify({ logger: { level: 'warn', stream } });
      f.decorate('ctx', { db: t.db, config: t.config, events: t.events });
      await f.register(securityPlugin);
      f.get('/api/invites/:token', async () => {
        await new Promise((res) => setTimeout(res, 15));
        return { ok: true };
      });
      await f.ready();
      return f;
    });
    try {
      const secret = 'inviteTokenSecret0123456789abcdef';
      const res = await m.inject({ method: 'GET', url: `/api/invites/${secret}`, headers: { 'x-request-id': 'slow-req-0001' } });
      expect(res.statusCode).toBe(200);
      const slow = lines.map((l) => JSON.parse(l)).find((l) => l.msg === '느린 요청');
      expect(slow).toMatchObject({ route: '/api/invites/:token', requestId: 'slow-req-0001', statusCode: 200 });
      expect(JSON.stringify(slow)).not.toContain(secret);
    } finally {
      await m.close();
    }
  });
});

describe('우아한 종료', () => {
  it('app.close() 때 열린 SSE 연결을 정리해 종료가 멈추지 않는다', async () => {
    const g = await createTestApp();
    try {
      const v = await g.login('viewer');
      const pending = v.get(`/api/w/${g.ws}/events`);
      for (let i = 0; i < 50 && g.events.listenerCount(g.ws) === 0; i++) await new Promise((res) => setTimeout(res, 20));
      expect(g.events.listenerCount(g.ws)).toBe(1);
      const closing = g.app.close();
      const res = await Promise.race([pending, new Promise<null>((ok) => setTimeout(() => ok(null), 3000))]);
      expect(res).not.toBeNull();
      expect(res!.body).toContain('event: hello');
      expect(res!.body).toContain('retry: 3000');
      // 실제 SSE 라우트(events/routes.ts, hijack)에도 헤더가 붙는다
      expect(String(res!.headers['x-request-id'])).toMatch(UUID);
      expect(res!.headers['x-content-type-options']).toBe('nosniff');
      expect(res!.headers['content-security-policy']).toBe(API_CSP);
      await closing;
    } finally {
      await g.events.stop();
      await g.testDb.dispose();
    }
  });
});

describe('우아한 종료 — AI 응답 스트림', () => {
  /** AI 라우트와 같은 모양(hijack → SSE)으로 delayMs 뒤 done을 보내는 가짜 라우트를 띄운다 */
  async function aiServer(env: Record<string, string>, delayMs: number) {
    const seen: { closedBeforeFinish?: boolean } = {};
    const app = await withEnv(env, async () => {
      const f = Fastify();
      f.decorate('ctx', { db: t.db, config: t.config, events: t.events });
      await f.register(securityPlugin);
      f.post('/api/w/:ws/ai/messages', async (_req, reply) => {
        reply.hijack();
        const res = reply.raw;
        res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' });
        res.on('close', () => {
          seen.closedBeforeFinish = !res.writableFinished; // ai/index.ts는 이때 Anthropic 스트림을 중단한다
        });
        res.write('event: text\ndata: {"delta":"부분"}\n\n');
        setTimeout(() => {
          if (!res.writableEnded && !res.destroyed) res.end('event: done\ndata: {"stop_reason":"end_turn"}\n\n');
        }, delayMs);
      });
      await f.listen({ port: 0, host: '127.0.0.1' });
      return f;
    });
    const port = (app.server.address() as AddressInfo).port;
    const body = new Promise<{ text: string; headers: Record<string, unknown> }>((ok) => {
      const rq = httpRequest({ host: '127.0.0.1', port, method: 'POST', path: '/api/w/abc/ai/messages', headers: { 'content-type': 'application/json' } }, (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (text += c));
        res.on('close', () => ok({ text, headers: res.headers }));
      });
      rq.on('error', () => ok({ text: '', headers: {} }));
      rq.end('{}');
    });
    // 첫 이벤트가 올 때까지 기다린 뒤 종료를 시작한다
    await new Promise((r) => setTimeout(r, 100));
    return { app, body, seen };
  }

  it('유예 시간 안에 끝나는 답은 끝까지 보낸 뒤 닫는다', async () => {
    const { app, body, seen } = await aiServer({ SHUTDOWN_STREAM_GRACE_MS: '3000' }, 400);
    const started = Date.now();
    await app.close();
    const r = await body;
    expect(r.text).toContain('event: done');
    expect(r.text).not.toContain('server_restarting');
    expect(seen.closedBeforeFinish).toBe(false);
    expect(Date.now() - started).toBeGreaterThanOrEqual(250);
    expect(r.headers['x-content-type-options']).toBe('nosniff'); // hijack 응답에도 보안 헤더
  });

  it('유예 시간을 넘기면 error 이벤트(server_restarting)를 보내고 끊는다 → 라우트가 업스트림을 중단할 수 있다', async () => {
    const { app, body, seen } = await aiServer({ SHUTDOWN_STREAM_GRACE_MS: '150' }, 10_000);
    const started = Date.now();
    await app.close();
    expect(Date.now() - started).toBeLessThan(5000);
    const r = await body;
    expect(r.text).toContain('event: text');
    expect(r.text).toContain(SHUTDOWN_AI_EVENT.trim());
    expect(r.text).toContain('서버를 다시 시작하는 중');
    expect(r.text).not.toContain('event: done');
    expect(seen.closedBeforeFinish).toBe(true);
  });
});

describe('순수 함수', () => {
  it('WindowLimiter: 창 안에서 max까지 허용, 창이 지나면 초기화, 만료 키 정리', () => {
    let now = 1_000_000;
    const l = new WindowLimiter(2, 60_000, () => now);
    expect(l.hit('a').ok).toBe(true);
    expect(l.hit('a')).toMatchObject({ ok: true, remaining: 0 });
    expect(l.hit('a')).toMatchObject({ ok: false, retryAfterSec: 60 });
    expect(l.hit('b').ok).toBe(true);
    now += 30_000;
    expect(l.hit('a')).toMatchObject({ ok: false, retryAfterSec: 30 });
    now += 30_001;
    expect(l.hit('a').ok).toBe(true);
    expect(l.size).toBe(1); // b는 만료되어 정리
  });

  it('WindowLimiter: 키 수 상한 — 한 창 안에 키를 쌓아도 상한을 넘지 않고, 가장 먼저 들어온 키부터 버린다', () => {
    const now = 5_000_000;
    const l = new WindowLimiter(2, 60_000, () => now, 3);
    l.hit('k1'); l.hit('k1'); l.hit('k2'); l.hit('k3');
    expect(l.hit('k1').ok).toBe(false); // 아직 상한 전: k1은 3회째로 막힘
    for (let i = 0; i < 50; i++) l.hit(`spray-${i}`);
    expect(l.size).toBe(3);
    // 버려진 k1은 새 창으로 다시 센다(대신 메모리는 상한 안)
    expect(l.hit('k1').ok).toBe(true);
    expect(l.size).toBe(3);
  });

  it('rateKeyOf: IPv4-mapped · 포트 · IPv6 /64', () => {
    expect(rateKeyOf('203.0.113.5')).toBe('203.0.113.5');
    expect(rateKeyOf('::ffff:203.0.113.5')).toBe('203.0.113.5');
    expect(rateKeyOf('203.0.113.5:4431')).toBe('203.0.113.5');
    expect(rateKeyOf('2001:0db8:0001:0002:aaaa::1')).toBe('2001:db8:1:2::/64');
    expect(rateKeyOf('[2001:db8:1:2::9]:443')).toBe('2001:db8:1:2::/64');
    expect(rateKeyOf('::1')).toBe('0:0:0:0::/64');
  });

  it('clientIp: 프록시 hops만큼 오른쪽에서 고른다 (꾸민 XFF 앞부분은 무시)', () => {
    const req = (xff?: string) => ({ headers: xff ? { 'x-forwarded-for': xff } : {}, raw: { socket: { remoteAddress: '10.0.0.2' } }, ip: '10.0.0.2' }) as never;
    expect(clientIp(req(), 1)).toBe('10.0.0.2');
    expect(clientIp(req('1.1.1.1'), 1)).toBe('1.1.1.1');
    expect(clientIp(req('6.6.6.6, 1.1.1.1'), 1)).toBe('1.1.1.1');
    expect(clientIp(req('6.6.6.6, 1.1.1.1'), 0)).toBe('10.0.0.2');
    expect(clientIp(req('6.6.6.6, 1.1.1.1, 172.16.0.1'), 2)).toBe('1.1.1.1');
    expect(clientIp(req('1.1.1.1'), 5)).toBe('1.1.1.1');
  });

  it('decodedPath · routePath: 라우트 패턴 우선, 와일드카드 · 404는 해제한 원시 경로', () => {
    expect(decodedPath('/%61pi/auth/%6cogin?x=1#y')).toBe('/api/auth/login');
    expect(decodedPath('/api/auth/login#frag')).toBe('/api/auth/login');
    expect(decodedPath('/bad/%E0%A4%A')).toBe('/bad/%E0%A4%A');
    expect(routePath({ url: '/api/w/abc/events', routeOptions: { url: '/api/w/:ws/events' } })).toBe('/api/w/:ws/events');
    expect(routePath({ url: '/%61pi/nope', routeOptions: { url: '/*' } })).toBe('/api/nope');
    expect(routePath({ url: '/%61pi/nope', routeOptions: {} })).toBe('/api/nope');
  });

  it('isInternalIp: 루프백 · 사설망 · 링크 로컬만', () => {
    for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.0.10', '169.254.1.1', '::1', '::ffff:10.0.0.2', 'fd12:3456::1', 'fe80::1%eth0', '[::1]:8080']) {
      expect(isInternalIp(ip), ip).toBe(true);
    }
    for (const ip of ['203.0.113.5', '172.32.0.1', '172.15.0.1', '8.8.8.8', '2001:db8::1', '100.64.0.1', '', 'unknown']) {
      expect(isInternalIp(ip), ip).toBe(false);
    }
  });

  it('CSP 추가 출처는 https/wss 출처만 통과', () => {
    expect(parseCspSources("https://api.anthropic.com wss://x.example.com:8443 'unsafe-eval' * http://x.com https://a.com;b")).toEqual([
      'https://api.anthropic.com',
      'wss://x.example.com:8443',
    ]);
    expect(appCsp(['https://api.anthropic.com'])).toContain("connect-src 'self' https://api.anthropic.com");
  });

  it('환경변수 기본값: 프로덕션은 켜짐, 테스트는 꺼짐, 잘못된 값은 기본값', () => {
    const prod = securityOptionsFromEnv({}, 'production');
    expect(prod).toMatchObject({
      apiRateMax: 600, apiRateWindowMs: 60_000, authRateMax: 20, loginFailMax: 10, loginFailWindowMin: 15, proxyHops: 1, workerStaleMin: 15,
      schedulerStaleMin: 25, shutdownStreamGraceMs: 20_000,
    });
    // 스케줄러 판정은 예약 간격(10분)보다 짧게 둘 수 없다
    expect(securityOptionsFromEnv({ READY_SCHEDULER_STALE_MIN: '5' }, 'production').schedulerStaleMin).toBe(11);
    const test = securityOptionsFromEnv({}, 'test');
    expect(test).toMatchObject({ apiRateMax: 0, authRateMax: 0, loginFailMax: 0 });
    const odd = securityOptionsFromEnv({ API_RATE_LIMIT_MAX: '-3', TRUST_PROXY_HOPS: '0' }, 'production');
    expect(odd.apiRateMax).toBe(600);
    expect(odd.proxyHops).toBe(0);
    expect(prod.readyToken).toBeNull();
    expect(securityOptionsFromEnv({ READY_TOKEN: 'short' }, 'production').readyToken).toBeNull();
    expect(securityOptionsFromEnv({ READY_TOKEN: ' 0123456789abcdef ' }, 'production').readyToken).toBe('0123456789abcdef');
  });
});

describe('ENCRYPTION_KEY 회전 도구 (deploy/tools/rotate-encryption-key.mjs)', () => {
  const OLD = Buffer.alloc(32, 7).toString('base64'); // 테스트 설정의 개발 키와 같다
  const NEW = Buffer.alloc(32, 9).toString('base64');

  it('*_enc 컬럼을 찾아 점검(dry-run) → 적용 → 재실행 안전 · 틀린 키는 아무것도 바꾸지 않는다', async () => {
    expect(t.config.encryptionKey).toBe(OLD);
    const cols = await findEncryptedColumns(t.db);
    expect(cols).toEqual(expect.arrayContaining([
      { table: 'connections', column: 'credentials_enc' },
      { table: 'notification_channels', column: 'config_enc' },
    ]));
    const secret = JSON.stringify({ apiKey: 'sk-live-123456', secretKey: 'abc' });
    const c1 = (await t.db.query<{ id: string }>(
      `INSERT INTO connections (workspace_id, provider, kind, label, credentials_enc) VALUES ($1, 'naver_sa', 'media', '회전 테스트', $2) RETURNING id`,
      [t.ws, encryptSecret(secret, OLD)],
    )).rows[0].id;
    await t.db.query(`INSERT INTO connections (workspace_id, provider, kind, label, credentials_enc) VALUES ($1, 'csv', 'other', '형식 다름', 'legacy-plain')`, [t.ws]);
    await t.db.query(`INSERT INTO connections (workspace_id, provider, kind, label) VALUES ($1, 'csv', 'other', '자격증명 없음')`, [t.ws]);
    const ch = (await t.db.query<{ id: string }>(
      `INSERT INTO notification_channels (workspace_id, type, name, config_enc) VALUES ($1, 'slack', '알림', $2) RETURNING id`,
      [t.ws, encryptSecret('https://hooks.slack.com/services/T/B/X', OLD)],
    )).rows[0].id;
    const read = async () => ({
      conn: (await t.db.query<{ v: string }>('SELECT credentials_enc AS v FROM connections WHERE id = $1', [c1])).rows[0].v,
      chan: (await t.db.query<{ v: string }>('SELECT config_enc AS v FROM notification_channels WHERE id = $1', [ch])).rows[0].v,
    });
    const original = await read();

    const dry = await t.db.tx((q) => rotateEncryptionKey(q, { oldKey: OLD, newKey: NEW }));
    expect(dry.applied).toBe(false);
    expect(dry.totals).toMatchObject({ rotated: 2, skipped: 1, failed: 0, alreadyNew: 0 });
    expect(await read()).toEqual(original);
    expect(JSON.stringify(dry)).not.toContain('sk-live');

    const wrong = Buffer.alloc(32, 3).toString('base64');
    await expect(t.db.tx((q) => rotateEncryptionKey(q, { oldKey: wrong, newKey: NEW, apply: true }))).rejects.toThrow(/풀리지 않는 값/);
    expect(await read()).toEqual(original);

    const done = await t.db.tx((q) => rotateEncryptionKey(q, { oldKey: OLD, newKey: NEW, apply: true }));
    expect(done).toMatchObject({ applied: true, totals: { rotated: 2, skipped: 1, failed: 0 } });
    const after = await read();
    expect(after.conn).not.toBe(original.conn);
    expect(decryptSecret(after.conn, NEW)).toBe(secret);
    expect(decryptSecret(after.chan, NEW)).toBe('https://hooks.slack.com/services/T/B/X');
    expect(() => decryptSecret(after.conn, OLD)).toThrow();

    const again = await t.db.tx((q) => rotateEncryptionKey(q, { oldKey: OLD, newKey: NEW, apply: true }));
    expect(again.totals).toMatchObject({ rotated: 0, alreadyNew: 2, failed: 0 });

    await expect(rotateEncryptionKey(t.db, { oldKey: OLD, newKey: OLD })).rejects.toThrow(/같습니다/);
    await expect(rotateEncryptionKey(t.db, { oldKey: 'short', newKey: NEW })).rejects.toThrow(/32바이트/);
    await t.db.query(`DELETE FROM connections WHERE label IN ('회전 테스트', '형식 다름', '자격증명 없음')`);
    await t.db.query('DELETE FROM notification_channels WHERE id = $1', [ch]);
  });
});
