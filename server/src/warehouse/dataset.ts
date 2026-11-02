/**
 * Dataset 빌더 계약 — 웨어하우스 → 프런트 Dataset(src/core/types.ts). data 도메인이 구현한다.
 * changes · alerts · reports · impact 도메인은 이 함수로 엔진 입력을 만든다.
 */
import type { Queryable } from '../db/pool';
import type { Dataset } from '@/core/types';

export interface BuildDatasetOptions {
  /** 기준일 (KST, 기본 오늘) */
  today?: string;
  /** 기준 시각 (KST 0~23, 기본 현재) */
  hour?: number;
  /** 일별 데이터 기간 (기본 120일) */
  days?: number;
}

export async function buildDataset(_q: Queryable, _workspaceId: string, _opts: BuildDatasetOptions = {}): Promise<Dataset> {
  throw new Error('buildDataset: data 도메인 구현 예정');
}
