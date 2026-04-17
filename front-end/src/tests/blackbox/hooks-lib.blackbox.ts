/**
 * Blackbox tests covering hook + lib modules that don't easily fit other
 * blackbox suites. Targets:
 *   - src/features/terminal/hooks/derivations.ts  (pure helpers)
 *   - src/hooks/useAgentTree.ts                   (tree state + helpers)
 *   - src/lib/supabase.ts                         (session helpers)
 *   - src/lib/realtime.ts                         (channel subscription)
 *   - src/features/agent-context/hooks/realtimeHandlers.ts
 *   - src/features/agent-context/hooks/useRealtimeSubscription.ts
 *   - src/features/terminal/hooks/useTerminalMessages.ts
 *   - src/features/settings/hooks/usePayment.ts   (payment form state)
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';

import { server } from './msw/server';

// Derivations (pure)
import {
  getModelContextWindow,
  getContextPercentage,
  deduplicateToolMessages,
  sortAgents,
  computeActiveBrowserPanels,
  derivePendingApproval,
  deriveHasActiveAttentionRequest,
} from '@/features/terminal/hooks/derivations';

// useAgentTree (mock realtime)
// NOTE: vi.mock calls are hoisted — imports below are real. Tests that rely
// on the mock use `vi.mocked(...)` after the hoist.
vi.mock('@/lib/realtime', async (importOriginal) => {
  const mod = await importOriginal<typeof import('@/lib/realtime')>();
  return {
    ...mod,
    subscribeToBus: vi.fn(),
    subscribeToAgent: vi.fn(),
    unsubscribe: vi.fn(),
  };
});

import { useAgentTree, filterTreeBySpawn, getCircleState, getStatusText } from '@/hooks/useAgentTree';

// Realtime handler pure functions
import {
  handleInsertMessage,
  handleUpdateAgent,
  handleAssistantStream,
  handlePlanStream,
  handleAttentionStream,
  handleToolStream,
  cleanupSubscription,
} from '@/features/agent-context/hooks/realtimeHandlers';

// useRealtimeSubscription
import { useRealtimeSubscription } from '@/features/agent-context/hooks/useRealtimeSubscription';

// useTerminalMessages
import { useTerminalMessages } from '@/features/terminal/hooks/useTerminalMessages';

// usePayment
import { usePayment } from '@/features/settings/hooks/usePayment';

// Supabase helpers
import {
  supabase,
  getSession,
  storeSession,
  clearSession,
  hasSession,
  getCachedUser,
  persistCachedUser,
  createAnonymousSession,
  signOut,
  setRealtimeAuth,
  isRealtimeReady,
  initializeRealtime,
  isAnonymousUser,
  getStoredSession,
  clearStoredSession,
} from '@/lib/supabase';

// Realtime subscribe helpers (original mod for direct calls)
import * as RealtimeMod from '@/lib/realtime';

const API_BASE = 'http://localhost:3001/api';

// ═══════════════════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════════════════

function mockSession() {
  const session = {
    access_token:
      // deliberately >50 chars and JWT-ish shape so identifyToken path works
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
    // minimal surface used by health check; other props unused in tests
  } as unknown as import('@supabase/supabase-js').RealtimeChannel;
}

// ═══════════════════════════════════════════════════════════════════════════
// derivations.ts
// ═══════════════════════════════════════════════════════════════════════════

describe('derivations.ts', () => {
  describe('getModelContextWindow', () => {
    it('returns contextLength when model is found', () => {
      const models = [{ id: 'abc', contextLength: 50000 } as any];
      expect(getModelContextWindow('abc', models)).toBe(50000);
    });
    it('falls back to default when model missing', () => {
      expect(getModelContextWindow('missing', [])).toBe(100000);
    });
    it('falls back to default when model has no contextLength', () => {
      const models = [{ id: 'abc' } as any];
      expect(getModelContextWindow('abc', models)).toBe(100000);
    });
  });

  describe('getContextPercentage', () => {
    it('computes percentage relative to 80% of max window', () => {
      const agent = { model: 'm', context_size: 40000 } as any;
      const models = [{ id: 'm', contextLength: 100000 } as any];
      // 80% threshold = 80000 → 40000/80000 = 50
      expect(getContextPercentage(agent, models)).toBe(50);
    });
    it('caps at 100 when context exceeds threshold', () => {
      const agent = { model: 'm', context_size: 999999 } as any;
      const models = [{ id: 'm', contextLength: 100000 } as any];
      expect(getContextPercentage(agent, models)).toBe(100);
    });
  });

  describe('deduplicateToolMessages', () => {
    const ts = (n: number) => new Date(1_700_000_000_000 + n * 1000).toISOString();
    it('passes through non-tool messages untouched', () => {
      const msgs = [
        { message_id: '1', role: 'USER', timestamp: ts(2), text: 'hi', metadata: {} },
        { message_id: '2', role: 'ASSISTANT', timestamp: ts(1), text: 'hey', metadata: {} },
      ] as any;
      const out = deduplicateToolMessages(msgs);
      expect(out).toHaveLength(2);
      // sorted ascending by timestamp
      expect(out[0].message_id).toBe('2');
    });

    it('dedups TOOL messages sharing toolCallId, keeping most recent and preserving first timestamp', () => {
      const msgs = [
        {
          message_id: 'a',
          role: 'TOOL',
          timestamp: ts(1),
          text: 'first',
          metadata: { toolCallId: 'tc1', toolStatus: 'IN_PROGRESS' },
        },
        {
          message_id: 'b',
          role: 'TOOL',
          timestamp: ts(5),
          text: 'later',
          metadata: { toolCallId: 'tc1', toolStatus: 'FINISHED' },
        },
      ] as any;
      const out = deduplicateToolMessages(msgs);
      expect(out).toHaveLength(1);
      expect(out[0].text).toBe('later');
      // firstTimestamp is kept
      expect(out[0].timestamp).toBe(ts(1));
    });

    it('attention messages preserve earlier message_id when dedup', () => {
      const msgs = [
        {
          message_id: 'original',
          role: 'TOOL',
          timestamp: ts(1),
          text: 'x',
          metadata: { toolCallId: 'tc1' },
        },
        {
          message_id: 'newer',
          role: 'TOOL',
          timestamp: ts(2),
          text: 'y',
          metadata: { toolCallId: 'tc1', isUserAttentionMessage: true },
        },
      ] as any;
      const out = deduplicateToolMessages(msgs);
      expect(out).toHaveLength(1);
      // attention path takes newer content but keeps existing message_id
      expect(out[0].message_id).toBe('original');
    });

    it('tool message missing toolCallId is pushed through as non-tool', () => {
      const msgs = [
        { message_id: 'x', role: 'TOOL', timestamp: ts(1), text: 'no-id', metadata: {} },
      ] as any;
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const out = deduplicateToolMessages(msgs);
      expect(out).toHaveLength(1);
      errSpy.mockRestore();
    });
  });

  describe('sortAgents', () => {
    const mk = (id: string, status: string, progress = 0) =>
      ({ agent_id: id, status, progress }) as any;

    it('puts COMPLETED agents last', () => {
      const out = sortAgents([mk('done', 'COMPLETED'), mk('active', 'ACTIVE')]);
      expect(out.map((a) => a.agent_id)).toEqual(['active', 'done']);
    });
    it('puts paused statuses after active', () => {
      const out = sortAgents([mk('paused', 'PAUSED'), mk('active', 'ACTIVE')]);
      expect(out.map((a) => a.agent_id)).toEqual(['active', 'paused']);
    });
    it('within same bucket, sorts by progress descending', () => {
      const out = sortAgents([mk('low', 'ACTIVE', 0.1), mk('high', 'ACTIVE', 0.9)]);
      expect(out.map((a) => a.agent_id)).toEqual(['high', 'low']);
    });
  });

  describe('computeActiveBrowserPanels', () => {
    it('returns panel for active browser tasks only', () => {
      const msgs = [
        {
          metadata: {
            task_id: 't1',
            toolName: 'spawn_browser_agent',
            action_type: 'system',
            browser_url: 'https://e.com',
          },
        },
      ] as any;
      const panels = computeActiveBrowserPanels(msgs);
      expect(panels).toEqual([{ taskId: 't1', browserUrl: 'https://e.com' }]);
    });
    it('excludes completed tasks', () => {
      const msgs = [
        {
          metadata: {
            task_id: 't1',
            toolName: 'spawn_browser_agent',
            action_type: 'system',
            browser_url: 'x',
          },
        },
        { metadata: { task_id: 't1', action_type: 'task_complete' } },
      ] as any;
      expect(computeActiveBrowserPanels(msgs)).toEqual([]);
    });
    it('returns empty when no browser messages', () => {
      expect(computeActiveBrowserPanels([])).toEqual([]);
    });
  });

  describe('derivePendingApproval / deriveHasActiveAttentionRequest', () => {
    const base = {
      message_id: 'a',
      role: 'TOOL',
      text: 'Approve?',
      timestamp: new Date().toISOString(),
    };

    it('returns null when no attention message present', () => {
      expect(derivePendingApproval([])).toBeNull();
      expect(deriveHasActiveAttentionRequest([])).toBe(false);
    });

    it('returns approval object when toolApproval IN_PROGRESS', () => {
      const msgs = [
        {
          ...base,
          metadata: {
            isUserAttentionMessage: true,
            toolCallId: 'tc1',
            toolStatus: 'IN_PROGRESS',
            requestUserApproval: { toolApproval: true, attentionRequestId: 'req-1' },
            imageUrl: 'https://img',
          },
        },
      ] as any;
      const result = derivePendingApproval(msgs);
      expect(result).toEqual({
        attentionRequestId: 'req-1',
        question: 'Approve?',
        imageUrl: 'https://img',
      });
      expect(deriveHasActiveAttentionRequest(msgs)).toBe(true);
    });

    it('returns null when attentionRequestId is missing', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const msgs = [
        {
          ...base,
          metadata: {
            isUserAttentionMessage: true,
            toolCallId: 'tc1',
            toolStatus: 'IN_PROGRESS',
            requestUserApproval: { toolApproval: true },
          },
        },
      ] as any;
      expect(derivePendingApproval(msgs)).toBeNull();
      warnSpy.mockRestore();
    });

    it('ignores messages lacking toolCallId on attention lookup', () => {
      const msgs = [
        {
          ...base,
          metadata: { isUserAttentionMessage: true, toolStatus: 'IN_PROGRESS' },
        },
      ] as any;
      expect(derivePendingApproval(msgs)).toBeNull();
      expect(deriveHasActiveAttentionRequest(msgs)).toBe(false);
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// useAgentTree.ts  (hook + pure helpers)
// ═══════════════════════════════════════════════════════════════════════════

describe('useAgentTree helpers', () => {
  describe('getCircleState', () => {
    const mk = (o: any) => ({
      agentId: 'a',
      parentAgentId: null,
      goal: '',
      status: 'ACTIVE',
      progress: 0,
      toolsInUse: [],
      messageCount: 0,
      costCents: 0,
      ...o,
    });

    it('returns ● when COMPLETED', () =>
      expect(getCircleState(mk({ status: 'COMPLETED' }))).toBe('●'));
    it('returns ✗ when FAILED', () =>
      expect(getCircleState(mk({ status: 'FAILED' }))).toBe('✗'));
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
    const mk = (o: any) => ({
      agentId: 'a',
      parentAgentId: null,
      goal: '',
      status: 'ACTIVE',
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
      const all = new Map<string, any>();
      all.set('root', { agentId: 'root', parentAgentId: null });
      all.set('a', { agentId: 'a', parentAgentId: 'root' });
      all.set('b', { agentId: 'b', parentAgentId: 'a' });
      all.set('c', { agentId: 'c', parentAgentId: 'unrelated' });
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
      let handlers: any = null;
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
        handlers.onAgentStateChanged({
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
      let handlers: any = null;
      vi.mocked(RealtimeMod.subscribeToBus).mockImplementation(async (_busId, h) => {
        handlers = h;
        return fakeChannel('joined');
      });
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const { result, unmount } = renderHook(() => useAgentTree('bus-2'));

      await waitFor(() => expect(result.current.has('root')).toBe(true));

      act(() => {
        handlers.onAgentStateChanged({ agentId: '' } as any);
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

// ═══════════════════════════════════════════════════════════════════════════
// realtimeHandlers.ts (pure-ish, use React setState dispatchers)
// ═══════════════════════════════════════════════════════════════════════════

describe('realtimeHandlers', () => {
  function mkSetters() {
    const state = {
      streamingBubbles: new Map(),
      streamingPlan: null as any,
      streamingAttention: null as any,
      streamingTools: new Map(),
      messages: [] as any[],
      agent: null as any,
      isChatMode: false,
    };
    return {
      state,
      setStreamingBubbles: (fn: any) => {
        state.streamingBubbles =
          typeof fn === 'function' ? fn(state.streamingBubbles) : fn;
      },
      setStreamingPlan: (fn: any) => {
        state.streamingPlan = typeof fn === 'function' ? fn(state.streamingPlan) : fn;
      },
      setStreamingAttention: (fn: any) => {
        state.streamingAttention =
          typeof fn === 'function' ? fn(state.streamingAttention) : fn;
      },
      setStreamingTools: (fn: any) => {
        state.streamingTools = typeof fn === 'function' ? fn(state.streamingTools) : fn;
      },
      setMessages: (fn: any) => {
        state.messages = typeof fn === 'function' ? fn(state.messages) : fn;
      },
      setAgent: (fn: any) => {
        state.agent = typeof fn === 'function' ? fn(state.agent) : fn;
      },
      setIsChatMode: (fn: any) => {
        state.isChatMode = typeof fn === 'function' ? fn(state.isChatMode) : fn;
      },
      dispatchMessage: vi.fn(),
    };
  }

  it('handleInsertMessage: ignores wrong agentId', () => {
    const s = mkSetters();
    handleInsertMessage({ agentId: 'other', id: 'm' } as any, 'me', s as any);
    expect(s.state.messages).toEqual([]);
  });

  it('handleInsertMessage: appends a USER message and dispatches', () => {
    const s = mkSetters();
    handleInsertMessage(
      {
        agentId: 'me',
        id: 'm1',
        timestamp: 't',
        text: 'hi',
        role: 'USER',
        metadata: null,
      } as any,
      'me',
      s as any,
    );
    expect(s.state.messages).toHaveLength(1);
    expect(s.dispatchMessage).toHaveBeenCalledTimes(1);
  });

  it('handleInsertMessage: clears streamingPlan on set_plan FINISHED and streamingTools on toolCallId', () => {
    const s = mkSetters();
    s.state.streamingPlan = { stream_id: 'x' } as any;
    s.state.streamingTools.set('tc1', { tool_name: 'foo' } as any);
    handleInsertMessage(
      {
        agentId: 'me',
        id: 'm1',
        timestamp: 't',
        text: '',
        role: 'TOOL',
        metadata: { toolName: 'set_plan', toolStatus: 'FINISHED', toolCallId: 'tc1' },
      } as any,
      'me',
      s as any,
    );
    expect(s.state.streamingPlan).toBeNull();
    expect(s.state.streamingTools.has('tc1')).toBe(false);
  });

  it('handleInsertMessage: dedup by existing message_id', () => {
    const s = mkSetters();
    s.state.messages = [{ message_id: 'dup' } as any];
    handleInsertMessage(
      { agentId: 'me', id: 'dup', timestamp: 't', text: '', role: 'USER' } as any,
      'me',
      s as any,
    );
    expect(s.state.messages).toHaveLength(1);
  });

  it('handleInsertMessage: ASSISTANT message cleans streaming bubble of same subAgentId', () => {
    const s = mkSetters();
    s.state.streamingBubbles.set('streamA', {
      text: 'x',
      sequence: 1,
      done: false,
      subAgentId: 'sub1',
    });
    handleInsertMessage(
      {
        agentId: 'me',
        id: 'm1',
        timestamp: 't',
        text: 'assistant',
        role: 'ASSISTANT',
        metadata: { subAgentId: 'sub1' },
      } as any,
      'me',
      s as any,
    );
    expect(s.state.streamingBubbles.size).toBe(0);
  });

  it('handleUpdateAgent: merges partial updates and toggles chat mode', () => {
    const s = mkSetters();
    s.state.agent = {
      progress: 0,
      status: 'ACTIVE',
      temporal_workflow_id: 'wf-old',
    } as any;
    const onLoad = vi.fn();
    handleUpdateAgent(
      {
        progress: 0.5,
        status: 'COMPLETED',
        temporalWorkflowId: null,
      } as any,
      s.setAgent as any,
      s.setIsChatMode as any,
      onLoad,
    );
    expect(s.state.agent.progress).toBe(0.5);
    expect(s.state.agent.status).toBe('COMPLETED');
    expect(s.state.isChatMode).toBe(true);
    expect(onLoad).toHaveBeenCalled();
  });

  it('handleUpdateAgent: no-ops when prev is null', () => {
    const s = mkSetters();
    handleUpdateAgent({} as any, s.setAgent as any, s.setIsChatMode as any);
    expect(s.state.agent).toBeNull();
  });

  it('handleAssistantStream: ignores wrong agentId', () => {
    const s = mkSetters();
    handleAssistantStream(
      { agentId: 'other', stream_id: 'x', sequence: 0, delta: 'd', done: false } as any,
      'me',
      { current: new Set<string>() },
      s.setStreamingBubbles as any,
    );
    expect(s.state.streamingBubbles.size).toBe(0);
  });

  it('handleAssistantStream: accumulates text and records stream on done', () => {
    const s = mkSetters();
    const refSet = new Set<string>();
    const ref = { current: refSet };
    // First chunk
    handleAssistantStream(
      {
        agentId: 'me',
        stream_id: 's1',
        sequence: 0,
        delta: 'Hello ',
        done: false,
      } as any,
      'me',
      ref,
      s.setStreamingBubbles as any,
    );
    // Second chunk marks done
    handleAssistantStream(
      {
        agentId: 'me',
        stream_id: 's1',
        sequence: 1,
        delta: 'World',
        done: true,
      } as any,
      'me',
      ref,
      s.setStreamingBubbles as any,
    );
    const bubble = s.state.streamingBubbles.get('s1');
    expect(bubble?.text).toBe('Hello World');
    expect(bubble?.done).toBe(true);
    expect(refSet.has('Hello World')).toBe(true);
  });

  it('handlePlanStream: stores plan for correct agent', () => {
    const s = mkSetters();
    handlePlanStream(
      {
        agentId: 'me',
        stream_id: 's1',
        tool_call_id: 'tc1',
        title: 'Plan',
        char_count: 10,
      } as any,
      'me',
      s.setStreamingPlan as any,
    );
    expect(s.state.streamingPlan).toMatchObject({ title: 'Plan', char_count: 10 });
  });

  it('handlePlanStream: ignores wrong agent', () => {
    const s = mkSetters();
    handlePlanStream(
      { agentId: 'other', stream_id: 's1', tool_call_id: 'tc1', title: 'x' } as any,
      'me',
      s.setStreamingPlan as any,
    );
    expect(s.state.streamingPlan).toBeNull();
  });

  it('handleAttentionStream: stores and ignores wrong agent', () => {
    const s = mkSetters();
    handleAttentionStream(
      {
        agentId: 'other',
        stream_id: 's',
        tool_call_id: 'tc',
        message: 'm',
      } as any,
      'me',
      s.setStreamingAttention as any,
    );
    expect(s.state.streamingAttention).toBeNull();
    handleAttentionStream(
      {
        agentId: 'me',
        stream_id: 's',
        tool_call_id: 'tc',
        message: 'hi',
      } as any,
      'me',
      s.setStreamingAttention as any,
    );
    expect(s.state.streamingAttention?.message).toBe('hi');
  });

  it('handleToolStream: adds to map and ignores wrong agent', () => {
    const s = mkSetters();
    handleToolStream(
      {
        agentId: 'other',
        stream_id: 's1',
        tool_call_id: 'tc1',
        tool_name: 'foo',
        title: 't',
      } as any,
      'me',
      s.setStreamingTools as any,
    );
    expect(s.state.streamingTools.size).toBe(0);
    handleToolStream(
      {
        agentId: 'me',
        stream_id: 's1',
        tool_call_id: 'tc1',
        tool_name: 'foo',
        title: 't',
      } as any,
      'me',
      s.setStreamingTools as any,
    );
    expect(s.state.streamingTools.get('tc1')?.tool_name).toBe('foo');
  });

  it('cleanupSubscription: resets refs and clears bubbles', () => {
    const s = mkSetters();
    s.state.streamingBubbles.set('x', { text: '', sequence: 0, done: false, timeoutId: 999 });
    s.state.streamingPlan = { stream_id: 'p' } as any;
    s.state.streamingAttention = { stream_id: 'a' } as any;
    const isReconnectingRef = { current: true };
    const reconnectTimeoutRef: { current: number | null } = { current: 123 };
    const channelRef: { current: any } = { current: fakeChannel() };
    const clearSpy = vi.spyOn(global, 'clearTimeout');
    cleanupSubscription(
      isReconnectingRef,
      reconnectTimeoutRef,
      channelRef,
      s.setStreamingBubbles as any,
      s.setStreamingPlan as any,
      s.setStreamingAttention as any,
    );
    expect(isReconnectingRef.current).toBe(false);
    expect(reconnectTimeoutRef.current).toBeNull();
    expect(channelRef.current).toBeNull();
    expect(s.state.streamingBubbles.size).toBe(0);
    expect(s.state.streamingPlan).toBeNull();
    expect(s.state.streamingAttention).toBeNull();
    clearSpy.mockRestore();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// useRealtimeSubscription.ts
// ═══════════════════════════════════════════════════════════════════════════

describe('useRealtimeSubscription', () => {
  function makeDeps(overrides: Partial<any> = {}) {
    const setters = {
      setStreamingBubbles: vi.fn(),
      setStreamingPlan: vi.fn(),
      setStreamingAttention: vi.fn(),
      setStreamingTools: vi.fn(),
      setMessages: vi.fn(),
      setAgent: vi.fn(),
      setIsChatMode: vi.fn(),
      setForceResubscribeCounter: vi.fn(),
      dispatchMessage: vi.fn(),
    };
    const refs = {
      channelRef: { current: null as any },
      reconnectAttemptRef: { current: 0 },
      reconnectTimeoutRef: { current: null as number | null },
      isReconnectingRef: { current: false },
      initialLoadDoneRef: { current: null as string | null },
      streamedTextsRef: { current: new Set<string>() },
    };
    return {
      ...setters,
      ...refs,
      selectedAgentId: 'agent-1',
      canSubscribe: true,
      forceResubscribeCounter: 0,
      onLoadAgents: vi.fn(),
      ...overrides,
    };
  }

  beforeEach(() => {
    vi.mocked(RealtimeMod.subscribeToAgent).mockReset();
    vi.mocked(RealtimeMod.unsubscribe).mockReset();
  });

  it('no-ops and cleans up when selectedAgentId is null', () => {
    const deps = makeDeps({ selectedAgentId: null });
    const { unmount } = renderHook(() => useRealtimeSubscription(deps as any));
    expect(RealtimeMod.subscribeToAgent).not.toHaveBeenCalled();
    unmount();
  });

  it('no-ops when canSubscribe is false', () => {
    const deps = makeDeps({ canSubscribe: false });
    const { unmount } = renderHook(() => useRealtimeSubscription(deps as any));
    expect(RealtimeMod.subscribeToAgent).not.toHaveBeenCalled();
    unmount();
  });

  it('subscribes and attaches handlers; cleans up on unmount', async () => {
    let capturedHandlers: any;
    const channel = fakeChannel();
    vi.mocked(RealtimeMod.subscribeToAgent).mockImplementation(async (_, h) => {
      capturedHandlers = h;
      return channel;
    });
    const deps = makeDeps();
    const { unmount } = renderHook(() => useRealtimeSubscription(deps as any));

    await waitFor(() => expect(RealtimeMod.subscribeToAgent).toHaveBeenCalled());
    expect(deps.channelRef.current).toBe(channel);

    // Drive each handler branch once
    capturedHandlers.onInsert({
      agentId: 'agent-1',
      id: 'm',
      timestamp: 't',
      text: 'x',
      role: 'USER',
    });
    capturedHandlers.onUpdate({ progress: 0.5 });
    capturedHandlers.onAssistantStream({
      agentId: 'agent-1',
      stream_id: 's',
      sequence: 0,
      delta: 'x',
      done: false,
    });
    capturedHandlers.onPlanStream({
      agentId: 'agent-1',
      stream_id: 's',
      tool_call_id: 'tc',
      title: 't',
    });
    capturedHandlers.onAttentionStream({
      agentId: 'agent-1',
      stream_id: 's',
      tool_call_id: 'tc',
      message: 'm',
    });
    capturedHandlers.onToolStream({
      agentId: 'agent-1',
      stream_id: 's',
      tool_call_id: 'tc',
      tool_name: 'n',
      title: 't',
    });
    capturedHandlers.onAgentModeStarted({ agentId: 'agent-1' });
    // wrong agent onAgentModeStarted → should no-op
    capturedHandlers.onAgentModeStarted({ agentId: 'other' });

    expect(deps.setIsChatMode).toHaveBeenCalledWith(false);

    unmount();
    expect(RealtimeMod.unsubscribe).toHaveBeenCalled();
  });

  it('onDisconnect schedules a reconnect (increments attempt ref)', async () => {
    let capturedHandlers: any;
    vi.mocked(RealtimeMod.subscribeToAgent).mockImplementation(async (_, h) => {
      capturedHandlers = h;
      return fakeChannel();
    });
    const deps = makeDeps();
    renderHook(() => useRealtimeSubscription(deps as any));
    await waitFor(() => expect(capturedHandlers).toBeTruthy());

    const before = deps.reconnectAttemptRef.current;
    act(() => {
      capturedHandlers.onDisconnect();
    });
    expect(deps.reconnectAttemptRef.current).toBeGreaterThan(before);
  });

  it('on subscribe failure, logs error and schedules reconnect', async () => {
    vi.mocked(RealtimeMod.subscribeToAgent).mockRejectedValueOnce(new Error('boom'));
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const deps = makeDeps();
    renderHook(() => useRealtimeSubscription(deps as any));
    await waitFor(() => expect(errSpy).toHaveBeenCalled());
    expect(deps.reconnectAttemptRef.current).toBeGreaterThan(0);
    errSpy.mockRestore();
  });

  it('reconnection refetches agent detail and merges messages', async () => {
    server.use(
      http.get(`${API_BASE}/agents/agent-1`, () =>
        HttpResponse.json({
          agent: {
            agent_id: 'agent-1',
            goal: 'g',
            model: 'm',
            source: 'WEB',
            reasoning_effort: 'off',
            progress: 0.5,
            status: 'ACTIVE',
            status_message: null,
            temporal_workflow_id: 'wf',
            token_count: 0,
            tokens_in: 0,
            tokens_out: 0,
            tool_tokens_in: 0,
            tool_tokens_out: 0,
            tool_cost_cents: 0,
            context_size: 0,
            message_count: 0,
            price_limit_cents: 100,
            tree_cost_cents: 0,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
            write_lock_enabled: false,
            verifier: null,
            tools: [],
          },
          messages: [{ message_id: 'from-api', timestamp: 't', text: '', role: 'USER' }],
          pagination: { has_more: false, oldest_timestamp: null },
        }),
      ),
    );
    vi.mocked(RealtimeMod.subscribeToAgent).mockResolvedValue(fakeChannel());
    const deps = makeDeps({
      forceResubscribeCounter: 1,
      initialLoadDoneRef: { current: 'agent-1' },
    });
    mockSession();
    renderHook(() => useRealtimeSubscription(deps as any));
    await waitFor(() => expect(deps.setMessages).toHaveBeenCalled());
    // Re-fetch also triggers agent setter
    expect(deps.setAgent).toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// useTerminalMessages.ts
// ═══════════════════════════════════════════════════════════════════════════

describe('useTerminalMessages', () => {
  it('wires visibility + focus listeners, attached/detached around mount', () => {
    const addSpy = vi.spyOn(document, 'addEventListener');
    const removeSpy = vi.spyOn(document, 'removeEventListener');
    const winAddSpy = vi.spyOn(window, 'addEventListener');
    const winRemoveSpy = vi.spyOn(window, 'removeEventListener');
    const force = vi.fn();
    const { unmount } = renderHook(() => useTerminalMessages([], 'agent-1', force));
    expect(addSpy).toHaveBeenCalledWith('visibilitychange', expect.any(Function));
    expect(winAddSpy).toHaveBeenCalledWith('focus', expect.any(Function));
    unmount();
    expect(removeSpy).toHaveBeenCalledWith('visibilitychange', expect.any(Function));
    expect(winRemoveSpy).toHaveBeenCalledWith('focus', expect.any(Function));
    addSpy.mockRestore();
    removeSpy.mockRestore();
    winAddSpy.mockRestore();
    winRemoveSpy.mockRestore();
  });

  it('visibility change → forceResubscribe after timeout; focus → forceResubscribe after timeout', () => {
    vi.useFakeTimers();
    const force = vi.fn();
    renderHook(() => useTerminalMessages([], 'agent-1', force));
    // simulate becoming visible
    Object.defineProperty(document, 'hidden', { configurable: true, value: false });
    document.dispatchEvent(new Event('visibilitychange'));
    vi.advanceTimersByTime(1200);
    expect(force).toHaveBeenCalled();

    force.mockReset();
    window.dispatchEvent(new Event('focus'));
    vi.advanceTimersByTime(600);
    expect(force).toHaveBeenCalled();
    vi.useRealTimers();
  });

  it('markInitialLoad is stable across renders', () => {
    const { result, rerender } = renderHook(
      ({ m }: { m: any[] }) => useTerminalMessages(m, 'a', () => {}),
      { initialProps: { m: [] } },
    );
    const first = result.current.markInitialLoad;
    rerender({ m: [{ message_id: 'a', timestamp: 't', metadata: {} }] as any });
    expect(result.current.markInitialLoad).toBe(first);
  });

  it('auto-scroll path: exits early when last message is a browser_url', () => {
    // Build a DOM: viewport > endDiv ; the ref inherits the attachment via
    // .closest('[data-radix-scroll-area-viewport]').
    const viewport = document.createElement('div');
    viewport.setAttribute('data-radix-scroll-area-viewport', 'true');
    Object.defineProperty(viewport, 'scrollHeight', { configurable: true, value: 10000 });
    Object.defineProperty(viewport, 'clientHeight', { configurable: true, value: 500 });
    viewport.scrollTop = 0;
    const endDiv = document.createElement('div');
    viewport.appendChild(endDiv);
    document.body.appendChild(viewport);

    const { result, rerender } = renderHook(
      ({ m }: { m: any[] }) => useTerminalMessages(m, 'a', () => {}),
      { initialProps: { m: [] } },
    );
    // Attach ref to our DOM node
    (result.current.messagesEndRef as any).current = endDiv;

    // Last message has a browser_url → should early-return, no scroll
    rerender({ m: [{ metadata: { browser_url: 'https://x' } }] as any });
    expect(viewport.scrollTop).toBe(0);

    document.body.removeChild(viewport);
  });

  it('auto-scroll path: skips when task is still active', () => {
    const viewport = document.createElement('div');
    viewport.setAttribute('data-radix-scroll-area-viewport', 'true');
    Object.defineProperty(viewport, 'scrollHeight', { configurable: true, value: 10000 });
    Object.defineProperty(viewport, 'clientHeight', { configurable: true, value: 500 });
    viewport.scrollTop = 0;
    const endDiv = document.createElement('div');
    viewport.appendChild(endDiv);
    document.body.appendChild(viewport);

    const { result, rerender } = renderHook(
      ({ m }: { m: any[] }) => useTerminalMessages(m, 'a', () => {}),
      { initialProps: { m: [] } },
    );
    (result.current.messagesEndRef as any).current = endDiv;
    rerender({
      m: [
        { metadata: { task_id: 't1', action_type: 'system' } },
        { metadata: { action_type: 'progress' } },
      ] as any,
    });
    expect(viewport.scrollTop).toBe(0); // active browser → no scroll
    document.body.removeChild(viewport);
  });

  it('auto-scroll path: scrolls when user is near bottom', () => {
    const viewport = document.createElement('div');
    viewport.setAttribute('data-radix-scroll-area-viewport', 'true');
    Object.defineProperty(viewport, 'scrollHeight', { configurable: true, value: 1000 });
    Object.defineProperty(viewport, 'clientHeight', { configurable: true, value: 500 });
    viewport.scrollTop = 499; // distanceFromBottom = 1000 - 499 - 500 = 1 < AUTO_SCROLL_THRESHOLD
    const endDiv = document.createElement('div');
    viewport.appendChild(endDiv);
    document.body.appendChild(viewport);

    const { result, rerender } = renderHook(
      ({ m }: { m: any[] }) => useTerminalMessages(m, 'a', () => {}),
      { initialProps: { m: [] } },
    );
    (result.current.messagesEndRef as any).current = endDiv;
    rerender({ m: [{ metadata: {} }] as any });
    expect(viewport.scrollTop).toBe(1000);
    document.body.removeChild(viewport);
  });

  it('auto-scroll path: initial load uses rAF to scroll to bottom', () => {
    const viewport = document.createElement('div');
    viewport.setAttribute('data-radix-scroll-area-viewport', 'true');
    Object.defineProperty(viewport, 'scrollHeight', { configurable: true, value: 2000 });
    Object.defineProperty(viewport, 'clientHeight', { configurable: true, value: 500 });
    viewport.scrollTop = 0;
    const endDiv = document.createElement('div');
    viewport.appendChild(endDiv);
    document.body.appendChild(viewport);

    const rafSpy = vi
      .spyOn(global, 'requestAnimationFrame')
      .mockImplementation((cb: any) => {
        cb(0);
        return 0 as any;
      });

    const { result, rerender } = renderHook(
      ({ m }: { m: any[] }) => useTerminalMessages(m, 'a', () => {}),
      { initialProps: { m: [] } },
    );
    (result.current.messagesEndRef as any).current = endDiv;
    act(() => {
      result.current.markInitialLoad();
    });
    rerender({ m: [{ metadata: {} }] as any });
    expect(viewport.scrollTop).toBe(2000);
    rafSpy.mockRestore();
    document.body.removeChild(viewport);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// usePayment.ts
// ═══════════════════════════════════════════════════════════════════════════

describe('usePayment', () => {
  const initialUserData = {
    name: '',
    addressLine1: '',
    addressLine2: '',
    city: '',
    state: '',
    postalCode: '',
    country: '',
    encryptedPaymentInformation: null as string | null,
  };

  beforeEach(() => {
    mockSession();
    server.use(
      http.patch(`${API_BASE}/user-settings`, async ({ request }) => {
        const body = (await request.json()) as any;
        return HttpResponse.json({ encryptedPaymentInformation: body.encryptedPaymentInformation });
      }),
    );
  });

  afterEach(() => {
    localStorage.clear();
  });

  it('formats card number in groups of 4, max 16 digits', () => {
    const setUser = vi.fn();
    const setErr = vi.fn();
    const { result } = renderHook(() => usePayment(initialUserData, setUser, setErr));
    act(() => result.current.handleCardNumber('4242abc4242-4242-4242-99'));
    // only digits kept, grouped; 16 digits max
    expect(result.current.paymentData.card_number).toBe('4242 4242 4242 4242');
  });

  it('formats expiry MM/YY', () => {
    const { result } = renderHook(() =>
      usePayment(initialUserData, vi.fn(), vi.fn()),
    );
    act(() => result.current.handleExpiry('1225abc'));
    expect(result.current.paymentData.card_expiry).toBe('12/25');
    act(() => result.current.handleExpiry('1'));
    expect(result.current.paymentData.card_expiry).toBe('1');
  });

  it('limits CVV to 4 digits and strips non-digits', () => {
    const { result } = renderHook(() =>
      usePayment(initialUserData, vi.fn(), vi.fn()),
    );
    act(() => result.current.handleCVV('12abc34567'));
    expect(result.current.paymentData.card_cvv).toBe('1234');
  });

  it('handleAutopayBlur converts dollars to cents', () => {
    const { result } = renderHook(() =>
      usePayment(initialUserData, vi.fn(), vi.fn()),
    );
    act(() => result.current.setAutopayLimitDisplay('12.34'));
    act(() => result.current.handleAutopayBlur());
    expect(result.current.paymentData.autoagentpaylimit_cents).toBe(1234);
  });

  it('derives envelope and autopay display from userData.encryptedPaymentInformation', async () => {
    const envelope = {
      version: 1,
      encrypted_aes_key: 'k',
      iv: 'i',
      ciphertext: 'c',
      card_last_four: '4242',
      card_type: 'visa',
      billing_city: 'SF',
      billing_country: 'US',
      autoagentpaylimit_cents: 4500,
    };
    const encrypted = btoa(JSON.stringify(envelope));
    const userData = { ...initialUserData, encryptedPaymentInformation: encrypted };
    const { result } = renderHook(() => usePayment(userData, vi.fn(), vi.fn()));
    await waitFor(() => {
      expect(result.current.savedPaymentEnvelope?.card_last_four).toBe('4242');
    });
    expect(result.current.autopayLimitDisplay).toBe('45.00');
  });

  it('clears saved envelope when encryptedPaymentInformation is null', () => {
    const { result, rerender } = renderHook(
      ({ ud }: { ud: any }) => usePayment(ud, vi.fn(), vi.fn()),
      {
        initialProps: {
          ud: {
            ...initialUserData,
            encryptedPaymentInformation: btoa(
              JSON.stringify({
                version: 1,
                encrypted_aes_key: 'k',
                iv: 'i',
                ciphertext: 'c',
                card_last_four: '1',
                card_type: 'visa',
                billing_city: '',
                billing_country: '',
                autoagentpaylimit_cents: 100,
              }),
            ),
          },
        },
      },
    );
    expect(result.current.savedPaymentEnvelope).not.toBeNull();
    rerender({ ud: initialUserData });
    expect(result.current.savedPaymentEnvelope).toBeNull();
  });

  it('savePaymentInfo surfaces validation errors without calling API', async () => {
    const setUser = vi.fn();
    const setErr = vi.fn();
    const { result } = renderHook(() => usePayment(initialUserData, setUser, setErr));
    await act(async () => {
      await result.current.savePaymentInfo();
    });
    // no success, errors populated for required fields
    expect(Object.keys(result.current.paymentErrors).length).toBeGreaterThan(0);
    expect(result.current.savedPayment).toBe(false);
  });

  it('savePaymentInfo writes userData on success', async () => {
    const setUser = vi.fn();
    const { result } = renderHook(() =>
      usePayment(initialUserData, setUser, vi.fn()),
    );
    act(() => {
      // Populate a valid card (Luhn-valid Visa test number), far-future expiry
      result.current.setPaymentData({
        card_number: '4242 4242 4242 4242',
        cardholder_name: 'A Holder',
        card_expiry: '12/40',
        card_cvv: '123',
        billing_street_address: '1 Main',
        billing_address_line2: '',
        billing_city: 'SF',
        billing_state: 'CA',
        billing_zipcode: '94103',
        billing_country: 'US',
        billing_phone: '',
        billing_email: 'x@y.com',
        autoagentpaylimit_cents: 10000,
      });
      result.current.setAutopayLimitDisplay('50.00');
    });
    await act(async () => {
      await result.current.savePaymentInfo();
    });
    expect(setUser).toHaveBeenCalled();
    expect(result.current.savedPayment).toBe(true);
  });

  it('savePaymentInfo reports API errors via setError', async () => {
    server.use(
      http.patch(`${API_BASE}/user-settings`, () => new HttpResponse(null, { status: 500 })),
    );
    const setErr = vi.fn();
    const { result } = renderHook(() =>
      usePayment(initialUserData, vi.fn(), setErr),
    );
    act(() => {
      result.current.setPaymentData({
        card_number: '4242 4242 4242 4242',
        cardholder_name: 'A',
        card_expiry: '12/40',
        card_cvv: '123',
        billing_street_address: '1',
        billing_address_line2: '',
        billing_city: 'SF',
        billing_state: 'CA',
        billing_zipcode: '1',
        billing_country: 'US',
        billing_phone: '',
        billing_email: '',
        autoagentpaylimit_cents: 0,
      });
    });
    await act(async () => {
      await result.current.savePaymentInfo();
    });
    expect(setErr).toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// supabase.ts
// ═══════════════════════════════════════════════════════════════════════════

describe('lib/supabase', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('getSession returns null when no session stored', () => {
    expect(getSession()).toBeNull();
    expect(hasSession()).toBe(false);
  });

  it('getSession returns null and clears when session expired', () => {
    const expired = {
      access_token: 't',
      refresh_token: 'r',
      expires_in: 0,
      expires_at: Math.floor(Date.now() / 1000) - 10,
      token_type: 'bearer',
      user: { id: 'u' },
    };
    localStorage.setItem('rose-session', JSON.stringify(expired));
    expect(getSession()).toBeNull();
    expect(localStorage.getItem('rose-session')).toBeNull();
  });

  it('getSession returns null on parse error', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    localStorage.setItem('rose-session', 'not-json');
    expect(getSession()).toBeNull();
    warnSpy.mockRestore();
  });

  it('storeSession + getSession round-trip', () => {
    const session = {
      access_token: 't',
      refresh_token: 'r',
      expires_in: 3600,
      expires_at: Math.floor(Date.now() / 1000) + 3600,
      token_type: 'bearer',
      user: { id: 'u-1' } as any,
    } as any;
    storeSession(session);
    expect(getSession()?.user?.id).toBe('u-1');
    expect(hasSession()).toBe(true);
    expect(getStoredSession()?.user?.id).toBe('u-1');
  });

  it('clearSession wipes storage (including legacy alias)', () => {
    localStorage.setItem('rose-session', '{"access_token":"x"}');
    localStorage.setItem('app-user', '{"id":"u"}');
    clearSession();
    expect(localStorage.getItem('rose-session')).toBeNull();
    expect(localStorage.getItem('app-user')).toBeNull();
    // legacy alias
    clearStoredSession();
  });

  it('getCachedUser returns parsed user or null; persistCachedUser stores and clears', () => {
    expect(getCachedUser()).toBeNull();
    persistCachedUser({ id: 'u1' } as any);
    expect(getCachedUser()?.id).toBe('u1');
    persistCachedUser(null);
    expect(getCachedUser()).toBeNull();
  });

  it('getCachedUser returns null on parse error', () => {
    localStorage.setItem('app-user', 'not-json');
    expect(getCachedUser()).toBeNull();
  });

  it('isAnonymousUser', () => {
    expect(isAnonymousUser(null)).toBe(false);
    expect(isAnonymousUser({ is_anonymous: true } as any)).toBe(true);
    expect(isAnonymousUser({ is_anonymous: false } as any)).toBe(false);
  });

  it('createAnonymousSession: parses response and stores session', async () => {
    server.use(
      http.post(`${API_BASE}/auth/anonymous`, () =>
        HttpResponse.json({
          user: { id: 'anon-1' },
          session: {
            access_token: 'at',
            refresh_token: 'rt',
            expires_in: 3600,
            expires_at: Math.floor(Date.now() / 1000) + 3600,
          },
        }),
      ),
    );
    const { user, session } = await createAnonymousSession();
    expect(user.id).toBe('anon-1');
    expect(session.access_token).toBe('at');
    expect(localStorage.getItem('rose-session')).toContain('anon-1');
  });

  it('createAnonymousSession: throws on non-ok response', async () => {
    server.use(
      http.post(`${API_BASE}/auth/anonymous`, () =>
        HttpResponse.json({ error: 'boom' }, { status: 500 }),
      ),
    );
    await expect(createAnonymousSession()).rejects.toThrow('boom');
  });

  it('signOut clears the session', async () => {
    mockSession();
    await signOut();
    expect(hasSession()).toBe(false);
  });

  it('setRealtimeAuth toggles isRealtimeReady', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await setRealtimeAuth(null);
    expect(isRealtimeReady()).toBe(false);
    // Exercise identifyToken's invalid + anon_key paths via setRealtimeAuth.
    await setRealtimeAuth('short');
    expect(isRealtimeReady()).toBe(true);
    await setRealtimeAuth(null);
    expect(isRealtimeReady()).toBe(false);
    logSpy.mockRestore();
  });

  it('setRealtimeAuth recognises anon JWT', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const anonToken =
      'eyJhbGciOiJIUzI1NiJ9.' + btoa(JSON.stringify({ role: 'anon' })) + '.sig';
    await setRealtimeAuth(anonToken);
    expect(isRealtimeReady()).toBe(true);
    await setRealtimeAuth(null);
    logSpy.mockRestore();
  });

  it('initializeRealtime calls setRealtimeAuth when session exists', async () => {
    mockSession();
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await initializeRealtime();
    expect(isRealtimeReady()).toBe(true);
    await setRealtimeAuth(null);
    logSpy.mockRestore();
  });

  it('initializeRealtime no-ops without a session', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await setRealtimeAuth(null);
    await initializeRealtime();
    expect(isRealtimeReady()).toBe(false);
    logSpy.mockRestore();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// realtime.ts - subscribeToChannel / subscribeToAgent / subscribeToBus
// ═══════════════════════════════════════════════════════════════════════════

describe('lib/realtime', () => {
  // IMPORTANT: These tests use the REAL subscribeToAgent/subscribeToBus from
  // the module we mocked above. The mock replaces subscribeToAgent/Bus with
  // vi.fn() shims in other test blocks — here we explicitly use the
  // `importOriginal` copy indirectly. Because vi.mock affects only the
  // specific import surface, we re-import the real implementations via a
  // dynamic import from the sibling module file.
  let real: typeof import('@/lib/realtime');
  beforeAll(async () => {
    const actual = await vi.importActual<typeof import('@/lib/realtime')>('@/lib/realtime');
    real = actual;
  });

  beforeEach(() => {
    mockSession();
  });

  afterEach(() => {
    localStorage.clear();
  });

  function setupChannelStub(statuses: string[] = ['SUBSCRIBED']) {
    // Patch supabase.channel + supabase.removeChannel for the duration
    // of the test via module spying.
    const listeners: Array<(status: string) => void> = [];
    const channel: any = {
      on: vi.fn().mockReturnThis(),
      subscribe: vi.fn((cb: (s: string) => void) => {
        listeners.push(cb);
        // Fire statuses immediately
        for (const s of statuses) cb(s);
        return channel;
      }),
    };
    const chanSpy = vi.spyOn(supabase, 'channel').mockReturnValue(channel);
    const rmSpy = vi.spyOn(supabase, 'removeChannel').mockReturnValue('ok' as any);
    const authSpy = vi
      .spyOn(supabase.realtime, 'setAuth')
      .mockResolvedValue(undefined as any);
    return { channel, chanSpy, rmSpy, authSpy, listeners };
  }

  it('subscribeToAgent: throws when no session', async () => {
    localStorage.clear();
    await expect(real.subscribeToAgent('a-1', {})).rejects.toThrow('Not authenticated');
  });

  it('subscribeToAgent: resolves on SUBSCRIBED, attaches handlers; invoking handler wrappers hits extractors', async () => {
    // Collect the (eventName → handler) map by intercepting channel.on
    const stub = setupChannelStub(['SUBSCRIBED']);
    const eventMap: Record<string, (w: unknown) => void> = {};
    (stub.channel.on as any).mockImplementation(
      (_type: string, cfg: { event: string }, handler: (w: unknown) => void) => {
        eventMap[cfg.event] = handler;
        return stub.channel;
      },
    );

    const onInsert = vi.fn();
    const onUpdate = vi.fn();
    const onDelete = vi.fn();
    const onAssistantStream = vi.fn();
    const onPlanStream = vi.fn();
    const onAttentionStream = vi.fn();
    const onToolStream = vi.fn();
    const onAgentModeStarted = vi.fn();
    const onDisconnect = vi.fn();
    const ch = await real.subscribeToAgent('a-1', {
      onInsert,
      onUpdate,
      onDelete,
      onAssistantStream,
      onPlanStream,
      onAttentionStream,
      onToolStream,
      onAgentModeStarted,
      onDisconnect,
    });
    expect(ch).toBe(stub.channel);
    // Fire each wrapper with an invalid payload — extractor returns null → no-op (covers the `if (record)` lines)
    for (const ev of [
      'INSERT',
      'UPDATE',
      'DELETE',
      'ASSISTANT_STREAM',
      'PLAN_STREAM',
      'ATTENTION_STREAM',
      'TOOL_STREAM',
      'AGENT_MODE_STARTED',
    ]) {
      eventMap[ev]?.(undefined);
    }
    // No extractor succeeds on undefined, so none of the user callbacks fired.
    expect(onInsert).not.toHaveBeenCalled();
  });

  it('subscribeToAgent: rejects on CHANNEL_ERROR before resolve', async () => {
    setupChannelStub(['CHANNEL_ERROR']);
    await expect(real.subscribeToAgent('a-2', {})).rejects.toThrow(/error/i);
  });

  it('subscribeToAgent: rejects on TIMED_OUT before resolve', async () => {
    setupChannelStub(['TIMED_OUT']);
    await expect(real.subscribeToAgent('a-3', {})).rejects.toThrow(/timed out/i);
  });

  it('subscribeToAgent: rejects on CLOSED before resolve', async () => {
    setupChannelStub(['CLOSED']);
    await expect(real.subscribeToAgent('a-4', {})).rejects.toThrow(/closed/i);
  });

  it('subscribeToAgent: fires onDisconnect after re-join error', async () => {
    const { listeners } = setupChannelStub(['SUBSCRIBED']);
    const onDisconnect = vi.fn();
    await real.subscribeToAgent('a-5', { onDisconnect });
    // Simulate a later post-join disconnect
    listeners[0]('CHANNEL_ERROR');
    expect(onDisconnect).toHaveBeenCalled();
  });

  it('subscribeToBus: attaches AGENT_STATE_CHANGED handler', async () => {
    const stub = setupChannelStub(['SUBSCRIBED']);
    const eventMap: Record<string, (w: unknown) => void> = {};
    (stub.channel.on as any).mockImplementation(
      (_type: string, cfg: { event: string }, handler: (w: unknown) => void) => {
        eventMap[cfg.event] = handler;
        return stub.channel;
      },
    );
    const onAgentStateChanged = vi.fn();
    await real.subscribeToBus('bus-1', { onAgentStateChanged });
    // Invoke wrapper with an invalid payload (extractor null → no-op branch)
    eventMap['AGENT_STATE_CHANGED']?.(undefined);
    expect(onAgentStateChanged).not.toHaveBeenCalled();
  });

  it('subscribeToBus: works without any handlers', async () => {
    setupChannelStub(['SUBSCRIBED']);
    await real.subscribeToBus('bus-2', {});
  });

  it('subscribeToAttentionRequests: attaches INSERT/UPDATE/DELETE handlers', async () => {
    const { channel } = setupChannelStub(['SUBSCRIBED']);
    await real.subscribeToAttentionRequests('user-1', {
      onInsert: vi.fn(),
      onUpdate: vi.fn(),
      onDelete: vi.fn(),
    });
    expect(channel.on).toHaveBeenCalled();
  });

  it('unsubscribe: no-op when given null', () => {
    // Should not throw
    real.unsubscribe(null as any);
  });

  it('unsubscribe: delegates to supabase.removeChannel', () => {
    const { rmSpy } = setupChannelStub(['SUBSCRIBED']);
    real.unsubscribe({} as any);
    expect(rmSpy).toHaveBeenCalled();
  });
});
