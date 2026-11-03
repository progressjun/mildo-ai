/**
 * 대량 변경 실수 가드 (p.45 · MILDO Alert detectBulkChange 재사용) — 변경 요청 한 건 기준으로 판정한다.
 *
 * 엔진 detectBulkChange는 요청자별로 '가장 큰 window 하나'만 보고하고, 이슈 id의 날짜를 opts.today로 정한다.
 * 서버 가드에 그대로 쓰면 두 가지가 어긋난다:
 *   같은 날 두 번째 일괄 변경(앞의 묶음보다 작거나 같은 크기)은 아예 감지되지 않는다.
 *   어제 감지 · 종료된 묶음의 건을 오늘 반영하면 오늘 날짜 id로 '새 이슈'가 생겨 다시 막힌다.
 * 그래서 서버는 이 건이 들어간 window만 골라(이 건 기준 앞뒤 window 분) 엔진에 넘기고(id 날짜 = 묶음 첫 건의 KST 날짜, 날이 바뀌어도 같은 id),
 * 이미 적재된 이슈의 related 목록으로 '확인 · 종료됨'과 '종료 뒤 재발'을 가른다.
 *   이 건을 포함한 같은 계열(같은 대상) 이슈가 미해결 → 차단 (새로 적재하지 않음)
 *   같은 id 이슈가 미해결(묶음이 커지는 중) → 차단
 *   이 건을 포함한 같은 계열 이슈가 모두 종료 → 통과
 *   같은 id 이슈가 종료됐고 이 건이 종료 전에 만들어진 같은 묶음의 건(이슈가 열려 있는 동안 묶음이 커진 경우) → 통과
 *   그 밖(새 묶음 · 종료 뒤 재발) → 차단 + 이슈 적재 (재발은 '<id>:<재발 첫 건 id>' — 같은 재발 묶음은 같은 id)
 * 순수 함수 — withWorkspaceConfig 안에서 호출한다(탐지 기준 · AD Pilot 상한이 워크스페이스 설정을 따른다).
 */
import type { ChangeRequest } from '@/core/types';
import { activeConfig, detectBulkChange, type AlertIncident } from '@/modules/alert/engine';

/** DB에 적재된 대량 변경 이슈 (incidents.id LIKE 'bulk_change:%') */
export interface StoredBulk {
  id: string;
  status: string;
  related: string[];
  /** 종료 시각 (ms, 종료 전이면 null) */
  resolvedAt: number | null;
}

const BULK_KINDS = new Set<ChangeRequest['kind']>(['bid', 'budget', 'gfa', 'status']);
const counts = (c: ChangeRequest) => c.status !== 'rejected' && c.status !== 'rolled_back' && BULK_KINDS.has(c.kind);
const ms = (c: ChangeRequest) => Date.parse(c.createdAt);

/** c가 들어간 가장 큰 window (같은 모듈 · 같은 요청자, 엔진과 같은 window 정의: t0 ≤ t ≤ t0 + 분) */
export function windowOf(changes: readonly ChangeRequest[], c: ChangeRequest, windowMin: number): ChangeRequest[] {
  const tc = ms(c);
  if (!Number.isFinite(tc) || !counts(c)) return [];
  const W = Math.max(0, windowMin) * 60_000;
  const peers = changes.filter((x) => x.id !== c.id && counts(x) && x.module === c.module && x.requestedBy === c.requestedBy && Number.isFinite(ms(x)));
  const sorted = [...peers, c].sort((a, b) => ms(a) - ms(b) || a.id.localeCompare(b.id));
  let best: ChangeRequest[] = [];
  for (const s of sorted) {
    const t0 = ms(s);
    if (t0 < tc - W || t0 > tc) continue; // c를 포함하는 window만
    const win = sorted.filter((x) => { const t = ms(x); return t >= t0 && t - t0 <= W; });
    if (win.length > best.length) best = win;
  }
  return best;
}

/** c가 걸린 대량 변경 감지 (엔진 이슈 형식) — c를 related에 포함한 것만 */
export function bulkIncidentsFor(changes: readonly ChangeRequest[], c: ChangeRequest): AlertIncident[] {
  let found: AlertIncident[] = [];
  try {
    const cfg = activeConfig(changes);
    const win = windowOf(changes, c, cfg.bulkWindowMin);
    // window가 기준 건수 미만이면 c만 넘긴다 (입찰 일 조정 폭 상한 초과 건 감지는 건별)
    const input = win.length >= cfg.bulkBatch ? win : [c];
    found = detectBulkChange(input, { config: cfg });
  } catch {
    found = [];
  }
  return found.filter((b) => (b.related ?? []).includes(c.id));
}

export interface BulkDecision {
  blocks: string[];
  passes: string[];
  /** 새로 적재할 이슈 */
  toStore: AlertIncident[];
}

const blockText = (title: string, id: string) => `대량 변경 실수 감지 (P1 · ${title}) — 이슈 ${id} 확인 · 종료 전 신규 반영 일시 차단 (p.45)`;

/** 감지 결과 + 적재된 이슈 → 차단 · 통과 · 새 이슈 */
export function decideBulk(
  found: readonly AlertIncident[], c: Pick<ChangeRequest, 'id' | 'createdAt'>, stored: readonly StoredBulk[],
  changes: readonly Pick<ChangeRequest, 'id' | 'createdAt'>[] = [],
): BulkDecision {
  const out: BulkDecision = { blocks: [], passes: [], toStore: [] };
  const createdOf = new Map(changes.map((x) => [x.id, Date.parse(x.createdAt)]));
  createdOf.set(c.id, Date.parse(c.createdAt));
  for (const b of found) {
    const family = `bulk_change:${b.target ?? ''}:`;
    const same = stored.filter((s) => s.id === b.id || s.id.startsWith(family));
    const covering = same.filter((s) => s.related.includes(c.id));
    const open = covering.find((s) => s.status !== 'resolved');
    if (open) { out.blocks.push(blockText(b.title, open.id)); continue; }
    const exact = same.find((s) => s.id === b.id);
    if (exact && exact.status !== 'resolved') { out.blocks.push(blockText(b.title, exact.id)); continue; }
    if (covering.length) { out.passes.push(`대량 변경 이슈 ${covering.map((s) => s.id).join(' · ')} 확인 · 종료됨`); continue; }
    const created = Date.parse(c.createdAt);
    if (exact && exact.resolvedAt !== null && Number.isFinite(created) && created <= exact.resolvedAt) {
      out.passes.push(`대량 변경 이슈 ${exact.id} 확인 · 종료됨 (종료 전 같은 묶음에 추가된 건)`);
      continue;
    }
    let inc: AlertIncident = b;
    if (exact) {
      // 같은 날 · 같은 대상의 이슈가 이미 종료됐는데 이 건은 그 목록에 없다 → 종료 뒤 재발
      const reviewed = new Set(same.filter((s) => s.status === 'resolved').flatMap((s) => s.related));
      const before = (id: string) => { const t = createdOf.get(id); return exact.resolvedAt !== null && t !== undefined && Number.isFinite(t) && t <= exact.resolvedAt; };
      const fresh = (b.related ?? []).filter((id) => !reviewed.has(id) && !before(id));
      const followId = `${b.id}:${fresh[0] ?? c.id}`;
      const f = same.find((s) => s.id === followId);
      if (f && f.status !== 'resolved') { out.blocks.push(blockText(b.title, f.id)); continue; }
      inc = { ...b, id: f ? `${b.id}:${c.id}` : followId, related: fresh.length ? fresh : [c.id], title: `${b.title} · 종료된 이슈 ${b.id} 이후 재발` };
    }
    out.blocks.push(blockText(inc.title, inc.id));
    if (!out.toStore.some((x) => x.id === inc.id)) out.toStore.push(inc);
  }
  return out;
}
