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

  it('keeps the browser failure chip visible after credential classification messages arrive', async () => {
    const baseTime = Date.now();
    const ctx = makeAgentCtx({
      messages: [
        msg('browser-ready', {
          role: 'TOOL',
          text: '',
          timestamp: new Date(baseTime).toISOString(),
          metadata: {
            task_id: 'browser-task-1',
            toolCallId: 'browser-call-1',
            toolName: 'spawn_browser_agent',
            title: 'Browser Ready',
            toolStatus: 'IN_PROGRESS',
            action_type: 'browser',
            browser_url: 'https://debug.steel.dev/session/browser-task-1',
          },
        }),
        msg('browser-failed', {
          role: 'TOOL',
          text:
            '**Status**: ❌ FAILED\n\n' +
            "**Outcome**: [Errno 13] Permission denied: '/.context'\n\n" +
            '**Error**: Failed during: initialization',
          timestamp: new Date(baseTime + 1000).toISOString(),
          metadata: {
            task_id: 'browser-task-1',
            toolCallId: 'browser-call-1',
            toolName: 'spawn_browser_agent',
            title: 'Task Failed',
            toolStatus: 'ERROR',
            action_type: 'task_complete',
          },
        }),
        msg('credential-classified', {
          role: 'TOOL',
          text: "Browser run failed.\n\nFailure reason: unknown\n\nRaw error: FAILED **Outcome**: [Errno 13] Permission denied: '/.context'",
          timestamp: new Date(baseTime + 2000).toISOString(),
          metadata: {
            toolCallId: 'credential-failure-classifier:agent-1',
            toolName: 'credential_failure_classifier',
            title: 'Browser Failure Classified',
            toolStatus: 'FINISHED',
            action_type: 'credential_failure_classification',
          },
        }),
      ],
    });

    renderList(ctx);

    await waitFor(() => expect(screen.getByTestId('browser-agent-chip')).toBeInTheDocument());
    expect(screen.getByText('Browser Agent')).toBeInTheDocument();
    expect(screen.getByText('Browser Failure Classified')).toBeInTheDocument();
  });

  it('hides cancelled DAG reasoning rows', async () => {
    const ctx = makeAgentCtx({
      messages: [
        msg('think-start', {
          role: 'TOOL',
          text: 'Synthesize the answer',
          timestamp: new Date(Date.now()).toISOString(),
          metadata: {
            toolCallId: 'dag-reasoning-1',
            toolName: 'thought',
            title: 'Thinking',
            toolStatus: 'IN_PROGRESS',
          },
        }),
        msg('think-error', {
          role: 'TOOL',
          text: 'Error: Cancelled',
          timestamp: new Date(Date.now() + 1000).toISOString(),
          metadata: {
            toolCallId: 'dag-reasoning-1',
            toolName: 'thought',
            title: 'Thought',
            toolStatus: 'ERROR',
          },
        }),
      ],
    });

    renderList(ctx);

    await waitFor(() => expect(screen.queryByText('reasoning')).not.toBeInTheDocument());
    expect(screen.queryByText('Thought')).not.toBeInTheDocument();
    expect(screen.queryByText('reasoning')).not.toBeInTheDocument();
    expect(screen.queryByText('Error: Cancelled')).not.toBeInTheDocument();
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

  it('opens the rendered task in the Mac app for any agent viewed on the web', () => {
    attemptMacAppHandoffMock.mockClear();
    const ctx = makeAgentCtx({
      agent: makeAgent({ agent_id: 'rendered-agent', source: 'MAC_APP' }),
      selectedAgentId: 'stale-selection',
    });
    renderList(ctx);
    expect(screen.getByText(/Preview Mode/)).toBeInTheDocument();
    const openAppLink = screen.getByRole('link', { name: /Open Mac App/i });
    expect(openAppLink).toHaveAttribute('href', 'roselabs://open?agent-id=rendered-agent');
    fireEvent.click(openAppLink);
    expect(attemptMacAppHandoffMock).toHaveBeenCalledOnce();
  });

  it('does not show the web Preview banner inside the Mac app', () => {
    const originalApi = Object.getOwnPropertyDescriptor(window, 'api');
    Object.defineProperty(window, 'api', { configurable: true, value: {} });

    try {
      const ctx = makeAgentCtx({ agent: makeAgent({ source: 'WEB' }) });
      renderList(ctx);
      expect(screen.queryByTestId('web-preview-banner')).not.toBeInTheDocument();
    } finally {
      if (originalApi) Object.defineProperty(window, 'api', originalApi);
      else delete (window as Window & { api?: unknown }).api;
    }
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
        sequence: 1,
        done: false,
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
    // Only ONE explore chip should render for taskId=task-X — confirm by the
    // single thinking-icon header marker.
    await waitFor(() => expect(screen.getAllByTestId('explore-thinking-icon')).toHaveLength(1));
    // While exploring after the last tool finished, the header moves straight
    // into the post-tool thinking metric before assistant tokens arrive.
    expect(screen.getByText('Exploring')).toBeInTheDocument();
    expect(document.body.textContent).toContain('0 tokens');
    expect(screen.getByTestId('explore-thinking-icon')).toBeInTheDocument();
    // The web_search step does NOT render as a separate chip — it's collapsed
    // into the explore bubble.
    expect(screen.queryByTestId('tool-row-explore-step-1')).not.toBeInTheDocument();
  });

  it('shows per-explore-agent token counts instead of sharing one aggregate', async () => {
    const now = Date.now();
    const ctx = makeAgentCtx({
      agent: makeAgent({ status: 'ACTIVE' }),
      messages: [
        msg('e-init-a', {
          role: 'TOOL',
          text: '',
          timestamp: new Date(now).toISOString(),
          metadata: {
            toolCallId: 'explore-init-a',
            toolName: 'spawn_agent',
            title: 'Explore A',
            toolStatus: 'IN_PROGRESS',
            agentType: 'explore',
            taskId: 'task-A',
          },
        }),
        msg('e-init-b', {
          role: 'TOOL',
          text: '',
          timestamp: new Date(now + 10).toISOString(),
          metadata: {
            toolCallId: 'explore-init-b',
            toolName: 'spawn_agent',
            title: 'Explore B',
            toolStatus: 'IN_PROGRESS',
            agentType: 'explore',
            taskId: 'task-B',
          },
        }),
      ],
      streamingBubbles: new Map([
        [
          'stream-a',
          {
            text: '',
            sequence: 1,
            done: false,
            subAgentId: 'task-A',
            startedAtMs: now - 5000,
            charCount: 8000,
          },
        ],
        [
          'stream-b',
          {
            text: '',
            sequence: 1,
            done: false,
            subAgentId: 'task-B',
            startedAtMs: now - 3000,
            charCount: 4000,
          },
        ],
      ]),
    });

    renderList(ctx);

    await waitFor(() => expect(screen.getAllByTestId('explore-thinking-icon')).toHaveLength(2));
    await waitFor(
      () => {
        const text = document.body.textContent ?? '';
        expect(text).toContain('2,000 tokens');
        expect(text).toContain('1,000 tokens');
      },
      { timeout: 3000 },
    );
  });

  it('derives active explore web-search titles from message content when metadata is generic', async () => {
    const now = Date.now();
    const ctx = makeAgentCtx({
      messages: [
        msg('e-init-query', {
          role: 'TOOL',
          text: '',
          timestamp: new Date(now).toISOString(),
          metadata: {
            toolCallId: 'explore-init-query',
            toolName: 'spawn_agent',
            title: 'Explore cities',
            toolStatus: 'IN_PROGRESS',
            agentType: 'explore',
            taskId: 'task-query',
          },
        }),
        msg('e-step-query', {
          role: 'TOOL',
          text: 'Query: "best cities to live in your 20s 2024 ranking credible source"',
          timestamp: new Date(now + 1000).toISOString(),
          metadata: {
            toolCallId: 'explore-step-query',
            toolName: 'web_search',
            title: 'Searching the web',
            toolStatus: 'IN_PROGRESS',
            agentType: 'explore',
            taskId: 'task-query',
          },
        }),
      ],
    });

    renderList(ctx);

    await waitFor(() =>
      expect(
        screen.getByText(/Searching the web for best cities to live in your 20s/),
      ).toBeInTheDocument(),
    );
    expect(screen.queryByText(/^Searching the web$/)).not.toBeInTheDocument();
  });

  it('uses terminal explore tool results for grouped finished and failed states', async () => {
    const now = Date.now();
    const ctx = makeAgentCtx({
      messages: [
        msg('finished-init', {
          role: 'TOOL',
          text: '',
          timestamp: new Date(now).toISOString(),
          metadata: {
            toolCallId: 'finished-spawn',
            toolName: 'spawn_agent',
            title: 'Check deployment',
            toolStatus: 'IN_PROGRESS',
            agentType: 'explore',
            taskId: 'finished-task',
            fullGoal: 'Check whether the production deployment finished',
          },
        }),
        msg('finished-step', {
          role: 'TOOL',
          text: '**Result:** Deployment status READY',
          timestamp: new Date(now + 1000).toISOString(),
          metadata: {
            toolCallId: 'finished-web-search',
            toolName: 'web_search',
            title: 'Web search completed',
            toolStatus: 'FINISHED',
            agentType: 'explore',
            taskId: 'finished-task',
          },
        }),
        msg('finished-final', {
          role: 'TOOL',
          text: 'The production deployment is ready. Status: READY. URL: https://roselabs.ai',
          timestamp: new Date(now + 2000).toISOString(),
          metadata: {
            toolCallId: 'finished-spawn',
            toolName: 'spawn_agent',
            title: 'Check deployment',
            toolStatus: 'FINISHED',
            agentType: 'explore',
            taskId: 'finished-task',
            fullGoal: 'Check whether the production deployment finished',
          },
        }),
        msg('failed-final', {
          role: 'TOOL',
          text: 'Activity task failed: web_search_activity failed: Parallel AI search returned HTTP 429 Too Many Requests',
          timestamp: new Date(now + 3000).toISOString(),
          metadata: {
            toolCallId: 'failed-spawn',
            toolName: 'spawn_agent',
            title: 'Check deployment',
            toolStatus: 'ERROR',
            agentType: 'explore',
            taskId: 'failed-task',
            fullGoal: 'Check whether the production deployment finished',
          },
        }),
      ],
    });

    renderList(ctx);

    await waitFor(() => expect(screen.getByText('Explored')).toBeInTheDocument());
    expect(screen.getByText('Explore Failed')).toBeInTheDocument();
    expect(document.body.textContent).toContain('The production deployment is ready');
    expect(document.body.textContent).toContain(
      'Parallel AI search returned HTTP 429 Too Many Requests',
    );
    expect(screen.queryByText(/Explored -/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Explore Failed -/)).not.toBeInTheDocument();
  });
});
