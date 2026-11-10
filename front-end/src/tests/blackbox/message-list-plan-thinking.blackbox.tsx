import React from 'react';
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { TooltipProvider } from '@/components/ui/tooltip';
import { AgentContext, type AgentContextValue } from '@/features/agent-context';
import { MessageList } from '@/features/terminal-component-group/components/MessageList';
import type { AgentDetail, Message } from '@/lib/api';

vi.mock('@/components/ThinkingAnimation', () => ({
  default: () => <div data-testid="thinking-animation" />,
}));

beforeAll(() => {
  if (!Element.prototype.scrollIntoView) {
    Element.prototype.scrollIntoView = function () {};
  }
});

function makeAgent(overrides: Partial<AgentDetail> = {}): AgentDetail {
  return {
    agent_id: 'agent-1',
    goal: 'do a thing',
    model: 'rose-1-flash',
    source: 'MAC_APP',
    reasoning_effort: 'medium',
    progress: 0,
    status: 'ACTIVE',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    messages: [],
    ...overrides,
  } as AgentDetail;
}

function makeAgentCtx(overrides: Partial<AgentContextValue> = {}): AgentContextValue {
  const streamedTextsRef = { current: new Set<string>() } as React.MutableRefObject<Set<string>>;
  return {
    agent: makeAgent(),
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
    streamedTextsRef,
    registerMessageHandler: () => () => {},
    sendMessage: async () => {},
    isLoadingAgent: false,
    forceResubscribe: () => {},
    isChatMode: false,
    ...overrides,
  };
}

function msg(id: string, overrides: Partial<Message> = {}): Message {
  return {
    message_id: id,
    timestamp: new Date().toISOString(),
    role: 'USER',
    text: id,
    ...overrides,
  };
}

function planMessage(): Message {
  return msg('plan-1', {
    role: 'TOOL',
    text: '',
    metadata: {
      toolCallId: 'plan-call',
      toolName: 'set_plan',
      title: 'Generating Plan',
      toolStatus: 'IN_PROGRESS',
    },
  });
}

function renderList(ctx: AgentContextValue) {
  return render(
    <AgentContext.Provider value={ctx}>
      <TooltipProvider>
        <MessageList />
      </TooltipProvider>
    </AgentContext.Provider>,
  );
}

describe('MessageList plan thinking state', () => {
  it('hides main thinking while a plan stream is active', async () => {
    const ctx = makeAgentCtx({
      streamingBubbles: new Map([['sb-1', { text: 'planning', sequence: 1, done: false }]]),
      streamingPlan: {
        stream_id: 'plan-stream',
        tool_call_id: 'plan-call',
        title: 'Generating Plan',
        char_count: 253,
        startedAtMs: Date.now() - 900,
      },
      messages: [planMessage()],
    });

    renderList(ctx);
    await new Promise((resolve) => setTimeout(resolve, 900));

    expect(screen.getByText('Generating Plan')).toBeInTheDocument();
    expect(screen.queryByText('Thinking')).not.toBeInTheDocument();
  });

  it('dismisses already-visible main thinking when plan generation starts', async () => {
    const baseCtx = makeAgentCtx({
      streamingBubbles: new Map([
        ['sb-1', { text: 'thinking before plan', sequence: 1, done: false }],
      ]),
    });
    const { rerender } = renderList(baseCtx);
    await waitFor(() => expect(screen.getByText('Thinking')).toBeInTheDocument(), {
      timeout: 1200,
    });

    const planCtx = makeAgentCtx({
      ...baseCtx,
      streamingPlan: {
        stream_id: 'plan-stream',
        tool_call_id: 'plan-call',
        title: 'Generating Plan',
        char_count: 253,
        startedAtMs: Date.now() - 900,
      },
      messages: [planMessage()],
    });

    rerender(
      <AgentContext.Provider value={planCtx}>
        <TooltipProvider>
          <MessageList />
        </TooltipProvider>
      </AgentContext.Provider>,
    );

    await waitFor(() => expect(screen.queryByText('Thinking')).not.toBeInTheDocument());
    expect(screen.getByText('Generating Plan')).toBeInTheDocument();
  });

  it('dismisses already-visible main thinking when the agent completes', async () => {
    const baseCtx = makeAgentCtx({
      streamingBubbles: new Map([
        ['sb-1', { text: 'thinking before completion', sequence: 1, done: false }],
      ]),
    });
    const { rerender } = renderList(baseCtx);
    await waitFor(() => expect(screen.getByText('Thinking')).toBeInTheDocument(), {
      timeout: 1200,
    });

    const completedCtx = makeAgentCtx({
      ...baseCtx,
      agent: makeAgent({ status: 'COMPLETED' }),
    });

    rerender(
      <AgentContext.Provider value={completedCtx}>
        <TooltipProvider>
          <MessageList />
        </TooltipProvider>
      </AgentContext.Provider>,
    );

    await waitFor(() => expect(screen.queryByText('Thinking')).not.toBeInTheDocument());
  });
});
