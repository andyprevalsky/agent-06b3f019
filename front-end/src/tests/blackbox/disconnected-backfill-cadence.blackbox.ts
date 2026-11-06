import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/features/agent-context/api', () => ({
  fetchAgentDetail: vi.fn(),
  // The read registry lives beside fetchAgentDetail; with it mocked no other
  // read is ever in flight or fresh, so every tick is decided by cadence alone.
  hasRecentAgentDetailRead: vi.fn(() => false),
  agentDetailSucceededAt: vi.fn(() => null),
}));

import { agentDetailSucceededAt, fetchAgentDetail } from '@/features/agent-context/api';
import {
  DISCONNECTED_BACKFILL_FAST_POLL_MS,
  DISCONNECTED_BACKFILL_FAST_WINDOW_MS,
  DISCONNECTED_BACKFILL_POLL_MS,
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

async function advance(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

const FAST_POLLS = DISCONNECTED_BACKFILL_FAST_WINDOW_MS / DISCONNECTED_BACKFILL_FAST_POLL_MS;

describe('disconnected agent backfill cadence', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.mocked(fetchAgentDetail).mockReset();
    vi.mocked(agentDetailSucceededAt).mockReset();
    vi.mocked(agentDetailSucceededAt).mockReturnValue(null);
  });

  it('polls every 300ms for the first 3s after selection, then every 2s', async () => {
    expect(DISCONNECTED_BACKFILL_FAST_POLL_MS).toBe(300);
    expect(DISCONNECTED_BACKFILL_FAST_WINDOW_MS).toBe(3000);
    expect(DISCONNECTED_BACKFILL_POLL_MS).toBe(2000);
    vi.useFakeTimers();
    vi.mocked(fetchAgentDetail).mockResolvedValue({
      agent: { agent_id: 'agent-a', temporal_workflow_id: null },
      messages: [],
    } as unknown as Awaited<ReturnType<typeof fetchAgentDetail>>);
    const deps = disconnectedDeps();
    const { unmount } = renderHook(() => useDisconnectedAgentBackfill(deps));

    await advance(DISCONNECTED_BACKFILL_FAST_POLL_MS - 1);
    expect(fetchAgentDetail).toHaveBeenCalledTimes(0);
    await advance(1);
    expect(fetchAgentDetail).toHaveBeenCalledTimes(1);

    await advance(DISCONNECTED_BACKFILL_FAST_WINDOW_MS - DISCONNECTED_BACKFILL_FAST_POLL_MS);
    expect(fetchAgentDetail).toHaveBeenCalledTimes(FAST_POLLS);

    await advance(DISCONNECTED_BACKFILL_POLL_MS - 1);
    expect(fetchAgentDetail).toHaveBeenCalledTimes(FAST_POLLS);
    await advance(1);
    expect(fetchAgentDetail).toHaveBeenCalledTimes(FAST_POLLS + 1);
    await advance(DISCONNECTED_BACKFILL_POLL_MS);
    expect(fetchAgentDetail).toHaveBeenCalledTimes(FAST_POLLS + 2);
    expect(deps.setMessages).toHaveBeenCalledTimes(FAST_POLLS + 2);
    unmount();
  });

  it('restarts the fast window when a different agent is selected', async () => {
    vi.useFakeTimers();
    vi.mocked(fetchAgentDetail).mockImplementation(
      async (agentId: string) =>
        ({
          agent: { agent_id: agentId, temporal_workflow_id: null },
          messages: [],
        }) as unknown as Awaited<ReturnType<typeof fetchAgentDetail>>,
    );
    const deps = disconnectedDeps();
    const { rerender, unmount } = renderHook(
      (props: RealtimeSubscriptionDeps) => useDisconnectedAgentBackfill(props),
      { initialProps: deps },
    );
    await advance(DISCONNECTED_BACKFILL_FAST_WINDOW_MS + DISCONNECTED_BACKFILL_POLL_MS);
    vi.mocked(fetchAgentDetail).mockClear();

    deps.selectedAgentIdRef.current = 'agent-b';
    rerender({ ...deps, selectedAgentId: 'agent-b' });
    await advance(DISCONNECTED_BACKFILL_FAST_WINDOW_MS);

    expect(fetchAgentDetail).toHaveBeenCalledTimes(FAST_POLLS);
    expect(vi.mocked(fetchAgentDetail).mock.calls.every(([id]) => id === 'agent-b')).toBe(true);
    unmount();
  });

  it('skips every fast tick while the realtime channel is connected', async () => {
    vi.useFakeTimers();
    const deps = disconnectedDeps();
    (deps.channelRef as { current: unknown }).current = { topic: 'agent:agent-a' };
    const { unmount } = renderHook(() => useDisconnectedAgentBackfill(deps));

    await advance(DISCONNECTED_BACKFILL_FAST_WINDOW_MS + DISCONNECTED_BACKFILL_POLL_MS);

    expect(fetchAgentDetail).not.toHaveBeenCalled();
    unmount();
  });

  it('skips a tick right after another read of the agent succeeded, then polls on the next', async () => {
    vi.useFakeTimers();
    vi.mocked(fetchAgentDetail).mockResolvedValue({
      agent: { agent_id: 'agent-a', temporal_workflow_id: null },
      messages: [],
    } as unknown as Awaited<ReturnType<typeof fetchAgentDetail>>);
    const deps = disconnectedDeps();
    const { unmount } = renderHook(() => useDisconnectedAgentBackfill(deps));

    // The selection's own detail read lands just before the first fast tick.
    await advance(DISCONNECTED_BACKFILL_FAST_POLL_MS - 50);
    vi.mocked(agentDetailSucceededAt).mockReturnValue(Date.now());
    await advance(50);
    expect(fetchAgentDetail).not.toHaveBeenCalled();

    // One fast tick later those rows are no longer fresh: poll as before.
    await advance(DISCONNECTED_BACKFILL_FAST_POLL_MS);
    expect(fetchAgentDetail).toHaveBeenCalledTimes(1);
    expect(deps.setMessages).toHaveBeenCalledTimes(1);
    unmount();
  });
});
