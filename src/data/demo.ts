/**
 * 시연용 테스트 데이터 생성기 (DEMO — 실제 성과 데이터 아님).
 * - 시드 고정: 같은 기준일이면 항상 같은 데이터
 * - 규모: RFP 연 예산 약 50억 → 제안서 p.37 매체 배분 가안 기준으로 일 광고비를 맞춤
 * - 실데이터 연동 시 이 모듈 대신 커넥터(Pro-board 수집)가 Dataset을 채운다.
 */
import type {
  AdAccount, Campaign, Dataset, DailyMediaRow, DailySalesRow, HourlyMediaRow, IntentId, Keyword,
  KeywordStats, MediaId, Product, Promotion, SalesChannelId, SearchTermRow,
} from '@/core/types';
import { MEDIA, MEDIA_IDS, SALES_CHANNEL_IDS } from './constants';
import { addDays, hashString, rng, sum, weekday } from '@/core/util';

/** 기준일 (고정): 2026-10-31(토) 15시 — PT 시연 기준 */
export const DEMO_TODAY = '2026-10-31';
export const DEMO_HOUR = 15;
const DAYS = 120;

/** 매체별 데모 효율 가정 (ROAS %, CPC 원, CVR %, 객단가 원) */
const MEDIA_PROFILE: Record<MediaId, { roas: number; cpc: number; cvr: number; aov: number; ctr: number; newShare: number }> = {
  naver_sa: { roas: 560, cpc: 820, cvr: 1.25, aov: 1_090_000, ctr: 2.4, newShare: 0.62 },
  naver_gfa: { roas: 270, cpc: 410, cvr: 0.34, aov: 1_020_000, ctr: 0.55, newShare: 0.81 },
  google: { roas: 310, cpc: 690, cvr: 0.62, aov: 1_040_000, ctr: 1.6, newShare: 0.78 },
  meta: { roas: 240, cpc: 520, cvr: 0.48, aov: 980_000, ctr: 1.1, newShare: 0.84 },
  kakao: { roas: 300, cpc: 380, cvr: 0.39, aov: 990_000, ctr: 0.7, newShare: 0.35 },
  vertical: { roas: 420, cpc: 560, cvr: 1.05, aov: 950_000, ctr: 1.3, newShare: 0.55 },
};

/** 시간대 가중치 (0~23시) — 매트리스: 저녁 21~23시 피크 */
const HOUR_WEIGHT = [
  0.9, 0.6, 0.35, 0.22, 0.18, 0.25, 0.5, 0.95, 1.35, 1.6, 1.75, 1.8,
  1.85, 1.95, 1.9, 1.85, 1.8, 1.75, 1.7, 1.95, 2.3, 2.6, 2.55, 1.7,
];
const HOUR_SUM = HOUR_WEIGHT.reduce((a, b) => a + b, 0);
/** 요일 가중치 (일~토) — 일·월 강세 */
const WEEKDAY_WEIGHT = [1.18, 1.12, 1.02, 0.98, 0.95, 0.86, 0.89];

function seasonality(date: string): number {
  // 10월 중순 이후 가을 이사·혼수 수요 + 11월 대형 행사 전 완만한 상승
  const d = new Date(date);
  const m = d.getMonth() + 1;
  const day = d.getDate();
  let s = 1;
  if (m === 7) s = 0.93;
  if (m === 8) s = 0.9 + day * 0.002;
  if (m === 9) s = 1.0 + (day < 20 ? 0.04 : -0.03); // 추석 전후
  if (m === 10) s = 1.02 + day * 0.003;
  return s;
}

function emptyStats(): KeywordStats {
  return { impressions: 0, clicks: 0, cost: 0, conversions: 0, revenue: 0 };
}

export function generateDemoData(today = DEMO_TODAY, currentHour = DEMO_HOUR): Dataset {
  const R = rng(hashString(`mildo-${today}`));
  const dates: string[] = [];
  for (let i = DAYS - 1; i >= 0; i--) dates.push(addDays(today, -i));

  /* ---------------- 매체 일별 ---------------- */
  const mediaDaily: DailyMediaRow[] = [];
  const dailySpendTarget = (m: MediaId) => MEDIA[m].annualBudget / 365;
  for (const date of dates) {
    const wd = weekday(date);
    const season = seasonality(date);
    const isToday = date === today;
    const dayFraction = isToday ? sum(HOUR_WEIGHT.slice(0, currentHour + 1), (x) => x) / HOUR_SUM : 1;
    for (const m of MEDIA_IDS) {
      const p = MEDIA_PROFILE[m];
      const spend = dailySpendTarget(m) * WEEKDAY_WEIGHT[wd] * season * R.noise(0.07) * dayFraction;
      const cpc = p.cpc * R.noise(0.05);
      const clicks = spend / cpc;
      const imps = clicks / (p.ctr / 100) * R.noise(0.05);
      // 효율은 요일·노이즈에 따라 변동
      const roas = p.roas * R.noise(0.12) * (wd === 0 || wd === 1 ? 1.05 : 1);
      const revenue = (spend * roas) / 100;
      const conversions = Math.max(0, revenue / (p.aov * R.noise(0.05)));
      mediaDaily.push({
        date, media: m,
        impressions: Math.round(imps), clicks: Math.round(clicks), cost: Math.round(spend),
        conversions: Math.round(conversions * 10) / 10, revenue: Math.round(revenue),
        newCustomers: Math.round(conversions * p.newShare * R.noise(0.08)),
      });
    }
  }

  /* ---------------- 매체 시간별 (최근 35일) ---------------- */
  const mediaHourly: HourlyMediaRow[] = [];
  const hourlyDates = dates.slice(-35);
  for (const date of hourlyDates) {
    const wd = weekday(date);
    for (const m of MEDIA_IDS) {
      const day = mediaDaily.find((r) => r.date === date && r.media === m)!;
      const maxHour = date === today ? currentHour : 23;
      const wsum = sum(HOUR_WEIGHT.slice(0, maxHour + 1), (x) => x);
      for (let h = 0; h <= maxHour; h++) {
        const w = (HOUR_WEIGHT[h] / wsum) * R.noise(0.1);
        const cvrShift = h >= 20 && h <= 23 ? 1.15 : h <= 5 ? 0.6 : 1;
        mediaHourly.push({
          date, hour: h, weekday: wd, media: m,
          impressions: Math.round(day.impressions * w),
          clicks: Math.round(day.clicks * w),
          cost: Math.round(day.cost * w),
          conversions: Math.round(day.conversions * w * cvrShift * 100) / 100,
          revenue: Math.round(day.revenue * w * cvrShift),
        });
      }
    }
  }

  /* ---------------- 테스트 이상 주입 (오늘) ----------------
   * 시연용: 오늘 14~15시 Meta 광고비 급등(+68%), 카카오 전환 급감(-100%)
   * → MILDO Alert가 '테스트 데이터'로 탐지하도록.
   */
  for (const row of mediaHourly) {
    if (row.date !== today) continue;
    if (row.media === 'meta' && row.hour >= 14) {
      row.cost = Math.round(row.cost * 1.68);
      row.clicks = Math.round(row.clicks * 1.55);
      row.conversions = Math.round(row.conversions * 0.7 * 100) / 100;
      row.revenue = Math.round(row.revenue * 0.7);
    }
    if (row.media === 'kakao' && row.hour >= 13) {
      row.conversions = 0;
      row.revenue = 0;
    }
  }
  // 오늘 일 합계를 시간별 합으로 다시 맞춘다
  for (const m of MEDIA_IDS) {
    const rows = mediaHourly.filter((r) => r.date === today && r.media === m);
    const d = mediaDaily.find((r) => r.date === today && r.media === m)!;
    d.cost = sum(rows, (r) => r.cost);
    d.clicks = sum(rows, (r) => r.clicks);
    d.impressions = sum(rows, (r) => r.impressions);
    d.conversions = Math.round(sum(rows, (r) => r.conversions) * 10) / 10;
    d.revenue = sum(rows, (r) => r.revenue);
  }

  /* ---------------- 판매 채널 일별 (실매출) ---------------- */
  const salesDaily: DailySalesRow[] = [];
  const channelShare: Record<SalesChannelId, number> = { brandstore: 0.52, ohouse: 0.2, coupang: 0.16, own_mall: 0.12 };
  const channelCvr: Record<SalesChannelId, number> = { brandstore: 2.1, ohouse: 1.6, coupang: 2.4, own_mall: 1.1 };
  for (const date of dates) {
    const adRev = sum(mediaDaily.filter((r) => r.date === date), (r) => r.revenue);
    const organicMult = 1.42 * R.noise(0.05); // 광고 외 오가닉 포함 총매출 = 광고 경유 × 1.42 (데모 가정)
    for (const c of SALES_CHANNEL_IDS) {
      const revenue = adRev * organicMult * channelShare[c] * R.noise(0.06);
      const orders = revenue / (1_030_000 * R.noise(0.04));
      const visitors = orders / (channelCvr[c] / 100) * R.noise(0.05);
      const detailViews = visitors * R.range(0.52, 0.6);
      const carts = detailViews * R.range(0.085, 0.11);
      salesDaily.push({
        date, channel: c,
        visitors: Math.round(visitors), detailViews: Math.round(detailViews), carts: Math.round(carts),
        orders: Math.round(orders), revenue: Math.round(revenue),
        adAttributedRevenue: Math.round(revenue / organicMult),
      });
    }
  }

  /* ---------------- 브랜드 검색량 (DA → SA 분석용) ----------------
   * 브랜드 검색량 = 기저 + GFA 집행 강도에 1~2일 시차로 동행 (데모 가정)
   */
  const brandSearchDaily = dates.map((date, i) => {
    const gfa = (d: string) => mediaDaily.find((r) => r.date === d && r.media === 'naver_gfa')?.cost ?? 0;
    const lag1 = i >= 1 ? gfa(dates[i - 1]) : gfa(date);
    const lag2 = i >= 2 ? gfa(dates[i - 2]) : lag1;
    const base = 2600 * WEEKDAY_WEIGHT[weekday(date)] * seasonality(date);
    const volume = base + (lag1 * 0.6 + lag2 * 0.4) / 1350 * R.noise(0.08);
    return { date, volume: Math.round(volume) };
  });

  /* ---------------- 키워드 (네이버 SA) ---------------- */
  const kwSeeds: { text: string; intent: IntentId; search: number; brand?: boolean; profile: 'star' | 'normal' | 'weak' | 'test' | 'new' }[] = [
    { text: '수면밀도', intent: 'brand', search: 41000, brand: true, profile: 'star' },
    { text: '밀도 매트리스', intent: 'brand', search: 18500, brand: true, profile: 'star' },
    { text: '수면밀도 매트리스', intent: 'brand', search: 9600, brand: true, profile: 'star' },
    { text: '밀도매트리스 후기', intent: 'brand', search: 2300, brand: true, profile: 'normal' },
    { text: '매트리스', intent: 'generic', search: 162000, profile: 'normal' },
    { text: '퀸 매트리스', intent: 'generic', search: 33100, profile: 'star' },
    { text: '매트리스 가격', intent: 'generic', search: 8800, profile: 'normal' },
    { text: '슈퍼싱글 매트리스', intent: 'generic', search: 27400, profile: 'normal' },
    { text: '킹 매트리스', intent: 'generic', search: 14800, profile: 'weak' },
    { text: '매트리스 할인', intent: 'generic', search: 5400, profile: 'weak' },
    { text: '허리 편안한 매트리스', intent: 'problem', search: 6100, profile: 'star' },
    { text: '매트리스 경도', intent: 'problem', search: 3900, profile: 'normal' },
    { text: '단단한 매트리스', intent: 'problem', search: 7200, profile: 'normal' },
    { text: '허리 아플때 매트리스', intent: 'problem', search: 2900, profile: 'star' },
    { text: '꺼짐 없는 매트리스', intent: 'problem', search: 1700, profile: 'normal' },
    { text: '통기성 좋은 매트리스', intent: 'problem', search: 1300, profile: 'weak' },
    { text: '매트리스 추천', intent: 'compare', search: 49500, profile: 'normal' },
    { text: '매트리스 비교', intent: 'compare', search: 6600, profile: 'normal' },
    { text: '매트리스 순위', intent: 'compare', search: 12100, profile: 'weak' },
    { text: '가성비 매트리스', intent: 'compare', search: 18100, profile: 'weak' },
    { text: '독립스프링 매트리스 추천', intent: 'compare', search: 4400, profile: 'normal' },
    { text: '신혼 매트리스', intent: 'life', search: 8100, profile: 'star' },
    { text: '이사 매트리스', intent: 'life', search: 1900, profile: 'normal' },
    { text: '신혼집 매트리스 사이즈', intent: 'life', search: 880, profile: 'test' },
    { text: '자취 매트리스', intent: 'life', search: 5400, profile: 'weak' },
    { text: '부모님 매트리스 선물', intent: 'life', search: 1100, profile: 'test' },
    { text: '아이방 매트리스', intent: 'life', search: 1600, profile: 'test' },
    { text: '첫 독립 매트리스', intent: 'life', search: 390, profile: 'new' },
  ];
  const keywords: Keyword[] = kwSeeds.map((s, i) => {
    const kr = rng(hashString(s.text));
    const profileMult = { star: 1.6, normal: 1.0, weak: 0.48, test: 0.9, new: 0.7 }[s.profile];
    const baseCpc = s.brand ? 210 : s.intent === 'generic' ? 1250 : s.intent === 'compare' ? 1050 : 760;
    const ctr = s.brand ? 9.5 : s.intent === 'problem' || s.intent === 'life' ? 2.6 : 1.9;
    const cvr = (s.brand ? 4.2 : 1.05) * profileMult * kr.noise(0.1);
    const share = s.intent === 'generic' ? 0.22 : s.brand ? 0.85 : 0.4;
    const dailyImps = (s.search / 30) * share * 1.8;
    const daily: KeywordStats[] = [];
    const prevDaily: KeywordStats[] = [];
    for (let d = 0; d < 28; d++) {
      const imps = dailyImps * kr.noise(0.12) * (s.profile === 'new' && d < 14 ? 0 : 1);
      const clicks = (imps * ctr) / 100 * kr.noise(0.08);
      const cost = clicks * baseCpc * kr.noise(0.06);
      const conv = (clicks * cvr) / 100 * kr.noise(0.25);
      const revenue = conv * 1_060_000 * kr.noise(0.06);
      const row = { impressions: Math.round(imps), clicks: Math.round(clicks), cost: Math.round(cost), conversions: Math.round(conv * 100) / 100, revenue: Math.round(revenue) };
      (d < 14 ? prevDaily : daily).push(row);
    }
    // 시연용: '매트리스 추천' 최근 3일 CPC 급등 (경쟁사 입찰 상승 가정)
    if (s.text === '매트리스 추천') {
      for (let d = 11; d < 14; d++) { daily[d].cost = Math.round(daily[d].cost * 1.7); daily[d].conversions = Math.round(daily[d].conversions * 0.6 * 100) / 100; daily[d].revenue = Math.round(daily[d].revenue * 0.6); }
    }
    const agg = (rows: KeywordStats[]) => rows.reduce((a, r) => ({
      impressions: a.impressions + r.impressions, clicks: a.clicks + r.clicks, cost: a.cost + r.cost,
      conversions: Math.round((a.conversions + r.conversions) * 100) / 100, revenue: a.revenue + r.revenue,
    }), emptyStats());
    const lost = s.profile === 'star' ? kr.range(0.26, 0.42) : s.profile === 'weak' ? kr.range(0.02, 0.08) : kr.range(0.08, 0.22);
    const bid = Math.round((baseCpc * kr.range(1.05, 1.3)) / 10) * 10;
    return {
      id: `kw_${i + 1}`,
      text: s.text,
      intent: s.intent,
      adgroup: `${s.intent.toUpperCase()}_${s.profile === 'test' || s.profile === 'new' ? 'TEST' : 'MAIN'}`,
      isBrand: !!s.brand,
      bid,
      maxBid: Math.round(bid * (s.brand ? 2 : 1.6) / 10) * 10,
      avgRank: Math.round((s.profile === 'star' ? kr.range(2.6, 4.2) : kr.range(1.3, 3.2)) * 10) / 10,
      monthlySearch: s.search,
      impressionShareLost: Math.round(lost * 100) / 100,
      status: s.profile === 'test' || s.profile === 'new' ? 'test' : 'on',
      landing: s.brand ? 'https://brand.naver.com/mildo' : s.intent === 'problem' ? 'https://mildo.kr/guide' : s.intent === 'life' ? 'https://mildo.kr/event' : 'https://brand.naver.com/mildo/products',
      last14: agg(daily),
      prev14: agg(prevDaily),
      daily,
    };
  });

  /* ---------------- 검색어 보고서 (미등록 구문형 후보 포함) ---------------- */
  const termSeeds = [
    ['신혼집 매트리스 퀸 킹 고민', true], ['허리 디스크 매트리스 단단한', false], ['이사 후 매트리스 교체 시기', false],
    ['매트리스 경도 고르는 법', false], ['아이방 슈퍼싱글 매트리스 추천', false], ['부모님 선물 매트리스', true],
    ['매트리스 꺼짐 보상', false], ['여름 매트리스 통기성', false], ['매트리스 소음 스프링', false],
    ['신혼 매트리스 사이즈', true], ['첫 자취 매트리스 추천', false], ['독립스프링 vs 포켓스프링', false],
    ['밀도 매트리스 경도', false], ['수면밀도 할인', false], ['매트리스 무료배송 설치', false],
  ] as const;
  const searchTerms: SearchTermRow[] = termSeeds.map(([term, registered], i) => {
    const t = rng(hashString(term));
    const clicks = t.int(14, 160);
    const conv = Math.round(clicks * t.range(0.004, 0.035) * 100) / 100;
    return {
      term, registered,
      impressions: Math.round(clicks / t.range(0.015, 0.045)),
      clicks, cost: Math.round(clicks * t.range(600, 1100)),
      conversions: conv, revenue: Math.round(conv * 1_050_000),
    };
  });

  /* ---------------- 캠페인 (오늘 소진 현황) ---------------- */
  const hourShare = sum(HOUR_WEIGHT.slice(0, currentHour + 1), (x) => x) / HOUR_SUM;
  const campaigns: Campaign[] = [];
  const campaignDefs: { media: MediaId; name: string; intent?: IntentId; budgetShare: number; paceMult: number }[] = [
    { media: 'naver_sa', name: 'SA_브랜드 방어', intent: 'brand', budgetShare: 0.16, paceMult: 0.95 },
    { media: 'naver_sa', name: 'SA_일반 제품', intent: 'generic', budgetShare: 0.34, paceMult: 1.32 },
    { media: 'naver_sa', name: 'SA_문제 해결', intent: 'problem', budgetShare: 0.18, paceMult: 1.0 },
    { media: 'naver_sa', name: 'SA_비교 · 검토', intent: 'compare', budgetShare: 0.2, paceMult: 1.08 },
    { media: 'naver_sa', name: 'SA_생활 상황', intent: 'life', budgetShare: 0.12, paceMult: 0.82 },
    { media: 'naver_gfa', name: 'GFA_Prospecting', budgetShare: 0.45, paceMult: 1.0 },
    { media: 'naver_gfa', name: 'GFA_쇼핑 고객 확장', budgetShare: 0.3, paceMult: 1.12 },
    { media: 'naver_gfa', name: 'GFA_리타겟팅', budgetShare: 0.25, paceMult: 0.9 },
    { media: 'google', name: 'Google_검색', budgetShare: 0.55, paceMult: 0.97 },
    { media: 'google', name: 'Google_Demand Gen', budgetShare: 0.45, paceMult: 1.04 },
    { media: 'meta', name: 'Meta_넓은 타겟', budgetShare: 0.6, paceMult: 1.58 },
    { media: 'meta', name: 'Meta_리타겟팅', budgetShare: 0.4, paceMult: 1.0 },
    { media: 'kakao', name: '카카오_장바구니 리마케팅', budgetShare: 0.6, paceMult: 0.94 },
    { media: 'kakao', name: '카카오_프로모션', budgetShare: 0.4, paceMult: 0.88 },
    { media: 'vertical', name: '쿠팡_상품광고', budgetShare: 0.55, paceMult: 1.01 },
    { media: 'vertical', name: '오늘의집_상품광고', budgetShare: 0.45, paceMult: 0.97 },
  ];
  campaignDefs.forEach((c, i) => {
    const daily = (MEDIA[c.media].annualBudget / 365) * c.budgetShare * 1.08;
    const dailyBudget = Math.round(daily / 10000) * 10000;
    campaigns.push({
      id: `cmp_${i + 1}`, media: c.media, name: c.name, intent: c.intent,
      dailyBudget, spentToday: Math.round(dailyBudget * hourShare * c.paceMult),
      status: 'on', hourOfData: currentHour,
    });
  });

  /* ---------------- 광고 계정 · 결제 ---------------- */
  const accounts: AdAccount[] = [
    { id: 'acc_sa', media: 'naver_sa', name: '네이버 검색광고 (수면밀도)', owner: '수면밀도', balance: 21_400_000, avgDailySpend: 6_180_000, autoCharge: 'ok', paymentMethod: '비즈머니 · 법인카드 자동충전', status: 'active',
      permissions: [{ user: 'PM', role: '관리자', realName: true, lastLogin: '2026-10-31' }, { user: 'SA Lead AE', role: '운영', realName: true, lastLogin: '2026-10-31' }, { user: 'SA AE', role: '운영', realName: true, lastLogin: '2026-10-30' }] },
    { id: 'acc_gfa', media: 'naver_gfa', name: '네이버 GFA (수면밀도)', owner: '수면밀도', balance: 2_350_000, avgDailySpend: 2_590_000, autoCharge: 'failed', paymentMethod: '비즈머니 · 자동충전 카드', status: 'active',
      permissions: [{ user: 'DA AE', role: '운영', realName: true, lastLogin: '2026-10-31' }, { user: 'PM', role: '관리자', realName: true, lastLogin: '2026-10-29' }] },
    { id: 'acc_google', media: 'google', name: 'Google Ads (수면밀도)', owner: '수면밀도', balance: -1, avgDailySpend: 1_720_000, autoCharge: 'postpaid', paymentMethod: '후불 · 법인카드', status: 'active',
      permissions: [{ user: '글로벌 매체 AE', role: '표준', realName: true, lastLogin: '2026-10-31' }, { user: 'agency-shared@', role: '관리자', realName: false, lastLogin: '2026-09-02' }] },
    { id: 'acc_meta', media: 'meta', name: 'Meta 비즈니스 (수면밀도)', owner: '수면밀도', balance: -1, avgDailySpend: 1_690_000, autoCharge: 'postpaid', paymentMethod: '후불 · 법인카드 (한도 확인)', status: 'active',
      permissions: [{ user: '글로벌 매체 AE', role: '광고주', realName: true, lastLogin: '2026-10-31' }] },
    { id: 'acc_kakao', media: 'kakao', name: '카카오모먼트 (수면밀도)', owner: '수면밀도', balance: 8_900_000, avgDailySpend: 1_120_000, autoCharge: 'ok', paymentMethod: '캐시 · 자동충전', status: 'active',
      permissions: [{ user: 'DA AE', role: '운영', realName: true, lastLogin: '2026-10-31' }] },
    { id: 'acc_coupang', media: 'coupang', name: '쿠팡 광고센터', owner: '수면밀도', balance: 3_100_000, avgDailySpend: 520_000, autoCharge: 'off', paymentMethod: '광고비 선충전', status: 'active',
      permissions: [{ user: 'DA AE', role: '운영', realName: true, lastLogin: '2026-10-30' }] },
    { id: 'acc_ohouse', media: 'ohouse', name: '오늘의집 광고', owner: '수면밀도', balance: 1_850_000, avgDailySpend: 430_000, autoCharge: 'off', paymentMethod: '광고비 선충전', status: 'review',
      permissions: [{ user: 'DA AE', role: '운영', realName: true, lastLogin: '2026-10-28' }] },
  ];

  /* ---------------- 상품 · 프로모션 ---------------- */
  const products: Product[] = [
    { id: 'p_main', name: '수면밀도 매트리스 (주력)', landing: 'https://brand.naver.com/mildo/products', options: [
      { id: 'ss', label: '슈퍼싱글', price: 790_000, inStock: true },
      { id: 'q', label: '퀸', price: 990_000, inStock: true },
      { id: 'k', label: '킹', price: 1_190_000, inStock: false },
    ] },
    { id: 'p_topper', name: '토퍼 (데모 가정)', landing: 'https://mildo.kr/topper', options: [
      { id: 'q', label: '퀸', price: 290_000, inStock: true },
    ] },
  ];
  const promotions: Promotion[] = [
    { id: 'promo_1', name: '가을 이사 · 혼수 기획전', channel: 'brandstore', start: '2026-10-20', end: '2026-11-03', discountRate: 15, adCopyPrice: 841_500, status: 'live' },
    { id: 'promo_2', name: '오늘의집 집들이 위크', channel: 'ohouse', start: '2026-10-27', end: '2026-11-02', discountRate: 12, adCopyPrice: 871_200, status: 'live' },
    { id: 'promo_3', name: '11월 연말 수면 환경 기획전', channel: 'brandstore', start: '2026-11-11', end: '2026-11-20', discountRate: 18, status: 'planned' },
  ];

  return {
    generatedAt: `${today}T${String(currentHour).padStart(2, '0')}:30:00+09:00`,
    today, currentHour, dates,
    mediaDaily, mediaHourly, salesDaily, keywords, campaigns, accounts, searchTerms, products, promotions,
    brandSearchDaily,
  };
}

/** 앱 전역 데모 데이터 (모듈 로드 시 1회 생성) */
export const DEMO: Dataset = generateDemoData();
