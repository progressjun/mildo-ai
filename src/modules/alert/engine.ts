/**
 * MILDO Alert 탐지 엔진 (계약 인터페이스).
 * Shell이 앱 시작 시 detectIncidents(data)를 호출해 이슈를 스토어에 넣는다.
 * 같은 이슈는 항상 같은 id를 가져야 한다 (ruleId + 대상 + 기준일시).
 */
import type { Dataset, Incident } from '@/core/types';

export function detectIncidents(_data: Dataset): Incident[] {
  return [];
}
