/**
 * Idle polls must not re-render the app when nothing changed.
 *
 * Evidence (heavy-account mobile profile, prod API, 174 agents, iPhone
 * viewport, 4x CPU throttle): every 10s agent-list poll committed twice
 * (isLoadingAgents true -> false, plus a fresh array of 174 new agent objects)
 * and each commit re-rendered ~446 components from TerminalContent down. Every
 * 10s attention-request poll replaced the list with an identical new array and
 * re-rendered ~386 components under AttentionRequestsProvider. Attention polls
 * also kept downloading while the page was hidden.
 *
 * These tests mount each hook in an owner component with a plain child (the
 * stand-in for that subtree) and count child renders across idle polls that
 * return the same data. React may re-run the owner once before bailing out on
 * unchanged state; the subtree must not render.
 */
import { createElement } from 'react';
import { act, render, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { useAgentList } from '@/features/terminal/hooks/useAgentList';
import { AGENT_POLL_INTERVAL_MS } from '@/features/terminal/config';
import { useAttentionRequests } from '@/features/terminal-component-group/components/attention-inbox/useAttentionRequests';

const ATTENTION_POLL_MS = 10_000;

function seedSession(): void {
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

function agentRow(id: string, status = 'COMPLETED') {
  return {
    agent_id: id,
    goal: `goal ${id}`,
    status,
    created_at: '2026-11-01T00:00:00.000Z',
    updated_at: '2026-11-01T00:00:00.000Z',
  };
}

function attentionRow(id: string) {
  return {
    id,
    agent_id: 'agent-1',
    workflow_id: 'wf-1',
    question: `question ${id}`,
    created_at: '2026-11-01T00:00:00.000Z',
    updated_at: '2026-11-01T00:00:00.000Z',
    answered: false,
  };
}

/** Serve `body()` as JSON for every fetch, counting requests per path. */
function serveJson(body: (url: string) => unknown) {
  const calls: string[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    calls.push(url);
    return new Response(JSON.stringify(body(url)), {
      headers: { 'Content-Type': 'application/json' },
    });
  });
  return calls;
}

/** Mount `useHook` in an owner whose plain child counts subtree renders. */
function renderWithSubtree<T>(useHook: () => T) {
  const result: { current: T | null } = { current: null };
  const counts = { subtree: 0 };
  function Subtree(_props: { value: T }) {
    counts.subtree += 1;
    return null;
  }
  function Owner() {
    const value = useHook();
    result.current = value;
    return createElement(Subtree, { value });
  }
  const view = render(createElement(Owner));
  return { result: result as { current: T }, counts, unmount: view.unmount };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  localStorage.clear();
});

describe('agent-list idle polls', () => {
  it('an unchanged poll of a loaded list neither re-renders the subtree nor replaces agent objects', async () => {
    seedSession();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    let rows = [agentRow('a1'), agentRow('a2', 'RUNNING')];
    const calls = serveJson(() => ({ agents: rows }));
    const { result, counts, unmount } = renderWithSubtree(() => useAgentList(true));
    try {
      await act(async () => {});
      await act(async () => {});
      expect(result.current.agents.map((agent) => agent.agent_id)).toEqual(['a1', 'a2']);
      expect(result.current.hasLoadedAgents).toBe(true);
      const loaded = result.current.agents;
      const rendersAfterLoad = counts.subtree;

      await act(async () => vi.advanceTimersByTimeAsync(AGENT_POLL_INTERVAL_MS * 3));
      expect(calls.filter((url) => url.includes('/agents')).length).toBe(4);
      expect(counts.subtree).toBe(rendersAfterLoad);
      expect(result.current.agents).toBe(loaded);
      expect(result.current.isLoadingAgents).toBe(false);

      // A real change still lands, and only the changed row gets a new object.
      rows = [
        agentRow('a1'),
        { ...agentRow('a2', 'COMPLETED'), updated_at: '2026-11-02T00:00:00.000Z' },
      ];
      await act(async () => vi.advanceTimersByTimeAsync(AGENT_POLL_INTERVAL_MS));
      expect(result.current.agents[1]?.status).toBe('COMPLETED');
      expect(result.current.agents[0]).toBe(loaded[0]);
      expect(result.current.agents[1]).not.toBe(loaded[1]);
    } finally {
      unmount();
    }
  });

  it('polls of an empty list keep reporting isLoadingAgents (the empty-list spinner)', async () => {
    seedSession();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    const pending: Array<() => void> = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      () =>
        new Promise<Response>((resolve) => {
          pending.push(() => resolve(new Response(JSON.stringify({ agents: [] }))));
        }),
    );
    const { result, unmount } = renderHook(() => useAgentList(true));
    try {
      await act(async () => {});
      await act(async () => pending.shift()?.());
      await act(async () => {});
      expect(result.current.hasLoadedAgents).toBe(true);
      expect(result.current.isLoadingAgents).toBe(false);

      await act(async () => vi.advanceTimersByTimeAsync(AGENT_POLL_INTERVAL_MS));
      expect(pending).toHaveLength(1);
      expect(result.current.isLoadingAgents).toBe(true);
      await act(async () => pending.shift()?.());
      await act(async () => {});
      expect(result.current.isLoadingAgents).toBe(false);
    } finally {
      unmount();
    }
  });
});

describe('attention-request idle polls', () => {
  it('an unchanged poll keeps the same list without re-rendering the subtree', async () => {
    seedSession();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    let rows = [attentionRow('r1'), attentionRow('r2')];
    serveJson(() => ({ requests: rows }));
    const { result, counts, unmount } = renderWithSubtree(() => useAttentionRequests(false));
    try {
      await act(async () => {});
      await act(async () => {});
      expect(result.current.requests.map((request) => request.id)).toEqual(['r1', 'r2']);
      const loaded = result.current.requests;
      const rendersAfterLoad = counts.subtree;

      await act(async () => vi.advanceTimersByTimeAsync(ATTENTION_POLL_MS * 3));
      expect(counts.subtree).toBe(rendersAfterLoad);
      expect(result.current.requests).toBe(loaded);

      rows = [attentionRow('r1')];
      await act(async () => vi.advanceTimersByTimeAsync(ATTENTION_POLL_MS));
      expect(result.current.requests.map((request) => request.id)).toEqual(['r1']);
    } finally {
      unmount();
    }
  });

  it('pauses polling while hidden and refetches as soon as the page is visible', async () => {
    seedSession();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    const visibility = vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
    const calls = serveJson(() => ({ requests: [attentionRow('r1')] }));
    const attentionCalls = () => calls.filter((url) => url.includes('/attention-requests')).length;
    const { unmount } = renderHook(() => useAttentionRequests(false));
    try {
      await act(async () => {});
      expect(attentionCalls()).toBe(1);

      visibility.mockReturnValue(true);
      await act(async () => document.dispatchEvent(new Event('visibilitychange')));
      await act(async () => vi.advanceTimersByTimeAsync(ATTENTION_POLL_MS * 3));
      expect(attentionCalls()).toBe(1);

      visibility.mockReturnValue(false);
      await act(async () => document.dispatchEvent(new Event('visibilitychange')));
      expect(attentionCalls()).toBe(2);
      await act(async () => vi.advanceTimersByTimeAsync(ATTENTION_POLL_MS));
      expect(attentionCalls()).toBe(3);
    } finally {
      unmount();
    }
  });
});
