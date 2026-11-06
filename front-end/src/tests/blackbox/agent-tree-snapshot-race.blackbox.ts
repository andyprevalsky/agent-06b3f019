import { act, renderHook, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { server } from './msw/server';

vi.mock('@/lib/realtime', async (importOriginal) => {
  const mod = await importOriginal<typeof import('@/lib/realtime')>();
  return { ...mod, subscribeToBus: vi.fn(), unsubscribe: vi.fn() };
});

import { noteTreeUserMessage, useAgentTree } from '@/hooks/useAgentTree';
import * as RealtimeMod from '@/lib/realtime';

const API_BASE = 'http://localhost:3001/api';

function fakeChannel() {
  return {
    state: 'joined',
    topic: 'test',
  } as unknown as import('@supabase/supabase-js').RealtimeChannel;
}

describe('agent tree snapshot ordering', () => {
  afterEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it('keeps the later lastUserMessageAt when a realtime node meets a newer snapshot', async () => {
    localStorage.setItem(
      'rose-session',
      JSON.stringify({ access_token: 'test-token', user: { id: 'user-1' } }),
    );
    let releaseSnapshot!: () => void;
    const snapshotBlocked = new Promise<void>((resolve) => {
      releaseSnapshot = resolve;
    });
    const row = (agent_id: string, parent_agent_id: string | null, last?: string) => ({
      agent_id,
      parent_agent_id,
      goal: agent_id,
      status: 'ACTIVE',
      progress: 0,
      tools_in_use: [],
      message_count: 0,
      tree_cost_cents: 0,
      ...(last ? { last_user_message_at: last } : {}),
    });
    server.use(
      http.get(`${API_BASE}/agents/tree`, async () => {
        await snapshotBlocked;
        // Another device messaged the child after this tab's own send.
        return HttpResponse.json({
          agents: [row('root', null), row('child', 'root', '2026-10-21T02:00:00.000Z')],
        });
      }),
    );
    let handlers: Parameters<typeof RealtimeMod.subscribeToBus>[1] = {};
    vi.mocked(RealtimeMod.subscribeToBus).mockImplementation(async (_busId, nextHandlers) => {
      handlers = nextHandlers;
      return fakeChannel();
    });
    const { result, unmount } = renderHook(() => useAgentTree('stamp-race-bus'));
    await waitFor(() => expect(handlers.onAgentStateChanged).toBeTypeOf('function'));
    act(() => {
      handlers.onAgentStateChanged?.({
        agentId: 'child',
        parentAgentId: 'root',
        goal: 'child',
        status: 'ACTIVE',
        progress: 0,
        toolsInUse: [],
        messageCount: 1,
        costCents: 0,
      });
    });
    act(() => noteTreeUserMessage('child', '2026-10-21T01:00:00.000Z'));
    expect(result.current.get('child')?.lastUserMessageAt).toBe('2026-10-21T01:00:00.000Z');

    releaseSnapshot();
    await waitFor(() => expect(result.current.has('root')).toBe(true));
    expect(result.current.get('child')?.lastUserMessageAt).toBe('2026-10-21T02:00:00.000Z');
    unmount();
  });

  it('does not overwrite a current-generation realtime node with an older initial snapshot', async () => {
    localStorage.setItem(
      'rose-session',
      JSON.stringify({ access_token: 'test-token', user: { id: 'user-1' } }),
    );
    let releaseSnapshot!: () => void;
    const snapshotBlocked = new Promise<void>((resolve) => {
      releaseSnapshot = resolve;
    });
    let markSnapshotReturned!: () => void;
    const snapshotReturned = new Promise<void>((resolve) => {
      markSnapshotReturned = resolve;
    });
    server.use(
      http.get(`${API_BASE}/agents/tree`, async () => {
        await snapshotBlocked;
        markSnapshotReturned();
        return HttpResponse.json({
          agents: [
            {
              agent_id: 'root',
              parent_agent_id: null,
              goal: 'older API snapshot',
              status: 'ACTIVE',
              progress: 0,
              tools_in_use: [],
              message_count: 0,
              tree_cost_cents: 0,
            },
            {
              agent_id: 'snapshot-only',
              parent_agent_id: 'root',
              goal: 'proves API snapshot landed',
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
    let handlers: Parameters<typeof RealtimeMod.subscribeToBus>[1] = {};
    vi.mocked(RealtimeMod.subscribeToBus).mockImplementation(async (_busId, nextHandlers) => {
      handlers = nextHandlers;
      return fakeChannel();
    });
    const { result, unmount } = renderHook(() => useAgentTree('snapshot-race-bus'));
    await waitFor(() => expect(handlers.onAgentStateChanged).toBeTypeOf('function'));

    act(() => {
      handlers.onAgentStateChanged?.({
        agentId: 'root',
        parentAgentId: null,
        goal: 'newer realtime state',
        progressEstimate: {
          progress: 0.6,
          etaSeconds: 60,
          sequence: 2,
          observedAt: '2026-10-21T01:00:00Z',
          model: 'jev',
          promptVersion: 'v1',
        },
        status: 'ACTIVE',
        progress: 0.5,
        toolsInUse: [],
        messageCount: 1,
        costCents: 1,
      });
    });
    expect(result.current.get('root')?.goal).toBe('newer realtime state');
    act(() => {
      handlers.onAgentStateChanged?.({
        agentId: 'root',
        parentAgentId: null,
        goal: 'newer realtime state',
        status: 'ACTIVE',
        progress: 0.1,
        toolsInUse: [],
        messageCount: 1,
        progressEstimate: {
          progress: 0.1,
          etaSeconds: 600,
          sequence: 1,
          observedAt: '2026-10-21T00:00:00Z',
          model: 'jev',
          promptVersion: 'v1',
        },
      });
    });
    expect(result.current.get('root')?.progressEstimate?.progress).toBe(0.6);

    releaseSnapshot();
    await snapshotReturned;
    await waitFor(() => expect(result.current.has('snapshot-only')).toBe(true));
    expect(result.current.get('root')?.goal).toBe('newer realtime state');
    expect(result.current.get('root')?.progressEstimate?.progress).toBe(0.6);
    unmount();
  });

  it('preserves the latest realtime node while a reconnect snapshot reconciles', async () => {
    localStorage.setItem(
      'rose-session',
      JSON.stringify({ access_token: 'test-token', user: { id: 'user-1' } }),
    );
    let requestCount = 0;
    let releaseReconnectSnapshot!: () => void;
    const reconnectSnapshotBlocked = new Promise<void>((resolve) => {
      releaseReconnectSnapshot = resolve;
    });
    let markReconnectSnapshotStarted!: () => void;
    const reconnectSnapshotStarted = new Promise<void>((resolve) => {
      markReconnectSnapshotStarted = resolve;
    });
    server.use(
      http.get(`${API_BASE}/agents/tree`, async () => {
        requestCount += 1;
        const currentRequest = requestCount;
        if (currentRequest === 2) {
          markReconnectSnapshotStarted();
          await reconnectSnapshotBlocked;
        }
        return HttpResponse.json({
          agents: [
            {
              agent_id: 'root',
              parent_agent_id: null,
              goal: currentRequest === 1 ? 'initial API state' : 'stale reconnect snapshot',
              status: 'ACTIVE',
              progress: 0,
              tools_in_use: [],
              message_count: 0,
              tree_cost_cents: 0,
            },
            ...(currentRequest === 2
              ? [
                  {
                    agent_id: 'reconnect-snapshot-only',
                    parent_agent_id: 'root',
                    goal: 'proves reconnect snapshot landed',
                    status: 'ACTIVE',
                    progress: 0,
                    tools_in_use: [],
                    message_count: 0,
                    tree_cost_cents: 0,
                  },
                ]
              : []),
          ],
        });
      }),
    );
    const handlerGenerations: Parameters<typeof RealtimeMod.subscribeToBus>[1][] = [];
    vi.mocked(RealtimeMod.subscribeToBus).mockImplementation(async (_busId, handlers) => {
      handlerGenerations.push(handlers);
      return fakeChannel();
    });
    const { result, unmount } = renderHook(() => useAgentTree('reconnect-race-bus'));
    await waitFor(() => expect(result.current.get('root')?.goal).toBe('initial API state'));
    await waitFor(() => expect(handlerGenerations).toHaveLength(1));

    act(() => {
      handlerGenerations[0].onAgentStateChanged?.({
        agentId: 'root',
        parentAgentId: null,
        goal: 'newer realtime state',
        status: 'ACTIVE',
        progress: 0.5,
        toolsInUse: [],
        messageCount: 1,
        costCents: 1,
      });
    });
    expect(result.current.get('root')?.goal).toBe('newer realtime state');

    let reconnect!: () => void;
    const timeoutSpy = vi.spyOn(window, 'setTimeout').mockImplementation(((
      callback: TimerHandler,
    ) => {
      reconnect = callback as () => void;
      return 1;
    }) as typeof window.setTimeout);
    act(() => handlerGenerations[0].onDisconnect?.());
    act(() => reconnect());
    await reconnectSnapshotStarted;
    timeoutSpy.mockRestore();
    releaseReconnectSnapshot();

    await waitFor(() => expect(result.current.has('reconnect-snapshot-only')).toBe(true));
    expect(result.current.get('root')?.goal).toBe('newer realtime state');
    unmount();
  });
});

describe('prediction updates on the existing tree bus', () => {
  it('retains a prediction received before the initial snapshot', async () => {
    localStorage.setItem(
      'rose-session',
      JSON.stringify({ access_token: 'test-token', user: { id: 'user-1' } }),
    );
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    server.use(
      http.get(`${API_BASE}/agents/tree`, async () => {
        await blocked;
        return HttpResponse.json({
          agents: [
            {
              agent_id: 'early',
              taskProgressEstimates: {
                task: {
                  taskId: 'task',
                  progress: 0.2,
                  etaSeconds: 60,
                  sequence: 1,
                  observedAt: '2026-10-21T01:00:00Z',
                  model: 'jev',
                  promptVersion: 'test',
                },
              },
              parent_agent_id: null,
              goal: 'goal',
              status: 'ACTIVE',
              temporal_workflow_id: 'wf',
              progress: 0,
              tools_in_use: [],
              message_count: 1,
              tree_cost_cents: 0,
            },
          ],
        });
      }),
    );
    let handlers: Parameters<typeof RealtimeMod.subscribeToBus>[1] = {};
    vi.mocked(RealtimeMod.subscribeToBus).mockImplementation(async (_id, value) => {
      handlers = value;
      return fakeChannel();
    });
    const { result, unmount } = renderHook(() => useAgentTree('early'));
    await waitFor(() => expect(handlers.onUpdate).toBeTypeOf('function'));
    const progressEstimate = {
      progress: 0.7,
      etaSeconds: 60,
      sequence: 2,
      observedAt: '2026-10-21T01:00:00Z',
      model: 'jev',
      promptVersion: 'test',
    };
    act(() =>
      handlers.onUpdate?.({ agentId: 'early', temporalWorkflowId: 'wf', progressEstimate }),
    );
    release();
    await waitFor(() =>
      expect(result.current.get('early')?.progressEstimate).toEqual(progressEstimate),
    );
    expect(result.current.get('early')?.taskProgressEstimates?.task.progress).toBe(0.2);
    unmount();
  });
  it('patches the existing node without a snapshot request and rejects stale generations', async () => {
    localStorage.setItem(
      'rose-session',
      JSON.stringify({ access_token: 'test-token', user: { id: 'user-1' } }),
    );
    let requests = 0;
    server.use(
      http.get(`${API_BASE}/agents/tree`, () => {
        requests++;
        return HttpResponse.json({
          agents: [
            {
              agent_id: 'prediction-root',
              parent_agent_id: null,
              goal: 'goal',
              status: 'ACTIVE',
              temporal_workflow_id: 'wf',
              progress: 0,
              tools_in_use: [],
              message_count: 1,
              tree_cost_cents: 0,
            },
          ],
        });
      }),
    );
    let handlers: Parameters<typeof RealtimeMod.subscribeToBus>[1] = {};
    vi.mocked(RealtimeMod.subscribeToBus).mockImplementation(async (_id, value) => {
      handlers = value;
      return fakeChannel();
    });
    const { result, unmount } = renderHook(() => useAgentTree('prediction-root'));
    await waitFor(() => expect(result.current.size).toBe(1));
    expect(handlers.onUpdate).toBeTypeOf('function');
    const prediction = {
      progress: 0.6,
      etaSeconds: 60,
      sequence: 2,
      observedAt: '2026-10-21T01:00:00Z',
      model: 'jev',
      promptVersion: 'v1',
    };
    act(() =>
      handlers.onUpdate?.({
        agentId: 'prediction-root',
        temporalWorkflowId: 'wf',
        progressEstimate: prediction,
      }),
    );
    expect(result.current.get('prediction-root')?.progressEstimate).toEqual(prediction);
    const unchanged = result.current;
    act(() =>
      handlers.onUpdate?.({
        agentId: 'prediction-root',
        temporalWorkflowId: 'wf',
        progressEstimate: prediction,
      }),
    );
    expect(result.current).toBe(unchanged);
    act(() =>
      handlers.onUpdate?.({
        agentId: 'prediction-root',
        temporalWorkflowId: 'old',
        progressEstimate: { ...prediction, sequence: 3 },
      }),
    );
    expect(result.current).toBe(unchanged);
    act(() =>
      handlers.onAgentStateChanged?.({
        agentId: 'prediction-root',
        parentAgentId: null,
        temporalWorkflowId: 'new-wf',
        goal: 'resumed',
        status: 'ACTIVE',
        progress: 0,
        toolsInUse: [],
        messageCount: 1,
      }),
    );
    expect(result.current.get('prediction-root')?.progressEstimate).toBeNull();
    act(() =>
      handlers.onUpdate?.({
        agentId: 'prediction-root',
        temporalWorkflowId: 'new-wf',
        progressEstimate: { ...prediction, sequence: 3 },
      }),
    );
    expect(result.current.get('prediction-root')?.progressEstimate?.sequence).toBe(3);
    expect(requests).toBe(1);
    unmount();
  });
});
