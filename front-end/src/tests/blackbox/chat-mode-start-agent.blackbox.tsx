/**
 * Chat-mode "Start agent" button (ChatModeActions) through the real
 * AgentProvider + MessageList, with Supabase realtime replaced by the exact
 * callbacks the backend emits.
 *
 * STATE MACHINE under test:
 *   [HIDDEN] --chat answer (send_message_to_user FINISHED) on an ACTIVE chat agent--> [READY]
 *   [READY] --click--> [STARTING] (disabled, "Starting agent…", no second POST)
 *   [STARTING] --AGENT_MODE_STARTED--> [HIDDEN]
 *   [STARTING] --POST fails--> [READY] + destructive toast
 *
 * Regression for docs/rca/cases/2026-10-28-chat-start-agent-button-stale-status-and-no-pending-state.md:
 * a follow-up chat on a finished run left the client's agent status at
 * COMPLETED (the reactivation was never broadcast), so the button never showed;
 * and a click gave no feedback until Temporal accepted the workflow, so a second
 * click POSTed again and toasted "Agent is already in agent mode".
 */
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { TooltipProvider } from '@/components/ui/tooltip';
import { AgentProvider } from '@/features/agent-context';
import { MessageList } from '@/features/terminal-component-group/components/MessageList';
import type { AgentDetail, Message } from '@/lib/api';
import { server } from './msw/server';

vi.mock('@/lib/realtime', async (importOriginal) => {
  const mod = await importOriginal<typeof import('@/lib/realtime')>();
  return { ...mod, subscribeToAgent: vi.fn(), unsubscribe: vi.fn() };
});

import * as RealtimeMod from '@/lib/realtime';

const API_BASE = 'http://localhost:3001/api';
const AGENT_ID = 'chat-agent';
type AgentHandlers = Parameters<typeof RealtimeMod.subscribeToAgent>[1];

beforeAll(() => {
  if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = function () {};
});

function makeAgent(overrides: Partial<AgentDetail>): AgentDetail {
  return {
    agent_id: AGENT_ID,
    goal: 'compare SOC 2 platforms',
    title: 'SOC 2 platforms',
    model: 'rose-1-flash',
    source: 'MAC_APP',
    reasoning_effort: 'medium',
    progress: 0,
    status: 'ACTIVE',
    status_message: null,
    temporal_workflow_id: null,
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
    created_at: '2026-10-28T00:00:00.000Z',
    updated_at: '2026-10-28T00:00:00.000Z',
    write_lock_enabled: false,
    parent_agent_id: null,
    parent_goal: null,
    verifier: null,
    tools: [],
    ...overrides,
  };
}

function finalAnswer(id: string, text: string, timestamp: string): Message {
  return {
    message_id: id,
    timestamp,
    role: 'TOOL',
    text,
    metadata: {
      toolCallId: `call-${id}`,
      toolName: 'send_message_to_user',
      toolStatus: 'FINISHED',
      title: 'FYI for User',
      isUserAttentionMessage: true,
      attentionMessage: text,
    },
  };
}

function mockSession() {
  localStorage.setItem(
    'rose-session',
    JSON.stringify({
      access_token: 'test-token',
      refresh_token: 'test-refresh',
      expires_in: 3600,
      expires_at: Math.floor(Date.now() / 1000) + 3600,
      token_type: 'bearer',
      user: { id: 'test-user', is_anonymous: false },
    }),
  );
}

async function renderChat(agent: AgentDetail, messages: Message[]): Promise<AgentHandlers> {
  let handlers: AgentHandlers | undefined;
  vi.mocked(RealtimeMod.subscribeToAgent).mockImplementation(async (_agentId, callbacks) => {
    handlers = callbacks;
    return { state: 'joined', topic: `agent:${AGENT_ID}` } as never;
  });
  server.use(
    http.get(`${API_BASE}/agents/${AGENT_ID}`, () =>
      HttpResponse.json({
        agent,
        messages,
        pagination: { has_more: false, oldest_timestamp: null },
      }),
    ),
  );
  render(
    <AgentProvider user={{ id: 'test-user' }} isAuthenticated realtimeReady onLoadAgents={vi.fn()}>
      <TooltipProvider>
        <MessageList />
      </TooltipProvider>
    </AgentProvider>,
  );
  await waitFor(() => expect(handlers).toBeDefined());
  await screen.findByText(messages[messages.length - 1].text);
  return handlers!;
}

/** The exact realtime frames one backend chat turn emits for a follow-up. */
function emitChatTurn(handlers: AgentHandlers, turn: string, extra: () => void = () => {}) {
  act(() => {
    handlers.onInsert?.({
      agentId: AGENT_ID,
      id: `${turn}-user`,
      timestamp: '2026-10-28T00:10:00.000Z',
      text: 'now also check pricing',
      role: 'USER',
    });
    extra();
    handlers.onAssistantStream?.({
      agentId: AGENT_ID,
      stream_id: `${turn}-gen`,
      sequence: 0,
      delta: '',
      done: false,
    });
    handlers.onAssistantStream?.({
      agentId: AGENT_ID,
      stream_id: `${turn}-gen`,
      sequence: 1,
      delta: 'Pricing is public for two of them.',
      done: false,
    });
    handlers.onAssistantStream?.({
      agentId: AGENT_ID,
      stream_id: `${turn}-gen`,
      sequence: 2,
      delta: '',
      done: true,
    });
    handlers.onInsert?.({
      agentId: AGENT_ID,
      id: `${turn}-reasoning`,
      timestamp: '2026-10-28T00:10:02.000Z',
      text: 'Pricing is public for two of them.',
      role: 'ASSISTANT',
      metadata: { streamId: `${turn}-gen` },
    });
    const answer = finalAnswer(
      `${turn}-answer`,
      'Vanta and Drata publish pricing.',
      '2026-10-28T00:10:03.000Z',
    );
    handlers.onInsert?.({
      agentId: AGENT_ID,
      id: answer.message_id,
      timestamp: answer.timestamp,
      text: answer.text,
      role: 'TOOL',
      metadata: answer.metadata,
    });
  });
}

describe('chat-mode Start agent button', () => {
  beforeEach(() => {
    localStorage.clear();
    mockSession();
    window.history.replaceState({}, '', `/?agent-id=${AGENT_ID}`);
    vi.mocked(RealtimeMod.subscribeToAgent).mockReset();
    vi.mocked(RealtimeMod.unsubscribe).mockReset();
  });

  it('shows after a follow-up chat answer on a finished run once the reactivation UPDATE arrives', async () => {
    // A completed run: chat mode is restored, the row still names the old workflow.
    const handlers = await renderChat(
      makeAgent({ status: 'COMPLETED', temporal_workflow_id: 'wf-first-run' }),
      [
        {
          message_id: 'goal',
          timestamp: '2026-10-28T00:00:00.000Z',
          role: 'USER',
          text: 'compare SOC 2 platforms',
        },
        finalAnswer('run-done', 'Here is the comparison.', '2026-10-28T00:05:00.000Z'),
      ],
    );
    expect(screen.queryByRole('button', { name: /Start agent/ })).toBeNull();

    // POST /messages reactivated the row for chat (status ACTIVE, workflow cleared).
    emitChatTurn(handlers, 'turn-2', () =>
      handlers.onUpdate?.({ agentId: AGENT_ID, status: 'ACTIVE', temporalWorkflowId: null }),
    );

    expect(await screen.findByRole('button', { name: /Start agent/ })).toBeEnabled();
  });

  it('acknowledges a click at once and never POSTs start-agent twice', async () => {
    let releaseStart!: () => void;
    const startCanFinish = new Promise<void>((resolve) => {
      releaseStart = resolve;
    });
    const startRequests: string[] = [];
    server.use(
      http.post(`${API_BASE}/agents/${AGENT_ID}/start-agent`, async ({ request }) => {
        startRequests.push(request.url);
        await startCanFinish;
        return HttpResponse.json({ success: true, agent_id: AGENT_ID, workflow_id: 'wf-new' });
      }),
    );
    const handlers = await renderChat(makeAgent({ status: 'ACTIVE' }), [
      {
        message_id: 'goal',
        timestamp: '2026-10-28T00:00:00.000Z',
        role: 'USER',
        text: 'compare SOC 2 platforms',
      },
      finalAnswer('answer-1', 'Here is a quick comparison.', '2026-10-28T00:00:03.000Z'),
    ]);
    const user = userEvent.setup();
    const button = await screen.findByRole('button', { name: /Start agent/ });

    await user.click(button);
    // Temporal has not accepted the workflow yet: the click is acknowledged now.
    const pending = screen.getByRole('button', { name: /Starting agent/ });
    expect(pending).toBeDisabled();
    await user.click(pending);
    await waitFor(() => expect(startRequests).toHaveLength(1));

    releaseStart();
    act(() => handlers.onAgentModeStarted?.({ agentId: AGENT_ID }));
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: /Start(ing)? agent/ })).toBeNull(),
    );
    expect(startRequests).toHaveLength(1);
  });

  it('leaves the starting state from the detail snapshot when AGENT_MODE_STARTED is lost', async () => {
    const answer = finalAnswer(
      'answer-1',
      'Here is a quick comparison.',
      '2026-10-28T00:00:03.000Z',
    );
    await renderChat(makeAgent({ status: 'ACTIVE' }), [answer]);
    server.use(
      http.post(`${API_BASE}/agents/${AGENT_ID}/start-agent`, () =>
        HttpResponse.json({ success: true, agent_id: AGENT_ID, workflow_id: 'wf-new' }),
      ),
      http.get(`${API_BASE}/agents/${AGENT_ID}`, () =>
        HttpResponse.json({
          agent: makeAgent({ status: 'ACTIVE', temporal_workflow_id: 'wf-new' }),
          messages: [answer],
          pagination: { has_more: false, oldest_timestamp: null },
        }),
      ),
    );
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: /Start agent/ }));
    // No realtime frame is delivered: the POST's own outcome must end chat mode.
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: /Start(ing)? agent/ })).toBeNull(),
    );
  });

  it('re-enables the button when starting fails', async () => {
    server.use(
      http.post(`${API_BASE}/agents/${AGENT_ID}/start-agent`, () =>
        HttpResponse.json({ error: 'Agent has no verifier configured' }, { status: 400 }),
      ),
    );
    await renderChat(makeAgent({ status: 'ACTIVE' }), [
      finalAnswer('answer-1', 'Here is a quick comparison.', '2026-10-28T00:00:03.000Z'),
    ]);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: /Start agent/ }));
    await waitFor(() => expect(screen.getByRole('button', { name: /Start agent/ })).toBeEnabled());
  });
});
