import { useEffect, useState } from 'react';
import { useStore } from '@/core/store';
import { ask, askJson, resolveBackend, type AskOptions, type Backend, type Turn } from './claude';

/** 현재 설정 기준 AI 백엔드 + 호출 함수 */
export function useAi() {
  const { state } = useStore();
  const [backend, setBackend] = useState<Backend | 'checking'>('checking');
  useEffect(() => {
    let alive = true;
    resolveBackend(state.ai).then((b) => alive && setBackend(b));
    return () => {
      alive = false;
    };
  }, [state.ai]);
  return {
    backend,
    connected: backend === 'artifact' || backend === 'anthropic',
    ask: (input: string | Turn[], opts?: AskOptions) => ask(state.ai, input, opts),
    askJson: <T,>(prompt: string, opts?: Omit<AskOptions, 'tools'>) => askJson<T>(state.ai, prompt, opts),
  };
}
