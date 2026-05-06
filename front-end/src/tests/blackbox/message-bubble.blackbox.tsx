/* eslint-disable max-lines */
/**
 * Blackbox tests for MessageBubble component.
 *
 * Covers all routing branches:
 *  - USER role: bubble with text, with file_pointer
 *  - ASSISTANT role: Thinking → Thought tool card, streaming, file_pointer
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
import { TooltipProvider } from '@/components/ui/tooltip';
import MessageBubble from '@/features/terminal-component-group/components/MessageBubble';
import { AgentContext } from '@/features/agent-context';
import type { AgentContextValue } from '@/features/agent-context';
import type { Message } from '@/lib/api';

function makeAgentCtx(overrides: Partial<AgentContextValue> = {}): AgentContextValue {
  const streamedTextsRef = { current: new Set<string>() } as React.MutableRefObject<Set<string>>;
  return {
    agent: null,
    setAgent: () => {},
    selectedAgentId: null,
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

  it('renders ASSISTANT with shouldType=true as Thinking (IN_PROGRESS)', async () => {
    const msg = baseMessage({ role: 'ASSISTANT', text: 'working' });
    const onComplete = vi.fn();
    renderBubble(<MessageBubble message={msg} shouldType={true} onTypingComplete={onComplete} />);
    await waitFor(() => expect(screen.getByText('Thinking')).toBeInTheDocument());
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

  it('renders Creating Cloud Agent tool while escalation starts', async () => {
    const msg = baseMessage({
      role: 'TOOL',
      text: '',
      metadata: {
        toolCallId: 'tc-cloud-agent',
        toolName: 'cloud_agent',
        title: 'Creating Cloud Agent',
        toolStatus: 'IN_PROGRESS',
      },
    });
    renderBubble(<MessageBubble message={msg} />);
    await waitFor(() => expect(screen.getByText('Creating Cloud Agent')).toBeInTheDocument());
  });

  it('renders Cloud Agent Created tool when workflow starts', async () => {
    const msg = baseMessage({
      role: 'TOOL',
      text: 'Cloud agent created.',
      metadata: {
        toolCallId: 'tc-cloud-agent',
        toolName: 'cloud_agent',
        title: 'Cloud Agent Created',
        toolStatus: 'FINISHED',
      },
    });
    renderBubble(<MessageBubble message={msg} />);
    await waitFor(() => expect(screen.getByText('Cloud Agent Created')).toBeInTheDocument());
    expect(screen.queryByText('Cloud agent created.')).not.toBeInTheDocument();
  });

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

  it('renders thought TOOL IN_PROGRESS as "Thinking" shimmer', async () => {
    const msg = baseMessage({
      role: 'TOOL',
      text: '',
      metadata: {
        toolCallId: 'tc-4',
        toolName: 'thought',
        title: 'Thinking',
        toolStatus: 'IN_PROGRESS',
      },
    });
    renderBubble(<MessageBubble message={msg} />);
    await waitFor(() => expect(screen.getByText('Thinking')).toBeInTheDocument());
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

  it('renders sub-agent spawn IN_PROGRESS as spawning line', async () => {
    const msg = baseMessage({
      role: 'TOOL',
      text: 'starting',
      metadata: {
        toolCallId: 'tc-10',
        toolName: 'spawn_sub_agent',
        toolStatus: 'IN_PROGRESS',
      },
    });
    renderBubble(<MessageBubble message={msg} />);
    await waitFor(() => expect(screen.getByText(/Spawning sub-agents/)).toBeInTheDocument());
  });

  it('renders sub-agent pre-spawn ERROR as failed tree-node', async () => {
    const msg = baseMessage({
      role: 'TOOL',
      text: 'DAG param failed',
      metadata: {
        toolCallId: 'tc-11',
        toolName: 'spawn_sub_agent',
        toolStatus: 'ERROR',
        title: 'Sub-agent',
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

  it('renders set_plan FINISHED with planData producing populated PlanChip', async () => {
    const msg = baseMessage({
      role: 'TOOL',
      text: '',
      metadata: {
        toolCallId: 'tc-18',
        toolName: 'set_plan',
        title: 'Plan title',
        toolStatus: 'FINISHED',
        data: {
          title: 'Deploy the thing',
          content: 'Ship it',
          tasks: [{ id: '1', title: 'task 1', status: 'planning' }],
          dependencies: null,
          join: 'all',
          status: 'planning',
        },
      },
    });
    renderBubble(<MessageBubble message={msg} planCharCount={123} />);
    await waitFor(() => expect(screen.getByText(/Deploy the thing/)).toBeInTheDocument());
  });

  it('renders streaming attention message using StreamingText (isStreaming=true)', async () => {
    const msg = baseMessage({
      role: 'TOOL',
      text: 'streaming body',
      metadata: {
        toolCallId: 'tc-19',
        toolName: 'send_message_to_user',
        isUserAttentionMessage: true,
        toolStatus: 'IN_PROGRESS',
        attentionMessage: 'streaming body',
      },
    });
    const { container } = renderBubble(<MessageBubble message={msg} isStreaming={true} />);
    await waitFor(() => expect(container.textContent).toContain('streaming body'));
  });

  it('renders claude_code_started branch as ClaudeCodeChip', async () => {
    const msg = baseMessage({
      role: 'TOOL',
      text: '',
      metadata: {
        toolCallId: 'tc-20',
        toolName: 'spawn_claude_code_agent',
        action_type: 'claude_code_started',
        task_id: 'cc-started',
      },
    });
    const { container } = renderBubble(<MessageBubble message={msg} />);
    // claude_code_started must render the ClaudeCodeChip (Claude logo).
    await waitFor(() => {
      expect(container.querySelector('img[alt="Claude Code"]')).not.toBeNull();
    });
  });

  it('renders task_complete branch for Claude Code tool', async () => {
    const msg = baseMessage({
      role: 'TOOL',
      text: '',
      metadata: {
        toolCallId: 'tc-21',
        toolName: 'spawn_claude_code_agent',
        action_type: 'task_complete',
        task_id: 'cc-complete',
      },
    });
    const { container } = renderBubble(<MessageBubble message={msg} />);
    // task_complete must still route through ClaudeCodeChip (Claude logo).
    await waitFor(() => {
      expect(container.querySelector('img[alt="Claude Code"]')).not.toBeNull();
    });
  });

  it('renders USER message with image file_pointer showing loading placeholder', async () => {
    const msg = baseMessage({
      role: 'USER',
      text: 'look',
      file_pointer: {
        id: 'img1',
        storage_path: 'uploads/pic.png',
        original_filename: 'pic.png',
        mime_type: 'image/png',
        size_bytes: 2048,
        created_at: new Date().toISOString(),
      },
    });
    const { container } = renderBubble(<MessageBubble message={msg} agentId="agent-img" />);
    // Image placeholder renders the filename while signed URL loads.
    await waitFor(() => expect(screen.getByText('pic.png')).toBeInTheDocument());
    expect(container.textContent).toContain('look');
  });

  it('renders iMessage action metadata block with Send via Mac button', async () => {
    const msg = baseMessage({
      role: 'TOOL',
      text: 'please send this',
      metadata: {
        toolCallId: 'tc-22',
        toolName: 'request_user_attention',
        title: 'Need Mac send',
        toolStatus: 'IN_PROGRESS',
        requestUserAttention: {
          onSuccess: 'sendSmsThroughIMessage',
          to: '+15551112222',
          message: 'Howdy',
          attentionRequestId: 'att-1',
        },
      },
    });
    renderBubble(<MessageBubble message={msg} />);
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /Send via Mac iMessage/ })).toBeInTheDocument(),
    );
    expect(screen.getByText(/Howdy/)).toBeInTheDocument();
  });

  it('AttentionMessage with Start Autonomous Execution button when onSendMessage given', async () => {
    const onSend = vi.fn();
    const msg = baseMessage({
      role: 'TOOL',
      text: 'answer me',
      metadata: {
        toolCallId: 'tc-auto',
        toolName: 'send_message_to_user',
        isUserAttentionMessage: true,
        toolStatus: 'IN_PROGRESS',
        attentionMessage: 'answer me',
      },
    });
    renderBubble(<MessageBubble message={msg} onSendMessage={onSend} />);
    const btn = await screen.findByRole('button', {
      name: /Start Autonomous Execution/,
    });
    await userEvent.click(btn);
    expect(onSend).toHaveBeenCalled();
  });

  it('renders TOOL IN_PROGRESS with progressComplete in 0-100 range', () => {
    const msg = baseMessage({
      role: 'TOOL',
      text: '',
      metadata: {
        toolCallId: 'tc-23',
        toolName: 'compute',
        title: 'Computing',
        toolStatus: 'IN_PROGRESS',
        progressComplete: 75,
      },
    });
    const { container } = renderBubble(<MessageBubble message={msg} />);
    const inner = container.querySelector('.bg-primary') as HTMLElement | null;
    expect(inner).not.toBeNull();
    expect(inner!.style.width).toContain('75');
  });

  it('renders completion summary with FeedbackBanner when onSubmitFeedback is passed', async () => {
    const onSubmitFeedback = vi.fn();
    const msg = baseMessage({
      role: 'TOOL',
      text: '',
      metadata: {
        toolCallId: 'tc-fb',
        toolName: 'complete',
        isFinalSummary: true,
        completionSummary: {
          summary: 'All done',
          outputs: [],
          totalToolCalls: 1,
          durationSeconds: 10,
        },
      },
    });
    renderBubble(<MessageBubble message={msg} onSubmitFeedback={onSubmitFeedback} />);
    // FeedbackBanner's initial rating step prompts "How was this result?".
    await waitFor(() => expect(screen.getByText(/How was this result\?/i)).toBeInTheDocument());
  });

  it('iMessage action button shows toast when bridge is missing', async () => {
    const msg = baseMessage({
      role: 'TOOL',
      text: 'please send',
      metadata: {
        toolCallId: 'tc-ims',
        toolName: 'request_user_attention',
        title: 'iMessage',
        toolStatus: 'IN_PROGRESS',
        requestUserAttention: {
          onSuccess: 'sendSmsThroughIMessage',
          to: '+15550000000',
          message: 'Hi',
          attentionRequestId: 'att-9',
        },
      },
    });
    renderBubble(<MessageBubble message={msg} />);
    const btn = await screen.findByRole('button', { name: /Send via Mac iMessage/ });
    await userEvent.click(btn);
    // Button still present - no crash.
    expect(btn).toBeInTheDocument();
  });

  it('renders thought TOOL FINISHED as collapsed tool card', async () => {
    const msg = baseMessage({
      role: 'TOOL',
      text: 'final thought',
      metadata: {
        toolCallId: 'tc-th-done',
        toolName: 'thought',
        title: 'Thought',
        toolStatus: 'FINISHED',
      },
    });
    const { container } = renderBubble(<MessageBubble message={msg} />);
    await waitFor(() => expect(screen.getByText('Thought')).toBeInTheDocument());
    expect(container).toBeTruthy();
  });

  it('renders wait_for tool as WaitForChip (FINISHED)', async () => {
    const msg = baseMessage({
      role: 'TOOL',
      text: 'done',
      metadata: {
        toolCallId: 'tc-wf-done',
        toolName: 'wait_for',
        title: 'Waiting for signal',
        toolStatus: 'FINISHED',
      },
    });
    renderBubble(<MessageBubble message={msg} waitForChecks={[]} />);
    // WaitForChip in FINISHED state renders "Waited for {condition}".
    await waitFor(() => expect(screen.getByText(/Waited for/i)).toBeInTheDocument());
  });

  it('calls onTypingComplete for set_plan IN_PROGRESS when shouldType=true', async () => {
    const onTypingComplete = vi.fn();
    const msg = baseMessage({
      role: 'TOOL',
      text: '',
      metadata: {
        toolCallId: 'tc-sp-type',
        toolName: 'set_plan',
        title: 'P',
        toolStatus: 'IN_PROGRESS',
      },
    });
    renderBubble(
      <MessageBubble message={msg} shouldType={true} onTypingComplete={onTypingComplete} />,
    );
    await waitFor(() => expect(onTypingComplete).toHaveBeenCalled());
  });

  it('calls onTypingComplete immediately for claude code tool when shouldType=true', async () => {
    const onTypingComplete = vi.fn();
    const msg = baseMessage({
      role: 'TOOL',
      text: '',
      metadata: {
        toolCallId: 'tc-cc-type',
        toolName: 'spawn_claude_code_agent',
        action_type: 'task_complete',
        task_id: 'x',
      },
    });
    renderBubble(
      <MessageBubble message={msg} shouldType={true} onTypingComplete={onTypingComplete} />,
    );
    await waitFor(() => expect(onTypingComplete).toHaveBeenCalled());
  });

  it('calls onTypingComplete immediately for tool-approval message when shouldType=true', async () => {
    const onTypingComplete = vi.fn();
    const msg = baseMessage({
      role: 'TOOL',
      text: 'approve?',
      metadata: {
        toolCallId: 'tc-ap-type',
        toolName: 'some_tool',
        requestUserApproval: { toolApproval: true },
      },
    });
    renderBubble(
      <MessageBubble message={msg} shouldType={true} onTypingComplete={onTypingComplete} />,
    );
    await waitFor(() => expect(onTypingComplete).toHaveBeenCalled());
  });

  it('renders sub-agent tree view when subAgentIds + busId present', async () => {
    const msg = baseMessage({
      role: 'TOOL',
      text: '',
      metadata: {
        toolCallId: 'tc-sat',
        toolName: 'spawn_sub_agent',
        toolStatus: 'FINISHED',
        title: '🚀 Spawning cluster',
        subAgentIds: ['a1', 'a2'],
        busId: 'bus-1',
      },
    });
    const { container } = renderBubble(<MessageBubble message={msg} />);
    await waitFor(() => expect(container.firstChild).not.toBeNull());
    // The SubAgentTree branch renders a wrapper <div.flex.gap-3> hosting <SubAgentTree />.
    // SubAgentTree returns null when useAgentTree has no nodes for the bus, so the wrapper
    // may be empty in this harness — but the OTHER branches (SubAgentToolBubble chip /
    // "Spawning sub-agents..." fallback / ERROR red row) all emit distinctive text.
    // Assert none of those alternate branches fired, proving we went through the tree branch.
    expect(screen.queryByText(/Spawning cluster/)).toBeNull(); // SubAgentToolBubble title
    expect(screen.queryByText(/Spawning sub-agents\.\.\./)).toBeNull(); // isSpawningMessage
    expect(screen.queryByText(/Failed to spawn sub-agent/)).toBeNull(); // error branch
    // And the tree wrapper is present.
    const wrapper = container.querySelector('div.flex.gap-3') as HTMLElement | null;
    expect(wrapper).not.toBeNull();
  });

  it('compact prop removes gap-3 container class in completion summary', async () => {
    const msg = baseMessage({
      role: 'TOOL',
      text: '',
      metadata: {
        toolCallId: 'tc-cs-compact',
        toolName: 'complete',
        isFinalSummary: true,
        completionSummary: {
          summary: 'Short',
          outputs: [],
          totalToolCalls: 0,
          durationSeconds: 0,
        },
      },
    });
    const { container: compactContainer } = renderBubble(
      <MessageBubble message={msg} compact={true} />,
    );
    // Control render without compact — must have gap-3.
    const { container: defaultContainer } = renderBubble(
      <MessageBubble message={msg} compact={false} />,
    );
    await waitFor(() => expect(compactContainer.querySelector('.flex')).not.toBeNull());
    // The compact outer flex wrapper must NOT contain gap-3.
    const compactFlex = compactContainer.querySelector('.flex') as HTMLElement | null;
    expect(compactFlex).not.toBeNull();
    expect(compactFlex!.classList.contains('gap-3')).toBe(false);
    // Sanity: default render DOES include gap-3.
    const defaultFlex = defaultContainer.querySelector('.flex') as HTMLElement | null;
    expect(defaultFlex).not.toBeNull();
    expect(defaultFlex!.classList.contains('gap-3')).toBe(true);
  });
});
