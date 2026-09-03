import { act, renderHook, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { server } from './msw/server';

vi.mock('@/lib/realtime', async (importOriginal) => {
  const mod = await importOriginal<typeof import('@/lib/realtime')>();
  return { ...mod, subscribeToBus: vi.fn(), unsubscribe: vi.fn() };
});

import { useAgentTree } from '@/hooks/useAgentTree';
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
        status: 'ACTIVE',
        progress: 0.5,
        toolsInUse: [],
        messageCount: 1,
        costCents: 1,
      });
    });
    expect(result.current.get('root')?.goal).toBe('newer realtime state');

    releaseSnapshot();
    await snapshotReturned;
    await waitFor(() => expect(result.current.has('snapshot-only')).toBe(true));
    expect(result.current.get('root')?.goal).toBe('newer realtime state');
    unmount();
  });
});
