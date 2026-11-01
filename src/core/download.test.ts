import { afterEach, describe, expect, it, vi } from 'vitest';

const g = globalThis as unknown as { window?: unknown };
async function load(save: (o: { filename: string; data: unknown }) => Promise<unknown>) {
  vi.resetModules();
  g.window = { claude: { use: async (n: string) => (n === 'downloads' ? { save } : null) } };
  return import('./download');
}
afterEach(() => {
  delete g.window;
});

describe('saveFile — claude.ai downloads 계약', () => {
  it('수락 → saved', async () => {
    const { saveFile } = await load(async () => ({ status: 'saved' }));
    expect(await saveFile('a.csv', 'x,y')).toBe('saved');
  });
  it('보는 사람이 거절 → declined (오류 표시 · 재시도 없음)', async () => {
    const { saveFile } = await load(async () => { throw { code: 'declined' }; });
    expect(await saveFile('a.md', '# t')).toBe('declined');
  });
  it('확장자 거부 · 잘못된 요청 → failed (사용자에게 알림)', async () => {
    const { saveFile } = await load(async () => { throw { code: 'rejected_extension' }; });
    expect(await saveFile('a.exe', 'x')).toBe('failed');
  });
  it('빈 데이터는 보내지 않는다', async () => {
    const save = vi.fn(async () => ({ status: 'saved' }));
    const { saveFile } = await load(save);
    expect(await saveFile('a.csv', '')).toBe('failed');
    expect(save).not.toHaveBeenCalled();
  });
});
