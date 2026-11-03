/**
 * 네이버 커머스API 응답 → 표준 레코드 (판매 채널 brandstore).
 *
 * 상품 주문 상태(productOrderStatus, 조건형 상품 주문 조회 문서의 코드표):
 *   PAYMENT_WAITING 결제 대기 · PAYED 결제 완료 · DELIVERING 배송 중 · DELIVERED 배송 완료 · PURCHASE_DECIDED 구매 확정 ·
 *   EXCHANGED 교환 · CANCELED 취소 · RETURNED 반품 · CANCELED_BY_NOPAYMENT 미결제 취소
 *   → 매출에서 빼는 상태: CANCELED · RETURNED · CANCELED_BY_NOPAYMENT · PAYMENT_WAITING(결제 전)
 *   취소 · 반품 요청 중(claimStatus CANCEL_REQUEST · RETURN_REQUEST 등)은 아직 완료가 아니라 매출에 남긴다(완료되면 다음 재수집에서 빠진다).
 * 수량 클레임(부분 취소 · 반품): quantityClaimCompatibility=true로 부르고, 잔여 값(remainQuantity · remainPaymentAmount ·
 *   remainProductAmount)이 있으면 그것을 쓴다. 잔여 수량 0이면 제외.
 * 금액 기준(설정 revenueBasis):
 *   net   = 잔여(없으면 최초) 결제 금액 — 할인 적용 후 상품 결제 금액(배송비 별도 필드 deliveryFeeAmount는 넣지 않음)
 *   gross = 잔여(없으면 최초) 주문 금액 — 할인 적용 전 상품 금액
 * 날짜: order.paymentDate(결제 일시, +09:00)의 KST 날짜. 없으면 orderDate.
 * 주문 수: 같은 주문번호(orderId)의 상품 주문은 1건으로 센다.
 * 광고 경유 매출(추정): productOrder.inflowPath(유입 경로: 검색광고(SA) · 공동구매 · 밴드 · 네이버 쇼핑 · 네이버 쇼핑 외)가
 *   설정 adInflowPatterns(기본 '검색광고')를 포함하는 상품 주문의 매출. 네이버 검색광고 유입만 잡히는 근사치다.
 */
import type { Product, Promotion } from '@/core/types';
import type { NaverChannelProduct, NaverOptionCombination, NaverOriginProduct, NaverProductOrderContent } from './client';
import { fillTemplate, kstDateOf, krw, num, promotionStatus, safeLanding } from './sales-shared';

export const EXCLUDED_ORDER_STATUSES = new Set(['CANCELED', 'RETURNED', 'CANCELED_BY_NOPAYMENT', 'PAYMENT_WAITING']);

export interface NaverOrderLine {
  date: string;
  orderId: string;
  productOrderId: string;
  revenue: number;
  quantity: number;
  adAttributed: boolean;
}

export type ExcludeReason = 'status' | 'zero_quantity' | 'no_date';

/** 상품 주문 하나 → 매출 행 (제외면 사유) */
export function naverOrderLine(c: NaverProductOrderContent, basis: 'net' | 'gross', adPatterns: string[]): NaverOrderLine | { excluded: ExcludeReason; status?: string } {
  const po = c.content?.productOrder ?? {};
  const order = c.content?.order ?? {};
  const status = String(po.productOrderStatus ?? '');
  if (EXCLUDED_ORDER_STATUSES.has(status)) return { excluded: 'status', status };
  const qty = po.remainQuantity ?? po.quantity ?? po.initialQuantity ?? 0;
  if (num(qty) <= 0) return { excluded: 'zero_quantity', status };
  const date = kstDateOf(order.paymentDate ?? order.orderDate);
  if (!date) return { excluded: 'no_date', status };
  const net = po.remainPaymentAmount ?? po.totalPaymentAmount ?? po.initialPaymentAmount;
  const gross = po.remainProductAmount ?? po.totalProductAmount ?? po.initialProductAmount ?? (num(po.unitPrice) + num(po.optionPrice)) * num(qty);
  const revenue = krw(basis === 'net' ? net ?? gross : gross);
  const inflow = String(po.inflowPath ?? '');
  return {
    date,
    orderId: String(order.orderId ?? po.productOrderId ?? c.productOrderId ?? ''),
    productOrderId: String(po.productOrderId ?? c.productOrderId ?? ''),
    revenue,
    quantity: num(qty),
    adAttributed: !!inflow && adPatterns.some((p) => p && inflow.includes(p)),
  };
}

export const isLine = (x: NaverOrderLine | { excluded: ExcludeReason }): x is NaverOrderLine => !('excluded' in x);

/* ---------------- 상품 ---------------- */

export const productEntityId = (originProductNo: number | string) => `ncm-${originProductNo}`;

/** 상품 목록의 채널 상품 중 스마트스토어(STOREFARM) 채널을 우선 고른다 */
export function pickChannelProduct(list: NaverChannelProduct[] | undefined): NaverChannelProduct | null {
  const arr = Array.isArray(list) ? list : [];
  return arr.find((c) => c.channelServiceType === 'STOREFARM') ?? arr[0] ?? null;
}

const sellable = (status: string | undefined) => status === 'SALE';

function comboLabel(c: NaverOptionCombination): string {
  return [c.optionName1, c.optionName2, c.optionName3, c.optionName4].filter((x) => x && String(x).trim()).join(' / ') || `옵션 ${c.id ?? ''}`.trim();
}

/**
 * 상품 엔티티. 옵션 가격 = 판매가(salePrice) + 조합형 옵션가(price). 할인가는 프로모션(즉시 할인)으로 따로 둔다
 * (Product.options.price는 기획전 할인 전 판매가 — Flow 엔진이 판매가 × (1 − 할인율)로 표기가를 검사).
 * 재고: 조합형 · 표준형 옵션의 stockQuantity > 0 이고 usable, 상품 판매 상태가 SALE일 때 inStock.
 */
export function naverProduct(
  originProductNo: number | string,
  cp: NaverChannelProduct,
  detail: NaverOriginProduct | null,
  o: { landing: string },
): Product {
  const op = detail?.originProduct;
  const status = op?.statusType ?? cp.statusType;
  const base = krw(op?.salePrice ?? cp.salePrice);
  const name = String(detail?.smartstoreChannelProduct?.channelProductName || cp.name || op?.name || `상품 ${originProductNo}`);
  const info = op?.detailAttribute?.optionInfo;
  const combos = info?.optionCombinations ?? [];
  const standards = info?.optionStandards ?? [];
  let options: Product['options'];
  if (combos.length) {
    options = combos.map((c) => ({ id: String(c.id ?? comboLabel(c)), label: comboLabel(c), price: base + krw(c.price), inStock: sellable(status) && c.usable !== false && num(c.stockQuantity) > 0 }));
  } else if (standards.length) {
    options = standards.map((c) => ({ id: String(c.id ?? comboLabel(c)), label: comboLabel(c), price: base, inStock: sellable(status) && c.usable !== false && num(c.stockQuantity) > 0 }));
  } else {
    const stock = op?.stockQuantity ?? cp.stockQuantity;
    options = [{ id: String(cp.channelProductNo ?? originProductNo), label: '단일 상품', price: base, inStock: sellable(status) && num(stock) > 0 }];
  }
  return { id: productEntityId(originProductNo), name, options, landing: o.landing };
}

/** 랜딩: 템플릿(https만) → 채널 URL(채널 정보 API) 순. https가 아니면 빈 값 */
export function landingOf(template: string | undefined, channelUrl: string | undefined, cp: NaverChannelProduct, originProductNo: number | string): string {
  return safeLanding(fillTemplate(template, { channelProductNo: cp.channelProductNo ?? '', originProductNo, id: cp.channelProductNo ?? originProductNo }, safeLanding(channelUrl)));
}

/**
 * 즉시 할인(판매자 기본 할인) → 프로모션. 시작 · 종료일이 모두 있는 기간 할인만 (상시 할인은 기간이 없어 프로모션 일정으로 보지 않는다).
 * 할인율(%): PERCENT면 값 그대로, WON이면 판매가 대비 비율(소수 첫째 자리).
 */
export function naverPromotion(originProductNo: number | string, productName: string, detail: NaverOriginProduct | null, today: string): Promotion | null {
  const op = detail?.originProduct;
  const dm = op?.customerBenefit?.immediateDiscountPolicy?.discountMethod;
  if (!dm || !dm.startDate || !dm.endDate) return null;
  const start = kstDateOf(dm.startDate);
  const end = kstDateOf(dm.endDate);
  if (!start || !end) return null;
  const price = num(op?.salePrice);
  const value = num(dm.value);
  let rate = 0;
  if (dm.unitType === 'PERCENT') rate = value;
  else if (dm.unitType === 'WON' && price > 0) rate = Math.round((value / price) * 1000) / 10;
  else return null; // YEN · COUNT는 국내 판매가 할인율로 해석할 수 없다
  const adCopyPrice = price > 0 ? krw(dm.unitType === 'PERCENT' ? price * (1 - value / 100) : price - value) : undefined;
  return {
    id: `ncm-promo-${originProductNo}`,
    name: `${productName} 즉시 할인`,
    channel: 'brandstore',
    start, end,
    discountRate: rate,
    ...(adCopyPrice !== undefined ? { adCopyPrice } : {}),
    status: promotionStatus(start, end, today),
  };
}
