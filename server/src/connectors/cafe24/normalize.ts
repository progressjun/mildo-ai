/**
 * 카페24 응답 → 표준 레코드 (판매 채널 own_mall).
 *
 * 주문 규칙 — 근거: 주문 목록 조회 · 주문 품주 목록 조회 문서
 *   - date_type=pay_date로 결제일 구간을 조회하고 payment_date(+09:00)의 KST 날짜로 묶는다.
 *   - 주문 제외: paid='F'(미결제) · canceled='T'(전체 취소).
 *   - 마켓 연동 주문 제외(설정 excludeMarketOrders, 기본 켬): 주문경로 order_place_id가 문서의 마켓 값
 *     (inpark · auction · sk11st · gmarket · coupang · shopn)이면 자사몰 매출이 아니다 — 쿠팡 · 스마트스토어 주문은 각 채널 커넥터가 따로 세므로
 *     카페24 마켓통합관리로 들어온 같은 주문을 자사몰에 또 넣으면 두 번 센다. cafe24 · mobile · mobile_d · NCHECKOUT(네이버페이 결제)은 자사몰 주문.
 *   - 품주(embed=items) 제외: status_code C1(입금전취소) · C2(배송전취소) · C3(반품). N1 정상 · N2 교환상품 · E1 교환은 매출에 남긴다.
 *     교환 한 건은 원래 품주(E1)와 새 품주(N2, original_item_no = 원래 품주 아이디)가 함께 남는다 — 같은 판매를 두 번 세지 않도록
 *     짝을 이룬 두 품주는 금액이 큰 쪽 하나만 센다(문서가 두 품주의 결제금액 배분을 정하지 않아, 같은 값이 둘 다 실려도 · 한쪽만 실려도 맞도록).
 *   - 매출 기준(설정 revenueBasis): net = 품목별 결제금액(payment_amount) 합 · gross = (상품 판매가 + 옵션 추가 가격) × 수량 합.
 *     품주가 없으면 주문의 현재 주문 금액(actual_order_amount: net은 payment_amount, gross는 order_price_amount)을 쓴다.
 */
import type { Product, Promotion } from '@/core/types';
import type { Cafe24Benefit, Cafe24Order, Cafe24OrderItem, Cafe24Product } from './client';
import { fillTemplate, kstDateOf, krw, num, promotionStatus, safeLanding } from '../naver-commerce/sales-shared';

export const EXCLUDED_ITEM_STATUS = new Set(['C1', 'C2', 'C3']);
/** 주문경로(order_place_id) 중 오픈마켓 · 다른 판매 채널 (문서 값) */
export const MARKET_ORDER_PLACES = new Set(['inpark', 'auction', 'sk11st', 'gmarket', 'coupang', 'shopn']);

export const isMarketOrder = (o: Cafe24Order) => MARKET_ORDER_PLACES.has(String(o.order_place_id ?? '').trim().toLowerCase());

const idList = (v: Cafe24OrderItem['original_item_no']) => (Array.isArray(v) ? v : v === undefined || v === null || v === '' ? [] : [v]).map(String);

/** 품주 금액 합 — 교환 짝(E1 원래 품주 + N2 새 품주)은 큰 쪽 하나만 */
function itemsRevenue(items: Cafe24OrderItem[], basis: 'net' | 'gross'): number {
  const value = (it: Cafe24OrderItem) => (basis === 'net' ? num(it.payment_amount) : (num(it.product_price) + num(it.option_price)) * num(it.quantity));
  const byNo = new Map(items.filter((it) => it.item_no !== undefined && it.item_no !== null).map((it) => [String(it.item_no), it]));
  const paired = new Set<Cafe24OrderItem>();
  let total = 0;
  for (const it of items) {
    if (String(it.status_code ?? '') !== 'N2') continue;
    const originals = idList(it.original_item_no).map((n) => byNo.get(n)).filter((o): o is Cafe24OrderItem => !!o && String(o.status_code ?? '') === 'E1' && !paired.has(o));
    if (!originals.length) continue;
    paired.add(it);
    originals.forEach((o) => paired.add(o));
    total += Math.max(value(it), ...originals.map(value));
  }
  for (const it of items) if (!paired.has(it)) total += value(it);
  return total;
}

export interface Cafe24Line { date: string; orderId: string; revenue: number; items: number }

export function cafe24OrderLine(o: Cafe24Order, basis: 'net' | 'gross'): Cafe24Line | null {
  if (o.paid === 'F' || o.canceled === 'T') return null;
  const date = kstDateOf(o.payment_date);
  if (!date || !o.order_id) return null;
  const items = Array.isArray(o.items) ? o.items : null;
  if (items && items.length) {
    const kept = items.filter((it) => !EXCLUDED_ITEM_STATUS.has(String(it.status_code ?? '')) && num(it.quantity) > 0);
    if (!kept.length) return null;
    return { date, orderId: o.order_id, revenue: krw(itemsRevenue(kept, basis)), items: kept.length };
  }
  const a = o.actual_order_amount ?? {};
  const revenue = basis === 'net' ? num(a.payment_amount ?? o.payment_amount) : num(a.order_price_amount);
  return revenue > 0 ? { date, orderId: o.order_id, revenue: krw(revenue), items: 0 } : null;
}

export const productEntityId = (productNo: number | string) => `c24-${productNo}`;

/** 상품 엔티티. 옵션 = 품목(variants): 가격 = 상품 판매가 + 품목 추가금액, 재고 = 판매함 · (재고 미사용이거나 수량 > 0) */
export function cafe24Product(p: Cafe24Product, o: { template?: string; domain?: string }): Product | null {
  if (p.product_no === undefined || p.product_no === null) return null;
  const base = krw(p.price);
  const selling = p.selling !== 'F';
  const variants = Array.isArray(p.variants) ? p.variants : [];
  const options = variants.length
    ? variants.map((v, i) => ({
      id: String(v.variant_code ?? i),
      label: (v.options ?? []).map((x) => x?.value).filter(Boolean).join(' / ') || '기본',
      price: base + krw(v.additional_amount),
      inStock: selling && v.selling !== 'F' && (v.use_inventory !== 'T' || num(v.quantity) > 0),
    }))
    : [{ id: String(p.product_code ?? p.product_no), label: '기본', price: base, inStock: selling }];
  const landing = safeLanding(fillTemplate(o.template, { productNo: p.product_no, productCode: p.product_code ?? '', id: p.product_no }, o.domain ? `https://${o.domain}` : ''));
  return { id: productEntityId(p.product_no), name: String(p.product_name ?? p.product_no), options, landing };
}

export const benefitName = (b: Cafe24Benefit) => b.benefit_name ?? `혜택 ${b.benefit_no}`;

/**
 * 혜택 → 프로모션. 진행 중(use_benefit=T)이고 기간이 정해진(use_benefit_period=T, 시작 · 종료일) 혜택 중
 * 할인율(%)이 정해진 것만: 기간할인(DP)의 period_sale.discount_value_unit이 P(비율)면 그 값.
 * 금액(W) 할인 · 사은품 · 배송비 할인 등은 판매가 대비 %가 없어 { skipped } — 호출한 쪽이 경고(promotions_skipped)로 남긴다.
 */
export function cafe24Promotion(b: Cafe24Benefit, today: string): Promotion | { skipped: string } | null {
  if (!b.benefit_no || b.use_benefit === 'F') return null;
  const start = kstDateOf(b.benefit_start_date);
  const end = kstDateOf(b.benefit_end_date);
  if (b.use_benefit_period === 'F' || !start || !end) return null;
  const ps = Array.isArray(b.period_sale) ? b.period_sale[0] : b.period_sale ?? undefined;
  const rate = ps?.discount_value_unit === 'P' ? num(ps.discount_value) : 0;
  if (!(rate > 0 && rate < 100)) {
    const amount = ps?.discount_value_unit === 'W' ? krw(ps.discount_value) : 0;
    return { skipped: `${benefitName(b)}${amount ? ` (정액 ${amount.toLocaleString('ko-KR')}원)` : b.benefit_type ? ` (${b.benefit_type})` : ''}` };
  }
  return {
    id: `c24-benefit-${b.benefit_no}`,
    name: benefitName(b),
    channel: 'own_mall',
    start, end,
    discountRate: rate,
    status: promotionStatus(start, end, today),
  };
}
