/* eslint-disable max-lines */
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
});
