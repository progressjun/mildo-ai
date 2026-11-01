/* 반복 구간 축소 (p.31) · 커뮤니케이션 · 의사결정 체계 (p.53) · 위임 범위 (p.15) */
import { useMemo } from 'react';
import { DECISION_MATRIX, GFA_DELEGATION, TF_ROLES } from '@/data/constants';
import { navigate } from '@/core/router';
import { Icon } from '@/ui/Icon';
import { Button, Card, Pill, Src } from '@/ui/primitives';
import { COMM_CHANNELS, LEAD_RULES } from './data';
import { APPROVER_LABEL, decisionIndexOf, fmtDuration, leadState, promoReport, ROLE_SCOPE, segmentRows } from './engine';
import type { FlowCtx } from './useFlow';

export function SystemTab({ ctx, onTab }: { ctx: FlowCtx; onTab: (t: string) => void }) {
  const { summary, checks, data, state, changes, clock, incidents, apCfg } = ctx;
  const reportsReady = useMemo(() => (data.promotions ?? []).filter((p) => promoReport(data, p, { changes, incidents }).ready).length, [data, changes, incidents]);
  const rows = segmentRows({ summary, checks, reportsReady, comments: state.comments.length });
  const byDecision = DECISION_MATRIX.map((d, k) => {
    const list = changes.filter((c) => decisionIndexOf(c) === k);
    const leads = list.map((c) => leadState(c, clock.nowMs, clock.toMs)).filter((l) => l.decidedMs !== null && Number.isFinite(l.elapsedMin));
    const met = leads.filter((l) => l.met === true).length;
    return { d, count: list.length, avg: leads.length ? leads.reduce((a, l) => a + l.elapsedMin, 0) / leads.length : NaN, met, decided: leads.length, rule: LEAD_RULES[d.lead] };
  });
  const pm = state.tf?.pm?.name?.trim();
  const go = (route: string, tab?: string) => (route === 'flow' && tab ? onTab(tab) : navigate(route));

  return (
    <div className="stack-lg">
      <Card title="브랜드 ↔ 대행사 반복 구간 축소" sub="요청하고, 기다리고, 다시 확인하던 구간을 MILDO Flow로 줄여 브랜드팀의 시간을 성장 업무로 돌립니다"
        actions={<><Src kind="PROPOSAL" page="p.31" /><Src kind="DEMO" title="이번 세션 실측 열은 시연용 테스트 데이터 기준" /></>}>
        <div className="table-wrap">
          <table className="tbl">
            <thead><tr><th>업무 구간</th><th>지금</th><th>MILDO Flow 이후</th><th>효과</th><th>MILDO OS 화면 · 이번 세션 실측</th></tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.seg}>
                  <td><strong className="small">{r.seg}</strong></td>
                  <td className="small muted">{r.now}</td>
                  <td className="small">{r.after}</td>
                  <td><Pill tone="accent">{r.effect}</Pill></td>
                  <td>
                    <div className="row" style={{ gap: 6, flexWrap: 'nowrap' }}>
                      <span className="small ink2">{r.live.value}</span>
                      <Button size="sm" variant="ghost" icon="chevron" onClick={() => go(r.live.route, r.live.tab)}>열기</Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="row small ink2" style={{ gap: 8 }}>
          <Icon name="zap" size={14} />확보된 시간은 키워드 확장 · 신규 매체 · 코프로모션 실험에 재투입합니다. 도입 브랜드 반복 업무 40%+ 감소 <Src kind="PROPOSAL" page="p.31" />
        </div>
      </Card>

      {/* 조직도(짧은 카드)를 위임 범위 · 권한 표 두 장과 나란히 두고, 7열 결정 유형 표는 전체 폭으로 — 반쪽 폭에서 1~2자씩 줄바꿈되던 문제 해소 */}
      <div className="grid g-2">
        <Card tone="dark" className="flow-org-card" title="커뮤니케이션 · 의사결정 체계" sub="창구는 메인 PM 한 명으로 모으고, 결정 유형마다 결정자와 소요 시간을 미리 정합니다" actions={<Src kind="PROPOSAL" page="p.53" />}>
          <div className="flow-org">
            <div className="flow-org-node">수면밀도 담당자</div>
            <Icon name="chevronDown" size={14} />
            <div className="flow-org-node main">메인 PM · 단일 창구<span className="xs">{pm || '[성명] — 전담 TF 화면에서 입력'}</span></div>
            <Icon name="chevronDown" size={14} />
            <div className="row" style={{ gap: 6, justifyContent: 'center' }}>
              {['Lead AE', '매체 전문가', '개발자'].map((x) => <div key={x} className="flow-org-node sm">{x}</div>)}
            </div>
          </div>
          <div className="flow-channels">
            {COMM_CHANNELS.map((c) => (
              <div key={c.name} className="flow-channel">
                <strong className="small">{c.name}</strong>
                <span className="xs muted">{c.cadence} · {c.use}</span>
              </div>
            ))}
          </div>
        </Card>
        <div className="stack-lg">
          <Card title="승인 위임 범위 (GFA Control v1 · AD Pilot 공통)" sub="담당 AE → PM → 광고주, 위임 범위별 차등 · 위임 범위는 예시이며 계약 시 확정" actions={<Src kind="PROPOSAL" page="p.15" />}>
            <div className="table-wrap">
              <table className="tbl">
                <thead><tr><th>변경 범위</th><th>승인 주체</th><th className="r">이번 세션 요청</th></tr></thead>
                <tbody>
                  {GFA_DELEGATION.map((g) => (
                    <tr key={g.range}><td className="small">{g.range}</td><td className="small"><strong>{g.label}</strong></td><td className="r">{changes.filter((c) => c.approver === g.approver).length}</td></tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="xs muted">입찰 변경은 위임 범위와 별도로 일 조정 폭 상한 {apCfg.dailyChangeCapPct}% · 브랜드 키워드 별도 기준(목표 ROAS {apCfg.brandTargetRoas}%)을 적용합니다 (p.14 · AD Pilot 공식 기준).</div>
          </Card>
          <Card title="역할별 처리 권한" sub="승인 · 반려 · 반영 · 롤백 모두 같은 권한 규칙" actions={<><Pill tone="accent">현재 {state.role}</Pill></>}>
            <div className="table-wrap">
              <table className="tbl">
                <thead><tr><th>역할</th><th>처리 가능한 요청</th><th className="r">현재 승인 대기</th></tr></thead>
                <tbody>
                  {Object.entries(ROLE_SCOPE).map(([role, scope]) => (
                    <tr key={role} className={role === state.role ? 'selected' : undefined}>
                      <td className="small"><strong>{role}</strong></td>
                      <td className="small">{scope.map((a) => APPROVER_LABEL[a]).join(' · ')} 건</td>
                      <td className="r">{changes.filter((c) => c.status === 'pending' && scope.includes(c.approver)).length}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="xs muted">전담 TF {TF_ROLES.length}인 · 단일 창구는 {TF_ROLES[0].role}, 백업 {TF_ROLES.find((r) => r.id === TF_ROLES[0].backup)?.role} (p.52).</div>
          </Card>
        </div>
      </div>

      <Card title="결정 유형 · 결정자 · 소요" sub="판정 시한은 소요 기준을 시각으로 환산 · 이번 세션 처리 실적" actions={<><Src kind="PROPOSAL" page="p.53" /><Src kind="DEMO" /></>}>
        <div className="table-wrap flow-decision-table">
          <table className="tbl">
            <thead><tr><th>결정 유형</th><th>결정자</th><th>소요</th><th>판정 시한</th><th className="r">건수</th><th className="r">평균 결정</th><th className="r">기준 충족</th></tr></thead>
            <tbody>
              {byDecision.map((r) => (
                <tr key={r.d.type}>
                  <td className="small"><strong>{r.d.type}</strong></td>
                  <td className="small">{r.d.decider}</td>
                  <td className="small">{r.d.lead}</td>
                  <td className="xs muted">{r.rule?.label ?? '—'}<div>{r.rule?.note}</div></td>
                  <td className="r">{r.count}</td>
                  <td className="r">{fmtDuration(r.avg)}</td>
                  <td className="r">{r.decided ? `${r.met}/${r.decided}` : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}
