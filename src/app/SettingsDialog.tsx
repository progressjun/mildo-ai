import { useState } from 'react';
import { useStore } from '@/core/store';
import { Button, Callout, Field, Modal, Segmented } from '@/ui/primitives';
import { useAi } from '@/ai/useAi';
import { BACKEND_LABEL } from '@/ai/claude';
import type { AiSettings } from '@/core/types';

export function SettingsDialog({ onClose }: { onClose: () => void }) {
  const { state, dispatch } = useStore();
  const ai = useAi();
  const [key, setKey] = useState(state.ai.apiKey);
  const [confirmReset, setConfirmReset] = useState(false);
  const inArtifact = typeof window !== 'undefined' && 'claude' in window;
  return (
    <Modal title="설정" onClose={onClose} footer={<Button variant="primary" onClick={() => { dispatch({ type: 'ai/set', patch: { apiKey: key.trim() } }); onClose(); }}>저장</Button>}>
      <div className="stack-lg">
        <Field label="AI 연결 방식" id="ai-mode">
          <Segmented<AiSettings['mode']> label="AI 연결 방식" value={state.ai.mode} onChange={(mode) => dispatch({ type: 'ai/set', patch: { mode } })}
            options={[{ id: 'auto', label: '자동' }, { id: 'artifact', label: 'claude.ai' }, { id: 'anthropic', label: 'API 키' }, { id: 'offline', label: '규칙 엔진만' }]} />
        </Field>
        <div className="small ink2">현재 상태: <strong>{ai.backend === 'checking' ? '확인 중' : BACKEND_LABEL[ai.backend]}</strong>{inArtifact ? ' · claude.ai 아티팩트에서 실행 중 (API 키 없이 보는 사람의 Claude 계정으로 동작)' : ''}</div>
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
        <Callout tone="info" title="데이터 안내">
          화면의 성과 수치는 시연용 테스트 데이터(TEST DATA)입니다. RFP · 제안서 기준값은 출처 태그로 구분합니다. 실계정 연동은 Pro-board 수집기(scripts/)로 Dataset을 교체합니다.
        </Callout>
        <div className="row">
          {confirmReset ? (
            <Button variant="danger" size="sm" icon="refresh" onClick={() => { dispatch({ type: 'reset' }); onClose(); }}>정말 초기화</Button>
          ) : (
            <Button size="sm" icon="refresh" onClick={() => setConfirmReset(true)}>시연 상태 초기화</Button>
          )}
          <span className="xs muted">승인 이력 · 이슈 처리 상태 · 코멘트를 처음 상태로 되돌립니다.</span>
        </div>
      </div>
    </Modal>
  );
}
