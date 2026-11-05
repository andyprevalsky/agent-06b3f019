import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useAgentList } from '@/features/terminal/hooks/useAgentList';
import { AGENT_POLL_INTERVAL_MS } from '@/features/terminal/config';

const deadline = AGENT_POLL_INTERVAL_MS * 3;
function session() {
  localStorage.setItem(
    'rose-session',
    JSON.stringify({
      access_token: 'token',
      expires_at: Date.now() / 1000 + 3600,
      user: { id: 'owner', is_anonymous: false },
    }),
  );
}

describe('agent-list request deadlines', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    localStorage.clear();
  });
  it.each([false, true])(
    'retires a stalled read and permits visible refresh when transport ignores abort=%s',
    async (ignoreAbort) => {
      session();
      vi.useFakeTimers();
      vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
      let signal: AbortSignal | null | undefined;
      let finish: (response: Response) => void = () => {};
      const fetchSpy = vi
        .spyOn(globalThis, 'fetch')
        .mockImplementationOnce((_url, init) => {
          signal = init?.signal;
          return new Promise((resolve, reject) => {
            finish = resolve;
            if (!ignoreAbort)
              signal?.addEventListener(
                'abort',
                () => reject(new DOMException('Aborted', 'AbortError')),
                { once: true },
              );
          });
        })
        .mockImplementation(
          async () => new Response(JSON.stringify({ agents: [{ agent_id: 'recovered' }] })),
        );
      const { result, unmount } = renderHook(() => useAgentList(true));
      try {
        await act(async () => vi.advanceTimersByTimeAsync(deadline - 1));
        expect(fetchSpy).toHaveBeenCalledTimes(1);
        expect(signal?.aborted).toBe(false);
        await act(async () => vi.advanceTimersByTimeAsync(1));
        expect(signal?.aborted).toBe(true);
        await act(async () => document.dispatchEvent(new Event('visibilitychange')));
        expect(fetchSpy.mock.calls.length).toBeGreaterThan(1);
        expect(result.current.agents[0]?.agent_id).toBe('recovered');
        await act(async () =>
          finish(new Response(JSON.stringify({ agents: [{ agent_id: 'retired' }] }))),
        );
        expect(result.current.agents.some((a) => a.agent_id === 'retired')).toBe(false);
        expect(result.current.agents[0]?.agent_id).toBe('recovered');
        expect(result.current.isLoadingAgents).toBe(false);
      } finally {
        unmount();
      }
      expect(vi.getTimerCount()).toBe(0);
    },
  );
  it('clears the deadline when a normal read succeeds and on owner exit', async () => {
    session();
    vi.useFakeTimers();
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async () => new Response(JSON.stringify({ agents: [] })));
    const { unmount } = renderHook(() => useAgentList(true));
    await act(async () => {});
    expect(fetchSpy).toHaveBeenCalledOnce();
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});
