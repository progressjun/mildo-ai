/** alerts 순수 로직: SSRF 검사 · 채널 설정 검증/마스킹 · 상태 전이 · SLA 단계 판정 · 메시지 형식 (DB 없음) */
import { describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import { DEMO } from '@/data/demo';
import { detectIncidents, msToKstIso, onDutyFor } from '@/modules/alert/engine';
import { checkOutboundUrl, guardedLookup, httpsPoster, isBlockedAddress, OutboundBlockedError } from './net';
import { maskConfig, maskUrl, severityAllowed, validateConfig } from './channels';
import { applyIncidentPatch, normalizeClientIncident, rosterAssignment, transitionOf, IncidentInput, type StoredIncident } from './incidents';
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
