/**
 * 롱테일 · 구문형 키워드 후보 생성 CLI (제안서 p.36: 제품 1 × 문제 4 × 상황 4 × 비교 3 = 48 진입점)
 *
 *   npm run keywords                 # 48개 진입점 + 구문형 후보 CSV 출력
 *   NAVER_SA_API_KEY=... npm run keywords -- --volume   # 네이버 키워드 도구로 월간 검색량 조회 (5개씩 묶음)
 */
import { SKU_EXPANSION } from '../src/data/constants';
import { credentialsFromEnv, naverSa, parseVolume } from './naver-searchad';

const PHRASE: Record<string, string> = {
  '허리 통증': '허리 편한', '꺼짐 · 처짐': '꺼짐 없는', '더위 · 통기': '통기성 좋은', '뒤척임 소음': '소음 없는',
  '신혼': '신혼', '이사 · 첫 독립': '이사', '아이 방': '아이방', '부모님 선물': '부모님',
  '경도': '경도', '사이즈': '사이즈', '소재 · 구조': '소재',
};

export function entryPoints() {
  const out: { problem: string; situation: string; criterion: string; phrase: string }[] = [];
  for (const p of SKU_EXPANSION.problems)
    for (const s of SKU_EXPANSION.situations)
      for (const c of SKU_EXPANSION.criteria)
        out.push({ problem: p, situation: s, criterion: c, phrase: `${PHRASE[s]} ${PHRASE[p]} 매트리스 ${PHRASE[c]}`.replace(/\s+/g, ' ').trim() });
  return out;
}

async function main() {
  const rows = entryPoints();
  const volumes = new Map<string, number>();
  if (process.argv.includes('--volume')) {
    const cred = credentialsFromEnv();
    if (!cred) {
      console.error('NAVER_SA_API_KEY / NAVER_SA_SECRET / NAVER_SA_CUSTOMER_ID 환경변수가 필요합니다.');
      process.exitCode = 2;
    } else {
      const hints = [...new Set(rows.map((r) => r.phrase.replace(/\s/g, '')))];
      for (let i = 0; i < hints.length; i += 5) {
        const { keywordList } = await naverSa.keywordTool(cred, hints.slice(i, i + 5));
        for (const k of keywordList) volumes.set(k.relKeyword, parseVolume(k.monthlyPcQcCnt) + parseVolume(k.monthlyMobileQcCnt));
      }
    }
  }
  console.log('problem,situation,criterion,phrase,monthly_volume');
  for (const r of rows) console.log([r.problem, r.situation, r.criterion, r.phrase, volumes.get(r.phrase.replace(/\s/g, '')) ?? ''].join(','));
  console.error(`검색 진입점 ${rows.length}개 (제품 1 × 문제 ${SKU_EXPANSION.problems.length} × 상황 ${SKU_EXPANSION.situations.length} × 비교 ${SKU_EXPANSION.criteria.length})`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
