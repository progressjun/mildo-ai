/**
 * 쿠팡 Wing 커넥터 (docs/SAAS_SPEC.md §4 connectors-sales) — 판매 채널 coupang.
 *
 * 공식 문서 (2026-11-03 확인 — 상세 근거는 client.ts · normalize.ts 머리말):
 *   https://developers.coupang.com/ko/getting-started/creating-hmac-signature                    HMAC 서명(CEA)
 *   https://developers.coupang.com/ko/api/shipments/po-list-query-paging-by-day?market=KR       발주서 목록 조회(일단위 페이징)
 *   https://developers.coupang.com/ko/api/products/product-list-paging-query?market=KR          상품 목록 페이징 조회
 *   https://developers.coupang.com/ko/api/products/querying-product?market=KR                   상품 조회(옵션)
 *   https://developers.coupang.com/ko/api/products/query-quantitypricestatus-by-product-items?market=KR  옵션 재고 · 가격 · 판매 상태
 *   https://developers.coupang.com/ko/api/promotions/instant-discount-coupon-query-a-list-of-coupons-status?market=KR  즉시할인 쿠폰
 *
 * 수집 (fetch)
 *   - salesDaily: 발주서 목록(일단위 페이징)을 주문 생성일(createdAt) 기준 30일 묶음 × 발주서 상태 6종(ACCEPT ~ NONE_TRACKING)으로 nextToken 순회.
 *     결제일(paidAt) KST 날짜로 다시 묶는다 — 가상계좌처럼 생성 후 결제되는 주문을 잡으려고 생성일 구간을 설정 createdLookbackDays(기본 2일)만큼 앞당겨 조회하고,
 *     요청 기간 밖 결제일은 버린다. 순수량 = shippingCount − holdCountForCancel − cancelCount, 취소 · 순수량 0 제외. 같은 배송번호 · 옵션은 한 번만.
 *   - visitors · detailViews · carts: Wing Open API에 방문 통계가 없어 0 + 경고(CSV 템플릿 안내)
 *   - products: 승인 완료 · 부분 승인 상품 → 상품 조회(옵션) → 옵션별 재고 조회(설정 inventoryLimit개까지). 랜딩 URL은 주문에 실린 productSalesPageUrl
 *   - promotions: 즉시할인 쿠폰(사용중 APPLIED · 대기중 STANDBY)
 *   상품 · 프로모션 스냅샷은 일 수집과 어제를 포함하는 백필 구간에서만 받는다.
 * 반영(apply): 없음 — 판매 채널은 읽기 전용.
 * 보관 한도: 문서는 한 번에 31일까지만 정하고 조회 가능 기간 한도는 적지 않아 플랫폼 상한(400일)을 쓴다.
 */
import { z } from 'zod';
import type { ConnectorContext, ConnectorDef, DateRange, NormalizedBatch } from '../types';
import type { Product, Promotion } from '@/core/types';
import { addDaysStr, kstToday, nowMs } from '../../lib/time';
import {
  ConfigError, MAX_PAGES, SalesAcc, SalesApiError, clampRange, funnelUnavailable, softPart, splitRange, testOutcome, warn, wantsSnapshot,
} from '../naver-commerce/sales-shared';
import { COUPANG_LABEL, CoupangClient, ORDER_SHEET_STATUSES, type CoupangCredentials, type CoupangInventory, type CoupangSellerProductSummary } from './client';
import { coupangLines, coupangProduct, coupangPromotion, landingOf } from './normalize';

/** 문서 오류 사양: 'endTime-startTime range should less than31.' → 시작 · 종료 차이 31일 미만이 되도록 30일 묶음 */
export const ORDER_WINDOW_DAYS = 30;

export const credentialsSchema = z.object({
  vendorId: z.string().trim().transform((v) => v.toUpperCase()).pipe(z.string().regex(/^[A-Z]\d{5,12}$/, '판매자 ID(vendorId)는 A00012345 형식입니다')),
  accessKey: z.string().trim().min(8, 'Access Key를 입력해 주세요'),
  secretKey: z.string().trim().min(8, 'Secret Key를 입력해 주세요'),
});

export const settingsSchema = z.object({
  /** 매출 기준: net = 판매가 × 순수량 − 총 할인(기본) · gross = 판매가 × 순수량 */
  revenueBasis: z.enum(['net', 'gross']).default('net'),
  /** 결제일 기준으로 묶기 위해 주문 생성일 조회를 앞당길 일수 */
  createdLookbackDays: z.number().int().min(0).max(7).default(2),
  /** 조회할 발주서 상태 (기본 전체) */
  statuses: z.array(z.enum(ORDER_SHEET_STATUSES)).min(1).default([...ORDER_SHEET_STATUSES]),
  fetchProducts: z.boolean().default(true),
  fetchPromotions: z.boolean().default(true),
  /** 상품 최대 개수 (상품당 상품 조회 1회) */
  productLimit: z.number().int().min(1).max(2000).default(200),
  /** 옵션별 재고 조회 최대 옵션 수 (옵션당 1회) — 0이면 상품 조회의 판매가능수량으로 판단 */
  inventoryLimit: z.number().int().min(0).max(5000).default(300),
  /** 상품 랜딩 URL 템플릿 (주문에 productSalesPageUrl이 없을 때) — {sellerProductId} · {productId} */
  productUrlTemplate: z.string().url().optional(),
});
export type CoupangSettings = z.infer<typeof settingsSchema>;

function parseCreds(ctx: ConnectorContext): CoupangCredentials {
  const r = credentialsSchema.safeParse(ctx.credentials ?? {});
  if (!r.success) throw new ConfigError(`${COUPANG_LABEL} 자격증명을 확인해 주세요: ${r.error.issues.map((i) => i.message).join(', ')}`);
  return r.data;
}
function parseSettings(ctx: ConnectorContext): CoupangSettings {
  const r = settingsSchema.safeParse(ctx.settings ?? {});
  return r.success ? r.data : settingsSchema.parse({});
}
export const clientOf = (ctx: ConnectorContext) => new CoupangClient(ctx, parseCreds(ctx), { now: nowMs });

/* ------------------------------ 수집 ------------------------------ */

export async function fetchCoupang(ctx: ConnectorContext, range: DateRange, opts: { intradayDate?: string } = {}): Promise<NormalizedBatch> {
  const s = parseSettings(ctx);
  const client = clientOf(ctx);
  const today = kstToday();
  const r = opts.intradayDate ? clampRange({ from: opts.intradayDate, to: opts.intradayDate }, today) : clampRange(range, today);
  const batch: NormalizedBatch = { salesDaily: [], warnings: [] };
  /** 주문에서 본 상품 판매 페이지 URL (sellerProductId → URL) */
  const pageUrl = new Map<string, string>();

  if (r) {
    const acc = new SalesAcc();
    const seen = new Set<string>();
    const created = { from: addDaysStr(r.from, -s.createdLookbackDays), to: r.to };
    for (const w of splitRange(created.from, created.to, ORDER_WINDOW_DAYS)) {
      for (const status of s.statuses) {
        let token: string | undefined;
        for (let page = 0; page < MAX_PAGES; page++) {
          const res = await client.orderSheets(w.from, w.to, status, token);
          for (const sheet of res.data ?? []) {
            for (const it of sheet.orderItems ?? []) if (it.sellerProductId && it.productSalesPageUrl) pageUrl.set(String(it.sellerProductId), it.productSalesPageUrl);
            for (const line of coupangLines(sheet, s.revenueBasis).lines) {
              if (seen.has(line.key)) continue;
              seen.add(line.key);
              acc.add(line.date, line.orderId, line.revenue);
            }
          }
          const next = res.nextToken ? String(res.nextToken) : '';
          if (!next || next === token || !(res.data ?? []).length) break;
          token = next;
        }
      }
    }
    batch.salesDaily = acc.rows('coupang', r);
    if (!opts.intradayDate) funnelUnavailable(batch, COUPANG_LABEL, ['방문자', '상세 조회', '장바구니']);
  }

  if (wantsSnapshot(range, opts, today)) {
    if (s.fetchProducts) {
      const products = await softPart(batch, 'products_failed', '상품 · 재고', () => collectProducts(client, s, pageUrl, batch));
      if (products) batch.products = products;
    }
    if (s.fetchPromotions) {
      const promos = await softPart(batch, 'promotions_failed', '즉시할인 쿠폰', () => collectPromotions(client, today));
      if (promos) batch.promotions = promos;
    }
  }
  if (!batch.warnings?.length) delete batch.warnings;
  return batch;
}

async function collectProducts(client: CoupangClient, s: CoupangSettings, pageUrl: Map<string, string>, batch: NormalizedBatch): Promise<Product[]> {
  const list: CoupangSellerProductSummary[] = [];
  let more = false;
  for (const status of ['APPROVED', 'PARTIAL_APPROVED']) {
    let token: string | undefined;
    for (let page = 0; page < MAX_PAGES && !more; page++) {
      const res = await client.sellerProducts(token, status);
      for (const p of res.data ?? []) {
        if (list.length >= s.productLimit) { more = true; break; }
        if (p.sellerProductId && !list.some((x) => x.sellerProductId === p.sellerProductId)) list.push(p);
      }
      const next = res.nextToken ? String(res.nextToken) : '';
      if (!next || next === token || !(res.data ?? []).length) break;
      token = next;
    }
    if (more) break;
  }
  if (more) warn(batch, 'products_truncated', `상품을 설정 productLimit(${s.productLimit})개까지만 받았습니다 — 늘리려면 커넥션 설정을 바꿔 주세요`);

  const products: Product[] = [];
  let invCalls = 0;
  let invSkipped = 0;
  let failed = 0;
  for (const p of list) {
    let detail;
    try {
      detail = (await client.sellerProduct(p.sellerProductId!)).data;
    } catch (e) {
      if (e instanceof SalesApiError && (e.kind === 'rate' || e.kind === 'auth')) throw e;
      failed++;
      continue;
    }
    const inv = new Map<string, CoupangInventory['data']>();
    for (const it of detail?.items ?? []) {
      if (it.vendorItemId === undefined || it.vendorItemId === null) continue;
      if (invCalls >= s.inventoryLimit) { invSkipped++; continue; }
      invCalls++;
      try {
        inv.set(String(it.vendorItemId), (await client.inventory(it.vendorItemId)).data);
      } catch (e) {
        if (e instanceof SalesApiError && (e.kind === 'rate' || e.kind === 'auth')) throw e;
        invSkipped++;
      }
    }
    const prod = coupangProduct(detail, inv, landingOf(s.productUrlTemplate, pageUrl.get(String(p.sellerProductId)), p.sellerProductId!, p.productId));
    if (prod) products.push(prod);
  }
  if (invSkipped) warn(batch, 'inventory_partial', `옵션 ${invSkipped}개는 옵션별 재고 조회를 하지 않았거나 실패해 상품 조회의 판매가능수량(maximumBuyCount)으로 재고를 판단했습니다 (설정 inventoryLimit ${s.inventoryLimit})`);
  if (failed) warn(batch, 'product_detail_failed', `상품 조회 ${failed}건 실패 — 해당 상품은 이번 스냅샷에서 빠졌습니다`);
  return products;
}

async function collectPromotions(client: CoupangClient, today: string): Promise<Promotion[]> {
  const out: Promotion[] = [];
  for (const status of ['APPLIED', 'STANDBY'] as const) {
    for (let page = 1; page <= 20; page++) {
      const res = await client.coupons(status, page);
      const content = res.data?.content ?? [];
      for (const c of content) {
        const p = coupangPromotion(c, today);
        if (p && !out.some((x) => x.id === p.id)) out.push(p);
      }
      const pg = res.data?.pagination ?? (Array.isArray(res.data?.Pagination) ? res.data?.Pagination[0] : res.data?.Pagination);
      const total = Number(pg?.totalPages ?? 1);
      if (!content.length || !Number.isFinite(total) || page >= total) break;
    }
  }
  return out;
}

/* ------------------------------ 정의 ------------------------------ */

export const connector: ConnectorDef = {
  provider: 'coupang',
  kind: 'sales',
  channel: 'coupang',
  label: '쿠팡 Wing',
  docsUrl: 'https://developers.coupang.com/ko/api',
  verifiedLive: false,
  credentialsSchema,
  settingsSchema,
  credentialFields: [
    { key: 'vendorId', label: '판매자 ID (업체 코드)', secret: false, help: '쿠팡 Wing 우측 상단 업체 코드(A00012345 형식)' },
    { key: 'accessKey', label: '액세스 키 (Access Key)', secret: true, help: 'Wing > 판매자 정보 > 추가판매정보 > OPEN API 키 발급에서 받은 Access Key. 키 발급 화면에 이 서버의 공인 IP를 호출 허용 IP로 등록해야 합니다' },
    { key: 'secretKey', label: '시크릿 키 (Secret Key)', secret: true, help: '같은 화면의 Secret Key. 요청마다 HMAC-SHA256 서명에만 쓰고 쿠팡으로 직접 보내지 않습니다' },
  ],
  capabilities: {
    reads: ['salesDaily', 'products', 'promotions'],
    writes: [],
    intraday: true,
    maxBackfillDays: 400,
  },
  async test(ctx) {
    return testOutcome(async () => {
      const client = clientOf(ctx);
      const products = await client.sellerProducts(undefined, undefined, 1);
      const y = addDaysStr(kstToday(), -1);
      const sheets = await client.orderSheets(y, y, 'ACCEPT');
      const n = (sheets.data ?? []).length;
      return {
        ok: true,
        account: `${COUPANG_LABEL} ${client.vendorId}`,
        message: `연결 확인 — 판매자 ID ${client.vendorId} · 상품 목록 ${products.data?.length ? '조회됨' : '비어 있음'} · 어제 생성된 결제완료(ACCEPT) 발주서 ${n}건${sheets.nextToken ? ' 이상' : ''}. 방문자 · 상세 조회 · 장바구니는 Wing Open API에서 제공하지 않아 CSV 템플릿으로 채워 주세요`,
      };
    });
  },
  fetch: (ctx, range, opts) => fetchCoupang(ctx, range, opts),
};
