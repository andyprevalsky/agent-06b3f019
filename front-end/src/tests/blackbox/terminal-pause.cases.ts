import { act, renderHook, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { expect, it, vi, type Mock } from 'vitest';
import { pauseAgent as sendPause, type AgentDetailResponse, type Message } from '@/lib/api';
import type { TerminalView } from '@/features/terminal/types';
import { useTerminalAgents } from '@/features/terminal/hooks/useTerminalAgents';
import { useTerminalDerivedState } from '@/features/terminal/components/terminalLayoutState';
import { server } from './msw/server';
import {
  makeTerminalHookAgent as makeAgent,
  mockTerminalHookSession as mockSession,
} from './terminal-hooks.fixtures';
import pauseTranscript from './browser-pause-1a3d.fixture.json';

interface Args {
  ctxState: {
    agent: unknown;
    selectedAgentId: string | null;
    messages: Message[];
    applyAgentDetail: Mock<(id: string, data: AgentDetailResponse) => boolean>;
  };
  setCurrentView: (view: TerminalView) => void;
  resetAnimationState: () => void;
}
const API_BASE = 'http://localhost:3001/api';

export function terminalPauseCases({ ctxState, setCurrentView, resetAnimationState }: Args) {
  it.each([200, 500])(
    'optimistically closes the browser and pauses its owner before HTTP %s',
    async (status) => {
      mockSession();
      const agent = makeAgent();
      ctxState.agent = agent;
      ctxState.selectedAgentId = agent.agent_id;
      // Captured production init, before either cleanup/terminal event arrives.
      ctxState.messages = pauseTranscript.slice(0, 1) as Message[];
      let release = () => {};
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      server.use(
        http.post(`${API_BASE}/agents/:agentId/pause`, async () => {
          await gate;
          return HttpResponse.json({ success: status === 200 }, { status });
        }),
        http.get(`${API_BASE}/agents/:agentId`, () =>
          HttpResponse.json({
            agent: { ...agent, status: 'PAUSED' },
            messages: ctxState.messages,
            pagination: { has_more: false, oldest_timestamp: null },
          }),
        ),
      );
      ctxState.applyAgentDetail.mockImplementation((_id, data) => {
        ctxState.agent = data.agent;
        return true;
      });
      const view = renderHook(() => {
        const agents = useTerminalAgents('agents', setCurrentView, resetAnimationState);
        return { agents, derived: useTerminalDerivedState(agents) };
      });
      expect(view.result.current.derived.browserStatusProps?.browsers).toHaveLength(1);
      let pending = Promise.resolve();
      act(() => {
        pending = view.result.current.agents.handlePauseAgent();
      });
      try {
        expect(view.result.current.agents.agentDetail?.status).toBe('PAUSED');
        expect(view.result.current.derived.browserStatusProps).toBeNull();
        // Canonical history and server state must remain untouched while pending.
        expect(ctxState.agent).toBe(agent);
        expect(ctxState.messages).toHaveLength(1);
        // Selection changes and canonical terminal events outrank old user intent.
        ctxState.selectedAgentId = 'other';
        ctxState.agent = makeAgent({ agent_id: 'other' });
        view.rerender();
        expect(view.result.current.agents.isPausing).toBe(false);
        expect(view.result.current.agents.agentDetail?.status).toBe('ACTIVE');
        ctxState.selectedAgentId = agent.agent_id;
        ctxState.agent = { ...agent, status: 'COMPLETED' };
        view.rerender();
        expect(view.result.current.agents.agentDetail?.status).toBe('COMPLETED');
        ctxState.agent = agent;
        view.rerender();
        expect(view.result.current.agents.agentDetail?.status).toBe('PAUSED');
      } finally {
        release();
        await act(async () => pending);
      }
      expect(view.result.current.agents.agentDetail?.status).toBe(
        status === 200 ? 'PAUSED' : 'ACTIVE',
      );
      expect(view.result.current.derived.browserStatusProps === null).toBe(status === 200);
      view.unmount();
      ctxState.messages = [];
      ctxState.applyAgentDetail.mockImplementation(() => true);
    },
  );

  it.each([500, 200])(
    'keeps an accepted pause when detail refresh is HTTP %s with stale ACTIVE',
    async (status) => {
      const agent = makeAgent();
      ctxState.agent = agent;
      ctxState.selectedAgentId = agent.agent_id;
      ctxState.messages = pauseTranscript.slice(0, 1) as Message[];
      server.use(
        http.post(`${API_BASE}/agents/:agentId/pause`, () => HttpResponse.json({ success: true })),
        http.get(`${API_BASE}/agents/:agentId`, () =>
          HttpResponse.json(
            {
              agent,
              messages: ctxState.messages,
              pagination: { has_more: false, oldest_timestamp: null },
            },
            { status },
          ),
        ),
      );
      const view = renderHook(() => {
        const agents = useTerminalAgents('agents', setCurrentView, resetAnimationState);
        return { agents, derived: useTerminalDerivedState(agents) };
      });
      await act(async () => view.result.current.agents.handlePauseAgent());
      expect(view.result.current.agents.agentDetail?.status).toBe('PAUSED');
      expect(view.result.current.derived.browserStatusProps).toBeNull();
      // A later canonical pause reconciles intent; a subsequent resume is visible.
      ctxState.agent = { ...agent, status: 'PAUSED' };
      view.rerender();
      ctxState.agent = agent;
      view.rerender();
      expect(view.result.current.agents.agentDetail?.status).toBe('ACTIVE');
      view.unmount();
    },
  );

  it('preserves concurrent pause ownership across A/B/A and out-of-order failure', async () => {
    const a = makeAgent();
    const b = makeAgent({ agent_id: 'agent-b' });
    ctxState.agent = a;
    ctxState.selectedAgentId = a.agent_id;
    const releases = new Map<string, () => void>();
    server.use(
      http.post(`${API_BASE}/agents/:agentId/pause`, async ({ params }) => {
        await new Promise<void>((resolve) => releases.set(String(params.agentId), resolve));
        return HttpResponse.json({ error: 'rejected' }, { status: 500 });
      }),
    );
    const view = renderHook(() => useTerminalAgents('agents', setCurrentView, resetAnimationState));
    let first = Promise.resolve();
    let second = Promise.resolve();
    act(() => {
      first = view.result.current.handlePauseAgent();
    });
    await waitFor(() => expect(releases.has(a.agent_id)).toBe(true));
    ctxState.agent = b;
    ctxState.selectedAgentId = b.agent_id;
    view.rerender();
    act(() => {
      second = view.result.current.handlePauseAgent();
    });
    await waitFor(() => expect(releases.has(b.agent_id)).toBe(true));
    ctxState.agent = a;
    ctxState.selectedAgentId = a.agent_id;
    view.rerender();
    try {
      expect(view.result.current.agentDetail?.status).toBe('PAUSED');
      releases.get(b.agent_id)?.();
      await act(async () => second);
      expect(view.result.current.agentDetail?.status).toBe('PAUSED');
    } finally {
      releases.get(a.agent_id)?.();
      releases.get(b.agent_id)?.();
      await act(async () => Promise.all([first, second]));
    }
    expect(view.result.current.agentDetail?.status).toBe('ACTIVE');
    view.unmount();
  });
  it('uses newer list status for both views without making terminal status sticky', async () => {
    const agent = makeAgent();
    ctxState.agent = agent;
    ctxState.selectedAgentId = agent.agent_id;
    let listed = agent;
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    server.use(
      http.get(`${API_BASE}/agents`, () => HttpResponse.json({ agents: [listed] })),
      http.post(`${API_BASE}/agents/:agentId/pause`, async () => {
        await gate;
        return HttpResponse.json({ error: 'rejected' }, { status: 500 });
      }),
    );
    const view = renderHook(() => useTerminalAgents('agents', setCurrentView, resetAnimationState));
    let pending = Promise.resolve();
    act(() => {
      pending = view.result.current.handlePauseAgent();
    });
    try {
      listed = { ...agent, status: 'COMPLETED', updated_at: '2026-01-01T00:00:02Z' };
      await act(async () => view.result.current.loadAgents());
      expect(view.result.current.agentDetail?.status).toBe('COMPLETED');
      expect(view.result.current.agents[0].status).toBe('COMPLETED');
    } finally {
      release();
      await act(async () => pending);
    }
    listed = { ...agent, status: 'ACTIVE', updated_at: '2026-01-01T00:00:03Z' };
    await act(async () => view.result.current.loadAgents());
    expect(view.result.current.agentDetail?.status).toBe('ACTIVE');
    expect(view.result.current.agents[0].status).toBe('ACTIVE');
    view.unmount();
  });

  it.each(['invalid', ''])(
    'preserves detail status when list timestamp is %s',
    async (updated_at) => {
      const agent = makeAgent();
      ctxState.agent = agent;
      ctxState.selectedAgentId = agent.agent_id;
      server.use(
        http.get(`${API_BASE}/agents`, () =>
          HttpResponse.json({ agents: [{ ...agent, status: 'COMPLETED', updated_at }] }),
        ),
      );
      const view = renderHook(() =>
        useTerminalAgents('agents', setCurrentView, resetAnimationState),
      );
      await act(async () => view.result.current.loadAgents());
      expect(view.result.current.agentDetail?.status).toBe('ACTIVE');
      view.unmount();
    },
  );

  it('reconciles an external resume revision without seeing PAUSED or trusting unrelated updates', async () => {
    const agent = makeAgent({ user_control_revision: 0 });
    ctxState.agent = agent;
    ctxState.selectedAgentId = agent.agent_id;
    let pauses = 0;
    server.use(
      http.post(`${API_BASE}/agents/:agentId/pause`, () =>
        HttpResponse.json({ success: true, user_control_revision: ++pauses * 2 - 1 }),
      ),
      http.get(`${API_BASE}/agents/:agentId`, () =>
        HttpResponse.json({
          agent,
          messages: [],
          pagination: { has_more: false, oldest_timestamp: null },
        }),
      ),
    );
    const view = renderHook(() => useTerminalAgents('agents', setCurrentView, resetAnimationState));
    await act(async () => view.result.current.handlePauseAgent());
    expect(view.result.current.agentDetail?.status).toBe('PAUSED');
    ctxState.agent = {
      ...agent,
      user_control_revision: 1,
      updated_at: '2026-01-01T00:00:04Z',
      token_count: 500,
    };
    view.rerender();
    expect(view.result.current.agentDetail?.status).toBe('PAUSED');
    // Resume may already be followed by ordinary worker status/token updates.
    ctxState.agent = {
      ...agent,
      user_control_revision: 2,
      updated_at: '2026-01-01T00:00:05Z',
      status_message: 'Working',
    };
    view.rerender();
    await waitFor(() => expect(view.result.current.agentDetail?.status).toBe('ACTIVE'));
    await act(async () => view.result.current.handlePauseAgent());
    expect(pauses).toBe(2);
    expect(view.result.current.agentDetail?.status).toBe('PAUSED');
    view.unmount();
  });

  it('keeps an HTTP-accepted pause when optional acknowledgment metadata is unreadable', async () => {
    const agent = makeAgent();
    ctxState.agent = agent;
    ctxState.selectedAgentId = agent.agent_id;
    server.use(
      http.post(
        `${API_BASE}/agents/:agentId/pause`,
        () => new HttpResponse('incomplete-json', { status: 200 }),
      ),
      http.get(`${API_BASE}/agents/:agentId`, () =>
        HttpResponse.json({ error: 'temporarily unavailable' }, { status: 503 }),
      ),
    );
    const view = renderHook(() => useTerminalAgents('agents', setCurrentView, resetAnimationState));
    await act(async () => view.result.current.handlePauseAgent());
    expect(view.result.current.agentDetail?.status).toBe('PAUSED');
    view.unmount();
  });

  it.each([true, false])(
    'keeps ACK revision 3 across delayed PAUSED 1 and ACTIVE 2 (refresh=%s)',
    async (refresh) => {
      const agent = makeAgent({ user_control_revision: 0 });
      ctxState.agent = agent;
      ctxState.selectedAgentId = agent.agent_id;
      ctxState.applyAgentDetail.mockImplementation((_id, data) => {
        ctxState.agent = data.agent;
        return true;
      });
      server.use(
        http.post(`${API_BASE}/agents/:agentId/pause`, () =>
          HttpResponse.json({ success: true, user_control_revision: 3 }),
        ),
        http.get(`${API_BASE}/agents/:agentId`, () =>
          HttpResponse.json(
            {
              agent: { ...agent, status: 'PAUSED', user_control_revision: 1 },
              messages: [],
              pagination: { has_more: false, oldest_timestamp: null },
            },
            { status: refresh ? 200 : 503 },
          ),
        ),
      );
      const view = renderHook(() =>
        useTerminalAgents('agents', setCurrentView, resetAnimationState),
      );
      try {
        await act(async () => view.result.current.handlePauseAgent());
        ctxState.agent = { ...agent, status: 'PAUSED', user_control_revision: 1 };
        view.rerender();
        ctxState.agent = { ...agent, status: 'ACTIVE', user_control_revision: 2 };
        view.rerender();
        expect(view.result.current.agentDetail?.status).toBe('PAUSED');
        ctxState.agent = { ...agent, status: 'PAUSED', user_control_revision: 3 };
        view.rerender();
        ctxState.agent = { ...agent, status: 'ACTIVE', user_control_revision: 4 };
        view.rerender();
        expect(view.result.current.agentDetail?.status).toBe('ACTIVE');
      } finally {
        view.unmount();
        ctxState.applyAgentDetail.mockImplementation(() => true);
      }
    },
  );

  it('keeps newer canonical control revision when a stale list row has a later timestamp', async () => {
    const agent = makeAgent({ status: 'PAUSED', user_control_revision: 3 });
    ctxState.agent = agent;
    ctxState.selectedAgentId = agent.agent_id;
    server.use(
      http.get(`${API_BASE}/agents`, () =>
        HttpResponse.json({
          agents: [
            {
              ...agent,
              status: 'ACTIVE',
              user_control_revision: 2,
              updated_at: '2099-01-01T00:00:00Z',
            },
          ],
        }),
      ),
    );
    const view = renderHook(() => useTerminalAgents('agents', setCurrentView, resetAnimationState));
    await act(async () => view.result.current.loadAgents());
    expect(view.result.current.agentDetail?.status).toBe('PAUSED');
    expect(view.result.current.agents[0].status).toBe('PAUSED');
    view.unmount();
  });

  it('keeps a revisionless accepted pause across an old credit state until PAUSED is observed', async () => {
    const agent = makeAgent({ status: 'OUT_OF_CREDITS' });
    ctxState.agent = agent;
    ctxState.selectedAgentId = agent.agent_id;
    server.use(
      http.post(`${API_BASE}/agents/:agentId/pause`, () => HttpResponse.json({ success: true })),
      http.get(`${API_BASE}/agents/:agentId`, () =>
        HttpResponse.json({ error: 'unavailable' }, { status: 503 }),
      ),
    );
    const view = renderHook(() => useTerminalAgents('agents', setCurrentView, resetAnimationState));
    await act(async () => view.result.current.handlePauseAgent());
    ctxState.agent = { ...agent, status: 'ACTIVE' };
    view.rerender();
    expect(view.result.current.agentDetail?.status).toBe('PAUSED');
    ctxState.agent = { ...agent, status: 'PAUSED' };
    view.rerender();
    ctxState.agent = { ...agent, status: 'ACTIVE' };
    view.rerender();
    expect(view.result.current.agentDetail?.status).toBe('ACTIVE');
    view.unmount();
  });

  it('keeps canonical control ordering when a legacy cached list omits its revision', async () => {
    const agent = makeAgent({ status: 'PAUSED', user_control_revision: 3 });
    ctxState.agent = agent;
    ctxState.selectedAgentId = agent.agent_id;
    server.use(
      http.get(`${API_BASE}/agents`, () =>
        HttpResponse.json({
          agents: [
            {
              ...agent,
              status: 'ACTIVE',
              user_control_revision: undefined,
              updated_at: '2099-01-01T00:00:00Z',
            },
          ],
        }),
      ),
    );
    const view = renderHook(() => useTerminalAgents('agents', setCurrentView, resetAnimationState));
    await act(async () => view.result.current.loadAgents());
    expect(view.result.current.agentDetail?.user_control_revision).toBe(3);
    expect(view.result.current.agentDetail?.status).toBe('PAUSED');
    view.unmount();
  });
  it('accepts successful pause headers when the optional response body never ends', async () => {
    vi.useFakeTimers();
    let body: ReadableStreamDefaultController<Uint8Array> | undefined;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        body = controller;
        controller.enqueue(new TextEncoder().encode('{"success":'));
      },
    });
    let responseSent = false;
    server.use(
      http.post(`${API_BASE}/agents/:agentId/pause`, () => {
        responseSent = true;
        return new HttpResponse(stream, {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }),
    );
    let accepted = false;
    const pending = sendPause('stalled-body').then(() => {
      accepted = true;
    });
    try {
      await vi.advanceTimersByTimeAsync(10_000);
      expect(responseSent).toBe(true);
      expect(accepted).toBe(true);
    } finally {
      try {
        body?.close();
      } catch {
        /* An aborted stream may already be closed. */
      }
      await pending;
      vi.useRealTimers();
    }
  });
}
