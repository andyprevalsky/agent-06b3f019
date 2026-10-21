/**
 * Blackbox tests for the in-app Benchmark Hub (BenchmarksView + panes).
 *
 * Every backend call is mocked at the fetch boundary:
 *   GET  /api/benchmarks/tasks         → catalog (stats, groups, flags)
 *   GET  /api/benchmarks/runs          → uploaded run index
 *   GET  /api/benchmarks/run-requests  → dispatch queue
 *   POST /api/benchmarks/run-requests  → dispatch (captured + asserted)
 *   POST /api/benchmarks/run-requests  → dispatch (captured + asserted)
 *   GET  /api/benchmarks/runs/:id/agents/:aid → transcript + tree
 *
 * Covers: render with stats + flag icons, tag/group filtering, select-all on
 * the FILTERED set, dispatch POST body, run rows with open-agent → in-app
 * transcript render (root + tree node swap).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { renderWithProviders } from './test-wrapper';
import { BenchmarksView } from '@/features/benchmarks';
import { deriveRunName } from '@/features/benchmarks/runName';
import type { HubRun } from '@/lib/api/benchmarksHub';
import { CATALOG } from './benchmarks-hub.fixtures';

// Authenticated session for getAuthHeaders()
const SESSION = { access_token: 'test-token', user: { id: 'admin-1' } };

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

// The run view's enriched detail, derived from a runs fixture entry.
function toDetail(run: (typeof RUNS)['runs'][number]) {
  const tasks = run.tasks.map((t) => ({
    ...t,
    tokens_in: 1000,
    tokens_out: 200,
    cache_hit_pct: 98,
    llm_call_count: 2,
    message_count: 5,
  }));
  return {
    ...run,
    tasks,
    totals: {
      passed: tasks.filter((t) => t.passed === true).length,
      failed: tasks.filter((t) => t.passed === false).length,
      running: tasks.filter((t) => t.passed === null).length,
      cost_cents: 3,
      tokens_in: 1000,
      tokens_out: 200,
      agents: 2,
    },
    code: 'main@abc1234 (clean)',
    elapsed_s: 41,
    cost: {
      agents_llm_usd: 0.03,
      wmh_grounding_usd: 0,
      infra_usd: 0.01,
      total_usd: 0.04,
      fast_cache_hit_rate: 98,
    },
    dispatch: run.live
      ? {
          status: 'running',
          created_at: '2026-07-10T00:59:00Z',
          claimed_at: '2026-07-10T00:59:30Z',
          claimed_by: 'test-poller:1',
          updated_at: '2026-07-10T01:00:00Z',
          error: null,
        }
      : null,
  };
}

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
    const detailMatch = url.match(/\/benchmarks\/runs\/([^/?]+)$/);
    if (detailMatch) {
      const fixture = RUNS.runs.find((r) => r.run_id === decodeURIComponent(detailMatch[1]));
      if (!fixture) return new Response('{"error":"Run not found"}', { status: 404 });
      return jsonResponse({ run: toDetail(fixture) });
    }
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

  it('exposes Process Bench as an independent family filter', async () => {
    const processTask = {
      ...CATALOG.tasks[0],
      name: 'process-example',
      title: 'Process Bench — Example',
      group: 'process-bench',
      tags: ['process'],
    };
    CATALOG.tasks.push(processTask);
    try {
      renderWithProviders(<BenchmarksView />);
      await waitFor(() =>
        expect(screen.getByTestId('task-row-process-example')).toBeInTheDocument(),
      );
      fireEvent.click(screen.getByTestId('group-process-bench'));
      expect(screen.getByTestId('task-row-process-example')).toBeInTheDocument();
      expect(screen.queryByTestId('task-row-chat-mode')).not.toBeInTheDocument();
    } finally {
      CATALOG.tasks.pop();
    }
  });

  it('filters by group and by tag', async () => {
    renderWithProviders(<BenchmarksView />);
    await waitFor(() => expect(screen.getByTestId('task-row-chat-mode')).toBeInTheDocument());

    // group filter: incomplete → only broken-task
    fireEvent.click(screen.getByTestId('group-incomplete'));
    expect(screen.queryByTestId('task-row-chat-mode')).not.toBeInTheDocument();
    expect(screen.getByTestId('task-row-broken-task')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('group-incomplete')); // clear

    // group filter: polar-bench → only polar slice
    expect(screen.getByTestId('group-polar-bench')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('group-polar-bench'));
    expect(screen.getByTestId('task-row-polar-bu-001')).toBeInTheDocument();
    expect(screen.queryByTestId('task-row-chat-mode')).not.toBeInTheDocument();
    expect(screen.queryByTestId('task-row-broken-task')).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId('group-polar-bench')); // clear

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

  it('does not expose task edit controls (catalog is read-only)', async () => {
    renderWithProviders(<BenchmarksView />);
    await waitFor(() => expect(screen.getByTestId('task-row-chat-mode')).toBeInTheDocument());
    expect(screen.queryByTestId('task-edit-chat-mode')).not.toBeInTheDocument();
  });

  it('renders the run status bar with passed/failed/queued segments', async () => {
    renderWithProviders(<BenchmarksView />);
    await waitFor(() => expect(screen.getByTestId('run-row-run-abc')).toBeInTheDocument());

    const runRow = screen.getByTestId('run-row-run-abc');
    // run-abc has a single passing task → green segment only, no red/blue.
    const bar = within(runRow).getByTestId('run-status-bar');
    expect(within(bar).getByTestId('run-status-seg-passed')).toBeInTheDocument();
    expect(within(bar).queryByTestId('run-status-seg-failed')).not.toBeInTheDocument();
    expect(within(bar).queryByTestId('run-status-seg-queued')).not.toBeInTheDocument();
    // accessible label + compact count summary
    expect(bar).toHaveAttribute('aria-label', '1 passed, 0 failed, 0 queued');
    expect(runRow.textContent).toContain('1✓');
    // the old text badges are gone
    expect(within(runRow).queryByText('pass')).not.toBeInTheDocument();
    // semantic name (derived from the single task) shows ALONGSIDE the opaque id
    expect(within(runRow).getByText('chat-mode')).toBeInTheDocument();
    expect(within(runRow).getByTestId('run-id-run-abc')).toHaveTextContent('run-abc');
  });

  it('opens a run into the run view; Open agent goes to the MAIN panel', async () => {
    const onOpenAgent = vi.fn();
    renderWithProviders(<BenchmarksView onOpenAgent={onOpenAgent} />);
    await waitFor(() => expect(screen.getByTestId('run-row-run-abc')).toBeInTheDocument());

    // click the run row → the in-app run view (tiles + per-task table)
    fireEvent.click(screen.getByTestId('run-row-run-abc'));
    await waitFor(() => expect(screen.getByTestId('benchmark-run-view')).toBeInTheDocument());
    await waitFor(() => expect(screen.getByTestId('run-tiles')).toBeInTheDocument());
    expect(screen.getByTestId('run-view-task-chat-mode')).toBeInTheDocument();
    const tiles = screen.getByTestId('run-tiles').textContent ?? '';
    expect(tiles).toContain('$0.04'); // total from the cost breakdown
    expect(tiles).toContain('LLM $0.03'); // LLM · WMH · infra sub-line
    expect(tiles).toContain('infra $0.01');
    expect(tiles).toContain('Success');
    expect(tiles).toContain('100%'); // success rate + cache hit
    expect(tiles).toContain('Elapsed');
    // code provenance from the executing controller
    expect(screen.getByTestId('run-code').textContent).toContain('main@abc1234');
    // finished run → no dispatch timeline
    expect(screen.queryByTestId('dispatch-timeline')).not.toBeInTheDocument();

    // Open agent → hands the agent to the app's MAIN panel (normal chat view)
    fireEvent.click(screen.getByTestId('run-view-open-chat-mode'));
    expect(onOpenAgent).toHaveBeenCalledWith('agent-root-1');

    // back returns to the hub
    fireEvent.click(screen.getByTestId('run-back'));
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
          agent_id: '   ', // cloud runner emitted whitespace before the agent existed
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

const MIXED_LIVE_RUN = {
  runs: [
    {
      run_id: 'run-mixed',
      timestamp: '2026-07-10T03:00:00Z',
      suite: 'hub-dispatch',
      source: 'hub-poller',
      live: true,
      uploaded_at: '2026-07-10T03:00:10Z',
      tasks: [
        { name: 't-pass', passed: true, status: 'passed', agent_id: 'a1' },
        { name: 't-fail', passed: false, status: 'failed', agent_id: 'a2' },
        { name: 't-run', passed: null, status: 'running', agent_id: null },
      ].map((t) => ({
        world_model_mode: null,
        fast_mode: false,
        tree_agent_count: null,
        failure_reason: null,
        duration_seconds: null,
        cost_cents: null,
        ...t,
      })),
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
    runs?: typeof RUNS;
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
      const detailMatch = url.match(/\/benchmarks\/runs\/([^/?]+)$/);
      if (detailMatch) {
        const fixture = (overrides.runs ?? RUNS).runs.find(
          (r) => r.run_id === decodeURIComponent(detailMatch[1]),
        );
        if (!fixture) return new Response('{"error":"Run not found"}', { status: 404 });
        return jsonResponse({ run: toDetail(fixture) });
      }
      if (url.includes('/benchmarks/runs')) return jsonResponse(overrides.runs ?? RUNS);
      return new Response('{}', { status: 404 });
    });
  }

  it('shows all three status-bar segments for a mixed live run', async () => {
    mockWith({ runs: MIXED_LIVE_RUN });
    renderWithProviders(<BenchmarksView />);
    await waitFor(() => expect(screen.getByTestId('run-row-run-mixed')).toBeInTheDocument());

    const runRow = screen.getByTestId('run-row-run-mixed');
    const bar = within(runRow).getByTestId('run-status-bar');
    expect(within(bar).getByTestId('run-status-seg-passed')).toBeInTheDocument();
    expect(within(bar).getByTestId('run-status-seg-failed')).toBeInTheDocument();
    expect(within(bar).getByTestId('run-status-seg-queued')).toBeInTheDocument();
    expect(bar).toHaveAttribute('aria-label', '1 passed, 1 failed, 1 queued');
    // live run → the queued segment pulses to read as "loading"
    expect(within(bar).getByTestId('run-status-seg-queued')).toHaveClass('animate-pulse');
    expect(runRow.textContent).toContain('1✓');
    expect(runRow.textContent).toContain('1✗');
    expect(runRow.textContent).toContain('1⋯');
    // 3 distinct tasks → semantic name joins them, still beside the opaque id
    expect(within(runRow).getByText('t-pass, t-fail, t-run')).toBeInTheDocument();
    expect(within(runRow).getByTestId('run-id-run-mixed')).toHaveTextContent('run-mixed');
  });

  it('hides cancelled requests from the Runs pane (C5)', async () => {
    mockWith({ requests: CANCELLED_REQUEST });
    renderWithProviders(<BenchmarksView />);
    await waitFor(() => expect(screen.getByTestId('runs-pane')).toBeInTheDocument());
    expect(screen.queryByTestId('request-row-req-cancelled')).not.toBeInTheDocument();
  });

  it('disables Open agent when the live task has a blank agent id (D8)', async () => {
    mockWith({ runs: LIVE_RUN_NO_AGENT });
    renderWithProviders(<BenchmarksView />);
    await waitFor(() => expect(screen.getByTestId('run-row-run-live')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('run-row-run-live'));
    await waitFor(() => expect(screen.getByTestId('run-view-open-chat-mode')).toBeInTheDocument());
    expect(screen.getByTestId('run-view-open-chat-mode')).toBeDisabled();
    expect(screen.getByTestId('run-view-open-chat-mode')).toHaveAttribute(
      'title',
      'Agent has not been created yet',
    );
    // live run → dispatch timeline with the fleet startup-bar essence
    const timeline = screen.getByTestId('dispatch-timeline').textContent ?? '';
    expect(timeline).toContain('Queued');
    expect(timeline).toContain('Claimed by poller');
    expect(timeline).toContain('test-poller:1');
    expect(timeline).toContain('Stack starting');
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
});

describe('deriveRunName (semantic run label)', () => {
  const mkRun = (over: Partial<HubRun>): HubRun => ({
    run_id: '20260719-131303-17378',
    timestamp: '2026-07-19T20:13:03Z',
    suite: 'cloud-fleet',
    source: 'cloud-fleet',
    live: false,
    uploaded_at: '2026-07-19T20:40:00Z',
    tasks: [],
    ...over,
  });
  const task = (name: string): HubRun['tasks'][number] => ({
    name,
    passed: null,
    status: 'queued',
    agent_id: null,
    duration_seconds: null,
    cost_cents: null,
    world_model_mode: null,
    fast_mode: false,
    tree_agent_count: null,
    failure_reason: null,
  });

  it('prefers an explicit bundle name over derivation', () => {
    expect(deriveRunName(mkRun({ name: 'ecommerce slice', tasks: [task('a'), task('b')] }))).toBe(
      'ecommerce slice',
    );
  });

  it('uses the single task name for a one-task run', () => {
    expect(deriveRunName(mkRun({ tasks: [task('browser-amazon-return')] }))).toBe(
      'browser-amazon-return',
    );
  });

  it('joins up to three distinct task names', () => {
    expect(deriveRunName(mkRun({ tasks: [task('a'), task('b'), task('c')] }))).toBe('a, b, c');
  });

  it('summarizes longer slices as "first, second +N more" and dedupes', () => {
    const tasks = [task('a'), task('b'), task('a'), task('c'), task('d')]; // 4 distinct
    expect(deriveRunName(mkRun({ tasks }))).toBe('a, b +2 more');
  });

  it('falls back to suite/source when there are no tasks', () => {
    expect(deriveRunName(mkRun({ tasks: [] }))).toBe('cloud-fleet');
    expect(deriveRunName(mkRun({ tasks: [], suite: null, source: 'manual-run' }))).toBe(
      'manual-run',
    );
    expect(deriveRunName(mkRun({ tasks: [], suite: null, source: null }))).toBe('run');
  });
});
