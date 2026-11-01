/**
 * AD Pilot 엔진 (계약 인터페이스) — 입찰 · 예산 조정 후보 생성.
 */
import type { Dataset } from '@/core/types';

export interface BidProposal {
  id: string;
  keywordId: string;
  keyword: string;
  rule: string;
  action: 'bid_up' | 'bid_down' | 'hold' | 'budget_shift' | 'test_candidate';
  before: number;
  after: number;
  changePct: number;
  reason: string;
  expected: string;
  guard: string[];
}

export function generateBidProposals(_data: Dataset): BidProposal[] {
  return [];
}
