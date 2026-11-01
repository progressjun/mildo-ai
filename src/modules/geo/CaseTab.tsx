/* 진단 전후 지표 입력 — 제안서 p.29 공란 "[브랜드 · 진단 전후 브랜드 언급률 · 인용 수 입력]"을 툴에서 채운다 */
import { useMemo } from 'react';
import { fmt, fmtDate } from '@/core/util';
import { Button, Callout, Card, CopyButton, DataTable, Field, Src } from '@/ui/primitives';
import { GEO_CASE_BLANK, GEO_PRINCIPLE } from './data';
import { caseMetrics, demoCaseFromSnapshot, EMPTY_CASE, visibilitySummary, type CaseInput, type GeoSnapshot } from './engine';

function numOrNull(v: string): number | null {
  if (v.trim() === '') return null;
  const n = Number(v.replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}

export function CaseTab({ value, onChange, snap }: { value: CaseInput; onChange: (v: CaseInput) => void; snap: GeoSnapshot }) {
  const m = caseMetrics(value);
  const set = (p: Partial<CaseInput>) => onChange({ ...value, ...p });
  const isDemo = value.engines.includes('TEST DATA');
  const ref = useMemo(() => snap.rounds.map((r, i) => {
    const v = visibilitySummary(snap, i);
    return { date: r.date, rate: v.overall.rate, owned: v.overall.ownedCitations, citations: v.overall.citations, sov: v.overall.sov };
  }), [snap]);
  const numField = (id: keyof CaseInput, label: string, suffix: string) => (
    <Field label={label} id={`geo-case-${id}`}>
      <div className="row" style={{ gap: 6, flexWrap: 'nowrap' }}>
        <input id={`geo-case-${id}`} className="input num" inputMode="decimal" placeholder="[입력]" value={value[id] === null ? '' : String(value[id])}
          onChange={(e) => set({ [id]: numOrNull(e.target.value) } as Partial<CaseInput>)} />
        <span className="small muted nowrap">{suffix}</span>
      </div>
    </Field>
  );

  return (
    <div className="grid g-3">
      <Card className="span-2" title="적용 사례 · 실제 집행 수치" sub="제안서 p.29 공란을 채웁니다 · 실제 집행 브랜드 데이터로만 입력"
        actions={<><Src kind="PROPOSAL" page="p.29" />{isDemo ? <Src kind="DEMO" /> : null}</>}>
        <div className="geo-quote">제안서 원문: <span className="geo-blank">{GEO_CASE_BLANK}</span> · {GEO_PRINCIPLE}</div>
        <div className="grid g-4">
          <Field label="브랜드" id="geo-case-brand"><input id="geo-case-brand" className="input" placeholder="[브랜드]" value={value.brand} onChange={(e) => set({ brand: e.target.value })} /></Field>
          <Field label="진단 전 시점" id="geo-case-bl"><input id="geo-case-bl" className="input" placeholder="예: 2026-03 (진단 전)" value={value.beforeLabel} onChange={(e) => set({ beforeLabel: e.target.value })} /></Field>
          <Field label="진단 후 시점" id="geo-case-al"><input id="geo-case-al" className="input" placeholder="예: 2026-06 (개선 3개월)" value={value.afterLabel} onChange={(e) => set({ afterLabel: e.target.value })} /></Field>
          <Field label="측정 범위 (엔진 · 질의 수)" id="geo-case-eng"><input id="geo-case-eng" className="input" placeholder="예: 5개 엔진 · 질의 20개" value={value.engines} onChange={(e) => set({ engines: e.target.value })} /></Field>
          {numField('beforeRate', '진단 전 브랜드 언급률', '%')}
          {numField('afterRate', '진단 후 브랜드 언급률', '%')}
          {numField('beforeCites', '진단 전 인용 수', '건')}
          {numField('afterCites', '진단 후 인용 수', '건')}
        </div>
        <div className="grid g-3">
          <div className="stat"><div className="stat-label">언급률 변화</div><div className="stat-value num">{m.rateDeltaPp === null ? '—' : `${m.rateDeltaPp > 0 ? '+' : ''}${m.rateDeltaPp.toFixed(1)}pp`}</div></div>
          <div className="stat"><div className="stat-label">인용 수 변화</div><div className="stat-value num">{m.citeDelta === null ? '—' : `${m.citeDelta > 0 ? '+' : ''}${m.citeDelta}건`}</div></div>
          <div className="stat"><div className="stat-label">인용 수 증감률</div><div className="stat-value num">{m.citeDeltaPct === null ? '—' : fmt.delta(m.citeDeltaPct)}</div></div>
        </div>
        <div className="geo-case-out" aria-label="제안서 삽입 문구">{m.text}</div>
        {m.complete ? null : <Callout tone="warning" title={`미입력 ${m.missing.length}개`}>{m.missing.join(' · ')} — 비어 있는 칸은 [입력]으로 남깁니다.</Callout>}
        {isDemo ? <Callout tone="warning" title="TEST DATA 값">데모 스냅샷으로 채운 값입니다. 제안서 적용 사례에는 실제 집행 브랜드의 진단 전후 수치만 넣습니다.</Callout> : null}
        <div className="row">
          <CopyButton text={m.text} label="문구 복사" />
          <Button size="sm" icon="refresh" onClick={() => onChange(demoCaseFromSnapshot(snap))}>데모 스냅샷 값 채우기 (TEST DATA)</Button>
          <Button size="sm" variant="ghost" icon="x" onClick={() => onChange({ ...EMPTY_CASE })}>지우기</Button>
        </div>
        <div className="xs muted">입력값은 이 브라우저에만 저장됩니다. 언급률 = 진단 질의 × 엔진 셀 중 브랜드가 언급된 비율, 인용 수 = AI 답변 인용 출처 중 자사 채널(자사몰 · 브랜드스토어 · 공식 인스타그램) 건수로 정의합니다.</div>
      </Card>

      <Card title="참고 · 정기 진단 기록 형식" sub="같은 정의로 회차마다 기록한 값 (데모 스냅샷)" actions={<Src kind="DEMO" />}>
        <DataTable rows={ref} rowKey={(r) => r.date}
          columns={[
            { key: 'd', label: '진단일', render: (r) => <span className="small">{fmtDate(r.date)}</span> },
            { key: 'r', label: '언급률', align: 'right', render: (r) => <span className="num small">{fmt.pct(r.rate * 100, 1)}</span> },
            { key: 'o', label: '자사 인용', align: 'right', render: (r) => <span className="num small">{r.owned} / {r.citations}</span> },
            { key: 's', label: '점유', align: 'right', render: (r) => <span className="num small">{fmt.pct(r.sov * 100, 0)}</span> },
          ]} />
        <div className="small ink2">진단 전후 비교는 같은 질의 세트 · 같은 엔진 · 같은 정의로만 합니다. 질의를 바꾸면 이전 회차와 비교하지 않고 새 기준선으로 기록합니다.</div>
      </Card>
    </div>
  );
}
