/**
 * 네이버 브랜드스토어(커머스API) 커넥터 (docs/SAAS_SPEC.md §4 connectors-sales) — 판매 채널 brandstore.
 *
 * 공식 문서 (커머스API 2.91.0, 2026-11-03 확인 — 상세 근거는 client.ts · normalize.ts 머리말):
 *   https://apicenter.commerce.naver.com/docs/auth                                        OAuth2 · 전자서명(bcrypt)
 *   https://apicenter.commerce.naver.com/docs/commerce-api/current/exchange-sellers-auth  인증 토큰 발급
 *   https://apicenter.commerce.naver.com/docs/commerce-api/current/seller-get-product-orders-with-conditions-pay-order-seller  조건형 상품 주문 조회
 *   https://apicenter.commerce.naver.com/docs/commerce-api/current/search-product         상품 목록 조회
 *   https://apicenter.commerce.naver.com/docs/commerce-api/current/read-origin-product-product  원상품 조회(옵션 · 재고 · 즉시 할인)
 *   https://apicenter.commerce.naver.com/docs/restriction                                 요청량 제한(429 GW.RATE_LIMIT)
 *
 * 수집 (fetch)
 *   - salesDaily: KST 날짜마다 결제 일시(PAYED_DATETIME) 하루 구간(00:00:00.000 ~ 23:59:59.999, 오늘은 현재 시각까지)을
 *     조건형 상품 주문 조회로 페이지(300건) 순회 → 취소 · 반품 · 미결제 제외, 결제일 KST 날짜로 묶는다. 주문이 없는 날은 0행.
 *     orders = 주문번호 수, revenue = 설정 revenueBasis(기본 net: 할인 후 결제 금액), adAttributedRevenue = 검색광고 유입 주문 매출(추정)
 *   - visitors · detailViews · carts: 커머스API에 스토어 방문 통계 API가 없어 0 + 경고(CSV 템플릿 안내)
 *   - products: 상품 목록(판매 중 · 품절 · 대기 · 중지) + 원상품 조회로 조합형 옵션 가격 · 재고 (설정 optionDetailLimit개까지)
 *   - promotions: 원상품의 즉시 할인(기간이 있는 것) → 브랜드스토어 프로모션
 *   상품 · 프로모션 스냅샷은 일 수집과 어제를 포함하는 백필 구간에서만 받는다(당일 시간대 수집 · 오래된 백필 구간은 생략).
 * 반영(apply): 없음 — 판매 채널은 읽기 전용(변경 요청 종류에 상품 가격 · 재고 변경이 없다).
 * 보관 한도: 문서에 주문 조회 가능 기간 한도가 없어 플랫폼 상한(400일)을 쓴다.
 */
import { z } from 'zod';
import type { ConnectorContext, ConnectorDef, DateRange, NormalizedBatch } from '../types';
import type { Product, Promotion } from '@/core/types';
import { addDaysStr, dateRange, kstToday, nowMs } from '../../lib/time';
import {
  ConfigError, MAX_PAGES, SalesAcc, SalesApiError, clampRange, funnelUnavailable, httpsUrlTemplate, kstDayEnd, kstDayStart, softPart, testOutcome, warn, wantsSnapshot,
} from './sales-shared';
import { NAVER_COMMERCE_LABEL, NaverCommerceClient, type NaverChannelProduct, type NaverCommerceCredentials, type NaverOriginProduct } from './client';
import { isLine, landingOf, naverOrderLine, naverProduct, naverPromotion, pickChannelProduct } from './normalize';

/** bcrypt salt 형식 — 커머스API센터가 발급하는 애플리케이션 시크릿 ($2a$ + 비용 2자리 + $ + 22자) */
export const BCRYPT_SALT = /^\$2[aby]\$\d{2}\$[./A-Za-z0-9]{22}$/;

export const credentialsSchema = z.object({
  clientId: z.string().trim().min(5, '애플리케이션 ID를 입력해 주세요'),
  clientSecret: z.string().trim().regex(BCRYPT_SALT, '애플리케이션 시크릿은 $2a$로 시작하는 29자 값입니다'),
  accountId: z.string().trim().min(1).max(100).optional(),
});

export const settingsSchema = z.object({
  /** 토큰 유형: SELF(자기 스토어, 기본) · SELLER(솔루션사가 판매자 리소스 호출 — 자격증명 accountId 필요) */
  tokenType: z.enum(['SELF', 'SELLER']).default('SELF'),
  /** 매출 기준: net = 할인 후 상품 결제 금액(기본) · gross = 할인 전 상품 주문 금액 */
  revenueBasis: z.enum(['net', 'gross']).default('net'),
  /** 광고 경유 매출로 볼 유입 경로(inflowPath) 문구 */
  adInflowPatterns: z.array(z.string().min(1)).default(['검색광고']),
  /** 상품 주문 페이지 크기 (문서 최대 300) */
  pageSize: z.number().int().min(1).max(300).default(300),
  fetchProducts: z.boolean().default(true),
  fetchPromotions: z.boolean().default(true),
  /** 상품 목록 최대 개수 */
  productLimit: z.number().int().min(1).max(5000).default(300),
  /** 옵션 · 재고 · 즉시 할인을 보려고 원상품을 조회할 최대 상품 수 (상품당 1회 호출) */
  optionDetailLimit: z.number().int().min(0).max(1000).default(100),
  /** 상품 랜딩 URL 템플릿 — 예: https://brand.naver.com/mildo/products/{channelProductNo} (없으면 채널 URL) */
  productUrlTemplate: httpsUrlTemplate.optional(),
});
export type NaverCommerceSettings = z.infer<typeof settingsSchema>;

function parseCreds(ctx: ConnectorContext): NaverCommerceCredentials {
  const r = credentialsSchema.safeParse(ctx.credentials ?? {});
  if (!r.success) throw new ConfigError(`${NAVER_COMMERCE_LABEL} 자격증명을 확인해 주세요: ${r.error.issues.map((i) => i.message).join(', ')}`);
  return r.data;
}
function parseSettings(ctx: ConnectorContext): NaverCommerceSettings {
  const r = settingsSchema.safeParse(ctx.settings ?? {});
  return r.success ? r.data : settingsSchema.parse({});
}
export const clientOf = (ctx: ConnectorContext, s: NaverCommerceSettings) => new NaverCommerceClient(ctx, parseCreds(ctx), { now: nowMs, tokenType: s.tokenType });

/** 지금(KST) — 'YYYY-MM-DDTHH:mm:ss.SSS+09:00' */
const nowKst = () => new Date(nowMs() + 9 * 3600_000).toISOString().replace('Z', '+09:00');

/* ------------------------------ 수집 ------------------------------ */

export async function fetchNaverCommerce(ctx: ConnectorContext, range: DateRange, opts: { intradayDate?: string } = {}): Promise<NormalizedBatch> {
  const s = parseSettings(ctx);
  const client = clientOf(ctx, s);
  const today = kstToday();
  const r = opts.intradayDate ? clampRange({ from: opts.intradayDate, to: opts.intradayDate }, today) : clampRange(range, today);
  const batch: NormalizedBatch = { salesDaily: [], warnings: [] };

  if (r) {
    const acc = new SalesAcc();
    const seen = new Set<string>();
    for (const d of dateRange(r.from, r.to)) {
      const from = kstDayStart(d);
      const to = d === today ? nowKst() : kstDayEnd(d);
      for (let page = 1; page <= MAX_PAGES; page++) {
        const res = await client.productOrders(from, to, page, s.pageSize);
        const contents = res.data?.contents ?? [];
        for (const c of contents) {
          const id = String(c.content?.productOrder?.productOrderId ?? c.productOrderId ?? '');
          if (id && seen.has(id)) continue;
          if (id) seen.add(id);
          const line = naverOrderLine(c, s.revenueBasis, s.adInflowPatterns);
          if (!isLine(line)) continue;
          acc.add(line.date, line.orderId, line.revenue, line.adAttributed ? line.revenue : 0);
        }
        if (!res.data?.pagination?.hasNext || !contents.length) break;
      }
    }
    batch.salesDaily = acc.rows('brandstore', r);
    if (!opts.intradayDate) funnelUnavailable(batch, NAVER_COMMERCE_LABEL, ['방문자', '상세 조회', '장바구니']);
  }

  if (s.fetchProducts && wantsSnapshot(range, opts, today)) {
    const snap = await softPart(batch, 'products_failed', '상품 · 재고', () => collectProducts(client, s, today, batch));
    if (snap) {
      batch.products = snap.products;
      if (s.fetchPromotions) batch.promotions = snap.promotions;
    }
  }
  if (!batch.warnings?.length) delete batch.warnings;
  return batch;
}

async function collectProducts(client: NaverCommerceClient, s: NaverCommerceSettings, today: string, batch: NormalizedBatch): Promise<{ products: Product[]; promotions: Promotion[] }> {
  let channelUrl: string | undefined;
  try {
    channelUrl = (await client.channels()).find((c) => c.channelType === 'STOREFARM')?.url ?? undefined;
  } catch (e) {
    if (e instanceof SalesApiError && e.kind === 'rate') throw e;
  }
  const items: { originProductNo: number; cp: NaverChannelProduct }[] = [];
  const size = Math.min(500, s.productLimit);
  let more = false;
  for (let page = 1; page <= MAX_PAGES; page++) {
    const res = await client.searchProducts(page, size);
    const contents = res.contents ?? [];
    for (const c of contents) {
      const cp = pickChannelProduct(c.channelProducts);
      const no = c.originProductNo ?? cp?.originProductNo;
      if (!cp || no === undefined || no === null) continue;
      if (items.length >= s.productLimit) { more = true; break; }
      items.push({ originProductNo: no, cp });
    }
    const last = res.last === true || (typeof res.totalPages === 'number' && page >= res.totalPages) || contents.length < size;
    if (more || last) break;
    if (items.length >= s.productLimit) { more = true; break; }
  }
  if (more) warn(batch, 'products_truncated', `상품을 설정 productLimit(${s.productLimit})개까지만 받았습니다 — 늘리려면 커넥션 설정을 바꿔 주세요`);

  const products: Product[] = [];
  const promotions: Promotion[] = [];
  let detailFailed = 0;
  for (const [i, it] of items.entries()) {
    let detail: NaverOriginProduct | null = null;
    if (i < s.optionDetailLimit) {
      try {
        detail = await client.originProduct(it.originProductNo);
      } catch (e) {
        if (e instanceof SalesApiError && (e.kind === 'rate' || e.kind === 'auth')) throw e;
        detailFailed++;
      }
    }
    const p = naverProduct(it.originProductNo, it.cp, detail, { landing: landingOf(s.productUrlTemplate, channelUrl, it.cp, it.originProductNo) });
    products.push(p);
    const promo = naverPromotion(it.originProductNo, p.name, detail, today);
    if (promo) promotions.push(promo);
  }
  if (items.length > s.optionDetailLimit) {
    warn(batch, 'option_detail_limit', `옵션 · 재고 상세는 상품 ${s.optionDetailLimit}개까지만 조회했습니다 — 나머지 ${items.length - s.optionDetailLimit}개는 상품 목록의 판매가 · 재고 합계로 단일 옵션을 만들었습니다(설정 optionDetailLimit)`);
  }
  if (detailFailed) warn(batch, 'option_detail_failed', `원상품 조회 ${detailFailed}건 실패 — 해당 상품은 목록 정보로 단일 옵션을 만들었습니다`);
  return { products, promotions };
}

/* ------------------------------ 정의 ------------------------------ */

export const connector: ConnectorDef = {
  provider: 'naver_commerce',
  kind: 'sales',
  channel: 'brandstore',
  label: '네이버 브랜드스토어(커머스 API)',
  docsUrl: 'https://apicenter.commerce.naver.com/docs/commerce-api/current',
  verifiedLive: false,
  credentialsSchema,
  settingsSchema,
  credentialFields: [
    { key: 'clientId', label: '애플리케이션 ID', secret: false, help: '커머스API센터 > 애플리케이션 등록 후 받은 애플리케이션 ID. API 그룹에 주문 · 상품 조회 권한을 넣어 주세요' },
    { key: 'clientSecret', label: '애플리케이션 시크릿', secret: true, help: '같은 화면의 시크릿($2a$로 시작하는 29자). 서버가 bcrypt 전자서명을 만들 때만 쓰고 네이버로 직접 보내지 않습니다' },
    { key: 'accountId', label: '판매자 ID (솔루션사 전용)', secret: false, optional: true, help: '솔루션사가 다른 판매자 스토어를 연동할 때만 입력합니다(토큰 유형 SELLER). 자기 스토어 애플리케이션이면 비워 두세요' },
  ],
  capabilities: {
    reads: ['salesDaily', 'products', 'promotions'],
    writes: [],
    intraday: true,
    maxBackfillDays: 400,
  },
  async test(ctx) {
    return testOutcome(async () => {
      const s = parseSettings(ctx);
      const client = clientOf(ctx, s);
      await client.token(true);
      let store = '';
      let accountId = '';
      try {
        const ch = await client.channels();
        store = ch.find((c) => c.channelType === 'STOREFARM')?.name ?? ch[0]?.name ?? '';
        accountId = (await client.account()).accountId ?? '';
      } catch (e) {
        if (!(e instanceof SalesApiError) || (e.kind !== 'permission' && e.kind !== 'not_found')) throw e;
      }
      const y = addDaysStr(kstToday(), -1);
      const page = await client.productOrders(kstDayStart(y), kstDayEnd(y), 1, 300);
      const n = page.data?.contents?.length ?? 0;
      const label = store || accountId || ctx.credentials?.clientId;
      return {
        ok: true,
        account: `${NAVER_COMMERCE_LABEL} ${label}`,
        message: `연결 확인 — ${store ? `스토어 ${store}` : '스토어 이름 미확인(판매자 정보 API 그룹 없음)'}${accountId ? ` · 계정 ${accountId}` : ''} · 어제 결제 상품 주문 ${n}건${page.data?.pagination?.hasNext ? ' 이상' : ''}. 방문자 · 상세 조회 · 장바구니는 커머스API에서 제공하지 않아 CSV 템플릿으로 채워 주세요`,
      };
    });
  },
  fetch: (ctx, range, opts) => fetchNaverCommerce(ctx, range, opts),
};
