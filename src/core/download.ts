/**
 * 파일 내보내기 / 복사.
 * - claude.ai 아티팩트: `downloads` 기능 (보는 사람 확인 후 저장)
 * - 일반 브라우저: Blob + <a download>
 */
type DownloadsNs = { save: (o: { filename: string; data: string | Blob }) => Promise<unknown> };

let dlPromise: Promise<DownloadsNs | null> | null = null;
function getDownloads(): Promise<DownloadsNs | null> {
  if (dlPromise) return dlPromise;
  const w = window as unknown as { claude?: { use: (n: string) => Promise<unknown> } };
  dlPromise = w.claude?.use ? w.claude.use('downloads').then((d) => (d as DownloadsNs) ?? null).catch(() => null) : Promise.resolve(null);
  return dlPromise;
}

export async function saveFile(filename: string, data: string, mime = 'text/plain;charset=utf-8'): Promise<'saved' | 'declined' | 'unavailable'> {
  const w = window as unknown as { claude?: unknown };
  if (w.claude) {
    const dl = await getDownloads();
    if (dl) {
      try {
        await dl.save({ filename, data: new Blob([data], { type: mime }) });
        return 'saved';
      } catch {
        return 'declined';
      }
    }
    return 'unavailable';
  }
  try {
    const blob = new Blob([data], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
    return 'saved';
  } catch {
    return 'unavailable';
  }
}

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      return ok;
    } catch {
      return false;
    }
  }
}

/** CSV 직렬화 (엑셀 한글 깨짐 방지 BOM 포함) */
export function toCsv(rows: Record<string, unknown>[], columns?: { key: string; label: string }[]): string {
  if (!rows.length) return '';
  const cols = columns ?? Object.keys(rows[0]).map((k) => ({ key: k, label: k }));
  const esc = (v: unknown) => {
    const s = v == null ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return '﻿' + [cols.map((c) => esc(c.label)).join(','), ...rows.map((r) => cols.map((c) => esc(r[c.key])).join(','))].join('\n');
}
