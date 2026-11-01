import { useMemo, useState } from 'react';
import type { Severity } from '@/core/types';
import { INCIDENT_REPORT_TEMPLATE, SLA } from '@/data/constants';
import { HBarChart } from '@/ui/charts';
import { Card, CopyButton, DataTable, DownloadButton, Pill, Segmented, Sev, Src, Stat, type Column } from '@/ui/primitives';
import { historyRecords, recordTargets, sessionRecords, slaReport, type SlaRecord, type SlaRow } from './engine';
import { TYPE_LABEL, WEEKEND_ACK_MIN } from './data';
import { mediaName } from './parts';
import type { AlertCtx } from './hooks';

const p = (x: number) => (Number.isFinite(x) ? `${x.toFixed(0)}%` : '—');

export function SlaTab({ ctx }: { ctx: AlertCtx }) {
  const { incidents, toMs } = ctx;
  const [src, setSrc] = useState<'all' | 'history' | 'session'>('all');
  const [sev, setSev] = useState<'all' | Severity>('all');
  const session = useMemo(() => sessionRecords(incidents, toMs), [incidents, toMs]);
  const all = useMemo(() => [...historyRecords(), ...session], [session]);
  const rep = useMemo(() => slaReport(all), [all]);
  const inProgress = incidents.filter((i) => i.status !== 'resolved').length;
  const list = all.filter((r) => (src === 'all' || r.source === src) && (sev === 'all' || r.severity === sev)).sort((a, b) => (b.date + String(b.hour).padStart(2, '0')).localeCompare(a.date + String(a.hour).padStart(2, '0')));

  const cell = (r: SlaRecord, k: 'ack' | 'action' | 'report') => {
    const v = k === 'ack' ? r.ackMin : k === 'action' ? r.actionMin : r.reportMin;
    if (v === null) return <span className="muted">—</span>;
    const t = recordTargets(r)[k];
    const adj = k === 'ack' ? v : v - r.mediaDelayMin;
    const miss = t !== null && adj > t && !(r.falsePositive && k !== 'ack');
    return <span className="num" title={t !== null ? `목표 ${Math.round(t)}분${k !== 'ack' && r.mediaDelayMin ? ` · 매체 지연 ${r.mediaDelayMin}분 제외` : ''}` : '목표 협의'}>{Math.round(v)}분{miss ? <Pill tone="critical">미달</Pill> : null}</span>;
  };
  const cols: Column<SlaRecord>[] = [
    { key: 'd', label: '일시', render: (r) => <span className="num xs">{r.date.slice(5)} {String(r.hour).padStart(2, '0')}시</span> },
    { key: 's', label: '등급', render: (r) => <Sev level={r.severity} /> },
    { key: 't', label: '이슈', render: (r) => <div><span className="small">{r.title}</span><div className="xs muted">{TYPE_LABEL[r.typeId] ?? r.typeId} · {mediaName(r.media)}</div></div> },
    { key: 'a', label: '인지', align: 'right', render: (r) => cell(r, 'ack') },
    { key: 'c', label: '1차 조치', align: 'right', render: (r) => cell(r, 'action') },
    { key: 'r', label: '결과 보고', align: 'right', render: (r) => cell(r, 'report') },
    { key: 'f', label: '구분', render: (r) => <span className="row" style={{ gap: 4 }}>{r.falsePositive ? <Pill tone="neutral">오탐</Pill> : null}{r.recurrence ? <Pill tone="warning">재발</Pill> : null}{r.mediaDelayMin ? <Pill tone="outline">매체 지연 {r.mediaDelayMin}분</Pill> : null}{r.source === 'session' ? <Pill tone="dark">이번 세션</Pill> : null}</span> },
  ];
  const md = () => [
    '## MILDO Alert 월간 SLA 리포트 · 2026년 10월',
    `대상 ${rep.total.total}건 (지난 이력 DEMO ${all.length - session.length}건 + 이번 세션 처리 ${session.length}건) · 진행 중 ${inProgress}건 · TEST DATA (시연용)`,
    '',
    '| 등급 | 건수 | 인지 달성 | 1차 조치 달성 | 결과 보고 달성 | 오탐 | 재발 | 매체 지연(별도) |',
    '|---|---|---|---|---|---|---|---|',
    ...rep.rows.map((r) => `| ${r.severity} | ${r.total} | ${p(r.ack.pct)} (${r.ack.ok}/${r.ack.n}) | ${p(r.action.pct)} (${r.action.ok}/${r.action.n}) | ${p(r.report.pct)} (${r.report.ok}/${r.report.n}) | ${r.falsePositive.n}건 (${p(r.falsePositive.pct)}) | ${r.recurrence}건 | ${r.mediaDelay.n}건 · ${r.mediaDelay.min}분 |`),
    `| 전체 | ${rep.total.total} | ${p(rep.total.ack.pct)} | ${p(rep.total.action.pct)} | ${p(rep.total.report.pct)} | ${rep.total.falsePositive.n}건 (${p(rep.total.falsePositive.pct)}) | ${rep.total.recurrence}건 | ${rep.total.mediaDelay.n}건 · ${rep.total.mediaDelay.min}분 |`,
    '',
    '### 산정 기준',
    `P1 인지 ${SLA.P1.label.ack} · 1차 조치 ${SLA.P1.label.action} · 결과 보고 ${SLA.P1.label.report}, P2 ${SLA.P2.label.ack} · ${SLA.P2.label.action} · ${SLA.P2.label.report}, P3 ${SLA.P3.label.ack} · ${SLA.P3.label.action} · ${SLA.P3.label.report} (제안서 p.49). 주말 · 공휴일 인지는 당번 ${WEEKEND_ACK_MIN}분 (p.48). 매체 지연(검수 대기 · 집계 지연)은 조치 · 보고 시간에서 빼고 별도 표기. 오탐은 조치 · 보고 달성률 분모에서 제외.`,
    '',
    '### 매체별',
    ...rep.byMedia.map((m) => `- ${mediaName(m.media)}: ${m.n}건 · 매체 지연 ${m.delayed}건 (${m.delayMin}분)`),
  ].join('\n');

  return (
    <div className="stack-lg">
      <div className="grid g-5 alert-kpis">
        <Card><Stat label="10월 이슈" src={<Src kind="DEMO" />} value={rep.total.total} foot={<span>이번 세션 처리 {session.length} · 진행 중 {inProgress}</span>} /></Card>
        <Card><Stat label="인지 SLA 달성" src={<Src kind="DEMO" />} value={p(rep.total.ack.pct)} foot={<span>{rep.total.ack.ok}/{rep.total.ack.n} · <span className="nowrap">P1 15분</span> · <span className="nowrap">P2 1시간</span> · <span className="nowrap">P3 1일</span></span>} /></Card>
        <Card><Stat label="1차 조치 달성" src={<Src kind="DEMO" />} value={p(rep.total.action.pct)} foot={<span>{rep.total.action.ok}/{rep.total.action.n} · 매체 지연 제외 산정</span>} /></Card>
        <Card><Stat label="오탐률" src={<Src kind="DEMO" />} value={p(rep.total.falsePositive.pct)} foot={<span>{rep.total.falsePositive.n}건 · 탐지 기준 튜닝 근거</span>} /></Card>
        <Card><Stat label="재발 · 매체 지연" src={<Src kind="DEMO" />} value={<span>{rep.total.recurrence}<span className="small muted"> / 지연 {rep.total.mediaDelay.n}</span></span>} foot={<span>매체 지연 합계 {rep.total.mediaDelay.min}분 (별도 표기)</span>} /></Card>
      </div>

      <div className="grid g-3">
        <Card className="span-2" title="월간 SLA 리포트 · 2026년 10월" sub="등급별 달성률 · 오탐률 · 재발 건수 · 매체 지연은 별도 표기 · 달성률은 매월 공개 (p.49)" actions={<><Src kind="PROPOSAL" page="p.49" /><Src kind="DEMO" /><CopyButton text={md} /><DownloadButton filename="MILDO-Alert-월간-SLA-2026-10.md" data={md} mime="text/markdown;charset=utf-8" label=".md" /></>}>
          <div className="table-wrap">
            <table className="tbl">
              <thead><tr><th>등급</th><th className="r">건수</th><th className="r">인지 달성</th><th className="r">1차 조치 달성</th><th className="r">결과 보고 달성</th><th className="r">오탐률</th><th className="r">재발</th><th className="r">매체 지연 (별도)</th></tr></thead>
              <tbody>
                {rep.rows.map((r: SlaRow) => (
                  <tr key={r.severity}>
                    <td><Sev level={r.severity} /> <span className="xs muted">목표 {SLA[r.severity].label.ack} · {SLA[r.severity].label.action} · {SLA[r.severity].label.report}</span></td>
                    <td className="r num">{r.total}</td>
                    <td className="r num">{p(r.ack.pct)} <span className="xs muted">{r.ack.ok}/{r.ack.n}</span></td>
                    <td className="r num">{SLA[r.severity].actionMin === null ? <span className="muted">협의</span> : <>{p(r.action.pct)} <span className="xs muted">{r.action.ok}/{r.action.n}</span></>}</td>
                    <td className="r num">{p(r.report.pct)} <span className="xs muted">{r.report.ok}/{r.report.n}</span></td>
                    <td className="r num">{p(r.falsePositive.pct)} <span className="xs muted">{r.falsePositive.n}건</span></td>
                    <td className="r num">{r.recurrence}</td>
                    <td className="r num">{r.mediaDelay.n}건 · {r.mediaDelay.min}분</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="xs muted">산정: 오탐은 조치 · 보고 분모에서 제외, 매체 지연(검수 대기 · 집계 지연)은 조치 · 보고 시간에서 빼고 별도 집계. 주말 · 공휴일 인지 목표는 당번 {WEEKEND_ACK_MIN}분 (p.48). 지난 이력은 시연용 DEMO 데이터.</div>
        </Card>
        <Card title="등급별 인지 SLA 달성률" sub="목표 100% · 세로선 90%" actions={<Src kind="DEMO" />}>
          <HBarChart data={rep.rows.map((r) => ({ label: `${r.severity} 인지`, value: Number.isFinite(r.ack.pct) ? r.ack.pct : 0, colorVar: '--series-1' }))
            .concat(rep.rows.filter((r) => SLA[r.severity].actionMin !== null).map((r) => ({ label: `${r.severity} 1차 조치`, value: Number.isFinite(r.action.pct) ? r.action.pct : 0, colorVar: '--series-7' })))}
            format={(v) => `${v.toFixed(0)}%`} max={100} refValue={90} refLabel="관리 기준 90% (운영 가정)" />
          <div className="stack-sm">
            <span className="alert-section-label">이슈 보고서 양식 (p.49)</span>
            {INCIDENT_REPORT_TEMPLATE.map((t) => <div key={t.key} className="row xs" style={{ gap: 6 }}><strong style={{ minWidth: 60 }}>{t.label}</strong><span className="muted">{t.fields}</span></div>)}
          </div>
        </Card>
      </div>

      <Card title="처리 이력" sub="지난 이력(DEMO) + 이번 세션에서 인지 · 처리한 이슈" actions={
        <>
          <Segmented label="출처" value={src} onChange={setSrc} options={[{ id: 'all', label: '전체' }, { id: 'history', label: '지난 이력' }, { id: 'session', label: `이번 세션 ${session.length}` }]} />
          <Segmented label="등급" value={sev} onChange={setSev} options={[{ id: 'all', label: '전체' }, { id: 'P1', label: 'P1' }, { id: 'P2', label: 'P2' }, { id: 'P3', label: 'P3' }]} />
        </>
      }>
        <DataTable rows={list} columns={cols} rowKey={(r) => r.id} maxHeight={420} empty="조건에 맞는 이력 없음 · 이슈 큐에서 인지 · 처리하면 이번 세션 이력이 쌓입니다" />
      </Card>
    </div>
  );
}
