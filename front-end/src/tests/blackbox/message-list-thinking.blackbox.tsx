/**
 * Blackbox tests for MessageList thinking, compact, and sub-agent tree states.
 */
import React from 'react';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { TooltipProvider } from '@/components/ui/tooltip';
import { AgentContext, type AgentContextValue } from '@/features/agent-context';
import { MessageList } from '@/features/terminal-component-group/components/MessageList';
import type { AgentDetail, Message } from '@/lib/api';

vi.mock('@/components/ThinkingAnimation', () => ({
  default: ({ gradient }: { gradient?: string[] }) => (
    <div data-testid="thinking-animation" data-has-gradient={gradient?.length ? 'true' : 'false'} />
  ),
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

describe('MessageList thinking states', () => {
  it('respects compact mode prop by keeping layout rendered', () => {
    const ctx = makeAgentCtx({
      messages: [msg('u1', { role: 'USER', text: 'compact hello' })],
    });
    renderList(ctx, { compact: true });
    expect(screen.getByText('compact hello')).toBeInTheDocument();
  });

  it('does not show thinking indicator when showThinkingIndicator=false', () => {
    const ctx = makeAgentCtx({
      agent: makeAgent({ status: 'ACTIVE' }),
      streamingBubbles: new Map([['sb-1', { text: 'thinking now', sequence: 1, done: false }]]),
    });
    renderList(ctx, { showThinkingIndicator: false });
    expect(screen.queryByText('Thinking')).not.toBeInTheDocument();
  });

  it('uses the orange direct-token thinking animation for GPT streaming bubbles', async () => {
    const ctx = makeAgentCtx({
      agent: makeAgent({ status: 'ACTIVE' }),
      streamingBubbles: new Map([
        ['sb-1', { text: 'thinking with gpt', sequence: 1, done: false, isGpt: true }],
      ]),
    });
    renderList(ctx);
    await waitFor(
      () =>
        expect(screen.getByTestId('thinking-animation')).toHaveAttribute(
          'data-has-gradient',
          'true',
        ),
      { timeout: 1200 },
    );
  });

  it('uses the sole bubble model and start time when a concurrent tool differs', async () => {
    const now = Date.now();
    const ctx = makeAgentCtx({
      agent: makeAgent({ status: 'ACTIVE' }),
      streamingBubbles: new Map([
        [
          'sb-1',
          {
            text: 'blue bubble',
            sequence: 1,
            done: false,
            startedAtMs: now - 1000,
          },
        ],
      ]),
      streamingTools: new Map([
        [
          'tool-1',
          {
            stream_id: 'stream-tool-1',
            tool_call_id: 'tool-1',
            tool_name: 'web_search',
            title: 'Concurrent GPT tool',
            startedAtMs: now - 100_000,
            isGpt: true,
          },
        ],
      ]),
    });

    renderList(ctx);

    await waitFor(() => expect(screen.getByText('Thinking')).toBeInTheDocument(), {
      timeout: 1200,
    });
    expect(screen.getByTestId('thinking-animation')).toHaveAttribute('data-has-gradient', 'false');
    expect(document.body.textContent).toMatch(/[0-5]\.\ds·\d+ tokens/);
  });

  it('renders main thinking stream as elapsed time plus token download count', async () => {
    const startedAtMs = Date.now() - 2200;
    const ctx = makeAgentCtx({
      agent: makeAgent({ status: 'ACTIVE' }),
      streamingBubbles: new Map([
        [
          'sb-1',
          {
            text: 'thinking with enough content to estimate tokens',
            sequence: 1,
            done: false,
            startedAtMs,
          },
        ],
      ]),
    });
    renderList(ctx);
    await waitFor(() => expect(screen.getByText('Thinking')).toBeInTheDocument(), {
      timeout: 1200,
    });
    expect(document.body.textContent).toMatch(/\d+\.\ds·\d+ tokens/);
    expect(document.querySelector('.lucide-arrow-down')).not.toBeNull();
  });

  it('renders main blue thinking metrics from llm start before first token arrives', async () => {
    const startedAtMs = Date.now() - 900;
    const ctx = makeAgentCtx({
      agent: makeAgent({ status: 'ACTIVE' }),
      streamingBubbles: new Map([
        [
          'sb-1',
          {
            text: '',
            sequence: 0,
            done: false,
            startedAtMs,
          },
        ],
      ]),
    });
    renderList(ctx);
    await waitFor(() => expect(screen.getByText('Thinking')).toBeInTheDocument(), {
      timeout: 1200,
    });
    expect(screen.getByTestId('thinking-animation')).toHaveAttribute('data-has-gradient', 'false');
    expect(document.body.textContent).toMatch(/\d+\.\ds·0 tokens/);
  });

  it('shows the ↓ token counter while thinking before any stream starts', async () => {
    renderList(makeAgentCtx({ agent: makeAgent({ status: 'ACTIVE' }) }));
    await waitFor(() => expect(screen.getByTestId('thinking-indicator')).toBeInTheDocument(), {
      timeout: 1200,
    });
    expect(screen.getByTestId('thinking-indicator')).toHaveTextContent(/^Thinking0 tokens$/);
    expect(document.querySelector('.lucide-arrow-down')).not.toBeNull();
  });

  it('renders concurrent assistant streams as separate thinking rows', async () => {
    const ctx = makeAgentCtx({
      agent: makeAgent({ status: 'ACTIVE' }),
      streamingBubbles: new Map([
        [
          'sb-1',
          { text: 'first stream', sequence: 1, done: false, startedAtMs: Date.now() - 2000 },
        ],
        [
          'sb-2',
          { text: 'second stream', sequence: 1, done: false, startedAtMs: Date.now() - 1000 },
        ],
      ]),
    });
    renderList(ctx);
    await waitFor(() => expect(screen.queryAllByText('Thinking')).toHaveLength(2), {
      timeout: 1200,
    });
  });

  it('does not render status banners inside a sub-agent panel', () => {
    const ctx = makeAgentCtx({
      agent: makeAgent({ status: 'PAUSED' }),
    });
    renderList(ctx, { subAgentId: 'sub-1' });
    expect(
      screen.queryByText(/Rose has stopped, send a new message to continue/),
    ).not.toBeInTheDocument();
  });

  it('hides thinking when last tool is IN_PROGRESS non-attention', () => {
    const ctx = makeAgentCtx({
      agent: makeAgent({ status: 'ACTIVE' }),
      messages: [
        msg('t1', {
          role: 'TOOL',
          text: '',
          metadata: {
            toolCallId: 'w1',
            toolName: 'web_search',
            title: 'Searching',
            toolStatus: 'IN_PROGRESS',
          },
        }),
      ],
    });
    renderList(ctx);
    expect(screen.queryAllByText('Thinking')).toHaveLength(0);
  });

  it('hides main thinking when the last message is IN_PROGRESS tool even if a stream is open', async () => {
    const ctx = makeAgentCtx({
      agent: makeAgent({ status: 'ACTIVE' }),
      streamingBubbles: new Map([['sb-1', { text: 'still streaming', sequence: 1, done: false }]]),
      messages: [
        msg('t1', {
          role: 'TOOL',
          text: '',
          metadata: {
            toolCallId: 'w1',
            toolName: 'web_search',
            title: 'Searching',
            toolStatus: 'IN_PROGRESS',
          },
        }),
      ],
    });
    renderList(ctx);
    await new Promise((resolve) => setTimeout(resolve, 900));
    expect(screen.queryByText('Thinking')).not.toBeInTheDocument();
  });

  it('hides browser thinking while an ephemeral browser tool is in progress', async () => {
    const ctx = makeAgentCtx({
      agent: makeAgent({ status: 'ACTIVE' }),
      streamingBubbles: new Map([
        [
          'browser-stream',
          {
            text: 'choosing the next browser action',
            sequence: 1,
            done: false,
            subAgentId: 'browser-task',
            startedAtMs: Date.now() - 500,
          },
        ],
      ]),
      streamingTools: new Map([
        [
          'browser-tool',
          {
            stream_id: 'browser-stream',
            tool_call_id: 'browser-tool',
            tool_name: 'click',
            title: 'Clicking checkout',
            subAgentId: 'browser-task',
            startedAtMs: Date.now() - 300,
          },
        ],
      ]),
    });

    renderList(ctx, { subAgentId: 'browser-task', compact: true });

    expect(screen.getByText('Clicking checkout')).toBeInTheDocument();
    await new Promise((resolve) => setTimeout(resolve, 900));
    expect(screen.queryByText('Thinking')).not.toBeInTheDocument();
  });

  it('renders browser thinking metrics as the final visual message-list item', async () => {
    const ctx = makeAgentCtx({
      agent: makeAgent({ status: 'ACTIVE' }),
      streamingBubbles: new Map([
        [
          'browser-stream',
          {
            text: 'reading the checkout page',
            sequence: 1,
            done: false,
            subAgentId: 'browser-task',
            startedAtMs: Date.now() - 1400,
          },
        ],
      ]),
    });

    const { container } = renderList(ctx, { subAgentId: 'browser-task', compact: true });

    await waitFor(() => expect(screen.getByTestId('thinking-indicator')).toBeInTheDocument(), {
      timeout: 1200,
    });
    expect(screen.getByTestId('thinking-indicator')).toHaveTextContent(/Thinking/);
    expect(screen.getByTestId('thinking-indicator')).toHaveTextContent(/\d+\.\ds·\d+ tokens/);

    const list = container.firstElementChild;
    const thinking = screen.getByTestId('thinking-indicator');
    const trailingElements = Array.from(list?.children ?? []).slice(
      Array.from(list?.children ?? []).indexOf(thinking) + 1,
    );
    expect(trailingElements.every((element) => element.textContent === '')).toBe(true);
  });

  it('merges general-purpose agent tree messages sharing spawnGroupId into single render', async () => {
    const ctx = makeAgentCtx({
      messages: [
        msg('tree1', {
          role: 'TOOL',
          text: '',
          timestamp: new Date(Date.now()).toISOString(),
          metadata: {
            toolCallId: 'spawn-a',
            toolName: 'spawn_general_purpose_agent',
            toolStatus: 'FINISHED',
            busId: 'bus-1',
            spawnGroupId: 'llm-turn:execute:2',
            subAgentIds: ['sub-a'],
            title: 'Cluster',
          },
        }),
        msg('tree2', {
          role: 'TOOL',
          text: '',
          timestamp: new Date(Date.now() + 1000).toISOString(),
          metadata: {
            toolCallId: 'spawn-b',
            toolName: 'spawn_general_purpose_agent_for_each',
            toolStatus: 'FINISHED',
            busId: 'bus-1',
            spawnGroupId: 'llm-turn:execute:2',
            subAgentIds: ['sub-b'],
            title: 'Cluster',
          },
        }),
      ],
    });
    const { container } = renderList(ctx);
    await waitFor(() => expect(container.firstChild).not.toBeNull());
    expect(screen.queryAllByText(/Cluster/).length).toBeLessThanOrEqual(1);
    const treeWrappers = container.querySelectorAll('div.flex.gap-3.animate-in');
    expect(treeWrappers.length).toBeLessThanOrEqual(1);
  });
});
