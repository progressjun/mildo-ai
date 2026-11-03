/**
 * QA 회귀 (G1b · MILDO Alert 서버 모드) — SSR 렌더 + 버튼 props 수집(클릭은 onClick 직접 호출).
 *  - 권한: client · viewer는 이슈 처리 · 재스캔 · 테스트 주입이 사유와 함께 막힌다 (낙관적 반영 후 403 되돌림 없음). 데모는 그대로.
 *  - 시계: 서버 모드는 실제 시각 — Dataset 새로고침(generatedAt 변경)으로 SLA 타이머가 앞당겨지지 않는다.
 *  - 정직성: 서버 모드 '알림 이력'은 서버 발송 기록, 결과 보고 기록에 '발송' 없음, 감지 알림 문구는 실제 발송 요청 결과.
 *  - 데이터 기준 시각: generatedAt의 실제 시 · 분 (HH:30 고정 아님).
 *  - 당번 체계 강제(offHoursMode): 서버 모드는 이미 감지된 평일 이슈의 SLA 목표를 소급해 바꾸지 않는다 (서버 SLA 잡과 같은 기준).
 *  - 대량 변경 이슈 제목: 모듈 id 대신 한글 · 제품명.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement as h, isValidElement, type ComponentType, type ReactNode } from 'react';
import { renderToString } from 'react-dom/server';
import type { AppState } from '@/core/store';
import type { ChangeRequest, Incident, Toast } from '@/core/types';
import { can as canRole, type Role } from '@/core/permissions';
import type { WorkspaceSummary } from '@/saas/context';
import { DEMO } from '@/data/demo';

/* ---------- 버튼 props 수집 ---------- */
interface BtnProps { children?: ReactNode; disabled?: boolean; title?: string; onClick?: (e: unknown) => void }
const buttons: BtnProps[] = [];
vi.mock('@/ui/primitives', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/ui/primitives')>();
  return { ...actual, Button: (p: BtnProps) => { buttons.push(p); return (actual.Button as unknown as (x: BtnProps) => ReactNode)(p); } };
});

/* ---------- 스토어 (상태 직접 주입) ---------- */
const toasts: Omit<Toast, 'id'>[] = [];
const updates: { id: string; patch: Partial<Incident>; action: string }[] = [];
const added: Incident[] = [];
let storeState: AppState;
vi.mock('@/core/store', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/core/store')>();
  const actions = {
    toast: (t: Omit<Toast, 'id'>) => { toasts.push(t); },
    addIncident: (i: Incident) => { added.push(i); },
    updateIncident: (id: string, patch: Partial<Incident>, action: string) => { updates.push({ id, patch, action }); },
    updateChange: () => undefined, addChange: (c: unknown) => c,
  };
  return { ...actual, useStore: () => ({ state: storeState, dispatch: () => undefined }), useStoreOptional: () => ({ state: storeState, dispatch: () => undefined }), useActions: () => actions };
});
const apiCalls: string[] = [];
vi.mock('@/saas/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/saas/api')>();
  return { ...actual, api: vi.fn(async (path: string) => { apiCalls.push(path); return { found: 0, created: 0, entries: [], nextBefore: null }; }) };
});

const NOW = Date.parse('2026-11-03T08:53:18Z'); // 11/3(화) 17:53:18 KST — 평일
const kst = (ms: number) => { const d = new Date(ms + 9 * 3600_000); return `${d.toISOString().slice(0, 19)}+09:00`; };

let engine: typeof import('./engine');
let base: Incident[];
/** 평일 17:22:51 감지 P2 (onDuty=false) — offHoursMode를 켠 뒤에도 인지 목표 1시간이 유지돼야 하는 이슈 */
let weekdayP2: Incident;

function mkState(over: Partial<AppState> = {}): AppState {
  return {
    data: { ...DEMO, today: '2026-11-03', currentHour: 17, generatedAt: '2026-11-03T17:24:00+09:00' },
    changes: [], incidents: [], toasts: [], comments: [], ai: { mode: 'auto', apiKey: '', model: 'claude-opus-5-5' }, role: 'PM', offHoursMode: false, tf: {},
    demo: { running: false, startedAt: null, pausedAt: null, elapsedBeforePause: 0 },
    ...over,
  } as AppState;
}

const ws = (role: Role): WorkspaceSummary => ({ id: 'ws_1', slug: 'mildo', name: '수면밀도', brand_name: '수면밀도', status: 'active', role, permissions: [], demoRole: 'PM' });
async function wrap(node: ReactNode, role: Role | 'demo'): Promise<ReactNode> {
  if (role === 'demo') return node;
  const { SaasTestProvider } = await import('@/saas/context');
  return h(SaasTestProvider, { value: { mode: 'server', role, workspace: ws(role), can: (p) => canRole(role, p) }, children: node });
}

type Ctx = ReturnType<typeof import('./hooks').useAlert>;
async function render(name: 'View' | 'IncidentDrawer' | 'NotifyTab' | 'QueueTab' | 'AccountsTab', role: Role | 'demo', extra: Record<string, unknown> = {}): Promise<{ html: string; ctx: Ctx }> {
  buttons.length = 0;
  const { useAlert } = await import('./hooks');
  let ctx: Ctx | null = null;
  let inner: ReactNode;
  if (name === 'View') {
    const View = (await import('./View')).default;
    function Probe() { ctx = useAlert(); return null; }
    inner = h('div', null, h(Probe), h(View));
  } else {
    const mod = (await import(`./${name}`)) as Record<string, unknown>;
    const Tab = mod[name] as ComponentType<Record<string, unknown>>;
    function Harness() { ctx = useAlert(); return h(Tab, { ctx, onOpen: () => undefined, onClose: () => undefined, ...extra }); }
    inner = h(Harness);
  }
  // SSR 텍스트 경계 표시(<!-- -->)는 빼고 비교한다
  const html = renderToString(h('div', null, await wrap(inner, role))).replace(/<!-- -->/g, '');
  if (!ctx) throw new Error('useAlert 컨텍스트 없음');
  return { html, ctx };
}
const text = (n: ReactNode): string => (Array.isArray(n) ? n.map(text).join('') : typeof n === 'string' || typeof n === 'number' ? String(n) : isValidElement(n) ? text((n.props as { children?: ReactNode }).children) : '');
const btn = (label: string | RegExp) => {
  const b = buttons.find((x) => (typeof label === 'string' ? text(x.children).trim() === label : label.test(text(x.children))));
  if (!b) throw new Error(`버튼 없음: ${label} — ${buttons.map((x) => text(x.children)).join(' | ')}`);
  return b;
};

beforeAll(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  engine = await import('./engine');
  base = engine.detectIncidents(DEMO);
  const p2 = base.find((i) => i.severity === 'P2')!;
  weekdayP2 = { ...p2, id: 'brand_intrusion:test:2026-11-03', detectedAt: '2026-11-03T17:22:51+09:00', occurredAt: '2026-11-03T17:00:00+09:00', onDuty: false, status: 'open', sla: {} } as Incident;
});
afterAll(() => { vi.useRealTimers(); });
beforeEach(() => {
  storeState = mkState({ incidents: [weekdayP2] });
  toasts.length = 0; updates.length = 0; added.length = 0; apiCalls.length = 0;
});

describe('권한 — 이슈 처리 · 재스캔 · 테스트 주입은 담당 AE 이상 (서버 모드)', () => {
  const OP_LABELS = ['인지', '배정', '1차 조치 기록', '결과 보고', '권고안으로 기록', '해결', '오탐으로 종료'];
  it.each(['client', 'viewer'] as const)('%s: 드로어 처리 버튼 · 입력이 사유와 함께 막히고 클릭해도 서버로 보내지 않는다', async (role) => {
    const { html, ctx } = await render('IncidentDrawer', role, { id: weekdayP2.id });
    for (const l of OP_LABELS) {
      const b = btn(l);
      expect(b.disabled, l).toBe(true);
      expect(b.title, l).toContain('담당 AE 이상 권한');
    }
    expect(html).toContain('처리 단계는 볼 수만 있습니다');
    expect(html).toMatch(/<select[^>]*disabled=""[^>]*title="이슈 처리/);
    expect(html).toMatch(/<textarea[^>]*disabled=""/);
    // 막힌 경로로 호출돼도 낙관적 반영을 만들지 않는다
    ctx.act(weekdayP2 as never, { status: 'ack' }, '인지');
    expect(updates).toEqual([]);
    expect(toasts.at(-1)).toMatchObject({ tone: 'warning', title: '이슈 처리 권한이 없습니다' });
  });
  it('client: 헤더 재스캔 · 테스트 주입 · 테스트 정리 · 메신저 인지가 막히고 재스캔 API를 부르지 않는다', async () => {
    const v = await render('View', 'client');
    const re = btn('재스캔');
    expect(re.disabled).toBe(true);
    expect(re.title).toBe('이슈 처리 · 재스캔 · 테스트 주입은 담당 AE 이상 권한 (현재 역할: 광고주 담당자)');
    expect(v.html).toContain('담당 AE 이상 권한 (현재 역할: 광고주 담당자)</span>');
    expect(v.ctx.rescan()).toBe(0);
    await new Promise((r) => setTimeout(r, 0));
    expect(apiCalls).toEqual([]);

    storeState = mkState({ incidents: [weekdayP2, { ...base.find((i) => i.severity === 'P1')!, isTest: true, id: 'p1:test-1' } as Incident] });
    await render('NotifyTab', 'client');
    const injects = buttons.filter((b) => /^(광고 OFF|결제 실패|광고비 급변|소재 반려)$/.test(text(b.children)));
    expect(injects.length).toBeGreaterThan(0);
    for (const b of injects) expect(b.disabled).toBe(true);
    expect(btn('테스트 이슈 정리').disabled).toBe(true);
    for (const b of buttons.filter((x) => text(x.children) === '인지')) expect(b.disabled).toBe(true);
  });
  it('viewer: 변경 요청 버튼도 사유와 함께 막힌다 (request 권한 없음)', async () => {
    const pay = base.find((i) => i.ruleId === 'account_payment')!;
    storeState = mkState({ data: DEMO, incidents: [pay] });
    await render('IncidentDrawer', 'viewer', { id: pay.id });
    const topup = btn(/^충전 요청/);
    expect(topup.disabled).toBe(true);
    expect(topup.title).toContain('변경 요청은');
    await render('IncidentDrawer', 'client', { id: pay.id });
    expect(btn(/^충전 요청/).disabled).toBe(false);
  });
  it('ae · 데모: 처리 버튼은 그대로 쓸 수 있다', async () => {
    for (const role of ['ae', 'demo'] as const) {
      const { ctx } = await render('IncidentDrawer', role, { id: weekdayP2.id });
      expect(btn('인지').disabled, role).toBe(false);
      expect(btn('인지').title, role).toBeUndefined();
      expect(btn('오탐으로 종료').disabled, role).toBe(false);
      expect(ctx.perm.operate).toBe(true);
    }
    await render('View', 'demo');
    expect(btn('재스캔').disabled).toBe(false);
  });
});

describe('시계 — 서버 모드는 실제 시각 (Dataset 새로고침에 흔들리지 않음)', () => {
  it('clock: 실제 시각 모드는 generatedAt과 무관하고 기록 시각을 그대로 읽는다 · 데모는 데이터 시계 그대로', async () => {
    const { dataNowMs, toDataMs } = await import('./clock');
    const real = Date.now() + 120_000;
    expect(dataNowMs('2026-11-03T17:24:00+09:00', true, real)).toBe(real);
    expect(dataNowMs('2026-11-03T17:26:00+09:00', true, real)).toBe(real);
    expect(toDataMs('2026-11-03T08:20:00.000Z', '2026-11-03T17:26:00+09:00', true)).toBe(Date.parse('2026-11-03T08:20:00.000Z'));
    // 데모: 데이터 기준 시각 + 세션 경과 (기존 동작)
    const a = dataNowMs(DEMO.generatedAt, false, real);
    const b = dataNowMs(DEMO.generatedAt, false, real + 60_000);
    expect(b - a).toBe(60_000);
    expect(a).toBeGreaterThanOrEqual(Date.parse(DEMO.generatedAt));
  });
  it('서버 모드 SLA 남은 시간 = 서버 기한 − 실제 시각 (새로고침 전후 동일 · 분 내림 지연 없음)', async () => {
    const det = NOW - 10 * 60_000 - 30_000; // 10분 30초 전 감지 (서버 KST 기록)
    const p1 = { ...base.find((i) => i.severity === 'P1')!, id: 'p1:x', detectedAt: kst(det), onDuty: false, status: 'open', sla: {} } as Incident;
    const remain = async (generatedAt: string) => {
      storeState = mkState({ incidents: [p1], data: { ...mkState().data, generatedAt } });
      const { ctx } = await render('QueueTab', 'pm');
      return engine.slaState(p1, ctx.nowMs, ctx.toMs, ctx.slaOff).remainingMin!;
    };
    const before = await remain('2026-11-03T17:43:00+09:00'); // 분 내림된 데이터 기준 시각
    const after = await remain('2026-11-03T17:53:00+09:00'); // 새로고침 뒤
    expect(before).toBeCloseTo(4.5, 5); // 15분 − 10.5분
    expect(after).toBeCloseTo(before, 5);
    const { ctx } = await render('QueueTab', 'pm');
    expect(Date.parse(ctx.clockIso())).toBe(Math.floor(NOW / 1000) * 1000);
  });
});

describe('정직성 — 서버 모드 알림 표기', () => {
  it('withDeliveryNote: 채널 0곳이면 미발송 · 사유, 있으면 발송 요청 채널 수, 모르면 발송 이력 기준', () => {
    const inc = base.find((i) => i.ruleId === 'tracking_break') ?? base.find((i) => i.severity === 'P1')!;
    expect(inc.timeline[0].action).toMatch(/^감지 · 메신저 알림/);
    const none = engine.withDeliveryNote(inc, { enqueued: 0, skipped: 0 });
    expect(none.timeline[0].action).toBe('감지 · 알림 미발송 (이 이벤트를 받는 켜진 알림 채널 없음)');
    expect(none.autoActions.join('\n')).not.toMatch(/알림 발송 · /);
    expect(none.autoActions.some((a) => a.startsWith('알림 미발송 · '))).toBe(true);
    const some = engine.withDeliveryNote(inc, { enqueued: 2, skipped: 0 });
    expect(some.timeline[0].action).toBe('감지 · 알림 채널 2곳에 발송 요청 (결과는 알림 설정 › 발송 이력)');
    expect(engine.withDeliveryNote(inc, { enqueued: 0, skipped: 1 }).timeline[0].action).toBe('감지 · 알림 미발송 (켜진 채널 1곳이 이 등급을 받지 않음)');
    expect(engine.withDeliveryNote(inc, null).timeline[0].action).toBe('감지 · 알림은 서버가 켜진 채널로 발송 (결과는 알림 설정 › 발송 이력)');
    // 원본은 바꾸지 않는다 (데모 엔진 출력 그대로)
    expect(inc.timeline[0].action).toMatch(/^감지 · 메신저 알림/);
    // 주말 당번 문구: 보낸 채널이 없으면 직접 연락 필요
    const duty = { ...inc, autoActions: ['주말 · 공휴일 체계: 당번 SA 리드 30분 내 확인 요청', 'P1 → PM 에스컬레이션 · 브랜드 담당자 연락'] };
    expect(engine.withDeliveryNote(duty, { enqueued: 0, skipped: 0 }).autoActions).toEqual([
      '주말 · 공휴일 체계: 당번 SA 리드 30분 내 확인 요청 (알림 미발송 — 직접 연락 필요)', 'P1 → PM 에스컬레이션 · 브랜드 담당자 연락 (알림 미발송 — 직접 연락 필요)',
    ]);
  });
  it('알림 탭(서버): 시뮬레이션 알림 이력 · "메신저 발송 완료" 대신 서버 발송 기록 · 미리보기 표기', async () => {
    storeState = mkState({ incidents: [weekdayP2, ...base.slice(0, 6)] });
    const s = await render('NotifyTab', 'pm');
    expect(s.html).toContain('알림 이력 · 서버 발송 기록');
    expect(s.html).not.toContain('메신저 발송 완료');
    expect(s.html).not.toContain('조치 공유');
    expect(s.html).toContain('P1 · P2 처리 현황 (요약 · 메신저 발송 결과는 알림 이력)');
    expect(s.html).toContain('미리보기 — 이 요약 메일은 아직 보내지 않았습니다');
    // 데모: 기존 화면 그대로
    const d = await render('NotifyTab', 'demo');
    expect(d.html).toContain('P1 · P2 처리 현황 (메신저 발송 완료 · 요약)');
    expect(d.html).toContain('주입 테스트 포함');
  });
  it('serverLogRows: 실제 발송 결과 · 사유를 그대로 옮긴다', async () => {
    const { serverLogRows, summarizeServerLog } = await import('./serverLog');
    const rows = serverLogRows([
      { id: 2, at: '2026-11-03T08:22:51Z', channelId: 'c1', channelName: '#ops', channelType: 'slack', event: 'incident', refId: weekdayP2.id, severity: 'P2', status: 'failed', attempts: 4, detail: { reason: 'Slack 응답 404 · no_team', isTest: false } },
      { id: 1, at: '2026-11-03T08:22:51Z', channelId: 'c2', channelName: '운영 메일', channelType: 'email', event: 'incident', refId: 'gone', severity: 'P2', status: 'skipped', attempts: 1, detail: { reason: '서버 SMTP가 설정되지 않아 메일을 보내지 않았습니다 (SMTP_HOST)', subject: '[MILDO] P2 …' } },
    ], [weekdayP2]);
    expect(rows[0]).toMatchObject({ channel: '#ops · Slack', statusLabel: '실패 · 4회 시도', tone: 'critical', title: weekdayP2.title, reason: 'Slack 응답 404 · no_team', incidentId: weekdayP2.id, event: '새 이슈' });
    expect(rows[1]).toMatchObject({ channel: '운영 메일 · 이메일', statusLabel: '보내지 않음', incidentId: null, title: '[MILDO] P2 …' });
    expect(summarizeServerLog(rows)).toEqual({ sent: 0, failed: 1, skipped: 1 });
  });
  it('서버 모드 결과 보고 기록에는 "발송"이 없다 (데모는 기존 문구) · 테스트 주입은 실제 발송 기준 문구로 저장', async () => {
    const acted = { ...weekdayP2, status: 'action', sla: { ackAt: kst(NOW - 60_000), actionAt: kst(NOW - 30_000) } } as Incident;
    storeState = mkState({ incidents: [acted] });
    await render('IncidentDrawer', 'pm', { id: acted.id });
    btn('결과 보고').onClick?.({});
    expect(updates.at(-1)?.action).toBe('결과 보고 · 이슈 보고서 작성 (p.49 양식 · 공유는 복사 · .md 내려받기)');
    expect(updates.at(-1)?.action).not.toContain('발송');
    await render('IncidentDrawer', 'demo', { id: acted.id });
    btn('결과 보고').onClick?.({});
    expect(updates.at(-1)?.action).toBe('결과 보고 · 이슈 보고서 발송 (p.49 양식)');

    storeState = mkState({ incidents: [] });
    await render('NotifyTab', 'pm');
    const inject = buttons.find((b) => text(b.children) === '광고 OFF');
    expect(inject).toBeTruthy();
    inject!.onClick?.({});
    expect(added.length).toBeGreaterThan(0);
    for (const i of added) {
      expect(i.timeline[0].action).toBe('테스트 이슈 감지 · 알림은 서버가 켜진 채널로 발송 (결과는 알림 설정 › 발송 이력)');
      expect(i.autoActions.join('\n')).not.toMatch(/^(메신저|메일) (즉시 )?알림 발송 · /m);
    }
  });
});

describe('데이터 기준 시각 — generatedAt의 실제 시 · 분', () => {
  it('헤더 · 규칙 엔진 브리프 · 에이전트가 17:24를 쓰고 17:30을 만들지 않는다 · 데모는 기존 15:30', async () => {
    expect(engine.dataAsOf({ generatedAt: '2026-11-03T17:24:00+09:00', today: '2026-11-03', currentHour: 17 }).label).toBe('11/3(화) 17:24');
    expect(engine.dataAsOf(DEMO).label).toBe('10/31(토) 15:30');
    const v = await render('View', 'pm');
    expect(v.html).toContain('데이터 기준 11/3(화) 17:24');
    expect(v.html).not.toContain('17:30');
    const { issuesBrief } = await import('./briefs');
    expect(issuesBrief(storeState.data, [weekdayP2]).facts[0]).toContain('기준 11/3(화) 17:24 ');
    const { agentKit } = await import('./agent');
    const tool = agentKit.tools({ state: storeState, actions: {} as never, navigate: () => undefined }).find((x) => x.name === 'alert_scan')!;
    expect((await tool.execute({}) as { asOf: string }).asOf).toBe('2026-11-03 17:24');
    const d = await render('View', 'demo');
    expect(d.html).toContain(`데이터 기준 ${engine.dataAsOf(storeState.data).label}`);
  });
});

describe('당번 체계 강제(offHoursMode) — 서버 모드는 감지 당시 배정 기준 (서버 SLA 잡과 같은 목표)', () => {
  it('평일 감지 P2(onDuty=false)는 offHoursMode를 켠 뒤에도 인지 1시간 · 약 29분 남음 · 초과 아님', async () => {
    storeState = mkState({ incidents: [weekdayP2], offHoursMode: true });
    const q = await render('QueueTab', 'pm');
    expect(q.ctx.slaOff).toBe(false);
    const st = engine.slaState(weekdayP2, q.ctx.nowMs, q.ctx.toMs, q.ctx.slaOff);
    expect(st.targets.ack).toBe('1시간');
    expect(st.overdue).toBe(false);
    expect(st.remainingMin!).toBeCloseTo(29 + 33 / 60, 5); // 17:22:51 + 60분 − 17:53:18
    expect(q.html).not.toContain('주말 · 공휴일 당번)');
    expect(q.html).toContain('/ 초과 0</span>');
    const dr = await render('IncidentDrawer', 'pm', { id: weekdayP2.id });
    expect(dr.html).not.toContain('인지 30분 (주말 · 공휴일 당번)');
    expect(dr.html).toContain('인지 1시간');
    // 서버 SLA 잡이 쓰는 기한 계산과 같다
    const { slaDeadlines } = await import('@/modules/notify/message');
    const ack = slaDeadlines(weekdayP2 as never).find((d) => d.stage === 'ack')!;
    expect(st.deadlineMs).toBe(ack.deadlineMs);
  });
  it('당번 배정으로 감지된 이슈(onDuty=true)는 서버 모드에서도 인지 30분', async () => {
    const duty = { ...weekdayP2, id: 'duty:x', onDuty: true } as Incident;
    storeState = mkState({ incidents: [duty], offHoursMode: true });
    const q = await render('QueueTab', 'pm');
    expect(engine.slaState(duty, q.ctx.nowMs, q.ctx.toMs, q.ctx.slaOff).targets.ack).toBe('30분 (주말 · 공휴일 당번)');
  });
  it('데모: 주말 모드 시뮬레이션은 기존대로 열린 이슈 전체에 적용', async () => {
    storeState = mkState({ incidents: [weekdayP2], offHoursMode: true });
    const q = await render('QueueTab', 'demo');
    expect(q.ctx.slaOff).toBe(true);
    expect(q.html).toContain('인지 30분 (주말 · 공휴일 당번)');
  });
});

describe('대량 변경 이슈 제목 — 모듈 한글 · 제품명', () => {
  it("'adpilot' 대신 'AD Pilot' (id · 대상 키는 서버 가드 호환을 위해 그대로)", () => {
    const changes: ChangeRequest[] = Array.from({ length: 11 }, (_, k) => ({
      id: `c${k}`, createdAt: `2026-11-03T14:${String(k).padStart(2, '0')}:00+09:00`, module: 'adpilot', kind: 'bid', target: `kw${k}`, before: 1000, after: 1050, changePct: 5,
      reason: 'r', requestedBy: '이AE', approver: 'AE', status: 'pending', history: [],
    }));
    const [inc] = engine.detectBulkChange(changes, { today: '2026-11-03' });
    expect(inc.title).toBe('AD Pilot 이AE 10분 내 11건 일괄 변경');
    expect(inc.target).toBe('adpilot · 이AE');
    expect(inc.id).toBe('bulk_change:adpilot · 이AE:2026-11-03');
    const gfa = engine.detectBulkChange(changes.map((c) => ({ ...c, module: 'gfa' })), { today: '2026-11-03' })[0];
    expect(gfa.title.startsWith('GFA Control ')).toBe(true);
  });
});
