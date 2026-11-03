/** CSV 엔진: RFC 4180 파서 · 구분자 감지 · 숫자/날짜/시간 해석 · 열 별칭 매핑 · 템플릿별 정규화 · 템플릿 파일 */
import { describe, expect, it } from 'vitest';
import {
  blockingIssues, detectDelimiter, normalizeCsv, normalizeHeader, parseChannel, parseCsv, parseDate, parseHour, parseMedia, parseNumber, resolveMapping, templateCsv,
  TEMPLATE_EXAMPLE_NOTE, TEMPLATES, UPLOAD_TEMPLATES, type MediaDailyRecord, type KeywordDailyRecord, type SalesDailyRecord, type MediaHourlyRecord,
} from './csv';

describe('RFC 4180 파서', () => {
  it('따옴표 필드 · 이스케이프된 따옴표 · 필드 안 줄바꿈 · CRLF · BOM', () => {
    const text = '﻿일자,캠페인,메모\r\n2026-10-30,"SA_일반, 제품","그는 ""최고""라고\r\n말했다"\r\n2026-10-31,SA_브랜드,\r\n';
    const p = parseCsv(text);
    expect(p.headers).toEqual(['일자', '캠페인', '메모']);
    expect(p.rows).toEqual([
      ['2026-10-30', 'SA_일반, 제품', '그는 "최고"라고\r\n말했다'],
      ['2026-10-31', 'SA_브랜드', ''],
    ]);
    expect(p.delimiter).toBe(',');
    expect(p.warnings).toEqual([]);
  });

  it('구분자 자동 감지 (; · 탭), 마지막 줄바꿈 없음, 빈 줄 무시', () => {
    expect(detectDelimiter('a;b;c\n1;2;3')).toBe(';');
    expect(detectDelimiter('a\tb\tc\n1\t2\t3')).toBe('\t');
    expect(detectDelimiter('"a;b",c\n1,2')).toBe(',');
    const p = parseCsv('날짜\t노출\n2026-10-30\t1,200\n\n2026-10-31\t900');
    expect(p.delimiter).toBe('\t');
    expect(p.rows).toEqual([['2026-10-30', '1,200'], ['2026-10-31', '900']]);
  });

  it('LF만 쓰는 파일 · 열 수 불일치 · 닫히지 않은 따옴표 경고', () => {
    const p = parseCsv('a,b\n1,2,3\n"open,4');
    expect(p.rows[0]).toEqual(['1', '2', '3']);
    expect(p.warnings.map((w) => w.message).join(' ')).toMatch(/열 수|닫히지 않은 따옴표/);
  });
});

describe('값 해석', () => {
  it('숫자: 쉼표 · ₩ · 원 · % · 공백 · 빈칸 · 괄호 음수', () => {
    expect(parseNumber('1,234,567')).toBe(1234567);
    expect(parseNumber('₩12,000')).toBe(12000);
    expect(parseNumber('12,000원')).toBe(12000);
    expect(parseNumber('2.4%')).toBe(2.4);
    expect(parseNumber(' 7 ')).toBe(7);
    expect(parseNumber('')).toBe(0);
    expect(parseNumber('-')).toBe(0);
    expect(parseNumber('(1,500)')).toBe(-1500);
    expect(parseNumber('-3.5')).toBe(-3.5);
    expect(parseNumber('abc')).toBeNaN();
    expect(parseNumber('1.2.3')).toBeNaN();
  });

  it('날짜: YYYY-MM-DD · YYYY.MM.DD(.) · YYYY/MM/DD · YYYYMMDD · 요일 꼬리 · 잘못된 날짜', () => {
    expect(parseDate('2026-10-31')).toBe('2026-10-31');
    expect(parseDate('2026.10.31')).toBe('2026-10-31');
    expect(parseDate('2026.10.31.')).toBe('2026-10-31');
    expect(parseDate('2026/1/5')).toBe('2026-01-05');
    expect(parseDate('20261031')).toBe('2026-10-31');
    expect(parseDate('2026-10-31 (토)')).toBe('2026-10-31');
    expect(parseDate('2026년 10월 31일')).toBe('2026-10-31');
    expect(parseDate('2026-02-30')).toBeNull();
    expect(parseDate('31/10/2026')).toBeNull();
    expect(parseDate('')).toBeNull();
  });

  it('시간대 · 매체 · 판매 채널 별칭', () => {
    expect(parseHour('21')).toBe(21);
    expect(parseHour('09시')).toBe(9);
    expect(parseHour('21:00')).toBe(21);
    expect(parseHour('0~1시')).toBe(0);
    expect(parseHour('24')).toBeNull();
    expect(parseMedia('네이버 검색광고')).toBe('naver_sa');
    expect(parseMedia('파워링크')).toBe('naver_sa');
    expect(parseMedia('GFA')).toBe('naver_gfa');
    expect(parseMedia('페이스북')).toBe('meta');
    expect(parseMedia('Google Ads')).toBe('google');
    expect(parseMedia('카카오모먼트')).toBe('kakao');
    expect(parseMedia('naver_sa')).toBe('naver_sa');
    expect(parseMedia('틱톡')).toBeNull();
    expect(parseChannel('스마트스토어')).toBe('brandstore');
    expect(parseChannel('오늘의집')).toBe('ohouse');
    expect(parseChannel('카페24')).toBe('own_mall');
    expect(parseChannel('own_mall')).toBe('own_mall');
  });

  it('머리글 정규화: 단위 괄호 · 공백 · 기호 제거', () => {
    expect(normalizeHeader('총비용(VAT포함)')).toBe('총비용');
    expect(normalizeHeader(' 광고비(원) ')).toBe('광고비');
    expect(normalizeHeader('Amount Spent')).toBe('amountspent');
  });
});

describe('열 매핑', () => {
  it('한글 · 영문 별칭 자동 매핑, 필수 열 누락, 사용자 매핑 우선', () => {
    const m = resolveMapping('media_daily', ['날짜', '매체', '노출수', '클릭수', '총비용(VAT포함)', '전환수', '전환매출액', '메모']);
    expect(m.fields).toMatchObject({ date: '날짜', media: '매체', impressions: '노출수', clicks: '클릭수', cost: '총비용(VAT포함)', conversions: '전환수', revenue: '전환매출액' });
    expect(m.missing).toEqual([]);
    expect(m.unmapped).toEqual(['메모']);
    const en = resolveMapping('media_daily', ['date', 'media', 'impressions', 'clicks', 'spend', 'conversions', 'revenue']);
    expect(en.fields.cost).toBe('spend');
    const miss = resolveMapping('sales_daily', ['일자', '채널', '방문자']);
    expect(miss.missing).toEqual(['orders', 'revenue']);
    const user = resolveMapping('media_daily', ['기간', '플랫폼', 'Cost', '비고'], { cost: '비고', revenue: '' });
    expect(user.fields.cost).toBe('비고');
    expect(user.fields.revenue).toBeNull();
    expect(resolveMapping('media_daily', ['일자', '광고비'], undefined, { fixedChannel: true }).missing).toEqual([]);
  });
});

describe('템플릿별 정규화', () => {
  it('매체 일별: 같은 날짜 · 매체 행 합산(경고), 형식 오류 행 제외, 앞 20행 미리보기', () => {
    const csv = [
      '일자,매체,캠페인,노출,클릭,광고비,전환,전환매출',
      '2026.10.30,네이버 검색광고,SA_브랜드,"12,000",480,"₩396,000",8,"8,720,000"',
      '2026.10.30,네이버 검색광고,SA_일반,30000,600,"510,000원",5,"5,400,000"',
      '2026.10.30,메타,넓은 타겟,90000,990,"520,000",2,2100000',
      '2026.10.31,메타,넓은 타겟,abc,10,100,0,0',
      '2026-13-01,메타,x,1,1,1,0,0',
    ].join('\n');
    const r = normalizeCsv('media_daily', csv);
    const recs = r.records as MediaDailyRecord[];
    expect(recs).toHaveLength(2);
    expect(recs.find((x) => x.media === 'naver_sa')).toEqual({ date: '2026-10-30', media: 'naver_sa', impressions: 42000, clicks: 1080, cost: 906000, conversions: 13, revenue: 14120000, newCustomers: 0 });
    expect(r.summary).toMatchObject({ rows: 5, invalidRows: 2, records: 2, dateFrom: '2026-10-30', dateTo: '2026-10-30', channels: ['meta', 'naver_sa'] });
    expect(r.issues.map((i) => i.code)).toEqual(expect.arrayContaining(['invalid_rows', 'duplicate_keys', 'unmapped_columns']));
    expect(r.preview).toHaveLength(3);
    expect(r.preview[0]._line).toBe(2);
    expect(blockingIssues(r.issues)).toEqual([]);
  });

  it('매체 열이 없으면 고정 매체를 쓰고, 고정값도 없으면 필수 열 누락으로 막는다', () => {
    const csv = '일자,노출,클릭,광고비\n20261030,100,5,4000';
    const fixed = normalizeCsv('media_daily', csv, { channel: 'kakao' });
    expect((fixed.records as MediaDailyRecord[])[0]).toMatchObject({ date: '2026-10-30', media: 'kakao', cost: 4000, conversions: 0, revenue: 0 });
    const none = normalizeCsv('media_daily', csv);
    expect(blockingIssues(none.issues).map((i) => i.code)).toEqual(['missing_columns']);
    expect(none.records).toEqual([]);
    expect(blockingIssues(normalizeCsv('media_daily', csv, { channel: 'tiktok' }).issues).map((i) => i.code)).toContain('unknown_channel');
  });

  it('매체 시간대 · 판매 채널 일별 (세미콜론 · 탭 파일)', () => {
    const h = normalizeCsv('media_hourly', 'date;hour;media;impressions;clicks;cost\n2026-10-31;21시;meta;1000;20;15000\n2026-10-31;22:00;meta;900;18;14000');
    expect((h.records as MediaHourlyRecord[]).map((x) => x.hour)).toEqual([21, 22]);
    const s = normalizeCsv('sales_daily', '일자\t판매채널\t방문자수\t주문수\t결제금액\n2026/10/30\t스마트스토어\t5,400\t110\t113,000,000\n2026/10/30\t쿠팡\t1,200\t30\t29,000,000');
    expect((s.records as SalesDailyRecord[])[0]).toEqual({ date: '2026-10-30', channel: 'brandstore', visitors: 5400, detailViews: 0, carts: 0, orders: 110, revenue: 113000000, adAttributedRevenue: 0 });
    expect(s.summary.delimiter).toBe('tab');
  });

  it('키워드 일별: 키워드 문구 또는 ID가 있어야 하고, 같은 키워드 행은 합산', () => {
    const r = normalizeCsv('keyword_daily', '일자,키워드,광고그룹,노출수,클릭수,총비용,전환수,전환매출액,평균노출순위\n2026-10-30,퀸 매트리스,G1,100,10,12000,1,1000000,3.2\n2026-10-30,퀸  매트리스,G2,50,5,6000,0,0,\n2026-10-30,,G1,1,1,1,0,0,');
    const recs = r.records as KeywordDailyRecord[];
    expect(recs).toHaveLength(1);
    expect(recs[0]).toMatchObject({ keywordKey: 'text:퀸 매트리스', impressions: 150, clicks: 15, cost: 18000, avgRank: 3.2 });
    expect(r.summary.invalidRows).toBe(1);
    expect(blockingIssues(normalizeCsv('keyword_daily', '일자,노출\n2026-10-30,1').issues).map((i) => i.code)).toEqual(['missing_columns']);
  });

  it('빈 파일 · 머리글만 있는 파일', () => {
    expect(blockingIssues(normalizeCsv('search_term_daily', '').issues).map((i) => i.code)).toEqual(['empty_file']);
    expect(blockingIssues(normalizeCsv('search_term_daily', '일자,검색어\n').issues).map((i) => i.code)).toEqual(['no_rows']);
  });

  it('템플릿 CSV: UTF-8 BOM · 한글 머리글이 모두 매핑되고, 예시 행(일자 칸 표시)은 실제 데이터로 가져오지 않는다', () => {
    for (const t of UPLOAD_TEMPLATES) {
      const csv = templateCsv(t);
      expect(csv.startsWith('﻿')).toBe(true);
      expect(csv, t).toContain(TEMPLATE_EXAMPLE_NOTE);
      const r = normalizeCsv(t, csv);
      expect(r.mapping.missing, t).toEqual([]);
      expect(r.records, t).toEqual([]);
      expect(r.issues.find((i) => i.code === 'template_example_row'), t).toMatchObject({ severity: 'warning' });
      // 예시 행만 있으면 가져올 행이 없다 — 예시 행을 지우라는 안내
      expect(blockingIssues(r.issues).map((i) => i.code), t).toEqual(['no_valid_rows']);
      expect(blockingIssues(r.issues)[0].message, t).toContain('예시 행');
      expect(TEMPLATES[t].fields.length).toBeGreaterThan(3);
    }
  });
});

describe('템플릿 예시 행 · 값 검사 (서버 수집 품질 검사와 같은 기준)', () => {
  const HEAD = '일자,매체,노출,클릭,광고비,전환,전환매출,신규 고객';
  const LEGACY_EXAMPLE = '2026-10-30,naver_sa,120000,2400,1850000,21,22000000,13';
  const GOOGLE = ['2026-10-27,google,90000,1800,3000000,30,12000000,20', '2026-10-28,google,91000,1810,3010000,31,12100000,21'];

  it('표시 없는 예전 템플릿의 예시 행(값이 예시와 전부 같음)도 알아보고 빼며, 그 아래 실제 행은 가져온다', () => {
    const r = normalizeCsv('media_daily', [HEAD, LEGACY_EXAMPLE, ...GOOGLE].join('\n'));
    expect((r.records as MediaDailyRecord[]).map((x) => x.media)).toEqual(['google', 'google']);
    expect(r.summary).toMatchObject({ rows: 3, validRows: 2, invalidRows: 1, channels: ['google'], excluded: { example: 1 } });
    expect(r.issues.find((i) => i.code === 'template_example_row')!.message).toContain('2행');
    expect(r.preview.map((p) => p._line)).toEqual([3, 4]);
    expect(blockingIssues(r.issues)).toEqual([]);
  });

  it('예시와 한 값이라도 다르면 실제 행 — 예시 행으로 보지 않는다', () => {
    const r = normalizeCsv('media_daily', [HEAD, '2026-10-30,naver_sa,120000,2400,1850001,21,22000000,13'].join('\n'));
    expect(r.records).toHaveLength(1);
    expect(r.issues.map((i) => i.code)).not.toContain('template_example_row');
  });

  it('음수 지표 · 오늘 이후 날짜 레코드는 빼고 행 단위 오류로 알린다 (가져오기는 막지 않음, 남는 행이 없으면 막음)', () => {
    const csv = [
      '일자,매체,노출수,클릭수,광고비(원),전환수,전환매출(원)',
      '2026-10-28,구글,"101,111","2,011","-₩3,010,000",11,"₩30,100,000"',
      '2026-10-29,구글,-5,"2,022","3,020,000",-12,"30,200,000"',
      '2026-11-20,구글,100,10,"1,000",1,"10,000"',
      '2026-11-03,카카오,100,10,"1,000",1,"10,000"',
    ].join('\n');
    const r = normalizeCsv('media_daily', csv, { today: '2026-11-03' });
    expect((r.records as MediaDailyRecord[]).map((x) => `${x.date}|${x.media}`)).toEqual(['2026-11-03|kakao']);
    expect(r.summary).toMatchObject({ rows: 4, validRows: 1, invalidRows: 3, dateFrom: '2026-11-03', dateTo: '2026-11-03', channels: ['kakao'], excluded: { negative: 2, future: 1 } });
    const neg = r.issues.find((i) => i.code === 'negative_values')!;
    expect(neg.severity).toBe('error');
    expect(neg.message).toContain('음수 지표가 있는 2행을 제외했습니다');
    expect(neg.message).toContain('2행 광고비 -3,010,000');
    expect(r.issues.find((i) => i.code === 'future_dates')!.message).toContain('오늘(2026-11-03) 이후 날짜 1행');
    expect(r.preview.map((p) => p._line)).toEqual([5]);
    expect(blockingIssues(r.issues)).toEqual([]);
    const none = normalizeCsv('media_daily', csv.split('\n').slice(0, 4).join('\n'), { today: '2026-11-03' });
    expect(blockingIssues(none.issues).map((i) => i.code)).toEqual(['no_valid_rows']);
    // 기준일을 주지 않으면 미래 날짜는 판정하지 않는다(음수는 항상)
    expect(normalizeCsv('media_daily', csv).records).toHaveLength(2);
  });

  it('같은 키 합산 뒤 값 기준 — 환불 · 조정 행(음수)이 있어도 합계가 0 이상이면 가져온다 (워커와 같은 판정)', () => {
    const r = normalizeCsv('media_daily', ['일자,매체,광고비', '2026-10-30,meta,100000', '2026-10-30,meta,-20000'].join('\n'), { today: '2026-11-03' });
    expect((r.records as MediaDailyRecord[])[0].cost).toBe(80000);
    expect(r.issues.map((i) => i.code)).not.toContain('negative_values');
  });
});
