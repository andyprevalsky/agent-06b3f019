import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { TooltipProvider } from '@/components/ui/tooltip';
import { AgentContext, type AgentContextValue } from '@/features/agent-context';
import { MessageList } from '@/features/terminal-component-group/components/MessageList';
import type { AgentDetail, Message } from '@/lib/api';
import { handleAssistantStream } from '@/features/agent-context/hooks/realtimeHandlers';

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

  it('shows a new root model call while its background child remains running (prod 784d6a3b)', async () => {
    // Captured UI contract: background spawn 21:46:59.945, user reply 22:03:08.624,
    // wait ends 22:03:11.940, empty root stream 22:03:14.120; no tool until :41.
    // Keep the child running: finishing or removing it would hide the original bug.
    const ctx = makeContext('ACTIVE');
    ctx.messages = [
      {
        message_id: 'background-spawn',
        timestamp: '2026-11-08T21:46:59.945Z',
        role: 'TOOL',
        text: '',
        metadata: {
          toolName: 'spawn_general_purpose_agent',
          toolCallId: 'background-call',
          toolStatus: 'IN_PROGRESS',
          title: 'Spawning sub-agent',
          busId: 'agent-1',
          subAgentIds: ['child-1'],
          excludeFromModel: true,
        },
      },
      {
        message_id: 'reply',
        timestamp: '2026-11-08T22:03:08.624Z',
        role: 'USER',
        text: 'can u give me the link to the flights u found so i can finish booking myself',
      },
      {
        message_id: 'wait-start',
        timestamp: '2026-11-08T21:58:11.940Z',
        role: 'TOOL',
        text: 'Waiting for child',
        metadata: { toolName: 'wait_for', toolCallId: 'wait-call', toolStatus: 'IN_PROGRESS' },
      },
      {
        message_id: 'wait-end',
        timestamp: '2026-11-08T22:03:11.940Z',
        role: 'TOOL',
        text: 'Woken by a new user message',
        metadata: { toolName: 'wait_for', toolCallId: 'wait-call', toolStatus: 'FINISHED' },
      },
    ];
    const view = renderMessageList(ctx);
    expect(screen.queryByText('Thinking')).not.toBeInTheDocument();
    handleAssistantStream(
      {
        agentId: 'agent-1',
        stream_id: 'reply-model-call',
        sequence: 0,
        delta: '',
        done: false,
        llm_started_at_ms: Date.parse('2026-11-08T22:03:14.120Z'),
      },
      'agent-1',
      ctx.streamedTextsRef,
      (update) => {
        ctx.streamingBubbles = typeof update === 'function' ? update(ctx.streamingBubbles) : update;
      },
    );
    view.rerender(
      <AgentContext.Provider value={{ ...ctx }}>
        <TooltipProvider>
          <MessageList />
        </TooltipProvider>
      </AgentContext.Provider>,
    );
    await waitFor(() => expect(screen.getByText('Thinking')).toBeInTheDocument(), {
      timeout: 1200,
    });
    expect(ctx.messages[0].metadata?.toolStatus).toBe('IN_PROGRESS');
    expect(
      screen.getByText(
        'can u give me the link to the flights u found so i can finish booking myself',
      ),
    ).toBeInTheDocument();
    expect(view.container.querySelector('[data-tool-call-id="background-call"]')).toHaveAttribute(
      'data-tool-status',
      'IN_PROGRESS',
    );
    expect(view.container.querySelector('[data-tool-call-id="wait-call"]')).toHaveAttribute(
      'data-tool-status',
      'FINISHED',
    );
  });

  it.each(['none', 'child', 'done', 'foreground'] as const)(
    'does not claim root thinking from a %s stream with background work',
    async (stream) => {
      const ctx = makeContext('ACTIVE');
      ctx.messages = [
        {
          message_id: 'background',
          timestamp: '2026-11-08T21:46:59.945Z',
          role: 'TOOL',
          text: '',
          metadata: {
            toolName: 'spawn_agent',
            toolCallId: 'background',
            toolStatus: 'IN_PROGRESS',
            excludeFromModel: true,
            taskId: 'child-task',
          },
        },
      ];
      if (stream !== 'none')
        ctx.streamingBubbles.set('stream', {
          text: '',
          sequence: 0,
          done: stream === 'done',
          subAgentId: stream === 'child' ? 'child-task' : undefined,
        });
      if (stream === 'foreground')
        ctx.messages.push({
          message_id: 'foreground',
          timestamp: '2026-11-08T22:03:14.000Z',
          role: 'TOOL',
          text: '',
          metadata: {
            toolName: 'web_search',
            toolCallId: 'search',
            toolStatus: 'IN_PROGRESS',
          },
        });
      renderMessageList(ctx);
      await new Promise((resolve) => setTimeout(resolve, 900));
      expect(screen.queryByText('Thinking')).not.toBeInTheDocument();
    },
  );

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
