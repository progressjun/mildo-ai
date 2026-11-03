/**
 * changes 도메인 진입점 (docs/SAAS_SPEC.md §4 changes · §6) — routes: /api 아래 Fastify 플러그인, jobs: 잡 · 스케줄 등록.
 * 코어(domains.ts)가 import한다. 이 파일의 export 이름과 형태를 바꾸지 말 것.
 *
 *   GET   /api/w/:ws/changes[?status=&limit=]          read      → { changes }        최신순, 기본 500건
 *   POST  /api/w/:ws/changes { change }                 request   → { change }         클라이언트 id 허용 (같은 요청 재전송은 같은 건을 돌려줌)
 *   PATCH /api/w/:ws/changes/:id { patch, action, note } 전이별    → { change }         서버가 전이 · 권한 · 반영 / 롤백 실행을 판정하고 실제 결과를 돌려준다
 *                                                                  409 → { error:{code,message,detail}, change } — code: same_status · invalid_transition ·
 *                                                                  not_approved_before · executing · stale · rollback_order · not_editable · approver_changed(승인 시점 재판정으로 승인 주체가 올라감)
 *   GET   /api/w/:ws/changes/:id                        read      → { change }
 *   GET   /api/w/:ws/changes/:id/executions             read      → { executions }     매체 반영 시도 기록 (dry_run · live · 실패 · 롤백 · 되돌림)
 *   GET   /api/w/:ws/changes/:id/preflight              read      → { check, target }  반영 전 점검 · 대상 미리보기 (상태 변경 없음)
 *
 * 커넥터 반영 계약: apply(ctx, change) — change.targetId = wh_entities.external_id(GFA 광고그룹은 'gfa:adgroup:<cid>:<agid>'),
 *   change.entity = { type, externalId, name?, text?, media?, campaignId?, adgroupId? } (웨어하우스 엔티티 요약, 선택 — dry_run 요청 표시용),
 *   실행 모드는 커넥션 write_mode(off → 보류, dry_run, live — live는 연결 확인을 통과한 커넥션만, 데모 커넥터는 항상 dry_run 시뮬레이션).
 *   execution.verifiedLive = 반영에 쓴 커넥터가 모두 실계정 호출로 검증됐는지(false면 화면에 '실계정 연결 전 확인 필요').
 *
 * 잡: 'changes.execute' { changeId, attemptId? } — 인라인 20초를 넘긴 반영 · 롤백의 마무리 · 비정상 종료 복구.
 *     실행 쪽 heartbeat가 최신이면 이어받지 않고(still_running) 다시 확인을 예약한다. 이어받을 때 저장된 계획에
 *     live 신규 생성 · 키워드 추가가 있으면 다시 보내지 않고 '반영 결과 확인 필요'로 보류한다.
 * 스케줄: 'changes.sweep' (10분마다) — heartbeat가 10분 넘게 멈췄는데 감시 잡이 사라진 실행 표시를 다시 예약.
 */
import type { FastifyPluginAsync } from 'fastify';
import type { JobRegistry } from '../domains';
import { z, parseBody } from '../lib/validate';
import { notFound } from '../lib/errors';
import { isSafeId } from '../lib/ids';
import { CHANGE_KINDS, APPROVAL_LEVELS, CHANGE_STATUSES, getChange, listChanges, listExecutions, toChange } from './model';
import { ChangeConflict, createChange, patchChange, preflight, runExecuteJob, sweepStale } from './service';

export { configureChanges, resetChangesConfig, settleInflight } from './service';

const value = z.union([z.string().max(2000, '값은 2,000자 이하로 입력해 주세요'), z.number()]);
const kind = z.enum(CHANGE_KINDS as [string, ...string[]]);
const approver = z.enum(APPROVAL_LEVELS as [string, ...string[]]);
const status = z.enum(CHANGE_STATUSES as [string, ...string[]]);

const ChangeBody = z.object({
  change: z.object({
    id: z.string().max(200).optional(),
    module: z.string().trim().min(1, '모듈을 입력해 주세요').max(40).regex(/^[A-Za-z][A-Za-z0-9_.-]*$/, '모듈 이름 형식이 올바르지 않습니다'),
    kind,
    target: z.string().trim().min(1, '대상을 입력해 주세요').max(300),
    targetId: z.string().max(300).nullable().optional(),
    before: value,
    after: value,
    changePct: z.number().nullable().optional(),
    reason: z.string().max(2000, '사유는 2,000자 이하로 입력해 주세요').default(''),
    requestedBy: z.string().max(200).optional(),
    approver,
    status: status.optional(),
  }),
});

const PatchBody = z.object({
  patch: z.object({
    status: status.optional(),
    target: z.string().trim().min(1).max(300).optional(),
    targetId: z.string().max(300).nullable().optional(),
    before: value.optional(),
    after: value.optional(),
    changePct: z.number().nullable().optional(),
    reason: z.string().max(2000, '사유는 2,000자 이하로 입력해 주세요').optional(),
    approver: approver.optional(),
  }).default({}),
  action: z.string().max(60).optional(),
  note: z.string().max(2000, '메모는 2,000자 이하로 입력해 주세요').optional(),
});

const ListQuery = z.object({ status: status.optional(), limit: z.coerce.number().int().min(1).max(500).optional() });

export const routes: FastifyPluginAsync = async (app) => {
  const env = { db: app.ctx.db, config: app.ctx.config };

  app.get('/w/:ws/changes', async (req) => {
    const c = await req.workspace('read');
    const qy = parseBody(ListQuery, req.query);
    const rows = await listChanges(env.db, c.workspace.id, { status: qy.status as never, limit: qy.limit ?? 500 });
    return { changes: rows.map((r) => toChange(r, { compact: true })) };
  });

  app.post('/w/:ws/changes', async (req, reply) => {
    const c = await req.workspace('request');
    const body = parseBody(ChangeBody, req.body);
    const r = await createChange(env, c, body.change as Parameters<typeof createChange>[2]);
    reply.status(r.created ? 201 : 200);
    return { change: r.change };
  });

  app.get('/w/:ws/changes/:id', async (req) => {
    const c = await req.workspace('read');
    const { id } = req.params as { id: string };
    const row = isSafeId(id) ? await getChange(env.db, c.workspace.id, id) : null;
    if (!row) throw notFound('변경 요청을 찾을 수 없습니다');
    return { change: toChange(row) };
  });

  app.get('/w/:ws/changes/:id/executions', async (req) => {
    const c = await req.workspace('read');
    const { id } = req.params as { id: string };
    const row = isSafeId(id) ? await getChange(env.db, c.workspace.id, id) : null;
    if (!row) throw notFound('변경 요청을 찾을 수 없습니다');
    const list = await listExecutions(env.db, c.workspace.id, id);
    return {
      executions: list.map((e) => ({
        id: e.id, attemptId: e.attempt_id, phase: e.phase, mode: e.mode, ok: e.ok, connectionId: e.connection_id, provider: e.provider,
        targetExternalId: e.target_external_id, request: e.request, response: e.response, error: e.error, appliedValue: e.applied_value, actor: e.actor,
        startedAt: new Date(e.started_at).toISOString(), finishedAt: new Date(e.finished_at).toISOString(),
      })),
    };
  });

  app.get('/w/:ws/changes/:id/preflight', async (req) => {
    const c = await req.workspace('read');
    const { id } = req.params as { id: string };
    if (!isSafeId(id)) throw notFound('변경 요청을 찾을 수 없습니다');
    return preflight(env, c.workspace.id, id);
  });

  app.patch('/w/:ws/changes/:id', async (req, reply) => {
    const c = await req.workspace('request');
    const { id } = req.params as { id: string };
    if (!isSafeId(id)) throw notFound('변경 요청을 찾을 수 없습니다');
    const body = parseBody(PatchBody, req.body);
    try {
      const change = await patchChange(env, c, id, body as Parameters<typeof patchChange>[3]);
      return { change };
    } catch (e) {
      if (e instanceof ChangeConflict) {
        return reply.status(409).send({ error: { code: e.code, message: e.message, detail: e.detail }, change: e.change });
      }
      throw e;
    }
  });
};

export function jobs(reg: JobRegistry): void {
  reg.job('changes.execute', async (jc) => {
    if (!jc.workspaceId) return { result: 'no_workspace' };
    return runExecuteJob({ db: jc.db, config: jc.config }, jc.workspaceId, jc.payload);
  });
  reg.schedule('changes.sweep', '*/10 * * * *', async (sc) => {
    await sweepStale({ db: sc.db, config: sc.config });
  });
}
