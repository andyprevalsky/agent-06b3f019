import { afterEach, it, vi } from 'vitest';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { renderWithProviders } from './test-wrapper';
import { BenchmarksView } from '@/features/benchmarks';

type FetchInput = Parameters<typeof fetch>[0];
const base = {
  run_id: 'run-abc',
  timestamp: '2026-10-04T00:00:00Z',
  suite: 'cloud-fleet',
  source: 'direct-cloud-fleet',
  uploaded_at: '2026-10-04T00:00:00Z',
  live: true,
  tasks: [
    {
      name: 'chat-mode',
      agent_id: 'fixture-agent',
      status: 'starting',
      passed: null,
      duration_seconds: 0,
      cost_cents: 0,
    },
  ],
};
const RUNS = { runs: [base] };
const jsonResponse = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
function toDetail(run: typeof base) {
  return {
    ...run,
    totals: {
      passed: 0,
      failed: 0,
      running: 1,
      cost_cents: 0,
      tokens_in: 0,
      tokens_out: 0,
      agents: 1,
    },
    elapsed_s: 1,
    cost: {
      agents_llm_usd: 0,
      wmh_grounding_usd: 0,
      infra_usd: 0,
      total_usd: 0,
      fast_cache_hit_rate: 0,
    },
    metadata: {},
    dispatch: {
      status: 'running',
      created_at: base.timestamp,
      claimed_at: base.timestamp,
      claimed_by: 'fixture-poller',
      updated_at: base.timestamp,
      error: null,
    },
  };
}
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  window.localStorage.clear();
});

it('shows evaluated pass/fail while teardown is pending, then stops terminal detail polling', async () => {
  window.localStorage.setItem(
    'rose-session',
    JSON.stringify({ access_token: 'fixture-token', user: { id: 'fixture-admin' } }),
  );
  const fetchSpy = vi.spyOn(global, 'fetch').mockImplementation(async (input: FetchInput) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url.includes('/benchmarks/tasks')) return jsonResponse({ tasks: [] });
    if (url.includes('/benchmarks/run-requests')) return jsonResponse({ requests: [] });
    return jsonResponse({});
  });
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  let status = 'starting';
  let live = true;
  let lifecycle_stage = 'starting';
  let detailReads = 0;
  const base = RUNS.runs[0];
  const delegate = fetchSpy.getMockImplementation()!;
  const run = () => ({
    ...base,
    live,
    tasks: [
      {
        ...base.tasks[0],
        status,
        lifecycle_stage,
        startup_label: 'Loading services',
        passed: status === 'passed' ? true : status === 'failed' ? false : null,
      },
    ],
  });
  fetchSpy.mockImplementation(async (input: FetchInput, init?) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url.match(/\/benchmarks\/runs\/run-abc$/)) {
      detailReads++;
      return jsonResponse({
        run: {
          ...toDetail(base),
          ...run(),
          totals: {
            ...toDetail(base).totals,
            passed: status === 'passed' ? 1 : 0,
            failed: status === 'failed' ? 1 : 0,
            running: status === 'starting' ? 1 : 0,
          },
        },
      });
    }
    if (url.includes('/benchmarks/runs')) return jsonResponse({ runs: [run()] });
    return delegate(input, init);
  });
  renderWithProviders(<BenchmarksView />);
  await waitFor(() => expect(screen.getByTestId('run-row-run-abc')).toBeInTheDocument());
  expect(screen.getByTestId('run-status-bar')).toHaveAttribute(
    'aria-label',
    '0 passed, 0 failed, 1 queued',
  );
  expect(screen.getByTestId('run-row-run-abc')).toHaveTextContent('1 task');
  fireEvent.click(screen.getByTestId('run-row-run-abc'));
  await waitFor(() => expect(screen.getByTestId('run-view-task-chat-mode')).toBeInTheDocument());
  expect(screen.getByTestId('run-tiles')).toHaveTextContent('0/1 done');
  expect(screen.getByText('Loading services')).toBeInTheDocument();
  lifecycle_stage = 'ready';
  status = 'ready';
  await act(async () => {
    await vi.advanceTimersByTimeAsync(5000);
  });
  expect(screen.getByText('Ready')).toBeInTheDocument();
  lifecycle_stage = 'running';
  status = 'running';
  await act(async () => {
    await vi.advanceTimersByTimeAsync(5000);
  });
  expect(
    within(screen.getByTestId('run-view-task-chat-mode')).getByText('running'),
  ).toBeInTheDocument();
  expect(screen.getByText('benchmark executing — table updates live')).toBeInTheDocument();
  lifecycle_stage = 'evaluated';
  status = 'passed';
  await act(async () => {
    await vi.advanceTimersByTimeAsync(5000);
  });
  expect(
    within(screen.getByTestId('run-view-task-chat-mode')).getByText('pass'),
  ).toBeInTheDocument();
  expect(screen.getByText('● live')).toBeInTheDocument();
  expect(screen.getByText('Evaluated')).toBeInTheDocument();
  expect(screen.queryByText('benchmark executing — table updates live')).not.toBeInTheDocument();
  lifecycle_stage = 'teardown';
  status = 'failed';
  await act(async () => {
    await vi.advanceTimersByTimeAsync(5000);
  });
  expect(
    within(screen.getByTestId('run-view-task-chat-mode')).getByText('failed'),
  ).toBeInTheDocument();
  expect(screen.getByText('● live')).toBeInTheDocument();
  expect(screen.getByText('Releasing resources')).toBeInTheDocument();
  lifecycle_stage = 'released';
  live = false;
  await act(async () => {
    await vi.advanceTimersByTimeAsync(5000);
  });
  expect(screen.queryByText('● live')).not.toBeInTheDocument();
  expect(screen.getByText('Resources released')).toBeInTheDocument();
  const terminalReads = detailReads;
  await act(async () => {
    await vi.advanceTimersByTimeAsync(15000);
  });
  expect(detailReads).toBe(terminalReads);
});

function installPagedGroupMock() {
  window.localStorage.setItem(
    'rose-session',
    JSON.stringify({ access_token: 'fixture-token', user: { id: 'fixture-admin' } }),
  );
  const tasks = Array.from({ length: 150 }, (_, index) => ({
    ...base.tasks[0],
    name: 'repeated-task',
    row_id: `member-${index}`,
    child_run_id: `child-${index}`,
    run_number: index + 1,
    passed: index < 120 ? true : index < 130 ? false : null,
    status: index < 120 ? 'passed' : index < 130 ? 'failed' : 'running',
  }));
  const group = {
    ...base,
    run_id: 'group-150',
    source: 'benchmark-campaign',
    is_group: true,
    task_total: tasks.length,
    task_counts: { passed: 120, failed: 10, queued: 20 },
  };
  const offsets: number[] = [];
  vi.spyOn(global, 'fetch').mockImplementation(async (input: FetchInput) => {
    const url = new URL(
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
    );
    if (url.pathname.includes('/benchmarks/tasks')) return jsonResponse({ tasks: [] });
    if (url.pathname.includes('/benchmarks/run-requests')) {
      return jsonResponse({ requests: [] });
    }
    if (url.pathname.endsWith('/benchmarks/runs/group-150')) {
      const offset = Number(url.searchParams.get('offset') ?? 0);
      offsets.push(offset);
      return jsonResponse({
        run: {
          ...toDetail(base),
          ...group,
          tasks: tasks.slice(offset, offset + 100),
          totals: { ...toDetail(base).totals, passed: 120, failed: 10, running: 20 },
          pagination: { offset, limit: 100, total: tasks.length },
        },
      });
    }
    if (url.pathname.endsWith('/benchmarks/runs')) {
      return jsonResponse({ runs: [{ ...group, tasks: tasks.slice(0, 100) }] });
    }
    return jsonResponse({});
  });
  return offsets;
}

it('shows the full grouped task count when the run catalog contains only a preview', async () => {
  installPagedGroupMock();
  renderWithProviders(<BenchmarksView />);
  await waitFor(() => expect(screen.getByTestId('run-row-group-150')).toBeInTheDocument());
  const row = screen.getByTestId('run-row-group-150');
  expect(row).toHaveTextContent('150 tasks');
  expect(within(row).getByTestId('run-status-bar')).toHaveAttribute(
    'aria-label',
    '120 passed, 10 failed, 20 queued',
  );
});

it('keeps grouped completion counts across task pages while showing only the current page', async () => {
  const offsets = installPagedGroupMock();
  renderWithProviders(<BenchmarksView />);
  await waitFor(() => expect(screen.getByTestId('run-row-group-150')).toBeInTheDocument());
  fireEvent.click(screen.getByTestId('run-row-group-150'));
  await waitFor(() => expect(screen.getByTestId('run-tiles')).toBeInTheDocument());
  expect(screen.getByTestId('run-tiles')).toHaveTextContent('130/150 done');
  expect(screen.getAllByTestId(/^run-view-task-member-/)).toHaveLength(100);
  expect(screen.queryByTestId('run-view-task-member-100')).not.toBeInTheDocument();
  expect(screen.getByText('1–100 of 150')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Next' }));
  await waitFor(() => expect(screen.getByTestId('run-view-task-member-100')).toBeInTheDocument());
  expect(screen.getAllByTestId(/^run-view-task-member-/)).toHaveLength(50);
  expect(screen.queryByTestId('run-view-task-member-0')).not.toBeInTheDocument();
  expect(screen.getByText('101–150 of 150')).toBeInTheDocument();
  expect(screen.getByTestId('run-tiles')).toHaveTextContent('130/150 done');
  expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: 'Previous' }));
  await waitFor(() => expect(screen.getByTestId('run-view-task-member-0')).toBeInTheDocument());
  expect(screen.getAllByTestId(/^run-view-task-member-/)).toHaveLength(100);
  expect(screen.getByTestId('run-tiles')).toHaveTextContent('130/150 done');
  expect(offsets).toEqual([0, 100, 0]);
});
