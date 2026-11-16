import { act, renderHook } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { beforeEach, expect, it, vi } from 'vitest';
import type { Message } from '@/lib/api';
import { computeActiveBrowserPanels } from '@/lib/browserPanelLifecycle';
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

import * as realtime from '@/lib/realtime';
import { useRealtimeSubscription } from '@/features/agent-context/hooks/useRealtimeSubscription';
import { CONNECTED_COMPLETION_BACKFILL_WINDOW_MS } from '@/features/agent-context/config';

beforeEach(() => {
  vi.mocked(realtime.subscribeToAgent).mockReset();
  server.use(
    http.get(
      `${API_BASE}/benchmarks/agent-preview/:agentId`,
      () => new HttpResponse(null, { status: 404 }),
    ),
  );
});

it('recovers a missed successor browser start across a zero-browser snapshot, then releases its lease', async () => {
  const message = (id: string, call: string, task: string, terminal = false): Message => ({
    message_id: id,
    timestamp: `2026-11-15T23:58:${id === 'first' ? '31' : id === 'terminal' ? '35' : '38'}.000Z`,
    role: 'TOOL',
    text: '',
    metadata: {
      toolName: 'spawn_browser_agent',
      toolCallId: call,
      toolStatus: terminal ? 'FINISHED' : 'IN_PROGRESS',
      action_type: terminal ? 'task_complete' : 'browser',
      task_id: task,
      browser_url: 'https://example.com/live',
    },
  });
  const first = message('first', 'first-call', 'first-task');
  const terminal = message('terminal', 'first-call', 'first-task', true);
  const successor = message('successor', 'call-retried-browser', 'retry-task-old');
  const answer: Message = {
    message_id: 'answer',
    timestamp: '2026-11-15T23:58:30.000Z',
    role: 'ASSISTANT',
    text: 'done',
    metadata: { isUserAttentionMessage: true },
  };
  let canonical = [answer];
  let reads = 0;
  let terminalSnapshotReads = 0;
  let successorFirstReadAt: number | undefined;
  server.use(
    http.get(`${API_BASE}/agents/agent-1`, () => {
      reads += 1;
      if (canonical.includes(terminal) && !canonical.includes(successor))
        terminalSnapshotReads += 1;
      if (canonical.includes(successor)) successorFirstReadAt ??= Date.now();
      return HttpResponse.json(agentDetailJson(canonical));
    }),
  );
  let handlers: Parameters<typeof realtime.subscribeToAgent>[1] = {};
  vi.mocked(realtime.subscribeToAgent).mockImplementation(async (_, incoming) => {
    handlers = incoming;
    return fakeChannel();
  });
  mockSession();
  const deps = makeDeps();
  let visible: Message[] = [];
  vi.mocked(deps.setMessages).mockImplementation((update) => {
    visible = typeof update === 'function' ? update(visible) : update;
  });
  const deliver = (row: Message) =>
    act(() => handlers.onInsert?.({ agentId: 'agent-1', id: row.message_id, ...row }));
  vi.useFakeTimers();
  const hook = renderHook(() => useRealtimeSubscription(deps));
  try {
    await vi.advanceTimersByTimeAsync(1_000);
    const idleReads = reads;
    await vi.advanceTimersByTimeAsync(2_000);
    expect(reads).toBe(idleReads); // Ordinary completed chat never starts a polling lease.
    canonical = [answer, first];
    deliver(first);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(computeActiveBrowserPanels(visible)).toHaveLength(1);
    canonical = [answer, first, terminal];
    deliver(terminal);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(computeActiveBrowserPanels(visible)).toHaveLength(0);
    expect(terminalSnapshotReads).toBeGreaterThan(0);
    // Broker acceptance is not client delivery. The real failing wait followed
    // a zero-browser snapshot by a new start whose INSERT was never observed.
    canonical = [answer, first, terminal, successor];
    await vi.advanceTimersByTimeAsync(5_000);
    expect(computeActiveBrowserPanels(visible)).toEqual([
      { taskId: 'retry-task-old', browserUrl: 'https://example.com/live' },
    ]);
    expect(successorFirstReadAt).toBeDefined();
    await vi.advanceTimersByTimeAsync(
      (successorFirstReadAt ?? Date.now()) +
        CONNECTED_COMPLETION_BACKFILL_WINDOW_MS +
        2_000 -
        Date.now(),
    );
    const expiredReads = reads;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(reads).toBe(expiredReads); // Snapshot rediscovery cannot renew the lease forever.
    expect(realtime.subscribeToAgent).toHaveBeenCalledTimes(1);
  } finally {
    hook.unmount();
    vi.useRealTimers();
  }
});
