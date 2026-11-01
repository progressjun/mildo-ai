/* SEO · 구조화 데이터 — 제품페이지 진단기 (HTML 붙여넣기 → DOMParser/정규식 추출 → 항목별 판정 · 점수) */
import type { Dataset } from '@/core/types';
import { fmt } from '@/core/util';
import { SALES_CHANNELS } from '@/data/constants';
import { Button, Callout, Card, CopyButton, DataTable, DownloadButton, Field, Pill, ProgressBar, Src, type Column } from '@/ui/primitives';
import { AUDIT_RULES } from './data';
import { auditMarkdown, clip, dateLabel, type AuditCheck, type PageAudit } from './engine';
import { ReviewHits, StatusPill, VerdictBadge } from './parts';

export function AuditTab({ d, html, onHtml, audit, sampleKind, onSample }: {
  d: Dataset; html: string; onHtml: (v: string) => void; audit: PageAudit; sampleKind: 'defect' | 'fixed' | 'custom' | 'empty'; onSample: (v: 'defect' | 'fixed' | 'empty') => void;
}) {
  const f = audit.facts;
  const meta = (k: string) => f.metas.find((m) => m.key === k)?.content ?? null;
  const product = audit.product;
  const columns: Column<AuditCheck>[] = [
    { key: 'axis', label: '축', sort: (c) => c.axis, render: (c) => <Pill tone="outline">{c.axis}</Pill> },
    { key: 'label', label: '항목', render: (c) => <strong className="small">{c.label}</strong> },
    { key: 'status', label: '판정', sort: (c) => ({ fail: 0, warn: 1, pass: 2, na: 3 }[c.status]), render: (c) => <StatusPill status={c.status} /> },
    { key: 'measured', label: '측정값', render: (c) => <span className="small geo-break">{c.measured}</span> },
    { key: 'basis', label: '기준', width: 170, render: (c) => <span className="geo-basis">{c.basis}</span> },
    { key: 'fix', label: '개선안', width: 230, render: (c) => <span className="small ink2">{c.fix}</span> },
    { key: 'w', label: '가중치', align: 'right', sort: (c) => c.weight, render: (c) => <span className="num small">{c.weight}</span> },
  ];
  const label = sampleKind === 'defect' ? '샘플 · 결함 포함' : sampleKind === 'fixed' ? '샘플 · 개선안' : sampleKind === 'custom' ? '붙여넣은 HTML' : '입력 없음';

  return (
    <div className="stack-lg">
      <div className="grid g-2">
        <Card className="geo-html-card" title="제품페이지 HTML" sub={`${label} · ${fmt.int(f.bytes)}자 · 파서 ${f.parser === 'dom' ? 'DOMParser (스크립트 미실행)' : '정규식 추출'}`}
          actions={
            <>
              <Button size="sm" variant={sampleKind === 'defect' ? 'primary' : 'default'} icon="refresh" onClick={() => onSample('defect')}>샘플 HTML (결함 포함)</Button>
              <Button size="sm" variant={sampleKind === 'fixed' ? 'primary' : 'default'} icon="check" onClick={() => onSample('fixed')}>개선안 샘플</Button>
              <Button size="sm" variant="ghost" icon="x" onClick={() => onSample('empty')}>지우기</Button>
            </>
          }>
          <Field label="HTML 붙여넣기 (페이지 소스 전체 또는 head + 상품 영역)" id="geo-html">
            <textarea id="geo-html" className="textarea geo-html" spellCheck={false} value={html} onChange={(e) => onHtml(e.target.value)}
              placeholder="<html> … <title>…</title> … <script type=&quot;application/ld+json&quot;>…</script> …" />
          </Field>
          <div className="xs muted">샘플은 운영 데이터(TEST DATA)의 상품 · 옵션 · 진행 프로모션으로 만듭니다. 붙여넣은 HTML은 외부로 전송하지 않고 이 화면에서만 해석합니다.</div>
        </Card>

        <div className="stack-lg">
          <Card title="진단 점수" sub="항목별 가중치 × (통과 1 · 개선 0.5 · 실패 0) · 해당 없음 제외 · 진단 항목은 p.29 SEO · 구조화 데이터 범위" actions={<><Src kind="PROPOSAL" page="p.29" />{sampleKind === 'defect' || sampleKind === 'fixed' ? <Src kind="DEMO" title="샘플은 시연용 테스트 데이터의 상품 · 옵션 · 프로모션으로 생성" /> : null}</>}>
            <div className="row-between">
              <div className="geo-score"><span className="geo-score-num">{audit.empty ? '—' : audit.score}</span><span className="muted">/ 100</span></div>
              <VerdictBadge v={audit.grade} />
            </div>
            <div className="row" style={{ gap: 6 }}>
              <Pill tone="critical" icon="alert">실패 {audit.counts.fail}</Pill>
              <Pill tone="warning" icon="alert">개선 {audit.counts.warn}</Pill>
              <Pill tone="good" icon="check">통과 {audit.counts.pass}</Pill>
              {audit.counts.na ? <Pill tone="outline">해당 없음 {audit.counts.na}</Pill> : null}
            </div>
            <div className="geo-axis-bars">
              {audit.axes.map((a) => (
                <div key={a.axis} style={{ display: 'contents' }}>
                  <span className="small">{a.axis}</span>
                  <ProgressBar value={a.checks ? a.score : 0} tone={!a.checks ? 'ink' : a.score >= AUDIT_RULES.scorePass ? 'good' : a.score >= AUDIT_RULES.scoreWarn ? 'warning' : 'critical'} label={`${a.axis} 점수`} marker={AUDIT_RULES.scorePass} />
                  <span className="num small" style={{ textAlign: 'right' }}>{a.checks ? `${a.score}점` : '—'}</span>
                </div>
              ))}
            </div>
            <div className="xs muted">세로 표시: 기준 {AUDIT_RULES.scorePass}점 · 제목 · 메타 길이 기준은 운영 초기 기준(한글 기준 · 온보딩 중 확정)</div>
          </Card>

          <Card title="운영 데이터 대조" sub="JSON-LD 가격 · 재고를 판매 데이터와 비교" actions={<Src kind="DEMO" />}>
            {audit.matched.product ? (
              <div className="stack-sm">
                <div className="small">일치 상품 <strong>{audit.matched.product}</strong>{audit.matched.channel ? ` · ${SALES_CHANNELS[audit.matched.channel].name}` : ' · 채널 미확인(canonical)'}</div>
                {audit.matched.promo ? (
                  <div className="small">진행 프로모션 <strong>{audit.matched.promo}</strong> {audit.matched.discountRate}% · {dateLabel(d.today)} 기준</div>
                ) : <div className="small muted">진행 중 프로모션 없음 → 정가 기준 대조</div>}
                {audit.checks.filter((c) => c.axis === '운영 데이터 대조').map((c) => (
                  <div key={c.id} className="row" style={{ gap: 6, alignItems: 'flex-start' }}>
                    <StatusPill status={c.status} />
                    <span className="small">{c.label} · {c.measured} <span className="geo-basis">· 기준 {c.basis}</span></span>
                  </div>
                ))}
              </div>
            ) : <div className="small muted">판매 데이터에 일치하는 상품이 없어 판매가 · 재고 대조를 건너뜁니다 (해당 없음).</div>}
          </Card>
        </div>
      </div>

      {audit.review.some((h) => h.level !== 'check') ? (
        <Callout tone={audit.review.some((h) => h.level === 'block') ? 'critical' : 'warning'} title="문구 검수 (REVIEW_RULES · p.27 · p.35)">
          <ReviewHits hits={audit.review} />
        </Callout>
      ) : null}

      <Card title="항목별 판정" sub={`${audit.checks.length}개 항목 · ${audit.axes.map((a) => `${a.axis} ${audit.checks.filter((c) => c.axis === a.axis).length}`).join(' · ')}`}
        actions={
          <>
            {sampleKind === 'defect' || sampleKind === 'fixed' ? <Src kind="DEMO" title="샘플은 시연용 테스트 데이터의 상품 · 옵션 · 프로모션으로 생성" /> : null}
            <CopyButton text={() => auditMarkdown(audit, label)} label="진단 결과 복사" />
            <DownloadButton filename={`searchtune-audit-${d.today}.md`} data={() => auditMarkdown(audit, label)} label=".md 다운로드" />
          </>
        }>
        <DataTable rows={audit.checks} columns={columns} rowKey={(c) => c.id} initialSort={{ key: 'status', dir: 'asc' }} />
      </Card>

      <Card title="추출 결과" sub="진단에 쓰인 원본 값" actions={<Src kind="DEMO" />}>
        <div className="grid g-2">
          <dl className="geo-facts">
            <dt>title</dt><dd>{f.title ?? <span className="muted">없음</span>}</dd>
            <dt>description</dt><dd>{meta('description') ?? <span className="muted">없음</span>}</dd>
            <dt>og:title · image</dt><dd>{meta('og:title') ?? '—'} · {meta('og:image') ? clip(meta('og:image') ?? '', 40) : <span className="muted">og:image 없음</span>}</dd>
            <dt>canonical</dt><dd>{f.canonical ?? <span className="muted">없음</span>}</dd>
            <dt>h1</dt><dd>{f.h1.length ? f.h1.join(' / ') : <span className="muted">없음</span>}</dd>
            <dt>이미지</dt><dd>{f.images.length}개 · ALT 없음 {f.images.filter((i) => i.alt === null).length} · 빈 값 {f.images.filter((i) => i.alt !== null && !i.alt.trim()).length}</dd>
            <dt>화면 가격</dt><dd>{audit.displayedPrice ? `${fmt.won(audit.displayedPrice.value)} (${audit.displayedPrice.kind === 'sale' ? '판매가' : '가격'} · ${audit.displayedPrice.source}${audit.displayedPrice.option ? ` · 옵션 ${audit.displayedPrice.option}` : ''})` : <span className="muted">미검출</span>}</dd>
          </dl>
          <dl className="geo-facts">
            <dt>JSON-LD</dt><dd>{f.jsonLd.length}개 블록{f.jsonLd.some((b) => b.error) ? ' · 구문 오류 있음' : ''}</dd>
            <dt>Product</dt><dd>{product ? `${product.name ?? '(name 없음)'} · brand ${product.brand ?? '없음'}` : <span className="muted">없음</span>}</dd>
            <dt>offers</dt><dd>{product?.offers.length ? product.offers.map((o) => `${o.name ?? o.sku ?? '오퍼'} ${o.price !== null ? fmt.won(o.price) : '가격 없음'} · ${o.availability ?? '재고 미기재'}`).join(' / ') : <span className="muted">없음</span>}</dd>
            <dt>aggregateRating</dt><dd>{product?.rating ? `${product.rating.value} · ${fmt.int(product.rating.count)}건` : <span className="muted">없음</span>}</dd>
            <dt>FAQPage</dt><dd>{audit.faq.count ? `${audit.faq.count}문항` : <span className="muted">없음</span>}</dd>
            <dt>AEO 주제</dt><dd>{audit.topics.map((t) => `${t.label} ${t.found ? '○' : '×'}`).join(' · ')}</dd>
          </dl>
        </div>
      </Card>
    </div>
  );
}
