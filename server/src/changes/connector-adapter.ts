/**
 * 커넥터 연결부 — 커넥션 행 → (ConnectorDef, ConnectorContext).
 * 실행기는 이 해석기를 의존성으로 받는다(테스트는 가짜 커넥터를 주입, 실제 네트워크 호출 없음).
 *
 * 기본 해석기 = 커넥터 레지스트리(connectors/registry.ts) 정의 + data 도메인의 공용 컨텍스트 빌더
 * (connectors/service.ts buildConnectorContext — 자격증명 복호화 · 타임아웃 · 재시도 · 요청 로그 마스킹 · 토큰 갱신 저장).
 * 쓰기 재시도: 절대값 설정(입찰가 · 일 예산 · ON/OFF)은 같은 값을 다시 보내도 결과가 같아 재시도를 허용하고,
 * 신규 생성 · 키워드 추가는 중복 생성을 막기 위해 재시도하지 않는다.
 */
import type { AppConfig } from '../config';
import type { Db } from '../db/pool';
import type { ConnectorContext, ConnectorDef } from '../connectors/types';
import { getConnector } from '../connectors/registry';
import { buildConnectorContext, type ConnectionRow as ServiceConnectionRow } from '../connectors/service';
import type { ConnectionRow } from './targets';

export interface ConnectorBinding {
  def: ConnectorDef;
  context(opts: { dryRun: boolean; log: (msg: string, extra?: unknown) => void; idempotent?: boolean }): Promise<ConnectorContext>;
}

export type ConnectorResolver = (db: Db, config: AppConfig, conn: ConnectionRow) => Promise<ConnectorBinding | null>;

/** 쓰기 요청 기본 타임아웃 — 인라인 반영 제한(20초) 안에서 한 번은 끝나도록 */
export const WRITE_TIMEOUT_MS = 15_000;

export const defaultConnectorResolver: ConnectorResolver = async (db, config, conn) => {
  const def = getConnector(conn.provider);
  if (!def) return null;
  return {
    def,
    async context({ dryRun, log, idempotent = true }) {
      try {
        return buildConnectorContext(db, config, conn as unknown as ServiceConnectionRow, {
          dryRun, log, timeoutMs: WRITE_TIMEOUT_MS, maxRetries: idempotent ? 2 : 0,
        });
      } catch (e) {
        throw new Error(`커넥션 컨텍스트를 만들 수 없습니다 — 데이터 연결 화면에서 자격증명을 확인해 주세요 (${(e as Error).message})`);
      }
    },
  };
};
