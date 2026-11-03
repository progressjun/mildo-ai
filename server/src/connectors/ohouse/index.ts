/**
 * 오늘의집 커넥터 (docs/SAAS_SPEC.md §4 connectors-sales) — 판매 채널 ohouse, CSV 업로드 전용.
 *
 * 공개 API 확인 결과 (2026-11-03)
 *   - 오늘의집(버킷플레이스)은 판매자 · 파트너용 공개 API 문서를 내놓지 않았다. 파트너센터(https://partner.ohou.se)는 로그인 화면만 있고,
 *     개발자 문서 · API 호스트로 볼 만한 주소(developers.ohou.se · api.ohou.se · seller.ohou.se)는 404였으며, 공식 안내에서 주문 · 상품 조회 API 근거를 찾지 못했다.
 *   - 문서가 없는 엔드포인트 · 필드를 지어내지 않는다(docs/SAAS_SPEC.md §0) → API 수집은 구현하지 않고 CSV 경로로 받는다.
 * 데이터 넣는 방법
 *   - 오늘의집 파트너센터에서 내려받은 일별 판매 실적을 판매 채널 일별 템플릿(GET /api/uploads/templates/sales_daily.csv)에 옮겨
 *     채널 값 ohouse(또는 '오늘의집')로 업로드한다(POST /api/w/:ws/uploads { template: 'sales_daily' }). 업로드 출처는 'csv:<업로드 id>'.
 *   - 공식 파트너 API가 확인되면 이 파일에 client.ts를 추가해 다른 판매 채널 커넥터와 같은 방식(salesDaily · products)으로 구현한다.
 * 이 정의는 카탈로그에 남겨 둔다 — reads가 비어 있어 카탈로그 available=false이고 예약 수집 대상이 아니다(ingest/jobs.ts eligible).
 * 화면 라벨은 데모 예시 카탈로그(src/modules/connections/demoState.ts)와 같은 '오늘의집'을 유지하고, CSV 전용 안내는 연결 확인 메시지 · csvGuide로 전한다.
 */
import { z } from 'zod';
import type { ConnectorDef, NormalizedBatch } from '../types';

export const CSV_ONLY_REASON = '오늘의집은 판매자용 공개 API 문서가 확인되지 않아 API 연결을 지원하지 않습니다';

/** CSV 경로 안내 (화면 · 연결 확인 메시지 · 다른 도메인에서 쓸 수 있게 내보낸다) */
export const csvGuide = {
  template: 'sales_daily' as const,
  channel: 'ohouse' as const,
  templateUrl: '/api/uploads/templates/sales_daily.csv',
  reason: CSV_ONLY_REASON,
  message: `${CSV_ONLY_REASON} — 파트너센터에서 내려받은 일별 판매 실적을 판매 채널 일별 CSV 템플릿(sales_daily, 채널 값 ohouse 또는 '오늘의집')에 옮겨 데이터 연결 화면의 업로드로 올려 주세요. 방문자 · 상세 조회 · 장바구니 · 주문 · 매출 열을 모두 담을 수 있습니다`,
};

export const connector: ConnectorDef = {
  provider: 'ohouse',
  kind: 'sales',
  channel: 'ohouse',
  label: '오늘의집',
  docsUrl: 'https://partner.ohou.se',
  verifiedLive: false,
  credentialsSchema: z.object({}),
  settingsSchema: z.object({}),
  credentialFields: [],
  capabilities: { reads: [], writes: [], intraday: false, maxBackfillDays: 0 },
  async test() {
    return { ok: false, message: csvGuide.message };
  },
  /** API 수집 없음 — 혹시 호출되더라도 쓰지 않을 빈 배치와 안내 경고만 돌려준다 */
  async fetch(): Promise<NormalizedBatch> {
    return { warnings: [{ code: 'csv_only', message: csvGuide.message, detail: { template: csvGuide.template, channel: csvGuide.channel } }] };
  },
};
