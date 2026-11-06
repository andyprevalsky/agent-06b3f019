/**
 * Opening a trajectory: the selection's GET /agents/:id is still downloading
 * while the realtime join is pending. The disconnected backfill's fast poll
 * must not start a second identical full-trajectory read beside it (on a
 * 600 KB trajectory that is another download, JSON parse and message merge on
 * a phone), nor repeat it on the tick right after it lands. Afterwards the
 * poll resumes as before.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';

import { server } from './msw/server';
import { mockTerminalHookSession } from './terminal-hooks.fixtures';
import { API_BASE_WITH_PATH } from '@/lib/api/client';
import { agentDetailSucceededAt, fetchAgentDetail } from '@/features/agent-context/api';
import { DISCONNECTED_BACKFILL_FAST_POLL_MS } from '@/features/agent-context/config';
import { useDisconnectedAgentBackfill } from '@/features/agent-context/hooks/useDisconnectedAgentBackfill';
import type { RealtimeSubscriptionDeps } from '@/features/agent-context/hooks/useRealtimeSubscription';

const AGENT = 'agent-open-1';

function disconnectedDeps(): RealtimeSubscriptionDeps {
  return {
    selectedAgentId: AGENT,
    selectedAgentIdRef: { current: AGENT },
    canSubscribe: true,
    channelRef: { current: null },
    setMessages: vi.fn(),
    setAgent: vi.fn(),
    setIsChatMode: vi.fn(),
  } as unknown as RealtimeSubscriptionDeps;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('disconnected backfill does not duplicate the selection detail read', () => {
  let requests = 0;
  let release: () => void = () => {};

  beforeEach(() => {
    mockTerminalHookSession();
    requests = 0;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    server.use(
      http.get(`${API_BASE_WITH_PATH}/agents/${AGENT}`, async () => {
        requests += 1;
        // Only the first (selection) read is slow; later polls answer at once.
        if (requests === 1) await gate;
        return HttpResponse.json({
          agent: { agent_id: AGENT, status: 'COMPLETED', temporal_workflow_id: null },
          messages: [],
        });
      }),
    );
  });

  afterEach(() => {
    release();
    localStorage.clear();
  });

  it('skips poll ticks while the selection read is in flight, then polls again', async () => {
    const selectionRead = fetchAgentDetail(AGENT);
    await waitFor(() => expect(requests).toBe(1));
    const deps = disconnectedDeps();
    const { unmount } = renderHook(() => useDisconnectedAgentBackfill(deps));

    // Three fast ticks pass while the selection read is still downloading.
    await sleep(DISCONNECTED_BACKFILL_FAST_POLL_MS * 3 + 100);
    expect(requests).toBe(1);

    release();
    await selectionRead;
    const landedAt = agentDetailSucceededAt(AGENT);
    expect(landedAt).not.toBeNull();
    // Still disconnected: a later tick reconciles from the API as before, but
    // not one that falls within a fast tick of the read that just landed.
    await waitFor(() => expect(requests).toBe(2), { timeout: 2000 });
    expect(Date.now() - (landedAt ?? 0)).toBeGreaterThanOrEqual(DISCONNECTED_BACKFILL_FAST_POLL_MS);
    await waitFor(() => expect(deps.setMessages).toHaveBeenCalled());
    unmount();
  });
});
