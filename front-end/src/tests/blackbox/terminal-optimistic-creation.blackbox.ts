import { act, renderHook } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  useMessageSending,
  type UseMessageSendingArgs,
} from '@/features/terminal/hooks/useMessageSending';

import { server } from './msw/server';

const API_BASE = 'http://localhost:3001/api';

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
  localStorage.setItem('app-user', JSON.stringify({ id: 'test-user', is_anonymous: false }));
}

function makeArgs(overrides: Partial<UseMessageSendingArgs> = {}): UseMessageSendingArgs {
  return {
    selectedAgentId: null,
    agentDetail: null,
    canSubmitGoals: true,
    isFullySignedIn: true,
    clientSource: 'WEB',
    setCurrentView: vi.fn(),
    setLoginModalOpen: vi.fn(),
    setIsLoadingNetwork: vi.fn(),
    loadAgents: vi.fn(async () => {}),
    stagePendingAgentCreation: vi.fn(),
    reconcilePendingAgentCreation: vi.fn(async () => {}),
    rollbackPendingAgentCreation: vi.fn(() => true),
    ...overrides,
  };
}

describe('optimistic terminal agent creation', () => {
  beforeEach(mockSession);
  afterEach(() => localStorage.clear());

  it('projects the view and USER message before deferred POST resolution and sends a client UUID', async () => {
    let releaseResponse = () => {};
    let markRequestStarted = () => {};
    const responseGate = new Promise<void>((resolve) => {
      releaseResponse = resolve;
    });
    const requestStarted = new Promise<void>((resolve) => {
      markRequestStarted = resolve;
    });
    let postedAgentId = '';
    server.use(
      http.post(`${API_BASE}/agents`, async ({ request }) => {
        const body = (await request.json()) as { agent_id: string };
        postedAgentId = body.agent_id;
        markRequestStarted();
        await responseGate;
        return HttpResponse.json({ agent_id: postedAgentId });
      }),
    );
    const args = makeArgs();
    const { result } = renderHook(() => useMessageSending(args));
    act(() => result.current.setMessageInput('instant goal'));

    let sendPromise = Promise.resolve();
    act(() => {
      sendPromise = result.current.handleSendMessage();
    });
    await requestStarted;

    expect(args.setCurrentView).toHaveBeenCalledWith('agents');
    expect(args.stagePendingAgentCreation).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: postedAgentId, goal: 'instant goal' }),
    );
    expect(result.current.messageInput).toBe('');
    expect(args.reconcilePendingAgentCreation).not.toHaveBeenCalled();
    expect(args.loadAgents).not.toHaveBeenCalled();
    expect(postedAgentId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );

    releaseResponse();
    await act(async () => sendPromise);
    expect(args.reconcilePendingAgentCreation).toHaveBeenCalledWith(postedAgentId);
    expect(args.loadAgents).toHaveBeenCalled();
  });

  it('restores the goal on failure only when rollback owns the selected staged id', async () => {
    server.use(
      http.post(`${API_BASE}/agents`, () =>
        HttpResponse.json({ error: 'creation failed' }, { status: 500 }),
      ),
    );
    const owningArgs = makeArgs();
    const owning = renderHook(() => useMessageSending(owningArgs));
    act(() => owning.result.current.setMessageInput('retry me'));
    await act(async () => owning.result.current.handleSendMessage());
    expect(owning.result.current.messageInput).toBe('retry me');

    const departedArgs = makeArgs({ rollbackPendingAgentCreation: vi.fn(() => false) });
    const departed = renderHook(() => useMessageSending(departedArgs));
    act(() => departed.result.current.setMessageInput('do not resurrect'));
    await act(async () => departed.result.current.handleSendMessage());
    expect(departed.result.current.messageInput).toBe('');
  });

  it('a new agent started from a project sends project_id once; Home goals omit it', async () => {
    const bodies: Record<string, unknown>[] = [];
    server.use(
      http.post(`${API_BASE}/agents`, async ({ request }) => {
        const body = (await request.json()) as Record<string, unknown>;
        bodies.push(body);
        return HttpResponse.json({ agent_id: body.agent_id });
      }),
    );
    const args = makeArgs();
    const { result } = renderHook(() => useMessageSending(args));
    expect(result.current.newAgentProjectId).toBeNull();

    act(() => result.current.setNewAgentProjectId('p-rose'));
    act(() => result.current.setMessageInput('in a project'));
    await act(async () => result.current.handleSendMessage());
    expect(bodies[0]).toEqual(
      expect.objectContaining({ goal: 'in a project', project_id: 'p-rose' }),
    );
    // Consumed by the created agent: the next new agent goes to Home.
    expect(result.current.newAgentProjectId).toBeNull();

    act(() => result.current.setMessageInput('at home'));
    await act(async () => result.current.handleSendMessage());
    expect(bodies[1]).toEqual(expect.objectContaining({ goal: 'at home' }));
    expect(bodies[1]).not.toHaveProperty('project_id');
  });

  it('a failed project create keeps the project for the retry', async () => {
    server.use(
      http.post(`${API_BASE}/agents`, () =>
        HttpResponse.json({ error: 'creation failed' }, { status: 500 }),
      ),
    );
    const args = makeArgs();
    const { result } = renderHook(() => useMessageSending(args));
    act(() => result.current.setNewAgentProjectId('p-rose'));
    act(() => result.current.setMessageInput('retry in project'));
    await act(async () => result.current.handleSendMessage());
    expect(result.current.newAgentProjectId).toBe('p-rose');
  });
});
