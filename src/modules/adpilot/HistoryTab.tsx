import { useMemo, useState } from 'react';
import type { ChangeRequest } from '@/core/types';
import { hhmm } from '@/core/util';
import { toCsv } from '@/core/download';
import { Card, type Column, CopyButton, DataTable, DownloadButton, Segmented, Src } from '@/ui/primitives';
import type { AdPilotCtx } from './useAdPilot';
import { ApproverPill, StatusPill } from './parts';
import { ChangeButtons } from './ProposalsTab';

interface Row { key: string; at: string; by: string; action: string; note?: string; change: ChangeRequest }

const KIND_LABEL: Record<string, string> = { bid: '입찰', budget: '예산', status: '상태', keyword_add: '키워드 등록', setting: '기준', gfa: '신규 캠페인', keyword_exclude: '제외', alert_rule: '알림 기준', test: '테스트' };

export function HistoryTab({ ap }: { ap: AdPilotCtx }) {
  const [scope, setScope] = useState<'all' | 'adpilot' | 'gfa'>('all');
  const changes = ap.changes.filter((c) => scope === 'all' || c.module === scope);
  const rows: Row[] = useMemo(() => changes
    .flatMap((c) => c.history.map((h, i) => ({ key: `${c.id}:${i}`, at: h.at, by: h.by, action: h.action, note: h.note, change: c })))
    .sort((a, b) => b.at.localeCompare(a.at)), [changes]);

  const cols: Column<Row>[] = [
    { key: 'at', label: '언제', sort: (r) => r.at, render: (r) => <span className="num small">{hhmm(r.at)}</span> },
    { key: 'by', label: '누가', sort: (r) => r.by, render: (r) => <strong className="small">{r.by}</strong> },
    { key: 'action', label: '무엇', render: (r) => <div className="stack-sm" style={{ gap: 0 }}><span className="small">{r.action} · {r.change.target}</span><span className="xs muted">{r.change.module === 'gfa' ? 'GFA Control' : 'AD Pilot'} · {KIND_LABEL[r.change.kind] ?? r.change.kind} · {String(r.change.before)} → {String(r.change.after)}</span></div> },
    { key: 'why', label: '왜', render: (r) => <div className="adpilot-basis">{r.note ?? r.change.reason}</div> },
    { key: 'approver', label: '승인 주체', render: (r) => <ApproverPill level={r.change.approver} /> },
    { key: 'status', label: '현재 상태', render: (r) => <StatusPill status={r.change.status} /> },
    { key: 'act', label: '', align: 'right', render: (r) => (r.key === `${r.change.id}:${r.change.history.length - 1}` ? <span className="adpilot-row-actions"><ChangeButtons ap={ap} c={r.change} /></span> : null) },
  ];

  const md = () => [
    `# AD Pilot · GFA Control 변경 이력 (${ap.data.today})`,
    '',
    '| 시각 | 누가 | 무엇 | 변경 | 왜 | 상태 |',
    '|---|---|---|---|---|---|',
    ...rows.map((r) => `| ${hhmm(r.at)} | ${r.by} | ${r.action} · ${r.change.target} | ${r.change.before} → ${r.change.after} | ${(r.note ?? r.change.reason).replace(/\|/g, '/')} | ${r.change.status} |`),
    '',
    '_시연용 테스트 데이터 기준 · 반영은 데모 로컬 상태_',
  ].join('\n');
  const csv = () => toCsv(rows.map((r) => ({ at: r.at, by: r.by, action: r.action, target: r.change.target, before: r.change.before, after: r.change.after, why: r.note ?? r.change.reason, approver: r.change.approver, status: r.change.status })));

  return (
    <Card title="변경 이력 전체 기록 — 누가 · 언제 · 왜" sub="요청 생성부터 승인 · 반영 · 실행 보류 · 롤백까지 모든 단계를 남깁니다. 반영 건은 최신 건부터 직전 상태로 롤백합니다."
      actions={<><Src kind="PROPOSAL" page="p.14 · p.15" /><CopyButton text={md} label="마크다운 복사" /><DownloadButton filename={`adpilot-history-${ap.data.today}.csv`} data={csv} mime="text/csv;charset=utf-8" label="CSV" /></>}>
      <Segmented label="범위" value={scope} onChange={setScope} options={[{ id: 'all', label: `전체 ${ap.changes.length}` }, { id: 'adpilot', label: `AD Pilot ${ap.changes.filter((c) => c.module === 'adpilot').length}` }, { id: 'gfa', label: `GFA ${ap.changes.filter((c) => c.module === 'gfa').length}` }]} />
      <DataTable rows={rows} columns={cols} rowKey={(r) => r.key} maxHeight={640} empty="이번 세션 변경 이력이 없습니다. 조정 후보의 [승인 요청]부터 시작하세요." />
    </Card>
  );
}
