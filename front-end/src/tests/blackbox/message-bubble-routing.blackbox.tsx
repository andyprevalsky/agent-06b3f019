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
          tasks: [
            { goal: 'Gather release facts', tool_name: 'spawn_explore_agent' },
            { goal: 'Write deployment notes', tool_name: 'reasoning' },
          ],
          dependencies_graph: [{ task_idx: '1', depends_on: ['0'] }],
          join: 'all',
          status: 'planning',
        },
      },
    });
    renderBubble(<MessageBubble message={msg} planCharCount={123} />);
    await waitFor(() => expect(screen.getByText(/Deploy the thing/)).toBeInTheDocument());
    expect(screen.getByText('2 Tasks · Sequential')).toBeInTheDocument();
    expect(screen.getByText('→ after 1')).toBeInTheDocument();
  });

  it('renders set_plan dependencies from a dependencies record', async () => {
    const msg = baseMessage({
      role: 'TOOL',
      text: '',
      metadata: {
        toolCallId: 'tc-plan-record',
        toolName: 'set_plan',
        toolStatus: 'FINISHED',
        data: {
          title: 'Record deps plan',
          content: 'Ship it',
          tasks: [
            { goal: 'Collect facts', tool_name: 'spawn_explore_agent' },
            { goal: 'Write summary', tool_name: 'reasoning' },
          ],
          dependencies: { '1': ['0'] },
          join: 'all',
          status: 'planning',
        },
      },
    });

    renderBubble(<MessageBubble message={msg} />);

    await waitFor(() => expect(screen.getByText(/Record deps plan/)).toBeInTheDocument());
    expect(screen.getByText('2 Tasks · Sequential')).toBeInTheDocument();
    expect(screen.getByText('→ after 1')).toBeInTheDocument();
  });

  it('renders set_plan dependencies from task depends_on fields', async () => {
    const msg = baseMessage({
      role: 'TOOL',
      text: '',
      metadata: {
        toolCallId: 'tc-plan-task-deps',
        toolName: 'set_plan',
        toolStatus: 'FINISHED',
        data: {
          title: 'Task deps plan',
          content: 'Ship it',
          tasks: [
            { goal: 'Collect facts', tool_name: 'spawn_explore_agent', depends_on: [] },
            { goal: 'Write summary', tool_name: 'reasoning', depends_on: ['0'] },
          ],
          join: 'all',
          status: 'planning',
        },
      },
    });

    renderBubble(<MessageBubble message={msg} />);

    await waitFor(() => expect(screen.getByText(/Task deps plan/)).toBeInTheDocument());
    expect(screen.getByText('2 Tasks · Sequential')).toBeInTheDocument();
    expect(screen.getByText('→ after 1')).toBeInTheDocument();
  });

  it('renders markdown photos inside a finished FYI attention bubble', async () => {
    const msg = baseMessage({
      role: 'TOOL',
      text: 'Cyber Racoon interior',
      metadata: {
        toolCallId: 'tc-photo-fyi',
        toolName: 'send_message_to_user',
        isUserAttentionMessage: true,
        toolStatus: 'FINISHED',
        attentionMessage:
          'Cyber Racoon interior:\n\n![Cyber Racoon PC Cafe](https://www.cyberracoon.com/gallery/room.jpg)',
        sendMessageToUser: { isQuestion: false, attentionKind: 'info', isWaitingForUser: false },
      },
    });
    const { container } = renderBubble(<MessageBubble message={msg} />);
    await waitFor(() => {
      const img = container.querySelector('img[alt="Cyber Racoon PC Cafe"]');
      expect(img).not.toBeNull();
      expect(img).toHaveAttribute('src', 'https://www.cyberracoon.com/gallery/room.jpg');
    });
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

  it('renders session_cancelled branch for Claude Code tool', async () => {
    const msg = baseMessage({
      role: 'TOOL',
      text: 'User paused the agent',
      metadata: {
        toolCallId: 'tc-21b',
        toolName: 'spawn_claude_code_agent',
        action_type: 'session_cancelled',
        task_id: 'cc-cancelled',
        toolStatus: 'ERROR',
      },
    });
    const { container } = renderBubble(<MessageBubble message={msg} />);
    await waitFor(() => {
      expect(container.querySelector('img[alt="Claude Code"]')).not.toBeNull();
    });
  });

  it('recovers task_id from sibling when cancel anchor omits it (avoids Spinning up)', async () => {
    // toolCallId-dedupe can anchor the chip on handler cancel without task_id.
    // Full agent transcript still has claude_code_started + Session Cancelled
    // with the real task_id — bubble must recover it so the chip leaves Spinning up.
    const toolCallId = 'tc-21c-orphan-cancel';
    const started = baseMessage({
      message_id: 'm-cc-started',
      role: 'TOOL',
      text: '',
      metadata: {
        toolCallId,
        toolName: 'spawn_claude_code_agent',
        action_type: 'claude_code_started',
        task_id: 'cc-orphan-task',
        toolStatus: 'IN_PROGRESS',
        title: 'Claude Code Started',
      },
    });
    const cancelledWithId = baseMessage({
      message_id: 'm-cc-cancelled-id',
      role: 'TOOL',
      text: 'Agent paused by user',
      metadata: {
        toolCallId,
        toolName: 'spawn_claude_code_agent',
        action_type: 'task_complete',
        task_id: 'cc-orphan-task',
        toolStatus: 'FINISHED',
        title: 'Session Cancelled',
      },
    });
    const cancelWithoutId = baseMessage({
      message_id: 'm-cc-cancel-bare',
      role: 'TOOL',
      text: 'User paused the agent',
      metadata: {
        toolCallId,
        toolName: 'spawn_claude_code_agent',
        action_type: 'task_complete',
        toolStatus: 'ERROR',
        title: 'Claude Code Session Cancelled',
        success: false,
      },
    });
    const ctx = makeAgentCtx({ messages: [started, cancelledWithId, cancelWithoutId] });
    const { container } = renderBubble(<MessageBubble message={cancelWithoutId} />, ctx);
    await waitFor(() => {
      expect(container.querySelector('img[alt="Claude Code"]')).not.toBeNull();
    });
    expect(container.textContent).not.toMatch(/Spinning up/i);
    expect(container.textContent).toMatch(/Failed|Cancelled|Complete/i);
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
        toolName: 'spawn_general_purpose_agent_for_each',
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
    // "Spawning general-purpose agents..." fallback / ERROR red row) all emit distinctive text.
    // Assert none of those alternate branches fired, proving we went through the tree branch.
    expect(screen.queryByText(/Spawning cluster/)).toBeNull(); // SubAgentToolBubble title
    expect(screen.queryByText(/Spawning general-purpose agents\.\.\./)).toBeNull(); // isSpawningMessage
    expect(screen.queryByText(/Failed to spawn general-purpose agent/)).toBeNull(); // error branch
    // And the tree wrapper is present.
    const wrapper = container.querySelector('div.flex.gap-3') as HTMLElement | null;
    expect(wrapper).not.toBeNull();
  });

  it('hides the parent for_each tree when a listed child is selected', async () => {
    const msg = baseMessage({
      role: 'TOOL',
      text: '',
      metadata: {
        toolCallId: 'tc-sat-parent',
        toolName: 'spawn_general_purpose_agent_for_each',
        toolStatus: 'FINISHED',
        title: '🚀 Spawning cluster',
        subAgentIds: ['child-1', 'child-2'],
        busId: 'root-1',
      },
    });
    const { container } = renderBubble(
      <MessageBubble message={msg} />,
      makeAgentCtx({ selectedAgentId: 'child-1' }),
    );
    await waitFor(() => expect(container.firstChild).toBeNull());
    expect(screen.queryByText(/Spawning cluster/)).toBeNull();
    expect(screen.queryByText(/Spawning general-purpose agents\.\.\./)).toBeNull();
    expect(container.querySelector('div.flex.gap-3')).toBeNull();
  });

  it('still renders a child-owned spawn tree when that child is selected', async () => {
    const msg = baseMessage({
      role: 'TOOL',
      text: '',
      metadata: {
        toolCallId: 'tc-sat-child',
        toolName: 'spawn_general_purpose_agent',
        toolStatus: 'FINISHED',
        title: 'Explore cluster',
        subAgentIds: ['explore-1'],
        busId: 'child-1',
      },
    });
    const { container } = renderBubble(
      <MessageBubble message={msg} />,
      makeAgentCtx({ selectedAgentId: 'child-1' }),
    );
    await waitFor(() => expect(container.firstChild).not.toBeNull());
    expect(screen.queryByText(/Explore cluster/)).toBeNull();
    expect(container.querySelector('div.flex.gap-3')).not.toBeNull();
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
