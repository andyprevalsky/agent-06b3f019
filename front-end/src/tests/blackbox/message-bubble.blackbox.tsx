/**
 * Blackbox tests for MessageBubble component.
 *
 * Covers all routing branches:
 *  - USER role: bubble with text, with file_pointer
 *  - ASSISTANT role: Thought tool card, streaming, file_pointer
 *  - SYSTEM role: plain bubble
 *  - TOOL role: ToolMessage card (IN_PROGRESS / FINISHED / ERROR with chevron)
 *  - isUserAttentionMessage → AttentionMessage with waiting indicator
 *  - isSubAgentTool: pre-spawn error, spawning-in-progress
 *  - isSignupRequest → SignupPromptBubble
 *  - isSetPlanTool → PlanChip (IN_PROGRESS / ERROR)
 *  - isPhoneCallTool → PhoneCallCard
 *  - isExploreAgent → ExploreAgentBubble
 *  - isWaitFor → WaitForChip
 *  - isClaudeCodeTool → ClaudeCodeChip
 *  - isCompletionSummary → CompletionSummaryCard + FeedbackBanner
 *  - Tool approval (returns null)
 */
import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { TooltipProvider } from '@/components/ui/tooltip';
import MessageBubble from '@/features/terminal-component-group/components/MessageBubble';
import { AgentContext } from '@/features/agent-context';
import type { AgentContextValue } from '@/features/agent-context';
import type { Message } from '@/lib/api';
import { server } from './msw/server';

function makeAgentCtx(overrides: Partial<AgentContextValue> = {}): AgentContextValue {
  const streamedTextsRef = { current: new Set<string>() } as React.MutableRefObject<Set<string>>;
  return {
    agent: null,
    applyAgentDetail: () => true,
    inspectionContext: null,
    stagePendingAgentCreation: () => {},
    reconcilePendingAgentCreation: async () => {},
    rollbackPendingAgentCreation: () => false,
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

function renderBubble(ui: React.ReactNode, agentCtx: AgentContextValue = makeAgentCtx()) {
  return render(
    <AgentContext.Provider value={agentCtx}>
      <TooltipProvider>{ui}</TooltipProvider>
    </AgentContext.Provider>,
  );
}

function baseMessage(overrides: Partial<Message> = {}): Message {
  return {
    message_id: 'm-1',
    timestamp: new Date().toISOString(),
    text: 'hello',
    role: 'ASSISTANT',
    ...overrides,
  };
}

function storeTestSession() {
  localStorage.setItem(
    'rose-session',
    JSON.stringify({
      access_token: 'test-token',
      expires_at: Math.floor(Date.now() / 1000) + 3600,
      user: { id: 'user-1' },
    }),
  );
}

describe('MessageBubble', () => {
  it('renders USER message with right-aligned text bubble', () => {
    const msg = baseMessage({ role: 'USER', text: 'hi rose' });
    renderBubble(<MessageBubble message={msg} />);
    expect(screen.getByText('hi rose')).toBeInTheDocument();
  });

  it('renders USER message without text when only a file_pointer is provided', async () => {
    const msg = baseMessage({
      role: 'USER',
      text: '',
      file_pointer: {
        id: 'fp1',
        storage_path: 'uploads/a.pdf',
        original_filename: 'a.pdf',
        mime_type: 'application/pdf',
        size_bytes: 1024,
        created_at: new Date().toISOString(),
      },
    });
    renderBubble(<MessageBubble message={msg} agentId="agent-1" />);
    await waitFor(() => expect(screen.getByText('a.pdf')).toBeInTheDocument());
  });

  it('renders SYSTEM message as a plain bubble', () => {
    const msg = baseMessage({ role: 'SYSTEM', text: 'system msg' });
    renderBubble(<MessageBubble message={msg} />);
    expect(screen.getByText('system msg')).toBeInTheDocument();
  });

  it('renders ASSISTANT message as Thought tool card (non-streaming, no file)', async () => {
    const msg = baseMessage({ role: 'ASSISTANT', text: 'I think so' });
    renderBubble(<MessageBubble message={msg} />);
    await waitFor(() => expect(screen.getByText('Thought')).toBeInTheDocument());
  });

  it('does not render ASSISTANT thought card when the message has no content', () => {
    const msg = baseMessage({ role: 'ASSISTANT', text: '   ' });
    const { container } = renderBubble(<MessageBubble message={msg} />);
    expect(screen.queryByText('Thought')).not.toBeInTheDocument();
    expect(container.firstChild).toBeNull();
  });

  it('renders ASSISTANT with shouldType=true as collapsed Thought and releases the animation queue', async () => {
    // Regression: the card has no typing animation, so deriving IN_PROGRESS
    // from shouldType flashed it open for one frame before the instant
    // onComplete collapsed it (open→closed flicker on the first thought).
    const msg = baseMessage({ role: 'ASSISTANT', text: 'working' });
    const onComplete = vi.fn();
    renderBubble(<MessageBubble message={msg} shouldType={true} onTypingComplete={onComplete} />);
    await waitFor(() => expect(screen.getByText('Thought')).toBeInTheDocument());
    expect(screen.queryByText('Thinking')).not.toBeInTheDocument();
    expect(screen.queryByText('working')).not.toBeInTheDocument();
    await waitFor(() => expect(onComplete).toHaveBeenCalled());
  });

  it('renders ASSISTANT streaming as plain text bubble', () => {
    const msg = baseMessage({ role: 'ASSISTANT', text: 'streaming text' });
    renderBubble(<MessageBubble message={msg} isStreaming={true} />);
    expect(screen.getByText('streaming text')).toBeInTheDocument();
  });

  it('renders ASSISTANT with file_pointer as attachment row', async () => {
    const msg = baseMessage({
      role: 'ASSISTANT',
      text: 'see file',
      file_pointer: {
        id: 'fp2',
        storage_path: '',
        original_filename: 'output.txt',
        mime_type: 'text/plain',
        size_bytes: 500,
        created_at: new Date().toISOString(),
      },
    });
    renderBubble(<MessageBubble message={msg} />);
    await waitFor(() => expect(screen.getByText('output.txt')).toBeInTheDocument());
    expect(screen.getByText('see file')).toBeInTheDocument();
  });

  it('renders ASSISTANT attachment row even when the message has no text', async () => {
    const msg = baseMessage({
      role: 'ASSISTANT',
      text: '',
      file_pointer: {
        id: 'fp3',
        storage_path: '',
        original_filename: 'empty-output.txt',
        mime_type: 'text/plain',
        size_bytes: 32,
        created_at: new Date().toISOString(),
      },
    });
    renderBubble(<MessageBubble message={msg} />);
    await waitFor(() => expect(screen.getByText('empty-output.txt')).toBeInTheDocument());
    expect(screen.queryByText('Thought')).not.toBeInTheDocument();
  });

  it('auto-downloads and renders Markdown attachments inline', async () => {
    storeTestSession();
    server.use(
      http.get('http://localhost:3001/api/agents/agent-md/attachments/fp-md/url', () =>
        HttpResponse.json({ signed_url: 'https://signed.test/report.md' }),
      ),
      http.get(
        'https://signed.test/report.md',
        () =>
          new HttpResponse('# Report\n\n- item one\n- item two', {
            headers: { 'Content-Type': 'text/markdown' },
          }),
      ),
    );
    const msg = baseMessage({
      role: 'ASSISTANT',
      text: '',
      file_pointer: {
        id: 'fp-md',
        storage_path: 'user-1/report.md',
        original_filename: 'report.md',
        mime_type: 'application/octet-stream',
        size_bytes: 29,
        created_at: new Date().toISOString(),
      },
    });

    renderBubble(<MessageBubble message={msg} agentId="agent-md" />);

    expect(await screen.findByRole('heading', { name: 'Report' })).toBeInTheDocument();
    expect(screen.getByText('item one')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Download report.md' })).toBeInTheDocument();
  });

  it('renders TOOL FINISHED as tool card with title and chevron', async () => {
    const msg = baseMessage({
      role: 'TOOL',
      text: 'the result body',
      metadata: {
        toolCallId: 'tc-1',
        toolName: 'web_search',
        title: '🔍 Searching',
        toolStatus: 'FINISHED',
      },
    });
    renderBubble(<MessageBubble message={msg} />);
    await waitFor(() => expect(screen.getByText(/Searching/)).toBeInTheDocument());
  });

  it('expands a FINISHED TOOL card when clicked to reveal message content', async () => {
    const msg = baseMessage({
      role: 'TOOL',
      text: 'the result body',
      metadata: {
        toolCallId: 'tc-1',
        toolName: 'web_search',
        title: 'Searching',
        toolStatus: 'FINISHED',
      },
    });
    const { container } = renderBubble(<MessageBubble message={msg} />);
    const header = await screen.findByText(/Searching/);
    await userEvent.click(header);
    // Content goes through MarkdownText which splits words into spans.
    // Assert the expandable panel exists by checking that textContent now
    // includes the body words.
    await waitFor(() => {
      expect(container.textContent).toContain('the');
      expect(container.textContent).toContain('result');
      expect(container.textContent).toContain('body');
    });
  });

  it('hides Fast Mode / fast-cache copy from expanded tool cards', async () => {
    const msg = baseMessage({
      role: 'TOOL',
      text: 'Fast Mode cache miss for this web search. Returning without a live provider call.',
      metadata: {
        toolCallId: 'tc-fast-cache-search',
        toolName: 'web_search',
        title: 'Searching',
        toolStatus: 'FINISHED',
      },
    });
    const { container } = renderBubble(<MessageBubble message={msg} />);
    const header = await screen.findByText(/Searching/);
    await userEvent.click(header);
    expect(container.textContent).not.toMatch(/fast\s*mode/i);
    expect(container.textContent).not.toMatch(/fast[\s-]*cache/i);
  });

  it('renders TOOL IN_PROGRESS with progress bar when progressComplete is present', () => {
    const msg = baseMessage({
      role: 'TOOL',
      text: '',
      metadata: {
        toolCallId: 'tc-2',
        toolName: 'compute',
        title: 'Computing',
        toolStatus: 'IN_PROGRESS',
        progressComplete: 0.42,
      },
    });
    const { container } = renderBubble(<MessageBubble message={msg} />);
    const inner = container.querySelector('.bg-primary') as HTMLElement | null;
    expect(inner).not.toBeNull();
  });

  it.each([
    ['Creating Cloud Agent', 'IN_PROGRESS'],
    ['Preparing Cloud Agent', 'IN_PROGRESS'],
    ['Starting Reasoning', 'IN_PROGRESS'],
    ['Cloud Agent Ready', 'FINISHED'],
  ] as const)(
    'renders %s cloud lifecycle tool without expandable output',
    async (title, toolStatus) => {
      const msg = baseMessage({
        role: 'TOOL',
        text: `${title} body should stay hidden.`,
        metadata: {
          toolCallId: 'tc-cloud-agent',
          toolName: 'cloud_agent',
          title,
          toolStatus,
        },
      });
      renderBubble(<MessageBubble message={msg} />);
      await waitFor(() => expect(screen.getByText(title)).toBeInTheDocument());
      expect(screen.queryByText(`${title} body should stay hidden.`)).not.toBeInTheDocument();
    },
  );

  it('renders TOOL ERROR in red with error title', async () => {
    const msg = baseMessage({
      role: 'TOOL',
      text: 'oops',
      metadata: {
        toolCallId: 'tc-3',
        toolName: 'foo',
        title: 'Foo failed',
        toolStatus: 'ERROR',
        error: true,
      },
    });
    renderBubble(<MessageBubble message={msg} />);
    await waitFor(() => expect(screen.getByText('Foo failed')).toBeInTheDocument());
  });

  it('renders thought TOOL IN_PROGRESS as collapsed "Thinking" shimmer', async () => {
    const msg = baseMessage({
      role: 'TOOL',
      text: 'internal synthesis prompt should stay hidden',
      metadata: {
        toolCallId: 'tc-4',
        toolName: 'thought',
        title: 'Thinking',
        toolStatus: 'IN_PROGRESS',
      },
    });
    renderBubble(<MessageBubble message={msg} />);
    await waitFor(() => expect(screen.getByText('Thinking')).toBeInTheDocument());
    expect(
      screen.queryByText('internal synthesis prompt should stay hidden'),
    ).not.toBeInTheDocument();
  });

  it('renders attention message (isUserAttentionMessage) with waiting indicator', async () => {
    const msg = baseMessage({
      role: 'TOOL',
      text: 'please answer',
      metadata: {
        toolCallId: 'tc-5',
        toolName: 'send_message_to_user',
        isUserAttentionMessage: true,
        toolStatus: 'IN_PROGRESS',
        attentionMessage: 'please answer',
      },
    });
    const { container } = renderBubble(<MessageBubble message={msg} />);
    await waitFor(() => {
      // Text is split into word spans by MarkdownText; check textContent.
      expect(container.textContent).toContain('please');
      expect(container.textContent).toContain('answer');
    });
    expect(screen.getByText(/Your Rose agent will continue working/)).toBeInTheDocument();
  });

  it('renders signup request as SignupPromptBubble when agentId provided', async () => {
    const msg = baseMessage({
      role: 'TOOL',
      text: 'need login',
      metadata: {
        toolCallId: 'tc-6',
        toolName: 'request_user_signup',
        toolStatus: 'IN_PROGRESS',
        requestUserSignup: { reason: 'verify your email' },
      },
    });
    const { container } = renderBubble(<MessageBubble message={msg} agentId="agent-xyz" />);
    await waitFor(() => expect(container.textContent).toMatch(/verify.*your.*email/i));
  });

  it('returns null for tool-approval messages on a plain tool', () => {
    const msg = baseMessage({
      role: 'TOOL',
      text: 'approve?',
      metadata: {
        toolCallId: 'tc-7',
        toolName: 'some_tool',
        requestUserApproval: { toolApproval: true },
      },
    });
    const { container } = renderBubble(<MessageBubble message={msg} />);
    expect(container.firstChild).toBeNull();
  });

  it('renders set_plan tool as PlanChip (IN_PROGRESS)', async () => {
    const msg = baseMessage({
      role: 'TOOL',
      text: '',
      metadata: {
        toolCallId: 'tc-8',
        toolName: 'set_plan',
        title: 'My plan',
        toolStatus: 'IN_PROGRESS',
      },
    });
    renderBubble(<MessageBubble message={msg} />);
    await waitFor(() => expect(screen.getByText(/plan/i)).toBeInTheDocument());
  });

  it('renders set_plan tool as PlanChip (ERROR)', async () => {
    const msg = baseMessage({
      role: 'TOOL',
      text: 'bad plan',
      metadata: {
        toolCallId: 'tc-9',
        toolName: 'set_plan',
        title: 'Plan Failed',
        toolStatus: 'ERROR',
      },
    });
    renderBubble(<MessageBubble message={msg} />);
    await waitFor(() => expect(screen.getByText(/Plan Failed/)).toBeInTheDocument());
  });

  it('renders general-purpose spawn IN_PROGRESS as spawning line', async () => {
    const msg = baseMessage({
      role: 'TOOL',
      text: 'starting',
      metadata: {
        toolCallId: 'tc-10',
        toolName: 'spawn_general_purpose_agent',
        toolStatus: 'IN_PROGRESS',
      },
    });
    renderBubble(<MessageBubble message={msg} />);
    await waitFor(() =>
      expect(screen.getByText(/Spawning general-purpose agents/)).toBeInTheDocument(),
    );
  });

  it('renders general-purpose pre-spawn ERROR as failed tree-node', async () => {
    const msg = baseMessage({
      role: 'TOOL',
      text: 'DAG param failed',
      metadata: {
        toolCallId: 'tc-11',
        toolName: 'spawn_general_purpose_agent_for_each',
        toolStatus: 'ERROR',
        title: 'General-purpose agent',
      },
    });
    renderBubble(<MessageBubble message={msg} />);
    await waitFor(() => expect(screen.getByText(/DAG param failed/)).toBeInTheDocument());
  });

  it('renders completion-summary message with CompletionSummaryCard', async () => {
    const msg = baseMessage({
      role: 'TOOL',
      text: '',
      metadata: {
        toolCallId: 'tc-12',
        toolName: 'complete',
        isFinalSummary: true,
        completionSummary: {
          summary: 'Completed the mission',
          outputs: [],
          totalToolCalls: 3,
          durationSeconds: 42,
        },
      },
    });
    renderBubble(<MessageBubble message={msg} />);
    await waitFor(() => expect(screen.getByText(/Completed the mission/)).toBeInTheDocument());
  });

  it('renders wait_for tool as WaitForChip', async () => {
    const msg = baseMessage({
      role: 'TOOL',
      text: 'waiting',
      metadata: {
        toolCallId: 'tc-13',
        toolName: 'wait_for',
        title: 'Wait for signal',
        toolStatus: 'IN_PROGRESS',
      },
    });
    const { container } = renderBubble(<MessageBubble message={msg} waitForChecks={[]} />);
    await waitFor(() => expect(container.textContent).toMatch(/Waiting|Wait|signal/i));
  });

  it('renders explore agent as ExploreAgentBubble', async () => {
    const msg = baseMessage({
      role: 'TOOL',
      text: '',
      metadata: {
        toolCallId: 'tc-14',
        toolName: 'spawn_agent',
        title: 'Explore foo',
        toolStatus: 'IN_PROGRESS',
        agentType: 'explore',
        taskId: 'task-1',
      },
    });
    renderBubble(<MessageBubble message={msg} />);
    await waitFor(() => expect(screen.getAllByText(/Explore foo/).length).toBeGreaterThan(0));
    expect(screen.getByTestId('explore-thinking-icon')).toBeInTheDocument();
  });

  it('renders finished explore agent with state-only header and result body', async () => {
    const msg = baseMessage({
      role: 'TOOL',
      text: 'The production deployment is ready. Status: READY. URL: https://roselabs.ai',
      metadata: {
        toolCallId: 'tc-14-finished',
        toolName: 'spawn_agent',
        title: 'Explore foo',
        fullGoal: 'Explore foo in detail',
        toolStatus: 'FINISHED',
        agentType: 'explore',
        taskId: 'task-1-finished',
      },
    });
    const { container } = renderBubble(<MessageBubble message={msg} />);

    await waitFor(() => expect(screen.getByText('Explored')).toBeInTheDocument());
    expect(screen.queryByText(/Explored -/)).not.toBeInTheDocument();
    expect(document.body.textContent).toContain('The production deployment is ready');
    expect(container.querySelector('.tool-message-markdown')).not.toBeNull();
  });

  it('hides Fast Mode / cached-trajectory copy from explore chips', async () => {
    const msg = baseMessage({
      role: 'TOOL',
      text: 'Fast Mode parallel replay: explore started and will run its full cached trajectory before this agent completes.',
      metadata: {
        toolCallId: 'tc-fast-mode-explore',
        toolName: 'spawn_agent',
        title: 'Identify top creators',
        fullGoal: 'Identify top creators',
        toolStatus: 'FINISHED',
        agentType: 'explore',
        taskId: 'task-fast-mode',
        fastModeParallel: true,
      },
    });
    renderBubble(<MessageBubble message={msg} />);

    await waitFor(() => expect(screen.getByText('Explored')).toBeInTheDocument());
    expect(document.body.textContent).not.toMatch(/fast\s*mode/i);
    expect(document.body.textContent).not.toMatch(/fast[\s-]*cache/i);
    expect(document.body.textContent).not.toMatch(/cached trajectory/i);
  });

  it('renders failed explore agent with state-only header and error result body', async () => {
    const msg = baseMessage({
      role: 'TOOL',
      text: 'Activity task failed: web_search_activity failed: Parallel AI search returned HTTP 429 Too Many Requests',
      metadata: {
        toolCallId: 'tc-14-error',
        toolName: 'spawn_agent',
        title: 'Check deploy status',
        fullGoal: 'Check whether the production deployment finished',
        toolStatus: 'ERROR',
        agentType: 'explore',
        taskId: 'task-1-error',
      },
    });
    renderBubble(<MessageBubble message={msg} />);

    await waitFor(() => expect(screen.getByText('Explore Failed')).toBeInTheDocument());
    expect(screen.queryByText(/Explore Failed -/)).not.toBeInTheDocument();
    expect(document.body.textContent).toContain(
      'Parallel AI search returned HTTP 429 Too Many Requests',
    );
  });

  it('renders Claude Code tool message as ClaudeCodeChip', async () => {
    const msg = baseMessage({
      role: 'TOOL',
      text: '',
      metadata: {
        toolCallId: 'tc-15',
        toolName: 'spawn_claude_code_agent',
        toolStatus: 'IN_PROGRESS',
        task_id: 'ccc-1',
      },
    });
    const { container } = renderBubble(<MessageBubble message={msg} />);
    // ClaudeCodeChip renders an <img alt="Claude Code"> logo — unique to that branch.
    await waitFor(() => {
      expect(container.querySelector('img[alt="Claude Code"]')).not.toBeNull();
    });
  });

  it('renders Codex code tool message when provider metadata is codex', async () => {
    const msg = baseMessage({
      role: 'TOOL',
      text: '',
      metadata: {
        toolCallId: 'tc-codex',
        toolName: 'spawn_claude_code_agent',
        toolStatus: 'IN_PROGRESS',
        task_id: 'codex-1',
        code_provider: 'codex',
      },
    });
    renderBubble(<MessageBubble message={msg} />);
    await waitFor(() => {
      expect(screen.getByText('Codex Spinning up...')).toBeInTheDocument();
    });
    expect(screen.getByAltText('Codex')).toBeInTheDocument();
  });

  it('renders phone call tool as PhoneCallCard', async () => {
    const msg = baseMessage({
      role: 'TOOL',
      text: '',
      metadata: {
        toolCallId: 'tc-16',
        toolName: 'call_phone_number',
        title: '📞 +15551234567',
        toolStatus: 'IN_PROGRESS',
      },
    });
    const { container } = renderBubble(<MessageBubble message={msg} />);
    await waitFor(() => expect(container.textContent).toMatch(/555|Unknown|call/i));
  });

  it('renders phone call FINISHED with phoneCall metadata', async () => {
    const msg = baseMessage({
      role: 'TOOL',
      text: '',
      metadata: {
        toolCallId: 'tc-17',
        toolName: 'call_phone_number',
        title: '✅ Call ended',
        toolStatus: 'FINISHED',
        phoneCall: {
          status: 'ended',
          to: '+15551234567',
          duration: 42,
          summary: 'Chat summary',
        },
      },
    });
    renderBubble(<MessageBubble message={msg} />);
    // PhoneCallCard renders the target phone number as unique text.
    await waitFor(() => expect(screen.getByText('+15551234567')).toBeInTheDocument());
    // Duration is formatted as m:ss (42s -> 0:42) — confirms FINISHED branch specifically.
    expect(screen.getByText('0:42')).toBeInTheDocument();
  });
});
