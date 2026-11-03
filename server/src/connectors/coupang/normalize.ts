/**
 * 쿠팡 Wing 응답 → 표준 레코드 (판매 채널 coupang).
 *
 * 주문(발주서) 규칙 — 근거: 발주서 목록 조회(일단위 페이징) 문서
 *   - 순수량 = shippingCount − (holdCountForCancel + cancelCount) ("발주 가능 수량" 정의). 0 이하이거나 canceled=true면 제외.
 *   - 반품 완료 건은 발주서 목록에서 조회되지 않으므로 다음 재수집(일 수집은 최근 3일)에서 자연히 빠진다.
 *   - 매출 기준(설정 revenueBasis): gross = salesPrice(개당 상품 가격) × 순수량,
 *     net = gross − discountPrice(총 할인 = 즉시할인 쿠폰 + 다운로드 쿠폰 + 쿠팡 지원 할인) × 순수량 / shippingCount
 *   - 날짜: paidAt(결제 일시, ISO 8601 오프셋 포함)의 KST 날짜. 없으면 orderedAt. 주문 수는 orderId 기준.
 */
import type { Product, Promotion } from '@/core/types';
import type { CoupangCoupon, CoupangOrderSheet, CoupangProductDetail, CoupangInventory } from './client';
import { money } from './client';
import { fillTemplate, isoDate, kstDateOf, krw, num, promotionStatus } from '../naver-commerce/sales-shared';

export interface CoupangLine { date: string; orderId: string; key: string; revenue: number; quantity: number }

export function coupangLines(sheet: CoupangOrderSheet, basis: 'net' | 'gross'): { lines: CoupangLine[]; excluded: number } {
  const date = kstDateOf(sheet.paidAt ?? sheet.orderedAt);
  const lines: CoupangLine[] = [];
  let excluded = 0;
  const orderId = String(sheet.orderId ?? sheet.shipmentBoxId ?? '');
  for (const [i, it] of (sheet.orderItems ?? []).entries()) {
    const shipping = num(it.shippingCount);
    const qty = shipping - num(it.holdCountForCancel) - num(it.cancelCount);
    if (!date || it.canceled === true || qty <= 0 || shipping <= 0) { excluded++; continue; }
    const unit = money(it.salesPrice);
    const gross = unit * qty;
    const discount = money(it.discountPrice) * (qty / shipping);
    lines.push({
      date, orderId,
      key: `${sheet.shipmentBoxId ?? orderId}|${it.vendorItemId ?? i}`,
      revenue: krw(basis === 'net' ? Math.max(0, gross - discount) : gross),
      quantity: qty,
    });
  }
  return { lines, excluded };
}

export const productEntityId = (sellerProductId: number | string) => `cpg-${sellerProductId}`;

/**
 * 상품 엔티티. 옵션 = 상품 조회의 items(vendorItemId · itemName · salePrice).
 * 재고: 옵션별 수량/가격/상태 조회 결과가 있으면 onSale && amountInStock > 0 · 판매가는 그 salePrice. 없으면 상품 조회의 maximumBuyCount(판매가능수량) > 0.
 */
export function coupangProduct(detail: CoupangProductDetail['data'], inv: Map<string, CoupangInventory['data']>, landing: string): Product | null {
  if (!detail?.sellerProductId) return null;
  const options = (detail.items ?? []).map((it, i) => {
    const vid = it.vendorItemId !== undefined && it.vendorItemId !== null ? String(it.vendorItemId) : null;
    const v = vid ? inv.get(vid) : undefined;
    return {
      id: vid ?? String(it.sellerProductItemId ?? i),
      label: String(it.itemName ?? `옵션 ${i + 1}`),
      price: krw(v?.salePrice ?? it.salePrice),
      inStock: v ? v.onSale !== false && num(v.amountInStock) > 0 : num(it.maximumBuyCount) > 0,
    };
  });
  return { id: productEntityId(detail.sellerProductId), name: String(detail.sellerProductName ?? detail.displayProductName ?? detail.sellerProductId), options, landing };
}

export function landingOf(template: string | undefined, fromOrders: string | undefined, sellerProductId: number | string, productId?: number | string): string {
  return fromOrders || fillTemplate(template, { sellerProductId, productId: productId ?? '', id: sellerProductId });
}

/**
 * 즉시할인 쿠폰 → 프로모션. 할인율(%): type RATE면 discount 그대로. PRICE · FIXED_WITH_QUANTITY(정액)는 판매가 대비 비율을 정할 수 없어 0으로 두고 이름에 금액을 적는다.
 * 기간: startAt · endAt('yyyy-MM-dd HH:mm:ss')의 날짜 부분. 상태: 쿠폰 APPLIED · STANDBY와 기간으로 판정.
 */
export function coupangPromotion(c: CoupangCoupon, today: string): Promotion | null {
  const start = isoDate(c.startAt);
  const end = isoDate(c.endAt);
  if (!c.couponId || !start || !end) return null;
  const isRate = c.type === 'RATE';
  const name = c.promotionName || `즉시할인 쿠폰 ${c.couponId}`;
  const byDate = promotionStatus(start, end, today);
  return {
    id: `cpg-coupon-${c.couponId}`,
    name: isRate ? name : `${name} (정액 ${krw(c.discount).toLocaleString('ko-KR')}원)`,
    channel: 'coupang',
    start, end,
    discountRate: isRate ? num(c.discount) : 0,
    status: c.status === 'STANDBY' && byDate === 'live' ? 'planned' : byDate,
  };
}
