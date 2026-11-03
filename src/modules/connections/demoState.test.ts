/**
 * 데모 모드 예시 카탈로그가 서버 커넥터 정의(server/src/connectors/registry.ts)와 어긋나지 않는지.
 * 예시는 서버 정의의 부분 집합이어야 한다 — 서버에 없는 입력 항목 · 수집 · 반영 기능을 화면에 지어내지 않는다.
 * (서버 쪽이 기능을 늘리는 것은 허용: 예시는 서버 연결 전 안내용)
 */
import { describe, expect, it } from 'vitest';
import { DEMO_CATALOG } from './demoState';
import { CONNECTORS } from '../../../server/src/connectors/registry';
import { csvGuide } from '../../../server/src/connectors/ohouse';

describe('예시 카탈로그 ↔ 서버 커넥터 정의', () => {
  it('공급자 목록 · 종류 · 채널 · 이름 · 공식 문서 · 실계정 검증 여부가 같다', () => {
    expect(DEMO_CATALOG.map((p) => p.provider).sort()).toEqual(Object.keys(CONNECTORS).sort());
    for (const p of DEMO_CATALOG) {
      const d = CONNECTORS[p.provider as keyof typeof CONNECTORS];
      expect({ kind: p.kind, channel: p.channel, label: p.label, verifiedLive: p.verifiedLive }, p.provider).toEqual({ kind: d.kind, channel: d.channel, label: d.label, verifiedLive: d.verifiedLive });
      if (p.docsUrl) expect(p.docsUrl, p.provider).toBe(d.docsUrl);
    }
  });

  it('입력 항목 · 수집 · 반영 기능은 서버 정의의 부분 집합 (비밀값 여부 · 라벨 일치)', () => {
    for (const p of DEMO_CATALOG) {
      const d = CONNECTORS[p.provider as keyof typeof CONNECTORS];
      for (const f of p.credentialFields) {
        const real = d.credentialFields.find((x) => x.key === f.key);
        expect(real, `${p.provider}.${f.key}`).toBeTruthy();
        expect({ label: f.label, secret: f.secret, optional: !!f.optional }, `${p.provider}.${f.key}`).toEqual({ label: real!.label, secret: real!.secret, optional: !!real!.optional });
      }
      // 서버의 필수 입력 항목은 예시에서 빠지면 안 된다 (예시 폼으로 연결을 설명할 때 빠진 항목이 없게)
      if (p.credentialFields.length) {
        for (const real of d.credentialFields.filter((x) => !x.optional)) expect(p.credentialFields.some((f) => f.key === real.key), `${p.provider}.${real.key} 필수`).toBe(true);
      }
      for (const r of p.capabilities.reads) expect(d.capabilities.reads, `${p.provider} reads`).toContain(r);
      for (const w of p.capabilities.writes) expect(d.capabilities.writes, `${p.provider} writes`).toContain(w);
      if (p.capabilities.intraday) expect(d.capabilities.intraday, `${p.provider} intraday`).toBe(true);
      expect(p.capabilities.maxBackfillDays, `${p.provider} backfill`).toBeLessThanOrEqual(Math.min(400, d.capabilities.maxBackfillDays));
      if (p.available) expect(d.capabilities.reads.length, `${p.provider} available`).toBeGreaterThan(0);
    }
  });
});

describe('예시 카탈로그 판매 채널 4종 ↔ 서버 커넥터 정의 (같아야 한다)', () => {
  it('네이버 커머스 · 쿠팡 · 카페24: available · 공식 문서 · 입력 항목(도움말 포함) · 기능이 서버 정의 그대로', () => {
    for (const provider of ['naver_commerce', 'coupang', 'cafe24'] as const) {
      const p = DEMO_CATALOG.find((x) => x.provider === provider)!;
      const d = CONNECTORS[provider];
      expect(p.available, provider).toBe(true);
      expect(p.docsUrl, provider).toBe(d.docsUrl);
      expect(p.credentialFields, provider).toEqual(d.credentialFields);
      expect(p.capabilities, provider).toEqual(d.capabilities);
      expect(p.csvOnly, provider).toBeUndefined();
    }
  });

  it('오늘의집: 수집 없음(available false) · 파트너센터 문서 · CSV 전용 경로(서버 csvGuide와 같은 템플릿 · 채널 · 문구)', () => {
    const p = DEMO_CATALOG.find((x) => x.provider === 'ohouse')!;
    expect(p).toMatchObject({ available: false, docsUrl: 'https://partner.ohou.se', credentialFields: [], capabilities: CONNECTORS.ohouse.capabilities });
    expect(p.csvOnly).toEqual({ template: csvGuide.template, channel: csvGuide.channel, message: csvGuide.message });
    // CSV 전용은 오늘의집 하나 (csv · demo 출처는 해당 없음)
    expect(DEMO_CATALOG.filter((x) => x.csvOnly).map((x) => x.provider)).toEqual(['ohouse']);
  });
});
