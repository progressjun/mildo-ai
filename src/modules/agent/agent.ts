import type { ModuleAgentKit } from '../types';
import { RFP } from '@/data/constants';

/** 에이전트 모듈 자체 도구: RFP 원문 기준 조회 */
export const agentKit: ModuleAgentKit = {
  tools: () => [
    {
      name: 'rfp_requirements',
      description: '수면밀도 RFP의 핵심 요구(브랜드 개요, KPI, 예산, 타겟 세그먼트, 경쟁사, 평가 비중, 일정)를 반환한다. 판단이 RFP 요구와 맞는지 확인할 때 호출.',
      execute: () => ({
        brand: RFP.brand, story: RFP.brandStory, kpi: RFP.kpi, annualBudget: RFP.annualBudget, media: RFP.media,
        segments: RFP.segments, competitors: RFP.competitors, evaluation: RFP.evaluation.map((e) => ({ label: e.label, weight: e.weight })),
        schedule: RFP.schedule, judgeCriteria: RFP.judgeCriteria,
      }),
    },
  ],
  briefs: [
    {
      id: 'rfp',
      match: /(RFP|평가|배점|비중|요구|선정 기준|제출)/i,
      build: () => ({
        title: 'RFP 요구 · 평가 기준',
        facts: [
          `연간 예산 약 50억 원(운영 방향에 따라 변동), 운영 매체 네이버(SA/DA) · 카카오 · 구글 · 메타 · 쿠팡 · 오늘의집 외 버티컬. KPI는 매출 증대 및 브랜드 운영 리소스 절감 (RFP).`,
          `선정 기준: ${RFP.evaluation.map((e) => `${e.label} ${e.weight}%`).join(', ')}. 우선 협상은 리소스 절감 자동화 · 운영 안정성 점수가 우선, 동점 시 수수료 (RFP).`,
          `네이버 결제수 기준 상위 세그먼트: ${RFP.segments.map((s) => `${s.label} ${(s.share * 100).toFixed(1)}%`).join(', ')} (RFP).`,
        ],
        patterns: [],
        interpretation: [`평가 비중 45%가 리소스 절감 자동화(25%)와 운영 안정성(20%)에 걸려 있고 동점 처리 기준도 이 두 항목입니다. 라이브 데모 15분은 Board · AD Pilot · Alert · 리포트 · 운영 프로세스 순서로 이 두 항목의 실제 작동을 보여주는 데 배분하는 것이 점수 구조와 맞습니다.`],
        conditions: [`배점 및 세부 채점표는 공개되지 않으므로 위 해석은 공개된 비중과 협상 원칙에만 근거합니다.`],
        counter: [`비용 · 계약 조건(10%)이 동점 처리 기준이므로, 자동화 · 안정성 점수가 비슷한 경쟁사가 있다면 수수료 · 페이백 조건이 최종 결정을 가를 수 있습니다.`],
        actions: [`PM: 전담 TF 실명 · 연차 · 투입률과 수수료 표 빈칸을 제출 마감(11/16 17시) 전 입력 (전담 TF · 온보딩 · 계약 화면).`],
      }),
    },
  ],
};
