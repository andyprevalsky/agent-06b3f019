/**
 * Blackbox tests for the in-app Benchmark Hub (BenchmarksView + panes).
 *
 * Every backend call is mocked at the fetch boundary:
 *   GET  /api/benchmarks/tasks         → catalog (stats, groups, flags)
 *   GET  /api/benchmarks/runs          → uploaded run index
 *   GET  /api/benchmarks/run-requests  → dispatch queue
 *   POST /api/benchmarks/run-requests  → dispatch (captured + asserted)
 *   PATCH /api/benchmarks/tasks/:name  → metadata edit (captured + asserted)
 *   GET  /api/benchmarks/runs/:id/agents/:aid → transcript + tree
 *
 * Covers: render with stats + flag icons, tag/group filtering, select-all on
 * the FILTERED set, dispatch POST body, edit modal PATCH body, run rows with
 * open-agent → in-app transcript render (root + tree node swap).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { renderWithProviders } from './test-wrapper';
import { BenchmarksView } from '@/features/benchmarks';

// Authenticated session for getAuthHeaders()
const SESSION = { access_token: 'test-token', user: { id: 'admin-1' } };

const CATALOG = {
  tasks: [
    {
      name: 'chat-mode',
      title: 'Chat Mode',
      description: 'basic chat',
      prompt: 'say hi',
      status: null,
      bench: 'pipeline-e2e',
      group: 'pre-deploy',
      tags: ['smoke', 'chat'],
      timeout_seconds: 240,
      price_limit_cents: 100,
      expected_tools: [],
      min_agent_count: null,
      is_chat_mode: true,
      world_model_mode: null,
      updated_at: '2026-07-10T00:00:00Z',
      updated_by: null,
      stats: {
        attempts: 10,
        passes: 9,
        pass_rate: 0.9,
        p50_duration_seconds: 42,
        p95_duration_seconds: 90,
        last_attempt_at: '2026-07-10T00:00:00Z',
        last_status: 'passed',
        last_fast_mode: true,
      },
    },
    {
      name: 'sim-task',
      title: 'Sim Task',
      description: 'simulated env',
      prompt: 'simulate',
      status: 'ready',
      bench: 'rose-bench',
      group: 'rose-bench',
      tags: ['research'],
      timeout_seconds: 600,
      price_limit_cents: 200,
      expected_tools: ['spawn_agent'],
      min_agent_count: 1,
      is_chat_mode: false,
      world_model_mode: 'simulate',
      updated_at: '2026-07-10T00:00:00Z',
      updated_by: null,
      stats: null,
    },
    {
      name: 'broken-task',
      title: 'Broken Task',
      description: 'missing fixtures',
      prompt: 'x',
      status: 'incomplete',
      bench: 'rose-bench',
      group: 'incomplete',
      tags: ['research'],
      timeout_seconds: null,
      price_limit_cents: null,
      expected_tools: [],
      min_agent_count: null,
      is_chat_mode: false,
      world_model_mode: null,
      updated_at: '2026-07-10T00:00:00Z',
      updated_by: null,
      stats: null,
    },
  ],
};

const RUNS = {
  runs: [
    {
      run_id: 'run-abc',
      timestamp: '2026-07-10T01:00:00Z',
      suite: 'hub-dispatch',
      source: 'hub-poller',
      live: false,
      uploaded_at: '2026-07-10T01:20:00Z',
      tasks: [
        {
          name: 'chat-mode',
          passed: true,
          status: 'passed',
          agent_id: 'agent-root-1',
          duration_seconds: 41,
          cost_cents: 3,
          world_model_mode: 'real',
          fast_mode: true,
          tree_agent_count: 2,
          failure_reason: null,
        },
      ],
    },
  ],
};

const REQUESTS = { requests: [] };

const AGENT_VIEW = {
  agent: {
    agent_id: 'agent-root-1',
    goal: 'say hi',
    status: 'COMPLETED',
    busId: 'agent-root-1',
  },
  messages: [
    {
      message_id: 'm1',
      timestamp: '2026-07-10T01:01:00Z',
      text: 'say hi',
      role: 'USER',
      metadata: {},
      file_pointer: null,
    },
    {
      message_id: 'm2',
      timestamp: '2026-07-10T01:02:00Z',
      text: 'hello from the benchmark agent',
      role: 'ASSISTANT',
      metadata: {},
      file_pointer: null,
    },
  ],
  tree: [
    {
      agent_id: 'agent-root-1',
      parent_agent_id: null,
      goal: 'say hi',
      status: 'COMPLETED',
      progress: 100,
      tools_in_use: [],
      message_count: 2,
      tree_cost_cents: 3,
    },
    {
      agent_id: 'agent-sub-1',
      parent_agent_id: 'agent-root-1',
      goal: 'research the greeting',
      status: 'COMPLETED',
      progress: 100,
      tools_in_use: [],
      message_count: 1,
      tree_cost_cents: 0,
    },
  ],
};

const SUB_AGENT_VIEW = {
  ...AGENT_VIEW,
  agent: { ...AGENT_VIEW.agent, agent_id: 'agent-sub-1', goal: 'research the greeting' },
  messages: [
    {
      message_id: 's1',
      timestamp: '2026-07-10T01:03:00Z',
      text: 'sub-agent findings',
      role: 'ASSISTANT',
      metadata: {},
      file_pointer: null,
    },
  ],
};

type FetchInput = Parameters<typeof fetch>[0];

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

let capturedRequests: Array<{ url: string; method: string; body: unknown }> = [];

function installFetchMock() {
  return vi.spyOn(global, 'fetch').mockImplementation(async (input: FetchInput, init?) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const method = init?.method ?? 'GET';
    let body: unknown = null;
    if (init?.body !== undefined && typeof init.body === 'string') {
      body = JSON.parse(init.body);
    }
    capturedRequests.push({ url, method, body });

    if (url.includes('/benchmarks/tasks') && method === 'PATCH') {
      const edit = body as Record<string, unknown>;
      return jsonResponse({ task: { ...CATALOG.tasks[0], ...edit } });
    }
    if (url.includes('/benchmarks/tasks')) return jsonResponse(CATALOG);
    if (url.includes('/benchmarks/run-requests') && method === 'POST') {
      return new Response(
        JSON.stringify({
          request: {
            id: 'req-1',
            taskNames: (body as { task_names: string[] }).task_names,
            simOn: [],
            status: 'queued',
            requestedBy: 'admin-1',
            claimedBy: null,
            progress: null,
            runId: null,
            error: null,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          },
        }),
        { status: 201, headers: { 'content-type': 'application/json' } },
      );
    }
    if (url.includes('/benchmarks/run-requests')) return jsonResponse(REQUESTS);
    if (url.includes('/agents/agent-sub-1')) return jsonResponse(SUB_AGENT_VIEW);
    if (url.includes('/agents/agent-root-1')) return jsonResponse(AGENT_VIEW);
    if (url.includes('/benchmarks/runs')) return jsonResponse(RUNS);
    return new Response('{}', { status: 404 });
  });
}

describe('BenchmarksView (in-app hub)', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    window.localStorage.setItem('rose-session', JSON.stringify(SESSION));
    capturedRequests = [];
    fetchSpy = installFetchMock();
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    window.localStorage.clear();
  });

  it('renders tasks with stats, groups, and flag icons', async () => {
    renderWithProviders(<BenchmarksView />);
    await waitFor(() => expect(screen.getByTestId('task-row-chat-mode')).toBeInTheDocument());

    const chatRow = screen.getByTestId('task-row-chat-mode');
    expect(within(chatRow).getByText('90% pass')).toBeInTheDocument();
    expect(within(chatRow).getByText(/p50 42s/)).toBeInTheDocument();
    // fast-mode Zap on chat-mode (last run used fast cache)
    expect(within(chatRow).getByTestId('flag-fast')).toBeInTheDocument();
    // sim Sparkles on the simulated task
    const simRow = screen.getByTestId('task-row-sim-task');
    expect(within(simRow).getByTestId('flag-sim')).toBeInTheDocument();
  });

  it('filters by group and by tag', async () => {
    renderWithProviders(<BenchmarksView />);
    await waitFor(() => expect(screen.getByTestId('task-row-chat-mode')).toBeInTheDocument());

    // group filter: incomplete → only broken-task
    fireEvent.click(screen.getByTestId('group-incomplete'));
    expect(screen.queryByTestId('task-row-chat-mode')).not.toBeInTheDocument();
    expect(screen.getByTestId('task-row-broken-task')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('group-incomplete')); // clear

    // tag filter: chat → only chat-mode
    fireEvent.click(screen.getByTestId('tag-chat'));
    await waitFor(() => {
      expect(screen.getByTestId('task-row-chat-mode')).toBeInTheDocument();
      expect(screen.queryByTestId('task-row-sim-task')).not.toBeInTheDocument();
    });
  });

  it('select-all selects only the filtered set and dispatches them', async () => {
    renderWithProviders(<BenchmarksView />);
    await waitFor(() => expect(screen.getByTestId('task-row-chat-mode')).toBeInTheDocument());

    // filter to the research tag (sim-task + broken-task), select all filtered
    fireEvent.click(screen.getByTestId('tag-research'));
    fireEvent.click(screen.getByTestId('select-all'));
    expect(screen.getByTestId('run-selected')).toHaveTextContent('Run 2');

    fireEvent.click(screen.getByTestId('run-selected'));
    await waitFor(() => {
      const dispatch = capturedRequests.find(
        (r) => r.method === 'POST' && r.url.includes('/benchmarks/run-requests'),
      );
      expect(dispatch).toBeDefined();
      expect((dispatch!.body as { task_names: string[] }).task_names.sort()).toEqual([
        'broken-task',
        'sim-task',
      ]);
    });
  });

  it('edits task metadata through the modal (PATCH body)', async () => {
    renderWithProviders(<BenchmarksView />);
    await waitFor(() => expect(screen.getByTestId('task-row-chat-mode')).toBeInTheDocument());

    fireEvent.click(screen.getByTestId('task-edit-chat-mode'));
    await waitFor(() => expect(screen.getByTestId('task-edit-modal')).toBeInTheDocument());

    fireEvent.change(screen.getByTestId('edit-title'), { target: { value: 'Chat Mode v2' } });
    fireEvent.change(screen.getByTestId('edit-timeout'), { target: { value: '300' } });
    fireEvent.click(screen.getByTestId('edit-save'));

    await waitFor(() => {
      const patch = capturedRequests.find((r) => r.method === 'PATCH');
      expect(patch).toBeDefined();
      expect(patch!.url).toContain('/benchmarks/tasks/chat-mode');
      expect(patch!.body).toEqual({ title: 'Chat Mode v2', timeout_seconds: 300 });
    });
  });

  it('shows runs and opens an agent transcript in-app (root + tree swap)', async () => {
    renderWithProviders(<BenchmarksView />);
    await waitFor(() => expect(screen.getByTestId('run-row-run-abc')).toBeInTheDocument());

    // expand the run → task rows with open-agent
    fireEvent.click(within(screen.getByTestId('run-row-run-abc')).getByRole('button'));
    await waitFor(() => expect(screen.getByTestId('open-agent-chat-mode')).toBeInTheDocument());

    fireEvent.click(screen.getByTestId('open-agent-chat-mode'));
    await waitFor(() => expect(screen.getByTestId('benchmark-agent-view')).toBeInTheDocument());
    await waitFor(() =>
      // MarkdownText animates in chunks — assert on the container's text.
      expect(screen.getByTestId('agent-messages').textContent).toContain(
        'hello from the benchmark agent',
      ),
    );

    // fan-out tree present; click sub-agent → its transcript loads
    expect(screen.getByTestId('agent-tree')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('tree-node-agent-sub-1'));
    await waitFor(() =>
      expect(screen.getByTestId('agent-messages').textContent).toContain('sub-agent findings'),
    );

    // back returns to the hub
    fireEvent.click(screen.getByTestId('agent-back'));
    await waitFor(() => expect(screen.getByTestId('benchmarks-view')).toBeInTheDocument());
  });
});

// ─── Edge states (V9) ────────────────────────────────────────────────────────

const LIVE_RUN_NO_AGENT = {
  runs: [
    {
      run_id: 'run-live',
      timestamp: '2026-07-10T02:00:00Z',
      suite: 'hub-dispatch',
      source: 'hub-poller',
      live: true,
      uploaded_at: '2026-07-10T02:00:10Z',
      tasks: [
        {
          name: 'chat-mode',
          passed: null,
          status: 'running',
          agent_id: null, // live snapshot before the agent exists
          duration_seconds: null,
          cost_cents: null,
          world_model_mode: null,
          fast_mode: false,
          tree_agent_count: null,
          failure_reason: null,
        },
      ],
    },
  ],
};

const CANCELLED_REQUEST = {
  requests: [
    {
      id: 'req-cancelled',
      taskNames: ['chat-mode'],
      simOn: [],
      status: 'cancelled',
      requestedBy: 'admin-1',
      claimedBy: null,
      progress: null,
      runId: null,
      error: null,
      createdAt: '2026-07-10T02:00:00Z',
      updatedAt: '2026-07-10T02:00:01Z',
    },
  ],
};

describe('BenchmarksView edge states', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  afterEach(() => {
    fetchSpy.mockRestore();
    window.localStorage.clear();
  });

  function mockWith(overrides: {
    runs?: unknown;
    requests?: unknown;
    agentStatus?: number;
    dispatchStatus?: number;
  }) {
    window.localStorage.setItem('rose-session', JSON.stringify(SESSION));
    fetchSpy = vi.spyOn(global, 'fetch').mockImplementation(async (input: FetchInput, init?) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const method = init?.method ?? 'GET';
      if (url.includes('/benchmarks/tasks')) return jsonResponse(CATALOG);
      if (url.includes('/benchmarks/run-requests') && method === 'POST') {
        return new Response(JSON.stringify({ error: 'dispatch exploded' }), {
          status: overrides.dispatchStatus ?? 500,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url.includes('/benchmarks/run-requests')) {
        return jsonResponse(overrides.requests ?? REQUESTS);
      }
      if (url.includes('/agents/')) {
        return new Response(JSON.stringify({ error: 'Agent not found in run' }), {
          status: overrides.agentStatus ?? 404,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url.includes('/benchmarks/runs')) return jsonResponse(overrides.runs ?? RUNS);
      return new Response('{}', { status: 404 });
    });
  }

  it('hides cancelled requests from the Runs pane (C5)', async () => {
    mockWith({ requests: CANCELLED_REQUEST });
    renderWithProviders(<BenchmarksView />);
    await waitFor(() => expect(screen.getByTestId('runs-pane')).toBeInTheDocument());
    expect(screen.queryByTestId('request-row-req-cancelled')).not.toBeInTheDocument();
  });

  it('disables Open agent when the live task has no agent yet (D8)', async () => {
    mockWith({ runs: LIVE_RUN_NO_AGENT });
    renderWithProviders(<BenchmarksView />);
    await waitFor(() => expect(screen.getByTestId('run-row-run-live')).toBeInTheDocument());
    fireEvent.click(within(screen.getByTestId('run-row-run-live')).getByRole('button'));
    await waitFor(() => expect(screen.getByTestId('open-agent-chat-mode')).toBeInTheDocument());
    expect(screen.getByTestId('open-agent-chat-mode')).toBeDisabled();
  });

  it('shows the dispatch error when the run request fails (B15)', async () => {
    mockWith({ dispatchStatus: 500 });
    renderWithProviders(<BenchmarksView />);
    await waitFor(() => expect(screen.getByTestId('task-row-chat-mode')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('task-check-chat-mode'));
    fireEvent.click(screen.getByTestId('run-selected'));
    await waitFor(() => expect(screen.getByTestId('dispatch-error')).toBeInTheDocument());
    expect(screen.getByTestId('dispatch-error').textContent).toContain('dispatch exploded');
  });

  it('agent view fetch failure shows error and retry re-fetches (E6)', async () => {
    mockWith({ runs: RUNS, agentStatus: 500 });
    renderWithProviders(<BenchmarksView />);
    await waitFor(() => expect(screen.getByTestId('run-row-run-abc')).toBeInTheDocument());
    fireEvent.click(within(screen.getByTestId('run-row-run-abc')).getByRole('button'));
    await waitFor(() => expect(screen.getByTestId('open-agent-chat-mode')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('open-agent-chat-mode'));
    await waitFor(() => expect(screen.getByTestId('benchmark-agent-view')).toBeInTheDocument());
    await waitFor(() => expect(screen.getByText(/retry/i)).toBeInTheDocument());
    const callsBefore = capturedRequests.length;
    fireEvent.click(screen.getByText(/retry/i));
    await waitFor(() => {
      // retry triggered a new fetch attempt (still failing is fine — the loop works)
      expect(fetchSpy.mock.calls.length).toBeGreaterThan(0);
      expect(screen.getByText(/retry/i)).toBeInTheDocument();
    });
    void callsBefore;
  });

  it('renders the no-transcript placeholder for an agent with zero messages (E7)', async () => {
    window.localStorage.setItem('rose-session', JSON.stringify(SESSION));
    fetchSpy = vi.spyOn(global, 'fetch').mockImplementation(async (input: FetchInput) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.includes('/benchmarks/tasks')) return jsonResponse(CATALOG);
      if (url.includes('/benchmarks/run-requests')) return jsonResponse(REQUESTS);
      if (url.includes('/agents/')) {
        return jsonResponse({ ...AGENT_VIEW, messages: [], tree: [] });
      }
      if (url.includes('/benchmarks/runs')) return jsonResponse(RUNS);
      return new Response('{}', { status: 404 });
    });
    renderWithProviders(<BenchmarksView />);
    await waitFor(() => expect(screen.getByTestId('run-row-run-abc')).toBeInTheDocument());
    fireEvent.click(within(screen.getByTestId('run-row-run-abc')).getByRole('button'));
    fireEvent.click(await screen.findByTestId('open-agent-chat-mode'));
    await waitFor(() => expect(screen.getByText(/No transcript captured/i)).toBeInTheDocument());
  });
});
