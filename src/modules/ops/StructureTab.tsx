/* p.48 주말 · 공휴일 당번 요약 · p.53 커뮤니케이션 · 의사결정 · p.50 계정 · 결제 · 권한 */
import { useMemo } from 'react';
import { useStore } from '@/core/store';
import { fmt } from '@/core/util';
import { Card, DataTable, Pill, Src, type Column } from '@/ui/primitives';
import { COMM_STRUCTURE, HOLIDAY_PRECHECK, WEEKEND_TIERS } from './data';
import { decisionLoad, dutyAccess, dutyBlocks, dutyLoad, shortDate, type AccountCheck, type DutyBlock, type OwnershipRow } from './engine';
import type { OpsModel } from './useOps';
import { LevelPill } from './parts';

export function StructureTab({ model }: { model: OpsModel }) {
  const { state } = useStore();
  const d = state.data;
  const blocks = useMemo(() => dutyBlocks(d.today, 63), [d.today]);
  const load = useMemo(() => dutyLoad(blocks.flatMap((b) => b.duties)), [blocks]);
  const decisions = useMemo(() => decisionLoad(state.changes), [state.changes]);
  const own = model.summary.ownership;
  const nameOf = (id: string) => state.tf[id]?.name?.trim() || '[성명]';
  const offNow = blocks[0] && blocks[0].start <= d.today && blocks[0].end >= d.today;

  const blockCols: Column<DutyBlock>[] = [
    { key: 'p', label: '휴무 구간', render: (b) => <div><strong className="small num">{shortDate(b.start)}{b.days > 1 ? ` ~ ${shortDate(b.end)}` : ''}</strong><div className="xs muted">{[...new Set(b.labels)].join(' · ')} · {b.days}일</div></div> },
    { key: 'o', label: '2차 · 당번 AE (30분 내 확인)', render: (b) => {
      const ids = [...new Set(b.duties.map((x) => x.roleId))];
      return <div className="small">{ids.map((id) => <div key={id}><strong>{b.duties.find((x) => x.roleId === id)!.role}</strong> <span className="muted">{nameOf(id)}</span></div>)}</div>;
    } },
    { key: 'b', label: '백업', render: (b) => <span className="small">{[...new Set(b.duties.map((x) => x.backup))].join(' · ')}</span> },
    { key: 'acc', label: '당번 권한 계정', align: 'right', render: (b) => {
      const a = dutyAccess(d, b.duties[0].roleId);
      return <span className="num small" title={a.missing.length ? `권한 없음: ${a.missing.join(', ')}` : undefined}>{a.has} / {a.total}</span>;
    } },
    { key: 'e', label: '3차', render: () => <span className="xs">PM 에스컬레이션 · P1 한정</span> },
    { key: 'n', label: '다음 영업일 브리핑', render: (b) => <span className="small num">{shortDate(b.briefing)} 09:30</span> },
    { key: 'h', label: '구분', render: (b) => (b.hasHoliday ? <Pill tone="accent" icon="calendar">공휴일 포함 · 전날 사전 점검</Pill> : <Pill tone="neutral">주말</Pill>) },
  ];

  const ownCols: Column<OwnershipRow>[] = [
    { key: 'item', label: '항목', render: (r) => <strong className="small">{r.item}</strong> },
    { key: 'owner', label: '소유 · 주체', render: (r) => <span className="small">{r.owner}</span> },
    { key: 'role', label: '프로그레스미디어 역할', render: (r) => <span className="small">{r.role}</span> },
    { key: 'approval', label: '변경 승인', render: (r) => <span className="small">{r.approval}</span> },
    { key: 'live', label: '현재 데이터 점검', render: (r) => <div className="row" style={{ gap: 6, flexWrap: 'nowrap' }}><LevelPill level={r.level} /><span className="xs">{r.live}</span></div> },
  ];

  const accCols: Column<AccountCheck>[] = [
    { key: 'name', label: '계정', render: (a) => <div><strong className="small">{a.name}</strong><div className="xs muted">{a.channel}</div></div> },
    { key: 'owner', label: '소유', render: (a) => (a.ownerOk ? <Pill tone="good" icon="check">수면밀도</Pill> : <Pill tone="critical" icon="x">{a.owner}</Pill>) },
    { key: 'pay', label: '결제', render: (a) => <div className="xs">{a.payment}<div className="muted">자동충전 {({ ok: '정상', failed: '실패', off: '없음', postpaid: '후불' } as const)[a.autoCharge]}</div></div> },
    { key: 'run', label: '잔액 일수', align: 'right', sort: (a) => a.runwayDays ?? 999, render: (a) => (a.runwayDays === null ? <span className="xs muted">후불</span> : <span className={`num ${a.runwayDays < 1 ? 'bold' : ''}`}>{fmt.dec1(a.runwayDays)}일</span>) },
    { key: 'perm', label: '권한 (실명)', render: (a) => <div className="xs">{a.agencyUsers.join(' · ') || '—'}{a.nonRealName.map((p) => <div key={p.user}><Pill tone="critical" icon="x">비실명 {p.user} · {p.role}</Pill></div>)}</div> },
    { key: 'st', label: '상태', render: (a) => (a.status === 'active' ? <span className="xs">정상</span> : <Pill tone="warning" icon="alert">{a.status === 'review' ? '검수 · 확인 필요' : '제재'}</Pill>) },
    { key: 'f', label: '점검 결과 · 조치', render: (a) => (
      <div className="stack-sm" style={{ gap: 3 }}>
        {a.findings.filter((f) => f.level !== 'info' || a.findings.length === 1).map((f, i) => <div key={i} className="xs"><LevelPill level={f.level}>{f.item}</LevelPill> {f.text}{f.action !== '—' ? <span className="muted"> → {f.action}</span> : null}</div>)}
      </div>
    ) },
  ];

  return (
    <div className="stack-lg">
      <div className="grid g-2">
        <Card title="주말 · 공휴일 당번 순번 요약" sub="MILDO Alert와 같은 규칙 · 매체 AE 4인 순환 · 주말은 토 · 일 같은 당번 · 평일 공휴일은 일자 순번 (순번 방식은 운영 가정)"
          actions={<><Src kind="PROPOSAL" page="p.48" /><a className="btn sm" href="#alert">Alert 당번표 · 사전 점검</a></>}>
          <div className="ops-tiers">
            {WEEKEND_TIERS.map((t) => (
              <div key={t.tier} className="ops-tier"><span className="ops-tier-k">{t.tier} · {t.when}</span><strong className="small">{t.who}</strong><span className="xs muted">{t.what}</span></div>
            ))}
          </div>
          {offNow ? <div className="small"><Pill tone="dark" icon="clock">기준일 {shortDate(d.today)} 휴무 · 당번 체계 운영 중</Pill> <span className="muted">당번 {blocks[0].duties[0].role} ({nameOf(blocks[0].duties[0].roleId)}) · 백업 {blocks[0].duties[0].backup}</span></div> : null}
          <DataTable rows={blocks.slice(0, 7)} columns={blockCols} rowKey={(b) => b.start} />
          <div className="row" style={{ gap: 8 }}>
            <span className="xs muted">9주 당번 일수:</span>
            {load.map((l) => <Pill key={l.roleId} tone="outline">{l.role} {l.days}일</Pill>)}
          </div>
          <div className="xs muted">{HOLIDAY_PRECHECK}. 당번 권한 계정 = 당번 AE가 실명 권한을 가진 광고 계정 수 (TEST DATA 권한 목록 기준).</div>
        </Card>

        <Card title="커뮤니케이션 · 의사결정 체계" sub="창구는 메인 PM 한 명으로 모으고, 결정 유형마다 결정자와 소요 시간을 미리 정합니다" actions={<Src kind="PROPOSAL" page="p.53" />}>
          <div className="ops-org" aria-label="커뮤니케이션 구조">
            <div className="ops-org-node"><strong>{COMM_STRUCTURE.client}</strong></div>
            <div className="ops-org-arrow">↕</div>
            <div className="ops-org-node single"><strong>{COMM_STRUCTURE.single}</strong><div className="xs">{COMM_STRUCTURE.singleNote} · {nameOf('pm')}</div></div>
            <div className="ops-org-arrow">↕</div>
            <div className="ops-org-row">{COMM_STRUCTURE.experts.map((e) => <div key={e} className="ops-org-node">{e}</div>)}</div>
          </div>
          <div className="table-wrap">
            <table className="tbl">
              <thead><tr><th>결정 유형</th><th>결정자</th><th>소요</th><th className="r">현재 승인 대기</th></tr></thead>
              <tbody>
                {decisions.map((x) => (
                  <tr key={x.type}>
                    <td className="small"><strong>{x.type}</strong></td>
                    <td className="small">{x.decider}</td>
                    <td className="small">{x.lead}</td>
                    <td className="r">{x.pending === null ? <span className="xs muted">월간 리뷰 안건</span> : <a href="#flow" className="num">{x.pending}건</a>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="row" style={{ gap: 6 }}>
            {COMM_STRUCTURE.channels.map((c) => <Pill key={c} tone="neutral">{c}</Pill>)}
            <span className="xs muted">승인 대기는 MILDO Flow의 요청 · 승인 이력(state.changes) 기준 · 승인 범위 내 = 담당 AE, 예산 · 구조 = 수면밀도, 알림 기준 = PM 승인 건</span>
          </div>
        </Card>
      </div>

      <Card title="계정 · 결제 · 권한 구조" sub="계정과 데이터의 소유권은 수면밀도에 두고, 프로그레스미디어는 위임받은 범위 안에서 운영합니다 — 표 기준으로 현재 계정을 점검"
        actions={<><Src kind="PROPOSAL" page="p.50" /><Src kind="DEMO" /><a className="btn sm" href="#alert">Alert 계정 점검</a></>}>
        <DataTable rows={own.rows} columns={ownCols} rowKey={(r) => r.item} />
        <div className="row" style={{ gap: 8 }}>
          <Pill tone={own.summary.ownerOk === own.summary.accounts ? 'good' : 'critical'} icon={own.summary.ownerOk === own.summary.accounts ? 'check' : 'x'}>수면밀도 소유 {own.summary.ownerOk}/{own.summary.accounts}</Pill>
          <Pill tone={own.summary.nonRealName ? 'critical' : 'good'} icon={own.summary.nonRealName ? 'x' : 'check'}>비실명 권한 {own.summary.nonRealName}건 · 기준 0</Pill>
          <Pill tone={own.summary.paymentRisk ? 'critical' : 'good'} icon={own.summary.paymentRisk ? 'x' : 'check'}>결제 위험 {own.summary.paymentRisk}개 · 기준 잔액 1일치 이상</Pill>
          <Pill tone={own.summary.review ? 'warning' : 'good'} icon={own.summary.review ? 'alert' : 'check'}>검수 · 제재 {own.summary.review}개</Pill>
        </div>
        <DataTable rows={own.checks} columns={accCols} rowKey={(a) => a.id} initialSort={{ key: 'run', dir: 'asc' }} />
        <div className="xs muted">잔액 일수 = 잔액 ÷ 일 평균 소진 (TEST DATA). 1일치 미만은 p.44 계정 · 결제 P1 기준, 3일치 미만 주의는 운영 가정입니다. 인수 첫 주 '계정 · 권한 · 결제 인수'(p.54 W1–W3)의 점검 목록으로 그대로 사용합니다.</div>
      </Card>
    </div>
  );
}
