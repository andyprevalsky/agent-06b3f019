import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { TooltipProvider } from '@/components/ui/tooltip';
import { AgentContext, type AgentContextValue } from '@/features/agent-context';
import { MessageList } from '@/features/terminal-component-group/components/MessageList';
import type { AgentDetail } from '@/lib/api';

vi.mock('@/components/ThinkingAnimation', () => ({
  default: () => <div data-testid="thinking-animation" />,
}));

function makeAgent(status: AgentDetail['status']): AgentDetail {
  return {
    agent_id: 'agent-1',
    goal: 'do a thing',
    model: 'rose-1-lite',
    source: 'MAC_APP',
    reasoning_effort: 'medium',
    progress: status === 'COMPLETED' ? 1 : 0,
    status,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    messages: [],
  } as AgentDetail;
}

function makeContext(status: AgentDetail['status']): AgentContextValue {
  return {
    agent: makeAgent(status),
    setAgent: () => {},
    selectedAgentId: 'agent-1',
    setSelectedAgentId: () => {},
    messages: [],
    setMessages: () => {},
    streamingBubbles: new Map(),
    streamingPlan: null,
    streamingAttention: null,
    streamingTools: new Map(),
    streamedTextsRef: { current: new Set<string>() },
    registerMessageHandler: () => () => {},
    sendMessage: async () => {},
    isLoadingAgent: false,
    forceResubscribe: () => {},
    isChatMode: false,
  };
}

function renderMessageList(ctx: AgentContextValue) {
  return render(
    <AgentContext.Provider value={ctx}>
      <TooltipProvider>
        <MessageList />
      </TooltipProvider>
    </AgentContext.Provider>,
  );
}

describe('MessageList thinking visibility', () => {
  it('hides when the selected agent completes without a refresh', async () => {
    const { rerender } = renderMessageList(makeContext('ACTIVE'));

    await waitFor(() => expect(screen.getByText('Thinking')).toBeInTheDocument(), {
      timeout: 1200,
    });

    rerender(
      <AgentContext.Provider value={makeContext('COMPLETED')}>
        <TooltipProvider>
          <MessageList />
        </TooltipProvider>
      </AgentContext.Provider>,
    );

    await waitFor(() => expect(screen.queryByText('Thinking')).not.toBeInTheDocument());
  });
});
