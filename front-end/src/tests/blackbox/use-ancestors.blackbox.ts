/**
 * Hub-archived GPs have parent_agent_id but GET /ancestors is empty (live CTE
 * misses torn-down bench rows). GET /tree and GET /agents/:parent already work
 * on prod — the trail must come from those, like live runs: parent > current.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { server } from './msw/server';
import { mockTerminalHookSession } from './terminal-hooks.fixtures';
import { useAncestors } from '@/features/terminal/hooks/useAncestors';
import { API_BASE_WITH_PATH } from '@/lib/api/client';

const API_BASE = API_BASE_WITH_PATH;
const GP = 'gp-creator-1';
const ROOT = 'root-creator-1';
const PARENT_GOAL = "I'm building a creator-brand for health";

describe('useAncestors (hub / archived sub-agents)', () => {
  beforeEach(() => {
    mockTerminalHookSession();
    server.use(
      http.get(`${API_BASE}/agents/:agentId/ancestors`, () => HttpResponse.json({ ancestors: [] })),
    );
  });
  afterEach(() => {
    localStorage.clear();
  });

  it('walks GET /tree when ancestors is empty so parent > current is clickable', async () => {
    server.use(
      http.get(`${API_BASE}/agents/tree`, ({ request }) => {
        const busId = new URL(request.url).searchParams.get('busId');
        expect(busId).toBe(ROOT);
        return HttpResponse.json({
          agents: [
            {
              agent_id: ROOT,
              parent_agent_id: null,
              goal: PARENT_GOAL,
              status: 'COMPLETED',
              progress: 100,
              tools_in_use: [],
              message_count: 2,
              tree_cost_cents: 0,
            },
            {
              agent_id: GP,
              parent_agent_id: ROOT,
              goal: 'You are analyzing ONE creator',
              status: 'COMPLETED',
              progress: 100,
              tools_in_use: [],
              message_count: 4,
              tree_cost_cents: 0,
            },
          ],
        });
      }),
    );

    const { result, unmount } = renderHook(() => useAncestors(GP, ROOT, null));
    await waitFor(() => expect(result.current.length).toBe(1));
    expect(result.current[0]).toEqual({
      id: ROOT,
      goal: PARENT_GOAL,
    });
    unmount();
  });

  it('falls back to GET parent agent when tree is empty too', async () => {
    server.use(
      http.get(`${API_BASE}/agents/tree`, () => HttpResponse.json({ agents: [] })),
      http.get(`${API_BASE}/agents/${ROOT}`, () =>
        HttpResponse.json({
          agent: {
            agent_id: ROOT,
            goal: PARENT_GOAL,
            parent_agent_id: null,
          },
          messages: [],
        }),
      ),
    );

    const { result, unmount } = renderHook(() => useAncestors(GP, ROOT, null));
    await waitFor(() => expect(result.current.length).toBe(1));
    expect(result.current[0].id).toBe(ROOT);
    expect(result.current[0].goal).toContain('creator-brand');
    unmount();
  });

  it('uses parent_goal without another fetch when the API already has it', async () => {
    const { result, unmount } = renderHook(() => useAncestors(GP, ROOT, PARENT_GOAL));
    await waitFor(() => expect(result.current.length).toBe(1));
    expect(result.current[0]).toEqual({
      id: ROOT,
      goal: PARENT_GOAL,
    });
    unmount();
  });

  it('does not replace the new agent breadcrumb with a late ancestor fallback', async () => {
    let treeRequestStarted!: () => void;
    const treeStarted = new Promise<void>((resolve) => {
      treeRequestStarted = resolve;
    });
    let finishOldTree!: () => void;
    const oldTreeCanFinish = new Promise<void>((resolve) => {
      finishOldTree = resolve;
    });
    server.use(
      http.get(`${API_BASE}/agents/:agentId/ancestors`, ({ params }) => {
        if (params.agentId === 'new-agent') {
          return HttpResponse.json({
            ancestors: [{ id: 'new-parent', goal: 'NEW AGENT PARENT' }],
          });
        }
        return HttpResponse.json({ ancestors: [] });
      }),
      http.get(`${API_BASE}/agents/tree`, async () => {
        treeRequestStarted();
        await oldTreeCanFinish;
        return HttpResponse.json({
          agents: [
            {
              agent_id: 'old-parent',
              parent_agent_id: null,
              goal: 'OLD AGENT PARENT',
              status: 'COMPLETED',
              progress: 100,
              tools_in_use: [],
              message_count: 1,
              tree_cost_cents: 0,
            },
            {
              agent_id: 'old-agent',
              parent_agent_id: 'old-parent',
              goal: 'old child',
              status: 'COMPLETED',
              progress: 100,
              tools_in_use: [],
              message_count: 1,
              tree_cost_cents: 0,
            },
          ],
        });
      }),
    );

    const { result, rerender, unmount } = renderHook(
      ({ agentId, parentId }: { agentId: string; parentId: string }) =>
        useAncestors(agentId, parentId, null),
      { initialProps: { agentId: 'old-agent', parentId: 'old-parent' } },
    );
    await treeStarted;
    rerender({ agentId: 'new-agent', parentId: 'new-parent' });
    await waitFor(() => expect(result.current[0]?.goal).toBe('NEW AGENT PARENT'));

    await act(async () => {
      finishOldTree();
      await oldTreeCanFinish;
      await Promise.resolve();
    });
    expect(result.current).toEqual([{ id: 'new-parent', goal: 'NEW AGENT PARENT' }]);
    unmount();
  });

  it('fetches a root agent ancestors once when its detail loads (undefined -> null parent)', async () => {
    const requested: string[] = [];
    server.use(
      http.get(`${API_BASE}/agents/:agentId/ancestors`, ({ params }) => {
        requested.push(String(params.agentId));
        return HttpResponse.json({ ancestors: [] });
      }),
    );
    // Navigation selects the agent before its detail arrives (parent fields
    // undefined); the loaded root detail then reports them as null.
    const { result, rerender, unmount } = renderHook(
      ({ parentId, goal }: { parentId?: string | null; goal?: string | null }) =>
        useAncestors(ROOT, parentId, goal),
      {
        initialProps: { parentId: undefined, goal: undefined } as {
          parentId?: string | null;
          goal?: string | null;
        },
      },
    );
    await waitFor(() => expect(requested).toEqual([ROOT]));
    rerender({ parentId: null, goal: null });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    expect(requested).toEqual([ROOT]);
    expect(result.current).toEqual([]);
    unmount();
  });
});
