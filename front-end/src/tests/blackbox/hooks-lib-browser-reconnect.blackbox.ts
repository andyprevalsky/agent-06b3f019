import { act, renderHook } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { expect, it, vi } from 'vitest';
import type { Message } from '@/lib/api';
import { server } from '@/tests/blackbox/msw/server';
import {
  agentDetailJson,
  API_BASE,
  fakeChannel,
  makeDeps,
  mockSession,
} from '@/tests/blackbox/realtime-subscription.fixtures';
import { computeActiveBrowserPanels } from '@/lib/browserPanelLifecycle';
vi.mock('@/lib/realtime', async (importOriginal) => {
  const mod = await importOriginal<typeof import('@/lib/realtime')>();
  return { ...mod, subscribeToAgent: vi.fn(), unsubscribe: vi.fn() };
});
import * as RealtimeMod from '@/lib/realtime';
import { useRealtimeSubscription } from '@/features/agent-context/hooks/useRealtimeSubscription';
it('retains browser demand across reconnect when the first snapshot is stale and replayed INIT is deduplicated', async () => {
  mockSession();
  const start: Message = {
    message_id: 'browser-start',
    timestamp: '2026-10-13T00:00:02Z',
    text: '',
    role: 'TOOL',
    metadata: {
      toolName: 'spawn_browser_agent',
      toolCallId: 'browser-call',
      toolStatus: 'IN_PROGRESS',
      action_type: 'browser',
      task_id: 'browser-task',
      browser_url: 'https://example.com/live',
    },
  };
  const terminal: Message = {
    ...start,
    message_id: 'browser-terminal',
    timestamp: '2026-10-13T00:00:03Z',
    metadata: { ...start.metadata, toolStatus: 'FINISHED', action_type: 'task_complete' },
  };
  const completedChat: Message[] = [
    { message_id: 'user', timestamp: '2026-10-13T00:00:00Z', text: 'goal', role: 'USER' },
    {
      message_id: 'answer',
      timestamp: '2026-10-13T00:00:01Z',
      text: 'done',
      role: 'TOOL',
      metadata: {
        toolName: 'send_message_to_user',
        toolStatus: 'FINISHED',
        isUserAttentionMessage: true,
      },
    },
  ];
  let terminalVisible = false;
  let requests = 0;
  server.use(
    http.get(
      `${API_BASE}/benchmarks/agent-preview/:agentId`,
      () => new HttpResponse(null, { status: 404 }),
    ),
    http.get(`${API_BASE}/agents/agent-1`, () => {
      requests += 1;
      return HttpResponse.json(
        agentDetailJson(terminalVisible ? [...completedChat, start, terminal] : completedChat),
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
  const deliverStart = () =>
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
  vi.useFakeTimers();
  try {
    const hook = renderHook(
      ({ counter }) => useRealtimeSubscription({ ...deps, forceResubscribeCounter: counter }),
      { initialProps: { counter: 0 } },
    );
    await vi.advanceTimersByTimeAsync(1000);
    expect(computeActiveBrowserPanels(messages)).toHaveLength(0);
    deliverStart();
    await vi.advanceTimersByTimeAsync(1000);
    expect(computeActiveBrowserPanels(messages)).toHaveLength(1);
    const beforeReconnect = requests;
    hook.rerender({ counter: 1 });
    await vi.advanceTimersByTimeAsync(1000);
    expect(requests).toBeGreaterThan(beforeReconnect);
    deliverStart();
    terminalVisible = true;
    const staleColdReads = requests;
    await vi.advanceTimersByTimeAsync(5000);
    console.log(
      'RECONNECT_REPRO',
      JSON.stringify({
        beforeReconnect,
        staleColdReads,
        finalReads: requests,
        activeBrowsers: computeActiveBrowserPanels(messages).length,
      }),
    );
    expect(
      computeActiveBrowserPanels(messages),
      'previously observed browser must reconcile its missed terminal within the existing lease after reconnect',
    ).toHaveLength(0);
    hook.unmount();
  } finally {
    vi.useRealTimers();
  }
});
