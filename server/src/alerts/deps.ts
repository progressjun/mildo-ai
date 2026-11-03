/**
 * alerts 도메인 외부 의존성 — 테스트에서 바꿔 끼운다 (실제 네트워크 · 미구현 Dataset 빌더 대신 가짜).
 *   const restore = setAlertDepsForTest({ buildDataset: async () => DEMO, poster: fakePoster });
 *   afterAll(restore);
 */
import { buildDataset } from '../warehouse/dataset';
import { httpsPoster, type HttpPoster } from './net';

export interface AlertDeps {
  buildDataset: typeof buildDataset;
  poster: HttpPoster;
}

export const deps: AlertDeps = { buildDataset, poster: httpsPoster };

export function setAlertDepsForTest(patch: Partial<AlertDeps>): () => void {
  const prev = { ...deps };
  Object.assign(deps, patch);
  return () => {
    Object.assign(deps, prev);
  };
}
