/* 페이드 AI 지면 — 네이버 AI 요약 · 쇼핑 지면 노출 점검 → SA 키워드 반영 (테스트 그룹 등록 요청 = ChangeRequest pending) */
import { useMemo, useState } from 'react';
import type { ChangeRequest } from '@/core/types';
import { useActions, useStore } from '@/core/store';
import { AD_PILOT } from '@/data/constants';
import { fmt, fmtDate } from '@/core/util';
import { Button, Card, DataTable, Empty, Pill, Src, Stat, type Column } from '@/ui/primitives';
import { BRAND, paidSummary, type PaidRow, type Visibility } from './engine';
import { IntentPill, VerdictBadge } from './parts';

export function PaidTab({ rows, vis }: { rows: PaidRow[]; vis: Visibility }) {
  const { state } = useStore();
  const actions = useActions();
  const [sel, setSel] = useState<string | null>(() => rows.find((r) => r.action.id === 'register')?.query.id ?? rows[0]?.query.id ?? null);
  const s = useMemo(() => paidSummary(rows), [rows]);
  const requested = (term: string): ChangeRequest | undefined =>
    state.changes.find((c) => c.module === 'geo' && c.kind === 'keyword_add' && c.target === term && c.status !== 'rejected' && c.status !== 'rolled_back');
  const selected = rows.find((r) => r.query.id === sel) ?? null;

  const request = (r: PaidRow) => {
    if (!r.requestable || !r.term || requested(r.term.term)) return;
    actions.addChange({
      module: 'geo', kind: 'keyword_add', target: r.term.term, before: '미등록 (검색어 보고서)', after: '테스트 그룹 등록 · 입찰 상한 적용',
      reason: `GEO 질의 '${r.query.text}' · ${r.action.basis} · 네이버 AI 브리핑 ${r.naverAi?.mentioned ? '언급' : '미언급'} (TEST DATA)`,
      requestedBy: state.role, approver: 'AE',
    });
    actions.toast({ tone: 'good', title: `'${r.term.term}' SA 테스트 그룹 등록 요청`, body: '승인 대기 · 담당 AE 승인 범위 (MILDO Flow에서 확인)', route: 'flow' });
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
        const ex = requested(r.term.term);
        return ex ? <Pill tone="neutral" icon="clock">{ex.status === 'pending' ? '승인 대기' : ex.status === 'approved' ? '승인됨' : ex.status === 'applied' ? '반영됨' : ex.status}</Pill>
          : <Button size="sm" variant="primary" icon="send" onClick={() => request(r)}>등록 요청</Button>;
      },
    },
  ];

  if (!rows.length) return <Card><Empty icon="search" title="점검할 질의가 없습니다" /></Card>;

  return (
    <div className="stack-lg">
      <Card title="페이드 AI 지면 → SA 키워드 반영" sub={`${fmtDate(vis.date ?? '')} 점검 · AI 브리핑 · 쇼핑 지면은 데모 스냅샷, SA 키워드 · 검색어 보고서는 운영 데이터 (모두 TEST DATA)`} actions={<><Src kind="DEMO" /><Src kind="PROPOSAL" page="p.29 · p.14" /></>}>
        <div className="grid g-6">
          <Stat label="SA 테스트 그룹 등록 후보" value={s.register} foot={<span className="muted">미등록 검색어 · 전환 발생</span>} />
          <Stat label="랜딩 점검" value={s.landing} foot={<span className="muted">품절 옵션 키워드</span>} />
          <Stat label="자동 조정 보류" value={s.hold} foot={<span className="muted">CPC ±{AD_PILOT.anomalyHoldPct}% 급변</span>} />
          <Stat label="SA 노출 유지 · 방어" value={s.defend} foot={<span className="muted">AI 미언급 · ROAS ≥ 목표</span>} />
          <Stat label="AI 브리핑 미언급" value={`${s.aiMiss}/${s.total}`} foot={<span className="muted">네이버 AI 브리핑</span>} />
          <Stat label="쇼핑 지면 미노출" value={`${s.shopMiss}/${s.total}`} foot={<span className="muted">네이버 쇼핑 블록</span>} />
        </div>
      </Card>

      <div className="grid g-3">
        <Card className="span-2" title="질의별 점검 · 판정" sub={`판정 순서: 품절 랜딩 → 미등록 전환 검색어 → CPC 급변(±${AD_PILOT.anomalyHoldPct}%) → AI 미언급 & ROAS ≥ 목표 → AI 언급 & ROAS < 목표 70% → 오가닉 · 쇼핑 모두 미노출`}>
          <DataTable rows={rows} columns={columns} rowKey={(r) => r.query.id} onRowClick={(r) => setSel(r.query.id)} selectedKey={sel} maxHeight={620} />
        </Card>
        <Card title={selected ? `'${selected.query.text}'` : '질의 선택'} sub="판정 상세 · 신호 근거">
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
              <div className="row" style={{ gap: 6 }}>
                {selected.requestable && selected.term ? (
                  requested(selected.term.term) ? <Pill tone="neutral" icon="clock">요청됨 · MILDO Flow에서 승인</Pill>
                    : <Button size="sm" variant="primary" icon="send" onClick={() => request(selected)}>SA 테스트 그룹 등록 요청</Button>
                ) : null}
                <a className="btn sm" href="#adpilot">AD Pilot 열기</a>
                <a className="btn sm" href="#lab">MILDO Lab 열기</a>
              </div>
              <div className="xs muted">등록 요청은 승인 범위 내 운영 조정(담당 AE, p.53)으로 승인 대기에 올라가며, 반영은 사람이 승인합니다. 테스트 판정은 MILDO Lab 기준(14일 또는 최소 클릭)을 따릅니다.</div>
            </div>
          ) : <Empty icon="search" title="질의를 선택하세요" />}
        </Card>
      </div>
    </div>
  );
}
