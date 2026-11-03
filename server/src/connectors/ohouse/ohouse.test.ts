/**
 * 오늘의집 — 공개 판매자 API 근거가 없어 CSV 업로드 전용: 수집 대상 아님(reads 비어 있음) · 연결 확인은 CSV 안내 · 호출해도 네트워크 없음.
 */
import { describe, expect, it } from 'vitest';
import { connector, csvGuide } from './index';
import { fakeCtx, handlerHttp } from '../naver-commerce/sales-testkit';

describe('오늘의집 (CSV 업로드 전용)', () => {
  it('판매 채널 ohouse · 수집 항목 없음 · 자격증명 없음 · 라벨은 데모 예시 카탈로그와 같은 오늘의집', () => {
    expect(connector).toMatchObject({ provider: 'ohouse', kind: 'sales', channel: 'ohouse', verifiedLive: false, label: '오늘의집' });
    expect(connector.capabilities).toEqual({ reads: [], writes: [], intraday: false, maxBackfillDays: 0 });
    expect(connector.credentialFields).toEqual([]);
    expect(connector.credentialsSchema.safeParse({}).success).toBe(true);
    expect(connector.docsUrl).toMatch(/^https:\/\//);
  });

  it('연결 확인은 실패(ok=false)로 CSV 경로와 이유를 안내한다', async () => {
    const http = handlerHttp(() => null);
    const r = await connector.test(fakeCtx({}, {}, http));
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/공개 API 문서가 확인되지 않아/);
    expect(r.message).toMatch(/sales_daily/);
    expect(r.message).toMatch(/ohouse/);
    expect(http.calls).toHaveLength(0);
  });

  it('fetch는 네트워크 없이 안내 경고만 돌려준다 (행 없음)', async () => {
    const http = handlerHttp(() => null);
    const b = await connector.fetch(fakeCtx({}, {}, http), { from: '2026-11-01', to: '2026-11-02' });
    expect(b.salesDaily).toBeUndefined();
    expect(b.warnings).toEqual([{ code: 'csv_only', message: csvGuide.message, detail: { template: 'sales_daily', channel: 'ohouse' } }]);
    expect(http.calls).toHaveLength(0);
    expect(csvGuide.templateUrl).toBe('/api/uploads/templates/sales_daily.csv');
  });
});
