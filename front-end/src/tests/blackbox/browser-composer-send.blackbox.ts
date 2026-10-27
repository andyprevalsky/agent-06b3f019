/**
 * Browser-composer sends (useMessageSending with a browser task target): the
 * message goes straight to that browser task. It is never captured as the
 * owner's answer to a pending question, and it never claims to resume a
 * paused owner (only a message to the agent itself lifts its pause).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { server } from './msw/server';
import { clearCaptures, capturedRequests } from './msw/capture';
import {
  makeTerminalHookAgent as makeAgent,
  mockTerminalHookSession as mockSession,
} from './terminal-hooks.fixtures';

const toast = vi.hoisted(() => vi.fn());
vi.mock('@/hooks/use-toast', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/hooks/use-toast')>()),
  useToast: () => ({ toast, dismiss: vi.fn(), toasts: [] }),
}));
vi.mock('@/features/auth', () => ({
  useAuth: () => ({
    user: { id: 'u-1', phone: '+19999999999', is_anonymous: false },
    session: { access_token: 't' },
    isAuthenticated: true,
    isAnonymous: false,
    isFullySignedIn: true,
    loading: false,
    realtimeReady: true,
  }),
}));

import { useMessageSending } from '@/features/terminal/hooks/useMessageSending';

const API_BASE = 'http://localhost:3001/api';

function args(status: 'ACTIVE' | 'PAUSED') {
  return {
    selectedAgentId: 'agent-001',
    agentDetail: makeAgent({ status }),
    canSubmitGoals: true,
    isFullySignedIn: true,
    clientSource: 'WEB',
    setSelectedAgentIdContext: vi.fn(),
    setCurrentView: vi.fn(),
    setLoginModalOpen: vi.fn(),
    setIsLoadingNetwork: vi.fn(),
    loadAgents: vi.fn(async () => {}),
    stagePendingAgentCreation: vi.fn(),
    reconcilePendingAgentCreation: vi.fn(async () => {}),
    rollbackPendingAgentCreation: vi.fn(() => true),
  };
}

describe('Browser-composer send', () => {
  beforeEach(() => {
    mockSession();
    clearCaptures();
    toast.mockClear();
    server.use(
      // The paused owner has a pending question: a normal send would answer it.
      http.get(`${API_BASE}/attention-requests`, () =>
        HttpResponse.json({ requests: [{ id: 'att-1', agent_id: 'agent-001', answered: false }] }),
      ),
      http.post(`${API_BASE}/agents/:agentId/messages`, () =>
        HttpResponse.json({ message_id: 'm1', timestamp: '2026-10-26T16:00:00Z', role: 'USER' }),
      ),
    );
  });

  it('goes to its browser task, never answers or resumes the paused owner', async () => {
    const { result } = renderHook(() => useMessageSending(args('PAUSED') as never));
    act(() => result.current.setMessageInput('go to instacart instead'));
    await act(async () => {
      await result.current.handleSendMessage(undefined, { browserTaskId: 'browser-task' });
    });
    const post = capturedRequests.find((r) => r.method === 'POST' && r.url.includes('/messages'));
    expect(post?.body).toEqual({
      message: 'go to instacart instead',
      browser_task_id: 'browser-task',
    });
    expect(capturedRequests.some((r) => r.url.includes('/attention-requests'))).toBe(false);
    expect(toast).not.toHaveBeenCalledWith(expect.objectContaining({ title: 'Agent resuming' }));
    expect(result.current.messageInput).toBe('');
  });

  it('keeps the browser target when the send is replayed after login', async () => {
    const signedOut = { ...args('ACTIVE'), canSubmitGoals: false, isFullySignedIn: false };
    const { result, rerender } = renderHook((props) => useMessageSending(props as never), {
      initialProps: signedOut,
    });
    act(() => result.current.setMessageInput('go to instacart instead'));
    await act(async () => {
      await result.current.handleSendMessage(undefined, { browserTaskId: 'browser-task' });
    });
    expect(signedOut.setLoginModalOpen).toHaveBeenCalledWith(true);
    expect(capturedRequests.some((r) => r.url.includes('/messages'))).toBe(false);
    rerender({ ...signedOut, canSubmitGoals: true, isFullySignedIn: true });
    await waitFor(() =>
      expect(
        capturedRequests.find((r) => r.method === 'POST' && r.url.includes('/messages'))?.body,
      ).toEqual({ message: 'go to instacart instead', browser_task_id: 'browser-task' }),
    );
  });

  it('a message to the paused owner itself still answers its question', async () => {
    const { result } = renderHook(() => useMessageSending(args('PAUSED') as never));
    act(() => result.current.setMessageInput('yes, continue'));
    await act(async () => {
      await result.current.handleSendMessage();
    });
    expect(capturedRequests.some((r) => r.url.includes('/attention-requests'))).toBe(true);
  });
});
