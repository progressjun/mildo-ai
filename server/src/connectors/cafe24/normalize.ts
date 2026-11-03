/**
 * 카페24 응답 → 표준 레코드 (판매 채널 own_mall).
 *
 * 주문 규칙 — 근거: 주문 목록 조회 · 주문 품주 목록 조회 문서
 *   - date_type=pay_date로 결제일 구간을 조회하고 payment_date(+09:00)의 KST 날짜로 묶는다.
 *   - 주문 제외: paid='F'(미결제) · canceled='T'(전체 취소).
 *   - 품주(embed=items) 제외: status_code C1(입금전취소) · C2(배송전취소) · C3(반품). N1 정상 · N2 교환상품 · E1 교환은 매출에 남긴다.
 *   - 매출 기준(설정 revenueBasis): net = 품목별 결제금액(payment_amount) 합 · gross = (상품 판매가 + 옵션 추가 가격) × 수량 합.
 *     품주가 없으면 주문의 현재 주문 금액(actual_order_amount: net은 payment_amount, gross는 order_price_amount)을 쓴다.
 */
import type { Product, Promotion } from '@/core/types';
import type { Cafe24Benefit, Cafe24Order, Cafe24Product } from './client';
import { fillTemplate, kstDateOf, krw, num, promotionStatus } from '../naver-commerce/sales-shared';

export const EXCLUDED_ITEM_STATUS = new Set(['C1', 'C2', 'C3']);

export interface Cafe24Line { date: string; orderId: string; revenue: number; items: number }

export function cafe24OrderLine(o: Cafe24Order, basis: 'net' | 'gross'): Cafe24Line | null {
  if (o.paid === 'F' || o.canceled === 'T') return null;
  const date = kstDateOf(o.payment_date);
  if (!date || !o.order_id) return null;
  const items = Array.isArray(o.items) ? o.items : null;
  if (items && items.length) {
    const kept = items.filter((it) => !EXCLUDED_ITEM_STATUS.has(String(it.status_code ?? '')) && num(it.quantity) > 0);
    if (!kept.length) return null;
    const revenue = kept.reduce((s, it) => s + (basis === 'net' ? num(it.payment_amount) : (num(it.product_price) + num(it.option_price)) * num(it.quantity)), 0);
    return { date, orderId: o.order_id, revenue: krw(revenue), items: kept.length };
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
  const landing = fillTemplate(o.template, { productNo: p.product_no, productCode: p.product_code ?? '', id: p.product_no }, o.domain ? `https://${o.domain}` : '');
  return { id: productEntityId(p.product_no), name: String(p.product_name ?? p.product_no), options, landing };
}

/**
 * 혜택 → 프로모션. 진행 중(use_benefit=T)이고 기간이 정해진(use_benefit_period=T, 시작 · 종료일) 혜택만.
 * 할인율(%): 기간할인(DP)의 period_sale.discount_value_unit이 P(비율)면 그 값, 금액(W)이거나 다른 유형이면 0.
 */
export function cafe24Promotion(b: Cafe24Benefit, today: string): Promotion | null {
  if (!b.benefit_no || b.use_benefit === 'F') return null;
  const start = kstDateOf(b.benefit_start_date);
  const end = kstDateOf(b.benefit_end_date);
  if (b.use_benefit_period === 'F' || !start || !end) return null;
  const ps = Array.isArray(b.period_sale) ? b.period_sale[0] : b.period_sale ?? undefined;
  const rate = ps?.discount_value_unit === 'P' ? num(ps.discount_value) : 0;
  const amount = ps?.discount_value_unit === 'W' ? krw(ps.discount_value) : 0;
  return {
    id: `c24-benefit-${b.benefit_no}`,
    name: `${b.benefit_name ?? `혜택 ${b.benefit_no}`}${amount ? ` (정액 ${amount.toLocaleString('ko-KR')}원)` : ''}`,
    channel: 'own_mall',
    start, end,
    discountRate: rate,
    status: promotionStatus(start, end, today),
  };
}
