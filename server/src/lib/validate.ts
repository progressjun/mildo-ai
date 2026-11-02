import { z } from 'zod';
import { badRequest } from './errors';

/** 요청 본문 · 쿼리 검증 — 실패하면 400 + 필드별 사유 */
export function parseBody<T extends z.ZodType>(schema: T, input: unknown): z.infer<T> {
  const r = schema.safeParse(input ?? {});
  if (!r.success) {
    const issues = r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message }));
    throw badRequest(`입력값을 확인해 주세요: ${issues.map((i) => i.path || '(본문)').join(', ')}`, issues);
  }
  return r.data;
}
export { z };
