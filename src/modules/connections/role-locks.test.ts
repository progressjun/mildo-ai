/**
 * QA 회귀 — 데이터 연결 화면:
 *  - 쓰기 모드(반영 끔 · dry_run · live)는 configure가 없으면 모두 잠기고, pm은 live만 잠긴다 (사유 title · 화면 안내)
 *  - 카드의 설정 · 사용 중지 · 삭제가 잠기면 사유(title)를 보인다
 *  - CSV 전용 공급자(오늘의집) 카탈로그 카드에는 '실계정 연결 전 확인 필요'를 붙이지 않는다
 *  - 업로드 이력: 0행 · 일부 제외는 초록 '가져옴'이 아니다, 사유 보기
 *  - 수집 현황 필터 빈 표 문구 · Dataset 출처 문구 자르기 · 커넥션 삭제 범위 문구
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { createElement as h, type ReactNode } from 'react';
import { renderToString } from 'react-dom/server';
import { DEMO } from '@/data/demo';
import { exampleState } from './demoState';
import { clipList, csvCheckDay, deleteScopeText, kstDateOf, runsEmptyText, uploadImportLock, uploadStatusMeta, type UploadView } from './model';
import { writeModeLock } from './parts';

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
/** 버튼 텍스트로 찾아 { disabled, title } */
function button(html: string, text: string): { disabled: boolean; title: string | null } | null {
  const re = /<button([^>]*)>((?:(?!<\/button>).)*)<\/button>/gs;
  for (const m of html.matchAll(re)) {
    if (m[2].replace(/<[^>]+>/g, '') !== text && !m[2].replace(/<[^>]+>/g, '').includes(text)) continue;
    const title = /\stitle="([^"]*)"/.exec(m[1]);
    return { disabled: /\sdisabled(=""|\s|>|$)/.test(m[1]), title: title ? title[1] : null };
  }
  return null;
}
const ex = exampleState(DEMO);
const noop = () => undefined;
const conn = { ...ex.connections[1], status: 'active' as const, lastSyncAt: `${DEMO.today}T07:00:00+09:00`, lastTestAt: `${DEMO.today}T06:00:00+09:00` };
type Perms = { configure: boolean; operate: boolean; liveWrite: boolean };
const AE: Perms = { configure: false, operate: true, liveWrite: false };
const VIEWER: Perms = { configure: false, operate: false, liveWrite: false };
const PM: Perms = { configure: true, operate: true, liveWrite: false };
const ADMIN: Perms = { configure: true, operate: true, liveWrite: true };

async function card(perms: Perms, readOnly = false, c = conn) {
  const { ConnectionCard } = await import('./parts');
  return wrap(h(ConnectionCard, { c, nowMs: ex.nowMs, perms, readOnly, onTest: noop, onSync: noop, onEdit: noop, onDelete: noop, onWriteMode: noop, onToggle: noop }));
}

describe('쓰기 모드 잠금 (서버 PATCH 판정과 같다)', () => {
  it('configure가 없으면(ae · client · viewer) 세 선택지 모두 잠기고 사유가 보인다', async () => {
    for (const perms of [AE, VIEWER]) {
      const html = await card(perms);
      for (const label of ['반영 끔', 'dry_run', 'live · 실제 반영']) {
        expect(button(html, label), label).toMatchObject({ disabled: true, title: '쓰기 모드는 PM · 관리자 · 소유자만 바꿀 수 있습니다' });
      }
      expect(html).toContain('쓰기 모드 변경은 PM · 관리자 · 소유자만');
      expect(html).not.toContain('live는 관리자 · 소유자만'); // off · dry_run은 된다고 읽히는 안내를 내지 않는다
    }
  });

  it('pm은 반영 끔 · dry_run만, live는 잠기고 live_write 사유 · 안내', async () => {
    const html = await card(PM);
    expect(button(html, '반영 끔')!.disabled).toBe(false);
    expect(button(html, 'dry_run')!.disabled).toBe(false);
    expect(button(html, 'live · 실제 반영')).toMatchObject({ disabled: true, title: '관리자 · 소유자만 live를 켤 수 있습니다 (live_write 권한)' });
    expect(html).toContain('live는 관리자 · 소유자만');
    // 이미 live인 커넥션을 pm이 내리는 것은 된다 (서버도 live 끄기는 configure로 허용)
    expect(writeModeLock('dry_run', 'live', PM, false)).toBeNull();
    expect(writeModeLock('live', 'live', PM, false)).toBeNull();
  });

  it('admin은 모두 누를 수 있고, 데모(읽기 전용)는 서버 연결 안내로 잠긴다', async () => {
    const html = await card(ADMIN);
    for (const label of ['반영 끔', 'dry_run', 'live · 실제 반영']) expect(button(html, label)!.disabled, label).toBe(false);
    const demo = await card(ADMIN, true);
    expect(button(demo, 'live · 실제 반영')).toMatchObject({ disabled: true, title: '서버 연결 시 사용할 수 있습니다' });
  });
});

describe('카드 버튼 잠금 사유', () => {
  it('ae · viewer: 설정 · 사용 중지 · 삭제가 잠기고 사유 title이 있다 (연결 확인과 같은 문구)', async () => {
    for (const perms of [AE, VIEWER]) {
      const html = await card(perms);
      for (const label of ['설정', '사용 중지', '삭제', '연결 확인']) expect(button(html, label), label).toMatchObject({ disabled: true, title: 'PM · 관리자 · 소유자만' });
    }
    const viewer = await card(VIEWER);
    expect(button(viewer, '지금 수집')).toMatchObject({ disabled: true, title: '담당 AE 이상' });
    const pm = await card(PM);
    expect(button(pm, '삭제')).toMatchObject({ disabled: false, title: null });
  });
});

describe('카탈로그 카드', () => {
  it('CSV 전용 공급자(오늘의집)에는 실계정 미검증 표시가 없고, API 공급자에는 있다', async () => {
    const { CatalogCard } = await import('./parts');
    const ohouse = ex.catalog.find((x) => x.provider === 'ohouse')!;
    const server = { ...ohouse, sourceKind: 'api' as const, verifiedLive: false, csvOnly: { template: 'sales_daily', channel: 'ohouse', message: '오늘의집 파트너센터에서 내려받은 일별 판매 실적을 올려 주세요' } };
    const html = await wrap(h(CatalogCard, { p: server, readOnly: false, canAdd: true, exists: false, onAdd: noop, onUpload: noop }));
    expect(html).toContain('CSV 업로드 전용');
    expect(html).not.toContain('실계정 연결 전 확인 필요');
    const sa = await wrap(h(CatalogCard, { p: ex.catalog.find((x) => x.provider === 'naver_sa')!, readOnly: false, canAdd: true, exists: false, onAdd: noop }));
    expect(sa).toContain('실계정 연결 전 확인 필요');
  });
});

describe('업로드 이력 상태', () => {
  const up = (status: UploadView['status'], summary: Record<string, unknown>): UploadView => ({ id: 'u', connectionId: null, template: 'media_daily', filename: 'a.csv', bytes: 1, mapping: {}, channel: null, status, summary, createdAt: null, importedAt: null });
  it('0행 · 일부 제외는 경고 톤(초록 가져옴 아님) + 사유 보기, 정상은 가져옴, 실패는 사유', () => {
    expect(uploadStatusMeta(up('imported', { rowsWritten: 0, records: 0 }))).toMatchObject({ tone: 'warning', label: '가져온 행 없음 · 모두 제외', runFilter: 'partial' });
    expect(uploadStatusMeta(up('imported', { outcome: 'empty', rowsWritten: 0 }))).toMatchObject({ tone: 'warning' });
    expect(uploadStatusMeta(up('imported', { outcome: 'partial', rowsWritten: 12, issueSummary: ['음수 지표가 있는 2행을 제외했습니다'] }))).toMatchObject({ tone: 'warning', label: '일부 제외 · 12행 가져옴', title: '음수 지표가 있는 2행을 제외했습니다' });
    expect(uploadStatusMeta(up('imported', { outcome: 'imported', rowsWritten: 5 }))).toMatchObject({ tone: 'good', label: '가져옴' });
    expect(uploadStatusMeta(up('imported', { records: 30 }))).toMatchObject({ tone: 'good', label: '가져옴' }); // 예전 요약(rowsWritten 없음)
    expect(uploadStatusMeta(up('failed', { error: '가져올 수 있는 행이 없습니다' }))).toMatchObject({ tone: 'critical', runFilter: 'failed' });
    expect(uploadStatusMeta(up('received', {}))).toMatchObject({ tone: 'neutral', label: '가져오는 중' });
  });

  it('업로드 패널 이력: 일부 제외 행에 경고 Pill · 사유 보기 버튼, 실제로 쓴 기간', async () => {
    const { UploadPanel } = await import('./UploadPanel');
    const uploads = [up('imported', { outcome: 'partial', rowsWritten: 1, dateFrom: '2026-10-30', dateTo: '2026-10-30', fileDateFrom: '2026-10-28', fileDateTo: '2026-11-20' })];
    let opened: string | null = null;
    const html = await wrap(h(UploadPanel, { server: true, workspaceId: 'ws', canOperate: true, canConfigure: true, csvConnections: [], uploads, onImported: noop, onShowRuns: (f: string) => { opened = f; } }));
    expect(html).toContain('pill warning');
    expect(html).toContain('일부 제외 · 1행 가져옴');
    expect(html).toContain('2026-10-30 ~ 2026-10-30');
    expect(html).not.toContain('2026-11-20');
    expect(button(html, '사유 보기')).toMatchObject({ disabled: false });
    expect(opened).toBeNull();
    expect(html).toContain('예시 행');
  });
});

describe('가져오기 잠금', () => {
  it('예시 내용(TEST DATA)은 서버 모드에서도 가져오지 않는다 · 권한 · 미리보기 · 오류 사유', () => {
    const ok = { server: true, canOperate: true, isSample: false, serverPreview: true, blocking: 0 };
    expect(uploadImportLock(ok)).toBeNull();
    expect(uploadImportLock({ ...ok, isSample: true })).toContain('예시 내용(TEST DATA)');
    expect(uploadImportLock({ ...ok, canOperate: false })).toBe('담당 AE 이상');
    expect(uploadImportLock({ ...ok, serverPreview: false })).toBe('미리보기를 먼저 누르세요');
    expect(uploadImportLock({ ...ok, blocking: 1 })).toBe('오류를 먼저 해결하세요');
    expect(uploadImportLock({ ...ok, server: false })).toBe('서버 연결 시 가져올 수 있습니다');
  });
});

describe('문구 도우미', () => {
  it('수집 현황 필터 빈 표: 필터 때문에 비었으면 조건 문구, 정말 없으면 기존 문구', () => {
    expect(runsEmptyText(true, 'partial', 9, false)).toBe('불러온 실행 중 조건(일부 제외)에 맞는 실행이 없습니다');
    expect(runsEmptyText(true, 'failed', 9, true)).toContain('더 보기');
    expect(runsEmptyText(true, 'all', 0, false)).toBe('아직 수집 실행이 없습니다');
    expect(runsEmptyText(true, 'partial', 0, false)).toBe('아직 수집 실행이 없습니다');
    expect(runsEmptyText(false, 'all', 0, false)).toBe('예시 실행이 없습니다');
  });

  it('Dataset 출처 문구: 구분자 단위로 자르고 … (끝에 · 가 남지 않는다)', () => {
    const basis = '실데이터 Google / 데모 네이버 SA · 네이버 GFA · Meta · 카카오 · 버티컬 · 신규 · 브랜드스토어 · 오늘의집';
    const cut = clipList(basis, 60);
    expect(cut.endsWith(' …')).toBe(true);
    expect(cut.length).toBeLessThanOrEqual(62);
    expect(cut).not.toMatch(/·\s*…$/);
    expect(basis.startsWith(cut.replace(/ …$/, ''))).toBe(true);
    expect(clipList('실데이터 Google', 60)).toBe('실데이터 Google');
  });

  it('커넥션 삭제 문구: CSV 커넥션은 그 커넥션으로 올린 업로드까지 지운다고 말한다', () => {
    expect(deleteScopeText({ provider: 'csv', sourceKind: 'csv' }, 2)).toContain('이 커넥션으로 올린 업로드 2개와 그 웨어하우스 데이터');
    expect(deleteScopeText({ provider: 'naver_sa', sourceKind: 'api' }, 0)).toContain('이 커넥션으로 수집한 웨어하우스 데이터와 수집 이력');
    expect(deleteScopeText({ provider: 'demo', sourceKind: 'demo' }, 0)).toContain('데모 TEST DATA를 지우면');
  });

  it('CSV 미래 날짜 기준일: 화면 기준일과 실제 오늘(KST) 중 늦은 날', () => {
    const ms = Date.parse('2026-11-03T15:30:00Z'); // KST 11/4 00:30
    expect(kstDateOf(ms)).toBe('2026-11-04');
    expect(csvCheckDay('2026-10-31', ms)).toBe('2026-11-04');
    expect(csvCheckDay('2026-12-01', ms)).toBe('2026-12-01');
  });
});
