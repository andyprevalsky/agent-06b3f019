/**
 * Regression: the web "Preview Mode… Open Mac App" notice is always the final
 * transcript item (after rows, live tool chips and the Thinking indicator).
 *
 * Original suite header (shared helpers copied from message-list.blackbox):
 * Blackbox tests for MessageList component.
 *
 * Covers:
 *  - Empty state
 *  - Filtering: SYSTEM messages hidden, subAgentId filtering
 *  - Rendering user + assistant + tool messages in order
 *  - Dedup: multiple tool updates sharing toolCallId collapse to latest
 *  - Explore agent grouping by taskId
 *  - Wait-for check-history grouping
 *  - Status banners: PAUSED, OUT_OF_CREDITS, COST_LIMIT_REACHED, web frontend preview
 *  - Streaming state: streaming tool, streaming attention
 *  - Hidden messages (metadata.hidden) are filtered
 *  - set_plan compression (only latest kept)
 *  - Sub-agent tree merging by busId
 */
import React from 'react';
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { TooltipProvider } from '@/components/ui/tooltip';
import { AgentContext } from '@/features/agent-context';
import type { AgentContextValue } from '@/features/agent-context';
import { MessageList } from '@/features/terminal-component-group/components/MessageList';
import type { Message, AgentDetail } from '@/lib/api';
import { makeCtx } from './browser-agent-chip.fixtures';

const attemptMacAppHandoffMock = vi.hoisted(() => vi.fn());

vi.mock('@/lib/macAppHandoff', () => ({
  attemptMacAppHandoff: attemptMacAppHandoffMock,
}));

vi.mock('@/components/ThinkingAnimation', () => ({
  default: ({ gradient }: { gradient?: string[] }) => (
    <div data-testid="thinking-animation" data-has-gradient={gradient?.length ? 'true' : 'false'} />
  ),
}));

// jsdom doesn't implement scrollIntoView — stub it so auto-scroll effect is inert.
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
    agent: null,
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

function renderList(ctx: AgentContextValue, props: React.ComponentProps<typeof MessageList> = {}) {
  return render(
    <AgentContext.Provider value={ctx}>
      <TooltipProvider>
        <MessageList {...props} />
      </TooltipProvider>
    </AgentContext.Provider>,
  );
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

describe('MessageList web preview notice', () => {
  it('pins the web Preview Mode notice as the final item, after rows, live tools and Thinking', async () => {
    const ctx = makeAgentCtx({
      agent: makeAgent({ agent_id: 'agent-1', status: 'ACTIVE' }),
      messages: [
        msg('u1', { role: 'USER', text: 'plan the offsite' }),
        msg('n1', {
          role: 'USER',
          text: 'Message Type: MESSAGE\nTask name: budget\nSender: /root/budget\nPayload:\nBudget ready.',
          timestamp: new Date(Date.now() + 1000).toISOString(),
          metadata: {
            agentMessage: true,
            messageType: 'MESSAGE',
            fromAgentId: 'a-budget',
            fromAgentPath: '/root/budget',
          },
        }),
      ],
      streamingBubbles: new Map([['sb-1', { text: 'thinking', sequence: 1, done: false }]]),
      streamingTools: new Map([
        [
          'tc-live',
          {
            stream_id: 'st-live',
            tool_call_id: 'tc-live',
            tool_name: 'web_search',
            title: 'Live searching',
          },
        ],
      ]),
    });
    renderList(ctx);
    await waitFor(() => expect(screen.getByText('Thinking')).toBeInTheDocument(), {
      timeout: 1200,
    });
    const banner = screen.getByText(/Preview Mode/);
    const follows = (earlier: Element) =>
      Boolean(earlier.compareDocumentPosition(banner) & Node.DOCUMENT_POSITION_FOLLOWING);
    expect(follows(screen.getByText('Message from /root/budget'))).toBe(true);
    expect(follows(screen.getByText('Thinking'))).toBe(true);
    expect(follows(screen.getAllByText(/Live searching/)[0])).toBe(true);
  });
});
