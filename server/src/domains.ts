/**
 * 도메인 등록 목록 — 코어 소유. 도메인은 각자 server/src/<domain>/index.ts의 routes · jobs만 채운다.
 */
import type { FastifyInstance } from 'fastify';
import { registerJob, type JobHandler } from './jobs/queue';
import { registerSchedule, type ScheduleFn } from './jobs/scheduler';
import * as team from './team';
import * as connectors from './connectors';
import * as ingest from './ingest';
import * as warehouse from './warehouse';
import * as changes from './changes';
import * as alerts from './alerts';
import * as reports from './reports';
import * as impact from './impact';
import * as ai from './ai';
import * as settings from './settings';
import * as state from './state';

export interface JobRegistry {
  job(type: string, handler: JobHandler): void;
  schedule(name: string, cron: string, fn: ScheduleFn): void;
}

export const DOMAINS = { team, connectors, ingest, warehouse, changes, alerts, reports, impact, ai, settings, state } as const;

let jobsRegistered = false;
/** 워커 · 테스트에서 한 번 호출 */
export function registerAllJobs(): void {
  if (jobsRegistered) return;
  jobsRegistered = true;
  const reg: JobRegistry = { job: registerJob, schedule: registerSchedule };
  for (const d of Object.values(DOMAINS)) d.jobs(reg);
}

export async function registerAllRoutes(app: FastifyInstance): Promise<void> {
  for (const d of Object.values(DOMAINS)) await app.register(d.routes, { prefix: '/api' });
}
