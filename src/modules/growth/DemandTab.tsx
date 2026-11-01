/* 새 수요: 신규 매체 발굴(p.38) — 기준 가중치 · 후보 점수 · 파일럿 계산기, 브랜드사별 코프로모션(p.39) */
import { useMemo, useState } from 'react';
import type { Dataset } from '@/core/types';
import { CO_PROMOTIONS, NEW_MEDIA_PILOT } from '@/data/constants';
import { clamp, fmt } from '@/core/util';
import { useActions, useStore } from '@/core/store';
import { Button, Callout, Card, NumberInput, Pill, ProgressBar, Src, Stat } from '@/ui/primitives';
import { HBarChart } from '@/ui/charts';
import { AiInsight } from '@/ui/AiInsight';
import { CO_PROMO_PRINCIPLES, NEW_MEDIA_CPA_MULT, NEW_MEDIA_SCORES, PILOT_DEFAULTS } from './data';
import { DEFAULT_WEIGHTS, coPromoDemand, defaultPilots, growthPrompt, pilotChange, pilotCommitments, pilotPlan, scoreNewMedia, type CriterionId, type ScoreTable } from './engine';
import { newMediaBrief } from './briefs';
import { Kv, Verdict } from './parts';

const STATUS: Record<'ok' | 'short' | 'off', { label: string; tone: 'good' | 'warning' | 'neutral' }> = {
  ok: { label: '판정 가능', tone: 'good' }, short: { label: '표본 부족', tone: 'warning' }, off: { label: '미배정', tone: 'neutral' },
};
/** 후보명(공백 · 기호 포함) 대신 p.38 후보 순서로 input id를 만든다 */
const candIdx = (name: string) => Math.max(0, NEW_MEDIA_PILOT.candidates.findIndex((c) => c.name === name));

export function DemandTab({ d, marginalRoas }: { d: Dataset; marginalRoas: number }) {
  const { state } = useStore();
  const { addChange, toast } = useActions();
  const [weights, setWeights] = useState<Record<CriterionId, number>>({ ...DEFAULT_WEIGHTS });
  const [scores, setScores] = useState<ScoreTable>(() => JSON.parse(JSON.stringify(NEW_MEDIA_SCORES)) as ScoreTable);
  const ranked = useMemo(() => scoreNewMedia(weights, scores), [weights, scores]);
  const [budgets, setBudgets] = useState<Record<string, number>>(() => Object.fromEntries(defaultPilots(scoreNewMedia()).map((p) => [p.name, p.budget])));
  const pilots = useMemo(() => ranked.map((r) => ({ name: r.name, budget: budgets[r.name] ?? 0 })), [ranked, budgets]);
  // 이미 승인 흐름에 올라간 파일럿은 금액을 고정하고 한도 합계에 넣는다 (탭을 다시 열어도 유지)
  const committed = useMemo(() => pilotCommitments(state.changes), [state.changes]);
  const plan = useMemo(() => pilotPlan(d, pilots, { marginalRoas, committed }), [d, pilots, marginalRoas, committed]);
  const co = useMemo(() => coPromoDemand(d), [d]);
  const wsum = NEW_MEDIA_PILOT.criteria.reduce((a, c) => a + (weights[c.id] || 0), 0);

  const request = (name: string) => {
    const row = plan.rows.find((r) => r.name === name);
    if (!row || row.requested || row.budget <= 0 || plan.overCap) return;
    const c = addChange({ ...pilotChange(row, state.role) });
    toast({ tone: 'info', title: '신규 매체 파일럿 승인 요청을 만들었습니다', body: `${c.target} · ${fmt.krw(row.budget)} · 수면밀도 승인 대기`, route: 'flow' });
  };

  return (
    <div className="stack-lg">
      <Card title={<>신규 매체 발굴 · 채널 선정 기준 <Src kind="PROPOSAL" page="p.38" /><Src kind="DEMO" title="후보 점수는 데모 평가 · 매체 미팅 후 확정" /></>}
        sub="수면밀도 타겟 데이터로 채널 선정 기준을 먼저 세우고, 소액 파일럿으로 검증한 뒤 확대 · 점수(1~5)는 데모 평가 — 온보딩 중 매체 미팅 후 확정 · 가중치 편집 시 순위 재계산">
        <div className="table-wrap">
          <table className="tbl">
            <thead>
              <tr>
                <th>후보 · 접점</th>
                {NEW_MEDIA_PILOT.criteria.map((c) => (
                  <th key={c.id} className="c" title={c.desc}>
                    <div className="stack-sm" style={{ gap: 2, alignItems: 'center' }}>
                      <span>{c.label}</span>
                      <div className="growth-mini-input"><NumberInput id={`growth-w-${c.id}`} value={weights[c.id]} step={5} min={0} max={100} onChange={(v) => setWeights({ ...weights, [c.id]: clamp(v, 0, 100) })} /></div>
                      <span className="xs muted">가중 {wsum > 0 ? fmt.ratio((weights[c.id] || 0) / wsum, 0) : '—'}</span>
                    </div>
                  </th>
                ))}
                <th className="r">점수</th><th className="r">순위</th>
              </tr>
            </thead>
            <tbody>
              {ranked.map((r) => (
                <tr key={r.name}>
                  <td><strong>{r.name}</strong><div className="xs muted">{r.touch} · {r.hypothesis}</div></td>
                  {NEW_MEDIA_PILOT.criteria.map((c) => (
                    <td key={c.id} className="c">
                      <div className="growth-mini-input" style={{ margin: '0 auto' }}>
                        <NumberInput id={`growth-s-${candIdx(r.name)}-${c.id}`} value={scores[r.name]?.[c.id] ?? 0} step={1} min={1} max={5}
                          onChange={(v) => setScores({ ...scores, [r.name]: { ...(scores[r.name] ?? ({} as Record<CriterionId, number>)), [c.id]: clamp(Math.round(v), 1, 5) } })} />
                      </div>
                    </td>
                  ))}
                  <td className="r"><strong>{fmt.int(r.total)}</strong></td>
                  <td className="r">{!Number.isFinite(r.total) ? <span className="muted">—</span> : r.rank === 1 ? <Pill tone="accent">1순위</Pill> : `${r.rank}`}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="grid g-3">
          <div className="span-2">
            <HBarChart data={ranked.map((r) => ({ label: r.name, value: Number.isFinite(r.total) ? r.total : 0, colorVar: '--series-1' }))} format={(v) => `${Math.round(v)}점`} max={100} />
          </div>
          <div className="stack-sm">
            {NEW_MEDIA_PILOT.criteria.map((c) => <Kv key={c.id} k={c.label} v={<span className="xs" style={{ fontWeight: 400 }}>{c.desc}</span>} />)}
            {wsum <= 0 ? <Callout tone="warning">가중치 합이 0이라 점수를 계산할 수 없습니다.</Callout> : null}
          </div>
        </div>
      </Card>

      <Card title={<>파일럿 계산기 <Src kind="PROPOSAL" page="p.38" /><Src kind="DEMO" /></>}
        sub={`파일럿 규칙: 연 예산의 ${Math.round(NEW_MEDIA_PILOT.maxBudgetShare * 100)}% 이내 · ${NEW_MEDIA_PILOT.weeks}주 · ${NEW_MEDIA_PILOT.rule} · 판정 기준 증분 ROAS = ${plan.thresholdBasis}`}>
        <div className="grid g-4">
          <Stat label={<>파일럿 한도 <Src kind="PROPOSAL" page="p.38" /></>} value={fmt.krw(plan.cap)} foot={<span className="xs muted">연 {fmt.krw(plan.cap / NEW_MEDIA_PILOT.maxBudgetShare)} × {Math.round(NEW_MEDIA_PILOT.maxBudgetShare * 100)}%</span>} />
          <Stat label="배정 합계" value={fmt.krw(plan.total)} foot={<span className="stack-sm" style={{ gap: 2 }}><ProgressBar value={plan.total} max={plan.cap} tone={plan.overCap ? 'critical' : 'ink'} label="파일럿 예산 사용률" /><span className="xs muted">승인 흐름 {plan.committedTotal > 0 ? fmt.krw(plan.committedTotal) : '없음'} · 남은 한도 {fmt.krw(Math.max(0, plan.remaining))}</span></span>} />
          <Stat label="판정 기준 증분 ROAS" value={fmt.roas(plan.threshold)} foot={<span className="xs muted">이 값 이상 확대 · 미달 중단</span>} />
          <Stat label="판정에 필요한 전환" value={`${fmt.int(plan.minConv)}건`} foot={<span className="xs muted">포아송 상대오차 ±{Math.round(PILOT_DEFAULTS.precision * 100)}% · 신뢰수준 {Math.round(PILOT_DEFAULTS.confidence * 100)}%</span>} />
        </div>
        {plan.overCap ? <Callout tone="critical" title="파일럿 한도 초과">배정 합계 {fmt.krw(plan.total)}가 한도 {fmt.krw(plan.cap)}를 {fmt.krw(plan.total - plan.cap)} 넘습니다. 승인 요청을 만들 수 없습니다.</Callout> : null}
        <div className="table-wrap">
          <table className="tbl">
            <thead>
              <tr>
                <th>후보</th><th className="r">4주 예산</th><th className="r">CPA 가정</th><th className="r">예상 전환</th><th className="r">필요 예산 (표본)</th><th className="r">기준 ROAS 달성 전환</th><th>판정 · 기준</th><th />
              </tr>
            </thead>
            <tbody>
              {plan.rows.map((r) => (
                <tr key={r.name}>
                  <td><strong>{r.name}</strong><div className="xs muted">순위 {Number.isFinite(ranked.find((x) => x.name === r.name)?.total ?? NaN) ? ranked.find((x) => x.name === r.name)?.rank : '—'}</div></td>
                  <td className="r growth-pilot-budget" style={{ minWidth: 170 }}>
                    {r.requested
                      ? <span className="stack-sm" style={{ gap: 0, alignItems: 'flex-end' }}><strong className="num">{fmt.krw(r.budget)}</strong><span className="xs muted">승인 흐름 · 금액 고정</span></span>
                      : <NumberInput id={`growth-pb-${candIdx(r.name)}`} value={r.budget} step={5_000_000} min={0} suffix={fmt.krw(r.budget)} onChange={(v) => setBudgets({ ...budgets, [r.name]: Math.max(0, v) })} />}
                  </td>
                  <td className="r">{fmt.won(r.cpa)}<div className="xs muted">DA 평균 × {NEW_MEDIA_CPA_MULT[r.name] ?? 1}</div></td>
                  <td className="r"><strong>{fmt.dec1(r.expectedConv)}</strong></td>
                  <td className="r">{fmt.krw(r.budgetForMin)}</td>
                  <td className="r">{fmt.dec1(r.breakEvenConv)}<div className="xs muted">증분 ROAS {fmt.roas(r.threshold)} · 객단가 기준</div></td>
                  <td><Verdict tone={STATUS[r.status].tone} label={STATUS[r.status].label} basis={r.status === 'off' ? '예산 미배정' : `예상 ${fmt.dec1(r.expectedConv)} vs 필요 ${fmt.int(r.minConv)}건`} /></td>
                  <td className="r">
                    {r.requested ? <a className="xs" href="#flow">요청됨 · MILDO Flow</a> : (
                      <Button size="sm" icon="send" disabled={r.budget <= 0 || plan.overCap} onClick={() => request(r.name)} title={plan.overCap ? '파일럿 한도 초과' : r.budget <= 0 ? '예산 미배정' : undefined}>승인 요청</Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="xs muted">
          CPA 가정 = 최근 30일 DA 평균 CPA {fmt.won(plan.baseCpa)} (GFA · Meta · Google, TEST DATA) × 후보별 배수(데모 가정) · 객단가 {fmt.won(plan.aov)} · 표본 부족 후보는 예산을 늘리거나 기간을 연장하지 않으면 4주 안에 확대 · 중단 판정을 내릴 수 없습니다. 신규 캠페인은 수면밀도 승인 (GFA 위임 범위 기준).
        </div>
      </Card>

      <Card title={<>브랜드사별 코프로모션 <Src kind="PROPOSAL" page="p.39" /></>} sub="수면밀도 고객이 매트리스를 사는 순간에 함께 필요한 브랜드와 손잡고, 서로의 고객에게 새 구매 이유를 만듭니다 · 관련 검색 수요는 SA 키워드 기준 (TEST DATA)">
        <div className="grid g-4">
          {co.map((c) => (
            <div key={c.moment} className="growth-group">
              <span className="xs muted">구매 순간</span>
              <strong style={{ fontSize: 'var(--fs-lg)' }}>{c.moment}</strong>
              <span className="small">{c.partners}</span>
              <span className="small"><strong>{c.idea}</strong></span>
              <span className="growth-chip">{c.format}</span>
              <div className="stack-sm" style={{ gap: 2, marginTop: 4 }}>
                <Kv k={<>관련 월 검색량 <Src kind="DEMO" /></>} v={fmt.int(c.monthlySearch)} />
                <Kv k="관련 키워드 ROAS" v={fmt.roas(c.roas)} />
                <span className="xs muted">{c.keywords.length ? c.keywords.join(' · ') : '연결 키워드 없음'}</span>
              </div>
            </div>
          ))}
        </div>
        <div className="grid g-2">
          <Callout tone="info" title="파트너 매칭">{CO_PROMO_PRINCIPLES.matching}</Callout>
          <Callout tone="accent" icon="shield" title="운영 원칙">{CO_PROMO_PRINCIPLES.rules}</Callout>
        </div>
        <div className="xs muted">코프로모션 {CO_PROMOTIONS.length}개 구매 순간은 2027 분기별 성장 캘린더(p.42)의 신규 매체 · 코프로모션 행과 연결됩니다 — 협업 제안 가안이며 확정 일정이 아닙니다.</div>
      </Card>

      <AiInsight title="새 수요 해석" sub="증분 매출 기준 · 기존 매체 한계 ROAS 대비 기회비용" buildPrompt={() => growthPrompt('demand', d, { 점수: ranked.map((r) => ({ 후보: r.name, 점수: Math.round(r.total) })), 파일럿: plan.rows.map((r) => ({ 후보: r.name, 예산: r.budget, 예상전환: Math.round(r.expectedConv), 상태: r.status })), 판정기준ROAS: Math.round(plan.threshold), 한도: plan.cap, 코프로모션: co.map((c) => ({ 순간: c.moment, 월검색량: c.monthlySearch })) })}
        fallback={() => newMediaBrief(d, weights, pilots, scores, committed)} />
    </div>
  );
}
