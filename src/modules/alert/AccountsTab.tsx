import { useMemo, useState } from 'react';
import { MEDIA_IDS, OWNERSHIP } from '@/data/constants';
import { fmt, sum } from '@/core/util';
import { Button, Card, DataTable, Pill, ProgressBar, Src, Stat, type Column } from '@/ui/primitives';
import { checkAccounts, dayDiff, fmtStamp, type AccountCheck } from './engine';
import { LevelPill, MediaTag } from './parts';
import type { AlertCtx } from './hooks';

export function AccountsTab({ ctx, onOpen }: { ctx: AlertCtx; onOpen: (id: string) => void }) {
  const { data, cfg, state, actions, incidents } = ctx;
  const checks = useMemo(() => checkAccounts(data, cfg), [data, cfg]);
  const [sel, setSel] = useState<string>(() => checks.find((c) => c.worst === 'fail')?.account.id ?? checks[0]?.account.id ?? '');
  const cur = checks.find((c) => c.account.id === sel);
  const prepaid = checks.filter((c) => c.prepaid);
  const minRun = prepaid.filter((c) => Number.isFinite(c.runwayDays)).sort((a, b) => a.runwayDays - b.runwayDays)[0];
  const exists = (tid: string) => state.changes.some((c) => c.targetId === tid && c.status !== 'rejected');

  const cols: Column<AccountCheck>[] = [
    { key: 'n', label: '계정', render: (c) => <div><strong className="small">{c.account.name}</strong><div><MediaTag media={c.account.media} /></div></div> },
    { key: 'o', label: '소유', render: (c) => (c.account.owner === '수면밀도' ? <Pill tone="good" icon="check">수면밀도</Pill> : <Pill tone="warning">{c.account.owner}</Pill>) },
    { key: 'pay', label: '결제', render: (c) => <span className="xs">{c.account.paymentMethod}</span> },
    { key: 'b', label: '잔액', align: 'right', render: (c) => <span className="num">{c.prepaid ? `${fmt.krw(c.account.balance)}원` : '후불'}</span>, sort: (c) => (c.prepaid ? c.account.balance : -1) },
    { key: 'a', label: '일 평균 소진', align: 'right', render: (c) => <span className="num">{fmt.krw(c.account.avgDailySpend)}원</span>, sort: (c) => c.account.avgDailySpend },
    {
      key: 'r', label: `소진 예상 (기준 1일 · 권장 ${cfg.runwayWarnDays}일)`, sort: (c) => (Number.isFinite(c.runwayDays) ? c.runwayDays : 1e9),
      render: (c) => c.prepaid ? (
        <div style={{ minWidth: 150 }}>
          <div className="row-between xs"><strong className="num">{Number.isFinite(c.runwayDays) ? `${fmt.dec1(c.runwayDays)}일` : '—'}</strong><span className="muted num">{c.exhaustAtMs ? fmtStamp(c.exhaustAtMs) : ''}</span></div>
          <ProgressBar value={Math.min(c.runwayDays, 7)} max={7} marker={cfg.runwayWarnDays} tone={c.runwayDays < 1 ? 'critical' : c.runwayDays < cfg.runwayWarnDays ? 'warning' : 'good'} label="잔액 소진 예상 일수" />
        </div>
      ) : <span className="xs muted">후불 · 한도 확인</span>,
    },
    { key: 'ac', label: '자동충전', render: (c) => <Pill tone={c.account.autoCharge === 'failed' ? 'critical' : c.account.autoCharge === 'ok' ? 'good' : 'neutral'} icon={c.account.autoCharge === 'failed' ? 'alert' : undefined}>{{ ok: '정상', failed: '실패', off: '수동', postpaid: '후불' }[c.account.autoCharge]}</Pill> },
    { key: 'p', label: '권한', render: (c) => <span className="xs">실명 {c.account.permissions.filter((p) => p.realName).length}{c.nonRealName ? <strong style={{ color: 'var(--critical-ink)' }}> · 비실명 {c.nonRealName}</strong> : null}{c.stale ? ` · 미접속 ${c.stale}` : ''}</span> },
    { key: 's', label: '상태', render: (c) => <Pill tone={c.account.status === 'active' ? 'neutral' : c.account.status === 'review' ? 'warning' : 'critical'}>{{ active: '정상', review: '검수 · 확인', restricted: '제재' }[c.account.status]}</Pill> },
    {
      key: 'w', label: '점검 결과 · 근거', render: (c) => {
        const hit = c.findings.filter((f) => f.level === c.worst && c.worst !== 'ok');
        return (
          <div className="stack-sm" style={{ gap: 2 }}>
            <LevelPill level={c.worst === 'fail' ? 'fail' : c.worst === 'warn' ? 'warn' : c.worst === 'info' ? 'info' : 'pass'} label={c.worst === 'fail' ? `실패 ${hit.length}` : c.worst === 'warn' ? '주의' : c.worst === 'info' ? '확인 필요' : '정상'} />
            <span className="xs muted">{hit.length ? Array.from(new Set(hit.map((f) => f.label))).join(' · ') : '소유 · 잔액 · 충전 · 권한 · 상태 통과'}</span>
          </div>
        );
      },
    },
  ];

  return (
    <div className="stack-lg">
      <div className="grid g-5">
        <Card><Stat label="광고 계정" src={<Src kind="DEMO" />} value={checks.length} foot={<span>매체 계정 {checks.filter((c) => (MEDIA_IDS as string[]).includes(c.account.media)).length} · 판매 채널 광고 {checks.filter((c) => !(MEDIA_IDS as string[]).includes(c.account.media)).length}</span>} /></Card>
        <Card><Stat label="점검 실패 · 주의" src={<Src kind="DEMO" />} value={<span>{checks.filter((c) => c.worst === 'fail').length}<span className="small muted"> / 주의 {checks.filter((c) => c.worst === 'warn').length}</span></span>} foot={<span>잔액 1일치 · 자동충전 · 권한 · 상태 (p.44)</span>} /></Card>
        <Card><Stat label="선결제 잔액 합계" src={<Src kind="DEMO" />} value={`${fmt.krw(sum(prepaid, (c) => c.account.balance))}원`} foot={<span>선결제 {prepaid.length}개 계정</span>} /></Card>
        <Card><Stat label="최단 소진 예상" src={<Src kind="DEMO" />} value={minRun ? `${fmt.dec1(minRun.runwayDays)}일` : '—'} foot={<span>{minRun ? `${minRun.account.name.replace(/ \(수면밀도\)/, '')} · ${minRun.exhaustAtMs ? fmtStamp(minRun.exhaustAtMs) : ''}` : ''}</span>} /></Card>
        <Card><Stat label="비실명 · 미사용 권한" src={<Src kind="DEMO" />} value={sum(checks, (c) => c.nonRealName + c.stale)} foot={<span>실명 · 최소 권한 원칙 (p.50)</span>} /></Card>
      </div>

      <Card title="계정 · 결제 · 권한 점검" sub="계정별 소유 · 잔액 · 일 평균 소진 · 잔액 소진 예상 일수(runway) · 자동충전 · 권한 · 상태. 소진 예상 시각은 매체 시간대 소진 곡선으로 계산합니다." actions={<><Src kind="PROPOSAL" page="p.50 · p.44" /><Src kind="DEMO" /></>}>
        <DataTable rows={checks} columns={cols} rowKey={(c) => c.account.id} onRowClick={(c) => setSel(c.account.id)} selectedKey={sel} />
      </Card>

      {cur ? (
        <div className="grid g-2">
          <Card title={`${cur.account.name} · 점검 상세`} sub={`${cur.account.paymentMethod} · 상태 ${cur.account.status}`} actions={<Src kind="DEMO" />}>
            <div className="stack-sm">
              {cur.findings.map((f, k) => (
                <div key={k} className="row small" style={{ gap: 8, flexWrap: 'nowrap', alignItems: 'flex-start' }}>
                  <LevelPill level={f.level === 'fail' ? 'fail' : f.level === 'warn' ? 'warn' : f.level === 'info' ? 'info' : 'pass'} />
                  <span><strong>{f.label}</strong> <span className="ink2">{f.detail}</span></span>
                </div>
              ))}
            </div>
            <div className="row">
              {cur.prepaid && (cur.runwayDays < cfg.runwayWarnDays || cur.account.autoCharge === 'failed') ? (() => {
                const topup = Math.max(0, Math.ceil((cur.account.avgDailySpend * cfg.runwayWarnDays - cur.account.balance) / 100000) * 100000);
                const tid = `alert:account:${cur.account.id}:topup`;
                return (
                  <Button size="sm" variant="primary" icon="wallet" disabled={exists(tid) || topup <= 0}
                    onClick={() => { actions.addChange({ module: 'alert', kind: 'setting', target: `${cur.account.name} 충전`, targetId: tid, before: cur.account.balance, after: cur.account.balance + topup, changePct: cur.account.balance > 0 ? (topup / cur.account.balance) * 100 : undefined, reason: `잔액 ${fmt.dec1(cur.runwayDays)}일치 → ${cfg.runwayWarnDays}일치 확보 (${fmt.krw(topup)}원) · 결제 수단 수면밀도 (p.50)`, requestedBy: state.role, approver: 'CLIENT' }); actions.toast({ tone: 'info', title: '충전 요청을 만들었습니다', body: '승인: 수면밀도 · MILDO Flow', route: 'flow' }); }}>
                    {exists(tid) ? '충전 요청됨' : `충전 요청 ${fmt.krw(topup)}원 (수면밀도 승인)`}
                  </Button>
                );
              })() : null}
              {cur.nonRealName || cur.stale ? (() => {
                const tid = `alert:account:${cur.account.id}:revoke`;
                return (
                  <Button size="sm" icon="shield" disabled={exists(tid)}
                    onClick={() => { actions.addChange({ module: 'alert', kind: 'setting', target: `${cur.account.name} 권한 회수`, targetId: tid, before: cur.account.permissions.filter((p) => !p.realName || dayDiff(data.today, p.lastLogin) > cfg.staleLoginDays).map((p) => `${p.user}(${p.role})`).join(', '), after: '회수 · 실명 계정 대체', reason: '담당자 실명 계정 · 최소 권한 · 교체 시 즉시 회수 (p.50)', requestedBy: state.role, approver: 'PM' }); actions.toast({ tone: 'info', title: '권한 회수 요청을 만들었습니다', body: 'PM → 수면밀도 통보', route: 'flow' }); }}>
                    {exists(tid) ? '회수 요청됨' : '권한 회수 요청 (PM → 수면밀도 통보)'}
                  </Button>
                );
              })() : null}
              {incidents.filter((i) => i.target === cur.account.name && i.status !== 'resolved').map((i) => (
                <Button key={i.id} size="sm" onClick={() => onOpen(i.id)}>{i.severity} 이슈 열기</Button>
              ))}
            </div>
          </Card>
          <Card title="권한 목록" sub="실명 여부 · 마지막 로그인 · 미접속 일수 (기준일 대비)" actions={<Src kind="DEMO" />}>
            <div className="table-wrap">
              <table className="tbl">
                <thead><tr><th>사용자</th><th>권한</th><th className="c">실명</th><th className="r">마지막 로그인</th><th className="r">미접속</th></tr></thead>
                <tbody>
                  {cur.account.permissions.map((p) => {
                    const d = dayDiff(data.today, p.lastLogin);
                    return (
                      <tr key={p.user}>
                        <td><strong className="small">{p.user}</strong></td><td className="small">{p.role}</td>
                        <td className="c">{p.realName ? <LevelPill level="pass" label="실명" /> : <LevelPill level="fail" label="비실명" />}</td>
                        <td className="r num small">{p.lastLogin}</td>
                        <td className="r num small">{d}일{d > cfg.staleLoginDays ? <Pill tone="warning">{cfg.staleLoginDays}일 초과</Pill> : null}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </Card>
        </div>
      ) : null}

      <Card title="계정 · 결제 · 권한 구조" sub="계정과 데이터의 소유권은 수면밀도에 두고, 프로그레스미디어는 위임받은 범위 안에서 운영합니다" actions={<Src kind="PROPOSAL" page="p.50" />}>
        <div className="table-wrap">
          <table className="tbl">
            <thead><tr><th>항목</th><th>소유 · 주체</th><th>프로그레스미디어 역할</th><th>변경 승인</th></tr></thead>
            <tbody>{OWNERSHIP.map((o) => <tr key={o.item}><td><strong>{o.item}</strong></td><td>{o.owner}</td><td>{o.role}</td><td>{o.approval}</td></tr>)}</tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}
