import { useMemo, useState } from 'react';
import type { Severity } from '@/core/types';
import { MEDIA } from '@/data/constants';
import { fmt, sum } from '@/core/util';
import { AiInsight } from '@/ui/AiInsight';
import { Card, DataTable, Pill, Segmented, Src, Stat, Toggle, type Column } from '@/ui/primitives';
import { fmtRemain, fmtStamp, heldMedia, nextAction, primaryEvidence, sevCounts, slaState, type AlertIncident } from './engine';
import { TYPE_LABEL } from './data';
import { issuesBrief } from './briefs';
import { krwOrDash, MediaTag, SevLabel, SlaTimer, StatusPill } from './parts';
import type { AlertCtx } from './hooks';

type SortId = 'priority' | 'impact' | 'recent';
const SEV_RANK: Record<Severity, number> = { P1: 0, P2: 1, P3: 2 };

export function QueueTab({ ctx, onOpen }: { ctx: AlertCtx; onOpen: (id: string) => void }) {
  const { incidents, nowMs, toMs, state, data, nameOf, regime } = ctx;
  const [status, setStatus] = useState<'open' | 'all' | 'resolved'>('open');
  const [sev, setSev] = useState<'all' | Severity>('all');
  const [testOnly, setTestOnly] = useState(false);
  const [sort, setSort] = useState<SortId>('priority');

  const open = incidents.filter((i) => i.status !== 'resolved');
  const counts = sevCounts(incidents);
  const held = heldMedia(incidents);
  const withSla = useMemo(() => incidents.map((i) => ({ i, st: slaState(i, nowMs, toMs, state.offHoursMode) })), [incidents, nowMs, toMs, state.offHoursMode]);
  const urgent = withSla.filter(({ i, st }) => i.status !== 'resolved' && (st.overdue || (st.remainingMin !== null && st.remainingMin <= 10)));
  const overdue = urgent.filter(({ st }) => st.overdue);
  const revenue = sum(open, (i) => i.impact?.revenueLossEst ?? 0);
  const spend = sum(open, (i) => i.impact?.spendAtRisk ?? 0);

  const rows = withSla
    .filter(({ i }) => (status === 'open' ? i.status !== 'resolved' : status === 'resolved' ? i.status === 'resolved' : true))
    .filter(({ i }) => sev === 'all' || i.severity === sev)
    .filter(({ i }) => !testOnly || i.isTest)
    .sort((a, b) => {
      if (sort === 'impact') return (b.i.impact?.revenueLossEst ?? 0) - (a.i.impact?.revenueLossEst ?? 0);
      if (sort === 'recent') return toMs(b.i.detectedAt) - toMs(a.i.detectedAt);
      return SEV_RANK[a.i.severity] - SEV_RANK[b.i.severity] || (a.st.remainingMin ?? 1e9) - (b.st.remainingMin ?? 1e9);
    });

  const columns: Column<(typeof rows)[number]>[] = [
    { key: 'sev', label: '등급', render: ({ i }) => <SevLabel sev={i.severity} />, width: 96 },
    {
      key: 'title', label: '이슈',
      render: ({ i }) => (
        <div style={{ minWidth: 220 }}>
          <div className="alert-title">{i.title}</div>
          <div className="alert-sub">
            <span>{TYPE_LABEL[i.typeId] ?? i.ruleId}</span>
            {i.page ? <Src kind="PROPOSAL" page={i.page} /> : null}
            {i.isTest ? <Pill tone="dark">테스트 주입</Pill> : null}
            {i.recurrence?.count ? <Pill tone="warning" title={i.recurrence.dates.join(', ')}>30일 내 재발 {i.recurrence.count}회</Pill> : null}
            {i.holdMedia && i.status !== 'resolved' ? <Pill tone="outline" icon="pause">자동 조정 보류</Pill> : null}
          </div>
        </div>
      ),
    },
    { key: 'media', label: '매체 · 대상', render: ({ i }) => <div className="stack-sm" style={{ gap: 2 }}><MediaTag media={i.media} /><span className="xs muted">{i.target}</span></div> },
    { key: 'ev', label: '감지 근거 · 판정 기준', render: ({ i }) => <div className="alert-ev">{primaryEvidence(i)}</div> },
    { key: 'cause', label: '원인 후보 1순위', render: ({ i }) => (i.causes?.[0] ? <div className="xs"><strong>{i.causes[0].label}</strong><div className="muted num">근거 강도 {i.causes[0].score}</div></div> : <span className="xs muted">{i.causeCandidates?.[0] ?? '—'}</span>) },
    { key: 'impact', label: '추정 매출 영향', align: 'right', render: ({ i }) => <span className="num">{krwOrDash(i.impact?.revenueLossEst)}</span>, sort: ({ i }) => i.impact?.revenueLossEst ?? 0 },
    { key: 'sla', label: 'SLA (p.49)', render: ({ i }) => <SlaTimer inc={i} compact /> },
    { key: 'who', label: '담당 · 백업', render: ({ i }) => <div className="xs"><div>{nameOf(i.assignee)}{i.onDuty ? <span className="muted"> (당번)</span> : null}</div><div className="muted">백업 {nameOf(i.backup)}</div></div> },
    { key: 'status', label: '상태', render: ({ i }) => <StatusPill inc={i} /> },
  ];

  const next = withSla.filter(({ i }) => i.status !== 'resolved').sort((a, b) => SEV_RANK[a.i.severity] - SEV_RANK[b.i.severity] || (a.st.remainingMin ?? 1e9) - (b.st.remainingMin ?? 1e9)).slice(0, 5);

  return (
    <div className="stack-lg">
      <div className="grid g-6">
        <Card><Stat label="열린 이슈" src={<Src kind="DEMO" />} value={counts.open} foot={<span>P1 {counts.P1} · P2 {counts.P2} · P3 {counts.P3}</span>} /></Card>
        <Card><Stat label="SLA 임박 · 초과" src={<Src kind="DEMO" />} value={<span>{urgent.length}<span className="small muted"> / 초과 {overdue.length}</span></span>} foot={<span>임박 = 단계 목표 10분 이내 (p.49)</span>} /></Card>
        <Card><Stat label="자동 조정 보류" src={<Src kind="DEMO" />} value={held.length} foot={<span>{held.length ? held.map((m) => MEDIA[m].short).join(' · ') : '없음'}</span>} /></Card>
        <Card><Stat label="추정 매출 영향" src={<Src kind="DEMO" />} value={`${fmt.krw(revenue)}원`} foot={<span>열린 이슈 합계 · 추세 지속 가정 (상세에 산출식)</span>} /></Card>
        <Card><Stat label="위험 노출 광고비" src={<Src kind="DEMO" />} value={`${fmt.krw(spend)}원`} foot={<span>잘못된 신호 · 초과 집행 · 중단 위험</span>} /></Card>
        <Card tone={regime.off ? 'dark' : undefined}>
          <Stat label="운영 체계" value={<span style={{ fontSize: 'var(--fs-xl)' }}>{regime.off ? '주말 · 공휴일' : '평일'}</span>}
            foot={<span className={regime.off ? 'muted' : undefined}>{regime.off ? `당번 ${nameOf(regime.duty?.role)} · 30분 내 확인 · P1 → PM (p.48)` : '담당 AE + 백업 · P1은 PM 동시 알림 (p.44)'}</span>} />
        </Card>
      </div>

      <Card
        title="열린 이슈 큐"
        sub="등급 · SLA 타이머 · 담당 AE + 백업 · 상태. 행을 누르면 감지 근거 · 원인 후보 · 영향 · 조치 단계가 열립니다."
        actions={
          <>
            <Segmented label="상태" value={status} onChange={setStatus} options={[{ id: 'open', label: `열린 이슈 ${open.length}` }, { id: 'all', label: `전체 ${incidents.length}` }, { id: 'resolved', label: `해결 ${incidents.length - open.length}` }]} />
            <Segmented label="등급" value={sev} onChange={setSev} options={[{ id: 'all', label: '전체' }, { id: 'P1', label: 'P1' }, { id: 'P2', label: 'P2' }, { id: 'P3', label: 'P3' }]} />
            <Segmented label="정렬" value={sort} onChange={setSort} options={[{ id: 'priority', label: '등급 · SLA' }, { id: 'impact', label: '영향' }, { id: 'recent', label: '최근' }]} />
            <Toggle id="alert-test-only" checked={testOnly} onChange={setTestOnly} label="테스트 주입만" />
            <Src kind="DEMO" />
          </>
        }
      >
        <DataTable rows={rows} columns={columns} rowKey={({ i }) => i.id} onRowClick={({ i }) => onOpen(i.id)} maxHeight={560}
          empty={status === 'open' ? '열린 이슈가 없습니다. 알림 · 테스트 주입 탭에서 테스트 이슈를 만들 수 있습니다.' : '조건에 맞는 이슈가 없습니다'} />
      </Card>

      <div className="grid g-2">
        <Card title="지금 처리할 순서" sub="등급 → SLA 남은 시간 순 · 단계별 다음 조치 (규칙 엔진 권고)">
          {next.length ? (
            <div className="stack">
              {next.map(({ i, st }) => (
                <button key={i.id} type="button" className="row" onClick={() => onOpen(i.id)} style={{ flexWrap: 'nowrap', alignItems: 'stretch', gap: 10, background: 'none', border: 0, padding: 0, textAlign: 'left', cursor: 'pointer', color: 'inherit', font: 'inherit' }}>
                  <span className={`alert-stripe ${i.severity}`} />
                  <span className="stack-sm" style={{ gap: 3, flex: 1, minWidth: 0 }}>
                    <span className="row-between" style={{ flexWrap: 'nowrap' }}>
                      <strong className="small">{i.title}</strong>
                      <span className={`alert-sla ${st.overdue ? 'critical' : 'neutral'}`}>{st.stageLabel} · {fmtRemain(st.remainingMin)}</span>
                    </span>
                    <span className="xs muted">{nameOf(i.assignee)}{i.onDuty ? ' (당번)' : ''} · {st.deadlineMs ? `${fmtStamp(st.deadlineMs)}까지` : ''} · {nextAction(i.ruleId)}</span>
                  </span>
                </button>
              ))}
            </div>
          ) : <div className="small muted">열린 이슈 없음</div>}
        </Card>
        <AiInsight
          title="AI 원인 분석 · 우선순위"
          sub="열린 이슈의 감지 근거 · 원인 후보 순위 · 영향을 읽고 판단 근거를 정리합니다 (버튼을 누를 때만 실행)"
          cta="AI 분석 생성"
          buildPrompt={() => {
            const list = open.slice(0, 12).map((i) => ({
              id: i.id, severity: i.severity, title: i.title, type: TYPE_LABEL[i.typeId] ?? i.ruleId, media: i.media,
              evidence: (i.evidence ?? []).slice(0, 6).map((e) => ({ label: e.label, observed: Number.isFinite(e.observed) ? Math.round(e.observed * 10) / 10 : null, baseline: e.baseline !== undefined && Number.isFinite(e.baseline) ? Math.round(e.baseline * 10) / 10 : null, deltaPct: e.deltaPct !== undefined && Number.isFinite(e.deltaPct) ? Math.round(e.deltaPct) : null, threshold: e.threshold, note: e.note })),
              basis: i.basis, causes: (i.causes ?? []).slice(0, 3), impact: i.impact, impactNote: i.impactNote, autoActions: i.autoActions, recurrence: i.recurrence,
              sla: slaState(i, nowMs, toMs, state.offHoursMode).stageLabel,
            }));
            return `과제: MILDO Alert에서 열린 이슈의 처리 우선순위와 원인 가설을 정리한다. 각 이슈의 감지 근거 수치 · 판정 기준 · 원인 후보 순위(근거 강도는 확률이 아님)를 근거로 쓰고, 같은 매체에서 동시에 열린 이슈가 하나의 원인에서 이어진 것인지 판단한다. CAC 회수 구조와 퍼널 역할(유입 · 전환 · 재방문) 관점에서 손실이 큰 순서를 제시하고, 실제 손실과 측정 손실(추적 단절)을 구분한다.
기준 시각: ${data.today} ${data.currentHour}:30 (${regime.off ? `${regime.label} · 당번 ${regime.duty?.role} 30분 내 확인 · P1은 PM 에스컬레이션` : '평일'}). SLA: P1 인지 15분 · 1차 조치 30분 · 결과 보고 2시간, P2 1시간 · 4시간 · 당일 (제안서 p.49).
데이터(JSON, 시연용 TEST DATA):
${JSON.stringify(list)}`;
          }}
          fallback={() => issuesBrief(data, incidents, nowMs, toMs)}
        />
      </div>
    </div>
  );
}
