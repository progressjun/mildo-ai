/**
 * CSV · TSV 업로드 — 템플릿 선택 · 템플릿 다운로드 · 파일 선택(UTF-8 / EUC-KR 자동) 또는 붙여 넣기 · 열 매핑 · 미리보기 · 가져오기.
 * 서버 모드: 미리보기 = POST uploads dryRun, 가져오기 = POST uploads (워커가 ingest.upload로 가져온다).
 * 데모 모드: 같은 엔진(csv.ts)으로 이 브라우저 안에서만 미리보기 — 가져오기는 서버 연결 시.
 */
import { useMemo, useState, type ChangeEvent } from 'react';
import { Button, Callout, Card, DataTable, DownloadButton, Field, Pill, Segmented, type Column } from '@/ui/primitives';
import { useActions, useStore } from '@/core/store';
import { fmt } from '@/core/util';
import { MEDIA, MEDIA_IDS, SALES_CHANNEL_IDS, SALES_CHANNELS } from '@/data/constants';
import { blockingIssues, MAX_UPLOAD_BYTES, normalizeCsv, TEMPLATE_EXAMPLE_MARK, TEMPLATE_HELP, templateCsv, TEMPLATES, UPLOAD_TEMPLATES, type UploadTemplate } from './csv';
import { channelLabel, csvCheckDay, decodeCsvBytes, fmtBytes, fmtStamp, uploadImportLock, uploadStatusMeta, type ConnectionView, type UploadView } from './model';
import { connectionsApi, type UploadResult } from './client';
import { IssueRow, ConfirmModal } from './parts';
import { errorText } from './useConnections';

const SAMPLE: Record<UploadTemplate, string> = {
  media_daily: '일자,매체,노출수,클릭수,총비용(VAT포함),전환수,전환매출액\n2026.10.29,네이버 GFA,"412,000","2,310","948,000",3,"3,120,000"\n2026.10.30,네이버 GFA,"398,500","2,190","921,000",2,"2,050,000"\n2026.10.30,네이버 GFA,합계,,,,',
  media_hourly: '일자,시간대,매체,노출,클릭,광고비,전환,전환매출\n2026-10-30,21시,meta,"12,000",140,"98,000",1,"990,000"\n2026-10-30,22시,meta,"13,400",151,"104,500",2,"1,980,000"',
  sales_daily: '날짜\t판매채널\t방문자수\t상품상세조회\t장바구니\t주문수\t결제금액\n2026/10/30\t오늘의집\t2,140\t1,190\t121\t41\t43,200,000\n2026/10/30\t자사몰\t1,050\t590\t60\t11\t11,300,000',
  keyword_daily: '일자,키워드,광고그룹,노출수,클릭수,총비용,전환수,전환매출액,평균노출순위\n2026-10-30,첫 독립 매트리스,LIFE_TEST,120,4,"3,100",0,0,2.4\n2026-10-30,퀸 매트리스,GENERIC_MAIN,"2,100",61,"76,400",1,"1,060,000",3.1',
  search_term_daily: '일자,검색어,노출수,클릭수,총비용,전환수,전환매출액\n2026-10-30,신혼집 매트리스 사이즈,410,12,"9,600",1,"1,050,000"\n2026-10-30,허리 디스크 매트리스 단단한,280,9,"8,100",0,0',
};

type PreviewState = { result: UploadResult; local: boolean } | null;

export function UploadPanel({ server, workspaceId, canOperate, canConfigure, csvConnections, uploads, onImported, initialTemplate, initialChannel, onShowRuns }: {
  server: boolean; workspaceId: string | null; canOperate: boolean; canConfigure: boolean; csvConnections: ConnectionView[]; uploads: UploadView[]; onImported: () => void;
  /** 처음 고를 템플릿 · 고정 채널 (CSV 전용 공급자 카드의 'CSV 업로드로 이동') */
  initialTemplate?: UploadTemplate; initialChannel?: string | null;
  /** 업로드 이력의 '사유 보기' — 수집 현황 탭을 상태 필터와 함께 연다 */
  onShowRuns?: (filter: 'partial' | 'failed') => void;
}) {
  const { toast } = useActions();
  // 미래 날짜 판정 기준일 (브라우저 미리보기) — 화면 Dataset 기준일과 실제 오늘(KST) 중 늦은 날. 서버 미리보기는 서버가 실제 오늘(KST)로 판정
  const dataToday = useStore().state.data.today;
  const [template, setTemplate] = useState<UploadTemplate>(initialTemplate && UPLOAD_TEMPLATES.includes(initialTemplate) ? initialTemplate : 'media_daily');
  const [filename, setFilename] = useState('붙여넣기.csv');
  const [content, setContent] = useState('');
  const [encoding, setEncoding] = useState<string | null>(null);
  const [channel, setChannel] = useState(initialChannel ?? '');
  const [connectionId, setConnectionId] = useState('');
  const [mapping, setMapping] = useState<Record<string, string | null>>({});
  const [preview, setPreview] = useState<PreviewState>(null);
  const [busy, setBusy] = useState<'preview' | 'import' | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [del, setDel] = useState<UploadView | null>(null);
  const [delBusy, setDelBusy] = useState(false);
  const def = TEMPLATES[template];
  const bytes = useMemo(() => new TextEncoder().encode(content).length, [content]);
  const tooBig = bytes > MAX_UPLOAD_BYTES;

  const reset = (keepContent = true) => { setPreview(null); setErr(null); if (!keepContent) { setContent(''); setEncoding(null); } };

  const onFile = async (e: ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    e.target.value = '';
    if (!f) return;
    if (f.size > MAX_UPLOAD_BYTES) { setErr(`파일이 너무 큽니다 (${fmtBytes(f.size)}) — 20MB 이하로 나눠 올려 주세요`); return; }
    try {
      const d = decodeCsvBytes(await f.arrayBuffer());
      setContent(d.text);
      setEncoding(d.encoding === 'euc-kr' ? 'EUC-KR(엑셀 한글)로 읽음' : 'UTF-8');
      setFilename(f.name);
      setMapping({});
      reset();
    } catch {
      setErr('파일을 읽지 못했습니다');
    }
  };

  const body = (dryRun: boolean) => ({
    template, filename, content, dryRun,
    mapping: Object.keys(mapping).length ? mapping : undefined,
    channel: def.fixedChannel && channel ? channel : null,
    connectionId: connectionId || null,
  });

  const runPreview = async () => {
    setErr(null);
    if (!content.trim()) { setErr('파일을 고르거나 내용을 붙여 넣으세요'); return; }
    if (tooBig) { setErr('20MB 이하만 올릴 수 있습니다'); return; }
    if (!server) {
      const r = normalizeCsv(template, content, { mapping, channel: def.fixedChannel && channel ? channel : null, today: csvCheckDay(dataToday, Date.now()) });
      setPreview({ local: true, result: { upload: null, preview: r.preview as unknown as UploadResult['preview'], issues: r.issues, columns: { headers: r.summary.headers, mapping: r.mapping.fields, missing: r.mapping.missing, unmapped: r.mapping.unmapped }, summary: r.summary } });
      return;
    }
    if (!workspaceId) return;
    setBusy('preview');
    try {
      setPreview({ local: false, result: await connectionsApi.upload(workspaceId, body(true)) });
    } catch (e) {
      setErr(errorText(e));
    } finally {
      setBusy(null);
    }
  };

  const runImport = async () => {
    if (!server || !workspaceId) return;
    setBusy('import');
    setErr(null);
    try {
      const r = await connectionsApi.upload(workspaceId, body(false));
      toast({ tone: 'good', title: '가져오기를 대기열에 올렸습니다', body: `${filename} · ${fmt.int(r.summary.records)}건 — 워커가 처리하면 수집 현황 · 데이터 품질에 결과가 표시됩니다` });
      setPreview({ local: false, result: r });
      onImported();
    } catch (e) {
      setErr(errorText(e));
    } finally {
      setBusy(null);
    }
  };

  const doDelete = async () => {
    if (!del || !workspaceId) return;
    setDelBusy(true);
    try {
      const r = await connectionsApi.removeUpload(workspaceId, del.id);
      toast({ tone: 'good', title: '업로드를 지웠습니다', body: `${del.filename} · 웨어하우스 ${fmt.int(r.purgedRows)}행 정리` });
      setDel(null);
      onImported();
    } catch (e) {
      setErr(errorText(e));
    } finally {
      setDelBusy(false);
    }
  };

  const res = preview?.result ?? null;
  const blocking = res ? blockingIssues(res.issues) : [];
  // '예시 내용 채우기'로 넣은 시연용 내용(TEST DATA)은 서버에 실데이터로 가져오지 않는다 — 미리보기만
  const isSample = content.trim() === SAMPLE[template].trim();
  const importLock = uploadImportLock({ server, canOperate, isSample, serverPreview: !!res && !preview?.local, blocking: blocking.length });
  type PreviewRow = Record<string, unknown> & { _line: number };
  const previewCols: Column<PreviewRow>[] = useMemo(() => [
    { key: '_line', label: '행', align: 'right', render: (r: PreviewRow) => r._line } as Column<PreviewRow>,
    ...def.fields.filter((f) => res?.columns.mapping[f.key] || f.type === 'media' || f.type === 'channel').map((f): Column<PreviewRow> => ({
      key: f.key, label: f.label, align: ['int', 'money', 'decimal', 'hour'].includes(f.type) ? 'right' : 'left',
      render: (r: PreviewRow) => {
        const v = r[f.key];
        if (v === null || v === undefined) return <span className="muted">—</span>;
        if (f.type === 'media' || f.type === 'channel') return channelLabel(String(v));
        if (typeof v === 'number') return f.type === 'money' ? fmt.won(v) : fmt.dec1(v).replace(/\.0$/, '');
        return String(v);
      },
    })),
  ], [def, res]);

  return (
    <div className="stack-lg">
      <Card title="CSV · TSV 업로드" sub="API가 없거나 아직 연결하지 않은 매체 · 판매 채널 데이터를 파일로 올립니다. 같은 기간을 다시 올리면 새 파일 값이 우선합니다 (업로드 출처 우선순위 50)">
        <div className="stack">
          <Segmented<UploadTemplate> label="템플릿" value={template} onChange={(t) => { setTemplate(t); setMapping({}); reset(); }} options={UPLOAD_TEMPLATES.map((t) => ({ id: t, label: TEMPLATES[t].label }))} />
          <div className="small ink2">{def.description}</div>
          <div className="xs muted">{TEMPLATE_HELP[template]}</div>
          <div className="xs ink2">템플릿의 예시 행(일자 칸에 '{TEMPLATE_EXAMPLE_MARK} 행 — 지우고 쓰세요' 표시)은 실제 데이터가 아니므로 지우고 쓰세요. 남아 있어도 가져오지 않고 미리보기에 경고로 표시합니다.</div>
          <div className="row" style={{ gap: 6 }}>
            <DownloadButton filename={`mildo_${template}.csv`} data={() => templateCsv(template)} mime="text/csv;charset=utf-8" label="템플릿 받기 (UTF-8)" />
            <Button size="sm" icon="copy" onClick={() => { setContent(SAMPLE[template]); setFilename(`예시_${template}.csv`); setEncoding('예시 (TEST DATA)'); setMapping({}); reset(); }}>예시 내용 채우기</Button>
          </div>
          <div className="grid g-3">
            <Field label="파일 (.csv · .tsv · .txt, 20MB 이하)" id="up-file" hint={encoding ? `${filename} · ${fmtBytes(bytes)} · ${encoding}` : '엑셀에서 CSV(쉼표로 분리)로 저장한 파일도 됩니다'}>
              <input id="up-file" className="input" type="file" accept=".csv,.tsv,.txt,text/csv,text/plain" onChange={onFile} />
            </Field>
            {def.fixedChannel ? (
              <Field label={def.fixedChannel === 'media' ? '매체 고정 (매체 열이 없을 때)' : '판매 채널 고정 (채널 열이 없을 때)'} id="up-channel">
                <select id="up-channel" className="select" value={channel} onChange={(e) => { setChannel(e.target.value); reset(); }}>
                  <option value="">파일의 열 사용</option>
                  {(def.fixedChannel === 'media' ? MEDIA_IDS.map((m) => [m, MEDIA[m].name]) : SALES_CHANNEL_IDS.map((c) => [c, SALES_CHANNELS[c].name])).map(([id, name]) => <option key={id} value={id}>{name}</option>)}
                </select>
              </Field>
            ) : <div />}
            {server && csvConnections.length ? (
              <Field label="CSV 커넥션 (우선순위 적용)" id="up-conn">
                <select id="up-conn" className="select" value={connectionId} onChange={(e) => setConnectionId(e.target.value)}>
                  <option value="">연결 안 함 (우선순위 50)</option>
                  {csvConnections.map((c) => <option key={c.id} value={c.id}>{c.label} (우선순위 {c.priority})</option>)}
                </select>
              </Field>
            ) : null}
          </div>
          <Field label="또는 내용 붙여 넣기" id="up-text">
            <textarea id="up-text" className="textarea conn-csv" value={content.length > 200_000 ? `${content.slice(0, 200_000)}\n… (화면에는 앞 200KB만 표시 — 전체 ${fmtBytes(bytes)}를 올립니다)` : content}
              readOnly={content.length > 200_000} spellCheck={false} placeholder={'일자,매체,노출,클릭,광고비,전환,전환매출\n2026-10-30,naver_sa,12000,480,396000,8,8720000'}
              onChange={(e) => { setContent(e.target.value); setEncoding(null); reset(); }} />
          </Field>
          <div className="row">
            <Button variant="primary" icon="search" onClick={runPreview} disabled={!content.trim() || busy !== null || tooBig || (server && !canOperate)} title={server && !canOperate ? '담당 AE 이상' : undefined}>{busy === 'preview' ? '읽는 중…' : '미리보기'}</Button>
            <Button variant="accent" icon="download" onClick={runImport} disabled={!!importLock || busy !== null} title={importLock ?? undefined}>{busy === 'import' ? '등록 중…' : '가져오기'}</Button>
            {!server ? <span className="xs muted">데모 모드: 미리보기는 이 브라우저 안에서만 읽고 어디에도 보내지 않습니다. 가져오기는 서버 연결 시 동작합니다</span> : null}
          </div>
          {err ? <Callout tone="critical">{err}</Callout> : null}
        </div>
      </Card>

      {res ? (
        <Card title="미리보기" sub={`${res.summary.rows}행 중 정상 ${res.summary.validRows}행 · 제외 ${res.summary.invalidRows}행 → ${res.summary.records}건 (같은 키 합산) · ${res.summary.dateFrom ?? '—'} ~ ${res.summary.dateTo ?? '—'} · 구분자 ${res.summary.delimiter}`}
          actions={res.upload ? <Pill tone="good">업로드 등록됨 · {res.upload.status === 'received' ? '가져오는 중' : res.upload.status}</Pill> : preview?.local ? <Pill tone="outline">브라우저 미리보기</Pill> : <Pill tone="outline">서버 미리보기 (저장 안 함)</Pill>}>
          <div className="stack">
            <div className="table-wrap">
              <table className="tbl">
                <thead><tr><th>템플릿 필드</th><th>필수</th><th>파일 열</th></tr></thead>
                <tbody>
                  {def.fields.map((f) => {
                    const cur = res.columns.mapping[f.key] ?? '';
                    const miss = res.columns.missing.includes(f.key);
                    return (
                      <tr key={f.key}>
                        <td>{f.label} <span className="xs muted">{f.key}</span></td>
                        <td>{f.required ? <Pill tone={miss ? 'critical' : 'neutral'}>{miss ? '없음' : '필수'}</Pill> : <span className="xs muted">선택</span>}</td>
                        <td>
                          <select className="select" aria-label={`${f.label} 열`} value={cur} onChange={(e) => { setMapping((m) => ({ ...m, [f.key]: e.target.value || null })); setPreview(null); }}>
                            <option value="">사용 안 함</option>
                            {res.columns.headers.map((h) => <option key={h} value={h}>{h}</option>)}
                          </select>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            {Object.keys(mapping).length ? <span className="xs muted">열 매핑을 바꿨습니다 — 미리보기를 다시 눌러 확인하세요</span> : null}
            {res.issues.length ? <ul className="conn-issues">{res.issues.map((i, k) => <IssueRow key={`${i.code}-${k}`} i={i} />)}</ul> : (
              <Callout tone="good">{preview?.local
                ? '형식 · 값 검사(음수 지표 · 오늘 이후 날짜 · 템플릿 예시 행)를 모두 통과했습니다. 누락 날짜 등 수집 품질 검사는 서버에서 가져올 때 수집 현황에 기록됩니다.'
                : '형식 · 값 검사와 수집 품질 검사(음수 지표 · 오늘 이후 날짜 · 누락 날짜 · 클릭 > 노출 등)를 모두 통과했습니다. 가져온 결과는 수집 현황에 기록됩니다.'}</Callout>
            )}
            {blocking.length ? <Callout tone="critical" title="가져올 수 없습니다">{blocking.map((b) => b.message).join(' / ')}</Callout> : null}
            <DataTable rows={res.preview} rowKey={(r) => String(r._line)} columns={previewCols} empty="정상 행이 없습니다" maxHeight={360} />
            <span className="xs muted">앞 {res.preview.length}행 (정규화 결과 · 합산 전)</span>
          </div>
        </Card>
      ) : null}

      <Card title="업로드 이력" sub="가져온 파일마다 별도 출처(csv:업로드)로 쌓입니다. 지우면 그 파일로 들어온 데이터만 빠집니다">
        <DataTable<UploadView> rows={uploads} rowKey={(u) => u.id} empty={server ? '아직 올린 파일이 없습니다' : '서버 연결 시 업로드 이력이 표시됩니다'}
          columns={[
            { key: 'createdAt', label: '올린 시각', render: (u) => fmtStamp(u.createdAt), sort: (u) => u.createdAt ?? '' },
            { key: 'filename', label: '파일', render: (u) => <span>{u.filename} <span className="xs muted">{fmtBytes(u.bytes)}</span></span> },
            { key: 'template', label: '템플릿', render: (u) => TEMPLATES[u.template as UploadTemplate]?.label ?? u.template },
            { key: 'range', label: '기간', render: (u) => (u.summary.dateFrom ? `${u.summary.dateFrom} ~ ${u.summary.dateTo}` : '—') },
            { key: 'records', label: '건수', align: 'right', render: (u) => fmt.int(Number(u.summary.rowsWritten ?? u.summary.records ?? 0)) },
            { key: 'status', label: '상태', render: (u) => {
              const st = uploadStatusMeta(u);
              return (
                <span className="row" style={{ gap: 4 }}>
                  <Pill tone={st.tone} title={st.title}>{st.label}</Pill>
                  {st.runFilter && onShowRuns ? <Button size="sm" variant="ghost" onClick={() => onShowRuns(st.runFilter!)} title="수집 현황에서 제외 · 실패 사유를 봅니다">사유 보기</Button> : null}
                </span>
              );
            } },
            { key: 'act', label: '', render: (u) => <Button size="sm" variant="ghost" icon="x" disabled={!server || !canConfigure} onClick={() => setDel(u)} title={!server ? '서버 연결 시' : !canConfigure ? 'PM · 관리자 · 소유자만' : undefined}>지우기</Button> },
          ]} />
      </Card>

      {del ? (
        <ConfirmModal title="업로드 지우기" confirmLabel="지우기" saving={delBusy} error={null} onClose={() => setDel(null)} onConfirm={doDelete}>
          <span className="small">{del.filename}({TEMPLATES[del.template as UploadTemplate]?.label ?? del.template})로 들어온 웨어하우스 데이터를 모두 지웁니다. 같은 기간에 다른 출처가 있으면 그 값이 다시 쓰입니다. 감사 로그에 남습니다.</span>
        </ConfirmModal>
      ) : null}
    </div>
  );
}
