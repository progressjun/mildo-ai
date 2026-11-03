/** 데이터 연결 모델: 출처 표시 · 지연 판정 · 커넥션 판정 · 기간 검증 · 시각 · 인코딩 감지 · 예시 상태 */
import { describe, expect, it } from 'vitest';
import { connectionVerdict, decodeCsvBytes, fmtStamp, ago, sourceModeOf, staleSources, validateSyncRange, syncBounds, type ConnectionView } from './model';
import { exampleState } from './demoState';
import { DEMO } from '@/data/demo';

const NOW = Date.parse('2026-11-02T15:30:00+09:00');
const conn = (p: Partial<ConnectionView>): ConnectionView => ({
  id: 'c', provider: 'naver_sa', providerLabel: '네이버 검색광고', kind: 'media', channel: 'naver_sa', label: 'SA', status: 'active', writeMode: 'dry_run', priority: 100,
  sourceKind: 'api', source: 'c', settings: {}, credentials: {}, hasCredentials: true, verifiedLive: false, docsUrl: '', capabilities: { reads: ['mediaDaily'], writes: ['bid'], intraday: true, maxBackfillDays: 400 },
  lastTestAt: null, lastSyncAt: '2026-11-02T15:10:00+09:00', lastError: null, createdAt: null, updatedAt: null, pendingJobs: 0, lastRun: null, ...p,
});

describe('데이터 연결 모델', () => {
  it('Dataset 출처: 메타 없음 = TEST DATA, demo · mixed · live', () => {
    expect(sourceModeOf(undefined)).toMatchObject({ mode: 'demo', label: 'TEST DATA' });
    const s = (kind: 'api' | 'csv' | 'demo', channel: string) => ({ channel, source: kind, kind, latestDate: '2026-11-01' });
    expect(sourceModeOf({ mode: 'demo', builtAt: '', sources: [s('demo', 'naver_sa')] }).label).toBe('TEST DATA');
    const mixed = sourceModeOf({ mode: 'mixed', builtAt: '', sources: [s('api', 'google'), s('demo', 'meta')] });
    expect(mixed).toMatchObject({ mode: 'mixed', label: '일부 LIVE' });
    expect(mixed.basis).toBe('실데이터 Google / 데모 Meta');
    expect(sourceModeOf({ mode: 'live', builtAt: '', sources: [s('csv', 'brandstore')] }).basis).toBe('실데이터 네이버 브랜드스토어');
  });

  it('어제 데이터가 없는 출처 = 지연', () => {
    const meta = { mode: 'live' as const, builtAt: '', sources: [
      { channel: 'google', source: 'a', kind: 'api' as const, latestDate: '2026-11-01' },
      { channel: 'meta', source: 'b', kind: 'api' as const, latestDate: '2026-10-29' },
      { channel: 'brand_search', source: 'b', kind: 'api' as const, latestDate: '2026-10-01' },
    ] };
    expect(staleSources(meta, '2026-11-02').map((s) => s.channel)).toEqual(['meta']);
  });

  it('커넥션 판정은 기준값을 함께 돌려준다', () => {
    expect(connectionVerdict(conn({}), NOW)).toMatchObject({ tone: 'good', label: '정상', basis: '마지막 수집 20분 전 · 기준 26시간 이내' });
    expect(connectionVerdict(conn({ lastSyncAt: '2026-11-01T10:00:00+09:00' }), NOW)).toMatchObject({ tone: 'warning', label: '수집 지연', basis: '마지막 수집 29시간 전 (기준 26시간)' });
    expect(connectionVerdict(conn({ status: 'error', lastError: '토큰 만료' }), NOW)).toMatchObject({ tone: 'critical', basis: '토큰 만료' });
    expect(connectionVerdict(conn({ status: 'pending' }), NOW).label).toBe('연결 확인 필요');
    expect(connectionVerdict(conn({ lastSyncAt: null, pendingJobs: 2 }), NOW).basis).toBe('수집 대기열 등록됨');
    expect(connectionVerdict(conn({ lastRun: { id: 'r', job: 'daily', status: 'partial', rowsIn: 3, rowsWritten: 2, issueCounts: { error: 1, warning: 0, info: 0 }, error: null, rangeFrom: null, rangeTo: null, startedAt: null, finishedAt: null } }), NOW).label).toBe('일부 행 제외');
  });

  it('기간 수집 검증: 미래 · 순서 · 보관 한도', () => {
    const cap = { reads: [], writes: [], intraday: false, maxBackfillDays: 90 };
    expect(syncBounds('2026-11-02', cap)).toEqual({ min: '2026-08-04', max: '2026-11-02', maxDays: 90 });
    expect(validateSyncRange('2026-10-01', '2026-10-31', '2026-11-02', cap)).toBeNull();
    expect(validateSyncRange('2026-10-31', '2026-10-01', '2026-11-02', cap)).toMatch(/늦습니다/);
    expect(validateSyncRange('2026-11-01', '2026-11-03', '2026-11-02', cap)).toMatch(/미래/);
    expect(validateSyncRange('2026-07-01', '2026-07-31', '2026-11-02', cap)).toMatch(/최근 90일/);
    expect(validateSyncRange('2026-10-01', '2026-10-02', '2026-11-02', { ...cap, maxBackfillDays: 0 })).toMatch(/지원하지 않습니다/);
    expect(validateSyncRange('2026/10/01', '2026-10-02', '2026-11-02', cap)).toMatch(/YYYY-MM-DD/);
  });

  it('시각 표시는 KST, 경과 시간', () => {
    expect(fmtStamp('2026-11-01T22:05:00Z')).toBe('11.02 07:05');
    expect(fmtStamp(null)).toBe('—');
    expect(ago('2026-11-02T15:29:30+09:00', NOW)).toBe('방금');
    expect(ago('2026-10-30T15:30:00+09:00', NOW)).toBe('3일 전');
  });

  it('CSV 인코딩: UTF-8 우선, 엑셀 한글(EUC-KR) 자동 감지', () => {
    expect(decodeCsvBytes(new TextEncoder().encode('일자,광고비').buffer as ArrayBuffer)).toEqual({ text: '일자,광고비', encoding: 'utf-8' });
    expect(decodeCsvBytes(new Uint8Array([192, 207, 192, 218, 44, 177, 164, 176, 237, 186, 241]).buffer)).toEqual({ text: '일자,광고비', encoding: 'euc-kr' });
  });

  it('예시 상태(데모 모드)는 데모 기준일에 맞춰 만들고 TEST DATA 출처를 포함한다', () => {
    const ex = exampleState(DEMO);
    expect(ex.connections.map((c) => c.sourceKind)).toEqual(['demo', 'api', 'csv']);
    expect(ex.connections[0].lastSyncAt).toBe(`${DEMO.today}T15:10:00+09:00`);
    expect(ex.catalog.find((c) => c.provider === 'naver_sa')!.credentialFields.filter((f) => f.secret).map((f) => f.key)).toEqual(['apiKey', 'secretKey']);
    expect(ex.quality.some((q) => q.severity === 'error')).toBe(true);
    expect(ex.catalog.every((c) => c.verifiedLive === false)).toBe(true);
  });
});
