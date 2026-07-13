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
      const { result } = renderHook(() => useAgentTree(null));
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
