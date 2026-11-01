/* p.58 운영 수수료 및 계약 조건 · p.37 연 50억 배분 기준 계산기 */
import { RFP } from '@/data/constants';
import { fmt } from '@/core/util';
import { Button, Callout, Card, CopyButton, Field, NumberInput, Pill, Segmented, Src, Stat } from '@/ui/primitives';
import { RFP_NOTES } from './data';
import { annualCost, type contractCheck, type FeeCalc, type FeeInput, type PaybackChoice, type SolutionFeeChoice } from './engine';
import type { OpsLocal } from './local';
import { InputFlag } from './parts';

type Contract = ReturnType<typeof contractCheck>;

function feeMarkdown(f: FeeCalc, c: Contract): string {
  const out = ['## 운영 수수료 및 계약 조건 (제안서 p.58)', '', '| 매체 | 연 광고비 (p.37 배분) | 수수료 | 페이백 | 연 순 수수료 |', '|---|---|---|---|---|'];
  for (const r of f.rows) out.push(`| ${r.media} | ${fmt.krw(r.budget)}원 | ${r.feePct !== null ? `${r.feePct}%` : '[n]%'} | ${r.payback === 'unset' ? '[적용 여부]' : r.payback === 'yes' ? `적용 ${r.paybackPct ?? '[n]'}%` : '미적용'} | ${r.net !== null ? `${fmt.krw(r.net)}원` : '—'} |`);
  out.push('', ...c.items.map((i) => `- ${i.label}: ${i.value}`));
  return out.join('\n') + '\n';
}

export function ContractTab({ fee, contract, local, patch }: { fee: FeeCalc; contract: Contract; local: OpsLocal; patch: (p: Partial<OpsLocal> | ((s: OpsLocal) => Partial<OpsLocal>)) => void }) {
  const cost = annualCost(fee, contract);
  const setFee = (media: string, p: Partial<FeeInput>) => patch((s) => ({ fees: { ...s.fees, [media]: { ...(s.fees[media] ?? {}), ...p } } }));
  const setContract = (p: Partial<OpsLocal['contract']>) => patch((s) => ({ contract: { ...s.contract, ...p } }));
  const missingAll = fee.missing.total + fee.missing.invalid + contract.missing;
  const costWeight = RFP.evaluation.find((e) => e.id === 'cost')?.weight ?? 10;

  return (
    <div className="stack-lg">
      <div className="grid g-4">
        <Card>
          <Stat label={<>연간 순 수수료 <Src kind="PROPOSAL" page="p.58" /></>} value={fee.rows.some((r) => r.net !== null) ? `${fmt.krw(fee.totals.net)}원` : '—'}
            foot={<span className="xs">{fee.rows.filter((r) => r.net !== null).length}/5개 매체 입력 · 월 평균 {fee.rows.some((r) => r.net !== null) ? `${fmt.krw(fee.totals.monthlyNet)}원` : '—'}</span>} />
        </Card>
        <Card>
          <Stat label="실효 수수료율" value={fmt.pct(fee.totals.effectivePct, 2)} foot={<span className="xs">(수수료 − 페이백) ÷ 입력 매체 광고비 {fmt.krw(fee.totals.enteredBudget)}원</span>} />
        </Card>
        <Card>
          <Stat label="연간 총 비용 (VAT 별도)" value={fee.complete && contract.complete ? `${fmt.krw(cost.total)}원` : '—'}
            foot={<span className="xs">{fee.complete && contract.complete ? `광고비 대비 부대 비용 ${fmt.pct(cost.overheadPct, 2)}` : `미입력 ${missingAll}건 · 확정 후 계산`}</span>} />
        </Card>
        <Card>
          <Stat label="수수료율 1%p당" value={`${fmt.krw(fee.perPointKrw)}원`} foot={<span className="xs">연 광고비 {fmt.krw(fee.annualBudget)}원 기준 · 민감도</span>} />
        </Card>
      </div>

      <Card title="매체별 수수료 · 페이백 계산기" sub="매체별 수수료와 페이백 적용 여부를 모두 공개 · 연 광고비를 p.37 배분 가안(SA 43 · GFA 18 · Google 12 · Meta 12 · 카카오 8 · 버티컬 7)으로 나눠 계산"
        actions={<><Src kind="PROPOSAL" page="p.58" /><Src kind="PROPOSAL" page="p.37" /><InputFlag missing={fee.missing.total + fee.missing.invalid} /><CopyButton text={() => feeMarkdown(fee, contract)} label="표 복사" /></>}>
        <div className="row" style={{ alignItems: 'flex-end', gap: 14 }}>
          <Field label="연간 광고비 (원) · RFP 약 50억, 운영 방향에 따라 변동" id="ops-budget">
            <NumberInput id="ops-budget" value={local.annualBudget} min={0} step={100_000_000} onChange={(v) => patch({ annualBudget: v > 0 ? v : 0 })} suffix={`= ${fmt.krw(local.annualBudget)}원`} style={{ width: 280 }} />
          </Field>
          {local.annualBudget !== RFP.annualBudget ? <Button size="sm" icon="rollback" onClick={() => patch({ annualBudget: RFP.annualBudget })}>RFP 50억으로</Button> : null}
          <Src kind="RFP" />
        </div>
        {fee.warnings.length ? <Callout tone="warning">{fee.warnings.join(' / ')}</Callout> : null}
        <div className="table-wrap">
          <table className="tbl">
            <thead><tr><th>매체</th><th className="r">배분 비중</th><th className="r">연 광고비</th><th>수수료율</th><th className="r">연 수수료</th><th>페이백</th><th className="r">연 순 수수료</th><th className="r">실효율</th></tr></thead>
            <tbody>
              {fee.rows.map((r) => {
                const inp = local.fees[r.media] ?? {};
                return (
                  <tr key={r.media}>
                    <td><strong className="small">{r.media}</strong><div className="xs muted">{r.mediaIds.length > 1 ? 'SA + GFA' : ''}</div></td>
                    <td className="r">{fmt.ratio(r.share)}</td>
                    <td className="r">{fmt.krw(r.budget)}</td>
                    <td>
                      <div className="ops-cell-wrap">
                        <input aria-label={`${r.media} 수수료율`} inputMode="decimal" className={`input ops-cell${r.feeInvalid ? ' ops-invalid' : r.feePct === null ? ' ops-blank' : ''}`} placeholder="[n]" value={inp.fee ?? ''} onChange={(e) => setFee(r.media, { fee: e.target.value })} />
                        <span className="xs muted">%</span>
                      </div>
                      {r.feeInvalid ? <div className="xs" style={{ color: 'var(--critical-ink)' }}>0~30% 숫자</div> : null}
                    </td>
                    <td className="r">{r.fee !== null ? fmt.krw(r.fee) : '—'}</td>
                    <td>
                      <div className="row" style={{ gap: 6, flexWrap: 'nowrap' }}>
                        <Segmented<PaybackChoice> label={`${r.media} 페이백`} value={r.payback} onChange={(v) => setFee(r.media, { payback: v })}
                          options={[{ id: 'unset', label: '[적용 여부]' }, { id: 'yes', label: '적용' }, { id: 'no', label: '미적용' }]} />
                        {r.payback === 'yes' ? (
                          <div className="ops-cell-wrap">
                            <input aria-label={`${r.media} 페이백율`} inputMode="decimal" className={`input ops-cell${r.paybackInvalid ? ' ops-invalid' : r.paybackPct === null ? ' ops-blank' : ''}`} style={{ width: 60 }} placeholder="[n]" value={inp.paybackPct ?? ''} onChange={(e) => setFee(r.media, { paybackPct: e.target.value })} />
                            <span className="xs muted">%</span>
                          </div>
                        ) : null}
                      </div>
                    </td>
                    <td className="r"><strong>{r.net !== null ? fmt.krw(r.net) : '—'}</strong></td>
                    <td className="r">{fmt.pct(r.effectivePct, 2)}</td>
                  </tr>
                );
              })}
              <tr className="ops-total-row">
                <td>합계</td>
                <td className="r">{fmt.ratio(fee.rows.reduce((s, r) => s + r.share, 0))}</td>
                <td className="r">{fmt.krw(fee.annualBudget)}</td>
                <td className="xs">{fee.missing.fee ? `미입력 ${fee.missing.fee}` : '입력 완료'}</td>
                <td className="r">{fmt.krw(fee.totals.fee)}</td>
                <td className="xs">페이백 {fmt.krw(fee.totals.payback)}{fee.missing.payback ? ` · 미정 ${fee.missing.payback}` : ''}</td>
                <td className="r">{fmt.krw(fee.totals.net)}</td>
                <td className="r">{fmt.pct(fee.totals.effectivePct, 2)}</td>
              </tr>
            </tbody>
          </table>
        </div>
        <div className="xs muted">수수료 · 페이백은 광고비(VAT 별도) 대비 비율로 계산합니다. 페이백은 광고주에게 돌려주는 금액으로 보고 순 수수료에서 차감합니다. 미입력 매체는 합계에서 제외되며 실효율은 입력된 매체 광고비 기준입니다.</div>
      </Card>

      <div className="grid g-2">
        <Card title="계약 조건" sub="솔루션 이용 조건을 수수료와 분리해 명시 · 계정 · 결제는 수면밀도 소유" actions={<><Src kind="PROPOSAL" page="p.58" /><InputFlag missing={contract.missing} /></>}>
          <div className="table-wrap">
            <table className="tbl">
              <thead><tr><th>항목</th><th>조건</th><th>상태</th><th>근거</th></tr></thead>
              <tbody>
                {contract.items.map((i) => (
                  <tr key={i.id}>
                    <td className="small"><strong>{i.label}</strong></td>
                    <td className="small">
                      {i.id === 'termination' ? (
                        <div className="ops-cell-wrap"><span className="xs muted">해지</span><input aria-label="해지 통보 기한(일)" inputMode="numeric" className={`input ops-cell${i.status === 'invalid' ? ' ops-invalid' : i.status === 'missing' ? ' ops-blank' : ''}`} placeholder="[통보 기한]" value={local.contract.terminationDays ?? ''} onChange={(e) => setContract({ terminationDays: e.target.value })} /><span className="xs muted">일 전 서면 통보</span></div>
                      ) : i.id === 'solution' ? (
                        <div className="stack-sm" style={{ gap: 4 }}>
                          <Segmented<SolutionFeeChoice> label="솔루션 이용료" value={local.contract.solutionFee ?? 'unset'} onChange={(v) => setContract({ solutionFee: v })}
                            options={[{ id: 'unset', label: '[포함 여부]' }, { id: 'included', label: '수수료에 포함' }, { id: 'separate', label: '별도' }]} />
                          {local.contract.solutionFee === 'separate' ? (
                            <div className="ops-cell-wrap"><span className="xs muted">월</span><input aria-label="솔루션 이용료 월 금액" inputMode="numeric" className={`input ops-cell${i.status !== 'ok' ? ' ops-blank' : ''}`} style={{ width: 110 }} placeholder="[금액]" value={local.contract.solutionMonthly ?? ''} onChange={(e) => setContract({ solutionMonthly: e.target.value })} /><span className="xs muted">원</span></div>
                          ) : null}
                          <span className="xs muted">{i.value}</span>
                        </div>
                      ) : i.value}
                    </td>
                    <td>{i.status === 'ok' ? <Pill tone="good" icon="check">확정</Pill> : i.status === 'invalid' ? <Pill tone="critical" icon="x">오입력</Pill> : <Pill tone="warning" icon="edit">입력 필요</Pill>}</td>
                    <td className="xs muted">{i.basis}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="row" style={{ gap: 8 }}>
            <Button size="sm" icon="rollback" onClick={() => patch({ fees: {}, contract: {} })}>수수료 · 계약 입력 초기화</Button>
          </div>
        </Card>
        <Card title="평가 · 협상 기준" sub="RFP 대행사 선정 기준 원문" actions={<Src kind="RFP" />}>
          <div className="small"><Pill tone="dark">비용 · 계약 조건 {costWeight}%</Pill> <span className="muted">수수료 · 페이백 · 기간 · 해지 조건</span></div>
          <Callout tone="info" title="우선 협상 기준">{RFP_NOTES.priority}.</Callout>
          <div className="small">요율 자체보다 매체별 요율 · 페이백 적용 여부 · 솔루션 이용료 · 해지 조건이 모두 공개되어 비교 가능한지가 이 항목의 완결성 기준입니다. 연 광고비 기준 수수료율 1%p 차이는 연 {fmt.krw(fee.perPointKrw)}원입니다.</div>
          <div className="xs muted">{RFP_NOTES.undisclosed} 동점 시 수수료 조건을 종합 고려하므로 같은 실효율이라도 페이백 · 솔루션 이용료 구조를 함께 표기합니다.</div>
        </Card>
      </div>
    </div>
  );
}
