/**
 * 데이터 연결 화면 렌더 스모크 (SSR) — 데모 모드 첫 화면(서버 연결 안내 · TEST DATA · 예시 커넥션)과
 * 서버 모드 부품(권한별 버튼 · 비밀값 입력 · live 2단계 확인 · 카탈로그 미검증 표시 · 업로드 · 실행 상세)이 예외 없이 그려지는지.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { createElement as h, type ReactNode } from 'react';
import { renderToString } from 'react-dom/server';
import { DEMO } from '@/data/demo';
import { exampleState } from './demoState';

const mem: Record<string, string> = {};
beforeAll(() => {
  (globalThis as unknown as { localStorage: Storage }).localStorage = {
    getItem: (k: string) => mem[k] ?? null, setItem: (k: string, v: string) => { mem[k] = v; }, removeItem: (k: string) => { delete mem[k]; },
    clear: () => undefined, key: () => null, length: 0,
  } as Storage;
});
async function wrap(node: ReactNode): Promise<string> {
  const { StoreProvider } = await import('@/core/store');
  return renderToString(h(StoreProvider, null, node)).replace(/<!-- -->/g, '');
}
/** 버튼 텍스트로 찾아 disabled 여부 */
function buttonDisabled(html: string, text: string): boolean | null {
  const re = /<button([^>]*)>((?:(?!<\/button>).)*)<\/button>/gs;
  for (const m of html.matchAll(re)) if (m[2].replace(/<[^>]+>/g, '').includes(text)) return /\sdisabled(=""|\s|>|$)/.test(m[1]);
  return null;
}
const ex = exampleState(DEMO);

describe('데이터 연결 화면', () => {
  it('데모 모드: 서버 연결 안내 · TEST DATA · 예시 커넥션 · 읽기 전용 버튼', async () => {
    const { default: View } = await import('./View');
    const html = await wrap(h(View));
    expect(html).toContain('서버 연결 시 실제로 동작합니다');
    expect(html).toContain('TEST DATA');
    expect(html).toContain('데모 데이터 (TEST DATA)');
    expect(html).toContain('네이버 검색광고 (본계정)');
    expect(html).toContain('연결 확인 필요');
    expect(html).toContain('실계정 연결 전 확인 필요');
    expect(html).toContain('GFA 보고서 업로드');
    expect(html).toContain('출처 우선순위');
    expect(buttonDisabled(html, '지금 수집')).toBe(true);
    expect(html).not.toMatch(/NaN|undefined|Infinity/);
  });

  it('서버 모드: 데모 안내 · 예시 커넥션 없이 서버 상태로 그린다 (불러오기 전 빈 목록 · 새로 고침), 워크스페이스 없으면 안내', async () => {
    const { default: View } = await import('./View');
    const { SaasTestProvider } = await import('@/saas/context');
    const ws = { id: 'ws-1', slug: 'sumyeon', name: '수면밀도', brand_name: '수면밀도', status: 'active', role: 'ae' as const, permissions: ['read', 'operate'] as never, demoRole: '담당 AE' as const };
    const html = await wrap(h(SaasTestProvider, { value: { mode: 'server', workspace: ws, role: 'ae', can: (p: string) => p === 'read' || p === 'operate' }, children: h(View) }));
    expect(html).not.toContain('서버 연결 시 실제로 동작합니다');
    expect(html).not.toContain('네이버 검색광고 (본계정)'); // 예시 커넥션이 섞이지 않는다
    expect(html).toContain('새로 고침');
    expect(html).toContain('아직 연결된 데이터가 없습니다');
    expect(html).not.toMatch(/NaN|undefined|Infinity/);
    const none = await wrap(h(SaasTestProvider, { value: { mode: 'server', workspace: null }, children: h(View) }));
    expect(none).toContain('워크스페이스를 고르세요');
    const { SERVER_EVENTS } = await import('./useConnections');
    expect([...SERVER_EVENTS]).toEqual(['connection', 'dataset']);
  });

  it('커넥션 카드 권한: ae는 수집만, pm은 설정 · 확인, live는 live_write 없으면 안내', async () => {
    const { ConnectionCard } = await import('./parts');
    const c = { ...ex.connections[1], status: 'active' as const, lastSyncAt: `${DEMO.today}T07:00:00+09:00`, lastTestAt: `${DEMO.today}T06:00:00+09:00` };
    const noop = () => undefined;
    const card = (perms: { configure: boolean; operate: boolean; liveWrite: boolean }) => wrap(h(ConnectionCard, { c, nowMs: ex.nowMs, perms, readOnly: false, onTest: noop, onSync: noop, onEdit: noop, onDelete: noop, onWriteMode: noop, onToggle: noop }));
    const ae = await card({ configure: false, operate: true, liveWrite: false });
    expect(buttonDisabled(ae, '지금 수집')).toBe(false);
    expect(buttonDisabled(ae, '연결 확인')).toBe(true);
    expect(buttonDisabled(ae, '설정')).toBe(true);
    expect(ae).toContain('live는 관리자 · 소유자만');
    const pm = await card({ configure: true, operate: true, liveWrite: false });
    expect(buttonDisabled(pm, '연결 확인')).toBe(false);
    expect(buttonDisabled(pm, '삭제')).toBe(false);
    const admin = await card({ configure: true, operate: true, liveWrite: true });
    expect(admin).not.toContain('live는 관리자 · 소유자만');
    expect(admin).toContain('반영 가능: 입찰가 · 일 예산 · ON/OFF');
    expect(admin).toContain('정상');
  });

  it('연결 폼: 비밀값은 password 입력 · 값을 다시 채우지 않음 · 저장됨 안내', async () => {
    const { ConnectionFormModal } = await import('./parts');
    const p = ex.catalog.find((x) => x.provider === 'naver_sa')!;
    const initial = { ...ex.connections[1], credentials: { apiKey: '••••••••(24자)', secretKey: '••••••••(40자)', customerId: '1234567' } };
    const html = await wrap(h(ConnectionFormModal, { provider: p, initial, editing: true, saving: false, error: null, onClose: () => undefined, onSubmit: () => undefined }));
    expect(html.match(/type="password"/g)).toHaveLength(2);
    expect(html).toContain('autoComplete="new-password"');
    expect(html).toContain('저장됨 ••••••••(24자)');
    expect(html).toMatch(/id="conn-cred-customerId"[^>]*value="1234567"/);
    expect(html).not.toMatch(/id="conn-cred-apiKey"[^>]*value="[^"]+"/);
    expect(html).toContain('실계정 연결 전 확인 필요');
  });

  it('live 2단계 확인 · 카탈로그 카드 · 실행 상세 · 업로드 패널(데모)', async () => {
    const { LiveConfirmModal, CatalogCard, RunDrawer, SyncModal } = await import('./parts');
    const { UploadPanel } = await import('./UploadPanel');
    const live = await wrap(h(LiveConfirmModal, { c: ex.connections[1], saving: false, error: null, onClose: () => undefined, onConfirm: () => undefined }));
    expect(live).toContain('승인된 변경이 매체에 실제로 반영됩니다');
    expect(live).toContain('실계정 연결 전 확인 필요');
    const cat = await wrap(h(CatalogCard, { p: ex.catalog[0], readOnly: false, canAdd: false, exists: false, onAdd: () => undefined }));
    expect(cat).toContain('실계정 연결 전 확인 필요');
    expect(cat).toContain('공식 문서');
    expect(buttonDisabled(cat, '연결 추가')).toBe(true);
    const drawer = await wrap(h(RunDrawer, { r: ex.runs[2], onClose: () => undefined }));
    expect(drawer).toContain('형식 오류로 제외한 행');
    expect(drawer).toContain('일부 제외');
    const sync = await wrap(h(SyncModal, { c: ex.connections[0], today: DEMO.today, saving: false, error: null, onClose: () => undefined, onSubmit: () => undefined }));
    expect(sync).toContain('어제 포함 3일');
    const up = await wrap(h(UploadPanel, { server: false, workspaceId: null, canOperate: true, canConfigure: false, csvConnections: [], uploads: ex.uploads, onImported: () => undefined }));
    expect(up).toContain('템플릿 받기');
    expect(up).toContain('데모 모드: 미리보기는 이 브라우저 안에서만');
    expect(buttonDisabled(up, '가져오기')).toBe(true);
    expect(up).toContain('GFA_일별보고서_10월.csv');
  });
});
