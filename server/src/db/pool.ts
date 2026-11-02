/**
 * PostgreSQL 접근 — pg Pool 래퍼. 도메인 코드는 Db 인터페이스만 쓴다(테스트에서 스키마별 Pool 주입).
 */
import pg from 'pg';

// numeric · bigint를 JS number로 (금액 · 지표는 Number 안전 범위 안)
pg.types.setTypeParser(1700, (v) => (v === null ? null : Number(v)) as unknown as string);
pg.types.setTypeParser(20, (v) => (v === null ? null : Number(v)) as unknown as string);
// date는 'YYYY-MM-DD' 문자열 그대로 (시간대 변환 방지)
pg.types.setTypeParser(1082, (v) => v);

export type Row = Record<string, unknown>;

export interface Queryable {
  query<T = Row>(text: string, params?: unknown[]): Promise<{ rows: T[]; rowCount: number }>;
}

export interface Db extends Queryable {
  /** 트랜잭션: fn 안의 쿼리는 같은 연결에서 실행, 예외 시 롤백 */
  tx<T>(fn: (q: Queryable) => Promise<T>): Promise<T>;
  /** LISTEN 전용 연결 (이벤트 허브) */
  connect(): Promise<pg.PoolClient>;
  end(): Promise<void>;
  pool: pg.Pool;
}

export function createDb(connectionString: string, opts: { searchPath?: string; max?: number } = {}): Db {
  const pool = new pg.Pool({
    connectionString,
    max: opts.max ?? 10,
    options: opts.searchPath ? `-c search_path=${opts.searchPath}` : undefined,
  });
  pool.on('error', (err) => {
    // 유휴 연결 오류는 프로세스를 죽이지 않는다 (pg 권장)
    console.error('[db] idle client error', err.message);
  });
  const query = async <T = Row>(text: string, params?: unknown[]) => {
    const r = await pool.query(text, params as unknown[]);
    return { rows: r.rows as T[], rowCount: r.rowCount ?? 0 };
  };
  return {
    pool,
    query,
    async tx<T>(fn: (q: Queryable) => Promise<T>): Promise<T> {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const q: Queryable = {
          query: async <R = Row>(text: string, params?: unknown[]) => {
            const r = await client.query(text, params as unknown[]);
            return { rows: r.rows as R[], rowCount: r.rowCount ?? 0 };
          },
        };
        const out = await fn(q);
        await client.query('COMMIT');
        return out;
      } catch (e) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw e;
      } finally {
        client.release();
      }
    },
    connect: () => pool.connect(),
    end: () => pool.end(),
  };
}

/** 단건 조회 헬퍼 */
export async function one<T = Row>(q: Queryable, text: string, params?: unknown[]): Promise<T | null> {
  const r = await q.query<T>(text, params);
  return r.rows[0] ?? null;
}
