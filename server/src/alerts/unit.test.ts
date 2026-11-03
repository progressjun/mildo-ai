/** alerts 순수 로직: SSRF 검사 · 채널 설정 검증/마스킹 · 상태 전이 · SLA 단계 판정 · 메시지 형식 (DB 없음) */
import { describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import { DEMO } from '@/data/demo';
import { detectIncidents, msToKstIso, onDutyFor } from '@/modules/alert/engine';
import { EventEmitter } from 'node:events';
import { checkOutboundUrl, createHttpsPoster, guardedLookup, httpsPoster, isBlockedAddress, OutboundBlockedError } from './net';
import { isTestData } from './scan';
import { maskConfig, maskUrl, severityAllowed, validateConfig } from './channels';
import { applyIncidentPatch, normalizeClientIncident, normImpact, rosterAssignment, transitionOf, IncidentInput, type StoredIncident } from './incidents';
import { dueEscalations } from './sla';
import { buildMessage, slaDeadlines } from './messages';
import { signWebhook } from './deliver';
import { HttpError } from '../lib/errors';

// 가짜 테스트 주소 — 비밀값 스캐너 오탐을 피하려고 조각으로 조립
const SLACK = ['https://hooks.slack.com', 'services', 'T0AAA1111', 'B0BBB2222', 'abcdefghijklmnopqrstuvwx'].join('/');
const ws = { id: '00000000-0000-0000-0000-000000000001', slug: 'mildo', name: '수면밀도 퍼포먼스', brand_name: '수면밀도' };

function incidentAt(detIso: string, over: Partial<StoredIncident> = {}): StoredIncident {
  const base = detectIncidents(DEMO).find((i) => i.severity === 'P1')!;
  return { ...base, detectedAt: detIso, status: 'open', sla: {}, timeline: [...base.timeline], ...over } as StoredIncident;
}

describe('SSRF 차단', () => {
  it.each([
    ['http://127.0.0.1/hook', 'https'],
    ['http://169.254.169.254/latest/meta-data', 'https'],
    ['http://hooks.example.com/x', 'https'],
    ['ftp://hooks.example.com/x', 'https'],
    ['https://127.0.0.1/hook', '사설'],
    ['https://169.254.169.254/latest/meta-data', '사설'],
    ['https://10.1.2.3/x', '사설'],
    ['https://172.20.0.1/x', '사설'],
    ['https://192.168.0.10/x', '사설'],
    ['https://100.64.1.1/x', '사설'],
    ['https://0.0.0.0/x', '사설'],
    ['https://[::1]/x', '사설'],
    ['https://[fe80::1]/x', '사설'],
    ['https://[fd00::5]/x', '사설'],
    ['https://[::ffff:127.0.0.1]/x', '사설'],
    ['https://[::ffff:a9fe:a9fe]/x', '사설'],
    ['https://0x7f000001/x', '사설'],
    ['https://2130706433/x', '사설'],
    ['https://localhost/x', '내부망'],
    ['https://metadata.google.internal/x', '내부망'],
    ['https://printer.local/x', '내부망'],
    ['https://intranet/x', '도메인'],
    ['https://user:pw@hooks.example.com/x', '사용자'],
    ['not a url', 'URL'],
  ])('%s → 차단', (url, why) => {
    const r = checkOutboundUrl(url);
    expect(r.ok).toBe(false);
    expect(r.reason).toContain(why);
  });
  it('공인 https 주소는 허용', () => {
    expect(checkOutboundUrl('https://hooks.example.com/mildo?x=1').ok).toBe(true);
    expect(checkOutboundUrl('https://8.8.8.8/x').ok).toBe(true);
    expect(checkOutboundUrl('https://hooks.example.com:8443/x').ok).toBe(true);
  });
  it('주소 판정: 사설 · 매핑 · NAT64 · 공인', () => {
    for (const a of ['127.0.0.1', '10.0.0.1', '169.254.169.254', '::1', '::ffff:10.0.0.1', '64:ff9b::7f00:1', 'fc00::1', 'not-ip', '255.255.255.255']) expect(isBlockedAddress(a), a).toBe(true);
    for (const a of ['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111', '::ffff:8.8.8.8']) expect(isBlockedAddress(a), a).toBe(false);
  });
});

describe('발송 시점 주소 검사 (DNS rebinding 방지)', () => {
  it('연결 직전 lookup에서 내부 주소로 풀리는 이름을 막는다 (localhost → 127.0.0.1, /etc/hosts · 네트워크 없음)', async () => {
    const err = await new Promise<NodeJS.ErrnoException | null>((resolve) => guardedLookup('localhost', {}, (e) => resolve(e)));
    expect(err).toBeInstanceOf(OutboundBlockedError);
    expect(err?.code).toBe('EBLOCKED');
  });
  it('기본 포스터는 보내기 전에 http · 사설 IP를 거부한다 (연결 시도 없음)', async () => {
    await expect(httpsPoster({ url: 'http://127.0.0.1/x', body: '{}', headers: {} })).rejects.toBeInstanceOf(OutboundBlockedError);
    await expect(httpsPoster({ url: 'https://169.254.169.254/latest', body: '{}', headers: {} })).rejects.toThrow(/사설/);
    // 테스트 환경에서 주입 없이 공인 주소로 보내려 하면 네트워크 대신 오류
    await expect(httpsPoster({ url: 'https://hooks.example.com/x', body: '{}', headers: {} })).rejects.toThrow(/테스트 환경/);
  });
});

describe('채널 설정 검증 · 마스킹', () => {
  it('Slack: hooks.slack.com/services 형식만', () => {
    expect(validateConfig('slack', { webhookUrl: SLACK })).toEqual({ webhookUrl: SLACK });
    for (const bad of ['https://hooks.slack.com.evil.com/services/a/b/c', 'http://hooks.slack.com/services/a/b/c', 'https://hooks.slack.com/other/a/b/c', 'https://example.com/services/a/b/c', '']) {
      expect(() => validateConfig('slack', { webhookUrl: bad }), bad).toThrow(HttpError);
    }
  });
  it('웹훅: SSRF 차단 · 비밀값 16자 이상', () => {
    expect(() => validateConfig('webhook', { url: 'http://127.0.0.1/x' })).toThrow(/https/);
    expect(() => validateConfig('webhook', { url: 'https://169.254.169.254/x' })).toThrow(/사설/);
    expect(() => validateConfig('webhook', { url: 'https://hooks.example.com/x', secret: 'short' })).toThrow(HttpError);
    expect(validateConfig('webhook', { url: 'https://hooks.example.com/x', secret: 's'.repeat(20) })).toEqual({ url: 'https://hooks.example.com/x', secret: 's'.repeat(20) });
  });
  it('이메일: 형식 · 개수 · 중복 제거', () => {
    expect(validateConfig('email', { recipients: ['A@x.com', 'a@x.com', 'b@y.co.kr'] })).toEqual({ recipients: ['a@x.com', 'b@y.co.kr'] });
    expect(() => validateConfig('email', { recipients: [] })).toThrow(HttpError);
    expect(() => validateConfig('email', { recipients: ['not-an-email'] })).toThrow(HttpError);
  });
  it('마스킹: 토큰 · 비밀값이 응답에 남지 않는다', () => {
    const m = maskConfig('slack', { webhookUrl: SLACK });
    expect(JSON.stringify(m)).not.toContain('abcdefghijklmnop');
    expect(JSON.stringify(m)).not.toContain('B0BBB2222');
    expect(m.webhookUrl).toMatch(/^https:\/\/hooks\.slack\.com\/••••/);
    const w = maskConfig('webhook', { url: 'https://hooks.example.com/secret-path?token=abc', secret: 'x'.repeat(30) });
    expect(JSON.stringify(w)).not.toContain('secret-path');
    expect(JSON.stringify(w)).not.toContain('x'.repeat(30));
    expect(w.hasSecret).toBe(true);
    expect(maskConfig('email', { recipients: ['marketing@mildo.kr'] }).recipients).toEqual(['ma••••@mildo.kr']);
    expect(maskUrl('garbage')).toBe('••••');
  });
  it('등급 필터', () => {
    expect(severityAllowed('P2', 'P1')).toBe(true);
    expect(severityAllowed('P2', 'P2')).toBe(true);
    expect(severityAllowed('P2', 'P3')).toBe(false);
    expect(severityAllowed('P1', 'P2')).toBe(false);
    expect(severityAllowed('P3', 'P3')).toBe(true);
  });
});

describe('상태 전이 · 처리 기록', () => {
  const det = '2026-10-31T15:30:00+09:00';
  it('허용 흐름', () => {
    expect(transitionOf('open', 'ack')).toBe('forward');
    expect(transitionOf('open', 'resolved')).toBe('forward');
    expect(transitionOf('ack', 'action')).toBe('forward');
    expect(transitionOf('resolved', 'open')).toBe('reopen');
    expect(transitionOf('ack', 'ack')).toBe('same');
    expect(transitionOf('action', 'ack')).toBeNull();
    expect(transitionOf('ack', 'open')).toBeNull();
    expect(transitionOf('resolved', 'action')).toBeNull();
  });
  it('SLA 시각은 서버 시각 — 화면이 보낸 과거 시각으로 꾸밀 수 없다', () => {
    const at = '2026-10-31T16:10:00+09:00';
    const r = applyIncidentPatch(incidentAt(det), { status: 'ack', sla: { ackAt: '2026-10-31T15:31:00+09:00' } }, '인지', '김AE (담당 AE)', at);
    expect(r.doc.sla?.ackAt).toBe(at);
    expect(r.doc.status).toBe('ack');
    expect(r.doc.timeline.at(-1)).toEqual({ at, by: '김AE (담당 AE)', action: '인지' });
    // 이미 기록된 시각은 유지
    const r2 = applyIncidentPatch(r.doc, { status: 'action', actionNote: '픽셀 재설치', sla: { ackAt: '2026-10-31T15:00:00+09:00' } }, '1차 조치 · 픽셀 재설치', 'x', '2026-10-31T16:20:00+09:00');
    expect(r2.doc.sla?.ackAt).toBe(at);
    expect(r2.doc.sla?.actionAt).toBe('2026-10-31T16:20:00+09:00');
    expect(r2.doc.actionNote).toBe('픽셀 재설치');
  });
  it('해결 → 재오픈: resolvedAt 제거 · 오탐 표시 해제', () => {
    const r = applyIncidentPatch(incidentAt(det), { status: 'resolved', falsePositive: true }, '오탐으로 종료', 'x', '2026-10-31T16:00:00+09:00');
    expect(r.doc.sla?.resolvedAt).toBe('2026-10-31T16:00:00+09:00');
    expect(r.doc.sla?.ackAt).toBe('2026-10-31T16:00:00+09:00');
    const re = applyIncidentPatch(r.doc, {}, 'reopen', 'y', '2026-10-31T17:00:00+09:00');
    expect(re.transition).toBe('reopen');
    expect(re.doc.status).toBe('open');
    expect(re.doc.sla?.resolvedAt).toBeUndefined();
    expect(re.doc.falsePositive).toBe(false);
    expect(re.doc.timeline.at(-1)?.action).toBe('재오픈');
  });
  it('되돌림은 409', () => {
    const ack = applyIncidentPatch(incidentAt(det), { status: 'action' }, undefined, 'x').doc;
    try {
      applyIncidentPatch(ack, { status: 'open' }, undefined, 'x');
      throw new Error('should throw');
    } catch (e) {
      expect((e as HttpError).status).toBe(409);
    }
  });
  it('클라이언트 생성 이슈: 서버 필드 제거 · 감지 시각 보정 · 주말 당번 배정', () => {
    const sat = Date.parse('2026-10-31T10:00:00+09:00');
    const input = IncidentInput.parse({
      id: 'adpilot_hold:매트리스:2026-10-31', ruleId: 'data_spike', severity: 'P2', title: 'AD Pilot 자동 조정 보류 · 매트리스', media: 'naver_sa',
      detectedAt: '2020-01-01T00:00:00+09:00', escalations: { ack: { at: 'x' } }, source: 'scan', stillDetected: true, evidence: [{ label: 'CPC', observed: 1, unit: 'krw' }],
    });
    const doc = normalizeClientIncident(input, '박PM (PM)', sat);
    expect(doc.source).toBe('client');
    expect(doc.escalations).toBeUndefined();
    expect(doc.stillDetected).toBeUndefined();
    expect(doc.detectedAt).toBe(msToKstIso(sat));
    expect(doc.evidence).toHaveLength(1);
    const duty = onDutyFor('2026-10-31')!;
    expect(doc.assignee).toBe(duty.role);
    expect(doc.onDuty).toBe(true);
    // 평일은 매체 담당
    const weekday = rosterAssignment({ media: 'naver_sa' }, '2026-11-03');
    expect(weekday.assigneeRoleId).toBe('sa_ae');
    expect(weekday.onDuty).toBe(false);
  });
});

describe('SLA 단계 판정', () => {
  const det = '2026-11-03T10:00:00+09:00'; // 화요일 (평일)
  const ms = (min: number) => Date.parse(det) + min * 60_000;
  it('P1: 인지 15분 · 1차 조치 30분 · 결과 2시간, 처리된 단계 · 이미 알린 단계는 제외', () => {
    const inc = incidentAt(det, { onDuty: false });
    expect(slaDeadlines(inc).map((d) => [d.stage, (d.deadlineMs - Date.parse(det)) / 60_000])).toEqual([['ack', 15], ['action', 30], ['report', 120]]);
    expect(dueEscalations(inc, ms(10))).toEqual([]);
    expect(dueEscalations(inc, ms(16)).map((d) => d.stage)).toEqual(['ack']);
    expect(dueEscalations(inc, ms(31)).map((d) => d.stage)).toEqual(['ack', 'action']);
    expect(dueEscalations({ ...inc, status: 'ack', sla: { ackAt: det } }, ms(31)).map((d) => d.stage)).toEqual(['action']);
    expect(dueEscalations({ ...inc, escalations: { ack: { at: '', deadline: '', notified: 0 } } }, ms(16))).toEqual([]);
    expect(dueEscalations({ ...inc, status: 'action', sla: { ackAt: det, actionAt: det } }, ms(121)).map((d) => d.stage)).toEqual(['report']);
    expect(dueEscalations({ ...inc, status: 'resolved' }, ms(500))).toEqual([]);
  });
  it('주말 · 당번 이슈 P2는 인지 30분', () => {
    const inc = incidentAt('2026-10-31T15:30:00+09:00', { severity: 'P2', onDuty: true });
    const d = slaDeadlines(inc);
    expect((d[0].deadlineMs - Date.parse(inc.detectedAt)) / 60_000).toBe(30);
  });
});

describe('알림 메시지', () => {
  it('Slack Block Kit: header · 기준/관측/변화 · 원인 후보 상위 2 · 영향 추정 · SLA 기한 · 링크', () => {
    const inc = incidentAt('2026-10-31T15:30:00+09:00');
    const m = buildMessage({ event: 'incident', workspace: ws, appUrl: 'https://os.mildo.kr', incident: inc });
    expect(m.slack.text).toContain(`[P1] ${inc.title}`);
    const blocks = m.slack.blocks as { type: string; text?: { type: string; text: string }; fields?: { text: string }[]; elements?: { url?: string; type: string }[] }[];
    expect(blocks[0]).toMatchObject({ type: 'header', text: { type: 'plain_text' } });
    expect(blocks[0].text!.text.length).toBeLessThanOrEqual(150);
    const all = JSON.stringify(blocks);
    expect(all).toContain('*기준*');
    expect(all).toContain('*관측 · 변화*');
    expect(all).toContain('원인 후보 상위 2');
    expect(all).toContain('영향 (추정)');
    expect(all).toContain('SLA 기한');
    const actions = blocks.find((b) => b.type === 'actions')!;
    expect(actions.elements![0]).toMatchObject({ type: 'button', url: 'https://os.mildo.kr/#alert' });
    for (const b of blocks) {
      if (b.text?.text) expect(b.text.text.length).toBeLessThanOrEqual(3000);
      for (const f of b.fields ?? []) expect(f.text.length).toBeLessThanOrEqual(2000);
      expect((b.fields ?? []).length).toBeLessThanOrEqual(10);
    }
    const causeBlock = blocks.find((b) => b.text?.text.startsWith('*원인 후보 상위 2*'))!;
    expect(causeBlock.text!.text.split('\n').filter((l) => l.startsWith('•'))).toHaveLength(2);
    expect(all).not.toMatch(/NaN|undefined/);
  });
  it('메일 제목 · 본문 · 웹훅 JSON', () => {
    const inc = incidentAt('2026-10-31T15:30:00+09:00');
    const m = buildMessage({ event: 'incident', workspace: ws, appUrl: 'https://os.mildo.kr', incident: inc });
    expect(m.subject.startsWith('[MILDO OS] P1 ')).toBe(true);
    expect(m.text).toContain('원인 후보 상위 2');
    expect(m.text).toContain('영향 (추정)');
    expect(m.text).toContain('https://os.mildo.kr/#alert');
    expect(m.webhook).toMatchObject({ event: 'incident', workspace: { id: ws.id, slug: 'mildo' }, incident: { id: inc.id, severity: 'P1', url: 'https://os.mildo.kr/#alert' } });
    const sla = buildMessage({ event: 'sla', stage: 'ack', workspace: ws, appUrl: 'https://os.mildo.kr', incident: inc });
    expect(sla.subject).toContain('SLA 초과 · P1');
    expect(sla.text).toContain('에스컬레이션: 인지 기한');
  });
  it('웹훅 서명: HMAC-SHA256(secret, timestamp.body)', () => {
    const sig = signWebhook('top-secret-value-123', '1700000000', '{"a":1}');
    expect(sig).toBe(`sha256=${createHmac('sha256', 'top-secret-value-123').update('1700000000.{"a":1}').digest('hex')}`);
  });
});

/* ------------------------------ 리뷰 보강 ------------------------------ */

describe('주소 판정 보강', () => {
  it('IPv4 호환(::a.b.c.d) · 로컬 NAT64(64:ff9b:1::/48) · SIIT 매핑도 막는다', () => {
    for (const a of ['::7f00:1', '::a9fe:a9fe', '::', '64:ff9b:1::a00:1', '::ffff:0:7f00:1']) expect(isBlockedAddress(a), a).toBe(true);
    expect(checkOutboundUrl('https://[::7f00:1]/x').ok).toBe(false);
    expect(isBlockedAddress('2606:4700:4700::1111')).toBe(false);
  });
});

/** 가짜 https.request — 응답을 원하는 대로 흘려보낸다 (실제 소켓 없음) */
function fakeRequest(onRes: (res: EventEmitter & { statusCode: number; headers: Record<string, string>; destroyed?: boolean; destroy: () => void }) => void) {
  const calls: { destroyed: Error | null; res?: { destroyed?: boolean } } = { destroyed: null };
  const impl = ((_opts: unknown, cb: (res: unknown) => void) => {
    const req = new EventEmitter() as EventEmitter & { end: (b: string) => void; destroy: (e?: Error) => void };
    req.destroy = (e?: Error) => { calls.destroyed = e ?? new Error('destroyed'); req.emit('error', calls.destroyed); };
    req.end = () => {
      const res = Object.assign(new EventEmitter(), { statusCode: 200, headers: { 'content-type': 'text/plain' }, destroyed: false, destroy() { res.destroyed = true; } });
      calls.res = res;
      setImmediate(() => { cb(res); onRes(res); });
    };
    return req;
  }) as never;
  return { impl, calls };
}

describe('기본 포스터 제한 (가짜 request)', () => {
  it('응답이 64KB를 넘으면 끊고 앞부분만 돌려준다', async () => {
    const { impl, calls } = fakeRequest((res) => {
      for (let i = 0; i < 3; i++) res.emit('data', Buffer.alloc(40 * 1024, 97));
      res.emit('end');
    });
    const r = await createHttpsPoster(impl)({ url: 'https://hooks.example.com/x', body: '{}', headers: {} });
    expect(r.status).toBe(200);
    expect(r.body.length).toBe(40 * 1024);
    expect(calls.res?.destroyed).toBe(true);
  });
  it('조금씩 계속 보내는 응답도 전체 마감 시간에 끊는다 (워커를 붙잡지 않음)', async () => {
    let timer: ReturnType<typeof setInterval> | null = null;
    const { impl, calls } = fakeRequest((res) => { timer = setInterval(() => res.emit('data', Buffer.from('x')), 5); });
    const t0 = Date.now();
    await expect(createHttpsPoster(impl)({ url: 'https://hooks.example.com/x', body: '{}', headers: {}, timeoutMs: 40 })).rejects.toThrow(/전체/);
    if (timer) clearInterval(timer);
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(calls.destroyed).toBeTruthy();
  });
  it('주입한 request도 SSRF 정적 검사는 그대로 거친다', async () => {
    const { impl } = fakeRequest(() => undefined);
    await expect(createHttpsPoster(impl)({ url: 'https://10.0.0.1/x', body: '{}', headers: {} })).rejects.toBeInstanceOf(OutboundBlockedError);
  });
});

describe('테스트 데이터 판정 (감지 이슈 isTest)', () => {
  const src = (channel: string, kind: 'api' | 'csv' | 'demo') => ({ channel, source: kind === 'demo' ? 'demo' : `conn-${channel}`, kind, latestDate: '2026-11-03' });
  it('meta 없음 · demo → true, live → false, mixed → 매체 출처 기준', () => {
    expect(isTestData(undefined, 'meta')).toBe(true);
    expect(isTestData({ mode: 'demo', builtAt: '', sources: [] }, 'meta')).toBe(true);
    expect(isTestData({ mode: 'live', builtAt: '', sources: [] }, 'meta')).toBe(false);
    const mixed = { mode: 'mixed' as const, builtAt: '', sources: [src('meta', 'demo'), src('kakao', 'api'), src('google', 'demo'), src('google', 'csv')] };
    expect(isTestData(mixed, 'meta')).toBe(true);
    expect(isTestData(mixed, 'kakao')).toBe(false);
    expect(isTestData(mixed, 'google')).toBe(false); // 실 CSV 출처가 섞여 있음
    expect(isTestData(mixed, undefined)).toBe(false); // 매체를 모르면 실제 알림을 막지 않는다
  });
});

describe('수치 단위 (외부 발송 · 저장)', () => {
  it('웹훅 JSON: 금액(원) · 노출은 정수, NaN · Infinity는 null, 추정 표기', () => {
    const base = detectIncidents(DEMO).find((i) => i.id.startsWith('account_payment:'))!;
    expect(Number.isInteger(base.impact.spendAtRisk)).toBe(false); // 엔진 값은 소수 — 그대로 내보내면 안 된다
    const inc = { ...base, observed: Number.NaN, baseline: Number.POSITIVE_INFINITY, deltaPct: -9.266409266 };
    const m = buildMessage({ event: 'incident', workspace: ws, appUrl: 'https://os.example.com', incident: inc as never, sentAtMs: 0 });
    const w = (m.webhook as { incident: { impact: Record<string, unknown>; observed: unknown; baseline: unknown; deltaPct: unknown } }).incident;
    expect(Number.isInteger(w.impact.spendAtRiskKrw)).toBe(true);
    expect(Number.isInteger(w.impact.revenueLossEstKrw)).toBe(true);
    expect(Number.isInteger(w.impact.impressionsLost)).toBe(true);
    expect(w.impact.estimate).toBe(true);
    expect(w.observed).toBeNull();
    expect(w.baseline).toBeNull();
    expect(w.deltaPct).toBe(-9.27);
    expect(JSON.stringify(m.webhook)).not.toMatch(/NaN|Infinity/);
  });
  it('저장 전 정규화: 정수 · 음수 · 비정상 값 제거', () => {
    expect(normImpact({ spendAtRisk: 2029079.6, revenueLossEst: -5, impressionsLost: Number.NaN })).toEqual({ spendAtRisk: 2029080 });
    expect(normImpact(null)).toEqual({});
    const doc = normalizeClientIncident({ id: 'x:1', ruleId: 'r', severity: 'P2', title: 't', impact: { spendAtRisk: 1200.4 } } as never, 'pm');
    expect(doc.impact).toEqual({ spendAtRisk: 1200 });
  });
});
