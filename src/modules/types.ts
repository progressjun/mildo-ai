import type { LazyExoticComponent, ComponentType } from 'react';
import type { AgentTool } from '@/ai/claude';
import type { Brief } from '@/ai/prompts';
import type { AppState, useActions } from '@/core/store';

/** 에이전트 도구 · 오프라인 브리프가 받는 컨텍스트 */
export interface ToolContext {
  state: AppState;
  actions: ReturnType<typeof useActions>;
  navigate: (route: string) => void;
}

/** AI 미연결 시 질문 키워드로 고르는 규칙 기반 답변 */
export interface OfflineBrief {
  id: string;
  /** 질문과 매칭할 정규식 */
  match: RegExp;
  build: (ctx: ToolContext) => Brief;
}

export interface ModuleAgentKit {
  tools: (ctx: ToolContext) => AgentTool[];
  briefs?: OfflineBrief[];
}

export interface ModuleDef {
  id: string; // 해시 라우트
  title: string; // 한글 메뉴명
  eng: string; // 영문 라벨 (eyebrow)
  group: 'overview' | 'automation' | 'monitoring' | 'growth' | 'stability' | 'team';
  summary: string;
  /** 제안서 장표 · RFP 항목 */
  sources: string;
  Component: LazyExoticComponent<ComponentType>;
  agent?: ModuleAgentKit;
}
