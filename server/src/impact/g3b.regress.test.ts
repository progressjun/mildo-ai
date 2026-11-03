/**
 * QA 회귀 (G3b · impact) — 장부 라벨이 종류어를 두 번 쓰지 않는다
 * ('수면밀도 입찰가 입찰가 270 → 280' · '… 일 예산 (naver_gfa) 일 예산 …'). 대상 이름은 AD Pilot · Flow · GFA 화면이 만든 형식 그대로.
 */
import { describe, expect, it } from 'vitest';
import { changeLabel, tidyLedgerLabel, toEntry, type LedgerRow } from './measure';

describe('장부 변경 라벨', () => {
  it('대상 이름이 이미 종류어로 끝나면 한 번만 쓴다', () => {
    expect(changeLabel('수면밀도 입찰가', 'bid', 270, 280)).toBe('수면밀도 입찰가 270 → 280');
    expect(changeLabel('밀도 매트리스 입찰가', 'bid', 260, 250)).toBe('밀도 매트리스 입찰가 260 → 250');
    expect(changeLabel('SA_일반 제품 일 예산', 'budget', 2_000_000, 2_500_000)).toBe('SA_일반 제품 일 예산 2,000,000 → 2,500,000');
    expect(changeLabel('GFA_Prospecting 일 예산', 'budget', 1_200_000, 1_260_000, 'naver_gfa')).toBe('GFA_Prospecting (naver_gfa) 일 예산 1,200,000 → 1,260,000');
    // 종류어가 없는 대상은 붙인다 (기존 동작)
    expect(changeLabel('키워드 kw1', 'bid', 700, 800)).toBe('키워드 kw1 입찰가 700 → 800');
    expect(changeLabel('GFA 리타겟팅', 'budget', 1, 2, 'naver_gfa')).toBe('GFA 리타겟팅 (naver_gfa) 일 예산 1 → 2');
  });

  it('이전 측정이 저장한 중복 라벨은 읽을 때 바로잡는다 (장부 화면 · CSV · 가치 리포트가 같은 값을 쓴다)', () => {
    expect(tidyLedgerLabel('수면밀도 입찰가 입찰가 270 → 280')).toBe('수면밀도 입찰가 270 → 280');
    expect(tidyLedgerLabel('GFA_Prospecting 일 예산 (naver_gfa) 일 예산 1,200,000 → 1,260,000')).toBe('GFA_Prospecting (naver_gfa) 일 예산 1,200,000 → 1,260,000');
    expect(tidyLedgerLabel('키워드 kw1 입찰가 700 → 800')).toBe('키워드 kw1 입찰가 700 → 800');
    const row = { id: '1', source_type: 'change', source_id: 'c', label: '밀도 매트리스 입찰가 입찰가 260 → 250', occurred_at: '2026-10-13T01:00:00.000Z', window_days: 7, status: 'pending', baseline: null, observed: null, control: null, estimate: null, measured_at: null, month: '2026-10', detail: {} } as LedgerRow;
    expect(toEntry(row).label).toBe('밀도 매트리스 입찰가 260 → 250');
    // 변경이 아닌 행은 손대지 않는다
    expect(toEntry({ ...row, source_type: 'incident', label: 'P1 입찰가 입찰가 이슈' }).label).toBe('P1 입찰가 입찰가 이슈');
  });
});
