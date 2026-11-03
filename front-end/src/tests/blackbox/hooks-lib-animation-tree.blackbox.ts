import { act, renderHook, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { server } from './msw/server';

vi.mock('@/lib/realtime', async (importOriginal) => {
  const mod = await importOriginal<typeof import('@/lib/realtime')>();
  return {
    ...mod,
    subscribeToBus: vi.fn(),
    subscribeToAgent: vi.fn(),
    unsubscribe: vi.fn(),
  };
});

import { useTickerCarousel } from '@/features/terminal/hooks/useTickerCarousel';
import { useTileAnimation } from '@/features/terminal/hooks/useTileAnimation';
import {
  filterTreeBySpawn,
  getCircleState,
  getStatusText,
  type TreeNode,
  useAgentTree,
} from '@/hooks/useAgentTree';
import * as RealtimeMod from '@/lib/realtime';
import { countParentReads } from './terminal-component-chips.fixtures';

const API_BASE = 'http://localhost:3001/api';

function mockSession() {
  const session = {
    access_token:
      'eyJhbGciOiJIUzI1NiJ9.' +
      btoa(JSON.stringify({ sub: 'user-12345678', role: 'authenticated' })) +
      '.signature-signature-signature',
    refresh_token: 'test-refresh',
    expires_in: 3600,
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    token_type: 'bearer',
    user: { id: 'user-12345678', is_anonymous: false },
  };
  localStorage.setItem('rose-session', JSON.stringify(session));
  return session;
}

function fakeChannel(state: 'joined' | 'closed' | 'errored' = 'joined') {
  return {
    state,
    topic: 'test',
  } as unknown as import('@supabase/supabase-js').RealtimeChannel;
}

describe('useTickerCarousel', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    Reflect.deleteProperty(window, 'api');
  });

  it('starts the popular-goals requestAnimationFrame loop in Electron', () => {
    Object.defineProperty(window, 'api', {
      value: {},
      configurable: true,
    });
    const requestAnimationFrameSpy = vi
      .spyOn(window, 'requestAnimationFrame')
      .mockImplementation(() => 1);

    renderHook(() => useTickerCarousel(null));

    expect(requestAnimationFrameSpy).toHaveBeenCalledTimes(1);
  });

  it('starts the popular-goals requestAnimationFrame loop on web when no agent is selected', () => {
    const requestAnimationFrameSpy = vi
      .spyOn(window, 'requestAnimationFrame')
      .mockImplementation(() => 1);

    renderHook(() => useTickerCarousel(null));

    expect(requestAnimationFrameSpy).toHaveBeenCalledTimes(1);
  });
});

describe('useTileAnimation', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    Reflect.deleteProperty(window, 'api');
  });

  it('starts incomplete and schedules tile animation timers in Electron', () => {
    Object.defineProperty(window, 'api', {
      value: {},
      configurable: true,
    });
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');

    const { result } = renderHook(() => useTileAnimation());

    expect(result.current.animationComplete).toBe(false);
    expect(setIntervalSpy).not.toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// useAgentTree.ts  (hook + pure helpers)
// ═══════════════════════════════════════════════════════════════════════════

describe('useAgentTree helpers', () => {
  describe('getCircleState', () => {
    const mk = (o: Partial<TreeNode>): TreeNode => ({
      agentId: 'a',
      parentAgentId: null,
      goal: '',
      status: 'ACTIVE' as const,
      progress: 0,
      toolsInUse: [],
      messageCount: 0,
      costCents: 0,
      ...o,
    });

    it('returns ● when COMPLETED', () =>
      expect(getCircleState(mk({ status: 'COMPLETED' }))).toBe('●'));
    it('returns ✗ when FAILED', () => expect(getCircleState(mk({ status: 'FAILED' }))).toBe('✗'));
    it('returns ⊘ when OUT_OF_CREDITS', () =>
      expect(getCircleState(mk({ status: 'OUT_OF_CREDITS' }))).toBe('⊘'));
    it('returns ◎ when COST_LIMIT_REACHED', () =>
      expect(getCircleState(mk({ status: 'COST_LIMIT_REACHED' }))).toBe('◎'));
    it('returns ◕ when progress >= 0.7', () =>
      expect(getCircleState(mk({ progress: 0.8 }))).toBe('◕'));
    it('returns ◔ when 0 < progress < 0.3', () =>
      expect(getCircleState(mk({ progress: 0.1 }))).toBe('◔'));
    it('returns ◑ when messageCount > 0 and progress === 0', () =>
      expect(getCircleState(mk({ messageCount: 5, progress: 0 }))).toBe('◑'));
    it('returns ○ default', () => expect(getCircleState(mk({}))).toBe('○'));
  });

  describe('getStatusText', () => {
    const mk = (o: Partial<TreeNode>): TreeNode => ({
      agentId: 'a',
      parentAgentId: null,
      goal: '',
      status: 'ACTIVE' as const,
      progress: 0,
      toolsInUse: [],
      messageCount: 1,
      costCents: 0,
      ...o,
    });
    it('empty for COMPLETED', () => expect(getStatusText(mk({ status: 'COMPLETED' }))).toBe(''));
    it('failed text', () => expect(getStatusText(mk({ status: 'FAILED' }))).toBe('failed'));
    it('paused text', () => expect(getStatusText(mk({ status: 'PAUSED' }))).toBe('paused'));
    it('out of credits', () =>
      expect(getStatusText(mk({ status: 'OUT_OF_CREDITS' }))).toBe('out of credits'));
    it('cost limit reached', () =>
      expect(getStatusText(mk({ status: 'COST_LIMIT_REACHED' }))).toBe('cost limit reached'));
    it('STARTING_UP → spinning up...', () =>
      expect(getStatusText(mk({ status: 'STARTING_UP' }))).toBe('spinning up...'));
    it('spinning up when no messages', () =>
      expect(getStatusText(mk({ messageCount: 0 }))).toBe('spinning up...'));
    it('thinking when no tools', () => expect(getStatusText(mk({}))).toBe('thinking...'));
    it('single tool shows tool name', () =>
      expect(getStatusText(mk({ toolsInUse: ['web_search'] }))).toBe('web_search'));
    it('multi-tool shows count', () =>
      expect(getStatusText(mk({ toolsInUse: ['a', 'b', 'c'] }))).toBe('Using 3 tools'));
  });

  describe('filterTreeBySpawn', () => {
    it('returns descendants of the subAgent ids', () => {
      const all = new Map<string, TreeNode>();
      all.set('root', { agentId: 'root', parentAgentId: null } as never);
      all.set('a', { agentId: 'a', parentAgentId: 'root' } as never);
      all.set('b', { agentId: 'b', parentAgentId: 'a' } as never);
      all.set('c', { agentId: 'c', parentAgentId: 'unrelated' } as never);
      const out = filterTreeBySpawn(all, ['a']);
      expect(Array.from(out.keys()).sort()).toEqual(['a', 'b']);
    });
    it('returns empty when ids are absent', () => {
      expect(filterTreeBySpawn(new Map(), ['missing']).size).toBe(0);
    });
    it('scans the whole tree once, however large the spawned subtree is', () => {
      const all = new Map<string, TreeNode>();
      const add = (agentId: string, parentAgentId: string | null) =>
        all.set(agentId, { agentId, parentAgentId } as never);
      add('root', null);
      add('a', 'root');
      const kids = Array.from({ length: 200 }, (_, i) => `a-${i}`);
      const grandkids = kids.slice(0, 100).map((id) => `${id}-x`);
      kids.forEach((id) => add(id, 'a'));
      grandkids.forEach((id, i) => add(id, kids[i]));
      for (let i = 0; i < 99; i += 1) add(`u-${i}`, 'unrelated');
      const counter = countParentReads(all.values());
      const out = filterTreeBySpawn(all, ['a', 'missing']);
      expect(Array.from(out.keys())).toEqual(['a', ...kids, ...grandkids]);
      expect(counter.reads).toBeLessThanOrEqual(all.size);
    });
  });

  describe('hook behaviour', () => {
    beforeEach(() => {
      // Ensure we start fresh; clear any prior mocks
      vi.mocked(RealtimeMod.subscribeToBus).mockReset();
      vi.mocked(RealtimeMod.unsubscribe).mockReset();
      mockSession();
      server.use(
        http.get(`${API_BASE}/agents/tree`, () =>
          HttpResponse.json({
            agents: [
              {
                agent_id: 'root',
                parent_agent_id: null,
                goal: 'root goal',
                status: 'ACTIVE',
                progress: 0.5,
                tools_in_use: ['web_search'],
                message_count: 3,
                tree_cost_cents: 12,
              },
            ],
          }),
        ),
      );
    });
    afterEach(() => {
      localStorage.clear();
    });

    it('returns empty map when busId is null', () => {
      const { result, rerender } = renderHook(() => useAgentTree(null));
      const emptyTree = result.current;
      expect(result.current.size).toBe(0);
      rerender();
      expect(result.current).toBe(emptyTree);
      expect(() => (result.current as Map<string, TreeNode>).set('leak', {} as TreeNode)).toThrow(
        'The shared empty agent tree is read-only',
      );
      expect(result.current.size).toBe(0);
    });

    it('populates nodes from initial fetch and applies AGENT_STATE_CHANGED updates', async () => {
      let handlers: Parameters<typeof RealtimeMod.subscribeToBus>[1] = {};
      vi.mocked(RealtimeMod.subscribeToBus).mockImplementation(async (_busId, h) => {
        handlers = h;
        return fakeChannel('joined');
      });

      const { result, unmount } = renderHook(() => useAgentTree('bus-1'));

      await waitFor(() => {
        expect(result.current.get('root')?.goal).toBe('root goal');
      });

      // Now deliver a realtime update
      await act(async () => {
        handlers.onAgentStateChanged?.({
          agentId: 'child',
          parentAgentId: 'root',
          goal: 'child goal',
          status: 'ACTIVE',
          progress: 0.9,
          toolsInUse: [],
          messageCount: 1,
          costCents: 5,
        });
      });

      await waitFor(() => {
        expect(result.current.get('child')?.goal).toBe('child goal');
      });

      unmount();
      // unsubscribe should run on last listener cleanup
      expect(vi.mocked(RealtimeMod.unsubscribe)).toHaveBeenCalled();
    });

    it('returns no previous-bus nodes during an agent-tree switch', async () => {
      server.use(
        http.get(`${API_BASE}/agents/tree`, ({ request }) => {
          const busId = new URL(request.url).searchParams.get('busId');
          return HttpResponse.json({
            agents: [
              {
                agent_id: `root-${busId}`,
                parent_agent_id: null,
                goal: `goal for ${busId}`,
                status: 'ACTIVE',
                progress: 0.5,
                tools_in_use: [],
                message_count: 1,
                tree_cost_cents: 0,
              },
            ],
          });
        }),
      );
      vi.mocked(RealtimeMod.subscribeToBus).mockResolvedValue(fakeChannel('joined'));
      const initialProps = { busId: 'agent-a' as string | null };
      const { result, rerender, unmount } = renderHook(
        (props: typeof initialProps) => useAgentTree(props.busId),
        { initialProps },
      );
      await waitFor(() => expect(result.current.has('root-agent-a')).toBe(true));

      rerender({ busId: 'agent-b' });

      expect(result.current.has('root-agent-a')).toBe(false);
      await waitFor(() => expect(result.current.has('root-agent-b')).toBe(true));
      unmount();
    });

    it('starts the new bus while the previous subscription is still resolving', async () => {
      let finishAgentASubscription!: (channel: ReturnType<typeof fakeChannel>) => void;
      vi.mocked(RealtimeMod.subscribeToBus).mockImplementation((busId) => {
        if (busId === 'agent-a') {
          return new Promise((resolve) => {
            finishAgentASubscription = resolve;
          });
        }
        return Promise.resolve(fakeChannel('joined'));
      });
      const initialProps = { busId: 'agent-a' as string | null };
      const { rerender, unmount } = renderHook(
        (props: typeof initialProps) => useAgentTree(props.busId),
        { initialProps },
      );
      rerender({ busId: 'agent-b' });

      await waitFor(() =>
        expect(vi.mocked(RealtimeMod.subscribeToBus).mock.calls.map(([busId]) => busId)).toContain(
          'agent-b',
        ),
      );
      const staleChannel = fakeChannel('joined');
      await act(async () => {
        finishAgentASubscription(staleChannel);
        await Promise.resolve();
      });
      expect(RealtimeMod.unsubscribe).toHaveBeenCalledWith(staleChannel);
      unmount();
    });

    it('keeps one shared channel alive when its creating consumer unmounts', async () => {
      let handlers: Parameters<typeof RealtimeMod.subscribeToBus>[1] = {};
      vi.mocked(RealtimeMod.subscribeToBus).mockImplementation(async (_busId, nextHandlers) => {
        handlers = nextHandlers;
        return fakeChannel('joined');
      });
      const creator = renderHook(() => useAgentTree('shared-bus'));
      const survivor = renderHook(() => useAgentTree('shared-bus'));
      await waitFor(() => expect(survivor.result.current.has('root')).toBe(true));
      expect(RealtimeMod.subscribeToBus).toHaveBeenCalledTimes(1);
      vi.mocked(RealtimeMod.unsubscribe).mockClear();

      creator.unmount();
      expect(RealtimeMod.unsubscribe).not.toHaveBeenCalled();
      act(() => {
        handlers.onAgentStateChanged?.({
          agentId: 'survivor-child',
          parentAgentId: 'root',
          goal: 'delivered to survivor',
          status: 'ACTIVE',
          progress: 0.5,
          toolsInUse: [],
          messageCount: 1,
          costCents: 0,
        });
      });

      expect(survivor.result.current.get('survivor-child')?.goal).toBe('delivered to survivor');
      let reconnect!: () => void;
      const staleHandlers = handlers;
      const timeoutSpy = vi.spyOn(window, 'setTimeout').mockImplementation(((
        callback: TimerHandler,
      ) => {
        reconnect = callback as () => void;
        return 1;
      }) as typeof window.setTimeout);
      handlers.onDisconnect?.();
      reconnect();
      timeoutSpy.mockRestore();
      expect(RealtimeMod.subscribeToBus).toHaveBeenCalledTimes(2);
      await act(async () => {
        await Promise.resolve();
      });
      const discardSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      for (let index = 0; index < 10_000; index += 1) {
        staleHandlers.onAgentStateChanged?.({ agentId: `stale-${index}` } as never);
      }
      expect(
        discardSpy.mock.calls.filter(
          ([message]) => message === 'Agent scope: discarded stale work',
        ),
      ).toHaveLength(1);
      discardSpy.mockRestore();
      survivor.unmount();
    });

    it('hands pending fetch and channel ownership to a surviving same-bus consumer', async () => {
      let finishFetch!: () => void;
      const fetchCanFinish = new Promise<void>((resolve) => {
        finishFetch = resolve;
      });
      server.use(
        http.get(`${API_BASE}/agents/tree`, async () => {
          await fetchCanFinish;
          return HttpResponse.json({
            agents: [
              {
                agent_id: 'pending-root',
                parent_agent_id: null,
                goal: 'pending root',
                status: 'ACTIVE',
                progress: 0,
                tools_in_use: [],
                message_count: 0,
                tree_cost_cents: 0,
              },
            ],
          });
        }),
      );
      let finishSubscription!: (channel: ReturnType<typeof fakeChannel>) => void;
      let handlers: Parameters<typeof RealtimeMod.subscribeToBus>[1] = {};
      vi.mocked(RealtimeMod.subscribeToBus).mockImplementation(
        (_busId, nextHandlers) =>
          new Promise((resolve) => {
            handlers = nextHandlers;
            finishSubscription = resolve;
          }),
      );
      const creator = renderHook(() => useAgentTree('pending-shared-bus'));
      const survivor = renderHook(() => useAgentTree('pending-shared-bus'));
      expect(RealtimeMod.subscribeToBus).toHaveBeenCalledTimes(1);

      creator.unmount();
      finishFetch();
      await act(async () => {
        finishSubscription(fakeChannel('joined'));
        await Promise.resolve();
      });
      await waitFor(() => expect(survivor.result.current.has('pending-root')).toBe(true));
      act(() => {
        handlers.onAgentStateChanged?.({
          agentId: 'pending-child',
          parentAgentId: 'pending-root',
          goal: 'still live',
          status: 'ACTIVE',
          progress: 0,
          toolsInUse: [],
          messageCount: 0,
          costCents: 0,
        });
      });
      expect(survivor.result.current.has('pending-child')).toBe(true);
      survivor.unmount();
    });

    it('gracefully handles AGENT_STATE_CHANGED payload missing agentId', async () => {
      let handlers: Parameters<typeof RealtimeMod.subscribeToBus>[1] = {};
      vi.mocked(RealtimeMod.subscribeToBus).mockImplementation(async (_busId, h) => {
        handlers = h;
        return fakeChannel('joined');
      });
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const { result, unmount } = renderHook(() => useAgentTree('bus-2'));

      await waitFor(() => expect(result.current.has('root')).toBe(true));

      act(() => {
        handlers.onAgentStateChanged?.({ agentId: '' } as never);
      });
      expect(warnSpy).toHaveBeenCalled();

      warnSpy.mockRestore();
      unmount();
    });

    it('logs error when subscribe rejects', async () => {
      vi.mocked(RealtimeMod.subscribeToBus).mockRejectedValueOnce(new Error('fail'));
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const { unmount } = renderHook(() => useAgentTree('bus-3'));

      await waitFor(() => {
        expect(errSpy).toHaveBeenCalled();
      });
      unmount();
      errSpy.mockRestore();
    });

    it('logs error when fetchTreeState rejects', async () => {
      server.use(
        http.get(`${API_BASE}/agents/tree`, () => new HttpResponse(null, { status: 500 })),
      );
      vi.mocked(RealtimeMod.subscribeToBus).mockResolvedValue(fakeChannel('joined'));
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      const { unmount } = renderHook(() => useAgentTree('bus-4'));
      await waitFor(() => {
        expect(errSpy).toHaveBeenCalled();
      });
      unmount();
      errSpy.mockRestore();
    });
  });
});
