/* SA 업무 자동화 절감 (p.19) · 절감 시간 재투입 · 자동화 적용 일정 90일 (p.20) */
import { useMemo, useState } from 'react';
import { fmt, fmtDate } from '@/core/util';
import { Button, Callout, Card, CopyButton, Pill, Segmented, Src, Stat, type Tone as UiTone } from '@/ui/primitives';
import { ShareBar } from '@/ui/charts';
import { Icon } from '@/ui/Icon';
import { aboutHours, automationRollout, computeSavings, fmtCut, measuredVerdict, parseBoundedInput, reinvestPlan, type PhaseStatus, type SavingsMode, type SavingsResult } from './engine';
import { KICKOFF_ASSUMED, REFERENCE_BRANDS, REINVEST_DEFAULT, ROLLOUT_SUB, SAVINGS_CONFIRM_DAYS, SAVINGS_FLOOR_PCT, SAVINGS_INPUT_MAX_MIN, WEEK_MINUTES_PER_FTE } from './data';

export interface SavingsInputs {
  before: Record<string, number>;
  measured: Record<string, number | null>;
  mode: SavingsMode;
  shares: Record<string, number>;
  kickoff: string;
}
export const DEFAULT_SAVINGS_INPUTS: SavingsInputs = {
  before: {}, measured: {}, mode: 'ratio',
  shares: Object.fromEntries(REINVEST_DEFAULT.map((r) => [r.id, r.share])),
  kickoff: KICKOFF_ASSUMED,
};

const REINVEST_COLOR: Record<string, string> = { keyword: '--series-1', test: '--series-3', analysis: '--series-7' };
const min = (v: number) => `${fmt.int(v)}분`;
const PHASE_PILL: Record<PhaseStatus, { tone: UiTone; label: string }> = {
  before: { tone: 'outline', label: '예정' },
  now: { tone: 'accent', label: '진행 중' },
  done: { tone: 'good', label: '완료' },
};

/**
 * 숫자 입력 — 입력 중에는 문자열 초안을 유지해 값을 지워도 즉시 기본값으로 되돌아가지 않는다.
 * 유효한 값(0 이상 · max 이하)만 반영하고, allowEmpty면 빈 값도 반영(실측 미입력 = null)한다. 포커스가 빠지면 반영된 값으로 표시를 맞춘다.
 */
function DraftNumber({ id, value, onCommit, label, step, max, className, placeholder, allowEmpty }: {
  id: string; value: number | null; onCommit: (raw: string) => void; label: string; step: number; max?: number; className: string; placeholder?: string; allowEmpty?: boolean;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const shown = draft ?? (value === null || !Number.isFinite(value) ? '' : String(value));
  // 음수 · 상한 초과 등 반영하지 않는 값은 입력칸에 그대로 두되 오류로 표시한다 (포커스가 빠지면 마지막 반영값으로 되돌아감)
  const invalid = draft !== null && draft !== '' && parseBoundedInput(draft, max) === null;
  const errId = `${id}-err`;
  return (
    <>
      <input id={id} className={`${className}${invalid ? ' invalid' : ''}`} type="number" min={0} max={max} step={step} aria-label={label} placeholder={placeholder} value={shown}
        aria-invalid={invalid || undefined} aria-describedby={invalid ? errId : undefined}
        onChange={(e) => {
          const raw = e.target.value;
          setDraft(raw);
          if (raw === '') { if (allowEmpty) onCommit(''); return; }
          if (parseBoundedInput(raw, max) !== null) onCommit(raw);
        }}
        onBlur={() => setDraft(null)} />
      {invalid ? <div id={errId} className="xs reports-input-err" role="alert">{max !== undefined ? `0~${fmt.int(max)} 숫자만 반영` : '0 이상 숫자만 반영'}</div> : null}
    </>
  );
}

/** 절감표 마크다운 (복사용) */
function savingsMarkdown(s: SavingsResult): string {
  const head = '| 업무 | 자동화 방식 | 기존 (분/주) | 자동화 후 목표 | 절감률 | 실측 |\n| --- | --- | ---: | ---: | ---: | ---: |';
  const body = s.rows.map((r) => `| ${r.task} | ${r.how} | ${fmt.int(r.before)}${r.edited ? ' (수정)' : ''} | ${fmt.int(r.after)} | ${fmtCut(r.reductionPct)} | ${r.measured !== null ? fmt.int(r.measured) : '—'} |`).join('\n');
  const total = `| 합계 | | ${fmt.int(s.before)} | ${fmt.int(s.after)} | ${fmtCut(s.reductionPct)} | ${s.measured ? `${fmt.int(s.measured.after)} (${s.measured.tasks}개 업무)` : '—'} |`;
  return [
    '## SA 업무 자동화 범위 · 절감 목표 (제안서 p.19)',
    `주간 합계 ${fmt.int(s.before)}분 → ${fmt.int(s.after)}분 (${fmtCut(s.reductionPct)}, 약 ${fmt.int(aboutHours(s.before))}시간 → 약 ${fmt.int(aboutHours(s.after))}시간) · 판정 ${s.verdict.label} — ${s.verdict.basis}`,
    head, body, total,
    `기존 소요는 가정값이며 온보딩 ${SAVINGS_CONFIRM_DAYS}일 내 실측으로 확정합니다. 도입 브랜드 실적(최소 ${SAVINGS_FLOOR_PCT}%)을 하한으로 둔 목표입니다.`,
  ].join('\n\n');
}

export function SavingsTab({ today, inputs, setInputs }: { today: string; inputs: SavingsInputs; setInputs: (f: (p: SavingsInputs) => SavingsInputs) => void }) {
  const s = useMemo(() => computeSavings({ before: inputs.before, measured: inputs.measured, mode: inputs.mode }), [inputs.before, inputs.measured, inputs.mode]);
  const plan = useMemo(() => reinvestPlan(s.saved, REINVEST_DEFAULT.map((r) => ({ id: r.id, label: r.label, share: inputs.shares[r.id] ?? r.share }))), [s.saved, inputs.shares]);
  const ro = useMemo(() => automationRollout(inputs.kickoff, today, s), [inputs.kickoff, today, s]);
  const maxBar = Math.max(1, ...s.rows.map((r) => Math.max(r.before, r.measured ?? 0)));
  const shareTotal = REINVEST_DEFAULT.reduce((a, r) => a + (inputs.shares[r.id] ?? r.share), 0);
  const floorAfter = s.before * (1 - SAVINGS_FLOOR_PCT / 100);
  const edited = s.edited || Object.values(inputs.measured).some((v) => v !== null && v !== undefined);
  const setBefore = (task: string, raw: string) => setInputs((p) => {
    const next = { ...p.before };
    const v = parseBoundedInput(raw, SAVINGS_INPUT_MAX_MIN);
    if (v === null) delete next[task];
    else next[task] = v;
    return { ...p, before: next };
  });
  const setMeasured = (task: string, raw: string) => setInputs((p) => {
    return { ...p, measured: { ...p.measured, [task]: parseBoundedInput(raw, SAVINGS_INPUT_MAX_MIN) } };
  });
  const setShare = (id: string, raw: string) => setInputs((p) => {
    return { ...p, shares: { ...p.shares, [id]: parseBoundedInput(raw, 100) ?? 0 } };
  });
  const confirmDate = ro.confirmDate;
  const d90 = ro.phases.find((p) => p.id === 'd90');

  return (
    <div className="stack-lg">
      <div className="grid g-3">
        <Card tone="dark" className="span-2" title="SA 업무 자동화 범위 · 절감 목표" sub="주간 SA 운영 업무 기준 · 도입 브랜드 실적(최소 40%)을 하한으로 둔 목표이며, 온보딩 30일 내 실측으로 확정합니다."
          actions={<><Src kind="PROPOSAL" page="p.19" />{s.edited ? <Pill tone="warning" icon="edit">기존 값 수정됨</Pill> : null}</>}>
          <div className="reports-sv-head">
            <div className="stack-sm" style={{ gap: 4 }}>
              <span className="xs muted">주간 합계 · 목표</span>
              <span className="reports-big accent">{fmtCut(s.reductionPct)}</span>
              <span className="small num">{min(s.before)} → {min(s.after)} / 주 · 약 {fmt.int(aboutHours(s.before))}시간 → 약 {fmt.int(aboutHours(s.after))}시간</span>
              <span className="row" style={{ gap: 6 }}>
                <Pill tone={s.verdict.tone as UiTone} icon={s.meetsFloor ? 'check' : 'alert'}>{s.verdict.label}</Pill>
                <span className="xs muted">{s.verdict.basis}</span>
              </span>
            </div>
            <div className="reports-total-bars" role="img" aria-label={`기존 ${s.before}분, 자동화 후 목표 ${s.after}분, 하한 기준 ${Math.round(floorAfter)}분`}>
              <div className="reports-total-bar">
                <span>기존 (가정)</span>
                <div className="track"><span style={{ width: '100%', background: 'var(--panel-muted)' }} /></div>
                <span className="num">{min(s.before)}</span>
              </div>
              <div className="reports-total-bar">
                <span>자동화 후 목표</span>
                <div className="track reports-track-marked">
                  <span style={{ width: `${s.before > 0 ? (s.after / s.before) * 100 : 0}%`, background: 'var(--accent)' }} />
                  <i style={{ left: `${100 - SAVINGS_FLOOR_PCT}%` }} title={`하한 −${SAVINGS_FLOOR_PCT}% = ${Math.round(floorAfter)}분`} />
                </div>
                <span className="num">{min(s.after)}</span>
              </div>
              {s.measured ? (
                <div className="reports-total-bar">
                  <span>실측 ({s.measured.tasks}개 업무)</span>
                  <div className="track"><span style={{ width: `${s.measured.before > 0 ? (s.measured.after / s.measured.before) * 100 : 0}%`, background: 'var(--series-1)' }} /></div>
                  <span className="num">{fmtCut(s.measured.reductionPct)}</span>
                </div>
              ) : null}
              <div className="xs muted">세로선: 하한 −{SAVINGS_FLOOR_PCT}% = 자동화 후 {min(floorAfter)} 이하 · 막대 길이는 기존 합계 대비</div>
            </div>
          </div>
        </Card>
        <Card title="연간 환산 · 확정 절차" actions={<Src kind="PROPOSAL" page="p.19 · p.20" />}>
          <div className="grid g-2" style={{ gap: 12 }}>
            <Stat label="절감 / 주" value={min(s.saved)} foot={<span className="muted">약 {fmt.dec1(s.savedHours)}시간</span>} />
            <Stat label="연간 절감" value={`${fmt.int(s.annualSavedHours)}시간`} foot={<span className="muted">52주 환산 · {fmt.dec1(s.fte)}명분</span>} />
          </div>
          <div className="xs muted">인력 환산은 주 {WEEK_MINUTES_PER_FTE / 60}시간 = 1명 가정입니다. 절감은 인력 축소가 아니라 키워드 확장 · 테스트 · 분석으로 재투입합니다.</div>
          <div className="divider" />
          <div className="stack-sm small">
            <div className="row" style={{ gap: 6, flexWrap: 'nowrap', alignItems: 'flex-start' }}><Icon name="target" size={15} /><span><strong>기존 소요 실측 확정</strong> · 온보딩 {SAVINGS_CONFIRM_DAYS}일 내 ({fmtDate(confirmDate)}까지) — 표의 기존 값을 실측으로 바꿉니다.</span></div>
            <div className="row" style={{ gap: 6, flexWrap: 'nowrap', alignItems: 'flex-start' }}><Icon name="check" size={15} /><span><strong>리소스 절감 실측 보고</strong> · D+90 ({d90 ? fmtDate(d90.end) : '—'}) — 실측 열에 자동화 후 소요를 기록합니다.</span></div>
          </div>
        </Card>
      </div>

      <Card title="업무별 주간 소요 · 기존 vs 자동화 후" sub="기존 값을 수정하면 합계 · 절감률 · 판정 · 재투입 계획 · 90일 일정이 다시 계산됩니다. 기존은 가정값입니다."
        actions={
          <>
            <Segmented<SavingsMode> label="재계산 방식" value={inputs.mode} onChange={(mode) => setInputs((p) => ({ ...p, mode }))}
              options={[{ id: 'ratio', label: '업무별 절감률 유지' }, { id: 'fixed', label: '자동화 후 목표 분 고정' }]} />
            <Src kind="PROPOSAL" page="p.19" />
            <Button size="sm" icon="refresh" disabled={!edited} onClick={() => setInputs((p) => ({ ...p, before: {}, measured: {} }))}>제안서 기본값</Button>
            <CopyButton text={() => savingsMarkdown(s)} label="절감표 복사" />
          </>
        }>
        <div className="table-wrap">
          <table className="tbl reports-sv-table">
            <thead>
              <tr>
                <th>업무 · 자동화 방식</th><th>MILDO OS</th><th className="r">기존 (분/주)</th><th className="r">자동화 후 목표</th><th className="r">절감</th><th className="r">절감률</th>
                <th>기존 · 목표 · 실측</th><th className="r">실측 (D+90)</th><th>실측 판정 · 기준</th>
              </tr>
            </thead>
            <tbody>
              {s.rows.map((r, ri) => {
                const v = measuredVerdict(r.measuredReductionPct, r.reductionPct);
                return (
                  <tr key={r.task}>
                    <td><strong>{r.task}</strong><div className="xs muted">{r.how}</div></td>
                    <td><a className="small" href={`#${r.route}`}>{r.moduleLabel || r.route}</a></td>
                    <td className="r">
                      <DraftNumber id={`reports-sv-before-${ri}`} className={`input num reports-input-sm${r.edited ? ' edited' : ''}`} step={10} max={SAVINGS_INPUT_MAX_MIN} label={`${r.task} 기존 분/주`} value={r.before} onCommit={(raw) => setBefore(r.task, raw)} />
                      {r.edited ? <div className="xs muted num">제안서 {fmt.int(r.defaultBefore)}</div> : null}
                    </td>
                    <td className="r num">{fmt.int(r.after)}{r.edited ? <div className="xs muted">제안서 {fmt.int(r.defaultAfter)}</div> : null}</td>
                    <td className="r num">{fmt.int(r.saved)}</td>
                    <td className="r num"><strong>{fmtCut(r.reductionPct)}</strong></td>
                    <td>
                      <div className="reports-sbar" aria-hidden>
                        <div className="reports-sbar-row" style={{ width: `${(r.before / maxBar) * 100}%` }} />
                        <div className="reports-sbar-row after" style={{ width: `${(r.after / maxBar) * 100}%` }} />
                        {r.measured !== null ? <div className="reports-sbar-row measured" style={{ width: `${(r.measured / maxBar) * 100}%` }} /> : null}
                      </div>
                    </td>
                    <td className="r">
                      <DraftNumber id={`reports-sv-measured-${ri}`} className="input num reports-input-sm" step={5} max={SAVINGS_INPUT_MAX_MIN} placeholder="—" allowEmpty label={`${r.task} 자동화 후 실측 분/주`} value={r.measured} onCommit={(raw) => setMeasured(r.task, raw)} />
                    </td>
                    <td>
                      {v ? (
                        <div className="stack-sm" style={{ gap: 2 }}><Pill tone={v.tone as UiTone}>{v.label}</Pill><span className="xs muted">{v.basis}</span></div>
                      ) : <span className="xs muted">실측 전 · 목표 {fmtCut(r.reductionPct)} · 하한 −{SAVINGS_FLOOR_PCT}%</span>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
            <tfoot>
              <tr>
                <td>합계</td><td />
                <td className="r num">{fmt.int(s.before)}</td>
                <td className="r num">{fmt.int(s.after)}</td>
                <td className="r num">{fmt.int(s.saved)}</td>
                <td className="r num">{fmtCut(s.reductionPct)}</td>
                <td className="small">약 {fmt.int(aboutHours(s.before))}시간 → 약 {fmt.int(aboutHours(s.after))}시간</td>
                <td className="r num">{s.measured ? fmt.int(s.measured.after) : '—'}</td>
                <td>{s.measured ? <div className="stack-sm" style={{ gap: 2 }}><Pill tone={s.measured.verdict.tone as UiTone}>{s.measured.verdict.label}</Pill><span className="xs muted" style={{ fontWeight: 400 }}>{s.measured.verdict.basis}</span></div> : <span className="xs muted" style={{ fontWeight: 400 }}>D+90 실측 보고에서 확정</span>}</td>
              </tr>
            </tfoot>
          </table>
        </div>
        <div className="legend">
          <span className="legend-item"><span className="legend-swatch" style={{ background: 'var(--line-strong)' }} />기존 (가정)</span>
          <span className="legend-item"><span className="legend-swatch" style={{ background: 'var(--ink)' }} />자동화 후 목표</span>
          <span className="legend-item"><span className="legend-swatch" style={{ background: 'var(--series-1)' }} />실측 (입력 시)</span>
          <span className="xs muted">{inputs.mode === 'ratio' ? '업무별 절감률 유지: 기존을 바꾸면 자동화 후도 같은 비율로 바뀝니다.' : '자동화 후 목표 분 고정: 기존을 바꿔도 자동화 후 목표 분은 유지됩니다 (기존보다 클 수 없음).'}</span>
        </div>
      </Card>

      <div className="grid g-2">
        <Card title="절감 시간 재투입 계획" sub={`주 ${min(s.saved)} · 연 ${fmt.int(s.annualSavedHours)}시간 · 배분 비율은 가안 (온보딩 중 확정)`} actions={<><Src kind="PROPOSAL" page="p.11 · p.19" /><Button size="sm" variant="ghost" icon="refresh" onClick={() => setInputs((p) => ({ ...p, shares: DEFAULT_SAVINGS_INPUTS.shares }))}>기본 비율</Button></>}>
          <div className="small ink2">절감된 시간은 키워드 확장과 전환 개선 실험에 재투입합니다.</div>
          <ShareBar parts={plan.map((p) => ({ label: p.label, value: p.minutesPerWeek > 0 ? p.minutesPerWeek : p.sharePct, colorVar: REINVEST_COLOR[p.id] ?? '--series-2' }))} format={(v) => `${(v * 100).toFixed(0)}%`} />
          <div className="table-wrap">
            <table className="tbl">
              <thead><tr><th>재투입 영역</th><th className="r">비중</th><th className="r">분 / 주</th><th className="r">시간 / 연</th></tr></thead>
              <tbody>
                {plan.map((p) => {
                  const meta = REINVEST_DEFAULT.find((r) => r.id === p.id)!;
                  return (
                    <tr key={p.id}>
                      <td><strong>{p.label}</strong><div className="xs muted">{meta.detail}</div><a className="xs" href={`#${meta.route}`}>화면 열기 →</a></td>
                      <td className="r"><DraftNumber id={`reports-sv-share-${p.id}`} className="input num reports-input-xs" step={5} max={100} label={`${p.label} 비중`} value={inputs.shares[p.id] ?? meta.share} onCommit={(raw) => setShare(p.id, raw)} />{shareTotal !== 100 ? <div className="xs muted num">정규화 {Math.round(p.sharePct)}%</div> : null}</td>
                      <td className="r num">{fmt.int(p.minutesPerWeek)}</td>
                      <td className="r num">{fmt.int(p.hoursPerYear)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Card>
        <Card title="하한 근거 · 도입 브랜드 리소스 절감 실적" sub="같은 솔루션을 쓰는 3개 브랜드에서 반복 업무 리소스가 최소 40% 줄었습니다." actions={<Src kind="PROPOSAL" page="p.11" />}>
          <div className="stack-sm">
            {REFERENCE_BRANDS.map((b) => (
              <div key={b.id} className="row-between reports-ref">
                <div className="stack-sm" style={{ gap: 0 }}><strong className="small">{b.name}</strong><span className="xs muted">{b.category}</span></div>
                <Pill tone="dark">{b.result}</Pill>
              </div>
            ))}
          </div>
          <Callout tone="info" title="목표 · 하한 · 실측의 관계">
            제안서 목표 −{Math.round(s.targetPct)}%는 업무별 자동화 수단을 적용했을 때의 가정치이고, 하한 −{SAVINGS_FLOOR_PCT}%는 도입 브랜드 실적입니다. 실측이 하한에 못 미치면 해당 업무의 자동화 범위와 수단을 재설계하고, 하한 이상 · 목표 미만이면 업무별 원인을 D+90 보고에 기록합니다. 브랜드명은 블라인드이며 브랜드별 실측 보고서는 Q&A 근거자료로 제공합니다.
          </Callout>
        </Card>
      </div>

      <Card title="자동화 적용 일정 · 90일" sub={ROLLOUT_SUB}
        actions={
          <>
            <Src kind="PROPOSAL" page="p.20" />
            <label className="row small" htmlFor="reports-kickoff" style={{ gap: 6 }}>
              <span className="muted">Kick-off</span>
              <input id="reports-kickoff" type="date" className="input" style={{ width: 150, padding: '4px 8px' }} value={inputs.kickoff} onChange={(e) => setInputs((p) => ({ ...p, kickoff: e.target.value || KICKOFF_ASSUMED }))} />
            </label>
            <Pill tone="outline">{Number.isFinite(ro.daysToKickoff) ? (ro.daysToKickoff > 0 ? `Kick-off까지 D-${ro.daysToKickoff}` : ro.daysToKickoff === 0 ? 'Kick-off 당일' : `Kick-off 후 D+${-ro.daysToKickoff}`) : '—'}</Pill>
          </>
        }>
        <div className="xs muted">기본 Kick-off는 최종 선정(26.11.24 주차) 후 {fmtDate(KICKOFF_ASSUMED)} 시작 가정이며 협의로 확정합니다. 단계 상태는 데이터 기준일 {fmtDate(today)} 기준입니다.</div>
        <div className="grid g-3">
          {ro.phases.map((p, i) => (
            <div key={p.id} className={`reports-phase${p.status === 'now' ? ' hl' : ''}`}>
              <div className="row-between">
                <span className="reports-phase-day">D+{p.day}</span>
                <Pill tone={PHASE_PILL[p.status].tone}>{PHASE_PILL[p.status].label}</Pill>
              </div>
              <div><strong>{p.label.replace(/^D\+\d+\s*/, '')}</strong> <span className="xs muted num">{fmtDate(p.start)}–{fmtDate(p.end)}</span></div>
              <ul>{p.items.map((it) => <li key={it}>{it}</li>)}</ul>
              <div className="small">
                <span className="muted">가동 모듈 (p.22) · </span>
                {p.modules.map((m, j) => <span key={m.route}>{j ? ' · ' : ''}<a href={`#${m.route}`}>{m.label}</a></span>)}
              </div>
              <div className="small">
                <span className="muted">적용 업무 (p.19) · </span>
                {p.tasks.length ? p.tasks.map((t) => `${t.task} −${fmt.int(t.saved)}분`).join(' · ') : i === 0 ? '없음 — 기존 입찰 로직 유지 · 기존 소요 실측' : '없음'}
              </div>
              <div className="stack-sm" style={{ gap: 3 }}>
                <div className="row-between xs"><span className="muted">단계 종료 시 주간 SA 업무 (목표 기준)</span><strong className="num">{min(p.weeklyAfter)} · {p.reductionPct >= 0.5 ? fmtCut(p.reductionPct) : '기존 유지'}</strong></div>
                <div className="bar"><span style={{ width: `${s.before > 0 ? (p.weeklyAfter / s.before) * 100 : 0}%`, background: p.id === 'd90' ? 'var(--accent)' : 'var(--ink)' }} /><i className="marker" style={{ left: `calc(${100 - SAVINGS_FLOOR_PCT}% - 1px)` }} /></div>
              </div>
              <div className="reports-metric"><span className="muted">측정 기준 · </span><strong>{p.metric}</strong>{p.id === 'd30' ? ` · 기존 소요 실측 확정 ${fmtDate(ro.confirmDate)}` : ''}</div>
            </div>
          ))}
        </div>
        <div className="xs muted">업무별 적용 단계는 p.20 단계 항목(D+60 Board v1 · Watch · Alert 가동 · 키워드 발굴 시작, D+90 AD Pilot 자동 조정)에 맞춘 운영 가정입니다. 병행 운영 기간에는 기존 로직을 유지해 성과 공백을 줄입니다. 세부 주차 일정은 <a href="#ops">전담 TF · 온보딩</a> 화면의 90일 간트에서 봅니다.</div>
      </Card>
    </div>
  );
}
