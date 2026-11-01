/* p.25 오가닉 · 페이드 통합 아카이빙 — 경쟁 6개사 × 6개 항목 매트릭스 · 아카이브 타임라인 · Alert P3 연동 */
import { useMemo, useState } from 'react';
import { RFP } from '@/data/constants';
import { fmtDate } from '@/core/util';
import { Button, Callout, Card, Empty, Pill, Segmented, Src, Stat } from '@/ui/primitives';
import { IMPACT_META, type ArchiveItemId, type ArchiveRow, type ImpactLevel } from './engine';
import { ARCHIVE_ITEMS } from './data';
import type { WatchCtx } from './hooks';
import { ImpactBadge } from './parts';

const CHANNEL_LABEL: Record<ArchiveRow['channel'], string> = { paid: '페이드', organic: '오가닉', offline: '오프라인', common: '공통' };

export function ArchiveTab({ w }: { w: WatchCtx }) {
  const [comp, setComp] = useState<string>('all');
  const [item, setItem] = useState<'all' | ArchiveItemId>('all');
  const [impact, setImpact] = useState<'all' | ImpactLevel>('all');
  const m = w.matrix;
  const rows = useMemo(
    () => w.archive.filter((r) => (comp === 'all' || r.competitor === comp || (comp === 'common' && !r.competitor)) && (item === 'all' || r.item === item) && (impact === 'all' || r.impact.level === impact)),
    [w.archive, comp, item, impact],
  );
  const week = w.archive.filter((r) => r.date >= w.brief.period.from);
  const alertable = w.archive.filter((r) => r.alertable && r.date >= m.from);
  const pick = (c: string, i: ArchiveItemId) => {
    setComp(c);
    setItem(i);
    setImpact('all');
  };

  return (
    <div className="stack-lg">
      <Callout tone="warning" icon="alert" title="시연용 가상 스냅샷">
        경쟁사 소재 · 가격 · 매장 기록은 화면 동작과 영향도 판정 로직을 보여주기 위한 TEST DATA이며 실제 경쟁사 활동 · 실제 판매가가 아닙니다. 자사 비교값(판매가 · 프로모션 · 키워드 순위)은 데이터셋에서 읽습니다.
      </Callout>

      <div className="grid g-4">
        <Card><Stat label={<>최근 7일 변경</>} src={<Src kind="DEMO" />} value={`${week.length}건`} foot={<span>영향도 높음 {week.filter((r) => r.impact.level === 'high').length}건</span>} /></Card>
        <Card><Stat label={<>최근 {m.days}일 변경</>} src={<Src kind="DEMO" />} value={`${w.archive.filter((r) => r.date >= m.from).length}건`} foot={<span>경쟁 {RFP.competitors.length}개사 · 항목 {ARCHIVE_ITEMS.length}개</span>} /></Card>
        <Card><Stat label="Alert P3 미등록 변경" src={<Src kind="PROPOSAL" page="p.44" />} value={`${alertable.filter((r) => !w.alertExists(r)).length}건`} foot={<span>가격 · 혜택 / 소재 · 프로모션 변경 {alertable.length}건 중 · 영향도 높음 {alertable.filter((r) => r.impact.level === 'high').length}건</span>} /></Card>
        <Card><Stat label="이 화면에서 생성한 Alert 이슈" value={`${w.alerts.length}건`} foot={<a href="#alert">MILDO Alert 이슈 큐</a>} /></Card>
      </div>

      <Card
        title="경쟁 6개사 × 아카이빙 항목"
        sub={`오가닉 · 페이드 구분 없이 경쟁 6개사와 외부 변수를 쌓아 브랜드에 영향을 줄 인사이트를 뽑습니다. 셀 = 최근 ${m.days}일 변경 건수 · 최고 영향도 · 최근 변경일 (누르면 타임라인 필터).`}
        actions={<><Src kind="PROPOSAL" page="p.25" /><Src kind="RFP" title="경쟁 6개사 · RFP 명시" /><Src kind="DEMO" /></>}
      >
        <div className="table-wrap">
          <table className="tbl watch-matrix">
            <thead>
              <tr>
                <th>아카이빙 항목</th>
                <th>범위 · 수집 주기</th>
                {RFP.competitors.map((c) => (
                  <th key={c} className="c">
                    <button type="button" className="watch-th-btn" onClick={() => { setComp(comp === c ? 'all' : c); setItem('all'); }}>{c}</button>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {m.items.map(({ item: it, cells, common }) => (
                <tr key={it.id}>
                  <td><strong className="small">{it.label}</strong></td>
                  <td>
                    <div className="xs ink2">{it.scope}</div>
                    <div className="xs"><Pill tone={it.cadenceSrc === 'p.25' ? 'accent' : 'outline'} icon="clock">{it.cadence}</Pill> <span className="muted">{it.cadenceSrc}</span></div>
                  </td>
                  {common ? (
                    <td colSpan={RFP.competitors.length}>
                      <button type="button" className="watch-cell wide" onClick={() => pick('common', it.id)}>
                        <span className="num"><strong>{common.count}</strong>건 · 공통</span>
                        {common.level ? <span className={`watch-dot ${common.level}`} title={IMPACT_META[common.level].label} /> : null}
                        <span className="xs muted watch-clip">{common.rows.slice(0, 2).map((r) => `${fmtDate(r.date, false)} ${r.title}`).join(' / ') || '기록 없음'}</span>
                      </button>
                    </td>
                  ) : cells.map((c) => (
                    <td key={c.competitor} className="c">
                      <button type="button" className={`watch-cell ${c.count ? '' : 'empty'}`} onClick={() => pick(c.competitor, it.id)} title={c.latest ? `${c.latest.title} · ${c.latest.impact.basis}` : '최근 변경 없음 (수집은 주기대로 진행)'}>
                        {c.count ? (
                          <>
                            <span className="row" style={{ gap: 4, justifyContent: 'center' }}>
                              {c.level ? <span className={`watch-dot ${c.level}`} aria-label={IMPACT_META[c.level].label} /> : null}
                              <strong className="num">{c.count}</strong>
                            </span>
                            <span className="xs muted">{c.latest ? fmtDate(c.latest.date, false) : ''}</span>
                          </>
                        ) : <span className="xs muted">변경 없음</span>}
                      </button>
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="row xs muted" style={{ gap: 12 }}>
          {(['high', 'mid', 'low'] as ImpactLevel[]).map((l) => <span key={l} className="row" style={{ gap: 4 }}><span className={`watch-dot ${l}`} />{IMPACT_META[l].label}</span>)}
          <span>영향도 기준(운영 가정): 실판매가 −10% 이상 높음 · −5% 이상 중간 / 자사 기획전과 기간 중복 · 할인율 ≥ 자사 높음 / 브랜드 키워드 지면 경쟁사 광고 높음 (p.45)</span>
        </div>
      </Card>

      <Card
        title="아카이브 타임라인"
        sub="날짜 · 경쟁사 · 항목 · 변경 내용 · 영향도(기준 병기). 가격 · 혜택, 소재 · 프로모션 변경은 MILDO Alert P3(매체 · 외부 환경, 24시간 내 영향 분석)로 보낼 수 있습니다."
        actions={<><Src kind="PROPOSAL" page="p.25 · p.44" /><Src kind="DEMO" /></>}
      >
        <div className="row-between">
          <div className="row">
            <select id="watch-archive-competitor" className="select" style={{ width: 160 }} value={comp} onChange={(e) => setComp(e.target.value)} aria-label="경쟁사">
              <option value="all">전체 경쟁사</option>
              {RFP.competitors.map((c) => <option key={c} value={c}>{c}</option>)}
              <option value="common">공통 (외부 변수 · 파트너)</option>
            </select>
            <select id="watch-archive-item" className="select" style={{ width: 170 }} value={item} onChange={(e) => setItem(e.target.value as 'all' | ArchiveItemId)} aria-label="아카이빙 항목">
              <option value="all">전체 항목</option>
              {ARCHIVE_ITEMS.map((i) => <option key={i.id} value={i.id}>{i.label}</option>)}
            </select>
          </div>
          <Segmented<'all' | ImpactLevel> label="영향도" value={impact} onChange={setImpact} options={[{ id: 'all', label: '전체' }, { id: 'high', label: '높음' }, { id: 'mid', label: '중간' }, { id: 'low', label: '낮음' }]} />
        </div>
        {rows.length === 0 ? <Empty title="조건에 맞는 기록이 없습니다" /> : (
          <ol className="watch-timeline">
            {rows.map((r) => {
              const exists = w.alertExists(r);
              return (
                <li key={r.id} className={`lv-${r.impact.level}`}>
                  <div className="watch-tl-date num">{fmtDate(r.date)}</div>
                  <div className="watch-tl-body">
                    <div className="row" style={{ gap: 6 }}>
                      <strong className="small">{r.competitor ?? '공통'}</strong>
                      <Pill tone="outline">{r.itemLabel}</Pill>
                      <Pill tone="neutral">{CHANNEL_LABEL[r.channel]}</Pill>
                      <span className="xs muted">수집 {r.cadence}</span>
                    </div>
                    <div className="small"><strong>{r.title}</strong> <span className="ink2">— {r.detail}</span></div>
                    {r.impact.facts.length ? <div className="xs ink2">{r.impact.facts.join(' · ')}</div> : null}
                    <ImpactBadge level={r.impact.level} basis={r.impact.basis} />
                  </div>
                  <div className="watch-tl-side">
                    {r.alertable ? (
                      exists ? <a className="xs" href="#alert"><Pill tone="good" icon="check">Alert P3 생성됨</Pill></a> : (
                        <Button size="sm" icon="bell" variant={r.impact.level === 'high' ? 'primary' : 'default'} onClick={() => w.createAlert(r)}>Alert P3 생성</Button>
                      )
                    ) : <span className="xs muted">주간 브리프 반영</span>}
                  </div>
                </li>
              );
            })}
          </ol>
        )}
      </Card>
    </div>
  );
}
