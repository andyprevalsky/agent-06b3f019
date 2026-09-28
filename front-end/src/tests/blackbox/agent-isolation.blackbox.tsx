/**
 * Agent-view isolation regression.
 *
 * STATE MACHINE:
 *   [AGENT A ACTIVE] -- select B --> [B LOADING] --> [AGENT B ACTIVE]
 *   [AGENT B ACTIVE] -- late A callback/response --> [AGENT B UNCHANGED]
 *
 * This preserves the production race at the owning boundary: Supabase can
 * deliver an already-queued callback after unsubscribe while React has moved
 * the shared provider state to another agent.
 */
import { act, render, renderHook, screen, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AgentProvider, useAgentContext } from '@/features/agent-context';
import { useAgentActions } from '@/features/terminal/hooks/useAgentActions';
import type { AgentDetail } from '@/lib/api';
import { server } from './msw/server';

vi.mock('@/lib/realtime', async (importOriginal) => {
  const mod = await importOriginal<typeof import('@/lib/realtime')>();
  return {
    ...mod,
    subscribeToAgent: vi.fn(),
    unsubscribe: vi.fn(),
  };
});

import * as RealtimeMod from '@/lib/realtime';

const API_BASE = 'http://localhost:3001/api';
type AgentHandlers = Parameters<typeof RealtimeMod.subscribeToAgent>[1];

function makeAgent(agentId: string): AgentDetail {
  return {
    agent_id: agentId,
    goal: `goal for ${agentId}`,
    title: `title for ${agentId}`,
    model: 'rose-1-flash',
    source: 'WEB',
    reasoning_effort: 'medium',
    progress: 0.5,
    status: 'ACTIVE',
    status_message: null,
    temporal_workflow_id: `workflow-${agentId}`,
    token_count: 0,
    tokens_in: 0,
    tokens_out: 0,
    tool_tokens_in: 0,
    tool_tokens_out: 0,
    tool_cost_cents: 0,
    context_size: 0,
    message_count: 1,
    price_limit_cents: 100,
    tree_cost_cents: 0,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    write_lock_enabled: false,
    parent_agent_id: null,
    parent_goal: null,
    verifier: null,
    tools: [],
  };
}

function agentResponse(agentId: string) {
  return {
    agent: makeAgent(agentId),
    messages: [
      {
        message_id: `message-${agentId}`,
        timestamp: '2026-01-01T00:00:00.000Z',
        text: `message for ${agentId}`,
        role: 'USER',
      },
    ],
    pagination: { has_more: false, oldest_timestamp: null },
  };
}

function mockSession() {
  const session = {
    access_token: 'test-token',
    refresh_token: 'test-refresh',
    expires_in: 3600,
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    token_type: 'bearer',
    user: { id: 'test-user', is_anonymous: false },
  };
  localStorage.setItem('rose-session', JSON.stringify(session));
}

/** Test-only view of every agent-scoped value that can visibly cross pages. */
export function IsolationProbe() {
  const context = useAgentContext();
  return (
    <div>
      <button type="button" onClick={() => context.setSelectedAgentId('agent-b')}>
        Select B
      </button>
      <output data-testid="selection">{context.selectedAgentId ?? 'none'}</output>
      <output data-testid="agent">{context.agent?.agent_id ?? 'none'}</output>
      <output data-testid="title">{context.agent?.title ?? 'none'}</output>
      <output data-testid="messages">
        {context.messages.map((message) => message.text).join('|')}
      </output>
      <output data-testid="streams">
        {[...context.streamingBubbles.values()].map((bubble) => bubble.text).join('|')}
      </output>
      <output data-testid="plan">{context.streamingPlan?.title ?? 'none'}</output>
      <output data-testid="attention">{context.streamingAttention?.message ?? 'none'}</output>
      <output data-testid="tools">
        {[...context.streamingTools.values()].map((tool) => tool.title).join('|')}
      </output>
      <output data-testid="chat-mode">{String(context.isChatMode)}</output>
    </div>
  );
}

describe('agent view isolation', () => {
  beforeEach(() => {
    localStorage.clear();
    mockSession();
    window.history.replaceState({}, '', '/?agent-id=agent-a');
    vi.mocked(RealtimeMod.subscribeToAgent).mockReset();
    vi.mocked(RealtimeMod.unsubscribe).mockReset();
  });

  it('rejects every late callback from the previously selected agent', async () => {
    const handlers = new Map<string, AgentHandlers>();
    vi.mocked(RealtimeMod.subscribeToAgent).mockImplementation(async (agentId, callbacks) => {
      handlers.set(agentId, callbacks);
      return { state: 'joined', topic: `agent:${agentId}` } as never;
    });
    server.use(
      http.get(`${API_BASE}/agents/:agentId`, ({ params }) =>
        HttpResponse.json(agentResponse(String(params.agentId))),
      ),
    );

    render(
      <AgentProvider
        user={{ id: 'test-user' }}
        isAuthenticated
        realtimeReady
        onLoadAgents={vi.fn()}
      >
        <IsolationProbe />
      </AgentProvider>,
    );

    await waitFor(() => expect(screen.getByTestId('agent')).toHaveTextContent('agent-a'));
    act(() => screen.getByRole('button', { name: 'Select B' }).click());
    await waitFor(() => expect(screen.getByTestId('agent')).toHaveTextContent('agent-b'));
    await waitFor(() => expect(handlers.get('agent-b')).toBeDefined());

    const stale = handlers.get('agent-a');
    expect(stale).toBeDefined();
    act(() => {
      stale?.onInsert?.({
        agentId: 'agent-a',
        id: 'late-a-message',
        timestamp: '2026-01-01T00:00:01.000Z',
        text: 'LEAKED MESSAGE FROM A',
        role: 'ASSISTANT',
      });
      stale?.onUpdate?.({ title: 'LEAKED TITLE FROM A' });
      stale?.onAssistantStream?.({
        agentId: 'agent-a',
        stream_id: 'late-a-stream',
        sequence: 0,
        delta: 'LEAKED STREAM FROM A',
        done: false,
      });
      stale?.onPlanStream?.({
        agentId: 'agent-a',
        stream_id: 'late-a-plan',
        tool_call_id: 'late-a-plan-tool',
        title: 'LEAKED PLAN FROM A',
      });
      stale?.onAttentionStream?.({
        agentId: 'agent-a',
        stream_id: 'late-a-attention',
        tool_call_id: 'late-a-attention-tool',
        message: 'LEAKED ATTENTION FROM A',
        is_question: false,
        done: false,
        sequence: 1,
      });
      stale?.onToolStream?.({
        agentId: 'agent-a',
        stream_id: 'late-a-tool',
        tool_call_id: 'late-a-tool-call',
        tool_name: 'browser',
        title: 'LEAKED TOOL FROM A',
      });
      stale?.onAgentModeStarted?.({ agentId: 'agent-a' });
      stale?.onDisconnect?.();
    });

    expect(screen.getByTestId('selection')).toHaveTextContent('agent-b');
    expect(screen.getByTestId('agent')).toHaveTextContent('agent-b');
    expect(screen.getByTestId('title')).toHaveTextContent('title for agent-b');
    expect(screen.getByTestId('messages')).toHaveTextContent('message for agent-b');
    expect(screen.getByTestId('messages')).not.toHaveTextContent('LEAKED MESSAGE FROM A');
    expect(screen.getByTestId('streams')).not.toHaveTextContent('LEAKED STREAM FROM A');
    expect(screen.getByTestId('plan')).not.toHaveTextContent('LEAKED PLAN FROM A');
    expect(screen.getByTestId('attention')).not.toHaveTextContent('LEAKED ATTENTION FROM A');
    expect(screen.getByTestId('tools')).not.toHaveTextContent('LEAKED TOOL FROM A');
    expect(screen.getByTestId('chat-mode')).toHaveTextContent('false');
  });

  it('rejects a detail refresh that resolves after the selected agent changes', async () => {
    let finishRequest!: () => void;
    const requestCanFinish = new Promise<void>((resolve) => {
      finishRequest = resolve;
    });
    server.use(
      http.get(`${API_BASE}/agents/agent-a`, async () => {
        await requestCanFinish;
        return HttpResponse.json(agentResponse('agent-a'));
      }),
    );
    const applyAgentDetail = vi.fn(() => true);
    const setAgentDetail = vi.fn();
    const setMessages = vi.fn();
    const setSelectedModel = vi.fn();
    const initialProps = {
      selectedAgentId: 'agent-a' as string | null,
      agentDetail: makeAgent('agent-a'),
      applyAgentDetail,
      setAgentDetail,
      setMessages,
      setSelectedModel,
      setSelectedAgentIdContext: vi.fn(),
      setCurrentView: vi.fn(),
      clientSource: 'WEB',
      loadAgents: vi.fn(async () => {}),
    };
    const { result, rerender } = renderHook(
      (props: typeof initialProps) => useAgentActions(props),
      { initialProps },
    );

    let refresh!: Promise<void>;
    act(() => {
      refresh = result.current.refreshAgentDetail('agent-a');
    });
    rerender({ ...initialProps, selectedAgentId: 'agent-b', agentDetail: makeAgent('agent-b') });
    finishRequest();
    await act(async () => refresh);

    expect(applyAgentDetail).not.toHaveBeenCalled();
    expect(setAgentDetail).not.toHaveBeenCalled();
    expect(setMessages).not.toHaveBeenCalled();
    expect(setSelectedModel).not.toHaveBeenCalled();
  });

  it('never renders an agent detail response whose identity differs from the URL', async () => {
    vi.mocked(RealtimeMod.subscribeToAgent).mockImplementation(
      async (agentId) =>
        ({
          state: 'joined',
          topic: `agent:${agentId}`,
        }) as never,
    );
    server.use(
      http.get(`${API_BASE}/agents/requested-agent`, () =>
        HttpResponse.json(agentResponse('different-agent')),
      ),
    );
    window.history.replaceState({}, '', '/?agent-id=requested-agent');
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    render(
      <AgentProvider user={{ id: 'test-user' }} isAuthenticated realtimeReady>
        <IsolationProbe />
      </AgentProvider>,
    );

    await waitFor(() => expect(error).toHaveBeenCalled());
    expect(screen.getByTestId('agent')).not.toHaveTextContent('different-agent');
    expect(screen.getByTestId('messages')).not.toHaveTextContent('message for different-agent');
    error.mockRestore();
  });
});
