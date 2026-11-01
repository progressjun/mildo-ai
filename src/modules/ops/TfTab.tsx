/* p.52 전담 TF 명단 · 1:1 백업 그래프 · 휴가 시뮬레이터 */
import { useMemo, useState } from 'react';
import { useStore } from '@/core/store';
import { TF_ROLES } from '@/data/constants';
import { addDays, fmt } from '@/core/util';
import { toCsv } from '@/core/download';
import { Button, Callout, Card, CopyButton, DataTable, DownloadButton, Field, NumberInput, Pill, Src, type Column } from '@/ui/primitives';
import { LEAVE_ASSUMPTIONS, TF_PLACEHOLDER } from './data';
import { ddayLabel, LEAVE_PRESETS, roleLabel, shortDate, simulateLeave, tfMarkdown, type TfRow } from './engine';
import type { OpsLocal } from './local';
import type { OpsModel } from './useOps';
import { BackupGraphSvg, LevelPill } from './parts';

export function TfTab({ model, local, patch }: { model: OpsModel; local: OpsLocal; patch: (p: Partial<OpsLocal> | ((s: OpsLocal) => Partial<OpsLocal>)) => void }) {
  const { state, dispatch } = useStore();
  const s = model.summary;
  const rows = s.roster;
  const m = s.tf;
  const g = s.graph;
  const dl = s.schedule.deadline;

  const [absent, setAbsent] = useState<string[]>(['sa_ae']);
  const [start, setStart] = useState(() => addDays(state.data.today, 2));
  const [days, setDays] = useState<number>(LEAVE_ASSUMPTIONS.defaultDays);
  const [transferPct, setTransferPct] = useState<number>(LEAVE_ASSUMPTIONS.transferPct);
  const [overloadPct, setOverloadPct] = useState<number>(LEAVE_ASSUMPTIONS.overloadPct);
  const sim = useMemo(() => simulateLeave(rows, absent, { start, days, transferPct, overloadPct }), [rows, absent, start, days, transferPct, overloadPct]);

  const setTf = (id: string, p: { name?: string; years?: string; allocation?: string }) => dispatch({ type: 'tf/set', id, patch: p });
  const setBackup = (id: string, to: string) => patch((st) => {
    const def = TF_ROLES.find((r) => r.id === id)?.backup;
    const next = { ...st.backupOverrides };
    if (to === def) delete next[id];
    else next[id] = to;
    return { backupOverrides: next };
  });
  const raw = (id: string) => state.tf[id] ?? { name: '', years: '', allocation: '' };
  const cls = (blank: boolean, invalid = false) => `input ops-cell${invalid ? ' ops-invalid' : blank ? ' ops-blank' : ''}`;

  const cols: Column<TfRow>[] = [
    { key: 'role', label: '역할', render: (r) => <div><strong className="small">{r.role}</strong><div className="xs muted">{r.domain}</div></div> },
    { key: 'name', label: '성명', render: (r) => <input id={`ops-tf-${r.id}-name`} aria-label={`${r.role} 성명`} className={`${cls(r.missing.name, r.invalid.name)} ops-name`} placeholder={TF_PLACEHOLDER.name} value={raw(r.id).name} onChange={(e) => setTf(r.id, { name: e.target.value })} /> },
    { key: 'years', label: '연차', render: (r) => (
      <div className="ops-cell-wrap"><input id={`ops-tf-${r.id}-years`} aria-label={`${r.role} 연차`} inputMode="numeric" className={cls(r.missing.years, r.invalid.years)} placeholder="[n]" value={raw(r.id).years} onChange={(e) => setTf(r.id, { years: e.target.value })} /><span className="xs muted">년</span></div>
    ) },
    { key: 'scope', label: '담당', render: (r) => <span className="small">{r.scope}</span> },
    { key: 'alloc', label: '투입률', render: (r) => (
      <div className="ops-cell-wrap"><input id={`ops-tf-${r.id}-alloc`} aria-label={`${r.role} 투입률`} inputMode="numeric" className={cls(r.missing.allocation, r.invalid.allocation)} placeholder="[n]" value={raw(r.id).allocation} onChange={(e) => setTf(r.id, { allocation: e.target.value })} /><span className="xs muted">%</span></div>
    ) },
    { key: 'backup', label: '백업 (1:1)', render: (r) => (
      <div className="row" style={{ gap: 6, flexWrap: 'nowrap' }}>
        <select id={`ops-tf-${r.id}-backup`} aria-label={`${r.role} 백업`} className="select ops-select" value={r.backupId} onChange={(e) => setBackup(r.id, e.target.value)}>
          <option value="">미지정</option>
          {TF_ROLES.map((x) => <option key={x.id} value={x.id}>{x.role}{x.id === r.defaultBackupId ? ' (제안서)' : ''}</option>)}
        </select>
        {r.backupOverridden ? <Pill tone="outline">재지정</Pill> : null}
      </div>
    ) },
    { key: 'state', label: '입력 상태', render: (r) => {
      const miss = [r.missing.name && '성명', r.missing.years && '연차', r.missing.allocation && '투입률'].filter(Boolean) as string[];
      const bad = [r.invalid.name && '실명 아님(마스킹)', r.invalid.years && `연차 0~45년`, r.invalid.allocation && '투입률 1~100%'].filter(Boolean) as string[];
      return bad.length ? <Pill tone="critical" icon="x">오입력 · {bad.join(' · ')}</Pill> : miss.length ? <Pill tone="warning" icon="edit">미입력 · {miss.join(' · ')}</Pill> : <Pill tone="good" icon="check">완료</Pill>;
    } },
  ];

  // 오입력 값은 제출 양식에 내보내지 않고 장표 빈칸 표기로 남긴다 (tfMarkdown과 같은 규칙)
  const csv = () => toCsv(rows.map((r) => ({
    역할: r.role, 성명: r.name && !r.invalid.name ? r.name : TF_PLACEHOLDER.name,
    연차: r.years !== null && !r.invalid.years ? `${r.years}년` : TF_PLACEHOLDER.years, 담당: r.scope,
    투입률: r.allocation !== null && !r.invalid.allocation ? `${r.allocation}%` : TF_PLACEHOLDER.allocation, 백업: r.backupRole,
  })));
  const toggle = (id: string) => setAbsent((a) => (a.includes(id) ? a.filter((x) => x !== id) : [...a, id]));
  const presetId = LEAVE_PRESETS.find((p) => p.absent.length === absent.length && p.absent.every((x) => absent.includes(x)))?.id;

  return (
    <div className="stack-lg">
      <Card title="전담 7인 TF 명단" sub="매체별 전담자와 지정 백업을 1:1로 연결 · 성명 · 연차 · 투입률은 제출 전 입력 (제안서 p.52 빈칸 그대로)"
        actions={<><Src kind="PROPOSAL" page="p.52" /><Src kind="RFP" title="RFP 필수 제출물 4) TF 명단 (실명 · 연차 · 투입률 · 백업)" /><CopyButton text={() => tfMarkdown(rows)} label="표 복사" /><DownloadButton filename="mildo-tf-명단.csv" data={csv} mime="text/csv;charset=utf-8" label="CSV" /></>}>
        {m.complete ? (
          <Callout tone="good" title="TF 명단 입력 완료">{rows.length}명 · {m.cells}칸 입력 · 입력 투입률 합계 {fmt.dec1(m.fte)} FTE. RFP 필수 제출물 4) 요건(실명 · 연차 · 투입률 · 백업)을 충족합니다.</Callout>
        ) : (
          <Callout tone="warning" title={`RFP 필수 제출물 4) TF 명단 · 미입력 ${m.total}칸 / ${m.cells}칸${m.invalid ? ` · 오입력 ${m.invalid}명` : ''}`}>
            성명 {m.name} · 연차 {m.years} · 투입률 {m.allocation}칸이 비어 있습니다. 제출 마감 {shortDate(dl.date)} {dl.hour}시 ({dl.passed ? '마감 지남' : ddayLabel(dl.days)}) · 내부 확정 목표 {shortDate(dl.freeze)}. 미입력 칸은 노란 테두리와 '입력 상태' 열의 항목명으로 표시됩니다.
          </Callout>
        )}
        <DataTable rows={rows} columns={cols} rowKey={(r) => r.id} />
        <div className="row-between">
          <div className="row" style={{ gap: 6 }}>
            {m.dedicated.map((d) => <Pill key={d.key} tone={d.ok ? 'good' : 'critical'} icon={d.ok ? 'check' : 'x'}>{d.label} {d.ok ? '지정' : '미지정'} · {d.roles.map(roleLabel).join(' · ')}</Pill>)}
            <span className="xs muted">RFP 기준: 매체별 전담자(SA · DA · 총괄)</span>
          </div>
          <div className="row" style={{ gap: 8 }}>
            <span className="small">입력 투입률 합계 <strong className="num">{fmt.dec1(m.fte)} FTE</strong> <span className="muted">({m.fteEntered}/{rows.length}명 입력)</span></span>
            {Object.keys(local.backupOverrides).length ? <Button size="sm" icon="rollback" onClick={() => patch({ backupOverrides: {} })}>백업 제안서 기준으로</Button> : null}
          </div>
        </div>
      </Card>

      <div className="grid g-2">
        <Card title="1:1 백업 그래프" sub={`상호 백업 ${g.mutualPairs.length}쌍 · 단방향 ${g.oneWay} · 백업 집중 ${g.concentration} · 공백 ${g.gaps} — 휴가 시뮬레이션 결과를 함께 표시`}
          actions={<><Src kind="PROPOSAL" page="p.52" />{g.gaps ? <Pill tone="critical" icon="x">백업 공백 {g.gaps} · 기준 0</Pill> : <Pill tone="good" icon="check">백업 공백 0 · {g.covered}/{rows.length} 지정</Pill>}</>}>
          <BackupGraphSvg rows={rows} graph={g} sim={sim} />
          <ul className="ops-issues">
            {g.issues.length === 0 ? <li><LevelPill level="pass" /> 모든 인원이 상호 백업으로 연결되어 있습니다.</li> : null}
            {g.issues.map((i) => (
              <li key={`${i.code}-${i.memberId}`}><LevelPill level={i.level === 'gap' ? 'fail' : i.level === 'warn' ? 'warn' : 'info'}>{i.level === 'gap' ? '공백' : i.level === 'warn' ? '주의' : '참고'}</LevelPill><span>{i.text}</span></li>
            ))}
          </ul>
        </Card>

        <Card title="휴가 시뮬레이터" sub="부재 인원을 고르면 담당 업무가 백업(백업도 부재면 2차 백업)에게 넘어가고, 합산 투입률로 과부하 · 응답 공백 · 당번 충돌을 판정합니다"
          actions={<Pill tone="outline">운영 가정 포함</Pill>}>
          <div className="ops-chips" role="group" aria-label="프리셋">
            {LEAVE_PRESETS.map((p) => <button key={p.id} type="button" className="ops-chip" aria-pressed={presetId === p.id} onClick={() => setAbsent([...p.absent])}>{p.label}</button>)}
            <button type="button" className="ops-chip" aria-pressed={absent.length === 0} onClick={() => setAbsent([])}>부재 없음</button>
          </div>
          <div className="row" style={{ gap: 12 }}>
            {rows.map((r) => (
              <label key={r.id} className="ops-check" htmlFor={`ops-leave-${r.id}`}><input id={`ops-leave-${r.id}`} type="checkbox" checked={absent.includes(r.id)} onChange={() => toggle(r.id)} />{r.role}</label>
            ))}
          </div>
          <div className="grid g-4" style={{ gap: 10 }}>
            <Field label="부재 시작일" id="ops-leave-start"><input id="ops-leave-start" type="date" className="input" value={start} onChange={(e) => e.target.value && setStart(e.target.value)} /></Field>
            <Field label="부재 일수" id="ops-leave-days"><NumberInput id="ops-leave-days" value={days} min={1} max={60} onChange={(v) => setDays(Math.max(1, Math.min(60, Math.round(v))))} suffix="일" /></Field>
            <Field label="백업 인수 비율 (가정)" id="ops-leave-tr"><NumberInput id="ops-leave-tr" value={transferPct} min={0} max={100} step={10} onChange={(v) => setTransferPct(Math.max(0, Math.min(100, v)))} suffix="%" /></Field>
            <Field label="과부하 기준" id="ops-leave-ov"><NumberInput id="ops-leave-ov" value={overloadPct} min={50} max={200} step={10} onChange={(v) => setOverloadPct(Math.max(50, Math.min(200, v)))} suffix="%" /></Field>
          </div>
          {sim.absent.length === 0 ? <div className="small muted">부재 인원을 선택하세요.</div> : (
            <>
              <div className="table-wrap">
                <table className="tbl">
                  <thead><tr><th>역할</th><th className="r">기본 투입률</th><th>인수 업무</th><th className="r">합산</th><th>판정</th></tr></thead>
                  <tbody>
                    {sim.members.map((x) => (
                      <tr key={x.id}>
                        <td className="small"><strong>{x.role}</strong>{x.absent ? <span className="muted"> · 부재</span> : null}</td>
                        <td className="r">{x.absent ? '—' : <>{fmt.int(x.base)}%{x.baseAssumed ? <span className="xs muted"> 가정</span> : null}</>}</td>
                        <td className="xs">{x.incoming.length ? x.incoming.map((t) => `${t.fromRole} +${fmt.int(t.alloc)}%${t.fallback ? ' (공백 → PM 대행)' : t.hops > 1 ? ` (${t.hops}차 백업)` : ''}`).join(' · ') : <span className="muted">—</span>}</td>
                        <td className="r"><strong>{x.absent ? '—' : `${fmt.int(x.load)}%`}</strong></td>
                        <td>{x.absent ? <Pill tone="outline">부재</Pill> : x.overload ? <Pill tone="critical" icon="alert">과부하 · 기준 {sim.assumptions.overloadPct}% 대비 {fmt.int(x.load)}%</Pill> : x.incoming.length ? <Pill tone="good" icon="check">인수 가능 · 기준 {sim.assumptions.overloadPct}% 이내</Pill> : <span className="xs muted">변동 없음</span>}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {sim.gaps.length ? (
                <Callout tone="critical" title={`응답 공백 ${sim.gaps.length}건 — 상호 백업 쌍 동시 부재`}>
                  {sim.gaps.map((x) => `${x.role}: ${x.reason}${x.fallbackId ? ' → 총괄 PM 임시 대행 (단일 창구)' : ' → 대행 인력 없음'}`).join(' / ')}. 같은 쌍의 휴가 일정을 겹치지 않게 조정하거나 PM 대행 범위를 명단에 명시합니다.
                </Callout>
              ) : null}
              {sim.overloaded.length ? (
                <Callout tone="warning" title={`과부하 ${sim.overloaded.length}명 · 최대 ${fmt.int(sim.maxLoad)}%`}>
                  {sim.members.filter((x) => x.overload).map((x) => `${x.role} ${fmt.int(x.load)}%`).join(', ')} — 기준 {sim.assumptions.overloadPct}% 초과. 부재 기간 중 전략 · 보고 업무를 복귀 후로 미루거나(인수 비율 하향) 휴가를 분산합니다.
                </Callout>
              ) : !sim.gaps.length ? <Callout tone="good" title="응답 공백 · 과부하 없음">최대 합산 투입률 {fmt.int(sim.maxLoad)}% · 기준 {sim.assumptions.overloadPct}% 이내.</Callout> : null}
              {sim.period ? (
                sim.dutyConflicts.length ? (
                  <Callout tone="warning" title={`부재 기간 ${shortDate(sim.period.start)}~${shortDate(sim.period.end)} 주말 · 공휴일 당번 충돌 ${sim.dutyConflicts.length}일`}>
                    {sim.dutyConflicts.map((c) => `${shortDate(c.date)} ${c.label} 당번 ${c.role} → ${c.replacement}`).join(' · ')} (p.48 당번 순번 · MILDO Alert와 같은 규칙)
                  </Callout>
                ) : <div className="xs muted">부재 기간 {shortDate(sim.period.start)}~{shortDate(sim.period.end)} · 당번 충돌 없음 (p.48)</div>
              ) : null}
              <div className="xs muted">
                가정: 투입률 미입력 인원은 전담 {sim.assumptions.assumedAllocation}%{sim.assumptions.assumedRoles.length ? ` (${sim.assumptions.assumedRoles.length}명 적용)` : ''} · 백업은 부재 인원 업무의 {sim.assumptions.transferPct}% 인수 · 과부하 = 합산 {sim.assumptions.overloadPct}% 초과. 제안서 기준값이 아닌 시뮬레이션 가정입니다.
              </div>
            </>
          )}
        </Card>
      </div>
    </div>
  );
}
