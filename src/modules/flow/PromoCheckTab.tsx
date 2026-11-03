/* 프로모션 체크리스트 · 오픈 전 자동 점검 (p.31 프로모션 준비 → 오픈 사고 예방) */
import { useState } from 'react';
import { SALES_CHANNELS } from '@/data/constants';
import { fmtDate } from '@/core/util';
import { AiInsight } from '@/ui/AiInsight';
import { Button, Card, Pill, Src } from '@/ui/primitives';
import { CHECK_GROUPS, STATUS_META } from './data';
import { APPROVER_LABEL, promoCheckBrief, type CheckItem, type PromoCheck } from './engine';
import { LevelPill } from './parts';
import type { FlowCtx } from './useFlow';

export function PromoCheckTab({ ctx, onOpen, onReport }: { ctx: FlowCtx; onOpen: (id: string) => void; onReport: (promoId: string) => void }) {
  const { checks, data, changes, incidents, actions } = ctx;
  const firstBad = checks.find((c) => c.counts.fail) ?? checks[0];
  const [sel, setSel] = useState<string>(firstBad?.promotion.id ?? '');
  const [ranAt, setRanAt] = useState<string | null>(null);
  const cur = checks.find((c) => c.promotion.id === sel) ?? checks[0];
  const rerun = () => {
    setRanAt(`${fmtDate(data.today)} ${String(data.currentHour).padStart(2, '0')}:30 기준`);
    const f = checks.reduce((a, c) => a + c.counts.fail, 0);
    const w = checks.reduce((a, c) => a + c.counts.warn, 0);
    actions.toast({ tone: f ? 'critical' : w ? 'warning' : 'good', title: `오픈 전 자동 점검 · 실패 ${f} · 주의 ${w}`, body: checks.map((c) => `${c.promotion.name} ${c.verdict.label}`).join(' · '), route: 'flow' });
  };
  if (!checks.length) return <Card title="프로모션 체크리스트"><div className="small muted">등록된 프로모션이 없습니다 (data.promotions).</div></Card>;

  return (
    <div className="stack-lg">
      <div className="grid g-3">
        {checks.map((c) => (
          <button key={c.promotion.id} type="button" className={`flow-promo${c.promotion.id === cur.promotion.id ? ' active' : ''}`} onClick={() => setSel(c.promotion.id)} aria-pressed={c.promotion.id === cur.promotion.id}>
            <span className="row-between">
              <span className="row" style={{ gap: 6 }}><span className="legend-swatch" style={{ background: `var(${SALES_CHANNELS[c.promotion.channel]?.colorVar ?? '--series-1'})` }} /><span className="small">{c.channelName}</span></span>
              <Pill tone={c.phase === 'pre' ? 'outline' : c.phase === 'live' ? 'accent' : 'neutral'}>{c.phaseLabel}{c.phase === 'pre' ? ` · D-${c.dday}` : c.phase === 'live' ? ` · 종료 D-${c.dday}` : ''}</Pill>
            </span>
            <strong>{c.promotion.name}</strong>
            <span className="xs muted num">{fmtDate(c.promotion.start)} ~ {fmtDate(c.promotion.end)} · 할인 {c.promotion.discountRate}%</span>
            <span className="row" style={{ gap: 6 }}>
              <Pill tone={c.verdict.tone} icon={c.verdict.tone === 'good' ? 'check' : 'alert'}>{c.verdict.label}</Pill>
              <span className="xs ink2 num">실패 {c.counts.fail} · 주의 {c.counts.warn} · 통과 {c.counts.pass}</span>
            </span>
            <span className="flow-group-dots">
              {CHECK_GROUPS.map((g) => <span key={g} className={`flow-gdot lv-${c.byGroup[g]}`} title={`${g}: ${c.byGroup[g]}`}>{g}</span>)}
            </span>
          </button>
        ))}
      </div>

      <Card title={<>{cur.promotion.name} · 체크리스트</>} sub={`${cur.channelName} · ${cur.phaseLabel} · 일정 · 가격 · 소재 · 랜딩 · 예산 · 재고 · 결제 잔액 자동 점검`}
        actions={<>
          <Pill tone={cur.verdict.tone} icon={cur.verdict.tone === 'good' ? 'check' : 'alert'}>{cur.verdict.label}</Pill>
          <Src kind="DEMO" /><Src kind="PROPOSAL" page="p.31" /><Src kind="PROPOSAL" page="p.45" />
          <Button size="sm" icon="refresh" onClick={rerun}>점검 다시 실행</Button>
          <Button size="sm" icon="report" onClick={() => onReport(cur.promotion.id)}>프로모션 리포트</Button>
        </>}>
        <div className="xs ink2">{cur.verdict.basis}{ranAt ? ` · 마지막 실행 ${ranAt}` : ''}</div>
        <div className="flow-checklist">
          {CHECK_GROUPS.map((g) => {
            const items = cur.items.filter((i) => i.group === g);
            if (!items.length) return null;
            return (
              <div key={g} className="flow-check-group">
                <div className="flow-check-group-head"><LevelPill level={cur.byGroup[g]} /><strong>{g}</strong><span className="xs muted">{items.length}항목</span></div>
                {items.map((i) => <CheckRow key={i.id} ctx={ctx} item={i} check={cur} onOpen={onOpen} />)}
              </div>
            );
          })}
        </div>
      </Card>

      <Card title="전 프로모션 점검 매트릭스" sub="항목군별 가장 나쁜 결과 · 기준: 실패 0건 = 오픈 가능" actions={<Src kind="DEMO" />}>
        <div className="table-wrap">
          <table className="tbl">
            <thead><tr><th>프로모션</th><th>단계</th>{CHECK_GROUPS.map((g) => <th key={g} className="c">{g}</th>)}<th>판정</th></tr></thead>
            <tbody>
              {checks.map((c) => (
                <tr key={c.promotion.id} onClick={() => setSel(c.promotion.id)} style={{ cursor: 'pointer' }} className={c.promotion.id === cur.promotion.id ? 'selected' : undefined}>
                  <td><strong className="small">{c.promotion.name}</strong><div className="xs muted">{c.channelName}</div></td>
                  <td className="small">{c.phaseLabel}</td>
                  {CHECK_GROUPS.map((g) => <td key={g} className="c"><LevelPill level={c.byGroup[g]} /></td>)}
                  <td><Pill tone={c.verdict.tone}>{c.verdict.label}</Pill><div className="xs muted num">실패 {c.counts.fail} · 주의 {c.counts.warn}</div></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <AiInsight title="오픈 전 점검 해석" sub="실패 항목의 조치 순서 · 오픈 판단 조건" cta="해석 생성"
        buildPrompt={() => `과제: 프로모션 오픈 전 자동 점검 결과로 오픈 여부와 조치 순서를 판단하라.\n데이터(JSON):\n${JSON.stringify(checks.map((c) => ({ 프로모션: c.promotion.name, 채널: c.channelName, 단계: c.phaseLabel, 판정: c.verdict.label, 실패: c.items.filter((i) => i.level === 'fail').map((i) => `${i.group} ${i.label}: ${i.detail}`), 주의: c.items.filter((i) => i.level === 'warn').map((i) => `${i.group} ${i.label}: ${i.detail}`) })))}`}
        fallback={() => promoCheckBrief(data, changes, incidents)} />
    </div>
  );
}

function CheckRow({ ctx, item, check, onOpen }: { ctx: FlowCtx; item: CheckItem; check: PromoCheck; onOpen: (id: string) => void }) {
  const { createRequest, requestPerm } = ctx;
  return (
    <div className={`flow-check lv-${item.level}`}>
      <LevelPill level={item.level} />
      <div className="stack-sm" style={{ gap: 2, minWidth: 0 }}>
        <div className="small"><strong>{item.label}</strong> <span className="ink2">{item.detail}</span></div>
        <div className="xs muted">기준 · {item.basis}</div>
        {item.action !== '—' ? <div className="xs">조치 · {item.action}</div> : null}
      </div>
      <div className="row" style={{ gap: 4, justifyContent: 'flex-end' }}>
        {item.fix ? (
          item.fixState ? (
            <Button size="sm" variant="ghost" icon="check" onClick={() => onOpen(item.fixState!.id)}>요청됨 · {STATUS_META[item.fixState.status].label}</Button>
          ) : (
            <Button size="sm" icon="send" disabled={!requestPerm.ok} title={requestPerm.ok ? `승인 주체 ${APPROVER_LABEL[item.fix.input.approver]}` : requestPerm.reason} onClick={() => createRequest({ ...item.fix!.input, reason: `${item.fix!.input.reason} · 프로모션 ${check.promotion.name} 체크리스트` })}>
              {item.fix.label} <span className="muted">· {APPROVER_LABEL[item.fix.input.approver]}</span>
            </Button>
          )
        ) : null}
      </div>
    </div>
  );
}
