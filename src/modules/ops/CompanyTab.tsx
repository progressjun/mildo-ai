/* p.55–57 회사 소개 · 고관여 내구재 레퍼런스 (+ p.5 · p.7 · p.11 근거) */
import { Fragment } from 'react';
import { fmt } from '@/core/util';
import { Button, Callout, Card, CopyButton, Pill, Src } from '@/ui/primitives';
import { COMPANY_FACTS, COMPANY_HISTORY, REFERENCE_FIELD_LABEL, RESOURCE_SAVING_CLAIM, WHY_US, type ReferenceField } from './data';
import type { RefView, referenceCheck } from './engine';
import type { OpsLocal } from './local';
import { InputFlag } from './parts';

type RefCheck = ReturnType<typeof referenceCheck>;

function refMarkdown(rows: RefView[]): string {
  const v = (r: RefView, f: ReferenceField) => r.cells[f].value || r.cells[f].original;
  return [
    '## 고관여 내구재 레퍼런스 (제안서 p.57)', '',
    '| 브랜드 · 카테고리 | 운영 기간 | 월 광고비 | 성과 수치 |', '|---|---|---|---|',
    ...rows.map((r) => `| ${r.ref.brand} · ${r.ref.category} | ${v(r, 'period')} | ${v(r, 'monthly')} | ${[...r.ref.results, v(r, 'metric')].join(' · ')} |`),
  ].join('\n') + '\n';
}

export function CompanyTab({ rows, check, patch }: { rows: RefView[]; check: RefCheck; patch: (p: (s: OpsLocal) => Partial<OpsLocal>) => void }) {
  const setCell = (refId: string, field: ReferenceField, value: string) => patch((s) => ({ refs: { ...s.refs, [refId]: { ...(s.refs[refId] ?? {}), [field]: value } } }));
  const b = check.bedding;
  return (
    <div className="stack-lg">
      <Card title="프로그레스미디어 소개" sub="검색광고로 시작해 네이버 · 카카오 · 쿠팡 · 당근 등 30여 개 매체를 공식 대행하는 퍼포먼스 마케팅 회사" actions={<Src kind="PROPOSAL" page="p.55–57" />}>
        <div className="ops-facts">
          {COMPANY_FACTS.map((f) => (
            <div key={f.id} className="ops-fact">
              <span className={`ops-fact-v${f.value.length > 12 ? ' long' : ''}`}>{f.value}</span>
              <span className="ops-fact-l">{f.label}</span>
              <span className="xs muted">{f.basis} · {f.page}</span>
            </div>
          ))}
        </div>
        <div className="grid g-2">
          <div className="ops-history" aria-label="연혁">
            {COMPANY_HISTORY.map((h) => <Fragment key={h.year}><strong>{h.year}</strong><span>{h.text}</span></Fragment>)}
          </div>
          <Callout tone="info" title={`검증된 결과 · ${RESOURCE_SAVING_CLAIM.page}`}>
            {RESOURCE_SAVING_CLAIM.text}. 브랜드명 블라인드 · 브랜드별 실측 보고서는 Q&A 근거자료로 제공합니다 (p.11). 수면밀도 대상 절감률은 온보딩 30일 내 실측으로 확정합니다 (p.19).
          </Callout>
        </div>
      </Card>

      <div className="grid g-4">
        {WHY_US.map((w) => (
          <Card key={w.title} title={w.title} actions={<Src kind="PROPOSAL" page="p.5" />}>
            <ul className="ops-issues">{w.points.map((p) => <li key={p}><Pill tone="outline">근거</Pill><span>{p}</span></li>)}</ul>
          </Card>
        ))}
      </div>

      <Card title="고관여 내구재 레퍼런스" sub="RFP 요구 양식: 브랜드(카테고리) · 운영 기간 · 월 광고비 · 성과 수치를 같은 양식으로 (블라인드 처리 가능) — 장표 빈칸만 편집"
        actions={<><Src kind="PROPOSAL" page="p.57" /><Src kind="RFP" title="필수 제출물 7) 회사소개 · 고관여 내구재 레퍼런스" /><InputFlag missing={check.total} label="빈칸" /><CopyButton text={() => refMarkdown(rows)} label="표 복사" /></>}>
        {check.total > 0 ? (
          <Callout tone="warning" title={`레퍼런스 빈칸 ${check.total}칸 / ${check.editable}칸 · 같은 양식 미충족`}>
            {check.blanks.map((x) => `${x.brand} ${REFERENCE_FIELD_LABEL[x.field]}`).join(' · ')}. 성과 수치는 증빙(매체 리포트 · 광고주 동의)이 있는 값만 입력합니다. RFP는 허위 기재 시 제안 검토 제외 · 손해배상을 명시했습니다.
          </Callout>
        ) : <Callout tone="good" title="레퍼런스 같은 양식 충족">{rows.length}개 레퍼런스 모두 운영 기간 · 월 광고비 · 성과 수치가 채워졌습니다.</Callout>}
        <div className="table-wrap">
          <table className="tbl">
            <thead><tr><th>브랜드 · 카테고리</th><th>운영 기간</th><th>월 광고비</th><th>성과 수치</th></tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.ref.id}>
                  <td><strong className="small">{r.ref.brand}</strong><div className="xs muted">{r.ref.category}</div></td>
                  {(['period', 'monthly'] as const).map((f) => (
                    <td key={f}>
                      {r.cells[f].editable ? (
                        <input id={`ops-ref-${r.ref.id}-${f}`} aria-label={`${r.ref.brand} ${REFERENCE_FIELD_LABEL[f]}`} className={`input ops-cell${r.cells[f].blank ? ' ops-blank' : ''}`} style={{ width: 150 }}
                          placeholder={r.cells[f].original} value={r.cells[f].value} onChange={(e) => setCell(r.ref.id, f, e.target.value)} />
                      ) : <span className="small">{r.cells[f].value}</span>}
                      {f === 'monthly' && r.cells.monthly.value && r.monthlyKrw === null ? <div className="xs muted">금액 해석 불가 · 예: 월 약 2억 원</div> : null}
                    </td>
                  ))}
                  <td>
                    <div className="stack-sm" style={{ gap: 4 }}>
                      {r.ref.results.map((x) => <span key={x} className="small"><Pill tone="neutral">확정</Pill> {x}</span>)}
                      {r.cells.metric.editable ? (
                        <input id={`ops-ref-${r.ref.id}-metric`} aria-label={`${r.ref.brand} 성과 수치`} className={`input ops-cell${r.cells.metric.blank ? ' ops-blank' : ''}`} style={{ width: 230 }}
                          placeholder={r.cells.metric.original} value={r.cells.metric.value} onChange={(e) => setCell(r.ref.id, 'metric', e.target.value)} />
                      ) : <span className="small">{r.cells.metric.value}</span>}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="row-between">
          <div className="row" style={{ gap: 8 }}>
            {b.matches ? <Pill tone="good" icon="check">침구 월 합산 일치</Pill> : <Pill tone="warning" icon="alert">침구 월 합산 확인 필요</Pill>}
            <span className="small">{b.brands.join(' + ')} 월 광고비 합 <strong className="num">{fmt.krw(b.sum)}원</strong> · 장표 표기 월 약 {fmt.krw(b.claim)}원 (p.57) · 차이 {fmt.delta(b.gapPct)} · 허용 ±{b.tolerancePct}%</span>
          </div>
          <Button size="sm" icon="rollback" onClick={() => patch(() => ({ refs: {} }))}>빈칸 초기화</Button>
        </div>
      </Card>
    </div>
  );
}
