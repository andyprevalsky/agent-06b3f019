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

import { useRealtimeSubscription } from '@/features/agent-context/hooks/useRealtimeSubscription';
import {
  CONNECTED_COMPLETION_BACKFILL_POLL_MS,
  CONNECTED_COMPLETION_BACKFILL_WINDOW_MS,
} from '@/features/agent-context/config';
import { computeActiveBrowserPanels } from '@/features/terminal/hooks/derivations';
import * as RealtimeMod from '@/lib/realtime';

describe('connected completion backfill', () => {
  beforeEach(() => {
    vi.mocked(RealtimeMod.subscribeToAgent).mockReset();
    vi.mocked(RealtimeMod.unsubscribe).mockReset();
    server.use(
      http.get(
        `${API_BASE}/benchmarks/agent-preview/:agentId`,
        () => new HttpResponse(null, { status: 404 }),
      ),
    );
  });

  it.each([
    { startDelayMs: 1_000, failFirstRead: false },
    { startDelayMs: CONNECTED_COMPLETION_BACKFILL_WINDOW_MS + 1_000, failFirstRead: false },
    { startDelayMs: CONNECTED_COMPLETION_BACKFILL_WINDOW_MS + 1_000, failFirstRead: true },
  ])(
    'recovers a missed browser terminal after completed chat: $startDelayMs ms, transient failure=$failFirstRead',
    async ({ startDelayMs, failFirstRead }) => {
      const user: Message = {
        message_id: 'user',
        timestamp: '2026-10-13T00:00:00Z',
        text: 'hello',
        role: 'USER',
      };
      const answer: Message = {
        message_id: 'answer',
        timestamp: '2026-10-13T00:00:01Z',
        text: 'done',
        role: 'ASSISTANT',
        metadata: { isUserAttentionMessage: true },
      };
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
      let phase: 'chat' | 'browser' | 'terminal' = 'chat';
      let calls = 0;
      let browserReads = 0;
      server.use(
        http.get(`${API_BASE}/agents/agent-1`, () => {
          calls += 1;
          if (phase !== 'chat') {
            browserReads += 1;
            if (failFirstRead && browserReads === 1) return new HttpResponse(null, { status: 500 });
          }
          return HttpResponse.json(
            agentDetailJson([
              user,
              answer,
              // The init broadcast can precede API snapshot visibility.
              ...(phase === 'chat' || browserReads === 1 ? [] : [start]),
              ...(phase === 'terminal' ? [terminal] : []),
            ]),
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
      vi.mocked(deps.setMessages).mockImplementation((update) => {
        messages = typeof update === 'function' ? update(messages) : update;
      });
      vi.useFakeTimers();
      try {
        const hook = renderHook(() => useRealtimeSubscription(deps));
        await vi.advanceTimersByTimeAsync(startDelayMs);
        const completedChatCalls = calls;
        await vi.advanceTimersByTimeAsync(2_000);
        expect(calls).toBe(completedChatCalls);
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
        await vi.advanceTimersByTimeAsync(1_000);
        expect(computeActiveBrowserPanels(messages)).toHaveLength(1);
        // Persist the terminal without delivering its broadcast.
        phase = 'terminal';
        await vi.advanceTimersByTimeAsync(2_500);
        expect(computeActiveBrowserPanels(messages)).toHaveLength(0);
        expect(messages.some((message) => message.message_id === terminal.message_id)).toBe(true);
        await vi.advanceTimersByTimeAsync(CONNECTED_COMPLETION_BACKFILL_WINDOW_MS + 5_000);
        const recoveredCalls = calls;
        await vi.advanceTimersByTimeAsync(5_000);
        expect(calls).toBe(recoveredCalls);
        expect(RealtimeMod.subscribeToAgent).toHaveBeenCalledTimes(1);
        hook.unmount();
      } finally {
        vi.useRealTimers();
      }
    },
  );

  // Regression (production semantic run 29807459093): the first authoritative
  // snapshot succeeded after the router/tool messages but before the canonical
  // final answer was persisted. The connected realtime channel then lost that
  // final INSERT, so the answer remained in the DB while the UI waited forever.
  // A successful but incomplete snapshot must keep reconciling until the latest
  // user turn has its canonical answer.
  it('continues connected backfill after an incomplete successful snapshot', async () => {
    let calls = 0;
    server.use(
      http.get(`${API_BASE}/agents/agent-1`, () => {
        calls += 1;
        const messages: Message[] = [
          { message_id: 'user', timestamp: '1', text: 'search', role: 'USER' },
          {
            message_id: 'search',
            timestamp: '2',
            text: '',
            role: 'TOOL',
            metadata: { toolName: 'web_search', toolStatus: 'FINISHED' },
          },
        ];
        if (calls >= 2) {
          messages.push({
            message_id: 'answer',
            timestamp: '3',
            text: 'RECOVERED FINAL',
            role: 'TOOL',
            metadata: {
              toolName: 'send_message_to_user',
              toolStatus: 'FINISHED',
              isUserAttentionMessage: true,
            },
          });
        }
        return HttpResponse.json(agentDetailJson(messages));
      }),
    );
    vi.mocked(RealtimeMod.subscribeToAgent).mockResolvedValue(fakeChannel());
    mockSession();
    const deps = makeDeps();
    vi.useFakeTimers();
    try {
      renderHook(() => useRealtimeSubscription(deps as never));
      await vi.advanceTimersByTimeAsync(CONNECTED_COMPLETION_BACKFILL_POLL_MS + 250);
    } finally {
      vi.useRealTimers();
    }
    expect(calls).toBeGreaterThanOrEqual(2);
    expect(deps.setMessages).toHaveBeenCalledTimes(2);
    expect(deps.initialLoadDoneRef.current).toBe('agent-1');
  });

  // Production run 38324164007: broadcasts timed out and nine snapshots
  // preceded the canonical answer. Reproduce the connected-channel path whose
  // reconciliation stopped before that answer was persisted.
  it('recovers a canonical answer after the connected snapshot burst ends', async () => {
    let calls = 0;
    server.use(
      http.get(`${API_BASE}/agents/agent-1`, () => {
        calls += 1;
        const messages: Message[] = [
          { message_id: 'user', timestamp: '1', text: 'search', role: 'USER' },
        ];
        if (calls >= 10) {
          messages.push({
            message_id: 'late-answer',
            timestamp: '2',
            text: 'RECOVERED LATE FINAL',
            role: 'TOOL',
            metadata: {
              toolName: 'send_message_to_user',
              toolStatus: 'FINISHED',
              isUserAttentionMessage: true,
            },
          });
        }
        return HttpResponse.json(agentDetailJson(messages));
      }),
    );
    vi.mocked(RealtimeMod.subscribeToAgent).mockResolvedValue(fakeChannel());
    mockSession();
    const deps = makeDeps();
    let messages: Message[] = [];
    vi.mocked(deps.setMessages).mockImplementation((update) => {
      messages = typeof update === 'function' ? update(messages) : update;
    });
    vi.useFakeTimers();
    try {
      const hook = renderHook(() => useRealtimeSubscription(deps as never));
      await vi.advanceTimersByTimeAsync(9_000);
      expect(messages).toEqual(
        expect.arrayContaining([expect.objectContaining({ message_id: 'late-answer' })]),
      );
      const callsAfterCompletion = calls;
      await vi.advanceTimersByTimeAsync(5_000);
      expect(calls).toBe(callsAfterCompletion);
      hook.unmount();
    } finally {
      vi.useRealTimers();
    }
  });

  it('stops recovery on the current turn failure while ignoring earlier and tool errors', async () => {
    let calls = 0;
    server.use(
      http.get(`${API_BASE}/agents/agent-1`, () => {
        calls += 1;
        const messages: Message[] = [
          { message_id: 'old-user', timestamp: '1', text: 'old', role: 'USER' },
          {
            message_id: 'old-error',
            timestamp: '2',
            text: 'failed',
            role: 'ASSISTANT',
            metadata: { error: true, source: 'chat_handler_failure' },
          },
          { message_id: 'new-user', timestamp: '3', text: 'new', role: 'USER' },
          {
            message_id: 'tool-error',
            timestamp: '4',
            text: 'retry',
            role: 'TOOL',
            metadata: { error: true },
          },
        ];
        if (calls >= 10)
          messages.push({
            message_id: 'new-error',
            timestamp: '5',
            text: 'failed',
            role: 'ASSISTANT',
            metadata: { error: true, source: 'chat_handler_failure' },
          });
        return HttpResponse.json(agentDetailJson(messages));
      }),
    );
    vi.mocked(RealtimeMod.subscribeToAgent).mockResolvedValue(fakeChannel());
    mockSession();
    const deps = makeDeps();
    let messages: Message[] = [];
    vi.mocked(deps.setMessages).mockImplementation((update) => {
      messages = typeof update === 'function' ? update(messages) : update;
    });
    vi.useFakeTimers();
    try {
      const hook = renderHook(() => useRealtimeSubscription(deps as never));
      await vi.advanceTimersByTimeAsync(9_000);
      expect(messages).toEqual(
        expect.arrayContaining([expect.objectContaining({ message_id: 'new-error' })]),
      );
      const stoppedCalls = calls;
      await vi.advanceTimersByTimeAsync(5_000);
      expect(calls).toBe(stoppedCalls);
      hook.unmount();
    } finally {
      vi.useRealTimers();
    }
  });

  it('bounds pending-turn recovery and preserves that bound across reconnects', async () => {
    let calls = 0;
    server.use(
      http.get(`${API_BASE}/agents/agent-1`, () => {
        calls += 1;
        return HttpResponse.json(
          agentDetailJson([
            { message_id: 'pending-user', timestamp: '1', text: 'search', role: 'USER' },
          ]),
        );
      }),
    );
    vi.mocked(RealtimeMod.subscribeToAgent).mockImplementation(async () => fakeChannel());
    mockSession();
    const deps = makeDeps();
    vi.useFakeTimers();
    try {
      const hook = renderHook(
        ({ counter }) =>
          useRealtimeSubscription({
            ...deps,
            forceResubscribeCounter: counter,
          }),
        { initialProps: { counter: 0 } },
      );
      await vi.advanceTimersByTimeAsync(CONNECTED_COMPLETION_BACKFILL_WINDOW_MS - 5_000);
      expect(calls).toBeGreaterThan(9);
      hook.rerender({ counter: 1 });
      await vi.advanceTimersByTimeAsync(10_000);
      const stoppedCalls = calls;
      await vi.advanceTimersByTimeAsync(CONNECTED_COMPLETION_BACKFILL_WINDOW_MS);
      expect(calls).toBe(stoppedCalls);
      hook.unmount();
    } finally {
      vi.useRealTimers();
    }
  });

  it('releases a hung connected snapshot and recovers on the next request', async () => {
    let calls = 0;
    let aborted = false;
    server.use(
      http.get(`${API_BASE}/agents/agent-1`, async ({ request }) => {
        calls += 1;
        if (calls === 1) {
          request.signal.addEventListener('abort', () => {
            aborted = true;
          });
          return new Promise<never>(() => {});
        }
        return HttpResponse.json(
          agentDetailJson([
            { message_id: 'user', timestamp: '1', text: 'search', role: 'USER' },
            {
              message_id: 'answer',
              timestamp: '2',
              text: 'recovered',
              role: 'ASSISTANT',
              metadata: { isUserAttentionMessage: true },
            },
          ]),
        );
      }),
    );
    vi.mocked(RealtimeMod.subscribeToAgent).mockResolvedValue(fakeChannel());
    mockSession();
    const deps = makeDeps();
    vi.useFakeTimers();
    try {
      const hook = renderHook(() => useRealtimeSubscription(deps as never));
      await vi.advanceTimersByTimeAsync(11_000);
      expect(aborted).toBe(true);
      expect(deps.initialLoadDoneRef.current).toBe('agent-1');
      const stoppedCalls = calls;
      await vi.advanceTimersByTimeAsync(5_000);
      expect(calls).toBe(stoppedCalls);
      hook.unmount();
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([-1, 1_000])(
    'recovers a new turn when reconnecting %ims from the previous lease expiry',
    async (offsetMs) => {
      let phase: 'completed' | 'pending' | 'answered' = 'completed';
      server.use(
        http.get(`${API_BASE}/agents/agent-1`, async () => {
          if (phase === 'pending') await new Promise((resolve) => setTimeout(resolve, 65));
          const messages: Message[] = [
            { message_id: 'old-user', timestamp: '1', text: 'old', role: 'USER' },
            {
              message_id: 'old-answer',
              timestamp: '2',
              text: 'done',
              role: 'ASSISTANT',
              metadata: { isUserAttentionMessage: true },
            },
          ];
          if (phase !== 'completed')
            messages.push({
              message_id: 'new-user',
              timestamp: '3',
              text: 'new',
              role: 'USER',
            });
          if (phase === 'answered')
            messages.push({
              message_id: 'new-answer',
              timestamp: '4',
              text: 'recovered',
              role: 'ASSISTANT',
              metadata: { isUserAttentionMessage: true },
            });
          return HttpResponse.json(agentDetailJson(messages));
        }),
      );
      vi.mocked(RealtimeMod.subscribeToAgent).mockImplementation(async () => fakeChannel());
      mockSession();
      const deps = makeDeps();
      let messages: Message[] = [];
      vi.mocked(deps.setMessages).mockImplementation((update) => {
        messages = typeof update === 'function' ? update(messages) : update;
      });
      vi.useFakeTimers();
      try {
        const hook = renderHook(
          ({ counter }) =>
            useRealtimeSubscription({
              ...deps,
              forceResubscribeCounter: counter,
            }),
          { initialProps: { counter: 0 } },
        );
        await vi.advanceTimersByTimeAsync(CONNECTED_COMPLETION_BACKFILL_WINDOW_MS + offsetMs);
        phase = 'pending';
        hook.rerender({ counter: 1 });
        await vi.advanceTimersByTimeAsync(8_000);
        phase = 'answered';
        await vi.advanceTimersByTimeAsync(2_500);
        expect(messages).toEqual(
          expect.arrayContaining([expect.objectContaining({ message_id: 'new-answer' })]),
        );
        hook.unmount();
      } finally {
        vi.useRealTimers();
      }
    },
  );
});
