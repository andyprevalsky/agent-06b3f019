/** Offline dispatch coverage; does not establish the cause of the live preview incident. */
import React from 'react';
import { it, expect } from 'vitest';
import { fireEvent, render, screen, waitFor, renderHook } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { server } from './msw/server';
import { makeCtx } from './browser-agent-chip.fixtures';
import { AgentContext } from '@/features/agent-context';
import { useAgentProviderState } from '@/features/agent-context/hooks/useAgentProviderState';
import { useAgentMessaging } from '@/features/agent-context/hooks/useAgentMessaging';
import { MessageList } from '@/features/terminal-component-group/components/MessageList';
import type { Message } from '@/lib/api';
import captured from './fixtures/start-autonomous-execution-2026-10-21.json';

it('dispatches Start Autonomous Execution through the real context and HTTP message path', async () => {
  // This session exists only in jsdom. MSW owns the HTTP boundary.
  localStorage.setItem(
    'rose-session',
    JSON.stringify({
      access_token: 'offline-test-token',
      expires_at: Math.floor(Date.now() / 1000) + 3600,
      user: { id: 'offline-user', is_anonymous: false },
    }),
  );
  const received: unknown[] = [];
  server.use(
    http.post('http://localhost:3001/api/agents/agent-1/messages', async ({ request }) => {
      received.push(await request.json());
      return HttpResponse.json(
        { message_id: 'reply', role: 'USER', text: 'sent' },
        { status: 201 },
      );
    }),
  );
  const { result } = renderHook(() => {
    const state = useAgentProviderState();
    state.selectedAgentIdRef.current = 'agent-1';
    return useAgentMessaging(state);
  });
  const [attention, finished] = captured as Message[];
  const ctx = { ...makeCtx([attention]), sendMessage: result.current.sendMessage };
  const view = render(
    <AgentContext.Provider value={ctx}>
      <MessageList />
    </AgentContext.Provider>,
  );
  fireEvent.click(await screen.findByRole('button', { name: 'Start Autonomous Execution' }));
  await waitFor(() =>
    expect(received).toEqual([
      {
        message:
          'Please do not ask me anymore questions. I trust your judgment, intuition, and ability to make reasonable assumptions. Please proceed to the Autonomous Execution phase.',
      },
    ]),
  );
  view.rerender(
    <AgentContext.Provider value={{ ...ctx, messages: [attention, finished] }}>
      <MessageList />
    </AgentContext.Provider>,
  );
  await waitFor(() =>
    expect(
      screen.queryByRole('button', { name: 'Start Autonomous Execution' }),
    ).not.toBeInTheDocument(),
  );
  expect(
    screen.queryByText('Your Rose agent will continue working after your reply'),
  ).not.toBeInTheDocument();
  localStorage.clear();
});

function renderWaitingAttention() {
  localStorage.setItem(
    'rose-session',
    JSON.stringify({
      access_token: 'offline-test-token',
      expires_at: Math.floor(Date.now() / 1000) + 3600,
      user: { id: 'offline-user', is_anonymous: false },
    }),
  );
  const { result } = renderHook(() => {
    const state = useAgentProviderState();
    state.selectedAgentIdRef.current = 'agent-1';
    return useAgentMessaging(state);
  });
  const ctx = { ...makeCtx([captured[0] as Message]), sendMessage: result.current.sendMessage };
  return render(
    <AgentContext.Provider value={ctx}>
      <MessageList />
    </AgentContext.Provider>,
  );
}

it('shows pending and acknowledgement and prevents duplicate requests while awaiting HTTP', async () => {
  let resolveRequest = () => {};
  const responseReady = new Promise<void>((resolve) => {
    resolveRequest = resolve;
  });
  let requests = 0;
  server.use(
    http.post('http://localhost:3001/api/agents/agent-1/messages', async () => {
      requests += 1;
      await responseReady;
      return HttpResponse.json(
        { message_id: 'reply', role: 'USER', text: 'sent' },
        { status: 201 },
      );
    }),
  );
  renderWaitingAttention();
  const button = await screen.findByRole('button', { name: 'Start Autonomous Execution' });
  fireEvent.click(button);
  try {
    await waitFor(() => expect(requests).toBe(1));
    expect(button).toBeDisabled();
    expect(screen.getByText('Sending request…')).toBeInTheDocument();
    fireEvent.click(button);
    expect(requests).toBe(1);
  } finally {
    resolveRequest();
  }
  await screen.findByText('Request sent');
  expect(button).toBeDisabled();
});

it('shows a failed HTTP submission and allows an explicit retry', async () => {
  server.use(
    http.post('http://localhost:3001/api/agents/agent-1/messages', () =>
      HttpResponse.json({ error: 'Message service unavailable' }, { status: 503 }),
    ),
  );
  renderWaitingAttention();
  fireEvent.click(await screen.findByRole('button', { name: 'Start Autonomous Execution' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Message service unavailable');
  const retry = screen.getByRole('button', { name: 'Start Autonomous Execution' });
  expect(retry).toBeEnabled();
  server.use(
    http.post('http://localhost:3001/api/agents/agent-1/messages', () =>
      HttpResponse.json({ message_id: 'retry', role: 'USER', text: 'sent' }, { status: 201 }),
    ),
  );
  fireEvent.click(retry);
  await screen.findByText('Request sent');
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
});
