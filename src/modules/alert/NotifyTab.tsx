import { useMemo, useState } from 'react';
import { MEDIA_IDS, SEVERITY_LABEL } from '@/data/constants';
import { addDays, fmt } from '@/core/util';
import { Icon } from '@/ui/Icon';
import { Button, Callout, Card, DataTable, Pill, Sev, Src, type Column } from '@/ui/primitives';
import {
  buildHourIndex, detectTestIncidents, evaluateMedia, fmtClock, fmtDateShort, fmtStamp, kstDate, nextAction, notificationLog, primaryEvidence, slaState, STATUS_LABEL, testBaseId, typeOf,
  withDeliveryNote, type AlertIncident, type NotifyEntry,
} from './engine';
import { DEMO_CREATIVES, TEST_SCENARIOS, TYPE_LABEL, type TestScenarioId } from './data';
import { krwOrDash, mediaName } from './parts';
import type { AlertCtx } from './hooks';
import { serverLogRows, summarizeServerLog, useServerNotifyLog, type ServerLogRow } from './serverLog';
import { useSaas } from '@/saas/context';

export function NotifyTab({ ctx, onOpen }: { ctx: AlertCtx; onOpen: (id: string) => void }) {
  const { incidents, data, nowMs, toMs, state, actions, cfg, clockIso, act, nameOf, server, perm } = ctx;
  const saas = useSaas();
  // 서버 모드: '알림 이력'은 실제 발송 기록 (알림 설정 › 발송 이력과 같은 원본) — 화면 시뮬레이션 목록을 쓰지 않는다
  const serverLog = useServerNotifyLog(server ? saas.workspace?.id ?? null : null);
  const [cleanArmed, setCleanArmed] = useState(false);
  const open = incidents.filter((i) => i.status !== 'resolved');
  const cards = [...open].filter((i) => i.severity !== 'P3').sort((a, b) => (a.severity < b.severity ? -1 : a.severity > b.severity ? 1 : toMs(b.detectedAt) - toMs(a.detectedAt))).slice(0, 4);
  const p3 = open.filter((i) => i.severity === 'P3');
  const tests = incidents.filter((i) => i.isTest);
  const openTestBases = new Set(tests.filter((t) => t.status !== 'resolved').map((t) => testBaseId(t.id)));
  const log = useMemo(() => (server ? [] : notificationLog(incidents, nowMs, toMs)), [server, incidents, nowMs, toMs]);
  const realRows = useMemo(() => (server ? serverLogRows(serverLog.entries, incidents) : []), [server, serverLog.entries, incidents]);
  const realSum = summarizeServerLog(realRows);

  const inject = (kind: TestScenarioId) => {
    if (!perm.operate) return;
    const seq = tests.length + 1;
    const found = detectTestIncidents(data, kind, { config: cfg, creatives: DEMO_CREATIVES, atIso: clockIso(), seq, offHours: state.offHoursMode });
    if (!found.length) {
      actions.toast({ tone: 'warning', title: '주입 결과 없음', body: '현재 탐지 기준에서 새 이슈가 생성되지 않았습니다.' });
      return;
    }
    // 같은 시나리오의 테스트 이슈가 아직 열려 있으면 다시 만들지 않는다 (연속 클릭 · 더블 클릭 중복 방지)
    const fresh = found.filter((f) => !openTestBases.has(testBaseId(f.id)));
    if (!fresh.length) {
      actions.toast({ tone: 'info', title: '같은 테스트 이슈가 이미 열려 있습니다', body: `${found[0].title} · 해결 또는 '테스트 이슈 정리' 후 다시 주입할 수 있습니다.`, route: 'alert' });
      return;
    }
    for (const i of fresh) {
      // 서버 모드: 알림은 서버가 저장하며 'test' 이벤트 채널로 보낸다 — 엔진의 '메신저 알림 발송' 시뮬레이션 문구를 실제 기준 문구로
      actions.addIncident(server ? withDeliveryNote(i, null) : i);
      actions.toast({
        tone: i.severity === 'P1' ? 'critical' : 'warning',
        title: `${i.severity} · ${i.title}`,
        body: `${primaryEvidence(i)} · 다음 조치: ${nextAction(i.ruleId)}`,
        route: 'alert',
      });
    }
  };

  // P3 메일: 주의 수준 관찰 항목 (이슈 미생성 · 표본 부족 포함)
  const watch = useMemo(() => {
    const idx = buildHourIndex(data);
    const covered = new Set(open.filter((i) => ['data_spike', 'anomaly_warn', 'tracking_break', 'invalid_traffic', 'media_no_impression'].includes(i.ruleId)).map((i) => i.media));
    return MEDIA_IDS.filter((m) => !covered.has(m)).flatMap((m) => (evaluateMedia(data, m, cfg, idx)?.evals ?? []).filter((e) => e.level !== 'ok').map((e) => ({ m, e })));
  }, [data, cfg, open]);
  const p12 = open.filter((i) => i.severity !== 'P3');
  const promoEnding = data.promotions.filter((p) => p.status !== 'ended' && p.end >= data.today && p.end <= addDays(data.today, 7));

  const columns: Column<NotifyEntry>[] = [
    { key: 'at', label: '시각', render: (n) => <span className="num nowrap">{fmtStamp(n.atMs)}</span>, sort: (n) => n.atMs, width: 90 },
    { key: 'sev', label: '등급', render: (n) => <Sev level={n.severity} />, width: 60 },
    { key: 'kind', label: '구분', render: (n) => <Pill tone={n.kind === '에스컬레이션' || n.kind === 'SLA 초과' ? 'critical' : n.kind === '조치 공유' ? 'good' : 'neutral'}>{n.kind}</Pill> },
    { key: 'ch', label: '채널 · 수신', render: (n) => <div className="xs"><div className="nowrap"><Icon name={n.channel === '메일' ? 'inbox' : 'send'} size={12} /> {n.channel}</div><div className="muted">{n.to}</div></div> },
    { key: 'title', label: '내용', render: (n) => <div className="xs" style={{ maxWidth: 420 }}><strong>{n.title}</strong><div className="muted">{n.body}</div></div> },
    { key: 'test', label: '', render: (n) => (n.isTest ? <Pill tone="dark">테스트</Pill> : null) },
  ];
  const realColumns: Column<ServerLogRow>[] = [
    { key: 'at', label: '시각', render: (n) => <span className="num nowrap">{fmtStamp(n.atMs)}</span>, sort: (n) => n.atMs, width: 90 },
    { key: 'sev', label: '등급', render: (n) => (n.severity ? <Sev level={n.severity} /> : <span className="xs muted">—</span>), width: 60 },
    { key: 'kind', label: '구분', render: (n) => <Pill tone="neutral">{n.event}</Pill> },
    { key: 'ch', label: '채널', render: (n) => <span className="xs">{n.channel}</span> },
    { key: 'title', label: '내용', render: (n) => <div className="xs" style={{ maxWidth: 420 }}><strong>{n.title}</strong>{n.reason ? <div className="muted">{n.reason}</div> : null}</div> },
    { key: 'status', label: '결과', render: (n) => <Pill tone={n.tone}>{n.statusLabel}</Pill> },
    { key: 'test', label: '', render: (n) => (n.isTest ? <Pill tone="dark">테스트</Pill> : null) },
  ];

  return (
    <div className="stack-lg">
      <Card tone="dark" title={<><Icon name="zap" size={16} /> 테스트 이슈 주입 · 라이브 데모 07:00–10:00</>}
        sub={server
          ? "테스트 데이터를 주입해 같은 탐지 엔진으로 이슈를 만들고 서버에 저장합니다 (isTest 표기). 알림은 'test' 이벤트를 켠 채널로만 발송되고 실제 결과는 아래 알림 이력에 남습니다. 원본 데이터는 바뀌지 않습니다."
          : '테스트 데이터를 주입해 같은 탐지 엔진으로 이슈를 생성합니다 (isTest 표기 · 토스트 알림 · 알림 이력 기록). 원본 데이터는 바뀌지 않습니다.'}
        actions={<><Src kind="PROPOSAL" page="p.60" /><Src kind="DEMO" /></>}>
        <div className="grid g-4">
          {TEST_SCENARIOS.map((s) => (
            <div key={s.id} className="stack-sm">
              <Button variant="accent" icon={s.icon} disabled={!perm.operate} title={perm.operateReason} onClick={() => inject(s.id)}>{s.label}</Button>
              <span className="xs muted">{s.detail}</span>
            </div>
          ))}
        </div>
        <div className="row-between">
          <span className="xs muted">주입 {tests.length}건 · 열린 테스트 이슈 {tests.filter((t) => t.status !== 'resolved').length}건{perm.operateReason ? ` · ${perm.operateReason}` : ''}</span>
          {tests.some((t) => t.status !== 'resolved') ? (
            !cleanArmed ? <Button size="sm" variant="ghost" disabled={!perm.operate} title={perm.operateReason} onClick={() => setCleanArmed(true)}>테스트 이슈 정리</Button> : (
              <span className="row" style={{ gap: 6 }}>
                <span className="xs">열린 테스트 이슈를 모두 해결 처리합니다</span>
                <Button size="sm" variant="danger" onClick={() => { tests.filter((t) => t.status !== 'resolved').forEach((t) => act(t, { status: 'resolved', actionNote: '테스트 정리 (라이브 데모 종료)' }, '테스트 정리')); setCleanArmed(false); }}>확인</Button>
                <Button size="sm" variant="ghost" onClick={() => setCleanArmed(false)}>취소</Button>
              </span>
            )
          ) : null}
        </div>
      </Card>

      <div className="grid g-2">
        <Card title="메신저 알림 미리보기 · P1 / P2" sub={server
          ? '메시지 구성 미리보기 (p.46) — 원인 요약 · 영향 · 다음 조치 · SLA. 실제 발송 여부 · 결과는 아래 알림 이력(서버 발송 기록) 기준입니다.'
          : '자동 알림 실제 화면 (p.46) — 원인 요약 · 영향 · 다음 조치 · SLA를 함께 보냅니다. A 뷰티 브랜드 전용 대시보드 긴급 검수 알림(광고 OFF · 소재 반려 · 성과 급변)과 같은 구조입니다.'} actions={<><Src kind="PROPOSAL" page="p.10 · p.46" /><Src kind="DEMO" /></>}>
          <div className="alert-phone">
            <div className="alert-phone-head"><span># 수면밀도-운영 · MILDO Alert</span><span className="num">{fmtDateShort(data.today)} {fmtClock(nowMs)}</span></div>
            {cards.length ? cards.map((i) => <MessengerCard key={i.id} ctx={ctx} inc={i} onOpen={onOpen} canAck={perm.operate} ackWhy={perm.operateReason} onAck={() => act(i, { status: i.status === 'open' ? 'ack' : i.status, sla: { ...(i.sla ?? {}), ackAt: i.sla?.ackAt ?? clockIso() } }, '인지 (메신저)')} />) : (
              <div className="small" style={{ color: 'var(--panel-muted)', padding: 12 }}>열린 P1 · P2 알림 없음. 위의 테스트 주입 버튼으로 알림을 만들 수 있습니다.</div>
            )}
          </div>
        </Card>

        <Card className="alert-mail-card" title="메일 미리보기 · P3" sub={server ? '매체 · 외부 환경은 메일 · 주간 리포트 (p.44) — 요약 메일 구성 미리보기 · 실제 발송은 알림 설정의 채널 · 발송 이력 기준' : '매체 · 외부 환경은 메일 · 주간 리포트 (p.44) — 24시간 내 영향 분석 · 대응안'} actions={<><Src kind="PROPOSAL" page="p.44" /><Src kind="DEMO" /></>}>
          <div className="alert-mail">
            <div className="alert-mail-head">
              <span>보낸 사람</span><span>{server ? 'MILDO Alert (미리보기 · 발송 전)' : 'MILDO Alert (자동 발송)'}</span>
              <span>받는 사람</span><span>담당 AE · PM · 수면밀도 마케팅 담당자</span>
              <span>제목</span><strong>[MILDO Alert] P3 매체 · 외부 환경 {p3.length}건 · 주의 관찰 {watch.length}건 · P1 · P2 {p12.length}건 ({fmtDateShort(data.today)})</strong>
            </div>
            <div className="alert-mail-body">
              <div>
                <div className="alert-section-label">P3 이슈 · 24시간 내 영향 분석</div>
                {p3.length ? p3.map((i) => (
                  <div key={i.id} className="small" style={{ marginTop: 4 }}>
                    <a href="#alert" onClick={(e) => { e.preventDefault(); onOpen(i.id); }}>{i.title}</a>
                    <div className="xs muted">{primaryEvidence(i)} · 다음 조치: {nextAction(i.ruleId)}</div>
                  </div>
                )) : <div className="small muted">이번 기준 시각 P3 이슈 없음 (탐지 규칙 가동 중).</div>}
              </div>
              <div>
                <div className="alert-section-label">주의 수준 관찰 (이슈 미생성 · p.47 주의 기준)</div>
                {watch.length ? watch.map(({ m, e }) => (
                  <div key={`${m}-${e.metric}`} className="xs" style={{ marginTop: 3 }}>
                    {mediaName(m)} {e.label} {fmt.delta(e.deltaPct)} ({e.baseLabel}) · {e.level === 'danger' ? '위험' : '주의'} 기준 {e.direction === 'both' ? '±' : e.direction === 'up' ? '+' : '−'}{e.level === 'danger' ? e.threshold.danger : e.threshold.warn}%
                    {!e.sampleOk ? <span className="muted"> · 표본 부족 · 참고</span> : null}
                  </div>
                )) : <div className="xs muted">없음</div>}
              </div>
              <div>
                <div className="alert-section-label">{server ? 'P1 · P2 처리 현황 (요약 · 메신저 발송 결과는 알림 이력)' : 'P1 · P2 처리 현황 (메신저 발송 완료 · 요약)'}</div>
                {p12.length ? p12.map((i) => (
                  <div key={i.id} className="xs" style={{ marginTop: 3 }}>{i.severity} {i.title} · {STATUS_LABEL[i.status]} · 담당 {nameOf(i.assignee)}</div>
                )) : <div className="xs muted">없음</div>}
              </div>
              <div>
                <div className="alert-section-label">프로모션 종료 예정 (7일 내)</div>
                {promoEnding.length ? promoEnding.map((p) => <div key={p.id} className="xs" style={{ marginTop: 3 }}>{p.name} · {fmtDateShort(p.end)} 종료 — 종료 시각 소재 가격 문구 교체 예약 필요</div>) : <div className="xs muted">없음</div>}
              </div>
              <div className="xs muted">{server ? '미리보기 — 이 요약 메일은 아직 보내지 않았습니다. 이슈 상세 · 보고서는 MILDO Alert에서 확인.' : '모든 수치는 시연용 TEST DATA. 이슈 상세 · 보고서는 MILDO Alert에서 확인.'}</div>
            </div>
          </div>
        </Card>
      </div>

      {server ? (
        <Card title="알림 이력 · 서버 발송 기록"
          sub={`실제 발송 시도와 결과 (알림 설정 › 발송 이력과 같은 기록 · 최근 ${realRows.length}건) — 발송 ${realSum.sent} · 실패 ${realSum.failed} · 보내지 않음 ${realSum.skipped}`}
          actions={<Button size="sm" variant="ghost" icon="refresh" onClick={serverLog.reload}>새로고침</Button>}>
          {serverLog.error ? <Callout tone="warning" title="발송 기록을 불러오지 못했습니다">{serverLog.error}</Callout> : null}
          <DataTable rows={realRows} columns={realColumns} rowKey={(n) => String(n.id)} maxHeight={420}
            onRowClick={(n) => { if (n.incidentId) onOpen(n.incidentId); }} initialSort={{ key: 'at', dir: 'desc' }}
            empty={serverLog.loading ? '발송 기록을 불러오는 중' : '발송 기록이 없습니다. 알림 채널이 없거나 아직 보낸 알림이 없습니다 — 07 관리 · 연동 › 알림 설정에서 채널을 추가하세요.'} />
        </Card>
      ) : (
        <Card title="알림 이력" sub={`감지 · 당번 호출 · P1 에스컬레이션 · SLA 초과 재알림 · 조치 공유 ${log.length}건 (주입 테스트 포함)`} actions={<Src kind="DEMO" />}>
          {state.offHoursMode || ctx.regime.off ? <Callout tone="info" title="주말 · 공휴일 체계">당번 AE 호출과 P1 PM 에스컬레이션이 함께 기록됩니다 (p.48). 나머지 등급은 다음 영업일 09:30 이슈 브리핑에 포함됩니다.</Callout> : null}
          <DataTable rows={log} columns={columns} rowKey={(n) => n.id} maxHeight={420} onRowClick={(n) => onOpen(n.incidentId)} initialSort={{ key: 'at', dir: 'desc' }} />
        </Card>
      )}
    </div>
  );
}

function MessengerCard({ ctx, inc, onOpen, onAck, canAck = true, ackWhy }: { ctx: AlertCtx; inc: AlertIncident; onOpen: (id: string) => void; onAck: () => void; canAck?: boolean; ackWhy?: string }) {
  const { nowMs, toMs, nameOf, slaOff } = ctx;
  const st = slaState(inc, nowMs, toMs, slaOff);
  const det = toMs(inc.detectedAt);
  const dl = (min: number | null) => {
    if (min === null) return '협의';
    const t = det + min * 60_000;
    const c = fmtClock(t);
    return c === '00:00' && kstDate(t) !== kstDate(det) ? '당일 24:00' : kstDate(t) !== kstDate(det) ? fmtStamp(t) : c;
  };
  return (
    <div className="alert-bot">
      <span className="alert-bot-avatar" aria-hidden>MA</span>
      <div className="stack-sm" style={{ gap: 2, flex: 1, minWidth: 0 }}>
        <div className={`alert-bubble ${inc.severity}`}>
          <div className="row-between" style={{ flexWrap: 'nowrap' }}>
            <span className="row" style={{ gap: 6 }}><Sev level={inc.severity} /><strong className="xs">{SEVERITY_LABEL[inc.severity].split(' · ')[1]}</strong><span className="xs muted">{TYPE_LABEL[typeOf(inc)] ?? ''}</span></span>
            {inc.isTest ? <Pill tone="dark">테스트</Pill> : null}
          </div>
          <strong>{inc.title}</strong>
          <div className="alert-bubble-row"><span>감지 근거</span><span>{primaryEvidence(inc)}</span></div>
          <div className="alert-bubble-row"><span>원인 후보</span><span>{(inc.causes ?? []).slice(0, 2).map((c) => `${c.label}(${c.score})`).join(' · ') || inc.causeCandidates?.[0] || '확인 중'}</span></div>
          <div className="alert-bubble-row"><span>영향</span><span>매출 {krwOrDash(inc.impact?.revenueLossEst)} · 광고비 {krwOrDash(inc.impact?.spendAtRisk)} (추정)</span></div>
          <div className="alert-bubble-row"><span>다음 조치</span><span>{nextAction(inc.ruleId)}</span></div>
          <div className="alert-bubble-row"><span>SLA</span><span className="num">인지 {dl(st.targets.ackMin)} · 1차 조치 {dl(st.targets.actionMin)} · 보고 {dl(st.targets.reportMin)}{st.overdue ? ' · 초과' : ''}</span></div>
          <div className="alert-bubble-row"><span>담당</span><span>{nameOf(inc.assignee)}{inc.onDuty ? ' (당번)' : ''} · 백업 {nameOf(inc.backup)}{inc.severity === 'P1' ? ' · PM 동시' : ''}</span></div>
          {(inc.autoActions ?? []).length ? <div className="alert-bubble-row"><span>자동 조치</span><span>{inc.autoActions[0]}</span></div> : null}
          <div className="alert-bubble-actions">
            <Button size="sm" variant={inc.sla?.ackAt ? 'default' : 'primary'} icon="check" disabled={!!inc.sla?.ackAt || !canAck} title={ackWhy} onClick={onAck}>{inc.sla?.ackAt ? '인지됨' : '인지'}</Button>
            <Button size="sm" icon="external" onClick={() => onOpen(inc.id)}>상세 · 보고서</Button>
          </div>
        </div>
        <span className="alert-time num">{fmtClock(det)} · MILDO Alert 봇</span>
      </div>
    </div>
  );
}
