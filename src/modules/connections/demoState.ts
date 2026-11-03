/**
 * 데모 모드(서버 없음 · claude.ai 아티팩트) 예시 상태 — 읽기 전용 (TEST DATA).
 * 서버에 연결하면 이 값 대신 실제 카탈로그 · 커넥션 · 수집 실행 · 품질 이슈를 API에서 읽는다.
 * 날짜는 데모 Dataset 기준일(today · currentHour)에 맞춰 만든다.
 */
import type { Dataset } from '@/core/types';
import type { CatalogProvider, ConnectionView, QualityItem, RunView, UploadView } from './model';
import { addDays } from './model';

const iso = (date: string, hour: number, minute = 0) => `${date}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00+09:00`;
const NONE = { reads: [], writes: [], intraday: false, maxBackfillDays: 0 };

/** 예시 카탈로그 — 자격증명 항목 · 기능은 구현된 커넥터 기준, 나머지는 서버 카탈로그에서 확인 */
export const DEMO_CATALOG: CatalogProvider[] = [
  { provider: 'naver_sa', kind: 'media', channel: 'naver_sa', label: '네이버 검색광고', docsUrl: 'https://naver.github.io/searchad-apidoc/', verifiedLive: false, sourceKind: 'api', defaultPriority: 100, available: true,
    credentialFields: [
      { key: 'apiKey', label: '액세스 라이선스 (API Key)', secret: true },
      { key: 'secretKey', label: '비밀키 (Secret Key)', secret: true },
      { key: 'customerId', label: '고객 ID (CUSTOMER_ID)', secret: false },
    ],
    capabilities: { reads: ['mediaDaily', 'mediaHourly', 'keywordDaily', 'keywords', 'campaigns', 'accounts'], writes: ['bid', 'budget', 'status'], intraday: true, maxBackfillDays: 400 } },
  { provider: 'google_ads', kind: 'media', channel: 'google', label: 'Google Ads', docsUrl: 'https://developers.google.com/google-ads/api/rest/overview', verifiedLive: false, sourceKind: 'api', defaultPriority: 100, available: true,
    credentialFields: [
      { key: 'clientId', label: 'OAuth 클라이언트 ID', secret: false },
      { key: 'clientSecret', label: 'OAuth 클라이언트 보안 비밀번호', secret: true },
      { key: 'refreshToken', label: '갱신 토큰 (refresh token)', secret: true },
      { key: 'customerId', label: '고객 ID', secret: false },
    ],
    capabilities: { reads: ['mediaDaily', 'mediaHourly', 'keywordDaily', 'searchTermDaily', 'campaigns'], writes: ['bid', 'budget', 'status'], intraday: true, maxBackfillDays: 400 } },
  { provider: 'meta', kind: 'media', channel: 'meta', label: 'Meta 광고', docsUrl: '', verifiedLive: false, sourceKind: 'api', defaultPriority: 100, available: true, credentialFields: [], capabilities: NONE },
  { provider: 'kakao_moment', kind: 'media', channel: 'kakao', label: '카카오모먼트', docsUrl: '', verifiedLive: false, sourceKind: 'api', defaultPriority: 100, available: true, credentialFields: [], capabilities: NONE },
  { provider: 'naver_gfa', kind: 'media', channel: 'naver_gfa', label: '네이버 성과형 디스플레이(GFA)', docsUrl: '', verifiedLive: false, sourceKind: 'api', defaultPriority: 100, available: true, credentialFields: [], capabilities: NONE },
  { provider: 'naver_commerce', kind: 'sales', channel: 'brandstore', label: '네이버 브랜드스토어(커머스 API)', docsUrl: '', verifiedLive: false, sourceKind: 'api', defaultPriority: 100, available: true, credentialFields: [], capabilities: NONE },
  { provider: 'coupang', kind: 'sales', channel: 'coupang', label: '쿠팡 Wing', docsUrl: '', verifiedLive: false, sourceKind: 'api', defaultPriority: 100, available: true, credentialFields: [], capabilities: NONE },
  { provider: 'cafe24', kind: 'sales', channel: 'own_mall', label: '카페24 자사몰', docsUrl: '', verifiedLive: false, sourceKind: 'api', defaultPriority: 100, available: true, credentialFields: [], capabilities: NONE },
  { provider: 'ohouse', kind: 'sales', channel: 'ohouse', label: '오늘의집', docsUrl: '', verifiedLive: false, sourceKind: 'api', defaultPriority: 100, available: true, credentialFields: [], capabilities: NONE },
  { provider: 'csv', kind: 'other', channel: null, label: 'CSV · TSV 업로드', docsUrl: 'https://www.rfc-editor.org/rfc/rfc4180', verifiedLive: false, sourceKind: 'csv', defaultPriority: 50, available: true, credentialFields: [],
    capabilities: { reads: ['mediaDaily', 'mediaHourly', 'salesDaily', 'keywordDaily', 'searchTermDaily', 'keywords'], writes: [], intraday: false, maxBackfillDays: 0 } },
  { provider: 'demo', kind: 'other', channel: null, label: '데모 데이터 (TEST DATA)', docsUrl: '', verifiedLive: false, sourceKind: 'demo', defaultPriority: 10, available: true, credentialFields: [],
    capabilities: { reads: ['mediaDaily', 'mediaHourly', 'salesDaily', 'keywordDaily', 'searchTermDaily', 'brandSearchDaily', 'keywords', 'campaigns', 'accounts', 'products', 'promotions'], writes: ['bid', 'budget', 'status'], intraday: true, maxBackfillDays: 400 } },
];

export interface ExampleState {
  catalog: CatalogProvider[];
  connections: ConnectionView[];
  runs: RunView[];
  quality: QualityItem[];
  uploads: UploadView[];
  nowMs: number;
}

export function exampleState(d: Pick<Dataset, 'today' | 'currentHour'>): ExampleState {
  const today = d.today;
  const h = d.currentHour;
  const y = addDays(today, -1);
  const cat = (p: string) => DEMO_CATALOG.find((c) => c.provider === p)!;
  const base = (p: string) => ({ providerLabel: cat(p).label, verifiedLive: false, docsUrl: cat(p).docsUrl, capabilities: cat(p).capabilities, settings: {} });
  const demoRun: RunView = {
    id: 'ex-run-1', job: 'intraday', status: 'succeeded', rowsIn: 140, rowsWritten: 140, issueCounts: { error: 0, warning: 0, info: 0 }, error: null,
    rangeFrom: today, rangeTo: today, startedAt: iso(today, h, 10), finishedAt: iso(today, h, 10), connectionId: 'ex-demo', uploadId: null, source: 'demo',
    trigger: 'schedule', label: '데모 데이터 (TEST DATA)', provider: 'demo', issues: [], stats: { mediaHourly: 96, campaigns: 16, accounts: 7 }, durationMs: 840,
  };
  const dailyRun: RunView = {
    ...demoRun, id: 'ex-run-2', job: 'daily', rowsIn: 1260, rowsWritten: 1260, rangeFrom: addDays(today, -3), rangeTo: y, startedAt: iso(today, 7, 0), finishedAt: iso(today, 7, 0),
    issueCounts: { error: 0, warning: 0, info: 1 }, durationMs: 2300,
    issues: [{ code: 'keyword_media_mismatch', severity: 'info', message: '데모 키워드는 대표 28개 표본이라 네이버 SA 매체 합계와 다릅니다 (3일, TEST DATA)' }],
    stats: { mediaDaily: 18, mediaHourly: 432, salesDaily: 12, keywordDaily: 84, searchTermDaily: 45, keywords: 28 },
  };
  const uploadRun: RunView = {
    id: 'ex-run-3', job: 'upload', status: 'partial', rowsIn: 62, rowsWritten: 30, issueCounts: { error: 1, warning: 1, info: 1 }, error: null,
    rangeFrom: addDays(today, -30), rangeTo: y, startedAt: iso(y, 18, 42), finishedAt: iso(y, 18, 42), connectionId: 'ex-csv', uploadId: 'ex-upload-1', source: 'csv:ex-upload-1',
    trigger: 'upload', label: '업로드 · GFA_일별보고서_10월.csv', provider: 'csv', durationMs: 410, stats: { mediaDaily: 30 },
    issues: [
      { code: 'invalid_rows', severity: 'error', message: '형식 오류로 제외한 행 2개 — 예: 33행 일자 \'합계\' 형식 오류 / 34행 일자 \'\' 형식 오류' },
      { code: 'duplicate_keys', severity: 'warning', message: '같은 일자 · 매체 행 30개를 합산했습니다 (캠페인 · 광고그룹별 행이면 정상, 같은 내용을 두 번 붙여 넣었다면 확인 필요)' },
      { code: 'unmapped_columns', severity: 'info', message: '사용하지 않는 열 2개: 캠페인명, 광고그룹명' },
    ],
  };
  const failedRun: RunView = {
    id: 'ex-run-4', job: 'backfill', status: 'failed', rowsIn: 0, rowsWritten: 0, issueCounts: { error: 0, warning: 0, info: 0 }, error: '연결 확인 전 수집 시도 — 자격증명 항목을 확인해 주세요: apiKey, secretKey',
    rangeFrom: addDays(today, -31), rangeTo: y, startedAt: iso(y, 11, 5), finishedAt: iso(y, 11, 5), connectionId: 'ex-sa', uploadId: null, source: 'ex-sa',
    trigger: 'manual', label: '네이버 검색광고 (본계정)', provider: 'naver_sa', issues: [], stats: {}, durationMs: 120,
  };
  const connections: ConnectionView[] = [
    { id: 'ex-demo', provider: 'demo', ...base('demo'), kind: 'other', channel: null, label: '데모 데이터 (TEST DATA)', status: 'active', writeMode: 'dry_run', priority: 10, sourceKind: 'demo', source: 'demo',
      credentials: {}, hasCredentials: false, lastTestAt: iso(addDays(today, -7), 10, 0), lastSyncAt: iso(today, h, 10), lastError: null, createdAt: iso(addDays(today, -7), 10, 0), updatedAt: iso(today, h, 10), pendingJobs: 0, lastRun: demoRun },
    { id: 'ex-sa', provider: 'naver_sa', ...base('naver_sa'), kind: 'media', channel: 'naver_sa', label: '네이버 검색광고 (본계정)', status: 'pending', writeMode: 'dry_run', priority: 100, sourceKind: 'api', source: 'ex-sa',
      credentials: { apiKey: null, secretKey: null, customerId: '1234567' }, hasCredentials: true, lastTestAt: null, lastSyncAt: null, lastError: null, createdAt: iso(y, 11, 0), updatedAt: iso(y, 11, 0), pendingJobs: 0, lastRun: failedRun },
    { id: 'ex-csv', provider: 'csv', ...base('csv'), kind: 'other', channel: 'naver_gfa', label: 'GFA 보고서 업로드', status: 'active', writeMode: 'off', priority: 50, sourceKind: 'csv', source: 'ex-csv',
      credentials: {}, hasCredentials: false, lastTestAt: null, lastSyncAt: iso(y, 18, 42), lastError: null, createdAt: iso(addDays(today, -3), 9, 0), updatedAt: iso(y, 18, 42), pendingJobs: 0, lastRun: uploadRun },
  ];
  const q = (r: RunView, i: RunView['issues'][number]): QualityItem => ({ ...i, runId: r.id, connectionId: r.connectionId, uploadId: r.uploadId, label: r.label, provider: r.provider, job: r.job, at: r.finishedAt });
  const quality: QualityItem[] = [
    { code: 'run_failed', severity: 'error', message: `마지막 수집 실패: ${failedRun.error}`, runId: failedRun.id, connectionId: 'ex-sa', uploadId: null, label: failedRun.label, provider: 'naver_sa', job: 'backfill', at: failedRun.finishedAt },
    q(uploadRun, uploadRun.issues[0]),
    { code: 'not_tested', severity: 'info', message: '연결 확인 전입니다 — 자격증명을 넣고 연결 확인을 눌러 주세요', runId: null, connectionId: 'ex-sa', uploadId: null, label: '네이버 검색광고 (본계정)', provider: 'naver_sa', job: null, at: iso(y, 11, 0) },
    q(uploadRun, uploadRun.issues[1]),
    q(dailyRun, dailyRun.issues[0]),
    q(uploadRun, uploadRun.issues[2]),
  ];
  const uploads: UploadView[] = [
    { id: 'ex-upload-1', connectionId: 'ex-csv', template: 'media_daily', filename: 'GFA_일별보고서_10월.csv', bytes: 6_410, mapping: { date: '일자', cost: '총비용(VAT포함)', impressions: '노출수', clicks: '클릭수', conversions: '전환수', revenue: '전환매출액' },
      channel: 'naver_gfa', status: 'imported', summary: { rows: 62, records: 30, invalidRows: 2, dateFrom: addDays(today, -30), dateTo: y }, createdAt: iso(y, 18, 41), importedAt: iso(y, 18, 42) },
  ];
  return { catalog: DEMO_CATALOG, connections, runs: [demoRun, dailyRun, uploadRun, failedRun], quality, uploads, nowMs: Date.parse(iso(today, h, 30)) };
}
