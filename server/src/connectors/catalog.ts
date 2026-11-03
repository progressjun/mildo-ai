/**
 * 커넥터 카탈로그 — GET /api/connectors/catalog (로그인 필요). 레지스트리(CONNECTORS)의 공급자 정의를 화면용으로 내보낸다.
 * verifiedLive=false인 공급자는 화면에 '실계정 연결 전 확인 필요'로 표시된다 (docs/SAAS_SPEC.md §0).
 *
 * 선택 필드
 *   csvOnly : API 수집 항목이 없는 공급자(csv · demo 제외 — 예: 오늘의집)의 CSV 업로드 경로 { template, channel, message }.
 *             이런 공급자는 커넥션을 만들 수 없고(POST /connections → 400 csv_only) 화면은 '연결 추가' 대신 업로드 탭으로 안내한다.
 *   oauth   : 브라우저 승인(인증 코드) 흐름을 지원하는 공급자(카페24) { startLabel, redirectUri } — redirectUri는 공급자 앱에 등록할
 *             콜백 주소(`${APP_URL}/api/oauth/cafe24/callback`, connectors/oauth.ts).
 */
import type { FastifyPluginAsync } from 'fastify';
import { CONNECTORS } from './registry';
import type { ConnectorDef } from './types';
import { csvOnlyGuide, DEFAULT_PRIORITY, sourceKindOf, type CsvOnlyGuide, type SourceKind } from './service';
import { OAUTH_APPS } from './credentials';
import { oauthRedirectUri } from './oauth';

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
  /** 구현 중(수집 · 확인 미지원) 공급자 — reads가 비어 있으면 false */
  available: boolean;
  /** CSV 업로드 전용 공급자의 업로드 경로 */
  csvOnly?: CsvOnlyGuide;
  /** OAuth 인증 코드 흐름 (appUrl을 알 때만 — 라우트 응답) */
  oauth?: { startLabel: string; redirectUri: string };
}

const ORDER: Record<string, number> = { media: 0, sales: 1, other: 2 };

export function catalog(opts: { appUrl?: string } = {}): CatalogProvider[] {
  return Object.values(CONNECTORS)
    .map((d) => {
      const sk = sourceKindOf(d.provider);
      const csvOnly = csvOnlyGuide(d);
      const oauth = OAUTH_APPS[d.provider] && opts.appUrl ? { startLabel: OAUTH_APPS[d.provider].startLabel, redirectUri: oauthRedirectUri(opts.appUrl, d.provider) } : null;
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
        ...(csvOnly ? { csvOnly } : {}),
        ...(oauth ? { oauth } : {}),
      };
    })
    .sort((a, b) => (ORDER[a.kind] - ORDER[b.kind]) || (a.provider === 'demo' ? 1 : b.provider === 'demo' ? -1 : 0));
}

export const catalogRoutes: FastifyPluginAsync = async (app) => {
  app.get('/connectors/catalog', async (req) => {
    req.requireUser();
    return { providers: catalog({ appUrl: app.ctx.config.appUrl }) };
  });
};
