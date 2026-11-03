import { useEffect, useState } from 'react';
import { useStore } from '@/core/store';
import { ask, askJson, onBackendChange, resolveBackend, type AskOptions, type Backend, type Turn } from './claude';

/** 현재 설정 기준 AI 백엔드 + 호출 함수 */
export function useAi() {
  const { state } = useStore();
  const [backend, setBackend] = useState<Backend | 'checking'>('checking');
  // 보는 사람이 Claude 사용을 거부하면(not_granted 등) 모든 화면의 연결 상태를 다시 계산한다
  const [epoch, setEpoch] = useState(0);
  useEffect(() => onBackendChange(() => setEpoch((n) => n + 1)), []);
  useEffect(() => {
    let alive = true;
    resolveBackend(state.ai).then((b) => alive && setBackend(b));
    return () => {
      alive = false;
    };
  }, [state.ai, epoch]);
  return {
    backend,
    connected: backend === 'artifact' || backend === 'anthropic' || backend === 'server',
    ask: (input: string | Turn[], opts?: AskOptions) => ask(state.ai, input, opts),
    askJson: <T,>(prompt: string, opts?: Omit<AskOptions, 'tools'>) => askJson<T>(state.ai, prompt, opts),
  };
}
