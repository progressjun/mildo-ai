/** 감사 로그 화면 렌더 (SSR) — 데모 예시 · 서버 모드 표 · 더 보기 · 권한 없음 · 상세 드로어(JSON) · 확인 중 */
import { beforeAll, describe, expect, it } from 'vitest';
import { createElement as h, type ComponentType, type ReactNode } from 'react';
import { renderToString } from 'react-dom/server';
import { demoAuditEntries } from './demo';
import type { AuditScreenProps } from './View';

const mem: Record<string, string> = {};
beforeAll(() => {
  (globalThis as unknown as { localStorage: Storage }).localStorage = {
    getItem: (k: string) => mem[k] ?? null,
    setItem: (k: string, v: string) => { mem[k] = v; },
    removeItem: (k: string) => { delete mem[k]; },
    clear: () => undefined, key: () => null, length: 0,
  } as Storage;
});
async function wrap(node: ReactNode): Promise<string> {
  const { StoreProvider } = await import('@/core/store');
  return renderToString(h(StoreProvider, null, node)).replace(/<!-- -->/g, '');
}
const NOW = Date.parse('2026-11-02T03:00:00Z');
const noop = () => undefined;

async function screen(extra: Partial<AuditScreenProps> = {}) {
  const { AuditScreen } = await import('./View');
  return wrap(h(AuditScreen, {
    mode: 'server', workspaceName: '수면밀도 퍼포먼스', entries: demoAuditEntries(NOW), hasMore: true, loading: false, error: null, filters: {},
    users: [{ id: 'demo-pm', name: '김PM', email: 'pm@example.com' }], seenActions: ['invite.create'], onApply: noop, onMore: noop, onCsv: noop, csvBusy: false, ...extra,
  }));
}

describe('감사 로그 화면', () => {
  it('데모 모드: 예시 안내 · TEST DATA · 필터 · 표 · 예시 CSV', async () => {
    const View = (await import('./View')).default as ComponentType;
    const html = await wrap(h(View));
    for (const s of ['감사 로그', '예시 화면', 'TEST DATA', '작업 (접두어)', '사용자', '시작일 (KST)', '종료일 (KST, 포함)', '구성원 로그인', '변경 요청 생성', '실반영', 'CSV 내려받기 (예시)', '보안 확인 대상', '로그인 실패', '예시 기록 안에서만 동작']) {
      expect(html, s).toContain(s);
    }
    expect(html).not.toMatch(/NaN|undefined|Infinity/);
    // 감사 화면은 데모에서도 필터 · CSV가 동작하므로 '조작 버튼이 꺼져 있다'고 안내하지 않는다
    expect(html).not.toContain('조작 버튼이 꺼져 있습니다');
  }, 30_000);

  it('서버 모드: LIVE · 작업 설명과 코드 · 더 보기 · CSV 버튼', async () => {
    const html = await screen();
    expect(html).toContain('LIVE');
    expect(html).not.toContain('예시 화면');
    expect(html).toContain('member.role_change');
    expect(html).toContain('역할 변경');
    expect(html).toContain('이전 기록 100건 더 보기');
    expect(html).toContain('CSV 내려받기');
    expect(html).toContain('18+');
    expect(html).toContain('<datalist id="audit-action-list">');
    expect(html).toContain('김PM · pm@example.com');
  });

  it('마지막 페이지 · 빈 결과 · 오류 · 권한 없음', async () => {
    expect(await screen({ hasMore: false })).toContain('마지막 기록까지 표시했습니다');
    expect(await screen({ entries: [], hasMore: false, filters: { action: 'zzz.' } })).toContain('조건에 맞는 기록이 없습니다');
    expect(await screen({ error: '서버 오류' })).toContain('감사 로그를 불러오지 못했습니다');
    const denied = await screen({ denied: true, entries: null });
    expect(denied).toContain('PM · 관리자 · 소유자만 볼 수 있습니다');
    expect(denied).not.toContain('이전 기록 100건 더 보기');
  });

  it('상세 드로어: 메타 · JSON · 가림 안내', async () => {
    const { AuditDrawer } = await import('./View');
    const entry = demoAuditEntries(NOW).find((e) => e.action === 'connection.write_mode')!;
    const html = await wrap(h(AuditDrawer, { entry, onClose: noop }));
    for (const s of ['쓰기 모드 변경', 'connection.write_mode', '보안 확인 대상', '&quot;to&quot;: &quot;live&quot;', '••••', 'JSON 복사', '저장하기 전에 ••••로 가렸고']) expect(html, s).toContain(s);
  });

  it('서버 모드 확인 중 · 워크스페이스 없음', async () => {
    const { SaasTestProvider } = await import('@/saas/context');
    const View = (await import('./View')).default as ComponentType;
    expect(await wrap(h(SaasTestProvider, { value: { mode: 'checking' }, children: h(View) }))).toContain('서버 연결을 확인하는 중입니다');
    expect(await wrap(h(SaasTestProvider, { value: { mode: 'server', workspace: null }, children: h(View) }))).toContain('워크스페이스가 없습니다');
  });
});
