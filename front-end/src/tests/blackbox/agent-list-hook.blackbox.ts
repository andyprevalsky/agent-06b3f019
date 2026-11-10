/**
 * Blackbox tests for the terminal agent-list request lifecycle.
 */
import { act, renderHook, waitFor } from '@testing-library/react';
import { StrictMode } from 'react';
import { http, HttpResponse } from 'msw';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useAgentList } from '@/features/terminal/hooks/useAgentList';
import { AGENT_POLL_INTERVAL_MS } from '@/features/terminal/config';

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
    vi.useRealTimers();
    vi.restoreAllMocks();
    localStorage.clear();
  });

  it('aborts an agent-list download when its view unmounts', async () => {
    mockSession();
    let signal: AbortSignal | null | undefined;
    vi.spyOn(globalThis, 'fetch').mockImplementation((_input, init) => {
      signal = init?.signal;
      return new Promise((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), {
          once: true,
        });
      });
    });
    const { unmount } = renderHook(() => useAgentList(true));
    unmount();
    expect(signal?.aborted).toBe(true);
    await act(async () => {});
  });

  it('suspends list polling while hidden and refreshes immediately when visible', async () => {
    mockSession();
    vi.useFakeTimers();
    const visibility = vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async () => new Response(JSON.stringify({ agents: [] })));
    const { unmount } = renderHook(() => useAgentList(true));
    try {
      await act(async () => {});
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      visibility.mockReturnValue(true);
      await act(async () => vi.advanceTimersByTimeAsync(AGENT_POLL_INTERVAL_MS * 3));
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      visibility.mockReturnValue(false);
      await act(async () => document.dispatchEvent(new Event('visibilitychange')));
      expect(fetchSpy).toHaveBeenCalledTimes(2);
    } finally {
      unmount();
    }
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

  it('reports hasLoadedAgents once the first load settles and keeps it through later polls', async () => {
    mockSession();
    const finishRequests: Array<() => void> = [];
    server.use(
      http.get(`${API_BASE}/agents`, async () => {
        await new Promise<void>((resolve) => finishRequests.push(resolve));
        return HttpResponse.json({ agents: [] });
      }),
    );

    const { result } = renderHook(() => useAgentList(false));
    expect(result.current.hasLoadedAgents).toBe(false);
    let load: Promise<void> | undefined;
    act(() => {
      load = result.current.loadAgents();
    });
    await waitFor(() => expect(finishRequests).toHaveLength(1));
    expect(result.current.hasLoadedAgents).toBe(false);
    finishRequests[0]();
    await act(async () => load);
    expect(result.current.hasLoadedAgents).toBe(true);

    act(() => {
      load = result.current.loadAgents();
    });
    await waitFor(() => expect(result.current.isLoadingAgents).toBe(true));
    expect(result.current.hasLoadedAgents).toBe(true);
    finishRequests[1]();
    await act(async () => load);
  });

  it('ending the session drops in-flight results, clears agents and resets hasLoadedAgents', async () => {
    mockSession();
    const finishRequests: Array<(agentId: string) => void> = [];
    server.use(
      http.get(
        `${API_BASE}/agents`,
        () =>
          new Promise((resolve) => {
            finishRequests.push((agentId) =>
              resolve(HttpResponse.json({ agents: [{ agent_id: agentId }] })),
            );
          }),
      ),
    );

    const { result, rerender } = renderHook(({ canLoad }) => useAgentList(canLoad), {
      initialProps: { canLoad: true },
    });
    await waitFor(() => expect(finishRequests).toHaveLength(1));
    act(() => finishRequests[0]('first-account-agent'));
    await waitFor(() => expect(result.current.hasLoadedAgents).toBe(true));

    let pending: Promise<void> | undefined;
    act(() => {
      pending = result.current.loadAgents();
    });
    await waitFor(() => expect(finishRequests).toHaveLength(2));
    rerender({ canLoad: false });
    expect(result.current.agents).toEqual([]);
    expect(result.current.hasLoadedAgents).toBe(false);

    finishRequests[1]('stale-agent');
    await act(async () => pending);
    expect(result.current.agents).toEqual([]);
    expect(result.current.hasLoadedAgents).toBe(false);
  });

  it('stays loading until every overlapping request settles', async () => {
    mockSession();
    const finishRequests: Array<() => void> = [];
    server.use(
      http.get(`${API_BASE}/agents`, async () => {
        await new Promise<void>((resolve) => finishRequests.push(resolve));
        return HttpResponse.json({ agents: [] });
      }),
    );

    const { result } = renderHook(() => useAgentList(false));
    let firstLoad: Promise<void> | undefined;
    let secondLoad: Promise<void> | undefined;
    act(() => {
      firstLoad = result.current.loadAgents();
      secondLoad = result.current.loadAgents();
    });

    await waitFor(() => {
      expect(finishRequests).toHaveLength(2);
      expect(result.current.isLoadingAgents).toBe(true);
    });

    finishRequests[0]();
    await act(async () => firstLoad);
    expect(result.current.isLoadingAgents).toBe(true);

    finishRequests[1]();
    await act(async () => secondLoad);
    expect(result.current.isLoadingAgents).toBe(false);
  });

  it('does not let an older overlapping response replace newer agent data', async () => {
    mockSession();
    const finishRequests: Array<(agentId: string) => void> = [];
    server.use(
      http.get(
        `${API_BASE}/agents`,
        () =>
          new Promise((resolve) => {
            finishRequests.push((agentId) =>
              resolve(HttpResponse.json({ agents: [{ agent_id: agentId }] })),
            );
          }),
      ),
    );

    const { result } = renderHook(() => useAgentList(false));
    let firstLoad: Promise<void> | undefined;
    let secondLoad: Promise<void> | undefined;
    act(() => {
      firstLoad = result.current.loadAgents();
      secondLoad = result.current.loadAgents();
    });

    await waitFor(() => expect(finishRequests).toHaveLength(2));
    finishRequests[1]('newer-agent');
    await act(async () => secondLoad);
    expect(result.current.agents[0]?.agent_id).toBe('newer-agent');

    finishRequests[0]('older-agent');
    await act(async () => firstLoad);
    expect(result.current.agents[0]?.agent_id).toBe('newer-agent');
  });
});

it('StrictMode list replay aborts old ownership and ignores its late response', async () => {
  mockSession();
  const requests: Array<{
    signal: AbortSignal | null | undefined;
    resolve: (r: Response) => void;
  }> = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(
    (_input, init) => new Promise((resolve) => requests.push({ signal: init?.signal, resolve })),
  );
  const { result, unmount } = renderHook(() => useAgentList(true), { wrapper: StrictMode });
  try {
    expect(requests).toHaveLength(2);
    expect(requests[0].signal?.aborted).toBe(true);
    expect(requests[1].signal?.aborted).toBe(false);
    await act(async () =>
      requests[1].resolve(new Response(JSON.stringify({ agents: [{ agent_id: 'current' }] }))),
    );
    expect(result.current.agents[0]?.agent_id).toBe('current');
    await act(async () =>
      requests[0].resolve(new Response(JSON.stringify({ agents: [{ agent_id: 'stale' }] }))),
    );
    expect(result.current.agents[0]?.agent_id).toBe('current');
    expect(result.current.isLoadingAgents).toBe(false);
  } finally {
    unmount();
  }
});
