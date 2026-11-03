/**
 * 데이터 연결 — MILDO Agent 도구 + 오프라인 브리프.
 *  - data_sources_status: 커넥션(공급자 · 상태 · 쓰기 모드 · 마지막 수집 · 오류) · 최근 수집 실행 · 품질 이슈 요약 · Dataset 출처.
 *    서버 모드면 화면이 마지막으로 읽은 상태(없으면 API 직접 조회), 데모 모드면 예시 상태(TEST DATA).
 *  - data_upload_templates: CSV 템플릿 열 · 필수 여부 · 별칭 예 — '어떤 형식으로 올려야 하나' 질문용.
 * 읽기 전용 도구만 둔다 (커넥션 추가 · live 켜기는 사람이 화면에서).
 */
import type { AgentTool } from '@/ai/claude';
import type { Brief } from '@/ai/prompts';
import type { DatasetMeta } from '@/core/types';
import type { ModuleAgentKit, ToolContext } from '../types';
import { detectMode } from '@/saas/mode';
import { exampleState } from './demoState';
import { connectionsApi, getSnapshot, type Snapshot } from './client';
import { TEMPLATE_HELP, TEMPLATES, UPLOAD_TEMPLATES } from './csv';
import { ago, channelLabel, connectionVerdict, JOB_LABEL, qualityCounts, RUN_STATUS_META, sourceModeOf, staleSources, STATUS_META, WRITE_MODE_META, type ConnectionView, type QualityItem, type RunView } from './model';

const WS_KEY = 'mildo-os/cloud/workspace';

interface StatusData { origin: 'server' | 'example'; at: number; connections: ConnectionView[]; runs: RunView[]; quality: QualityItem[] }

/** 서버 모드면 스냅샷 → 없으면 API 조회, 아니면 예시 상태 */
async function loadStatus(ctx: ToolContext): Promise<StatusData> {
  const snap: Snapshot | null = getSnapshot();
  if (snap) return { origin: 'server', at: snap.at, connections: snap.connections, runs: snap.runs, quality: snap.quality?.issues ?? [] };
  try {
    if ((await detectMode()) === 'server') {
      let ws: string | null = null;
      try { ws = localStorage.getItem(WS_KEY); } catch { ws = null; }
      if (ws) {
        const [c, r, q] = await Promise.all([connectionsApi.list(ws), connectionsApi.runs(ws, { limit: 20 }), connectionsApi.quality(ws)]);
        return { origin: 'server', at: Date.now(), connections: c.connections, runs: r.runs, quality: q.issues };
      }
    }
  } catch {
    /* 서버 조회 실패 → 예시 상태 */
  }
  const ex = exampleState(ctx.state.data);
  return { origin: 'example', at: ex.nowMs, connections: ex.connections, runs: ex.runs, quality: ex.quality };
}

function metaView(meta: DatasetMeta | undefined, today: string) {
  const src = sourceModeOf(meta);
  return {
    출처: src.label,
    근거: src.basis,
    기준일: today,
    채널별: (meta?.sources ?? []).slice(0, 30).map((s) => ({ 채널: channelLabel(s.channel), 종류: s.kind === 'demo' ? 'TEST DATA' : s.kind.toUpperCase(), 최신일: s.latestDate, 최신시각: s.latestHour ?? undefined })),
    어제데이터없음: staleSources(meta, today).map((s) => channelLabel(s.channel)),
  };
}

function statusTool(ctx: ToolContext): AgentTool {
  return {
    name: 'data_sources_status',
    description: '데이터 연결 현황: 매체 · 판매 채널 커넥션(상태 · 쓰기 모드 dry_run/live · 마지막 수집 · 오류), 최근 수집 실행(성공 · 일부 제외 · 실패, 행 수), 데이터 품질 이슈(누락 날짜 · 중복 · 음수 · 급변 · 키워드 합계 차이 · 수집 지연), 현재 Dataset 출처(TEST DATA · LIVE · 일부 LIVE). 서버 연결 전에는 예시 상태(TEST DATA)를 돌려준다.',
    inputSchema: { type: 'object', properties: {} },
    async execute() {
      const d = await loadStatus(ctx);
      const qc = qualityCounts(d.quality);
      return {
        상태출처: d.origin === 'server' ? '서버 (실제 상태)' : '예시 상태 (서버 미연결 · TEST DATA)',
        dataset: metaView(ctx.state.data.meta, ctx.state.data.today),
        커넥션: d.connections.slice(0, 20).map((c) => {
          const v = connectionVerdict(c, d.at);
          return {
            이름: c.label, 공급자: c.providerLabel, 채널: channelLabel(c.channel), 상태: STATUS_META[c.status].label, 판정: `${v.label} (${v.basis})`,
            쓰기모드: WRITE_MODE_META[c.writeMode].label, 실계정검증: c.sourceKind === 'api' ? (c.verifiedLive ? '검증됨' : '실계정 연결 전 확인 필요') : undefined,
            출처종류: c.sourceKind === 'demo' ? 'TEST DATA' : c.sourceKind.toUpperCase(), 우선순위: c.priority,
            마지막수집: c.lastSyncAt ? ago(c.lastSyncAt, d.at) : '없음', 대기수집: c.pendingJobs || undefined, 오류: c.lastError?.slice(0, 200) ?? undefined,
          };
        }),
        최근실행: d.runs.slice(0, 10).map((r) => ({
          출처: r.label, 종류: JOB_LABEL[r.job] ?? r.job, 기간: r.rangeFrom ? `${r.rangeFrom}~${r.rangeTo}` : null, 결과: RUN_STATUS_META[r.status].label,
          행: `${r.rowsIn}→${r.rowsWritten}`, 이슈: `오류 ${r.issueCounts.error} · 경고 ${r.issueCounts.warning}`, 실패사유: r.error?.slice(0, 200) ?? undefined,
        })),
        품질: { 오류: qc.error, 경고: qc.warning, 참고: qc.info, 주요: d.quality.slice(0, 8).map((i) => `[${i.severity}] ${i.label}: ${i.message.slice(0, 160)}`) },
      };
    },
  };
}

function templatesTool(): AgentTool {
  return {
    name: 'data_upload_templates',
    description: 'CSV · TSV 업로드 템플릿 5종(매체 일별 · 매체 시간대 · 판매 채널 일별 · 키워드 일별 · 검색어 일별)의 열 이름 · 필수 여부 · 한글/영문 별칭 예 · 값 형식(날짜 · 숫자 · 매체 값). 사용자가 파일 형식을 물을 때 쓴다.',
    inputSchema: { type: 'object', properties: { template: { type: 'string', enum: UPLOAD_TEMPLATES, description: '특정 템플릿만 (없으면 전체)' } } },
    execute(input) {
      const only = typeof input.template === 'string' && (UPLOAD_TEMPLATES as string[]).includes(input.template) ? [input.template] : UPLOAD_TEMPLATES;
      return {
        공통: '날짜 YYYY-MM-DD · YYYY.MM.DD · YYYY/MM/DD · YYYYMMDD, 숫자는 쉼표 · ₩ · 원 · % 허용(빈칸 = 0), 구분자 쉼표 · 세미콜론 · 탭 자동, UTF-8(BOM 가능) · 엑셀 한글(EUC-KR) 자동, 20MB 이하',
        템플릿: only.map((t) => {
          const def = TEMPLATES[t as keyof typeof TEMPLATES];
          return {
            id: t, 이름: def.label, 설명: def.description, 안내: TEMPLATE_HELP[t as keyof typeof TEMPLATE_HELP],
            열: def.fields.map((f) => ({ 필드: f.label, 필수: f.required, 별칭예: f.aliases.slice(0, 5).join(', '), 예시: f.example || undefined })),
          };
        }),
      };
    },
  };
}

/* ---------- 오프라인 브리프 ---------- */

function sourcesBrief(ctx: ToolContext): Brief {
  const d = ctx.state.data;
  const meta = d.meta;
  const src = sourceModeOf(meta);
  const snap = getSnapshot();
  const ex = snap ? null : exampleState(d);
  const conns = snap?.connections ?? ex!.connections;
  const quality = snap?.quality?.issues ?? ex!.quality;
  const at = snap?.at ?? ex!.nowMs;
  const qc = qualityCounts(quality);
  const stale = staleSources(meta, d.today);
  const facts: string[] = [];
  if (!meta) facts.push('현재 Dataset은 시연용 생성기 데이터(TEST DATA)입니다 — 실제 성과 데이터가 아니며, 서버에 연결하면 커넥션 · CSV로 받은 데이터로 바뀝니다.');
  else facts.push(`현재 Dataset 출처: ${src.label} (${src.basis}) · 기준일 ${d.today} ${d.currentHour}시`);
  facts.push(`${snap ? '' : '예시 상태 기준 '}커넥션 ${conns.length}개 — ${conns.map((c) => `${c.label} ${STATUS_META[c.status].label} · 쓰기 ${WRITE_MODE_META[c.writeMode].label}`).join(' / ') || '없음'}`);
  facts.push(`데이터 품질: 오류 ${qc.error}건 · 경고 ${qc.warning}건 · 참고 ${qc.info}건 (커넥션별 마지막 실행 · 최근 업로드 기준)`);
  const patterns: string[] = [];
  if (stale.length) patterns.push(`어제(${d.today} 전날) 데이터가 없는 출처: ${stale.map((s) => channelLabel(s.channel)).join(' · ')} — 매체 집계 지연 또는 수집 실패 가능성`);
  const errConns = conns.filter((c) => c.status === 'error');
  if (errConns.length) patterns.push(`오류 상태 커넥션 ${errConns.length}개: ${errConns.map((c) => `${c.label}(${(c.lastError ?? '사유 미상').slice(0, 80)})`).join(' / ')}`);
  const unverified = conns.filter((c) => c.sourceKind === 'api' && !c.verifiedLive);
  if (unverified.length) patterns.push(`실계정 연결 전 확인 필요 커넥터 ${unverified.length}개 — 첫 수집 값을 매체 관리 화면과 대조해야 합니다`);
  const live = conns.filter((c) => c.writeMode === 'live');
  const interpretation = [
    src.mode === 'demo'
      ? '지금 화면의 판정 · 제안은 테스트 데이터 기준이라 실제 운영 판단에 쓰면 안 됩니다. 매체 API를 연결하거나 CSV를 올리면 그 매체부터 실데이터로 바뀝니다.'
      : src.mode === 'mixed'
        ? '일부 매체만 실데이터입니다. 매체 간 비교(예산 재배분 · 기여 분석)는 데모 매체가 섞여 있어 결론을 미루는 편이 안전합니다.'
        : '모든 매체 · 채널이 실데이터 출처입니다. 품질 경고가 있는 날짜는 판단에서 따로 확인하세요.',
    live.length ? `실제 반영(live) 커넥션 ${live.length}개: ${live.map((c) => c.label).join(' · ')} — 승인된 변경이 매체 API로 호출됩니다.` : '실제 반영(live)을 켠 커넥션이 없어 승인된 변경은 dry_run(요청 기록만)으로 처리됩니다.',
  ];
  return {
    title: '데이터 연결 · 수집 현황',
    facts,
    patterns,
    interpretation,
    conditions: [
      '예약 수집: 매일 07:00 어제 포함 3일 재수집(늦게 잡히는 전환 반영) · 매시 10분 당일 시간대',
      '품질 기준: 같은 요일 직전 4주 평균 대비 ±80% 급변, 네이버 SA 키워드 합계 vs 매체 합계 10% 초과 차이, 26시간 수집 지연',
      `마지막 확인 ${ago(new Date(at).toISOString(), at)} · 출처 우선순위 API 100 > CSV 50 > 데모 10`,
    ],
    counter: [
      '급변 경고는 실제 성과 변화(프로모션 · 예산 증액)일 수도 있습니다 — 집계 오류로 단정하지 말고 매체 화면 값과 대조하세요.',
      '매체 전환 집계는 최대 며칠 늦게 확정됩니다. 어제 전환이 낮아 보여도 다음 07:00 재수집에서 늘어날 수 있습니다.',
    ],
    actions: [
      qc.error ? '데이터 연결 화면의 데이터 품질 탭에서 오류 항목(실패 사유 · 제외 행)을 먼저 해결하세요.' : '데이터 품질 오류는 없습니다. 경고 항목만 주간 점검에서 확인하세요.',
      src.mode !== 'live' ? '실데이터 전환: 연결 추가에서 매체 API 자격증명을 넣고 연결 확인 → 최근 120일 자동 수집, API가 없는 채널은 CSV 템플릿으로 업로드' : '새 매체 · 채널을 늘릴 때도 연결 확인 후 첫 수집 값을 대조하세요.',
    ],
  };
}

export const agentKit: ModuleAgentKit = {
  tools: (ctx) => [statusTool(ctx), templatesTool()],
  briefs: [
    {
      id: 'connections_status',
      match: /데이터\s?(연결|출처|소스|수집|품질|연동)|커넥션|커넥터|연결\s?(상태|현황|추가)|수집\s?(현황|실패|지연|일정|오류)|CSV|업로드|TEST DATA|테스트\s?데이터|실데이터|LIVE\s?DATA|dry.?run|live\s?반영|쓰기\s?모드/i,
      build: (ctx) => sourcesBrief(ctx),
    },
  ],
};
