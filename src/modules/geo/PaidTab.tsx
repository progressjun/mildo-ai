/* 페이드 AI 지면 — 네이버 AI 요약 · 쇼핑 지면 노출 점검 → SA 키워드 반영 (테스트 그룹 등록 요청 = ChangeRequest pending) */
import { useMemo, useState } from 'react';
import { useActions, useStore } from '@/core/store';
import { AD_PILOT, KEYWORD_TEST_RULES } from '@/data/constants';
import { fmt } from '@/core/util';
import { Button, Card, DataTable, Empty, Pill, ProgressBar, Src, Stat, type Column } from '@/ui/primitives';
import { BRAND, dateLabel, findRegistration, paidSummary, REGISTRATION_ORIGIN, registrationRequest, type PaidRow, type Visibility } from './engine';
import { IntentPill, VerdictBadge } from './parts';

export function PaidTab({ rows, vis }: { rows: PaidRow[]; vis: Visibility }) {
  const { state } = useStore();
  const actions = useActions();
  const [sel, setSel] = useState<string | null>(() => rows.find((r) => r.action.id === 'register')?.query.id ?? rows[0]?.query.id ?? null);
  const s = useMemo(() => paidSummary(rows), [rows]);
  // AD Pilot · MILDO Lab에서 같은 검색어를 이미 올렸으면 중복 요청하지 않는다
  const requested = (term: string) => findRegistration(state.changes, term);
  const selected = rows.find((r) => r.query.id === sel) ?? null;
  const STATUS_TXT: Record<string, string> = { pending: '승인 대기', approved: '승인됨', applied: '반영됨', held: '보류' };
  const reqLabel = (term: string) => {
    const ex = requested(term);
    if (!ex) return null;
    const origin = ex.module === 'geo' ? '' : ` · ${REGISTRATION_ORIGIN[ex.module] ?? ex.module}에서 요청`;
    return `${STATUS_TXT[ex.status] ?? ex.status}${origin}`;
  };

  const request = (r: PaidRow) => {
    if (!r.term || requested(r.term.term)) return;
    const payload = registrationRequest(r, state.role);
    if (!payload) return;
    actions.addChange(payload);
    actions.toast({ tone: 'good', title: `'${r.term.term}' SA 테스트 그룹 등록 요청`, body: `승인 대기 · ${payload.approver === 'PM' ? 'PM 승인 (브랜드 검색어)' : '담당 AE 승인 범위'} · MILDO Flow에서 확인`, route: 'flow' });
  };

  const columns: Column<PaidRow>[] = [
    {
      key: 'q', label: '질의', sort: (r) => r.query.id,
      render: (r) => <div className="stack-sm" style={{ gap: 2 }}><span className="geo-qtext">{r.query.text}</span><IntentPill intent={r.query.intent} /></div>,
    },
    {
      key: 'ai', label: '네이버 AI 브리핑', sort: (r) => (r.naverAi?.mentioned ? 1 : 0),
      render: (r) => r.naverAi ? (
        <span className="geo-badge">
          <Pill tone={r.naverAi.mentioned ? 'good' : 'warning'} icon={r.naverAi.mentioned ? 'check' : 'alert'}>{r.naverAi.mentioned ? `${BRAND} ${r.naverAi.position}번째` : '미언급'}</Pill>
          <span className="geo-basis">경쟁사 {r.naverAi.competitors.length}개{r.naverAi.competitors[0] ? ` · ${r.naverAi.competitors.slice(0, 2).join(', ')}` : ''}</span>
        </span>
      ) : <span className="muted xs">—</span>,
    },
    {
      key: 'shop', label: '쇼핑 지면', sort: (r) => r.shopping.rank ?? 99,
      render: (r) => r.shopping.exposed ? (
        <span className="geo-badge"><Pill tone={r.shopping.rank === 1 ? 'good' : 'neutral'}>{r.shopping.rank}위</Pill>{r.shopping.competitorsAbove.length ? <span className="geo-basis">위: {r.shopping.competitorsAbove.join(', ')}</span> : null}</span>
      ) : <Pill tone="warning" icon="alert">미노출</Pill>,
    },
    {
      key: 'kw', label: 'SA 키워드 · 14일', sort: (r) => r.kw?.roasRatio ?? -1,
      render: (r) => r.kw ? (
        <div className="stack-sm" style={{ gap: 1 }}>
          <span className="small"><strong>{r.kw.text}</strong> <span className="muted">· {r.kw.status === 'test' ? '테스트' : 'ON'} · {fmt.dec1(r.kw.avgRank)}위</span></span>
          <span className="geo-basis">ROAS {fmt.roas(r.kw.roas)} · 목표 {fmt.roas(r.kw.targetRoas)} 대비 {fmt.pct(r.kw.roasRatio * 100, 0)} · 손실 {fmt.pct(r.kw.lost * 100, 0)}</span>
        </div>
      ) : <span className="muted xs">연결 키워드 없음</span>,
    },
    {
      key: 'term', label: '검색어 보고서', sort: (r) => r.term?.conversions ?? -1,
      render: (r) => r.term ? (
        <div className="stack-sm" style={{ gap: 1 }}>
          <span className="small">{r.term.term} <Pill tone={r.term.registered ? 'neutral' : 'accent'}>{r.term.registered ? '등록' : '미등록'}</Pill></span>
          <span className="geo-basis">클릭 {fmt.int(r.term.clicks)} · 전환 {fmt.dec1(r.term.conversions)} · ROAS {fmt.roas(r.term.roas)}</span>
        </div>
      ) : <span className="muted xs">—</span>,
    },
    { key: 'action', label: '판정 · 근거', sort: (r) => r.action.id, render: (r) => <VerdictBadge v={r.action} /> },
    {
      key: 'req', label: 'SA 반영',
      render: (r) => {
        if (!r.requestable || !r.term) return <span className="muted xs">—</span>;
        const lbl = reqLabel(r.term.term);
        return lbl ? <Pill tone="neutral" icon="clock">{lbl}</Pill>
          : <Button size="sm" variant="primary" icon="send" onClick={() => request(r)}>등록 요청</Button>;
      },
    },
  ];

  if (!rows.length) return <Card><Empty icon="search" title="점검할 질의가 없습니다" /></Card>;

  return (
    <div className="stack-lg">
      <Card title="페이드 AI 지면 → SA 키워드 반영" sub={`${dateLabel(vis.date)} 점검 · AI 브리핑 · 쇼핑 지면은 데모 스냅샷, SA 키워드 · 검색어 보고서는 운영 데이터 (모두 TEST DATA)`} actions={<><Src kind="DEMO" /><Src kind="PROPOSAL" page="p.29 · p.14" /></>}>
        <div className="grid g-6">
          <Stat label="SA 테스트 그룹 등록 후보" value={s.register} foot={<span className="muted">미등록 검색어 · 전환 발생</span>} />
          <Stat label="랜딩 점검" value={s.landing} foot={<span className="muted">품절 옵션 키워드</span>} />
          <Stat label="자동 조정 보류" value={s.hold} foot={<span className="muted">최근 3일 CPC · 전환 ±{AD_PILOT.anomalyHoldPct}%</span>} />
          <Stat label="SA 노출 유지 · 방어" value={s.defend} foot={<span className="muted">AI 미언급 · ROAS ≥ 목표</span>} />
          <Stat label="AI 브리핑 미언급" value={`${s.aiMiss}/${s.total}`} foot={<span className="muted">네이버 AI 브리핑</span>} />
          <Stat label="쇼핑 지면 미노출" value={`${s.shopMiss}/${s.total}`} foot={<span className="muted">네이버 쇼핑 블록</span>} />
        </div>
      </Card>

      {/* 7열 표가 옆 패널과 나란히 있으면 'SA 반영' 열이 가려진다 — 표는 전체 폭, 판정 상세는 아래 */}
      <div className="grid g-3 geo-split">
        <Card className="span-2" title="질의별 점검 · 판정" sub={`판정 순서: 품절 랜딩 → 미등록 전환 검색어 → 성과 급변(최근 3일 CPC · 전환 ±${AD_PILOT.anomalyHoldPct}%, 표본 기준 충족 시) → AI 미언급 & ROAS ≥ 목표 → AI 언급 & ROAS < 목표 ${KEYWORD_TEST_RULES.keepFromPct}% → 오가닉 · 쇼핑 모두 미노출`}
          actions={<Src kind="DEMO" />}>
          <DataTable rows={rows} columns={columns} rowKey={(r) => r.query.id} onRowClick={(r) => setSel(r.query.id)} selectedKey={sel} maxHeight={620} />
        </Card>
        <Card className="geo-paid-detail" title={selected ? `'${selected.query.text}'` : '질의 선택'} sub="판정 상세 · 신호 근거" actions={<Src kind="DEMO" />}>
          {selected ? (
            <div className="stack">
              <VerdictBadge v={selected.action} />
              <div className="small ink2">{selected.action.detail}</div>
              {selected.signals.length ? (
                <div className="stack-sm">
                  {selected.signals.map((g) => (
                    <div key={g.id} className="geo-badge">
                      <Pill tone={g.tone as 'warning'} icon={g.tone === 'accent' ? 'zap' : 'alert'}>{g.label}</Pill>
                      <span className="geo-basis">{g.basis}</span>
                    </div>
                  ))}
                </div>
              ) : <span className="small muted">신호 없음</span>}
              {selected.causes.length ? (
                <div className="stack-sm">
                  <span className="small"><strong>원인 후보</strong> <span className="muted">· 근거 강도 순 (상대 점수 · 확률 아님)</span></span>
                  {selected.causes.map((c) => (
                    <div key={c.label} className="geo-cause">
                      <span className="small"><strong>{c.label}</strong></span>
                      <ProgressBar value={c.score} tone={c.score >= 60 ? 'warning' : 'ink'} label={`${c.label} 근거 강도`} />
                      <span className="num small">{c.score}</span>
                      <span className="geo-basis" style={{ gridColumn: '1 / -1' }}>{c.basis}</span>
                    </div>
                  ))}
                </div>
              ) : null}
              <div className="row" style={{ gap: 6 }}>
                {selected.requestable && selected.term ? (
                  reqLabel(selected.term.term) ? <Pill tone="neutral" icon="clock">{reqLabel(selected.term.term)} · MILDO Flow에서 승인</Pill>
                    : <Button size="sm" variant="primary" icon="send" onClick={() => request(selected)}>SA 테스트 그룹 등록 요청</Button>
                ) : null}
                <a className="btn sm" href="#adpilot">AD Pilot 열기</a>
                <a className="btn sm" href="#lab">MILDO Lab 열기</a>
              </div>
              <div className="xs muted">등록 요청은 승인 범위 내 운영 조정(담당 AE, p.53)으로 승인 대기에 올라가며, 브랜드 검색어 편입은 PM이 승인합니다(AD Pilot 기준과 같음). 반영은 사람이 승인하고, 테스트 판정은 MILDO Lab 기준(14일 또는 최소 클릭)을 따릅니다. AD Pilot · MILDO Lab에서 이미 올린 검색어는 다시 요청하지 않습니다.</div>
            </div>
          ) : <Empty icon="search" title="질의를 선택하세요" />}
        </Card>
      </div>
    </div>
  );
}
