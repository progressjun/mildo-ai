/**
 * CSV · TSV 업로드 엔진 (순수 모듈 — 서버 업로드 수집과 화면 미리보기가 같이 쓴다. React · DOM 없음).
 *  - RFC 4180 파서: 따옴표 필드 · 이스케이프된 따옴표("") · 필드 안 줄바꿈 · CRLF/LF · UTF-8 BOM · 구분자 , ; 탭 자동 감지
 *  - 템플릿 5종: 매체 일별 · 매체 시간대 · 판매 채널 일별 · 키워드 일별 · 검색어 일별
 *  - 한글/영문 열 이름 별칭 → 템플릿 필드, 매체 · 판매 채널 값 별칭 → MediaId · SalesChannelId
 *  - 숫자: 천 단위 쉼표 · ₩ · 원 · % · 공백 · 빈칸(0) · (1,234) 음수 / 날짜: YYYY-MM-DD · YYYY.MM.DD · YYYY/MM/DD · YYYYMMDD
 * 정규화 결과 레코드는 서버 NormalizedBatch 행과 같은 모양이다 (server/src/connectors/types.ts).
 */
import type { MediaId, SalesChannelId } from '@/core/types';

export type UploadTemplate = 'media_daily' | 'media_hourly' | 'sales_daily' | 'keyword_daily' | 'search_term_daily';
export const UPLOAD_TEMPLATES: UploadTemplate[] = ['media_daily', 'media_hourly', 'sales_daily', 'keyword_daily', 'search_term_daily'];
export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;

export type FieldType = 'date' | 'hour' | 'media' | 'channel' | 'int' | 'money' | 'decimal' | 'text';

export interface TemplateField {
  key: string;
  label: string;
  type: FieldType;
  required: boolean;
  /** 열 이름 별칭 (비교 전 normalizeHeader 적용) */
  aliases: string[];
  example: string;
}

export interface TemplateDef {
  id: UploadTemplate;
  label: string;
  description: string;
  /** 수집 표준 레코드 종류 (NormalizedBatch 키) */
  target: 'mediaDaily' | 'mediaHourly' | 'salesDaily' | 'keywordDaily' | 'searchTermDaily';
  /** 행 키 (중복 판정 · 합산 기준) */
  keyFields: string[];
  fields: TemplateField[];
  /** 고정 매체 · 채널을 화면에서 고를 수 있는지 (열이 없을 때) */
  fixedChannel?: 'media' | 'channel';
}

const F = (key: string, label: string, type: FieldType, required: boolean, aliases: string[], example: string): TemplateField => ({ key, label, type, required, aliases, example });

const DATE = F('date', '일자', 'date', true, ['일자', '날짜', 'date', '기간', 'day', '일', '보고일', '집계일', '통계일', '통계일자', '기준일', '기준일자', 'reportdate', 'statdate', 'dt'], '2026-10-30');
const MEDIA_F = F('media', '매체', 'media', true, ['매체', '매체명', 'media', '광고매체', 'platform', '플랫폼', 'publisher', '광고플랫폼'], 'naver_sa');
const IMPS = F('impressions', '노출', 'int', false, ['노출', '노출수', 'impressions', 'impression', 'impr', 'imps', '노출량'], '120000');
const CLICKS = F('clicks', '클릭', 'int', false, ['클릭', '클릭수', 'clicks', 'click', 'clk'], '2400');
const COST = F('cost', '광고비', 'money', true, ['광고비', '비용', '총비용', 'cost', 'spend', '소진액', '소진금액', '집행금액', '광고비용', 'amountspent', '지출금액', '광고비vat포함', '총비용vat포함', '사용금액'], '1850000');
const CONV = F('conversions', '전환', 'decimal', false, ['전환', '전환수', 'conversions', 'conversion', 'conv', '구매', '구매수', '총전환수', '구매완료', '결과'], '21');
const REV = F('revenue', '전환매출', 'money', false, ['전환매출', '전환매출액', '매출', '매출액', 'revenue', 'conversionvalue', '구매금액', '총전환매출액', '전환가치', '구매전환매출', 'purchasevalue'], '22000000');

export const TEMPLATES: Record<UploadTemplate, TemplateDef> = {
  media_daily: {
    id: 'media_daily', label: '매체 일별', target: 'mediaDaily', keyFields: ['date', 'media'], fixedChannel: 'media',
    description: '매체별 하루 합계 (광고비 · 노출 · 클릭 · 전환 · 전환매출). 매체 보고서를 일자 · 매체 기준으로 내려받은 파일',
    fields: [DATE, MEDIA_F, IMPS, CLICKS, COST, CONV, REV, F('newCustomers', '신규 고객', 'decimal', false, ['신규고객', '신규고객수', '신규구매자', 'newcustomers', '신규'], '13')],
  },
  media_hourly: {
    id: 'media_hourly', label: '매체 시간대', target: 'mediaHourly', keyFields: ['date', 'hour', 'media'], fixedChannel: 'media',
    description: '매체별 시간대(0~23시) 합계. 당일 이상 감지 · 시간대 분석에 쓰인다',
    fields: [DATE, F('hour', '시간대', 'hour', true, ['시간', '시간대', 'hour', '시', '시각', 'hourofday', '시간구분'], '21'), MEDIA_F, IMPS, CLICKS, COST, CONV, REV],
  },
  sales_daily: {
    id: 'sales_daily', label: '판매 채널 일별', target: 'salesDaily', keyFields: ['date', 'channel'], fixedChannel: 'channel',
    description: '판매 채널(브랜드스토어 · 오늘의집 · 쿠팡 · 자사몰) 하루 실매출 · 주문 · 방문',
    fields: [
      DATE,
      F('channel', '판매 채널', 'channel', true, ['채널', '판매채널', 'channel', '스토어', '쇼핑몰', '몰', 'store', '판매처', '마켓'], 'brandstore'),
      F('visitors', '방문자', 'int', false, ['방문자', '방문자수', 'visitors', '유입수', '유입', '세션', 'sessions', '방문수', 'uv'], '5400'),
      F('detailViews', '상세 조회', 'int', false, ['상세조회', '상품상세조회', '상세페이지조회', 'detailviews', 'pdp', '상품조회수', '상세조회수', 'productviews'], '3000'),
      F('carts', '장바구니', 'int', false, ['장바구니', '장바구니수', 'carts', 'addtocart', '장바구니담기', 'cart'], '290'),
      F('orders', '주문', 'int', true, ['주문', '주문수', 'orders', '결제건수', '주문건수', '구매건수', '결제수'], '110'),
      F('revenue', '매출', 'money', true, ['매출', '매출액', '결제금액', '주문금액', 'revenue', 'sales', '실매출', '총매출', '판매금액', '결제액'], '113000000'),
      F('adAttributedRevenue', '광고 경유 매출', 'money', false, ['광고매출', '광고경유매출', 'adrevenue', 'adattributedrevenue', '광고기여매출'], '79000000'),
    ],
  },
  keyword_daily: {
    id: 'keyword_daily', label: '키워드 일별', target: 'keywordDaily', keyFields: ['date', 'keywordKey'],
    description: '네이버 검색광고 키워드별 하루 성과. 키워드 ID가 없으면 키워드 문구로 맞춘다',
    fields: [
      DATE,
      F('keyword', '키워드', 'text', false, ['키워드', 'keyword', '키워드명', '검색키워드'], '퀸 매트리스'),
      F('keywordId', '키워드 ID', 'text', false, ['키워드id', 'keywordid', '키워드아이디', 'ncckeywordid', 'kwid'], ''),
      F('campaign', '캠페인', 'text', false, ['캠페인', 'campaign', '캠페인명', 'campaignname'], 'SA_일반 제품'),
      F('adgroup', '광고그룹', 'text', false, ['광고그룹', 'adgroup', '광고그룹명', '그룹', 'adgroupname'], 'GENERIC_MAIN'),
      IMPS, CLICKS, COST, CONV, REV,
      F('avgRank', '평균 노출 순위', 'decimal', false, ['평균순위', '평균노출순위', 'avgrank', 'avgposition', '순위', '평균노출위치'], '3.1'),
      F('bid', '입찰가', 'money', false, ['입찰가', 'bid', '현재입찰가', 'bidamt'], '1450'),
    ],
  },
  search_term_daily: {
    id: 'search_term_daily', label: '검색어 일별', target: 'searchTermDaily', keyFields: ['date', 'term'],
    description: '실제 검색어(검색어 보고서) 하루 성과. 미등록 구문형 키워드 후보 발굴에 쓰인다',
    fields: [DATE, F('term', '검색어', 'text', true, ['검색어', 'searchterm', 'term', '검색어명', 'query', '검색질의', '실제검색어'], '신혼집 매트리스 사이즈'), IMPS, CLICKS, { ...COST, required: false }, CONV, REV],
  },
};

/* ---------- 값 별칭 ---------- */

const MEDIA_ALIASES: Record<MediaId, string[]> = {
  naver_sa: ['naversa', '네이버sa', '네이버검색광고', '검색광고', '파워링크', '네이버파워링크', 'sa', '네이버검색', '쇼핑검색', '네이버쇼핑검색광고'],
  naver_gfa: ['navergfa', 'gfa', '네이버gfa', '성과형디스플레이', '네이버성과형디스플레이', '네이버디스플레이'],
  google: ['google', '구글', 'googleads', '구글애즈', '구글광고', 'youtube', '유튜브', 'adwords'],
  meta: ['meta', '메타', 'facebook', '페이스북', 'instagram', '인스타그램', 'fb', 'metaads'],
  kakao: ['kakao', '카카오', '카카오모먼트', 'kakaomoment', '모먼트', '카카오광고'],
  vertical: ['vertical', '버티컬', '쿠팡광고', '오늘의집광고', '쿠팡', '오늘의집', '버티컬신규'],
};
const CHANNEL_ALIASES: Record<SalesChannelId, string[]> = {
  brandstore: ['brandstore', '브랜드스토어', '네이버브랜드스토어', '스마트스토어', '네이버스마트스토어', 'smartstore', '네이버스토어', '네이버'],
  ohouse: ['ohouse', '오늘의집', '오집', 'todayhouse', 'bucketplace'],
  coupang: ['coupang', '쿠팡', '쿠팡윙', 'wing', '쿠팡로켓'],
  own_mall: ['ownmall', '자사몰', '카페24', 'cafe24', '공식몰', '홈페이지', '공홈'],
};

/** 열 이름 비교용: 소문자 · 괄호 안 단위 제거 · 공백/기호 제거 */
export function normalizeHeader(h: string): string {
  return String(h ?? '')
    .replace(/^﻿/, '')
    .toLowerCase()
    .replace(/\((?:원|krw|₩|%|건|회|vat\s*포함|vat\s*별도|vat)\)/g, '')
    .replace(/[\s_\-./·:()[\]{}"'*#]/g, '');
}
const normValue = (v: string) => String(v ?? '').toLowerCase().replace(/[\s_\-./·()]/g, '');

export function parseMedia(v: string): MediaId | null {
  const n = normValue(v);
  if (!n) return null;
  for (const [id, al] of Object.entries(MEDIA_ALIASES) as [MediaId, string[]][]) if (n === normValue(id) || al.includes(n)) return id;
  return null;
}
export function parseChannel(v: string): SalesChannelId | null {
  const n = normValue(v);
  if (!n) return null;
  for (const [id, al] of Object.entries(CHANNEL_ALIASES) as [SalesChannelId, string[]][]) if (n === normValue(id) || al.includes(n)) return id;
  return null;
}

/* ---------- RFC 4180 파서 ---------- */

export interface ParsedCsv {
  headers: string[];
  rows: string[][];
  delimiter: ',' | ';' | '\t';
  /** 파서 경고 (닫히지 않은 따옴표 · 열 수 불일치) */
  warnings: { line: number; message: string }[];
}

/** 첫 줄(따옴표 밖)에서 가장 많이 나온 구분자 */
export function detectDelimiter(text: string): ',' | ';' | '\t' {
  const counts = { ',': 0, ';': 0, '\t': 0 } as Record<',' | ';' | '\t', number>;
  let inQ = false;
  for (let i = 0; i < text.length && i < 64_000; i++) {
    const ch = text[i];
    if (ch === '"') inQ = !inQ;
    else if (!inQ && (ch === '\n' || ch === '\r')) break;
    else if (!inQ && (ch === ',' || ch === ';' || ch === '\t')) counts[ch]++;
  }
  if (counts['\t'] > 0 && counts['\t'] >= counts[','] && counts['\t'] >= counts[';']) return '\t';
  if (counts[';'] > counts[',']) return ';';
  return ',';
}

export function parseCsv(input: string, opts: { delimiter?: ',' | ';' | '\t' } = {}): ParsedCsv {
  const text = String(input ?? '').replace(/^﻿/, '');
  const delimiter = opts.delimiter ?? detectDelimiter(text);
  const records: string[][] = [];
  const warnings: ParsedCsv['warnings'] = [];
  let field = '';
  let row: string[] = [];
  let inQuotes = false;
  let line = 1;
  let rowLine = 1;
  let quotedField = false;
  const pushField = () => {
    row.push(quotedField ? field : field.trim());
    field = '';
    quotedField = false;
  };
  const pushRow = () => {
    pushField();
    if (!(row.length === 1 && row[0] === '')) records.push(row);
    row = [];
    rowLine = line;
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else {
        if (ch === '\n') line++;
        field += ch;
      }
      continue;
    }
    if (ch === '"') {
      if (field.trim() === '') { field = ''; inQuotes = true; quotedField = true; }
      else field += ch; // 필드 중간 따옴표는 글자로 취급 (관대한 처리)
    } else if (ch === delimiter) {
      pushField();
    } else if (ch === '\r') {
      if (text[i + 1] === '\n') i++;
      line++;
      pushRow();
    } else if (ch === '\n') {
      line++;
      pushRow();
    } else {
      field += ch;
    }
  }
  if (inQuotes) warnings.push({ line: rowLine, message: '닫히지 않은 따옴표가 있습니다 — 파일 끝까지 한 칸으로 읽었습니다' });
  if (field !== '' || row.length) pushRow();
  const headers = (records.shift() ?? []).map((h) => h.replace(/^﻿/, '').trim());
  const rows: string[][] = [];
  records.forEach((r, idx) => {
    if (r.every((c) => c === '')) return;
    if (r.length !== headers.length && warnings.length < 20) warnings.push({ line: idx + 2, message: `열 수가 머리글(${headers.length})과 다릅니다 (${r.length})` });
    rows.push(r);
  });
  return { headers, rows, delimiter, warnings };
}

/* ---------- 값 해석 ---------- */

/** 숫자: 쉼표 · ₩ · 원 · % · 공백 제거, 빈칸 · '-' → 0, (1,234) → -1234. 해석 불가 → NaN */
export function parseNumber(v: string | number | null | undefined): number {
  if (typeof v === 'number') return Number.isFinite(v) ? v : NaN;
  let s = String(v ?? '').trim();
  if (s === '' || s === '-' || s === '–' || s === '—' || s.toLowerCase() === 'n/a' || s === '--') return 0;
  let neg = false;
  if (/^\(.*\)$/.test(s)) { neg = true; s = s.slice(1, -1); }
  s = s.replace(/[\s ,₩원%]/g, '').replace(/^krw/i, '').replace(/krw$/i, '');
  if (s === '' || s === '-') return 0;
  if (!/^[-+]?(\d+(\.\d*)?|\.\d+)(e[-+]?\d+)?$/i.test(s)) return NaN;
  const n = Number(s);
  return Number.isFinite(n) ? (neg ? -n : n) : NaN;
}

function validYmd(y: number, m: number, d: number): string | null {
  if (y < 2000 || y > 2100 || m < 1 || m > 12 || d < 1 || d > 31) return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/** 날짜: YYYY-MM-DD · YYYY.MM.DD(.) · YYYY/MM/DD · YYYYMMDD (뒤에 붙은 요일 · 시각은 무시). 해석 불가 → null */
export function parseDate(v: string | null | undefined): string | null {
  const s = String(v ?? '').trim().replace(/^﻿/, '');
  if (!s) return null;
  let m = s.match(/^(\d{4})[-./](\d{1,2})[-./](\d{1,2})\.?(?:$|[\sT(])/);
  if (m) return validYmd(Number(m[1]), Number(m[2]), Number(m[3]));
  m = s.match(/^(\d{4})(\d{2})(\d{2})(?:$|[\sT(])/);
  if (m) return validYmd(Number(m[1]), Number(m[2]), Number(m[3]));
  m = s.match(/^(\d{4})년\s*(\d{1,2})월\s*(\d{1,2})일/);
  if (m) return validYmd(Number(m[1]), Number(m[2]), Number(m[3]));
  return null;
}

/** 시간대: '21' · '21시' · '21:00' · '21~22시' · '21-22' → 21 (0~23 밖이면 null) */
export function parseHour(v: string | null | undefined): number | null {
  const s = String(v ?? '').trim();
  const m = s.match(/^(\d{1,2})/);
  if (!m) return null;
  const h = Number(m[1]);
  return h >= 0 && h <= 23 ? h : null;
}

/* ---------- 열 매핑 ---------- */

export interface ColumnMapping {
  /** 템플릿 필드 → CSV 열 이름 (없으면 null) */
  fields: Record<string, string | null>;
  /** 필수인데 찾지 못한 필드 */
  missing: string[];
  /** 어떤 필드에도 매핑되지 않은 CSV 열 */
  unmapped: string[];
}

/** 별칭으로 자동 매핑 → 사용자가 준 mapping으로 덮어쓰기 (값 '' · null은 '사용 안 함') */
export function resolveMapping(template: UploadTemplate, headers: string[], user?: Record<string, string | null | undefined>, opts: { fixedChannel?: boolean } = {}): ColumnMapping {
  const def = TEMPLATES[template];
  const norm = headers.map(normalizeHeader);
  const fields: Record<string, string | null> = {};
  const used = new Set<number>();
  for (const f of def.fields) {
    const aliases = new Set([normalizeHeader(f.key), ...f.aliases.map(normalizeHeader)]);
    let idx = norm.findIndex((h, i) => !used.has(i) && aliases.has(h));
    if (idx < 0) idx = norm.findIndex((h, i) => !used.has(i) && h.length > 1 && [...aliases].some((a) => a.length >= 2 && h.startsWith(a) && /^(수|액|금액|합계|vat포함|vat별도|총)?$/.test(h.slice(a.length))));
    fields[f.key] = idx >= 0 ? headers[idx] : null;
    if (idx >= 0) used.add(idx);
  }
  for (const [k, v] of Object.entries(user ?? {})) {
    if (!def.fields.some((f) => f.key === k)) continue;
    if (v === undefined) continue;
    fields[k] = v && headers.includes(v) ? v : null;
  }
  const missing = def.fields
    .filter((f) => f.required && !fields[f.key])
    .filter((f) => !(opts.fixedChannel && ((def.fixedChannel === 'media' && f.key === 'media') || (def.fixedChannel === 'channel' && f.key === 'channel'))))
    .map((f) => f.key);
  if (template === 'keyword_daily' && !fields.keyword && !fields.keywordId) missing.push('keyword');
  const mapped = new Set(Object.values(fields).filter(Boolean) as string[]);
  return { fields, missing, unmapped: headers.filter((h) => h && !mapped.has(h)) };
}

/* ---------- 정규화 ---------- */

export interface CsvIssue {
  code: string;
  severity: 'error' | 'warning' | 'info';
  message: string;
  detail?: unknown;
}

export interface MediaDailyRecord { date: string; media: MediaId; impressions: number; clicks: number; cost: number; conversions: number; revenue: number; newCustomers?: number }
export interface MediaHourlyRecord { date: string; hour: number; media: MediaId; impressions: number; clicks: number; cost: number; conversions: number; revenue: number }
export interface SalesDailyRecord { date: string; channel: SalesChannelId; visitors: number; detailViews: number; carts: number; orders: number; revenue: number; adAttributedRevenue?: number }
export interface KeywordDailyRecord { date: string; keywordKey: string; keywordId: string | null; keyword: string | null; campaign: string | null; adgroup: string | null; impressions: number; clicks: number; cost: number; conversions: number; revenue: number; avgRank: number | null; bid: number | null }
export interface SearchTermDailyRecord { date: string; term: string; impressions: number; clicks: number; cost: number; conversions: number; revenue: number }

export type CsvRecord = MediaDailyRecord | MediaHourlyRecord | SalesDailyRecord | KeywordDailyRecord | SearchTermDailyRecord;

export interface NormalizeResult<R = CsvRecord> {
  template: UploadTemplate;
  mapping: ColumnMapping;
  /** 키별 합산 후 레코드 (음수 지표 · 미래 날짜 레코드는 뺀 뒤) */
  records: R[];
  /** 앞 20행 (합산 전, 정규화 결과 — 제외된 행은 넣지 않는다) */
  preview: (R & { _line: number })[];
  issues: CsvIssue[];
  summary: {
    rows: number; validRows: number;
    /** 제외한 행 전체 (형식 오류 + 템플릿 예시 행 + 음수 지표 + 미래 날짜) */
    invalidRows: number;
    records: number; dateFrom: string | null; dateTo: string | null; channels: string[]; delimiter: string; headers: string[];
    /** 제외 사유별 행 수 */
    excluded?: { format: number; example: number; negative: number; future: number };
  };
}

const METRIC_KEYS = ['impressions', 'clicks', 'cost', 'conversions', 'revenue', 'newCustomers', 'visitors', 'detailViews', 'carts', 'orders', 'adAttributedRevenue'];
const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * 행 단위 오류 — 그 행(레코드)만 빼고 가져온다(가져오기를 막지 않는다). 서버 품질 검사(server/src/ingest/quality.ts)와 같은 코드:
 * invalid_rows(형식) · negative_values(음수 지표) · future_dates(오늘 이후 날짜)
 */
export const ROW_LEVEL_ERROR_CODES = ['invalid_rows', 'negative_values', 'future_dates'] as const;

/** 템플릿 예시 행 표시 — 템플릿 파일의 예시 행 일자 칸에 붙는다. 일자 칸에 이 글자가 있는 행은 실제 데이터로 가져오지 않는다 */
export const TEMPLATE_EXAMPLE_MARK = '예시';
export const TEMPLATE_EXAMPLE_NOTE = `(${TEMPLATE_EXAMPLE_MARK} 행 — 지우고 쓰세요)`;

export interface NormalizeOptions {
  mapping?: Record<string, string | null | undefined>;
  /** 매체 · 채널 열이 없을 때 모든 행에 쓸 값 */
  channel?: string | null;
  delimiter?: ',' | ';' | '\t';
  previewRows?: number;
  /**
   * 기준일 (KST YYYY-MM-DD). 주면 이 날 이후 날짜 레코드를 future_dates로 뺀다 — 서버 수집 품질 검사와 같은 기준(오늘까지 허용).
   * 음수 지표(negative_values)는 기준일과 상관없이 항상 뺀다.
   */
  today?: string | null;
}

/** 템플릿 파일에 들어가는 필드 (키워드 일별의 키워드 ID는 템플릿에 없다) */
function templateFields(template: UploadTemplate): TemplateField[] {
  return TEMPLATES[template].fields.filter((f) => !(template === 'keyword_daily' && f.key === 'keywordId'));
}

/** 템플릿 예시 값을 행 값과 같은 방식으로 해석 (예시 행 판정용) */
function parsedExample(f: TemplateField): unknown {
  switch (f.type) {
    case 'date': return parseDate(f.example);
    case 'hour': return parseHour(f.example);
    case 'media': return parseMedia(f.example);
    case 'channel': return parseChannel(f.example);
    case 'int': return Math.round(parseNumber(f.example));
    case 'money': return Math.round(parseNumber(f.example) * 100) / 100;
    case 'decimal': return round2(parseNumber(f.example));
    default: return f.example.trim() || null;
  }
}

const numKo = (n: number) => (Number.isFinite(n) ? n.toLocaleString('ko-KR') : String(n));
const linesText = (lines: number[], max = 3) => `${lines.slice(0, max).join('·')}${lines.length > max ? '…' : ''}행`;

export function normalizeCsv(template: UploadTemplate, content: string, opts: NormalizeOptions = {}): NormalizeResult {
  const def = TEMPLATES[template];
  const parsed = parseCsv(content, { delimiter: opts.delimiter });
  const issues: CsvIssue[] = parsed.warnings.slice(0, 10).map((w) => ({ code: 'csv_format', severity: 'warning' as const, message: `${w.line}행: ${w.message}` }));
  const fixed = opts.channel ? (def.fixedChannel === 'media' ? parseMedia(opts.channel) : def.fixedChannel === 'channel' ? parseChannel(opts.channel) : null) : null;
  if (opts.channel && def.fixedChannel && !fixed) issues.push({ code: 'unknown_channel', severity: 'error', message: `고정 ${def.fixedChannel === 'media' ? '매체' : '판매 채널'} 값 '${opts.channel}'을(를) 알 수 없습니다` });
  const mapping = resolveMapping(template, parsed.headers, opts.mapping, { fixedChannel: !!fixed });
  const summaryBase = { delimiter: parsed.delimiter === '\t' ? 'tab' : parsed.delimiter, headers: parsed.headers };
  if (!parsed.headers.length) {
    issues.push({ code: 'empty_file', severity: 'error', message: '파일이 비어 있거나 머리글 행이 없습니다' });
    return { template, mapping, records: [], preview: [], issues, summary: { rows: 0, validRows: 0, invalidRows: 0, records: 0, dateFrom: null, dateTo: null, channels: [], ...summaryBase } };
  }
  if (mapping.missing.length) {
    const labels = mapping.missing.map((k) => def.fields.find((f) => f.key === k)?.label ?? k);
    issues.push({ code: 'missing_columns', severity: 'error', message: `필수 열을 찾지 못했습니다: ${labels.join(', ')} — 열 매핑에서 직접 고르거나 템플릿 머리글을 쓰세요`, detail: { missing: mapping.missing, headers: parsed.headers } });
  }
  if (mapping.unmapped.length) issues.push({ code: 'unmapped_columns', severity: 'info', message: `사용하지 않는 열 ${mapping.unmapped.length}개: ${mapping.unmapped.slice(0, 8).join(', ')}${mapping.unmapped.length > 8 ? ' …' : ''}` });
  const colIdx: Record<string, number> = {};
  for (const [k, h] of Object.entries(mapping.fields)) colIdx[k] = h ? parsed.headers.indexOf(h) : -1;

  const rowErrors: { line: number; message: string }[] = [];
  let invalid = 0;
  /** 미리보기 후보 (합산 전 · 앞쪽 행만) — 음수 · 미래 날짜로 빠지는 키는 합산 뒤에 걸러 낸다 */
  const PREVIEW_CANDIDATES = 5000;
  const candidates: { key: string; rec: CsvRecord & { _line: number } }[] = [];
  const agg = new Map<string, CsvRecord>();
  const keyLines = new Map<string, number[]>();
  let dupRows = 0;
  const previewN = opts.previewRows ?? 20;
  const fatal = mapping.missing.length > 0 || issues.some((i) => i.code === 'unknown_channel');
  // 템플릿 예시 행: 일자 칸에 '예시' 표시가 있거나, 템플릿 필드가 모두 매핑돼 있고 값이 예시와 전부 같은 행 (표시 없는 예전 템플릿)
  const exFields = templateFields(template);
  const exValues = Object.fromEntries(exFields.map((f) => [f.key, parsedExample(f)]));
  const exComparable = exFields.every((f) => colIdx[f.key] >= 0 || (!!fixed && (f.type === 'media' || f.type === 'channel')));
  const exampleLines: number[] = [];

  if (!fatal) {
    parsed.rows.forEach((cells, i) => {
      const line = i + 2;
      const get = (k: string) => (colIdx[k] >= 0 ? cells[colIdx[k]] ?? '' : '');
      if (colIdx.date >= 0 && get('date').includes(TEMPLATE_EXAMPLE_MARK)) { exampleLines.push(line); return; }
      const errs: string[] = [];
      const rec: Record<string, unknown> = {};
      for (const f of def.fields) {
        if (colIdx[f.key] < 0) {
          if (f.type === 'media' || f.type === 'channel') rec[f.key] = fixed;
          else if (f.type === 'int' || f.type === 'money' || f.type === 'decimal') rec[f.key] = f.key === 'avgRank' || f.key === 'bid' ? null : 0;
          else rec[f.key] = null;
          continue;
        }
        const raw = get(f.key);
        switch (f.type) {
          case 'date': {
            const d = parseDate(raw);
            if (!d) errs.push(`${f.label} '${raw}' 형식 오류`);
            rec[f.key] = d;
            break;
          }
          case 'hour': {
            const h = parseHour(raw);
            if (h === null) errs.push(`${f.label} '${raw}' 형식 오류 (0~23)`);
            rec[f.key] = h;
            break;
          }
          case 'media': {
            const m = raw.trim() ? parseMedia(raw) : fixed;
            if (!m) errs.push(`${f.label} '${raw}'을(를) 알 수 없습니다`);
            rec[f.key] = m;
            break;
          }
          case 'channel': {
            const c = raw.trim() ? parseChannel(raw) : fixed;
            if (!c) errs.push(`${f.label} '${raw}'을(를) 알 수 없습니다`);
            rec[f.key] = c;
            break;
          }
          case 'int':
          case 'money':
          case 'decimal': {
            const n = parseNumber(raw);
            if (!Number.isFinite(n)) errs.push(`${f.label} '${raw}' 숫자 아님`);
            const optionalNull = (f.key === 'avgRank' || f.key === 'bid') && raw.trim() === '';
            rec[f.key] = optionalNull ? null : f.type === 'int' ? Math.round(n) : f.type === 'money' ? Math.round(n * 100) / 100 : round2(n);
            break;
          }
          default:
            rec[f.key] = raw.trim() || null;
        }
      }
      if (template === 'keyword_daily') {
        const kid = (rec.keywordId as string | null) ?? null;
        const kw = (rec.keyword as string | null) ?? null;
        if (!kid && !kw) errs.push('키워드 · 키워드 ID가 모두 비어 있습니다');
        rec.keywordKey = kid ? `id:${kid}` : `text:${(kw ?? '').replace(/\s+/g, ' ').trim()}`;
      }
      if (template === 'search_term_daily' && !rec.term) errs.push('검색어가 비어 있습니다');
      if (errs.length) {
        invalid++;
        if (rowErrors.length < 50) rowErrors.push({ line, message: errs.join(' · ') });
        return;
      }
      if (exComparable && exFields.every((f) => colIdx[f.key] < 0 || rec[f.key] === exValues[f.key])) { exampleLines.push(line); return; }
      const r = rec as unknown as CsvRecord;
      const key = def.keyFields.map((k) => String(rec[k])).join('|');
      if (candidates.length < PREVIEW_CANDIDATES) candidates.push({ key, rec: { ...(r as object), _line: line } as CsvRecord & { _line: number } });
      const ls = keyLines.get(key);
      if (ls) ls.push(line); else keyLines.set(key, [line]);
      const prev = agg.get(key) as Record<string, unknown> | undefined;
      if (!prev) {
        agg.set(key, { ...(r as object) } as CsvRecord);
      } else {
        dupRows++;
        for (const k of METRIC_KEYS) {
          if (typeof rec[k] === 'number') prev[k] = round2(Number(prev[k] ?? 0) + (rec[k] as number));
        }
        if (template === 'keyword_daily') {
          if (rec.avgRank !== null && rec.avgRank !== undefined) prev.avgRank = prev.avgRank ?? rec.avgRank;
          if (rec.bid !== null && rec.bid !== undefined) prev.bid = rec.bid;
        }
      }
    });
  }
  if (rowErrors.length) {
    issues.push({ code: 'invalid_rows', severity: 'error', message: `형식 오류로 제외한 행 ${invalid}개 — 예: ${rowErrors.slice(0, 3).map((e) => `${e.line}행 ${e.message}`).join(' / ')}`, detail: { rows: rowErrors } });
  }
  if (exampleLines.length) {
    issues.push({
      code: 'template_example_row', severity: 'warning',
      message: `템플릿 예시 행 ${exampleLines.length}개(${linesText(exampleLines)})는 실제 데이터가 아니라 가져오지 않습니다 — 템플릿을 쓸 때 예시 행은 지우고 실제 값을 넣으세요`,
      detail: { lines: exampleLines.slice(0, 50) },
    });
  }
  if (dupRows) {
    issues.push({ code: 'duplicate_keys', severity: 'warning', message: `같은 ${def.keyFields.filter((k) => k !== 'keywordKey').map((k) => def.fields.find((f) => f.key === k)?.label ?? k).join(' · ')}${template === 'keyword_daily' ? ' · 키워드' : ''} 행 ${dupRows}개를 합산했습니다 (캠페인 · 광고그룹별 행이면 정상, 같은 내용을 두 번 붙여 넣었다면 확인 필요)`, detail: { mergedRows: dupRows } });
  }

  /* ---------- 값 검사 (합산 뒤 레코드 기준 — 서버 수집 품질 검사 checkBatch와 같은 규칙 · 순서: 음수 → 미래 날짜) ---------- */
  const labelOf = (k: string) => def.fields.find((f) => f.key === k)?.label ?? k;
  const negative: { key: string; lines: number[]; field: string; value: number }[] = [];
  const future: { key: string; lines: number[]; date: string }[] = [];
  const excludedKeys = new Set<string>();
  const today = opts.today && /^\d{4}-\d{2}-\d{2}$/.test(opts.today) ? opts.today : null;
  for (const [key, r] of agg) {
    const rec = r as unknown as Record<string, unknown>;
    const neg = METRIC_KEYS.find((k) => typeof rec[k] === 'number' && (rec[k] as number) < 0);
    if (neg) { negative.push({ key, lines: keyLines.get(key) ?? [], field: neg, value: rec[neg] as number }); excludedKeys.add(key); continue; }
    if (today && r.date > today) { future.push({ key, lines: keyLines.get(key) ?? [], date: r.date }); excludedKeys.add(key); }
  }
  for (const k of excludedKeys) agg.delete(k);
  const lineCount = (xs: { lines: number[] }[]) => xs.reduce((a, x) => a + x.lines.length, 0);
  const negativeRows = lineCount(negative);
  const futureRows = lineCount(future);
  if (negative.length) {
    issues.push({
      code: 'negative_values', severity: 'error',
      message: `음수 지표가 있는 ${negativeRows}행을 제외했습니다 — 예: ${negative.slice(0, 3).map((n) => `${linesText(n.lines, 2)} ${labelOf(n.field)} ${numKo(n.value)}`).join(', ')} (광고비 · 노출 · 전환 · 매출은 0 이상이어야 합니다. 같은 ${def.keyFields.filter((k) => k !== 'keywordKey').map(labelOf).join(' · ')} 행은 합산한 값 기준)`,
      detail: { count: negativeRows, examples: negative.slice(0, 8).map((n) => ({ lines: n.lines.slice(0, 5), field: n.field, value: n.value })) },
    });
  }
  if (future.length) {
    issues.push({
      code: 'future_dates', severity: 'error',
      message: `오늘(${today}) 이후 날짜 ${futureRows}행을 제외했습니다 — 예: ${future.slice(0, 3).map((f) => `${linesText(f.lines, 2)} ${f.date}`).join(', ')}`,
      detail: { count: futureRows, today, examples: future.slice(0, 8).map((f) => ({ lines: f.lines.slice(0, 5), date: f.date })) },
    });
  }
  const preview = candidates.filter((c) => !excludedKeys.has(c.key)).slice(0, previewN).map((c) => c.rec);

  const records = [...agg.values()];
  const dates = records.map((r) => r.date).sort();
  const channels = [...new Set(records.map((r) => ('media' in r ? r.media : 'channel' in r ? r.channel : template === 'keyword_daily' || template === 'search_term_daily' ? 'naver_sa' : '')).filter(Boolean))].sort();
  if (!fatal && !records.length && parsed.rows.length) {
    issues.push({
      code: 'no_valid_rows', severity: 'error',
      message: exampleLines.length === parsed.rows.length
        ? '템플릿 예시 행만 있습니다 — 예시 행을 지우고 실제 데이터를 넣으세요'
        : invalid + exampleLines.length + negativeRows + futureRows > 0
          ? '가져올 수 있는 행이 없습니다 — 모든 행이 제외됩니다 (위 사유를 고친 뒤 다시 올려 주세요)'
          : '가져올 수 있는 행이 없습니다',
    });
  }
  if (!fatal && !parsed.rows.length) issues.push({ code: 'no_rows', severity: 'error', message: '머리글 아래 데이터 행이 없습니다' });
  const excludedRows = fatal ? parsed.rows.length : invalid + exampleLines.length + negativeRows + futureRows;
  return {
    template, mapping, records, preview, issues,
    summary: {
      rows: parsed.rows.length, validRows: parsed.rows.length - excludedRows, invalidRows: excludedRows, records: records.length,
      dateFrom: dates[0] ?? null, dateTo: dates[dates.length - 1] ?? null, channels, ...summaryBase,
      excluded: { format: fatal ? parsed.rows.length : invalid, example: exampleLines.length, negative: negativeRows, future: futureRows },
    },
  };
}

/** 오류(error) 등급 이슈가 있어 가져올 수 없는지 — 행 단위 오류(형식 · 음수 · 미래 날짜)는 해당 행만 빼고 가져온다 */
export function blockingIssues(issues: CsvIssue[]): CsvIssue[] {
  return issues.filter((i) => i.severity === 'error' && !(ROW_LEVEL_ERROR_CODES as readonly string[]).includes(i.code));
}

/* ---------- 템플릿 파일 ---------- */

function csvCell(v: string): string {
  return /[",\r\n;\t]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

/**
 * 템플릿 CSV (UTF-8 BOM · 한글 머리글 · 예시 1행). 예시 행 일자 칸에 '(예시 행 — 지우고 쓰세요)'를 붙인다 —
 * 지우지 않고 올려도 정규화가 예시 행으로 알아보고 가져오지 않는다(template_example_row 경고). 표시 없는 예전 템플릿의 예시 행은 값이 예시와 전부 같은지로 알아본다.
 */
export function templateCsv(template: UploadTemplate): string {
  const fields = templateFields(template);
  const head = fields.map((f) => csvCell(f.label)).join(',');
  const ex = fields.map((f) => csvCell(f.type === 'date' ? `${f.example} ${TEMPLATE_EXAMPLE_NOTE}` : f.example)).join(',');
  return `﻿${head}\r\n${ex}\r\n`;
}

export const TEMPLATE_HELP: Record<UploadTemplate, string> = {
  media_daily: '매체 값: naver_sa · naver_gfa · google · meta · kakao · vertical (또는 네이버 검색광고 · GFA · 구글 · 메타 · 카카오 · 버티컬). 매체 열이 없으면 화면에서 매체를 고정하세요',
  media_hourly: '시간대: 0~23 (21 · 21시 · 21:00 모두 가능). 매체 열이 없으면 화면에서 매체를 고정하세요',
  sales_daily: '판매 채널 값: brandstore · ohouse · coupang · own_mall (또는 브랜드스토어 · 오늘의집 · 쿠팡 · 자사몰)',
  keyword_daily: '키워드 ID가 없으면 키워드 문구로 기존 키워드와 맞추고, 없으면 새 키워드로 등록합니다 (의도 분류는 문구 기준 추정)',
  search_term_daily: '검색어 보고서를 일자별로 내려받은 파일. 등록 키워드와 같은 단어 조합이면 등록됨으로 표시합니다',
};
