import React from 'react';
import { render } from '@testing-library/react';
import { TooltipProvider } from '@/components/ui/tooltip';
import { AgentContext } from '@/features/agent-context';
import type { AgentContextValue } from '@/features/agent-context';
import type { Message } from '@/lib/api';

export function makeAgentCtx(overrides: Partial<AgentContextValue> = {}): AgentContextValue {
  const streamedTextsRef = { current: new Set<string>() } as React.MutableRefObject<Set<string>>;
  return {
    agent: null,
    applyAgentDetail: () => true,
    inspectionContext: null,
    stagePendingAgentCreation: () => {},
    reconcilePendingAgentCreation: async () => {},
    rollbackPendingAgentCreation: () => false,
    stageUserMessage: () => ({ confirm: () => {}, drop: () => {} }),
    selectedAgentId: null,
    setSelectedAgentId: () => {},
    messages: [],
    streamingBubbles: new Map(),
    streamingPlan: null,
    streamingAttention: null,
    streamingTools: new Map(),
    streamedTextsRef,
    registerMessageHandler: () => () => {},
    sendMessage: async () => {},
    isLoadingAgent: false,
    forceResubscribe: () => {},
    isChatMode: false,
    ...overrides,
  };
}

export function renderBubble(ui: React.ReactNode, agentCtx: AgentContextValue = makeAgentCtx()) {
  return render(
    <AgentContext.Provider value={agentCtx}>
      <TooltipProvider>{ui}</TooltipProvider>
    </AgentContext.Provider>,
  );
}

export function baseMessage(overrides: Partial<Message> = {}): Message {
  return {
    message_id: 'm-1',
    timestamp: new Date().toISOString(),
    text: 'hello',
    role: 'ASSISTANT',
    ...overrides,
  };
}

export function storeTestSession() {
  localStorage.setItem(
    'rose-session',
    JSON.stringify({
      access_token: 'test-token',
      expires_at: Math.floor(Date.now() / 1000) + 3600,
      user: { id: 'user-1' },
    }),
  );
}
