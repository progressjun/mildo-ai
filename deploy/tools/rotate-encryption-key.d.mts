/** rotate-encryption-key.mjs 타입 선언 (서버 테스트에서 import) */
export interface RotateQueryable {
  query(text: string, params?: unknown[]): Promise<{ rows: any[] }>;
}
export interface RotateColumnReport { table: string; column: string; rows: number; rotated: number; alreadyNew: number; skipped: number; failed: number }
export interface RotateReport {
  applied: boolean;
  columns: RotateColumnReport[];
  totals: { rows: number; rotated: number; alreadyNew: number; skipped: number; failed: number };
}
export function checkKey(b64: string | undefined, name?: string): string;
export function encryptV1(plain: string, keyB64: string): string;
export function decryptV1(blob: string, keyB64: string): string;
export function findEncryptedColumns(q: RotateQueryable): Promise<{ table: string; column: string }[]>;
export function rotateEncryptionKey(
  q: RotateQueryable,
  opts: { oldKey: string; newKey: string; apply?: boolean; columns?: { table: string; column: string }[] },
): Promise<RotateReport>;
