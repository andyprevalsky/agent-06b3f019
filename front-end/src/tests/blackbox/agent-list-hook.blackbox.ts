/**
 * Blackbox tests for the terminal agent-list request lifecycle.
 */
import { act, renderHook, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { useAgentList } from '@/features/terminal/hooks/useAgentList';

import { capturedRequests, clearCaptures } from './msw/capture';
import { server } from './msw/server';

const API_BASE = 'http://localhost:3001/api';

function mockSession(): void {
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

describe('useAgentList', () => {
  beforeEach(() => {
    clearCaptures();
  });

  afterEach(() => {
    localStorage.clear();
  });

  it('stays idle when auth prevents an agent-list request', async () => {
    const { result } = renderHook(() => useAgentList(false));

    await act(async () => {
      await Promise.resolve();
    });

    expect(result.current.isLoadingAgents).toBe(false);
    expect(capturedRequests.some((request) => request.url.endsWith('/api/agents'))).toBe(false);
  });

  it('is loading only while the agent-list request is active', async () => {
    mockSession();
    let finishRequest: (() => void) | undefined;
    server.use(
      http.get(`${API_BASE}/agents`, async () => {
        await new Promise<void>((resolve) => {
          finishRequest = resolve;
        });
        return HttpResponse.json({ agents: [] });
      }),
    );

    const { result } = renderHook(() => useAgentList(true));

    await waitFor(() => {
      expect(result.current.isLoadingAgents).toBe(true);
      expect(finishRequest).toBeDefined();
    });

    act(() => finishRequest?.());

    await waitFor(() => {
      expect(result.current.isLoadingAgents).toBe(false);
    });
  });
});
