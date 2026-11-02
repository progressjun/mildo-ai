/** 카페24 자사몰 커넥터 — 구현 예정 (docs/SAAS_SPEC.md §4). 이 export 이름 · 형태를 유지할 것. */
import { z } from 'zod';
import type { ConnectorDef } from '../types';

export const connector: ConnectorDef = {
  provider: 'cafe24',
  kind: 'sales',
  channel: 'own_mall',
  label: '카페24 자사몰',
  docsUrl: '',
  verifiedLive: false,
  credentialsSchema: z.object({}),
  settingsSchema: z.object({}),
  credentialFields: [],
  capabilities: { reads: [], writes: [], intraday: false, maxBackfillDays: 0 },
  async test() {
    return { ok: false, message: '아직 구현되지 않은 커넥터입니다' };
  },
  async fetch() {
    throw new Error('아직 구현되지 않은 커넥터입니다');
  },
};
