/**
 * CSV · TSV 업로드 API (docs/SAAS_SPEC.md §6 data)
 *   POST   /api/w/:ws/uploads { template, filename, content, mapping?, dryRun?, channel?, connectionId? }  (operate) → { upload, preview, issues, columns, summary }
 *          dryRun=true: 저장 없이 앞 20행 정규화 결과 · 열 매핑 · 이슈만. false: 업로드 저장 + ingest.upload 잡 예약(워커가 가져온다)
 *   GET    /api/w/:ws/uploads (read) → { uploads }
 *   DELETE /api/w/:ws/uploads/:id (configure) → 그 업로드로 들어온 웨어하우스 데이터를 지운다
 *   GET    /api/uploads/templates (로그인) → { templates }
 *   GET    /api/uploads/templates/:template.csv (로그인) → 템플릿 CSV (UTF-8 BOM)
 */
import type { FastifyPluginAsync } from 'fastify';
import { z, parseBody } from '../lib/validate';
import { badRequest, notFound, HttpError } from '../lib/errors';
import { one } from '../db/pool';
import { audit } from '../audit/audit';
import { publish } from '../events/hub';
import { enqueue } from '../jobs/queue';
import { purgeSource } from '../warehouse/write';
import { loadConnection } from '../connectors/service';
import { blockingIssues, normalizeCsv, templateCsv, TEMPLATES, UPLOAD_TEMPLATES, type UploadTemplate } from '../connectors/csv';
import { MAX_UPLOAD_BYTES, TEMPLATE_HELP } from '@/modules/connections/csv';
import type { UploadRow } from './pipeline';

const UploadBody = z.object({
  template: z.enum(UPLOAD_TEMPLATES as [UploadTemplate, ...UploadTemplate[]]),
  filename: z.string().trim().min(1).max(200),
  content: z.string(),
  mapping: z.record(z.string(), z.string().max(200).nullable()).optional(),
  dryRun: z.boolean().optional(),
  channel: z.string().max(40).nullable().optional(),
  connectionId: z.string().uuid().nullable().optional(),
});

const iso = (v: Date | string | null | undefined) => (v ? new Date(v).toISOString() : null);

export function uploadView(u: Omit<UploadRow, 'content'> & { content?: string | null }) {
  return {
    id: u.id, connectionId: u.connection_id, template: u.template, filename: u.filename, bytes: Number(u.bytes), mapping: u.mapping ?? {}, channel: u.channel ?? null,
    status: u.status, summary: u.summary ?? {}, createdAt: iso(u.created_at), importedAt: iso(u.imported_at),
  };
}

export const uploadRoutes: FastifyPluginAsync = async (app) => {
  const { db } = app.ctx;

  app.post('/w/:ws/uploads', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req) => {
    const c = await req.workspace('operate');
    const ws = c.workspace.id;
    const body = parseBody(UploadBody, req.body);
    const bytes = Buffer.byteLength(body.content, 'utf8');
    if (bytes > MAX_UPLOAD_BYTES) throw new HttpError(413, 'payload_too_large', `파일이 너무 큽니다 (${Math.round(bytes / 1024 / 1024)}MB) — 20MB 이하로 나눠 올려 주세요`);
    if (!body.content.trim()) throw badRequest('파일 내용이 비어 있습니다');
    if (body.connectionId) {
      const conn = await loadConnection(db, ws, body.connectionId);
      if (!conn) throw notFound('커넥션을 찾을 수 없습니다');
      if (conn.provider !== 'csv') throw badRequest('업로드는 CSV 커넥션에만 연결할 수 있습니다');
    }
    const norm = normalizeCsv(body.template, body.content, { mapping: body.mapping, channel: body.channel ?? undefined });
    const columns = { headers: norm.summary.headers, mapping: norm.mapping.fields, missing: norm.mapping.missing, unmapped: norm.mapping.unmapped };
    const preview = norm.preview;
    if (body.dryRun) return { upload: null, preview, issues: norm.issues, columns, summary: norm.summary };
    const blocking = blockingIssues(norm.issues);
    if (blocking.length) {
      throw new HttpError(400, 'invalid_upload', `가져올 수 없습니다: ${blocking[0].message}`, { issues: norm.issues, preview, columns, summary: norm.summary });
    }
    const mapping = Object.fromEntries(Object.entries(norm.mapping.fields).filter(([, v]) => v)) as Record<string, string>;
    const { upload, jobId } = await db.tx(async (q) => {
      const u = await one<UploadRow>(
        q,
        `INSERT INTO uploads (workspace_id, connection_id, template, filename, bytes, mapping, status, summary, created_by, content, channel)
         VALUES ($1, $2, $3, $4, $5, $6, 'received', $7, $8, $9, $10) RETURNING *`,
        [ws, body.connectionId ?? null, body.template, body.filename, bytes, JSON.stringify(mapping), JSON.stringify(norm.summary), c.user.id, body.content, body.channel ?? null],
      );
      const jid = await enqueue(q, { type: 'ingest.upload', workspaceId: ws, payload: { uploadId: u!.id }, dedupeKey: `ingest.upload:${u!.id}`, maxAttempts: 3 });
      await audit(q, {
        workspaceId: ws, userId: c.user.id, actor: c.actor, action: 'upload.create', targetType: 'upload', targetId: u!.id, ip: c.ip,
        detail: { template: body.template, filename: body.filename, bytes, rows: norm.summary.rows, records: norm.summary.records, dateFrom: norm.summary.dateFrom, dateTo: norm.summary.dateTo, channels: norm.summary.channels },
      });
      await publish(q, ws, { type: 'connection', id: body.connectionId ?? undefined });
      return { upload: u!, jobId: jid };
    });
    return { upload: uploadView(upload), preview, issues: norm.issues, columns, summary: norm.summary, jobId };
  });

  app.get('/w/:ws/uploads', async (req) => {
    const c = await req.workspace('read');
    const rows = (await db.query<UploadRow>(
      `SELECT id, workspace_id, connection_id, template, filename, bytes, mapping, status, summary, channel, created_by, created_at, imported_at
         FROM uploads WHERE workspace_id = $1 ORDER BY created_at DESC LIMIT 100`, [c.workspace.id],
    )).rows;
    return { uploads: rows.map(uploadView) };
  });

  app.delete('/w/:ws/uploads/:id', async (req) => {
    const c = await req.workspace('configure');
    const ws = c.workspace.id;
    const { id } = req.params as { id: string };
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw notFound('업로드를 찾을 수 없습니다');
    const up = await one<UploadRow>(db, 'SELECT id, template, filename, connection_id FROM uploads WHERE workspace_id = $1 AND id = $2', [ws, id]);
    if (!up) throw notFound('업로드를 찾을 수 없습니다');
    const purged = await db.tx(async (q) => {
      const n = await purgeSource(q, ws, `csv:${id}`);
      await q.query(`UPDATE jobs SET status = 'failed', finished_at = now(), last_error = '업로드 삭제로 취소' WHERE workspace_id = $1 AND status = 'queued' AND payload->>'uploadId' = $2`, [ws, id]);
      await q.query('DELETE FROM uploads WHERE workspace_id = $1 AND id = $2', [ws, id]);
      await audit(q, { workspaceId: ws, userId: c.user.id, actor: c.actor, action: 'upload.delete', targetType: 'upload', targetId: id, ip: c.ip, detail: { template: up.template, filename: up.filename, purgedRows: n } });
      await publish(q, ws, { type: 'dataset' });
      await publish(q, ws, { type: 'connection', id: up.connection_id ?? undefined });
      return n;
    });
    return { ok: true, purgedRows: purged };
  });

  app.get('/uploads/templates', async (req) => {
    req.requireUser();
    return {
      templates: UPLOAD_TEMPLATES.map((t) => ({
        id: t, label: TEMPLATES[t].label, description: TEMPLATES[t].description, help: TEMPLATE_HELP[t], fixedChannel: TEMPLATES[t].fixedChannel ?? null,
        fields: TEMPLATES[t].fields.map((f) => ({ key: f.key, label: f.label, type: f.type, required: f.required, example: f.example })),
      })),
    };
  });

  app.get('/uploads/templates/:file', async (req, reply) => {
    req.requireUser();
    const { file } = req.params as { file: string };
    const t = file.replace(/\.csv$/i, '') as UploadTemplate;
    if (!file.toLowerCase().endsWith('.csv') || !UPLOAD_TEMPLATES.includes(t)) throw notFound('템플릿을 찾을 수 없습니다');
    reply
      .header('content-type', 'text/csv; charset=utf-8')
      .header('content-disposition', `attachment; filename="mildo_${t}.csv"`)
      .header('cache-control', 'no-store');
    return reply.send(templateCsv(t));
  });
};
