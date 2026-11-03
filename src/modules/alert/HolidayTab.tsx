import { useMemo, useState } from 'react';
import { fmt } from '@/core/util';
import { Callout, Card, CopyButton, DataTable, Pill, Segmented, Sev, Src, Toggle, type Column } from '@/ui/primitives';
import { fmtDateShort, fmtStamp, holidayPrecheck, nextBusinessDay, offBlocks, rotationTable, type DutyRow, type OffBlock, type PrecheckItem } from './engine';
import { PRECHECK_GROUPS, ROLE_ACCOUNT_USER, WEEKEND_TIERS } from './data';
import { LevelPill } from './parts';
import type { AlertCtx } from './hooks';

export function HolidayTab({ ctx, onOpen }: { ctx: AlertCtx; onOpen: (id: string) => void }) {
  const { data, state, dispatch, regime, nameOf, cfg, tfNames, incidents } = ctx;
  const blocks = useMemo(() => offBlocks(data.today, 120), [data.today]);
  const choices = useMemo(() => {
    const out: { id: string; label: string; block: OffBlock }[] = [];
    if (blocks[0]) out.push({ id: 'cur', label: data.today >= blocks[0].start ? '이번 주말 (진행 중)' : `${fmtDateShort(blocks[0].start)} 휴무`, block: blocks[0] });
    if (blocks[1]) out.push({ id: 'next', label: `다음 주말 ${fmtDateShort(blocks[1].start)}`, block: blocks[1] });
    for (const b of blocks.filter((x) => x.days >= 3).slice(0, 3)) out.push({ id: b.start, label: `${b.labels.find((l) => l !== '토요일' && l !== '일요일')?.replace(/ 연휴|\(.*\)/g, '') ?? '연휴'} ${b.days}일 (${fmtDateShort(b.start)})`, block: b });
    return out;
  }, [blocks, data.today]);
  const [pick, setPick] = useState<string>(choices[0]?.id ?? 'cur');
  const chosen = choices.find((c) => c.id === pick) ?? choices[0];
  const check = useMemo(() => (chosen ? holidayPrecheck(data, chosen.block, { config: cfg, tfNames }) : null), [data, chosen, cfg, tfNames]);
  const rotation = useMemo(() => rotationTable(data.today, 63), [data.today]);
  const longStarts = new Set(blocks.filter((b) => b.days >= 3).flatMap((b) => b.dates));
  const briefingDay = nextBusinessDay(data.today);
  const pendingBriefing = incidents.filter((i) => i.status !== 'resolved' && i.severity !== 'P1');
  const count = (l: PrecheckItem['level']) => check?.items.filter((i) => i.level === l).length ?? 0;

  const rotCols: Column<DutyRow>[] = [
    { key: 'd', label: '날짜', render: (r) => <span className="num">{fmtDateShort(r.date)}{r.date === data.today ? <Pill tone="dark">오늘</Pill> : null}</span> },
    { key: 'l', label: '구분', render: (r) => <span className="row" style={{ gap: 4 }}>{r.label}{longStarts.has(r.date) ? <Pill tone="warning">연휴</Pill> : null}</span> },
    { key: 'o', label: '2차 · 당번 AE (30분 내 확인)', render: (r) => <strong className="small">{nameOf(r.role)}</strong> },
    { key: 'b', label: '백업', render: (r) => <span className="small">{nameOf(r.backup)}</span> },
    { key: 'e', label: '3차 · 에스컬레이션', render: () => <span className="small">{nameOf('총괄 PM')} · P1 한정</span> },
    { key: 'p', label: '당번 권한 계정', align: 'right', render: (r) => { const n = data.accounts.filter((a) => a.permissions.some((p) => p.user === ROLE_ACCOUNT_USER[r.roleId] && p.realName)).length; return <span className="num">{n} / {data.accounts.length}</span>; } },
  ];
  const md = () => !check || !chosen ? '' : [
    `## 연휴 전날 사전 점검 · ${fmtDateShort(chosen.block.start)}~${fmtDateShort(chosen.block.end)} (${chosen.block.labels.join(' · ')})`,
    `점검 구간 ${fmtStamp(Date.parse(check.from))} → ${fmtStamp(Date.parse(check.to))} (${fmt.dec1(check.coverHours)}시간) · 실패 ${count('fail')} · 주의 ${count('warn')} · 통과 ${count('pass')} · TEST DATA 기준 시뮬레이션`,
    '',
    ...PRECHECK_GROUPS.flatMap((g) => [`### ${g}`, ...check.items.filter((i) => i.group === g).map((i) => `- [${i.level === 'pass' ? '통과' : i.level === 'warn' ? '주의' : '실패'}] ${i.item} — ${i.detail}${i.action !== '—' ? ` → ${i.action}` : ''}`), '']),
  ].join('\n');

  return (
    <div className="stack-lg">
      <Card title="주말 · 공휴일 대응 체계" sub="업무시간 밖에서도 감지는 멈추지 않고, 사람의 확인은 순번제로 보장합니다" actions={<Src kind="PROPOSAL" page="p.48" />}>
        <div className="alert-tiers">
          {WEEKEND_TIERS.map((t, k) => (
            <div key={t.tier} className={`alert-tier${regime.off && (k < 2 || incidents.some((i) => i.status !== 'resolved' && i.severity === 'P1')) ? ' active' : ''}`}>
              <span className="alert-tier-k">{t.tier}</span>
              <strong>{k === 1 && regime.duty ? `${t.who} · ${nameOf(regime.duty.role)}` : t.who}</strong>
              <span className="small ink2">{t.what}</span>
              <span className="row" style={{ gap: 6 }}><Pill tone="dark">{t.when}</Pill>{k === 2 ? <Sev level="P1" /> : null}</span>
            </div>
          ))}
        </div>
        <div className="row-between">
          <Callout tone="info" title={regime.off ? `${regime.forced ? '주말 모드 시뮬레이션' : `${fmtDateShort(data.today)} ${regime.label}`} — 주말 · 공휴일 체계 적용 중` : '평일 운영 체계'}>
            {regime.off
              ? `당번 ${nameOf(regime.duty?.role)} (백업 ${nameOf(regime.duty?.backup)}) · 전 등급 30분 내 확인 · P1은 PM 에스컬레이션 · 나머지는 다음 영업일 ${fmtDateShort(briefingDay)} 09:30 이슈 브리핑 (p.44).`
              : '담당 AE + 백업 · 등급별 SLA (p.49). 주말 모드를 켜면 당번 체계로 시뮬레이션합니다.'}
          </Callout>
          <Toggle id="alert-offhours" checked={state.offHoursMode} onChange={(v) => dispatch({ type: 'offhours/set', on: v })} label={isWeekendToday(regime) ? '주말 모드 강제 (오늘은 휴무일이라 자동 적용 중)' : '주말 모드 시뮬레이션'} />
        </div>
      </Card>

      <div className="grid g-3">
        <Card className="span-2" title="당번 순번표 · 9주" sub="주말은 토 · 일 같은 당번, 평일 공휴일은 일자 순번 · 매체 AE 4인 순환 (순번 방식은 운영 가정)" actions={<><Src kind="PROPOSAL" page="p.48" /><a className="btn sm" href="#ops">TF 성명 입력</a></>}>
          <DataTable rows={rotation} columns={rotCols} rowKey={(r) => r.date} maxHeight={420} />
          <div className="xs muted">당번 권한 계정 = 당번 AE가 실명 권한을 가진 광고 계정 수. 권한이 없는 계정의 P1은 백업 또는 PM이 1차 조치를 대행합니다.</div>
        </Card>
        <Card title={`다음 영업일 ${fmtDateShort(briefingDay)} 09:30 이슈 브리핑`} sub="야간 · 주말 포함 이슈 요약 (p.18 데이터 시간표 · p.44)" actions={<Src kind="DEMO" />}>
          {pendingBriefing.length ? (
            <div className="stack-sm">
              {pendingBriefing.slice(0, 10).map((i) => (
                <a key={i.id} href="#alert" className="row small" style={{ gap: 6, flexWrap: 'nowrap', textDecoration: 'none', color: 'inherit' }} onClick={(e) => { e.preventDefault(); onOpen(i.id); }}>
                  <Sev level={i.severity} /><span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{i.title}</span>
                </a>
              ))}
              {pendingBriefing.length > 10 ? <span className="xs muted">외 {pendingBriefing.length - 10}건</span> : null}
            </div>
          ) : <div className="small muted">브리핑 대상 없음</div>}
          <div className="xs muted">P1은 브리핑을 기다리지 않고 PM 에스컬레이션으로 즉시 처리.</div>
        </Card>
      </div>

      <Card title="연휴 전날 사전 점검 · 예산 · 소재 · 결제 잔액" sub="현재 데이터로 실제 점검 결과를 계산합니다. 점검 구간 = 연휴 전날 17:00 → 다음 영업일 09:30 (진행 중이면 현재 시각부터)." actions={<><Src kind="PROPOSAL" page="p.48" /><Src kind="DEMO" /><CopyButton text={md} label="점검표 복사" /></>}>
        <div className="row-between">
          <Segmented label="점검 대상 휴무 구간" value={pick} onChange={setPick} options={choices.map((c) => ({ id: c.id, label: c.label }))} />
          {check && chosen ? (
            <span className="row small" style={{ gap: 8 }}>
              <span className="num">{fmtStamp(Date.parse(check.from))} → {fmtStamp(Date.parse(check.to))} · {fmt.dec1(check.coverHours)}시간</span>
              <LevelPill level="fail" label={`실패 ${count('fail')}`} /><LevelPill level="warn" label={`주의 ${count('warn')}`} /><LevelPill level="pass" label={`통과 ${count('pass')}`} />
            </span>
          ) : null}
        </div>
        {chosen && chosen.block.start > data.today ? <Callout tone="info">미래 구간은 현재(데이터 기준 {fmtDateShort(data.today)}) 잔액 · 소재 상태로 시뮬레이션합니다. 실제 점검은 {fmtDateShort(chosen.block.prevBusinessDay)} 17:00 데이터로 다시 실행합니다.</Callout> : null}
        {check ? (
          <div className="alert-precheck">
            {PRECHECK_GROUPS.map((g) => {
              const items = check.items.filter((i) => i.group === g);
              return (
                <div key={g} className="stack-sm">
                  <div className="row-between"><strong>{g}</strong><span className="xs muted">{items.length}항목</span></div>
                  {items.map((i, k) => (
                    <div key={k} className="row small" style={{ gap: 8, flexWrap: 'nowrap', alignItems: 'flex-start', borderTop: '1px solid var(--line)', paddingTop: 6 }}>
                      <LevelPill level={i.level} />
                      <div className="stack-sm" style={{ gap: 1, minWidth: 0 }}>
                        <strong className="small">{i.item}{i.fixture ? <> <Src kind="DEMO" fixture title="시연용 예시 소재 · 매체 소재 검수 연동 전 (실제 소재 아님)" /></> : null}</strong>
                        <span className="xs ink2">{i.detail}</span>
                        {i.action !== '—' ? <span className="xs muted">조치: {i.action}</span> : null}
                      </div>
                    </div>
                  ))}
                </div>
              );
            })}
          </div>
        ) : null}
      </Card>
    </div>
  );
}

function isWeekendToday(regime: AlertCtx['regime']) {
  return regime.off && !regime.forced;
}
