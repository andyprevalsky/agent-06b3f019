/**
 * MessageList state-transition coverage split from message-list.blackbox.tsx
 * to keep each blackbox suite within the repository line budget.
 */
import React from 'react';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { act, render, renderHook, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TooltipProvider } from '@/components/ui/tooltip';
import { AgentContext, type AgentContextValue } from '@/features/agent-context';
import { MessageList } from '@/features/terminal-component-group/components/MessageList';
import { useMessageAnimationBuffer } from '@/features/terminal-component-group/components/useMessageList';
import type { AgentDetail, Message } from '@/lib/api';

beforeAll(() => {
  if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = function () {};
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

function renderList(ctx: AgentContextValue) {
  return render(
    <AgentContext.Provider value={ctx}>
      <TooltipProvider>
        <MessageList />
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

describe('MessageList state transitions', () => {
  it('clears an in-flight animation when the selected agent changes', async () => {
    let dispatch!: (message: Message) => void;
    const registerMessageHandler = (_subAgentId: string | null, handler: (m: Message) => void) => {
      dispatch = handler;
      return () => {};
    };
    const streamedTextsRef = { current: new Set<string>() };
    const assistantInsertedRef = { current: false };
    const { result, rerender } = renderHook(
      ({ selectedAgentId }) =>
        useMessageAnimationBuffer({
          selectedAgentId,
          subAgentId: undefined,
          registerMessageHandler,
          streamedTextsRef,
          assistantInsertedRef,
        }),
      { initialProps: { selectedAgentId: 'agent-1' as string | null } },
    );

    act(() => dispatch(msg('agent-1-answer', { role: 'ASSISTANT', text: 'secret from A' })));
    await waitFor(() => expect(result.current.currentAnimatingId).toBe('agent-1-answer'));
    rerender({ selectedAgentId: 'agent-2' });

    expect(result.current.currentAnimatingId).toBeNull();
    expect(result.current.isAnimating).toBe(false);
    expect(result.current.messageBufferLength).toBe(0);
  });

  it('clears an in-flight animation when the displayed sub-agent changes', async () => {
    let dispatch!: (message: Message) => void;
    const registerMessageHandler = (_subAgentId: string | null, handler: (m: Message) => void) => {
      dispatch = handler;
      return () => {};
    };
    const streamedTextsRef = { current: new Set<string>() };
    const assistantInsertedRef = { current: false };
    const initialProps = { subAgentId: 'sub-agent-a' as string | undefined };
    const { result, rerender } = renderHook(
      ({ subAgentId }) =>
        useMessageAnimationBuffer({
          selectedAgentId: 'root-agent',
          subAgentId,
          registerMessageHandler,
          streamedTextsRef,
          assistantInsertedRef,
        }),
      { initialProps },
    );

    act(() => dispatch(msg('sub-a-answer', { role: 'ASSISTANT', text: 'secret from sub A' })));
    await waitFor(() => expect(result.current.currentAnimatingId).toBe('sub-a-answer'));
    const staleSubAgentHandler = dispatch;
    rerender({ subAgentId: 'sub-agent-b' });
    act(() =>
      staleSubAgentHandler(
        msg('late-sub-a-answer', { role: 'ASSISTANT', text: 'late secret from sub A' }),
      ),
    );

    expect(result.current.currentAnimatingId).toBeNull();
    expect(result.current.isAnimating).toBe(false);
    expect(result.current.messageBufferLength).toBe(0);
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
    await waitFor(() => expect(container.firstChild).not.toBeNull());
    expect(container.textContent).toMatch(/Check 2 done|Check 2|condition met/i);
    expect(container.textContent).toMatch(/2\s*checks/i);
  });

  it('renders chat-mode actions after a finished user message', async () => {
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

  it('copies the last assistant or tool text', async () => {
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
    await userEvent.click(await screen.findByTitle('Copy response'));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('copy me'));
  });
});
