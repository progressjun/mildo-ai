import { useState } from 'react';
import { broadcastReset, useStore } from '@/core/store';
import { Button, Callout, Field, Modal, Segmented } from '@/ui/primitives';
import { useAi } from '@/ai/useAi';
import { BACKEND_LABEL } from '@/ai/claude';
import type { AiSettings } from '@/core/types';
import { useSaas } from '@/saas/context';
import { dataSourceLabel, describeSources } from '@/saas/sync';

const DEMO_AI_OPTIONS: { id: AiSettings['mode']; label: string }[] = [{ id: 'auto', label: '자동' }, { id: 'artifact', label: 'claude.ai' }, { id: 'anthropic', label: 'API 키' }, { id: 'offline', label: '규칙 엔진만' }];
/** 서버 모드: 조직 키(서버 환경변수의 Anthropic 키)로 서버가 호출 — 'auto'도 서버 백엔드를 고른다 */
const SERVER_AI_OPTIONS: { id: AiSettings['mode']; label: string }[] = [{ id: 'auto', label: '자동' }, { id: 'server', label: 'MILDO 서버 (조직 키)' }, { id: 'anthropic', label: 'API 키' }, { id: 'offline', label: '규칙 엔진만' }];

export function SettingsDialog({ onClose }: { onClose: () => void }) {
  const { state, dispatch, sync } = useStore();
  const saas = useSaas();
  const serverMode = saas.mode === 'server' && !!sync;
  const [reloading, setReloading] = useState(false);
  const ds = dataSourceLabel(state.data.meta);
  const ai = useAi();
  const [key, setKey] = useState(state.ai.apiKey);
  const [confirmReset, setConfirmReset] = useState(false);
  const inArtifact = typeof window !== 'undefined' && 'claude' in window;
  return (
    <Modal title="설정" onClose={onClose} footer={<Button variant="primary" onClick={() => { dispatch({ type: 'ai/set', patch: { apiKey: key.trim() } }); onClose(); }}>저장</Button>}>
      <div className="stack-lg">
        <Field label="AI 연결 방식" id="ai-mode">
          <Segmented<AiSettings['mode']> label="AI 연결 방식" value={state.ai.mode} onChange={(mode) => dispatch({ type: 'ai/set', patch: { mode } })}
            options={serverMode ? SERVER_AI_OPTIONS : DEMO_AI_OPTIONS} />
        </Field>
        <div className="small ink2">현재 상태: <strong>{ai.backend === 'checking' ? '확인 중' : (BACKEND_LABEL as Record<string, string>)[ai.backend] ?? ai.backend}</strong>{inArtifact ? (ai.backend === 'artifact' ? ' · claude.ai 아티팩트에서 실행 중 (API 키 없이 보는 사람의 Claude 계정으로 동작)' : ' · claude.ai 아티팩트에서 실행 중') : ''}</div>
        <Field label="Anthropic API 키 (로컬 · 사내 배포용)" id="api-key" hint="이 브라우저의 localStorage에만 저장되며 api.anthropic.com으로만 전송됩니다. 공용 PC에서는 입력하지 마세요.">
          <input id="api-key" className="input" type="password" autoComplete="off" placeholder="sk-ant-..." value={key} onChange={(e) => setKey(e.target.value)} />
        </Field>
        <Field label="모델" id="ai-model">
          <select id="ai-model" className="select" value={state.ai.model} onChange={(e) => dispatch({ type: 'ai/set', patch: { model: e.target.value } })}>
            <option value="claude-opus-5-5">Claude Opus 5.5 (기본)</option>
            <option value="claude-sonnet-5-5">Claude Sonnet 5.5</option>
            <option value="claude-haiku-5-5">Claude Haiku 5.5</option>
          </select>
        </Field>
        {serverMode ? (
          <Callout tone={ds.tone === 'live' ? 'good' : 'info'} title={`데이터 안내 · ${ds.label}`}>
            {ds.tone === 'demo'
              ? '이 워크스페이스는 아직 실연동 데이터가 없어 테스트 데이터(TEST DATA, 데모 커넥터)로 표시합니다. 07 관리 · 연동의 데이터 연결에서 매체 · 판매 채널 API를 연결하거나 CSV를 올리면 LIVE DATA로 바뀝니다.'
              : ds.tone === 'empty'
                ? '이 워크스페이스에는 아직 연결된 데이터 출처가 없습니다. 07 관리 · 연동의 데이터 연결에서 매체 · 판매 채널 API를 연결하거나 CSV를 올려 주세요. 연결 전까지 성과 화면의 수치는 비어 있습니다.'
              : ds.tone === 'mixed'
                ? '일부 매체 · 채널만 실연동 데이터이고 나머지는 테스트 데이터입니다. 출처 태그에 마우스를 올리면 매체별 출처와 최신 시각을 볼 수 있습니다.'
                : '연결된 매체 · 판매 채널에서 수집한 실데이터입니다.'}
            {state.data.meta ? <div className="xs muted" style={{ marginTop: 4, whiteSpace: 'pre-line' }}>{describeSources(state.data.meta).join('\n')}</div> : null}
          </Callout>
        ) : (
          <Callout tone="info" title="데이터 안내">
            화면의 성과 수치는 시연용 테스트 데이터(TEST DATA)입니다. RFP · 제안서 기준값은 출처 태그로 구분합니다. 실계정 연동은 Pro-board 수집기(scripts/)로 Dataset을 교체합니다.
          </Callout>
        )}
        {serverMode ? (
          <div className="row">
            <Button size="sm" icon="refresh" disabled={reloading} onClick={async () => {
              setReloading(true);
              try {
                await sync!.reloadAll();
                dispatch({ type: 'toast/push', toast: { id: `t_reload_${Date.now()}`, tone: 'good', title: '서버 데이터를 다시 불러왔습니다', body: '성과 데이터 · 변경 요청 · 이슈 · 코멘트 · 화면 입력값' } });
              } finally {
                setReloading(false);
              }
            }}>{reloading ? '불러오는 중…' : '화면 새로고침(서버 데이터 다시 불러오기)'}</Button>
            <span className="xs muted">서버 데이터는 지우지 않습니다. 승인 이력 · 이슈는 서버에 그대로 남고 감사 로그로 추적됩니다.</span>
          </div>
        ) : (
        <div className="row">
          {confirmReset ? (
            <Button variant="danger" size="sm" icon="refresh" onClick={(e) => { if (e.detail > 1) return; /* 더블클릭의 두 번째 클릭이 같은 자리에 나타난 확인 버튼을 누르지 않게 */ dispatch({ type: 'reset' }); broadcastReset(); onClose(); }}>정말 초기화</Button>
          ) : (
            <Button size="sm" icon="refresh" onClick={() => setConfirmReset(true)}>시연 상태 초기화</Button>
          )}
          <span className="xs muted">승인 이력 · 이슈 처리 상태 · 코멘트를 처음 상태로 되돌립니다.</span>
        </div>
        )}
      </div>
    </Modal>
  );
}
