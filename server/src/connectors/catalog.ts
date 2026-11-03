/**
 * 커넥터 카탈로그 — GET /api/connectors/catalog (로그인 필요). 레지스트리(CONNECTORS)의 공급자 정의를 화면용으로 내보낸다.
 * verifiedLive=false인 공급자는 화면에 '실계정 연결 전 확인 필요'로 표시된다 (docs/SAAS_SPEC.md §0).
 */
import type { FastifyPluginAsync } from 'fastify';
import { CONNECTORS } from './registry';
import type { ConnectorDef } from './types';
import { DEFAULT_PRIORITY, sourceKindOf, type SourceKind } from './service';

export interface CatalogProvider {
  provider: string;
  kind: ConnectorDef['kind'];
  channel: string | null;
  label: string;
  docsUrl: string;
  verifiedLive: boolean;
  credentialFields: ConnectorDef['credentialFields'];
  capabilities: ConnectorDef['capabilities'];
  sourceKind: SourceKind;
  defaultPriority: number;
  /** 구현 중(수집 · 확인 미지원) 공급자 — reads가 비어 있으면 true */
  available: boolean;
}

const ORDER: Record<string, number> = { media: 0, sales: 1, other: 2 };

export function catalog(): CatalogProvider[] {
  return Object.values(CONNECTORS)
    .map((d) => {
      const sk = sourceKindOf(d.provider);
      return {
        provider: d.provider,
        kind: d.kind,
        channel: d.channel,
        label: d.label,
        docsUrl: d.docsUrl,
        verifiedLive: d.verifiedLive,
        credentialFields: d.credentialFields.map((f) => ({ ...f })),
        capabilities: { ...d.capabilities, reads: [...d.capabilities.reads], writes: [...d.capabilities.writes] },
        sourceKind: sk,
        defaultPriority: DEFAULT_PRIORITY[sk],
        available: d.capabilities.reads.length > 0,
      };
    })
    .sort((a, b) => (ORDER[a.kind] - ORDER[b.kind]) || (a.provider === 'demo' ? 1 : b.provider === 'demo' ? -1 : 0));
}

export const catalogRoutes: FastifyPluginAsync = async (app) => {
  app.get('/connectors/catalog', async (req) => {
    req.requireUser();
    return { providers: catalog() };
  });
};
