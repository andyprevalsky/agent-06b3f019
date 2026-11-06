import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/features/agent-context/api', () => ({
  fetchAgentDetail: vi.fn(),
}));

import { fetchAgentDetail } from '@/features/agent-context/api';
import {
  DISCONNECTED_BACKFILL_POLL_MS,
  DISCONNECTED_BACKFILL_REQUEST_TIMEOUT_MS,
} from '@/features/agent-context/config';
import { useDisconnectedAgentBackfill } from '@/features/agent-context/hooks/useDisconnectedAgentBackfill';
import type { RealtimeSubscriptionDeps } from '@/features/agent-context/hooks/useRealtimeSubscription';

function disconnectedDeps(): RealtimeSubscriptionDeps {
  return {
    selectedAgentId: 'agent-a',
    selectedAgentIdRef: { current: 'agent-a' },
    canSubscribe: true,
    channelRef: { current: null },
    setMessages: vi.fn(),
    setAgent: vi.fn(),
    setIsChatMode: vi.fn(),
  } as unknown as RealtimeSubscriptionDeps;
}

describe('disconnected agent backfill timeout', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('allows a later poll when the previous detail request never settles', async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.mocked(fetchAgentDetail).mockImplementation(() => new Promise(() => {}));
    const deps = disconnectedDeps();
    const { unmount } = renderHook(() => useDisconnectedAgentBackfill(deps));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(
        DISCONNECTED_BACKFILL_POLL_MS +
          DISCONNECTED_BACKFILL_REQUEST_TIMEOUT_MS +
          DISCONNECTED_BACKFILL_POLL_MS +
          1,
      );
    });

    expect(fetchAgentDetail).toHaveBeenCalledTimes(2);
    expect(vi.mocked(fetchAgentDetail).mock.calls[0]?.[1]?.aborted).toBe(true);
    unmount();
  });

  it('discards a detail payload whose agent identity differs from the requested agent', async () => {
    vi.useFakeTimers();
    vi.mocked(fetchAgentDetail).mockResolvedValue({
      agent: { agent_id: 'agent-b' },
      messages: [{ message_id: 'foreign-message' }],
    } as Awaited<ReturnType<typeof fetchAgentDetail>>);
    const deps = disconnectedDeps();
    const { unmount } = renderHook(() => useDisconnectedAgentBackfill(deps));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(DISCONNECTED_BACKFILL_POLL_MS + 1);
    });

    expect(deps.setAgent).not.toHaveBeenCalled();
    expect(deps.setMessages).not.toHaveBeenCalled();
    expect(deps.setIsChatMode).not.toHaveBeenCalled();
    unmount();
  });
});
