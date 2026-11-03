/**
 * 카페24 자사몰 커넥터 (docs/SAAS_SPEC.md §4 connectors-sales) — 판매 채널 own_mall.
 *
 * 공식 문서 (2026-11-03 확인 — 상세 근거는 client.ts · normalize.ts 머리말):
 *   https://apidocs.cafe24.com/docs/guide/oauth2-authentication       OAuth 2.0 (인증 코드 · 갱신 토큰, Basic 인증)
 *   https://apidocs.cafe24.com/docs/admin/get-orders                  주문 목록 조회 (embed=items)
 *   https://apidocs.cafe24.com/docs/admin/get-orders-by-order-id-items 품주 필드 · status_code
 *   https://apidocs.cafe24.com/docs/admin/get-products                상품 목록 (embed=variants)
 *   https://apidocs.cafe24.com/docs/admin/get-products-by-product-no-variants  품목 · 재고 수량
 *   https://apidocs.cafe24.com/docs/admin/get-benefits                혜택(기간할인)
 *   https://developers.cafe24.com/docs/ko/api/cafe24data/             Cafe24 Analytics API (방문자 · 상품 조회수 · 장바구니)
 *
 * 인증
 *   - 갱신 토큰(refresh token)을 넣거나, 브라우저로 받은 인증 코드(1분 유효 · 1회용)와 Redirect URI를 넣으면 첫 호출에서 토큰으로 교환한다.
 *     인증 코드가 남아 있으면(=운영자가 다시 승인) 먼저 교환하고, 교환이 거절되면 갱신 토큰으로 이어서 시도한다. 저장된 갱신 토큰 만료 시각은 참고만 한다.
 *   - 액세스 토큰(2시간)은 만료 5분 전에 갱신하고, 갱신마다 새 갱신 토큰을 ctx.saveCredentials로 즉시 암호화 저장한다(이전 갱신 토큰은 폐기됨).
 *   - 인증 코드 요청 URL은 cafe24AuthorizeUrl()로 만든다(커넥션 화면 · OAuth 콜백 라우트용, client.ts).
 * 수집 (fetch)
 *   - salesDaily: 결제일(pay_date) 구간을 설정 orderWindowDays(기본 7일) 묶음 × offset 페이지(최대 15,000)로 순회 → 취소 · 미결제 · 취소/반품 품주 제외,
 *     결제일 KST 날짜로 묶는다. offset 상한에 닿으면 그 구간을 하루 단위로 다시 나눈다.
 *   - visitors: Analytics visitors/view(일별 방문자수) · detailViews: products/view(상품 상세 조회수 합) · carts: carts/action(장바구니 담긴수 합)
 *     — 조회수 · 장바구니는 기간 합계 API라 최근 funnelDays(기본 14일)만 하루씩 부른다. Analytics 권한이 없으면 0 + 경고.
 *   - products: 상품 + 품목(variants) 가격 · 재고 · promotions: 진행 중 기간 혜택
 *   상품 · 프로모션 스냅샷은 일 수집과 어제를 포함하는 백필 구간에서만 받는다.
 * 반영(apply): 없음 — 판매 채널은 읽기 전용.
 * 보관 한도: 문서는 한 호출 3개월 미만만 정하고 조회 가능 기간 한도는 적지 않아 플랫폼 상한(400일)을 쓴다.
 */
import { z } from 'zod';
import type { ConnectorContext, ConnectorDef, DateRange, NormalizedBatch } from '../types';
import type { Product, Promotion } from '@/core/types';
import { addDaysStr, dateRange, kstToday, nowMs } from '../../lib/time';
import {
  ConfigError, SalesAcc, SalesApiError, clampRange, isoDate, num, softPart, splitRange, testOutcome, warn, wantsSnapshot, type FunnelValues,
} from '../naver-commerce/sales-shared';
import { CAFE24_API_VERSION, CAFE24_LABEL, CAFE24_SCOPES, Cafe24Client, type Cafe24Credentials } from './client';
import { cafe24OrderLine, cafe24Product, cafe24Promotion } from './normalize';

/** 주문 목록 offset 최대값 (문서) */
export const MAX_ORDER_OFFSET = 15_000;

const opt = (min = 1) => z.string().trim().min(min).optional();

export const credentialsSchema = z.object({
  mallId: z.string().trim().transform((v) => v.toLowerCase()).pipe(z.string().regex(/^[a-z0-9][a-z0-9-]{1,49}$/, '쇼핑몰 ID(mall_id)는 영문 소문자 · 숫자입니다')),
  clientId: z.string().trim().min(5, 'Client ID를 입력해 주세요'),
  clientSecret: z.string().trim().min(5, 'Client Secret을 입력해 주세요'),
  redirectUri: z.string().trim().url('Redirect URI는 앱에 등록한 URL 전체입니다').optional(),
  authCode: opt(5),
  refreshToken: opt(5),
  accessToken: opt(5),
  accessTokenExpiresAt: opt(),
  refreshTokenExpiresAt: opt(),
  scopes: z.array(z.string()).optional(),
})
  .refine((c) => !!(c.refreshToken || c.authCode || c.accessToken), { message: '갱신 토큰(refreshToken) 또는 인증 코드(authCode)를 넣어 주세요', path: ['refreshToken'] })
  .refine((c) => !c.authCode || !!c.redirectUri || !!c.refreshToken, { message: '인증 코드를 교환하려면 앱에 등록한 Redirect URI가 필요합니다', path: ['redirectUri'] });

export const settingsSchema = z.object({
  /** 멀티쇼핑몰 번호 */
  shopNo: z.number().int().min(1).default(1),
  /** X-Cafe24-Api-Version (yyyy-mm-dd) */
  apiVersion: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).default(CAFE24_API_VERSION),
  /** 매출 기준: net = 품목별 결제금액(기본) · gross = (판매가 + 옵션가) × 수량 */
  revenueBasis: z.enum(['net', 'gross']).default('net'),
  /** 주문 조회 구간 일수 (문서: 한 호출 3개월 미만) */
  orderWindowDays: z.number().int().min(1).max(60).default(7),
  /** 주문 페이지 크기 (문서 최대 1000) */
  pageSize: z.number().int().min(10).max(1000).default(500),
  /** Cafe24 Analytics(방문자 · 상세 조회 · 장바구니) 수집 */
  fetchAnalytics: z.boolean().default(true),
  /** 상세 조회 · 장바구니를 하루씩 부를 최근 일수 (방문자는 기간 전체) */
  funnelDays: z.number().int().min(0).max(62).default(14),
  fetchProducts: z.boolean().default(true),
  fetchPromotions: z.boolean().default(true),
  productLimit: z.number().int().min(1).max(5000).default(300),
  /** 상품 랜딩 URL 템플릿 — {productNo} · {productCode} (없으면 쇼핑몰 대표 도메인) */
  productUrlTemplate: z.string().url().optional(),
});
export type Cafe24Settings = z.infer<typeof settingsSchema>;

function parseCreds(ctx: ConnectorContext): Cafe24Credentials {
  const r = credentialsSchema.safeParse(ctx.credentials ?? {});
  if (!r.success) throw new ConfigError(`${CAFE24_LABEL} 자격증명을 확인해 주세요: ${r.error.issues.map((i) => i.message).join(', ')}`);
  return r.data as Cafe24Credentials;
}
function parseSettings(ctx: ConnectorContext): Cafe24Settings {
  const r = settingsSchema.safeParse(ctx.settings ?? {});
  return r.success ? r.data : settingsSchema.parse({});
}
export const clientOf = (ctx: ConnectorContext, s: Cafe24Settings) => new Cafe24Client(ctx, parseCreds(ctx), { now: nowMs, apiVersion: s.apiVersion, shopNo: s.shopNo });

/* ------------------------------ 수집 ------------------------------ */

export async function fetchCafe24(ctx: ConnectorContext, range: DateRange, opts: { intradayDate?: string } = {}): Promise<NormalizedBatch> {
  const s = parseSettings(ctx);
  const client = clientOf(ctx, s);
  const today = kstToday();
  const r = opts.intradayDate ? clampRange({ from: opts.intradayDate, to: opts.intradayDate }, today) : clampRange(range, today);
  const batch: NormalizedBatch = { salesDaily: [], warnings: [] };

  if (r) {
    const acc = new SalesAcc();
    const seen = new Set<string>();
    const take = (orders: Awaited<ReturnType<Cafe24Client['orders']>>) => {
      for (const o of orders) {
        if (!o.order_id || seen.has(o.order_id)) continue;
        const line = cafe24OrderLine(o, s.revenueBasis);
        if (!line) continue;
        seen.add(o.order_id);
        acc.add(line.date, line.orderId, line.revenue);
      }
    };
    /** 구간 하나를 offset 페이지로 — 상한에 닿으면 false */
    const scan = async (w: DateRange): Promise<boolean> => {
      for (let offset = 0; offset <= MAX_ORDER_OFFSET; offset += s.pageSize) {
        const rows = await client.orders(w.from, w.to, offset, s.pageSize);
        take(rows);
        if (rows.length < s.pageSize) return true;
      }
      return false;
    };
    for (const w of splitRange(r.from, r.to, s.orderWindowDays)) {
      if (await scan(w)) continue;
      if (w.from === w.to) { warn(batch, 'orders_truncated', `${w.from} 주문이 조회 offset 상한(${MAX_ORDER_OFFSET.toLocaleString('ko-KR')}건)을 넘어 일부만 집계했습니다`); continue; }
      for (const d of dateRange(w.from, w.to)) {
        if (!(await scan({ from: d, to: d }))) warn(batch, 'orders_truncated', `${d} 주문이 조회 offset 상한(${MAX_ORDER_OFFSET.toLocaleString('ko-KR')}건)을 넘어 일부만 집계했습니다`);
      }
    }
    const funnel = s.fetchAnalytics ? await collectFunnel(client, s, r, today, batch) : undefined;
    batch.salesDaily = acc.rows('own_mall', r, funnel);
    if (!s.fetchAnalytics && !opts.intradayDate) warn(batch, 'funnel_disabled', '설정 fetchAnalytics=false — 방문자 · 상세 조회 · 장바구니를 0으로 저장했습니다');
  }

  if (wantsSnapshot(range, opts, today)) {
    let domain: string | undefined;
    if (s.fetchProducts || s.fetchPromotions) {
      try {
        const st = await client.store();
        domain = st.primary_domain || st.base_domain || undefined;
      } catch (e) {
        if (e instanceof SalesApiError && (e.kind === 'rate' || e.kind === 'auth')) throw e;
      }
    }
    if (s.fetchProducts) {
      const products = await softPart(batch, 'products_failed', '상품 · 품목 재고', () => collectProducts(client, s, domain, batch));
      if (products) batch.products = products;
    }
    if (s.fetchPromotions) {
      const promos = await softPart(batch, 'promotions_failed', '혜택(프로모션)', () => collectPromotions(client, today), { allowAuth: true });
      if (promos) batch.promotions = promos;
    }
  }
  if (!batch.warnings?.length) delete batch.warnings;
  return batch;
}

/** 방문자(기간 일별) + 상세 조회 · 장바구니(최근 funnelDays 하루씩). Analytics 권한 · 한도 문제는 경고로 남기고 주문 집계는 살린다 */
async function collectFunnel(client: Cafe24Client, s: Cafe24Settings, r: DateRange, today: string, batch: NormalizedBatch): Promise<Map<string, FunnelValues> | undefined> {
  const m = new Map<string, FunnelValues>();
  const slot = (d: string) => m.get(d) ?? m.set(d, {}).get(d)!;
  try {
    for (const row of await client.analyticsRows('/visitors/view', '방문자수 조회', { start_date: r.from, end_date: r.to, format_type: 'day' }, ['date', 'visit_count'])) {
      const d = isoDate(row.date);
      if (d) slot(d).visitors = num(slot(d).visitors) + num(row.visit_count);
    }
    const from = addDaysStr(today, -(Math.max(1, s.funnelDays) - 1));
    const days = s.funnelDays > 0 ? dateRange(r.from, r.to).filter((d) => d >= from) : [];
    for (const d of days) {
      const views = await client.analyticsRows('/products/view', '상품 조회수 조회', { start_date: d, end_date: d }, ['product_no', 'count']);
      slot(d).detailViews = views.reduce((a, x) => a + num(x.count), 0);
      const carts = await client.analyticsRows('/carts/action', '장바구니 담긴수 조회', { start_date: d, end_date: d }, ['product_no', 'add_cart_count']);
      slot(d).carts = carts.reduce((a, x) => a + num(x.add_cart_count), 0);
    }
    if (r.from < from || s.funnelDays === 0) {
      warn(batch, 'funnel_window', `상세 조회 · 장바구니는 최근 ${s.funnelDays}일(${from} 이후)만 하루씩 조회했습니다 — 그 이전 날짜는 0입니다(Analytics API가 기간 합계만 제공, 설정 funnelDays)`);
    }
    return m;
  } catch (e) {
    if (!(e instanceof SalesApiError)) throw e;
    warn(batch, 'analytics_unavailable', `Cafe24 Analytics 조회 실패 — 방문자 · 상세 조회 · 장바구니를 ${m.size ? '일부만' : '0으로'} 저장했습니다. 앱 권한 범위 mall.read_analytics와 Analytics API 사용 승인(카페24 문서: 승인된 협력사 대상 베타)을 확인하거나 CSV 템플릿으로 채워 주세요: ${e.message}`);
    return m;
  }
}

async function collectProducts(client: Cafe24Client, s: Cafe24Settings, domain: string | undefined, batch: NormalizedBatch): Promise<Product[]> {
  const out: Product[] = [];
  let since: number | undefined;
  let more = false;
  for (let page = 0; page < 100; page++) {
    const rows = await client.products(since, 100);
    for (const p of rows) {
      if (out.length >= s.productLimit) { more = true; break; }
      const prod = cafe24Product(p, { template: s.productUrlTemplate, domain });
      if (prod) out.push(prod);
    }
    const max = rows.length ? Math.max(...rows.map((p) => num(p.product_no))) : NaN;
    if (more || rows.length < 100 || !Number.isFinite(max) || (since !== undefined && max <= since)) break;
    since = max;
    if (out.length >= s.productLimit) { more = true; break; }
  }
  if (more) warn(batch, 'products_truncated', `상품을 설정 productLimit(${s.productLimit})개까지만 받았습니다 — 늘리려면 커넥션 설정을 바꿔 주세요`);
  return out;
}

async function collectPromotions(client: Cafe24Client, today: string): Promise<Promotion[]> {
  const out: Promotion[] = [];
  let details = 0;
  for (let offset = 0; offset <= 8000; offset += 100) {
    const rows = await client.benefits(offset, 100);
    for (const b of rows) {
      let full = b;
      if (b.benefit_type === 'DP' && b.use_benefit_period !== 'F' && b.benefit_no && details < 30) {
        details++;
        try { full = { ...b, ...(await client.benefit(b.benefit_no)) }; } catch (e) { if (e instanceof SalesApiError && e.kind === 'rate') throw e; }
      }
      const p = cafe24Promotion(full, today);
      if (p) out.push(p);
    }
    if (rows.length < 100) break;
  }
  return out;
}

/* ------------------------------ 정의 ------------------------------ */

export const connector: ConnectorDef = {
  provider: 'cafe24',
  kind: 'sales',
  channel: 'own_mall',
  label: '카페24 자사몰',
  docsUrl: 'https://apidocs.cafe24.com/docs/guide/intro',
  verifiedLive: false,
  credentialsSchema,
  settingsSchema,
  credentialFields: [
    { key: 'mallId', label: '쇼핑몰 ID (mall_id)', secret: false, help: '카페24 관리자 로그인 ID와 같은 쇼핑몰 ID. API 주소 https://{mall_id}.cafe24api.com에 들어갑니다' },
    { key: 'clientId', label: '클라이언트 ID (Client ID)', secret: false, help: '카페24 개발자센터 > Apps > 개발정보의 Client ID. 앱 권한 범위에 주문 · 상품 · 상점 · 프로모션 읽기(필요하면 접속통계 mall.read_analytics)를 넣어 주세요' },
    { key: 'clientSecret', label: '클라이언트 시크릿 (Client Secret)', secret: true, help: '같은 화면의 Client Secret. 토큰 발급 · 갱신 요청의 Basic 인증에만 씁니다' },
    { key: 'refreshToken', label: '갱신 토큰 (Refresh Token)', secret: true, optional: true, help: '이미 발급받은 갱신 토큰(2주 유효). 넣으면 서버가 2시간마다 액세스 토큰을 갱신하고 새 갱신 토큰을 자동 저장합니다' },
    { key: 'authCode', label: '인증 코드 (처음 한 번)', secret: true, optional: true, help: `갱신 토큰이 없으면 https://{mall_id}.cafe24api.com/api/v2/oauth/authorize?response_type=code&client_id={Client ID}&state=임의값&redirect_uri={Redirect URI}&scope=${CAFE24_SCOPES.join('+')} 를 브라우저로 열어 승인한 뒤 돌아온 주소의 code 값. 1분 안에 저장하고 바로 연결 확인을 눌러 주세요(1회용)` },
    { key: 'redirectUri', label: '리디렉션 URI (Redirect URI)', secret: false, optional: true, help: '앱에 등록한 Redirect URI 전체 — 인증 코드를 교환할 때 같은 값이 필요합니다' },
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
      await client.accessToken();
      const st = await client.store();
      const y = addDaysStr(kstToday(), -1);
      const orders = (await client.orders(y, y, 0, 100)).filter((o) => o.paid !== 'F' && o.canceled !== 'T');
      const missing = client.scopes.length ? CAFE24_SCOPES.filter((sc) => !client.scopes.includes(sc)) : [];
      const tail = missing.length ? ` · 승인되지 않은 권한: ${missing.join(', ')}${missing.includes('mall.read_analytics') ? ' (방문자 · 상세 조회 · 장바구니는 0으로 저장)' : ''}` : '';
      return {
        ok: true,
        account: `${CAFE24_LABEL} ${st.shop_name ?? client.mallId}`,
        message: `연결 확인 — 쇼핑몰 ${st.shop_name ?? '(이름 없음)'} (${client.mallId}) · 어제 결제 주문 ${orders.length}건${orders.length >= 100 ? ' 이상' : ''}${tail}. 액세스 토큰은 만료 전 자동 갱신합니다`,
      };
    });
  },
  fetch: (ctx, range, opts) => fetchCafe24(ctx, range, opts),
};
