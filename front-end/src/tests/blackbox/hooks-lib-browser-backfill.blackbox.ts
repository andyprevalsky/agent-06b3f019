import { act, renderHook } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Message } from '@/lib/api';
import { server } from './msw/server';
import {
  agentDetailJson,
  API_BASE,
  fakeChannel,
  makeDeps,
  mockSession,
} from './realtime-subscription.fixtures';

vi.mock('@/lib/realtime', async (importOriginal) => {
  const mod = await importOriginal<typeof import('@/lib/realtime')>();
  return { ...mod, subscribeToAgent: vi.fn(), unsubscribe: vi.fn() };
});

import * as RealtimeMod from '@/lib/realtime';
import { useRealtimeSubscription } from '@/features/agent-context/hooks/useRealtimeSubscription';
import { CONNECTED_COMPLETION_BACKFILL_WINDOW_MS } from '@/features/agent-context/config';
import { computeActiveBrowserPanels } from '@/features/terminal/hooks/derivations';

function browserStart(taskId: string): Message {
  return {
    message_id: `${taskId}-start`,
    timestamp: '2026-10-13T00:00:02Z',
    text: '',
    role: 'TOOL',
    metadata: {
      toolName: 'spawn_browser_agent',
      toolCallId: `${taskId}-call`,
      toolStatus: 'IN_PROGRESS',
      action_type: 'browser',
      task_id: taskId,
      browser_url: 'https://example.com/live',
    },
  };
}
function deliver(handlers: Parameters<typeof RealtimeMod.subscribeToAgent>[1], message: Message) {
  act(() =>
    handlers.onInsert?.({
      agentId: 'agent-1',
      id: message.message_id,
      timestamp: message.timestamp,
      text: message.text,
      role: message.role,
      metadata: message.metadata,
    }),
  );
}

describe('browser completion recovery ownership', () => {
  beforeEach(() => {
    vi.mocked(RealtimeMod.subscribeToAgent).mockReset();
    vi.mocked(RealtimeMod.unsubscribe).mockReset();
    server.use(
      http.get(
        `${API_BASE}/benchmarks/agent-preview/:agentId`,
        () => new HttpResponse(null, { status: 404 }),
      ),
    );
    mockSession();
  });

  it('does not renew a spent browser lease for duplicate init, progress, or reconnect', async () => {
    const start = browserStart('bounded');
    let calls = 0;
    server.use(
      http.get(`${API_BASE}/agents/agent-1`, () => {
        calls += 1;
        return HttpResponse.json(agentDetailJson([start]));
      }),
    );
    let handlers: Parameters<typeof RealtimeMod.subscribeToAgent>[1] = {};
    vi.mocked(RealtimeMod.subscribeToAgent).mockImplementation(async (_, incoming) => {
      handlers = incoming;
      return fakeChannel();
    });
    const deps = makeDeps();
    vi.useFakeTimers();
    try {
      const hook = renderHook(
        ({ counter }) => useRealtimeSubscription({ ...deps, forceResubscribeCounter: counter }),
        { initialProps: { counter: 0 } },
      );
      await vi.advanceTimersByTimeAsync(CONNECTED_COMPLETION_BACKFILL_WINDOW_MS + 1_000);
      const expiredCalls = calls;
      await vi.advanceTimersByTimeAsync(5_000);
      expect(calls).toBe(expiredCalls);
      deliver(handlers, start);
      deliver(handlers, {
        ...start,
        message_id: 'progress',
        metadata: { ...start.metadata, action_type: 'click' },
      });
      await vi.advanceTimersByTimeAsync(5_000);
      const afterDuplicateCalls = calls;
      expect(afterDuplicateCalls).toBe(expiredCalls);
      hook.rerender({ counter: 1 });
      await vi.advanceTimersByTimeAsync(1_000);
      const coldSnapshotCalls = calls;
      expect(coldSnapshotCalls - afterDuplicateCalls).toBe(1);
      await vi.advanceTimersByTimeAsync(CONNECTED_COMPLETION_BACKFILL_WINDOW_MS);
      expect(calls).toBe(coldSnapshotCalls);
      hook.unmount();
    } finally {
      vi.useRealTimers();
    }
  });

  it('discards an old browser snapshot when selection changes during the request', async () => {
    let release: (() => void) | undefined;
    let oldRequestStarted = false;
    server.use(
      http.get(`${API_BASE}/agents/:agentId`, async ({ params }) => {
        if (params.agentId === 'agent-1') {
          oldRequestStarted = true;
          await new Promise<void>((resolve) => {
            release = resolve;
          });
          return HttpResponse.json(agentDetailJson([browserStart('old-browser')]));
        }
        const data = agentDetailJson([]);
        data.agent.agent_id = 'agent-2';
        return HttpResponse.json(data);
      }),
    );
    vi.mocked(RealtimeMod.subscribeToAgent).mockImplementation(async () => fakeChannel());
    const deps = makeDeps();
    let messages: Message[] = [];
    vi.mocked(deps.setMessages).mockImplementation((update) => {
      messages = typeof update === 'function' ? update(messages) : update;
    });
    vi.useFakeTimers();
    try {
      const hook = renderHook(
        ({ agentId }) => useRealtimeSubscription({ ...deps, selectedAgentId: agentId }),
        { initialProps: { agentId: 'agent-1' } },
      );
      await vi.advanceTimersByTimeAsync(100);
      expect(oldRequestStarted).toBe(true);
      deps.selectedAgentIdRef.current = 'agent-2';
      hook.rerender({ agentId: 'agent-2' });
      await vi.advanceTimersByTimeAsync(100);
      const writesBeforeOldResponse = vi.mocked(deps.setMessages).mock.calls.length;
      const agentWritesBeforeOldResponse = vi.mocked(deps.setAgent).mock.calls.length;
      const modeWritesBeforeOldResponse = vi.mocked(deps.setIsChatMode).mock.calls.length;
      release?.();
      await vi.advanceTimersByTimeAsync(100);
      expect(deps.setMessages).toHaveBeenCalledTimes(writesBeforeOldResponse);
      expect(deps.setAgent).toHaveBeenCalledTimes(agentWritesBeforeOldResponse);
      expect(deps.setIsChatMode).toHaveBeenCalledTimes(modeWritesBeforeOldResponse);
      expect(messages).toEqual([]);
      expect(deps.initialLoadDoneRef.current).toBe('agent-2');
      hook.unmount();
    } finally {
      release?.();
      vi.useRealTimers();
    }
  });

  it('serializes overlapping browser starts and recovers both missing terminals', async () => {
    const starts = [browserStart('first'), browserStart('second')];
    let phase: 'empty' | 'active' | 'done' = 'empty';
    let release: (() => void) | undefined;
    let blocked = false;
    let inFlight = 0;
    let maximumInFlight = 0;
    let calls = 0;
    server.use(
      http.get(`${API_BASE}/agents/agent-1`, async () => {
        calls += 1;
        inFlight += 1;
        maximumInFlight = Math.max(maximumInFlight, inFlight);
        if (phase === 'active' && !blocked) {
          blocked = true;
          await new Promise<void>((resolve) => {
            release = resolve;
          });
        }
        const terminals = starts.map((message): Message => ({
          ...message,
          message_id: `${message.message_id}-terminal`,
          timestamp: '2026-10-13T00:00:03Z',
          metadata: { ...message.metadata, action_type: 'task_complete', toolStatus: 'FINISHED' },
        }));
        inFlight -= 1;
        return HttpResponse.json(
          agentDetailJson(
            phase === 'empty' ? [] : [...starts, ...(phase === 'done' ? terminals : [])],
          ),
        );
      }),
    );
    let handlers: Parameters<typeof RealtimeMod.subscribeToAgent>[1] = {};
    vi.mocked(RealtimeMod.subscribeToAgent).mockImplementation(async (_, incoming) => {
      handlers = incoming;
      return fakeChannel();
    });
    const deps = makeDeps();
    let messages: Message[] = [];
    vi.mocked(deps.setMessages).mockImplementation((update) => {
      messages = typeof update === 'function' ? update(messages) : update;
    });
    vi.useFakeTimers();
    try {
      const hook = renderHook(() => useRealtimeSubscription(deps));
      await vi.advanceTimersByTimeAsync(100);
      phase = 'active';
      deliver(handlers, starts[0]!);
      await vi.advanceTimersByTimeAsync(100);
      expect(blocked).toBe(true);
      const leaseExpiresAt = Date.now() + CONNECTED_COMPLETION_BACKFILL_WINDOW_MS;
      deliver(handlers, starts[1]!);
      await vi.advanceTimersByTimeAsync(100);
      expect(maximumInFlight).toBe(1);
      release?.();
      await vi.advanceTimersByTimeAsync(1_000);
      expect(computeActiveBrowserPanels(messages)).toHaveLength(2);
      phase = 'done';
      await vi.advanceTimersByTimeAsync(2_500);
      expect(computeActiveBrowserPanels(messages)).toHaveLength(0);
      expect(maximumInFlight).toBe(1);
      const terminalCalls = calls;
      await vi.advanceTimersByTimeAsync(leaseExpiresAt + 1_000 - Date.now());
      expect(calls).toBeGreaterThan(terminalCalls);
      expect(maximumInFlight).toBe(1);
      const recoveredCalls = calls;
      await vi.advanceTimersByTimeAsync(5_000);
      expect(calls).toBe(recoveredCalls);
      hook.unmount();
    } finally {
      release?.();
      vi.useRealTimers();
    }
  });
  it('retains a browser wake queued while the previous recovery is returning', async () => {
    const start: Message = {
      message_id: 'race-start',
      timestamp: '2026-10-13T00:00:02Z',
      text: '',
      role: 'TOOL',
      metadata: {
        toolName: 'spawn_browser_agent',
        toolCallId: 'race-call',
        toolStatus: 'IN_PROGRESS',
        action_type: 'browser',
        task_id: 'race-task',
        browser_url: 'https://example.com/live',
      },
    };
    const terminal: Message = {
      ...start,
      message_id: 'race-terminal',
      timestamp: '2026-10-13T00:00:03Z',
      metadata: { ...start.metadata, action_type: 'task_complete', toolStatus: 'FINISHED' },
    };
    let calls = 0;
    let phase: 'empty' | 'browser' | 'terminal' = 'empty';
    server.use(
      http.get(
        `${API_BASE}/benchmarks/agent-preview/:agentId`,
        () => new HttpResponse(null, { status: 404 }),
      ),
      http.get(`${API_BASE}/agents/agent-1`, () => {
        calls += 1;
        return HttpResponse.json(
          agentDetailJson(
            phase === 'empty' ? [] : [start, ...(phase === 'terminal' ? [terminal] : [])],
          ),
        );
      }),
    );
    let handlers: Parameters<typeof RealtimeMod.subscribeToAgent>[1] = {};
    vi.mocked(RealtimeMod.subscribeToAgent).mockImplementation(async (_, incoming) => {
      handlers = incoming;
      return fakeChannel();
    });
    mockSession();
    const deps = makeDeps();
    let messages: Message[] = [];
    let queued = false;
    vi.mocked(deps.setMessages).mockImplementation((update) => {
      messages = typeof update === 'function' ? update(messages) : update;
      if (!queued) {
        queued = true;
        queueMicrotask(() => {
          phase = 'browser';
          act(() =>
            handlers.onInsert?.({
              agentId: 'agent-1',
              id: start.message_id,
              timestamp: start.timestamp,
              text: start.text,
              role: start.role,
              metadata: start.metadata,
            }),
          );
        });
      }
    });
    vi.useFakeTimers();
    try {
      const hook = renderHook(() => useRealtimeSubscription(deps));
      await vi.advanceTimersByTimeAsync(1_000);
      expect(computeActiveBrowserPanels(messages)).toHaveLength(1);
      phase = 'terminal';
      await vi.advanceTimersByTimeAsync(2_500);
      expect(computeActiveBrowserPanels(messages)).toHaveLength(0);
      expect(calls).toBeGreaterThan(1);
      hook.unmount();
    } finally {
      vi.useRealTimers();
    }
  });
});
