import type { SetStateAction } from 'react';
import { vi } from 'vitest';
import type { AgentDetail, Message } from '@/lib/api';
import type {
  StreamingAttention,
  StreamingBubble,
  StreamingPlan,
  StreamingTool,
} from '@/features/agent-context/types';
import type { RealtimeSetters } from '@/features/agent-context/hooks/realtimeHandlers';

function applyState<T>(current: T, action: SetStateAction<T>): T {
  return typeof action === 'function' ? (action as (previous: T) => T)(current) : action;
}

export function mkSetters() {
  const state = {
    streamingBubbles: new Map<string, StreamingBubble>(),
    streamingPlan: null as StreamingPlan | null,
    streamingAttention: null as StreamingAttention | null,
    streamingTools: new Map<string, StreamingTool>(),
    messages: [] as Message[],
    agent: null as AgentDetail | null,
    isChatMode: false,
  };
  return {
    state,
    setStreamingBubbles: (action: SetStateAction<Map<string, StreamingBubble>>) => {
      state.streamingBubbles = applyState(state.streamingBubbles, action);
    },
    setStreamingPlan: (action: SetStateAction<StreamingPlan | null>) => {
      state.streamingPlan = applyState(state.streamingPlan, action);
    },
    setStreamingAttention: (action: SetStateAction<StreamingAttention | null>) => {
      state.streamingAttention = applyState(state.streamingAttention, action);
    },
    setStreamingTools: (action: SetStateAction<Map<string, StreamingTool>>) => {
      state.streamingTools = applyState(state.streamingTools, action);
    },
    setMessages: (action: SetStateAction<Message[]>) => {
      state.messages = applyState(state.messages, action);
    },
    setAgent: (action: SetStateAction<AgentDetail | null>) => {
      state.agent = applyState(state.agent, action);
    },
    setIsChatMode: (action: SetStateAction<boolean>) => {
      state.isChatMode = applyState(state.isChatMode, action);
    },
    dispatchMessage: vi.fn(),
  } satisfies RealtimeSetters & { state: typeof state };
}
