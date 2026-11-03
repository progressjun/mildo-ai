/**
 * state 도메인 진입점 (platform 담당, docs/SAAS_SPEC.md §4 platform · §6 platform(state))
 *
 *   GET   /api/w/:ws/comments[?target=]        read     → { comments }
 *   POST  /api/w/:ws/comments { comment }        comment  → { comment }   (클라이언트 id 허용 — 낙관적 생성 · 멱등 재시도)
 *   PATCH /api/w/:ws/comments/:id { resolved }   comment  → { comment }
 *   GET   /api/w/:ws/state                       read     → { state: Record<key, value> }
 *   PUT   /api/w/:ws/state/:key { value }        comment  → { state: { [key]: value }, key, updatedAt, unchanged }
 *         (value = null이면 삭제 — 프런트 localStorage.removeItem 미러)
 *   DELETE /api/w/:ws/state/:key                 comment  → { ok, deleted }
 *
 * 키는 프런트 localStorage 키 그대로('mildo-os/lab/v1' 등, 슬래시 포함) — 경로에서는 그대로 쓰거나 %2F로 인코딩해도 된다.
 * 모든 쓰기는 감사(audit) · 이벤트(publish 'comment' | 'state')를 남긴다.
 */
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import type { JobRegistry } from '../domains';
import { z, parseBody } from '../lib/validate';
import { HttpError, badRequest, conflict, notFound } from '../lib/errors';
import { isSafeId, randomToken } from '../lib/ids';
import { audit } from '../audit/audit';
import { publish } from '../events/hub';
import {
  STATE_KEY_RE, STATE_MAX_KEYS, STATE_VALUE_MAX_BYTES, canonicalJson, countStateKeys, deleteState, getComment, getStateRow, insertComment,
  listComments, loadState, setCommentResolved, stateValueBytes, toCommentDto, upsertState,
} from './service';


const CommentBody = z.object({
  comment: z.object({
    id: z.string().optional(),
    target: z.string().trim().min(1, '대상을 입력해 주세요').max(200),
    text: z.string().trim().min(1, '내용을 입력해 주세요').max(4000, '코멘트는 4,000자 이하로 입력해 주세요'),
  }),
});
const ResolveBody = z.object({ resolved: z.boolean() });
const StateBody = z.object({ value: z.unknown() });
const ListQuery = z.object({ target: z.string().max(200).optional(), limit: z.coerce.number().int().min(1).max(5000).optional() });

/** 경로의 키 (:key 또는 와일드카드) — 형식이 맞지 않으면 400 */
function stateKeyOf(req: FastifyRequest): string {
  const raw = (req.params as Record<string, string | undefined>)['*'] ?? '';
  let key = raw;
  try { key = decodeURIComponent(raw); } catch { /* 이미 디코딩된 값 */ }
  if (!STATE_KEY_RE.test(key)) throw badRequest('저장 키 형식이 올바르지 않습니다 (영문 소문자 · 숫자 · : / . _ - , 120자 이하)');
  return key;
}

export const routes: FastifyPluginAsync = async (app) => {
  const { db } = app.ctx;

  /* ---------- 코멘트 ---------- */

  app.get('/w/:ws/comments', async (req) => {
    const c = await req.workspace('read');
    const qy = parseBody(ListQuery, req.query);
    return { comments: await listComments(db, c.workspace.id, { target: qy.target, limit: qy.limit }) };
  });

  app.post('/w/:ws/comments', async (req, reply) => {
    const c = await req.workspace('comment');
    const body = parseBody(CommentBody, req.body);
    const inputId = body.comment.id;
    if (inputId !== undefined && !isSafeId(inputId)) throw badRequest('코멘트 id 형식이 올바르지 않습니다');
    const id = inputId ?? `cm_${randomToken(9)}`;
    const ws = c.workspace.id;
    const created = await db.tx(async (q) => {
      const row = await insertComment(q, ws, { id, target: body.comment.target, text: body.comment.text, author: c.actor, authorUser: c.user.id, authorRole: c.role });
      if (!row) return null;
      await audit(q, { workspaceId: ws, userId: c.user.id, actor: c.actor, action: 'comment.create', targetType: 'comment', targetId: id, detail: { target: row.target, length: row.text.length }, ip: c.ip });
      await publish(q, ws, { type: 'comment', id });
      return row;
    });
    if (created) {
      reply.status(201);
      return { comment: toCommentDto(created) };
    }
    // 같은 id가 이미 있음: 같은 사람의 같은 내용이면 재시도(멱등) — 그대로 돌려준다, 아니면 충돌
    const existing = await getComment(db, ws, id);
    if (existing && existing.author_user === c.user.id && existing.target === body.comment.target && existing.text === body.comment.text) {
      return { comment: toCommentDto(existing) };
    }
    throw conflict('같은 id의 코멘트가 이미 있습니다. 새로고침 후 다시 시도해 주세요');
  });

  app.patch('/w/:ws/comments/:id', async (req) => {
    const c = await req.workspace('comment');
    const { id } = req.params as { id: string };
    if (!isSafeId(id)) throw notFound('코멘트를 찾을 수 없습니다');
    const body = parseBody(ResolveBody, req.body);
    const ws = c.workspace.id;
    const updated = await db.tx(async (q) => {
      const before = await getComment(q, ws, id);
      if (!before) return null;
      if (before.resolved === body.resolved) return before;
      const row = await setCommentResolved(q, ws, id, body.resolved, c.user.id);
      await audit(q, {
        workspaceId: ws, userId: c.user.id, actor: c.actor, action: body.resolved ? 'comment.resolve' : 'comment.reopen',
        targetType: 'comment', targetId: id, detail: { target: before.target, before: { resolved: before.resolved }, after: { resolved: body.resolved } }, ip: c.ip,
      });
      await publish(q, ws, { type: 'comment', id });
      return row;
    });
    if (!updated) throw notFound('코멘트를 찾을 수 없습니다');
    return { comment: toCommentDto(updated) };
  });

  /* ---------- 모듈 로컬 입력 (workspace_state) ---------- */

  app.get('/w/:ws/state', async (req) => {
    const c = await req.workspace('read');
    return { state: await loadState(db, c.workspace.id) };
  });

  app.put('/w/:ws/state/*', async (req) => {
    const c = await req.workspace('comment');
    const key = stateKeyOf(req);
    const body = parseBody(StateBody, req.body);
    if (!body || !Object.prototype.hasOwnProperty.call(req.body ?? {}, 'value')) throw badRequest('입력값을 확인해 주세요: value');
    const value = body.value === undefined ? null : body.value;
    const bytes = stateValueBytes(value);
    if (bytes > STATE_VALUE_MAX_BYTES) throw new HttpError(413, 'too_large', `저장 값이 너무 큽니다 (${Math.ceil(bytes / 1024)}KB · 최대 256KB)`);
    const ws = c.workspace.id;
    return db.tx(async (q) => {
      const before = await getStateRow(q, ws, key);
      if (value === null) {
        if (!before) return { state: { [key]: null }, key, updatedAt: null, unchanged: true };
        await deleteState(q, ws, key);
        await audit(q, { workspaceId: ws, userId: c.user.id, actor: c.actor, action: 'state.delete', targetType: 'state', targetId: key, detail: { key, beforeBytes: stateValueBytes(before.value) }, ip: c.ip });
        await publish(q, ws, { type: 'state', id: key });
        return { state: { [key]: null }, key, updatedAt: null, unchanged: false };
      }
      if (before && canonicalJson(before.value) === canonicalJson(value)) {
        return { state: { [key]: before.value }, key, updatedAt: new Date(before.updated_at).toISOString(), unchanged: true };
      }
      if (!before && (await countStateKeys(q, ws)) >= STATE_MAX_KEYS) {
        throw conflict(`저장 키가 너무 많습니다 (워크스페이스당 최대 ${STATE_MAX_KEYS}개)`);
      }
      const row = await upsertState(q, ws, key, value, c.user.id);
      await audit(q, {
        workspaceId: ws, userId: c.user.id, actor: c.actor, action: 'state.update', targetType: 'state', targetId: key,
        detail: { key, bytes, beforeBytes: before ? stateValueBytes(before.value) : 0, created: !before }, ip: c.ip,
      });
      await publish(q, ws, { type: 'state', id: key });
      return { state: { [key]: value }, key, updatedAt: new Date(row.updated_at).toISOString(), unchanged: false };
    });
  });

  app.delete('/w/:ws/state/*', async (req) => {
    const c = await req.workspace('comment');
    const key = stateKeyOf(req);
    const ws = c.workspace.id;
    const deleted = await db.tx(async (q) => {
      const before = await getStateRow(q, ws, key);
      if (!before) return false;
      await deleteState(q, ws, key);
      await audit(q, { workspaceId: ws, userId: c.user.id, actor: c.actor, action: 'state.delete', targetType: 'state', targetId: key, detail: { key, beforeBytes: stateValueBytes(before.value) }, ip: c.ip });
      await publish(q, ws, { type: 'state', id: key });
      return true;
    });
    return { ok: true, deleted };
  });
};

export function jobs(_reg: JobRegistry): void {
  /* state 도메인은 잡이 없다 */
}
