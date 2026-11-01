import { useMemo, useState } from 'react';
import { hhmm } from '@/core/util';
import { Button, Card, Pill, Src } from '@/ui/primitives';
import { Icon } from '@/ui/Icon';
import { CONFIG_FIELDS, type NumericConfigKey, resolveConfig } from './engine';
import { SAFETY_ITEMS } from './data';
import type { AdPilotCtx } from './useAdPilot';

/** 입력 중에는 문자열로 두고 blur · Enter 에서 확정 (확정 시 범위 보정) */
function CommitNumber({ id, value, step, min, max, suffix, onCommit }: { id: string; value: number; step: number; min: number; max: number; suffix: string; onCommit: (v: number) => void }) {
  const [text, setText] = useState<string | null>(null);
  const commit = () => {
    if (text === null) return;
    const v = Number(text);
    if (text.trim() !== '' && Number.isFinite(v)) onCommit(Math.min(max, Math.max(min, v)));
    setText(null);
  };
  return (
    <span className="row" style={{ gap: 6, flexWrap: 'nowrap' }}>
      <input id={id} className="input num" type="number" step={step} min={min} max={max} value={text ?? String(value)}
        onChange={(e) => setText(e.target.value)} onBlur={commit} onKeyDown={(e) => { if (e.key === 'Enter') commit(); if (e.key === 'Escape') setText(null); }} />
      <span className="small muted nowrap">{suffix}</span>
    </span>
  );
}

const cfgId = (k: NumericConfigKey) => `adpilot-cfg-${k}`;

function CfgInput({ ap, k, pct = false }: { ap: AdPilotCtx; k: NumericConfigKey; pct?: boolean }) {
  const f = CONFIG_FIELDS.find((x) => x.key === k)!;
  const raw = ap.draft[k];
  const v = pct ? Math.round(raw * 1000) / 10 : raw;
  const changed = ap.official[k] !== raw;
  return (
    <div className="row" style={{ gap: 6, flexWrap: 'nowrap', justifyContent: 'flex-end' }}>
      {changed ? <Pill tone="accent" title={`공식 기준 ${pct ? Math.round(ap.official[k] * 100) : ap.official[k]}${pct ? '%' : f.unit}`}>미승인</Pill> : null}
      <CommitNumber id={cfgId(k)} value={v} step={pct ? 1 : f.step} min={pct ? f.min * 100 : f.min} max={pct ? f.max * 100 : f.max} suffix={pct ? '%' : f.unit}
        onCommit={(n) => ap.setDraft(resolveConfig({ ...ap.draft, [k]: pct ? n / 100 : n }))} />
    </div>
  );
}

/** SAFETY 패널 (p.14) — 일 조정 폭 상한 · 브랜드 별도 기준 · 변경 이력 · 즉시 롤백 + 판정 기준 편집 */
export function SafetyPanel({ ap, onHistory }: { ap: AdPilotCtx; onHistory: () => void }) {
  const [confirmRb, setConfirmRb] = useState(false);
  const applied = ap.changes.filter((c) => c.status === 'applied' && c.kind !== 'setting');
  const rb = ap.rollbackPlan;
  const log = useMemo(() => ap.changes
    .flatMap((c) => c.history.map((h) => ({ ...h, target: c.target })))
    .sort((a, b) => b.at.localeCompare(a.at))
    .slice(0, 6), [ap.changes]);
  const label = (k: NumericConfigKey) => CONFIG_FIELDS.find((f) => f.key === k)!.label;

  return (
    <Card tone="dark" className="adpilot-safety" title={<><Icon name="shield" size={16} />SAFETY</>} sub="모든 변경은 승인 · 기록 · 롤백이 가능합니다" actions={<Src kind="PROPOSAL" page="p.14" />}>
      <div className="adpilot-safety-cols">
        <div className="adpilot-sec">
          <div className="adpilot-sec-title"><Icon name="target" size={14} />{SAFETY_ITEMS[0].title}<span className="xs adpilot-dim">· {SAFETY_ITEMS[0].detail}</span></div>
          <div className="adpilot-kv">
            <label htmlFor={cfgId('dailyChangeCapPct')}>키워드별 1일 변동 한도 (시작 입찰가 기준)</label><CfgInput ap={ap} k="dailyChangeCapPct" />
          </div>
        </div>
        <div className="adpilot-sec">
          <div className="adpilot-sec-title"><Icon name="shield" size={14} />{SAFETY_ITEMS[1].title}<span className="xs adpilot-dim">· {SAFETY_ITEMS[1].detail}</span></div>
          <div className="adpilot-kv">
            <label htmlFor={cfgId('brandTargetRoas')}>{label('brandTargetRoas')}</label><CfgInput ap={ap} k="brandTargetRoas" />
            <label htmlFor={cfgId('brandRankTarget')}>{label('brandRankTarget')} <span className="xs adpilot-dim">(모듈 가정)</span></label><CfgInput ap={ap} k="brandRankTarget" />
          </div>
          <div className="xs adpilot-dim">브랜드는 목표 미달이어도 자동 하향하지 않고 PM 검토. 브랜드 변경은 폭과 무관하게 PM 이상 승인.</div>
        </div>
        <div className="adpilot-sec">
          <div className="adpilot-sec-title"><Icon name="filter" size={14} />판정 기준 <span className="xs adpilot-dim">· 초기값 · 온보딩 중 확정</span></div>
          <div className="adpilot-kv">
            <label htmlFor={cfgId('targetRoas')}>{label('targetRoas')}</label><CfgInput ap={ap} k="targetRoas" />
            <label htmlFor={cfgId('highEfficiencyRoasRatio')}>{label('highEfficiencyRoasRatio')}</label><CfgInput ap={ap} k="highEfficiencyRoasRatio" />
            <label htmlFor={cfgId('lostShareTrigger')}>{label('lostShareTrigger')}</label><CfgInput ap={ap} k="lostShareTrigger" pct />
            <label htmlFor={cfgId('minConversionsForDown')}>{label('minConversionsForDown')}</label><CfgInput ap={ap} k="minConversionsForDown" />
            <label htmlFor={cfgId('anomalyHoldPct')}>{label('anomalyHoldPct')}</label><CfgInput ap={ap} k="anomalyHoldPct" />
            <label htmlFor={cfgId('bulkWarnCount')}>{label('bulkWarnCount')}</label><CfgInput ap={ap} k="bulkWarnCount" />
            <label htmlFor={cfgId('bulkBlockCount')}>{label('bulkBlockCount')}</label><CfgInput ap={ap} k="bulkBlockCount" />
          </div>
          {ap.dirty.length ? (
            <div className="stack-sm">
              <div className="xs">미승인 기준 {ap.dirty.length}건으로 화면 판정을 시뮬레이션 중입니다. 공식 기준은 승인 · 반영 후 바뀝니다 (목표 ROAS · 상한은 수면밀도 승인).</div>
              <div className="row" style={{ gap: 6 }}>
                {ap.settingSplit.fresh.length
                  ? <Button size="sm" variant="accent" icon="send" onClick={ap.submitSettings}>기준 변경 승인 요청 {ap.settingSplit.fresh.length}건</Button>
                  : <Button size="sm" icon="check" disabled title="같은 기준 항목의 열린 요청이 있습니다 — MILDO Flow에서 승인 · 반려 후 다시 요청">승인 요청됨 {ap.settingSplit.duplicate.length}건</Button>}
                <Button size="sm" icon="refresh" onClick={() => ap.setDraft(ap.official)}>공식 기준으로</Button>
              </div>
            </div>
          ) : <div className="xs adpilot-dim">기준을 바꾸면 조정 후보가 즉시 다시 판정됩니다.</div>}
        </div>
        <div className="adpilot-sec">
          <div className="row-between">
            <div className="adpilot-sec-title"><Icon name="report" size={14} />{SAFETY_ITEMS[2].title}<span className="xs adpilot-dim">· {SAFETY_ITEMS[2].detail}</span></div>
            <Button size="sm" onClick={onHistory}>전체 이력</Button>
          </div>
          {log.length ? (
            <div className="adpilot-log">
              {log.map((h, i) => (
                <div key={i} className="adpilot-log-row">
                  <span className="num adpilot-dim">{hhmm(h.at)}</span>
                  <span><strong>{h.by}</strong> · {h.action} · {h.target}{h.note ? <span className="adpilot-dim"> — {h.note.length > 70 ? `${h.note.slice(0, 70)}…` : h.note}</span> : null}</span>
                </div>
              ))}
            </div>
          ) : <div className="xs adpilot-dim">이번 세션 변경 이력이 없습니다. 승인 요청부터 반영 · 롤백까지 누가 · 언제 · 왜가 모두 기록됩니다.</div>}
        </div>
        <div className="adpilot-sec">
          <div className="adpilot-sec-title"><Icon name="rollback" size={14} />{SAFETY_ITEMS[3].title}<span className="xs adpilot-dim">· {SAFETY_ITEMS[3].detail}</span></div>
          <div className="adpilot-kv">
            <span>반영 중인 변경 (입찰 · 예산 · 상태)</span><strong className="num">{applied.length}건</strong>
          </div>
          {rb.skipped.length ? <div className="xs adpilot-dim">현재 역할({ap.state.role}) 승인 범위 밖 {rb.skipped.length}건은 일괄 롤백에서 제외됩니다.</div> : null}
          {confirmRb && rb.list.length ? (
            <div className="row" style={{ gap: 6 }}>
              <Button size="sm" variant="danger" icon="rollback" onClick={(e) => { if (e.detail > 1) return; ap.rollbackAll(); setConfirmRb(false); }}>{rb.list.length}건 모두 복원 확정</Button>
              <Button size="sm" onClick={(e) => { if (e.detail > 1) return; setConfirmRb(false); }}>취소</Button>
            </div>
          ) : (
            <Button size="sm" icon="rollback" disabled={!rb.list.length} onClick={() => setConfirmRb(true)}>반영분 전체 롤백</Button>
          )}
        </div>
      </div>
    </Card>
  );
}
