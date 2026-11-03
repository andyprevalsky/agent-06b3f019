/** Selected-agent network and reconnect resources belong to the mounted view. */
import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useState } from 'react';
import type { AgentDetailResponse, Message } from '@/lib/api';
import { applyAgentBackfill } from '@/features/agent-context/hooks/agentBackfill';
import { agentDetailJson } from './realtime-subscription.fixtures';
import { fakeChannel, makeDeps, mockSession } from './realtime-subscription.fixtures';
import { useVisibilityReconnect } from '@/features/agent-context/hooks/useVisibilityReconnect';
vi.mock('@/lib/realtime', async (importOriginal) => {
  const mod = await importOriginal<typeof import('@/lib/realtime')>();
  return { ...mod, subscribeToAgent: vi.fn(), unsubscribe: vi.fn() };
});
import * as RealtimeMod from '@/lib/realtime';
import { useRealtimeSubscription } from '@/features/agent-context/hooks/useRealtimeSubscription';
type AgentHandlers = Parameters<typeof RealtimeMod.subscribeToAgent>[1];

it('does not rerender an unchanged 10,000-message snapshot and preserves actual updates', () => {
  let renders = 0;
  const { result, unmount } = renderHook(() => {
    renders += 1;
    const [messages, setMessages] = useState<Message[]>([]);
    return { messages, setMessages };
  });
  const messages: Message[] = Array.from({ length: 10_000 }, (_, index) => ({
    message_id: `row-${index}`,
    text: `Full message ${index}`,
    role: 'USER',
    timestamp: new Date(index * 1000).toISOString(),
    metadata: { hidden: false },
  }));
  const apply = (rows: Message[]) =>
    act(() =>
      applyAgentBackfill(
        agentDetailJson(rows) as AgentDetailResponse,
        result.current.setMessages,
        vi.fn(),
        vi.fn(),
      ),
    );
  try {
    apply(messages);
    const original = result.current.messages;
    // React can render once to discover the first no-op setter, then bails out.
    apply(structuredClone(messages));
    const settledRenders = renders;
    apply(structuredClone(messages));
    expect(renders).toBe(settledRenders);
    expect(result.current.messages).toBe(original);
    const updated = structuredClone(messages);
    updated[9_999].text = 'Updated message stays visible';
    apply(updated);
    expect(result.current.messages[9_999].text).toBe('Updated message stays visible');
    expect(result.current.messages[0]).toBe(original[0]);
  } finally {
    unmount();
  }
});

describe('selected-agent network ownership', () => {
  it('aborts snapshot and deferred-message downloads when their subscription unmounts', async () => {
    mockSession();
    let handlers: AgentHandlers = {};
    vi.mocked(RealtimeMod.subscribeToAgent).mockImplementation(async (_, incoming) => {
      handlers = incoming;
      return fakeChannel();
    });
    const signals: (AbortSignal | null | undefined)[] = [];
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation((_input, init) => {
      signals.push(init?.signal);
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener(
          'abort',
          () => reject(new DOMException('Aborted', 'AbortError')),
          { once: true },
        );
      });
    });
    const { unmount } = renderHook(() => useRealtimeSubscription(makeDeps()));
    try {
      await waitFor(() => expect(signals).toHaveLength(1));
      act(() =>
        handlers.onInsertDeferred?.({
          agentId: 'agent-1',
          id: 'large-message',
          timestamp: '2026-11-02T00:00:00Z',
          role: 'TOOL',
          reason: 'Large row',
          metadata: {},
        }),
      );
      expect(signals).toHaveLength(2);
      unmount();
      expect(signals.every((signal) => signal?.aborted)).toBe(true);
      await act(async () => {});
      expect(signals).toHaveLength(2);
    } finally {
      unmount();
      fetchSpy.mockRestore();
    }
  });
});

describe('visibility reconnect ownership', () => {
  it('coalesces repeated focus events and cancels delayed reconnect on switch and unmount', () => {
    vi.useFakeTimers();
    const channelRef = { current: null };
    const resubscribe = vi.fn();
    const { rerender, unmount } = renderHook(
      ({ agentId }) => useVisibilityReconnect(agentId, channelRef, resubscribe),
      { initialProps: { agentId: 'agent-a' } },
    );
    try {
      act(() => {
        window.dispatchEvent(new Event('focus'));
        window.dispatchEvent(new Event('focus'));
      });
      expect(vi.getTimerCount()).toBe(1);
      rerender({ agentId: 'agent-b' });
      act(() => vi.advanceTimersByTime(1000));
      expect(resubscribe).not.toHaveBeenCalled();
      act(() => window.dispatchEvent(new Event('focus')));
      unmount();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      unmount();
      vi.useRealTimers();
    }
  });

  it('does not reconnect a channel that joined while the focus delay was pending', () => {
    vi.useFakeTimers();
    const channelRef = { current: fakeChannel('closed') };
    const resubscribe = vi.fn();
    const { unmount } = renderHook(() =>
      useVisibilityReconnect('agent-a', channelRef, resubscribe),
    );
    try {
      act(() => window.dispatchEvent(new Event('focus')));
      channelRef.current = fakeChannel('joined');
      act(() => vi.advanceTimersByTime(1000));
      expect(resubscribe).not.toHaveBeenCalled();
    } finally {
      unmount();
      vi.useRealTimers();
    }
  });
});
