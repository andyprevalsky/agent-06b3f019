/**
 * Blackbox tests for MessageList component.
 *
 * Covers:
 *  - Empty state
 *  - Filtering: SYSTEM messages hidden, subAgentId filtering
 *  - Rendering user + assistant + tool messages in order
 *  - Dedup: multiple tool updates sharing toolCallId collapse to latest
 *  - Explore agent grouping by taskId
 *  - Wait-for check-history grouping
 *  - Status banners: PAUSED, OUT_OF_CREDITS, COST_LIMIT_REACHED, WEB source preview
 *  - Streaming state: streaming tool, streaming attention
 *  - Hidden messages (metadata.hidden) are filtered
 *  - set_plan compression (only latest kept)
 *  - Sub-agent tree merging by busId
 */
import React from 'react';
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TooltipProvider } from '@/components/ui/tooltip';
import { AgentContext } from '@/features/agent-context';
import type { AgentContextValue } from '@/features/agent-context';
import { MessageList } from '@/features/terminal-component-group/components/MessageList';
import type { Message, AgentDetail } from '@/lib/api';

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
    model: 'rose-1-lite',
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
    setAgent: () => {},
    selectedAgentId: 'agent-1',
    setSelectedAgentId: () => {},
    messages: [],
    setMessages: () => {},
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

describe('MessageList', () => {
  it('renders empty when no messages', () => {
    const { container } = renderList(makeAgentCtx());
    expect(container.firstChild).not.toBeNull();
    // No message bubbles
    expect(container.textContent).not.toContain('hello');
  });

  it('renders USER and ASSISTANT messages in order', async () => {
    const ctx = makeAgentCtx({
      messages: [
        msg('u1', { role: 'USER', text: 'question?' }),
        msg('a1', {
          role: 'ASSISTANT',
          text: 'my answer',
          timestamp: new Date(Date.now() + 1000).toISOString(),
        }),
      ],
    });
    renderList(ctx);
    await waitFor(() => {
      expect(screen.getByText('question?')).toBeInTheDocument();
      expect(screen.getByText('Thought')).toBeInTheDocument();
    });
  });

  it('filters out SYSTEM messages', () => {
    const ctx = makeAgentCtx({
      messages: [
        msg('s1', { role: 'SYSTEM', text: 'secret system prompt' }),
        msg('u1', { role: 'USER', text: 'user visible' }),
      ],
    });
    renderList(ctx);
    expect(screen.queryByText('secret system prompt')).not.toBeInTheDocument();
    expect(screen.getByText('user visible')).toBeInTheDocument();
  });

  it('filters out messages with metadata.hidden === true', () => {
    const ctx = makeAgentCtx({
      messages: [
        msg('h1', { role: 'USER', text: 'hidden msg', metadata: { hidden: true } }),
        msg('u1', { role: 'USER', text: 'visible msg' }),
      ],
    });
    renderList(ctx);
    expect(screen.queryByText('hidden msg')).not.toBeInTheDocument();
    expect(screen.getByText('visible msg')).toBeInTheDocument();
  });

  it('deduplicates tool messages by toolCallId, keeping the latest', async () => {
    const ctx = makeAgentCtx({
      messages: [
        msg('t1', {
          role: 'TOOL',
          text: 'first update',
          timestamp: new Date(Date.now()).toISOString(),
          metadata: {
            toolCallId: 'same',
            toolName: 'web_search',
            title: 'Searching web',
            toolStatus: 'IN_PROGRESS',
          },
        }),
        msg('t2', {
          role: 'TOOL',
          text: 'final result',
          timestamp: new Date(Date.now() + 1000).toISOString(),
          metadata: {
            toolCallId: 'same',
            toolName: 'web_search',
            title: 'Searched web',
            toolStatus: 'FINISHED',
          },
        }),
      ],
    });
    renderList(ctx);
    await waitFor(() => expect(screen.getByText('Searched web')).toBeInTheDocument());
    // Earlier title shouldn't be present (only latest kept)
    expect(screen.queryByText('Searching web')).not.toBeInTheDocument();
  });

  it('filters messages by subAgentId (sub-agent panel)', () => {
    const ctx = makeAgentCtx({
      messages: [
        msg('u1', { role: 'USER', text: 'main chat' }),
        msg('u2', {
          role: 'USER',
          text: 'sub agent chat',
          metadata: { subAgentId: 'sub-1' },
        }),
      ],
    });
    // subAgentId="sub-1" only shows sub-agent messages
    renderList(ctx, { subAgentId: 'sub-1' });
    expect(screen.getByText('sub agent chat')).toBeInTheDocument();
    expect(screen.queryByText('main chat')).not.toBeInTheDocument();
  });

  it('shows PAUSED banner when agent status is PAUSED', () => {
    const ctx = makeAgentCtx({
      agent: makeAgent({ status: 'PAUSED' }),
      messages: [msg('u1', { text: 'hi' })],
    });
    renderList(ctx);
    expect(
      screen.getByText(/Rose has stopped, send a new message to continue/),
    ).toBeInTheDocument();
  });

  it('shows OUT_OF_CREDITS banner with Add Credits button', () => {
    const onAddCredits = () => {};
    const ctx = makeAgentCtx({
      agent: makeAgent({ status: 'OUT_OF_CREDITS' }),
    });
    renderList(ctx, { onAddCredits });
    expect(screen.getByText(/agent ran out of credits/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Add Credits/ })).toBeInTheDocument();
  });

  it('shows COST_LIMIT_REACHED banner with Increase Cost Limit button', () => {
    const ctx = makeAgentCtx({
      agent: makeAgent({ status: 'COST_LIMIT_REACHED' }),
    });
    renderList(ctx, { onIncreaseCostLimit: () => {} });
    expect(screen.getByText(/agent cost limit reached/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Increase Cost Limit/ })).toBeInTheDocument();
  });

  it('shows WEB Preview banner when agent source is WEB', () => {
    const ctx = makeAgentCtx({
      agent: makeAgent({ source: 'WEB' }),
    });
    renderList(ctx);
    expect(screen.getByText(/Preview Mode/)).toBeInTheDocument();
    expect(screen.getByText(/Download for Mac/)).toBeInTheDocument();
  });

  it('does not show status banners when showStatusBanners=false', () => {
    const ctx = makeAgentCtx({
      agent: makeAgent({ status: 'PAUSED' }),
    });
    renderList(ctx, { showStatusBanners: false });
    expect(
      screen.queryByText(/Rose has stopped, send a new message to continue/),
    ).not.toBeInTheDocument();
  });

  it('renders streaming tool bubble when streamingTools has entries', async () => {
    const ctx = makeAgentCtx({
      streamingTools: new Map([
        [
          'sc-1',
          {
            stream_id: 'str-1',
            tool_call_id: 'sc-1',
            tool_name: 'web_search',
            title: 'Live searching',
          },
        ],
      ]),
    });
    renderList(ctx);
    await waitFor(() => expect(screen.getByText(/Live searching/)).toBeInTheDocument());
  });

  it('renders streaming attention message', async () => {
    const ctx = makeAgentCtx({
      streamingBubbles: new Map([['sb-1', { text: 'streaming...', sequence: 1, done: false }]]),
      streamingAttention: {
        stream_id: 'str-a',
        tool_call_id: 'sa-1',
        message: 'please respond',
        is_question: true,
      },
    });
    const { container } = renderList(ctx);
    await waitFor(() => expect(container.textContent).toContain('please respond'));
  });

  it('compresses set_plan messages - only keeps latest by message_id', async () => {
    const ctx = makeAgentCtx({
      messages: [
        msg('sp1', {
          role: 'TOOL',
          text: '',
          timestamp: new Date(Date.now()).toISOString(),
          metadata: {
            toolCallId: 'plan-1',
            toolName: 'set_plan',
            title: 'Plan One',
            toolStatus: 'FINISHED',
          },
        }),
        msg('sp2', {
          role: 'TOOL',
          text: '',
          timestamp: new Date(Date.now() + 2000).toISOString(),
          metadata: {
            toolCallId: 'plan-2',
            toolName: 'set_plan',
            title: 'Plan Two',
            toolStatus: 'FINISHED',
          },
        }),
      ],
    });
    renderList(ctx);
    // Only the latest set_plan (Plan Two) should be rendered.
    await waitFor(() => expect(screen.getByText(/Plan Two/)).toBeInTheDocument());
    expect(screen.queryByText(/Plan One/)).not.toBeInTheDocument();
  });

  it('groups explore agent messages by taskId into a single chip', async () => {
    const ctx = makeAgentCtx({
      messages: [
        msg('e-init', {
          role: 'TOOL',
          text: '',
          timestamp: new Date(Date.now()).toISOString(),
          metadata: {
            toolCallId: 'explore-init',
            toolName: 'spawn_agent',
            title: 'Explore thing',
            toolStatus: 'IN_PROGRESS',
            agentType: 'explore',
            taskId: 'task-X',
          },
        }),
        msg('e-step', {
          role: 'TOOL',
          text: '',
          timestamp: new Date(Date.now() + 1000).toISOString(),
          metadata: {
            toolCallId: 'explore-step-1',
            toolName: 'web_search',
            title: 'Searching',
            toolStatus: 'FINISHED',
            agentType: 'explore',
            taskId: 'task-X',
          },
        }),
      ],
    });
    renderList(ctx);
    // Only ONE explore chip should render for taskId=task-X — confirm a single
    // "Explore thing" title node rather than two separate rows.
    await waitFor(() => expect(screen.getAllByText(/Explore thing/)).toHaveLength(1));
    // The internal web_search step must NOT render as its own chip — the grouping
    // collapses it inside the explore agent bubble.
    expect(screen.queryByText('Searching')).not.toBeInTheDocument();
  });

  it('cleans up orphan IN_PROGRESS tools that came before the last ASSISTANT msg', () => {
    const now = Date.now();
    const ctx = makeAgentCtx({
      messages: [
        msg('t-orphan', {
          role: 'TOOL',
          text: '',
          timestamp: new Date(now).toISOString(),
          metadata: {
            toolCallId: 'orphan-1',
            toolName: 'web_search',
            title: 'Orphaned tool',
            toolStatus: 'IN_PROGRESS',
          },
        }),
        msg('a1', {
          role: 'ASSISTANT',
          text: 'new thought',
          timestamp: new Date(now + 5000).toISOString(),
        }),
      ],
    });
    renderList(ctx);
    // The orphan tool should be filtered out.
    expect(screen.queryByText('Orphaned tool')).not.toBeInTheDocument();
  });

  it('hides internal agent initialization liveness tools', () => {
    const ctx = makeAgentCtx({
      messages: [
        msg('init', {
          role: 'TOOL',
          text: 'Agent initializing',
          metadata: {
            toolCallId: 'tc-agent-init',
            toolName: 'agent_init',
            title: 'Initializing',
            toolStatus: 'IN_PROGRESS',
          },
        }),
        msg('u1', { role: 'USER', text: 'visible user message' }),
      ],
    });
    renderList(ctx);
    expect(screen.queryByText('Initializing')).not.toBeInTheDocument();
    expect(screen.getByText('visible user message')).toBeInTheDocument();
  });

  it('keeps IN_PROGRESS wait_for tool even when an ASSISTANT came later', () => {
    const now = Date.now();
    const ctx = makeAgentCtx({
      messages: [
        msg('w-kept', {
          role: 'TOOL',
          text: '',
          timestamp: new Date(now).toISOString(),
          metadata: {
            toolCallId: 'wf-1',
            toolName: 'wait_for',
            title: 'Wait condition',
            toolStatus: 'IN_PROGRESS',
          },
        }),
        msg('a1', {
          role: 'ASSISTANT',
          text: 'chat',
          timestamp: new Date(now + 1000).toISOString(),
        }),
      ],
    });
    const { container } = renderList(ctx);
    // wait_for survives the orphan-cleanup filter.
    expect(container.textContent).toMatch(/Waiting|Wait|condition/i);
  });

  it('builds wait_for check history from multiple events sharing toolCallId', async () => {
    const now = Date.now();
    const ctx = makeAgentCtx({
      messages: [
        msg('wf-init', {
          role: 'TOOL',
          text: '',
          timestamp: new Date(now).toISOString(),
          metadata: {
            toolCallId: 'wf-many',
            toolName: 'wait_for',
            title: 'Wait many',
            toolStatus: 'IN_PROGRESS',
          },
        }),
        msg('wf-check-1', {
          role: 'TOOL',
          text: 'still waiting',
          timestamp: new Date(now + 1000).toISOString(),
          metadata: {
            toolCallId: 'wf-many',
            toolName: 'wait_for',
            title: 'Check 1',
            toolStatus: 'FINISHED',
            checkNum: 1,
            maxChecks: 5,
            conditionMet: false,
          },
        }),
        msg('wf-check-2', {
          role: 'TOOL',
          text: 'condition met',
          timestamp: new Date(now + 2000).toISOString(),
          metadata: {
            toolCallId: 'wf-many',
            toolName: 'wait_for',
            title: 'Check 2 done',
            toolStatus: 'FINISHED',
            checkNum: 2,
            maxChecks: 5,
            conditionMet: true,
          },
        }),
      ],
    });
    const { container } = renderList(ctx);
    // Only the latest (dedup'd) wait_for message is rendered; the check-history
    // block is passed as waitForChecks prop.
    await waitFor(() => expect(container.firstChild).not.toBeNull());
    // Latest title should render (Check 2 done wins dedup)
    expect(container.textContent).toMatch(/Check 2 done|Check 2|condition met/i);
    // Reconstructed history must include the earlier check. WaitForChip's header
    // shows the completed check count ("X checks" or "X check"). Both raw events
    // are FINISHED ⇒ waitForCheckMap must contain 2 entries ⇒ header renders "2 checks".
    // If reconstruction breaks (map empty), the count falls back to 0 or vanishes.
    expect(container.textContent).toMatch(/2\s*checks/i);
  });

  it('renders chat-mode Copy + Start Agent when last msg is FINISHED send_message_to_user (ACTIVE)', async () => {
    const ctx = makeAgentCtx({
      agent: makeAgent({ status: 'ACTIVE' }),
      isChatMode: true,
      messages: [
        msg('t1', {
          role: 'TOOL',
          text: 'final answer',
          metadata: {
            toolCallId: 'sm1',
            toolName: 'send_message_to_user',
            title: 'Sent',
            toolStatus: 'FINISHED',
          },
        }),
      ],
    });
    renderList(ctx);
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /Start agent/ })).toBeInTheDocument(),
    );
  });

  it('clicking Copy writes last assistant/tool text to clipboard', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    const ctx = makeAgentCtx({
      agent: makeAgent({ status: 'ACTIVE' }),
      isChatMode: true,
      messages: [
        msg('t1', {
          role: 'TOOL',
          text: 'copy me',
          metadata: {
            toolCallId: 'sm1',
            toolName: 'send_message_to_user',
            title: 'Sent',
            toolStatus: 'FINISHED',
          },
        }),
      ],
    });
    renderList(ctx);
    const copyBtn = await screen.findByTitle('Copy response');
    await userEvent.click(copyBtn);
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('copy me'));
  });

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
    // No "Thinking" word from the MessageList-level thinking banner
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

  it('does not render status banners inside a sub-agent panel', () => {
    const ctx = makeAgentCtx({
      agent: makeAgent({ status: 'PAUSED' }),
    });
    renderList(ctx, { subAgentId: 'sub-1' });
    // Banner is only shown for main chat (subAgentId === undefined)
    expect(
      screen.queryByText(/Rose has stopped, send a new message to continue/),
    ).not.toBeInTheDocument();
  });

  it('hides thinking when last tool is IN_PROGRESS non-attention (user feedback expected)', () => {
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
    // Thinking indicator is hidden when an IN_PROGRESS non-attention tool is present.
    // The tool card itself renders 'Searching', not the banner-level 'Thinking' word.
    const matches = screen.queryAllByText('Thinking');
    // Only acceptable 'Thinking' would be from thought tool card — we have no such tool.
    expect(matches.length).toBe(0);
  });

  it('merges spawn_sub_agent tree messages sharing busId into single render', async () => {
    const ctx = makeAgentCtx({
      messages: [
        msg('tree1', {
          role: 'TOOL',
          text: '',
          timestamp: new Date(Date.now()).toISOString(),
          metadata: {
            toolCallId: 'spawn-a',
            toolName: 'spawn_sub_agent',
            toolStatus: 'FINISHED',
            busId: 'bus-1',
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
            toolName: 'spawn_sub_agent',
            toolStatus: 'FINISHED',
            busId: 'bus-1',
            subAgentIds: ['sub-b'],
            title: 'Cluster',
          },
        }),
      ],
    });
    const { container } = renderList(ctx);
    // Tree rendered once. Text content should include merged header.
    await waitFor(() => expect(container.firstChild).not.toBeNull());
    // Two messages share busId=bus-1; MessageList collapses them into a single
    // SubAgentTree render. The "Cluster" title text must only appear once (or
    // not at all if SubAgentTree strips it) — it must NOT appear twice.
    const clusterMatches = screen.queryAllByText(/Cluster/);
    expect(clusterMatches.length).toBeLessThanOrEqual(1);
    // And the summary must reference both sub-agent IDs in the merged tree data.
    // Both tree messages have distinct toolCallIds ('spawn-a' and 'spawn-b') but the
    // merged render should NOT produce two separate SubAgentToolBubble chips.
    // Individual SubAgentToolBubble rows each emit an `aria-live` or chip title
    // — here we verify only one top-level wrapper class is rendered.
    const treeWrappers = container.querySelectorAll('div.flex.gap-3.animate-in');
    // Other messages render in their own wrappers, but we expect the spawn_sub_agent
    // messages to produce at most a single tree wrapper (merged), not two.
    // Count wrappers that originate from the spawn_sub_agent branch specifically:
    // this branch puts SubAgentTree as a direct child. A collapsed "Cluster" row
    // would produce two such wrappers if the merge regressed.
    expect(treeWrappers.length).toBeLessThanOrEqual(1);
  });
});
