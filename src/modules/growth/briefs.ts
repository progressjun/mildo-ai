/**
 * 매출 성장 — 규칙 엔진 브리프 (AI 미연결 시 같은 형식으로 판단 근거를 정리).
 * 확정 팩트 / 반복 관측 패턴 / AI 해석(규칙 엔진 해석) / 전제 조건 · 기준값 / 반례 · 대체 시나리오 / 다음 액션.
 * 번호 매기기 · 감정 표현 · 근거 없는 판정 금지. 수치는 TEST DATA.
 */
import type { Brief } from '@/ai/prompts';
import type { Dataset, MediaId } from '@/core/types';
import { AD_PILOT, MEDIA, MEDIA_IDS, NEW_MEDIA_PILOT, RFP } from '@/data/constants';
import { fmt } from '@/core/util';
import { ALLOCATION_GUARDRAILS, CO_PROMO_PRINCIPLES, FUNNEL_RULES, REBALANCE_RULES } from './data';
import {
  CAMPAIGN_VERDICT_LABEL, CONSTRAINT_LABEL, PROPOSAL_SHARES, allocationModel, belowTargetKeywords, budgetConstraints, coPromoDemand, daSaAnalysis, defaultPilots, exhaustText, f2,
  funnelDiagnosis, growthSignals, keywordCpcSpikes,
  holdoutDesign, pilotPlan, rfpSegmentSummary, saCampaignPerformance, scoreNewMedia, skuExpansionSummary, type AllocationInput, type AllocationModel,
  type CriterionId, type PilotInput, type ScoreTable,
} from './engine';

const name = (m: MediaId | null) => (m ? MEDIA[m].name : '—');
const fin = Number.isFinite;

function moveText(model: AllocationModel): string {
  return MEDIA_IDS.map((m) => {
    const a = PROPOSAL_SHARES[m];
    const b = model.equalize.shares[m];
    const why = model.equalize.binding[m];
    const tag = why === 'max' ? ' 가드레일 상한' : why === 'min' ? ' 가드레일 하한' : why === 'step' ? ' 재배분 폭 상한' : why === 'cap' ? ' 볼륨 한계' : '';
    return `${MEDIA[m].short} ${fmt.ratio(a)} → ${fmt.ratio(b)}${tag}`;
  }).join(' · ');
}

export function allocationBrief(d: Dataset, input: AllocationInput = {}): Brief {
  const m = allocationModel(d, input);
  const credit = input.daSaCredit ? m : allocationModel(d, { ...input, daSaCredit: true });
  const plain = input.daSaCredit ? allocationModel(d, { ...input, daSaCredit: false }) : m;
  const sp = m.baseline.spread;
  if (!m.baseline.valid) {
    return {
      title: '예산 재배분 · 한계 효율 (p.37)', facts: ['매체별 일별 성과 데이터가 없어 반응 곡선을 적합할 수 없습니다. 배분 가안(p.37) SA 43% · GFA 18% · Google 12% · Meta 12% · 카카오 8% · 버티컬 7%를 유지합니다.'],
      patterns: [], interpretation: [], conditions: [`재배분 원칙 ${REBALANCE_RULES.principle} (p.37).`], counter: [], actions: ['데이터 연동(Pro-board 수집) 후 최근 90일 기준으로 곡선을 다시 적합합니다.'],
    };
  }
  const prior = m.curves.filter((c) => c.bSource === 'prior');
  const cvs = m.curves.map((c) => c.costCv).filter(fin);
  const sa = m.curves.find((c) => c.media === 'naver_sa');
  return {
    title: '예산 재배분 · 한계 효율 (p.37)',
    facts: [
      `최근 ${m.curves[0]?.days ?? 0}일 관측 ROAS (TEST DATA): ${m.curves.map((c) => `${MEDIA[c.media].short} ${fmt.roas(c.roas)}`).join(' · ')}.`,
      `배분 가안(p.37, 연 ${fmt.krw(m.budget)}) 운영점의 한계 ROAS: ${m.baseline.rows.map((r) => `${MEDIA[r.media].short} ${fmt.roas(r.marginalRoas)}`).join(' · ')}. 최고 ${name(sp.maxMedia)}, 최저 ${name(sp.minMedia)}, 격차 ${fmt.int(sp.gapPct)}%.`,
      `한계 ROAS 균등화안: ${moveText(m)}. 균등화 한계 ROAS ${fmt.roas(m.equalize.marginalRoas)}.`,
    ],
    patterns: [
      prior.length === m.curves.length
        ? `6개 매체 모두 로그-로그 적합 b의 95% 구간이 1을 포함하거나 넘습니다. 일 광고비 변동계수 ${fmt.ratio(Math.min(...cvs))}~${fmt.ratio(Math.max(...cvs))} 범위에서는 체감 형태가 관측되지 않습니다.`
        : `데이터로 체감이 확인된 매체 ${m.identifiedCount}개, 사전 가정 b를 쓴 매체 ${prior.length}개 (${prior.map((c) => MEDIA[c.media].short).join(' · ')}).`,
      `관측 평균 ROAS가 높은 SA · 버티컬은 한계 ROAS도 높고, 리마케팅 모수가 한정된 카카오는 평균 ROAS ${fmt.roas(m.curves.find((c) => c.media === 'kakao')?.roas ?? NaN)} 대비 한계 ROAS가 가장 낮습니다.`,
      ...(() => {
        const bc = budgetConstraints(d, m);
        return bc.length
          ? [`오늘 ${d.currentHour}시 기준 일 예산 조기 소진 예상 캠페인 ${bc.length}개 (최근 28일 시간대 소진 곡선 · MILDO Board · AD Pilot과 같은 계산): ${bc.map((x) => `${x.campaign} 소진 배수 ${f2(x.paceIndex)} · 예상 마감 ${exhaustText(x.exhaustHour)} → ${CONSTRAINT_LABEL[x.verdict]} (${x.basis})`).join(' / ')}.`]
          : [];
      })(),
    ],
    interpretation: [
      `균등화안 예상 연 매출 ${fmt.delta(m.upliftOptimizedPct)} (${fmt.krw(m.upliftOptimized)})은 사전 가정 b에 기대는 시나리오이며 예측이 아닙니다. b를 매체별 ±0.1 바꿔도 증분은 ${fmt.delta(m.sensitivity.lowPct)}~${fmt.delta(m.sensitivity.highPct)} 범위이고, 증감 방향은 ${m.sensitivity.stable ? '유지됩니다' : `${m.sensitivity.flipped.map((x) => MEDIA[x].short).join(' · ')}에서 바뀝니다`}.`,
      `GFA는 직접 ROAS만 보면 감액 대상이지만, DA→SA 기여(METHOD 1 · 3 추정, SA 경유 ROAS ${fmt.roas(credit.credit.haloRoas)})를 반영하면 균등화안 GFA 비중이 ${fmt.ratio(plain.equalize.shares.naver_gfa)} → ${fmt.ratio(credit.equalize.shares.naver_gfa)}로 바뀝니다. 기여 추정치에 따라 결론이 뒤집히므로 GFA 감액은 홀드아웃 결과 전까지 보류합니다.`,
    ],
    conditions: [
      `재배분 원칙: ${REBALANCE_RULES.principle} (p.37). 1회 재배분 폭 ±${REBALANCE_RULES.stepCapPct}% · 가드레일 ${MEDIA_IDS.map((x) => `${MEDIA[x].short} ${fmt.ratio(ALLOCATION_GUARDRAILS[x].min, 0)}~${fmt.ratio(ALLOCATION_GUARDRAILS[x].max, 0)}`).join(' · ')} (초기값 · 협의 후 확정).`,
      `SA 볼륨 한계: ${sa?.capBasis ?? '—'}. 연 ${fmt.krw(RFP.annualBudget)} 가정 · VAT · 수수료 별도 · 최근 90일 효율 수준을 연간에 적용 (시즌성 미반영).`,
    ],
    counter: [
      `데이터 적합 b(${m.curves.map((c) => `${MEDIA[c.media].short} ${f2(c.fit.b)}`).join(' · ')})를 그대로 쓰면 체감이 없는 직선이 되어 평균 ROAS가 높은 매체로 가드레일 상한까지 몰리는 결과가 나옵니다. 관측 변동폭 밖의 외삽이므로 의사결정 근거로 쓰지 않습니다.`,
      (() => {
        const sp = keywordCpcSpikes(d);
        return `SA 증액분은 노출 기회 손실 회수에 기대므로, 경쟁사 입찰 상승${sp.length ? `(${sp.slice(0, 2).map((x) => `'${x.keyword}' 최근 3일 CPC ${fmt.delta(x.deltaPct, 0)}`).join(' · ')})` : ''}이 이어지면 볼륨 한계가 더 낮아지고 증분이 줄어듭니다.`;
      })(),
    ],
    actions: [
      'PM: 균등화안 중 가드레일 · 재배분 폭 안의 변경을 다음 달 재배분안으로 작성해 수면밀도 승인 요청 (p.53 예산 · 구조 변경, 당일). 판정은 4주 후 매체별 ROAS가 곡선 예측 ±15% 이내인지로 합니다.',
      '데이터 애널리스트: SA · 버티컬 증액 구간에서 ±20% 증액 테스트로 b를 실측하고 4주 단위로 곡선을 갱신합니다.',
      'DA AE: GFA 감액은 METHOD 2 홀드아웃(지역 단위) 결과를 확인한 뒤 분기 구조 리뷰에서 결정합니다.',
    ],
  };
}

export function daSaBrief(d: Dataset): Brief {
  const ds = daSaAnalysis(d);
  if (!ds.valid) {
    return {
      title: 'DA → SA 전환 기여 (p.40)', facts: [`GFA 광고비와 브랜드 검색량이 함께 있는 날이 ${ds.n}일로 시차 분석 기준(20일)에 미달합니다.`],
      patterns: [], interpretation: [], conditions: ['요일 · 시즌 보정에는 앞뒤 1주가 필요합니다.'], counter: [], actions: ['브랜드 검색량 데이터(네이버 검색광고 · 데이터랩) 연동 후 다시 분석합니다.'],
    };
  }
  const best = ds.lags.find((l) => l.lag === ds.bestLag);
  const raw0 = ds.lags[0];
  const h = holdoutDesign(d, { unit: 'region', metric: 'brand_search', mdePct: 10 });
  const hc = holdoutDesign(d, { unit: 'region', metric: 'sa_brand_conv', mdePct: 10 });
  return {
    title: 'DA → SA 전환 기여 (p.40)',
    facts: [
      `분석 기간 ${ds.n}일 (요일 · 시즌 보정 후, TEST DATA). GFA 일 평균 광고비 ${fmt.krw(ds.avgGfaDaily)}, 브랜드 검색량 일 평균 ${fmt.int(ds.avgBrandSearch)}회.`,
      ds.bestLag !== null
        ? `보정 시차 상관 최고값은 ${ds.bestLag}일 시차 r ${f2(ds.bestR)} (유의 기준 r > ${f2(ds.threshold)}, 시차 8개 다중 비교 보정). 분산 시차 회귀 누적 계수 광고비 100만원당 브랜드 검색 ${fmt.int(ds.dl.cumulativePerMillion)}회 (시차 ${ds.dl.lagsUsed.join(' · ')}일).`
        : `보정 시차 상관이 모든 시차에서 유의 기준 r > ${f2(ds.threshold)}에 미달합니다.`,
      `METHOD 3: SA 키워드 매출 중 DA 경유 추정 ${fmt.ratio(ds.method3.daShareOfSa)} (브랜드 키워드 ${fmt.ratio(ds.daShareBrand)}는 METHOD 1 추정, 비브랜드는 데모 가정). GFA 광고비 대비 SA 경유 매출 ${fmt.roas(ds.halo.haloRoas)}.`,
    ],
    patterns: [
      `보정 전 원계열 상관은 ${raw0 ? `시차 0일 r ${f2(raw0.raw)}` : '—'}로 가장 높게 나오지만, 요일 · 시즌 공통 요인을 제거하면 ${best ? `${best.lag}일 시차로 이동합니다` : '유의한 시차가 남지 않습니다'}. 원계열 상관은 같은 요일에 함께 늘어나는 집행 · 수요 패턴을 섞어 보여줍니다.`,
      `SA 전체 전환과 GFA 광고비의 보정 상관은 최대 |r| ${f2(ds.saLink.maxAbsR)}로 유의 기준에 미달합니다. 브랜드 검색 증가가 SA 전환 증가로 이어지는지는 시계열로 확인되지 않습니다.`,
    ],
    interpretation: [
      `브랜드 검색의 약 ${fmt.ratio(ds.daShareBrand, 0)}가 DA 경유라는 추정은 상관 기반이며 인과가 아닙니다. 같은 날 기획전 · 시즌 수요가 GFA 증액과 겹치면 기여가 과대 추정됩니다.`,
      `SA 경유 ROAS ${fmt.roas(ds.halo.haloRoas)}를 그대로 재배분에 반영하면 GFA 증액이 정당화되지만, 증가한 브랜드 검색이 SA가 아닌 오가닉 · 다른 판매 채널 구매로 이어지는 비율은 반영되어 있지 않아 상한 성격의 추정입니다.`,
    ],
    conditions: [
      `METHOD 2 지역 단위 홀드아웃(30%) · 브랜드 검색량 기준 최소 검출 효과 10%: 그룹당 ${fmt.int(h.requiredDays)}일, 권장 ${fmt.int(h.recommendedDays)}일 · 미집행 광고비 ${fmt.krw(h.unspentSpend)} (추정).`,
      `같은 조건을 SA 브랜드 키워드 전환으로 측정하면 그룹당 ${fmt.int(hc.requiredDays)}일이 필요합니다. 전환 수가 적어 1차 지표는 브랜드 검색량으로 둡니다.`,
    ],
    counter: [
      '기간 단위(주 ON/OFF) 홀드아웃은 요일 · 시즌 요인이 상쇄되지 않아 같은 효과를 검출하는 데 지역 단위보다 긴 기간이 필요합니다.',
      'DA를 끈 지역에서 브랜드 검색이 줄지 않으면 GFA의 역할은 SA 기여가 아니라 직접 전환과 신규 고객 확보로 평가해야 합니다 (판단 지표 신규 CPA, p.37).',
    ],
    actions: [
      '데이터 애널리스트: 지역 단위 홀드아웃 설계안(지역 · 기간 · 지표)을 작성해 PM 검토 후 수면밀도 승인 요청 (DA 집행 구조 변경).',
      `DA AE: 홀드아웃 결과가 나올 때까지 GFA 예산은 가안 ${fmt.ratio(PROPOSAL_SHARES.naver_gfa)} 기준 ±10% 이내에서만 조정합니다 (위임 범위 AE).`,
      'PM: 홀드아웃 순증 효과가 확인되면 분기 구조 리뷰에서 DA→SA 기여 반영 재배분안을 상정합니다 (2027 Q3 전환 고도화 · DA→SA 재배분).',
    ],
  };
}

export function funnelBrief(d: Dataset): Brief {
  const f = funnelDiagnosis(d);
  if (!f.valid) {
    return {
      title: '브랜드스토어 · 자사몰 전환 개선 (p.41)', facts: ['판매 채널 퍼널 데이터(유입 · 상세 · 장바구니 · 구매)가 없습니다.'], patterns: [], interpretation: [],
      conditions: [`판정 기준: 채널 간 ${FUNNEL_RULES.gapPct}% 이하 또는 직전 기간 대비 ${FUNNEL_RULES.trendPct}% 이하이면 개선 우선.`], counter: [], actions: ['브랜드스토어 · 자사몰 퍼널 데이터 연동 후 진단합니다.'],
    };
  }
  const bs = f.brandstore;
  const om = f.ownMall;
  const p = f.priority;
  const c = f.cannibal;
  return {
    title: '브랜드스토어 · 자사몰 전환 개선 (p.41)',
    facts: [
      `최근 ${f.window.days}일 (TEST DATA) 브랜드스토어: 유입 ${fmt.int(bs.cur.visitors)} → 상세 ${fmt.int(bs.cur.detailViews)} → 장바구니 ${fmt.int(bs.cur.carts)} → 구매 ${fmt.int(bs.cur.orders)} (방문 대비 ${fmt.pct(bs.rates.cvr, 2)}).`,
      `자사몰: 유입 ${fmt.int(om.cur.visitors)} → 상세 ${fmt.int(om.cur.detailViews)} → 장바구니 ${fmt.int(om.cur.carts)} → 구매 ${fmt.int(om.cur.orders)} (방문 대비 ${fmt.pct(om.rates.cvr, 2)}).`,
      `두 채널 합산 매출 ${fmt.krw(c.combined.cur)} · 직전 ${f.window.days}일 대비 ${fmt.delta(c.combined.deltaPct)} (브랜드스토어 ${fmt.delta(c.bs.deltaPct)} · 자사몰 ${fmt.delta(c.om.deltaPct)}).`,
    ],
    patterns: [
      (() => {
        const steps = f.stages.filter((s) => s.stage !== 'order' && Number.isFinite(s.gapPct));
        const similar = steps.filter((s) => Math.abs(s.gapPct) < 10);
        const widest = steps.reduce<(typeof steps)[number] | null>((a, s) => (!a || Math.abs(s.gapPct) > Math.abs(a.gapPct) ? s : a), null);
        const sim = similar.length ? `${similar.map((s) => `${s.metricLabel}(${fmt.pct(s.bs.cur)} vs ${fmt.pct(s.om.cur)})`).join(' · ')}은 두 채널 차이가 10% 미만이고, ` : '';
        return widest ? `${sim}격차는 ${widest.label} 단계에 가장 큽니다 (${widest.metricLabel} 브랜드스토어 ${fmt.pct(widest.bs.cur)} vs 자사몰 ${fmt.pct(widest.om.cur)}).` : '단계별 비교 데이터가 부족합니다.';
      })(),
      f.landing.mismatches.length
        ? `의도-랜딩 불일치 키워드 ${f.landing.mismatches.length}개: ${Array.from(new Set(f.landing.mismatches.map((x) => `${x.expected} 기대 → ${x.actual} 랜딩`))).join(' · ')} (p.35 구조 기준, SA 광고비의 ${fmt.ratio(f.landing.mismatchCostShare)}).${f.landing.soldout.length ? ` ${f.landing.soldout.map((s) => `'${s.keyword}'는 ${s.option} 옵션 품절 상세로 랜딩`).join(' · ')}.` : ''}`
        : '의도-랜딩 불일치 키워드가 없습니다.',
    ],
    interpretation: [
      p
        ? `우선 개선 단계는 ${p.focus === 'own_mall' ? '자사몰' : '브랜드스토어'} ${p.label}입니다 (${p.reasons[0] ?? ''}). 격차 절반 회복을 가정하면 월 ${fmt.krw(f.upside.addRevenueMonthly)} 수준의 매출 차이로, 광고비 증액 없이 CAC를 낮추는 경로입니다 (시나리오).`
        : '채널 간 격차가 판정 기준 안에 있어 단계 단위 우선 개선 대상이 없습니다.',
      `자사몰 장바구니 이탈은 결제 수단 · 배송 안내 · 혜택 차이 중 어느 원인인지 데이터로 구분되지 않습니다. ${c.benefitGap ? `현재 ${c.benefitGap}이라 혜택 차이가 후보입니다.` : ''}`,
    ],
    conditions: [
      `판정 기준(초기값): 채널 간 ${FUNNEL_RULES.gapPct}% 이하 또는 직전 ${f.window.days}일 대비 ${FUNNEL_RULES.trendPct}% 이하 → 개선 우선. 상품 상세의 체류 · 리뷰 조회 데이터는 연동 전이라 장바구니 담기율로 대체합니다.`,
      `판단은 두 채널 합산 매출 기준 (p.41). 잠식 판정: 한 채널 ±5% 이상 증가가 다른 채널 감소로 상쇄되고 합산 변화가 ±${FUNNEL_RULES.cannibalCombinedPct}% 이내.`,
    ],
    counter: [
      `잠식 판정은 ${c.flag === 'suspect' ? '잠식 의심' : c.flag === 'none' ? '잠식 신호 없음' : '판단 불가'}입니다 (${c.basis}). 자사몰 전용 혜택을 열면 브랜드스토어 구매가 자사몰로 이동할 수 있으므로 합산 매출과 채널 비중을 함께 봅니다.`,
      '브랜드스토어의 높은 장바구니 → 구매 전환은 네이버페이 · 리뷰 노출 효과일 수 있어, 자사몰에 같은 수준을 목표로 두는 것은 과대 목표일 수 있습니다.',
    ],
    actions: [
      `담당 AE: ${f.landing.mismatches.length ? `${Array.from(new Set(f.landing.mismatches.map((x) => x.expected))).join(' · ')} 랜딩 분리 테스트안을 작성합니다 (AD Pilot · Lab 연계, 판정 2주).` : '의도별 랜딩 구조를 월 1회 점검합니다.'}${f.landing.soldout.length ? ' 품절 옵션 랜딩 키워드는 MILDO Alert 품절 랜딩 이슈로 처리합니다.' : ''}`,
      'PM: 자사몰 장바구니 이탈 고객 대상 CRM(카카오 채널 · 알림톡) 연계 검토를 수면밀도에 제안하고, 4주 후 장바구니 → 구매 전환율과 합산 매출로 판정합니다.',
    ],
  };
}

export function campaignBrief(d: Dataset): Brief {
  const camps = saCampaignPerformance(d);
  const seg = rfpSegmentSummary();
  const sku = skuExpansionSummary();
  const valid = camps.filter((c) => c.verdict !== 'nodata');
  const brand = camps.find((c) => c.intent === 'brand');
  const nonBrandShare = 1 - (brand?.revenueShare ?? NaN);
  return {
    title: '구매 의도별 타겟 그룹 · SA 캠페인 구조 (p.34–36)',
    facts: [
      `RFP 네이버 결제 상위 4개 세그먼트 ${fmt.ratio(seg.top4Share)} · 그중 여성 31~50세 ${fmt.ratio(seg.female3150Share, 0)} (RFP).`,
      valid.length
        ? `SA 5개 캠페인 최근 14일 (TEST DATA): ${valid.map((c) => `${c.name} ROAS ${fmt.roas(c.roas)} · 매출 비중 ${fmt.ratio(c.revenueShare)}`).join(' / ')}.`
        : 'SA 키워드 성과 데이터가 없습니다.',
    ],
    patterns: valid.length ? [
      `브랜드 방어가 SA 키워드 매출의 ${fmt.ratio(brand?.revenueShare ?? NaN)}를 차지하고, 비브랜드 4개 캠페인 합계는 ${fmt.ratio(nonBrandShare)}입니다. 비브랜드 캠페인은 모두 목표 ROAS ${AD_PILOT.targetRoas}%를 넘지만 매출 규모는 검색량에 묶여 있습니다.`,
      `노출 손실: ${valid.map((c) => `${c.name} ${fmt.ratio(c.lostShare, 0)}`).join(' · ')}.`,
      (() => {
        const stars = valid.flatMap((c) => c.expandKeywords.map((k) => `${k.keyword}(${c.name} · 목표 대비 ${fmt.int(k.ratioPct)}% · 손실 ${fmt.ratio(k.lostShare, 0)})`));
        return stars.length
          ? `키워드 단위 확대 여지 ${stars.length}개: ${stars.slice(0, 5).join(' · ')}${stars.length > 5 ? ` 외 ${stars.length - 5}개` : ''}. 캠페인 합계가 기준에 못 미쳐도 키워드 단위로는 고효율 · 노출 손실 조건을 충족합니다.`
          : '키워드 단위 확대 여지(목표 대비 130% 이상 · 노출 손실 25% 이상) 키워드가 없습니다.';
      })(),
    ] : [],
    interpretation: valid.length ? [
      `판정은 ${valid.map((c) => `${c.name} ${CAMPAIGN_VERDICT_LABEL[c.verdict]}`).join(' · ')}입니다. 브랜드 방어의 확대 여지는 수요 창출이 아니라 이미 생긴 브랜드 수요의 점유 회수이므로, 신규 고객 확보는 문제 해결 · 생활 상황 캠페인의 구문형 확장(제품 1 × 문제 ${sku.problems} × 상황 ${sku.situations} × 비교 ${sku.criteria} = 진입점 ${sku.total}개, p.36)으로 접근합니다.`,
    ] : [],
    conditions: [
      `판정 기준: 목표 ROAS ${AD_PILOT.targetRoas}% (브랜드 ${AD_PILOT.brandTargetRoas}%) 대비 ${AD_PILOT.highEfficiencyRoasRatio * 100}% 이상 + 노출 손실 ${AD_PILOT.lostShareTrigger * 100}% 이상 → 확대 여지 · 100% 이상 유지 · 미만 효율 점검 (p.14 기준을 캠페인 합계에 적용).`,
      '타겟 원칙: 건강 상태를 추정해 개인을 타겟팅하지 않고, 고객이 직접 검색한 키워드와 제품 선택 맥락으로 운영합니다 (p.34).',
    ],
    counter: [
      (() => {
        const below = belowTargetKeywords(d);
        return below.length
          ? `캠페인 합계 ROAS가 높아도 키워드 단위로는 목표 미달 키워드 ${below.length}개(${below.slice(0, 3).map((k) => `${k.keyword} ${fmt.roas(k.roas)}`).join(' · ')})가 섞여 있어, 캠페인 단위 증액보다 키워드 단위 입찰 조정(AD Pilot)이 먼저입니다.`
          : '키워드 단위 목표 미달은 없지만, 캠페인 합계 ROAS는 고효율 키워드가 끌어올린 값일 수 있어 키워드 단위 입찰 조정(AD Pilot)을 함께 봅니다.';
      })(),
    ],
    actions: [
      'SA Lead AE: 확대 여지 캠페인의 노출 손실 회수는 AD Pilot 입찰 상향 후보로 처리하고(일 조정 폭 ±20%), 비교 · 검토 캠페인은 랜딩 분리 테스트를 먼저 진행합니다.',
      'SA AE: 생활 상황 · 문제 해결 구문형 후보를 MILDO Lab 테스트 그룹으로 등록합니다 (14일 · 목표 ROAS 100% 이상 확장).',
    ],
  };
}

export function newMediaBrief(d: Dataset, weights?: Record<CriterionId, number>, pilots?: PilotInput[], scores?: ScoreTable, committed?: Record<string, number>): Brief {
  const ranked = scoreNewMedia(weights, scores);
  const model = allocationModel(d);
  const plan = pilotPlan(d, pilots ?? defaultPilots(ranked), { marginalRoas: model.equalize.marginalRoas, committed });
  const active = plan.rows.filter((r) => r.budget > 0);
  const co = coPromoDemand(d);
  return {
    title: '신규 매체 발굴 · 코프로모션 (p.38–39)',
    facts: [
      `후보 점수 (기준 5개 가중 · 데모 평가): ${ranked.map((r) => `${r.name} ${fmt.int(r.total)}점`).join(' · ')}.`,
      `파일럿 ${active.length}개 ${fmt.krw(plan.total)} / 한도 연 예산 ${Math.round(NEW_MEDIA_PILOT.maxBudgetShare * 100)}% ${fmt.krw(plan.cap)} (p.38)${plan.committedTotal > 0 ? ` · 이 중 승인 흐름 ${fmt.krw(plan.committedTotal)}` : ''}. DA 평균 CPA ${fmt.won(plan.baseCpa)} · 객단가 ${fmt.won(plan.aov)} (최근 30일, TEST DATA).`,
    ],
    patterns: [
      `코프로모션 구매 순간별 관련 SA 검색 수요 (월간, TEST DATA): ${co.map((c) => `${c.moment} ${fmt.int(c.monthlySearch)}회`).join(' · ')}.`,
    ],
    interpretation: [
      `신규 매체는 평균 ROAS가 아니라 증분 ROAS가 기존 매체의 한계 ROAS ${fmt.roas(plan.threshold)}를 넘는지로 판단합니다. 같은 예산을 기존 매체에 더 넣었을 때의 매출이 기회비용입니다.`,
      active.length
        ? `${active.map((r) => `${r.name}은 예상 전환 ${fmt.int(r.expectedConv)}건${r.status === 'short' ? `으로 판정 표본 ${fmt.int(r.minConv)}건에 미달` : ''}`).join(' · ')}입니다.`
        : '현재 배정된 파일럿 예산이 없습니다.',
    ],
    conditions: [
      `파일럿 규칙: ${plan.rule} (p.38). 필요 전환 수는 포아송 상대오차 ±25% · 신뢰수준 95% 기준.`,
      `코프로모션 운영 원칙: ${CO_PROMO_PRINCIPLES.rules} · ${CO_PROMO_PRINCIPLES.matching} (p.39).`,
    ],
    counter: [
      '측정 가능성(매출 귀속) 점수가 낮은 후보는 증분 매출을 분리할 수 없어, 점수가 높아도 4주 안에 확대 · 중단 판정을 내리지 못할 수 있습니다.',
      (() => {
        const alt = scoreNewMedia({ fit: 0, context: 0, measure: 0, cost: 0, brand: 100 }, scores)[0];
        return alt && alt.name !== ranked[0]?.name
          ? `가중치를 브랜드 적합성 중심으로 바꾸면 1순위가 ${ranked[0]?.name}에서 ${alt.name}으로 바뀝니다. 가중치는 수면밀도와 합의한 뒤 고정합니다.`
          : '가중치를 브랜드 적합성 중심으로 바꿔도 1순위는 유지됩니다. 가중치는 수면밀도와 합의한 뒤 고정합니다.';
      })(),
    ],
    actions: [
      'PM: 상위 후보 파일럿안(예산 · 4주 · 판정 기준)을 신규 캠페인으로 수면밀도 승인 요청 (GFA 위임 범위 기준 신규 캠페인 = 수면밀도 승인).',
      'DA AE: 파일럿 매체별 전환 귀속 방식(브랜드스토어 · 자사몰 UTM, 매체 리프트)을 집행 전에 확정합니다.',
    ],
  };
}

export function overviewBrief(d: Dataset): Brief {
  const sig = growthSignals(d);
  return {
    title: '매출 성장 고도화 — 성장 과제 (p.30–42)',
    facts: sig.length ? sig.map((s) => `${s.title}. ${s.basis}.`) : ['성장 과제를 계산할 데이터가 없습니다.'],
    patterns: [],
    interpretation: sig.length ? [
      '광고비를 늘리지 않고 바꿀 수 있는 항목(랜딩 분리 · 자사몰 장바구니 이탈 · 품절 랜딩)은 CAC를 직접 낮추는 경로이고, 재배분과 신규 매체는 곡선 · 기여 가정이 들어간 시나리오입니다. 앞의 것은 바로 실행하고, 뒤의 것은 테스트로 검증한 뒤 반영합니다.',
    ] : [],
    conditions: ['재배분 월 1회 · 분기 구조 리뷰 (p.37) · 파일럿 연 예산 5% 이내 · 4주 (p.38) · 2027 분기별 성장 캘린더는 협업 제안 가안 (p.42).'],
    counter: ['DA→SA 기여를 반영하면 GFA 감액 결론이 바뀌므로, 재배분은 홀드아웃 결과를 확인한 범위에서만 진행합니다.'],
    actions: ['PM: 이번 달 재배분안 · 랜딩 분리 테스트 · 홀드아웃 설계를 하나의 월간 리뷰 안건으로 묶어 수면밀도에 상정합니다 (월간 리뷰).'],
  };
}
