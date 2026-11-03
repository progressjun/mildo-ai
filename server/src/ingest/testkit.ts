/**
 * data 도메인 서버 테스트 도우미 (테스트 파일에서만 import) — 수집 잡만 등록 · 실행, 가짜 커넥터 설치, 고정 시각.
 * 다른 도메인 잡(alerts.scan 등)은 등록하지 않는다: drainIngest는 수집 잡 타입만 처리한다.
 */
import { _resetJobsForTest, drain, registerJob } from '../jobs/queue';
import { _resetSchedulesForTest, registerSchedule } from '../jobs/scheduler';
import { CONNECTORS } from '../connectors/registry';
import type { ConnectorDef, Provider } from '../connectors/types';
import type { Db } from '../db/pool';
import type { AppConfig } from '../config';
import { registerIngestJobs } from './jobs';

export const INGEST_JOB_TYPES = ['ingest.daily', 'ingest.intraday', 'ingest.backfill', 'ingest.upload'];

export function registerDataJobsForTest(): void {
  _resetJobsForTest();
  _resetSchedulesForTest();
  registerIngestJobs({ job: registerJob, schedule: registerSchedule });
}

export function drainIngest(db: Db, config: AppConfig): Promise<number> {
  return drain(db, config, { types: INGEST_JOB_TYPES });
}

/** 레지스트리의 공급자 하나를 가짜 커넥터로 바꾼다 → 되돌리는 함수 */
export function installConnector(provider: Provider, def: Partial<ConnectorDef>): () => void {
  const prev = CONNECTORS[provider];
  CONNECTORS[provider] = { ...prev, ...def, provider } as ConnectorDef;
  return () => { CONNECTORS[provider] = prev; };
}

/** KST 기준 시각 → epoch ms (예: kst('2026-10-31', 15, 30)) */
export const kst = (date: string, hour = 0, minute = 0) => Date.parse(`${date}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00+09:00`);
