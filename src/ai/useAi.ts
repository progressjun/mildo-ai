import { useEffect, useState } from 'react';
import { useStore } from '@/core/store';
import { aiStatusNote, ask, askJson, backendLabel, onBackendChange, resolveBackend, type AiStatusNote, type AskOptions, type Backend, type Turn } from './claude';

/**
 * 현재 설정 기준 AI 백엔드 + 호출 함수.
 * note: 규칙 엔진으로 동작하는 실제 이유(서버 모드 — 서버 키 미설정 · AI 꺼짐 · 열람자 · 월 한도 · API 키 방식 차단). 데모에서는 null.
 * label: 상단 바 · 배지 문구 (규칙 엔진이면 이유를 괄호에).
 */
export function useAi(): {
  backend: Backend | 'checking';
  connected: boolean;
  note: AiStatusNote | null;
  label: string;
  ask: (input: string | Turn[], opts?: AskOptions) => ReturnType<typeof ask>;
  askJson: <T>(prompt: string, opts?: Omit<AskOptions, 'tools'>) => Promise<T>;
} {
  const { state } = useStore();
  const [backend, setBackend] = useState<Backend | 'checking'>('checking');
  // 보는 사람이 Claude 사용을 거부하면(not_granted 등) · 서버 AI 상태가 바뀌면 모든 화면의 연결 상태를 다시 계산한다
  const [epoch, setEpoch] = useState(0);
  useEffect(() => onBackendChange(() => setEpoch((n) => n + 1)), []);
  useEffect(() => {
    let alive = true;
    resolveBackend(state.ai).then((b) => alive && setBackend(b));
    return () => {
      alive = false;
    };
  }, [state.ai, epoch]);
  const note = aiStatusNote(state.ai, backend);
  return {
    backend,
    connected: backend === 'artifact' || backend === 'anthropic' || backend === 'server',
    note,
    label: backendLabel(backend, note),
    ask: (input: string | Turn[], opts?: AskOptions) => ask(state.ai, input, opts),
    askJson: <T,>(prompt: string, opts?: Omit<AskOptions, 'tools'>) => askJson<T>(state.ai, prompt, opts),
  };
}
