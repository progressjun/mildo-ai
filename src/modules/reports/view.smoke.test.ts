/**
 * 화면 렌더 스모크 테스트 (SSR) — 리포트 4종 · 시간표 · 절감 탭이 데모 데이터와 빈 데이터에서 예외 없이 렌더되고,
 * 데모 시나리오 문구가 화면에 실제로 나타나는지 확인한다.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { createElement as h, type ComponentType, type ReactNode } from 'react';
import { renderToString } from 'react-dom/server';
import type { Dataset } from '@/core/types';
import { DEMO } from '@/data/demo';
import { detectIncidents } from '@/modules/alert/engine';
import { generateReport, type IssueLike, type ReportType } from './engine';
import { REPORT_TYPES } from './data';

const mem: Record<string, string> = {};
beforeAll(() => {
  (globalThis as unknown as { localStorage: Storage }).localStorage = {
    getItem: (k: string) => mem[k] ?? null,
    setItem: (k: string, v: string) => { mem[k] = v; },
    removeItem: (k: string) => { delete mem[k]; },
    clear: () => undefined, key: () => null, length: 0,
  } as Storage;
});

const empty: Dataset = {
  generatedAt: '2026-10-31T15:30:00+09:00', today: '2026-10-31', currentHour: 15, dates: [],
  mediaDaily: [], mediaHourly: [], salesDaily: [], keywords: [], campaigns: [], accounts: [], searchTerms: [], products: [], promotions: [], brandSearchDaily: [],
};
const INCIDENTS = detectIncidents(DEMO) as IssueLike[];

async function wrap(node: ReactNode): Promise<string> {
  const { StoreProvider } = await import('@/core/store');
  return renderToString(h(StoreProvider, null, node)).replace(/<!-- -->/g, '');
}

describe('리포트 화면 렌더', () => {
  it('View: 첫 화면은 일간 리포트 · 발송 현황 4종 · TEST DATA 표기', async () => {
    const View = (await import('./View')).default as ComponentType;
    const html = await wrap(h(View));
    expect(html).toContain('리포트 · 데이터 시간표');
    expect(html).toContain('TEST DATA');
    expect(html).toContain('10/31(토) 08:00 발송 완료');
    expect(html).toContain('일간 리포트 · 10/30(금) 성과');
    expect(html).toContain('네이버 GFA');
    expect(html).toContain('킹 매트리스');
    expect(html).toContain('메신저 미리보기');
    expect(html).toContain('담당 AE 해석 · 다음 액션');
    // 발송 현황 카드 — 주기 · 채널은 제안서 p.17 기준 표기
    expect(html).toMatch(/리포트 4종 발송 현황[\s\S]*?제안서 p\.17/);
    // 광고비 증감은 색 없는 중립 표기
    expect(html).toContain('증감 방향만 표시');
    expect(html).not.toMatch(/NaN|undefined/);
  });

  it('View: Alert 이슈 · AE 코멘트 · 섹션 피드백이 있는 실제 운영 상태 (Shell이 시작 시 이슈를 넣는 것과 같은 상태)', async () => {
    mem['mildo-os/v1'] = JSON.stringify({
      incidents: INCIDENTS, role: 'PM',
      comments: [
        { id: 'c1', target: 'reports:daily:media', author: '수면밀도', text: 'GFA는 신규 CPA 기준으로 봐 주세요', at: '2026-10-31T06:00:00.000Z' },
        { id: 'c2', target: 'reports:daily:ae', author: '담당 AE', text: 'GFA 충전 요청 완료 · 17시 재확인', at: '2026-10-31T06:10:00.000Z' },
      ],
    });
    try {
      const View = (await import('./View')).default as ComponentType;
      const html = await wrap(h(View));
      const p1 = INCIDENTS.filter((i) => i.status !== 'resolved' && i.severity === 'P1').length;
      expect(html).toContain(`P1 ${p1}`);
      expect(html).toContain('카카오 전환 추적 단절');
      expect(html).toContain('GFA 충전 요청 완료 · 17시 재확인');
      expect(html).toContain('GFA는 신규 CPA 기준으로 봐 주세요');
      expect(html).toContain('반영 대기');
      expect(html).not.toContain('담당 담당');
      expect(html).not.toMatch(/NaN|undefined/);
    } finally {
      delete mem['mildo-os/v1'];
    }
  });

  it('리포트 4종 렌더: 문서형 + 메신저형 + 코멘트 영역', async () => {
    const { ReportsTab } = await import('./ReportsTab');
    for (const type of REPORT_TYPES as ReportType[]) {
      const report = generateReport(type, DEMO, { incidents: INCIDENTS });
      const html = await wrap(h(ReportsTab, {
        type, report, genMs: 2, month: '2026-10', setMonth: () => undefined, issueId: null, setIssueId: () => undefined,
        interpKey: type, interp: type === 'weekly' ? { text: '### AI 해석\n해석 문단', by: 'rule', at: '2026-10-31T15:30:00+09:00' } : null, setInterp: () => undefined, sendLabel: '발송',
      }));
      expect(html, type).toContain(report.title.replace(/'/g, '&#x27;'));
      expect(html, type).toContain('확정 팩트');
      expect(html, type).toContain('.md 다운로드');
      expect(html, type).not.toMatch(/NaN|undefined/);
      if (type === 'weekly') {
        expect(html).toContain('메일 미리보기');
        expect(html).toContain('해석 문단');
        // 키워드 테스트 판정은 MILDO Lab과 같은 판정 · 배지 옆 기준값
        expect(html).toContain('판정 보류 · 표본 부족 (클릭 20 &lt; 30)');
        expect(html).toContain('확장 · 목표 ROAS 400% 대비');
        expect(html).toContain('MILDO Lab과 같은 판정');
      }
      if (type === 'issue') expect(html).toContain('카카오 전환 추적 단절');
    }
  });

  it('시간표 탭: 토요일 → 이슈 브리핑 다음 영업일 이동 · 14:00 조기 소진 산출물', async () => {
    const { TimetableTab } = await import('./TimetableTab');
    const html = await wrap(h(TimetableTab));
    expect(html).toContain('수면밀도 업무시간');
    expect(html).toContain('11/2(월) 09:30 이동');
    expect(html).toContain('SA_일반 제품');
    expect(html).toContain('현재 15:30');
    // 공휴일 바로가기는 공용 KR_HOLIDAYS에서 데이터 기준일 이후 첫 공휴일
    expect(html).toContain('공휴일 12/25(금) 성탄절');
    expect(html).toContain('운영 가정');
    expect(html).not.toMatch(/NaN|undefined/);
  });

  it('절감 탭: 1,070 → 435분 · −59% · 약 18시간 → 약 7시간 · 하한 40% · 90일 일정', async () => {
    const { SavingsTab, DEFAULT_SAVINGS_INPUTS } = await import('./SavingsTab');
    const html = await wrap(h(SavingsTab, { today: DEMO.today, inputs: DEFAULT_SAVINGS_INPUTS, setInputs: () => undefined }));
    expect(html).toContain('−59%');
    expect(html).toContain('1,070분 → 435분');
    expect(html).toContain('약 18시간 → 약 7시간');
    expect(html).toContain('하한 충족');
    expect(html).toContain('하한 −40% 대비 목표 −59%');
    expect(html).toContain('D+30');
    expect(html).toContain('D+90');
    expect(html).toContain('키워드 확장');
    expect(html).toContain('Kick-off까지 D-31');
    expect(html).toContain('1,070분 · 기존 유지');
    expect(html).toContain('525분 · −51%');
    expect(html).not.toMatch(/NaN|undefined/);
    const edited = await wrap(h(SavingsTab, { today: DEMO.today, inputs: { ...DEFAULT_SAVINGS_INPUTS, mode: 'fixed', before: { '일간 성과 조회·취합': 90, '주간 보고서 작성': 100 }, measured: { '소재·URL·상태 점검': 60 } }, setInputs: () => undefined }));
    expect(edited).toContain('기존 값 수정됨');
    expect(edited).toContain('실측 (1개 업무)');
    expect(edited).not.toMatch(/NaN|undefined/);
  });

  it('월간 선택지 · 입력 id · 출처 태그 · 월별 피드백 분리', async () => {
    const { ReportsTab } = await import('./ReportsTab');
    mem['mildo-os/v1'] = JSON.stringify({ comments: [
      { id: 'm9', target: 'reports:monthly-2026-09:channels', author: '수면밀도', text: '9월 피드백 문구', at: '2026-10-31T06:00:00.000Z' },
      { id: 'm10', target: 'reports:monthly-2026-10:channels', author: '수면밀도', text: '10월 피드백 문구', at: '2026-10-31T06:00:00.000Z' },
    ] });
    try {
      const report = generateReport('monthly', DEMO, { month: '2026-10' });
      const html = await wrap(h(ReportsTab, {
        type: 'monthly', report, genMs: 1, month: '2026-10', setMonth: () => undefined, issueId: null, setIssueId: () => undefined,
        interpKey: 'm', interp: null, setInterp: () => undefined, sendLabel: '발송',
      }));
      expect(html).toContain('10월 (잠정 · 월 마감 전)');
      expect(html).not.toContain('9월 (잠정');
      expect(html).toContain('10월 피드백 문구');
      expect(html).not.toContain('9월 피드백 문구');
      expect(html).toContain('id="reports-ae-note"');
    } finally {
      delete mem['mildo-os/v1'];
    }
    const { SavingsTab, DEFAULT_SAVINGS_INPUTS } = await import('./SavingsTab');
    const sv = await wrap(h(SavingsTab, { today: DEMO.today, inputs: DEFAULT_SAVINGS_INPUTS, setInputs: () => undefined }));
    expect(sv).toContain('id="reports-sv-before-0"');
    expect(sv).toContain('id="reports-sv-measured-0"');
    expect(sv).toContain('id="reports-sv-share-keyword"');
    const { TimetableTab } = await import('./TimetableTab');
    const tt = await wrap(h(TimetableTab));
    expect(tt).toContain('id="reports-tt-date"');
    expect(tt).toMatch(/리포트별 리드타임[\s\S]*?제안서 p\.17 · p\.18/);
  });

  it('이슈 알림: MILDO Alert에 등록된 이슈가 없으면 재탐지 미리보기 + Alert 안내 (대상 이슈 선택 없음)', async () => {
    mem['mildo-os/v1'] = JSON.stringify({ incidents: [], comments: [], changes: [], role: '담당 AE' });
    const { ReportsTab } = await import('./ReportsTab');
    const report = generateReport('issue', DEMO, { incidents: [] });
    const html = await wrap(h(ReportsTab, {
      type: 'issue', report, genMs: 1, month: '2026-10', setMonth: () => undefined, issueId: null, setIssueId: () => undefined,
      interpKey: 'issue', interp: null, setInterp: () => undefined, sendLabel: '감지 즉시',
    }));
    expect(html).toContain('MILDO Alert에 등록된 이슈가 없습니다');
    expect(html).toContain('href="#alert"');
    expect(html).not.toContain('id="reports-issue"');
    expect(html).toContain('카카오');
    expect(html).not.toMatch(/NaN|undefined/);
    delete mem['mildo-os/v1'];
  });

  it('빈 데이터에서도 예외 없음', async () => {
    const { ReportsTab } = await import('./ReportsTab');
    const { SavingsTab, DEFAULT_SAVINGS_INPUTS } = await import('./SavingsTab');
    for (const type of REPORT_TYPES as ReportType[]) {
      const report = generateReport(type, empty, { incidents: [] });
      const html = await wrap(h(ReportsTab, {
        type, report, genMs: 0, month: '2026-10', setMonth: () => undefined, issueId: null, setIssueId: () => undefined,
        interpKey: type, interp: null, setInterp: () => undefined, sendLabel: '—',
      }));
      expect(html.length).toBeGreaterThan(100);
      expect(html, type).not.toMatch(/NaN|undefined/);
    }
    const sv = await wrap(h(SavingsTab, { today: empty.today, inputs: { ...DEFAULT_SAVINGS_INPUTS, kickoff: 'bad' }, setInputs: () => undefined }));
    expect(sv).not.toMatch(/NaN|undefined/);
  });
});
