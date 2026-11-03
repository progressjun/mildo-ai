/**
 * 커넥터 계약 (docs/SAAS_SPEC.md §3) — 매체 · 판매 채널 공급자는 server/src/connectors/<provider>/index.ts에서
 * `export const connector: ConnectorDef`를 내보낸다. 커넥터는 DB에 직접 쓰지 않고 NormalizedBatch를 돌려준다.
 */
import type { z } from 'zod';
import type { MediaId, SalesChannelId, Keyword, Campaign, AdAccount, Product, Promotion, ChangeRequest } from '@/core/types';

export type Provider =
  | 'naver_sa' | 'google_ads' | 'meta' | 'kakao_moment' | 'naver_gfa'
  | 'naver_commerce' | 'coupang' | 'cafe24' | 'ohouse'
  | 'csv' | 'demo';

export type Channel = MediaId | SalesChannelId;

/** 외부 호출 래퍼 — 타임아웃 · 재시도(429 · 5xx) · 요청 로그(비밀값 마스킹). 테스트에서는 가짜 fetch를 주입한다. */
export interface ConnectorHttp {
  request<T = unknown>(o: {
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
    url: string;
    query?: Record<string, string | number | boolean | undefined>;
    headers?: Record<string, string>;
    body?: unknown;
    /** 'json'(기본) · 'text' · 'form' */
    bodyType?: 'json' | 'form' | 'text';
    timeoutMs?: number;
    retries?: number;
  }): Promise<{ status: number; data: T; headers: Record<string, string> }>;
}

export interface ConnectorContext<C = Record<string, unknown>, S = Record<string, unknown>> {
  workspaceId: string;
  connectionId: string;
  credentials: C;
  settings: S;
  http: ConnectorHttp;
  log: (msg: string, extra?: unknown) => void;
  /** true면 apply는 실제 호출 없이 보낼 요청만 만들어 돌려준다 */
  dryRun: boolean;
  /** 자격증명 갱신(OAuth 토큰 재발급 등)을 저장해야 할 때 */
  saveCredentials?: (next: C) => Promise<void>;
}

export interface DateRange { from: string; to: string } // YYYY-MM-DD (포함, KST)

/** 표준 레코드 — 웨어하우스 테이블과 1:1 (금액 원, 비율 0~1) */
export interface NormalizedBatch {
  mediaDaily?: { date: string; media: MediaId; impressions: number; clicks: number; cost: number; conversions: number; revenue: number; newCustomers?: number }[];
  mediaHourly?: { date: string; hour: number; media: MediaId; impressions: number; clicks: number; cost: number; conversions: number; revenue: number }[];
  salesDaily?: { date: string; channel: SalesChannelId; visitors: number; detailViews: number; carts: number; orders: number; revenue: number; adAttributedRevenue?: number }[];
  keywordDaily?: { date: string; keywordId: string; impressions: number; clicks: number; cost: number; conversions: number; revenue: number; avgRank?: number | null }[];
  searchTermDaily?: { date: string; term: string; impressions: number; clicks: number; cost: number; conversions: number; revenue: number }[];
  brandSearchDaily?: { date: string; volume: number }[];
  /** 엔티티 스냅샷 (현재 상태). keyword의 last14/prev14/daily는 Dataset 빌더가 keywordDaily로 다시 계산한다 */
  keywords?: Omit<Keyword, 'last14' | 'prev14' | 'daily'>[];
  campaigns?: Campaign[];
  accounts?: AdAccount[];
  products?: Product[];
  promotions?: Promotion[];
  /** 수집 중 발견한 문제 (데이터 품질 검사 결과와 합쳐 ingest_runs.issues에 저장) */
  warnings?: { code: string; message: string; detail?: unknown }[];
}

export interface ApplyResult {
  ok: boolean;
  /** 보낸(dry_run이면 보낼) 요청 요약 — 비밀값 제외 */
  request: unknown;
  response?: unknown;
  error?: string;
  /** 반영 후 매체가 돌려준 실제 값 (예: 적용된 입찰가) */
  appliedValue?: string | number;
}

export interface ConnectorCapabilities {
  /** 수집 가능한 표준 레코드 */
  reads: (keyof NormalizedBatch)[];
  /** 반영 가능한 변경 종류 (ChangeRequest.kind) */
  writes: ChangeRequest['kind'][];
  /** 시간대 데이터 지원 (당일 intraday 수집) */
  intraday: boolean;
  /** 최대 백필 일수 (매체 API 보관 한도) */
  maxBackfillDays: number;
}

export interface ConnectorDef<C = any, S = any> {
  provider: Provider;
  kind: 'media' | 'sales' | 'other';
  /** 기본 채널 (매체 · 판매 채널). csv · demo는 null */
  channel: Channel | null;
  label: string;
  /** 공식 문서 URL — 화면 · 감사에 표시 */
  docsUrl: string;
  /** 실계정 호출로 검증됐는지 — false면 화면에 '실계정 연결 전 확인 필요' */
  verifiedLive: boolean;
  credentialsSchema: z.ZodType<C>;
  settingsSchema: z.ZodType<S>;
  /** 자격증명 입력 폼 안내 (필드명 → 라벨 · 도움말 · 비밀값 여부) */
  credentialFields: { key: string; label: string; help?: string; secret: boolean; optional?: boolean }[];
  capabilities: ConnectorCapabilities;
  /** 연결 확인 — 계정 이름 등 확인용 요약을 돌려준다 */
  test(ctx: ConnectorContext<C, S>): Promise<{ ok: boolean; message: string; account?: string }>;
  fetch(ctx: ConnectorContext<C, S>, range: DateRange, opts?: { intradayDate?: string }): Promise<NormalizedBatch>;
  /** 매체 반영 (writes에 있는 kind만) */
  apply?(ctx: ConnectorContext<C, S>, change: ApplyChange): Promise<ApplyResult>;
}

/**
 * apply에 넘어오는 변경 — ChangeRequest + 변경 실행기가 웨어하우스(wh_entities.doc)에서 읽어 붙인 대상 정보(허용 필드만).
 * 커넥터는 entity를 사전 확인 값으로만 쓴다: live에서는 매체에서 다시 읽어 다르면 중단한다.
 */
export type ApplyChange = ChangeRequest & {
  entity?: { type: 'keyword' | 'campaign' | 'account'; externalId: string; name?: string; text?: string; media?: string; campaignId?: string; adgroupId?: string };
};
