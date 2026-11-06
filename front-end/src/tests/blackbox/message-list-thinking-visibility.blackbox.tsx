import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { TooltipProvider } from '@/components/ui/tooltip';
import { AgentContext, type AgentContextValue } from '@/features/agent-context';
import { MessageList } from '@/features/terminal-component-group/components/MessageList';
import type { AgentDetail, Message } from '@/lib/api';

vi.mock('@/components/ThinkingAnimation', () => ({
  default: () => <div data-testid="thinking-animation" />,
}));

function makeAgent(status: AgentDetail['status']): AgentDetail {
  return {
    agent_id: 'agent-1',
    goal: 'do a thing',
    model: 'rose-1-flash',
    source: 'MAC_APP',
    reasoning_effort: 'medium',
    progress: status === 'COMPLETED' ? 1 : 0,
    status,
    status_message: null,
    temporal_workflow_id: null,
    token_count: 0,
    tokens_in: 0,
    tokens_out: 0,
    tool_tokens_in: 0,
    tool_tokens_out: 0,
    tool_cost_cents: 0,
    context_size: 0,
    message_count: 0,
    price_limit_cents: 0,
    tree_cost_cents: 0,
    write_lock_enabled: false,
    verifier: null,
    tools: [],
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
}

function makeContext(status: AgentDetail['status']): AgentContextValue {
  return {
    agent: makeAgent(status),
    applyAgentDetail: () => true,
    inspectionContext: null,
    stagePendingAgentCreation: () => {},
    reconcilePendingAgentCreation: async () => {},
    rollbackPendingAgentCreation: () => false,
    stageUserMessage: () => ({ confirm: () => {}, drop: () => {} }),
    selectedAgentId: 'agent-1',
    setSelectedAgentId: () => {},
    messages: [],
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

  it('does not treat a hung chat escalation as still thinking', async () => {
    const messages: Message[] = [
      {
        message_id: 'user-1',
        timestamp: '2026-09-18T20:57:25.321Z',
        role: 'USER',
        text: 'help me check this tests and validate the cheaper one',
      },
      {
        message_id: 'router-1',
        timestamp: '2026-09-18T20:57:26.252Z',
        role: 'ASSISTANT',
        text: 'The user is asking for a comparison and validation of medical test options, including location choices. This requires multi-step research and planning, not a simple direct answer or current fact lookup.',
      },
    ];
    const ctx = makeContext('ACTIVE');
    ctx.isChatMode = true;
    ctx.messages = messages;
    ctx.agent = {
      ...ctx.agent!,
      temporal_workflow_id: null,
      status: 'ACTIVE',
    };

    renderMessageList(ctx);

    await new Promise((resolve) => setTimeout(resolve, 1100));
    expect(screen.queryByText('Thinking')).not.toBeInTheDocument();
  });
});
