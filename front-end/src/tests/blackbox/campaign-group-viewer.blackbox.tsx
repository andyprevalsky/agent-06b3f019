import { afterEach, it, expect, vi } from 'vitest';
import { fireEvent, screen, waitFor, within, cleanup } from '@testing-library/react';
import captured from './fixtures/campaign-group-view.fixture.json';
import { renderWithProviders } from './test-wrapper';
import { BenchmarkRunView } from '@/features/benchmarks/BenchmarkRunView';
import { BenchmarksView } from '@/features/benchmarks/BenchmarksView';
const response = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  window.localStorage.clear();
});
function session() {
  window.localStorage.setItem(
    'rose-session',
    JSON.stringify({ access_token: 'fixture-token', user: { id: 'fixture-admin' } }),
  );
}
it('repeated task copies retain unique rows and exact direct agent links before cleanup', async () => {
  session();
  const opened = vi.fn();
  vi.spyOn(global, 'fetch').mockImplementation(async (input) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url.includes('/benchmarks/runs/group-first')) return response(captured.detail);
    return response({});
  });
  renderWithProviders(
    <BenchmarkRunView runId="group-first" onBack={() => {}} onOpenAgent={opened} />,
  );
  await waitFor(() => expect(screen.getByTestId('run-view-task-r001-j0001-0')).toBeInTheDocument());
  const first = screen.getByTestId('run-view-task-r001-j0001-0');
  const second = screen.getByTestId('run-view-task-r002-j0002-0');
  expect(within(first).getByText('pass')).toBeInTheDocument();
  expect(within(second).getByText('pass')).toBeInTheDocument();
  expect(screen.getByText('● live')).toBeInTheDocument();
  fireEvent.click(screen.getByTestId('run-view-open-r001-j0001-0'));
  fireEvent.click(screen.getByTestId('run-view-open-r002-j0002-0'));
  expect(opened.mock.calls).toEqual(
    captured.detail.run.tasks.map((task) => [task.child_run_id, task.agent_id]),
  );
});
it('run pagination keeps global counts and uses explicit grouped API pages', async () => {
  session();
  const reads: string[] = [];
  const group = {
    ...captured.list.runs[0],
    task_total: 10000,
    task_counts: { passed: 2, failed: 0, queued: 9998 },
    tasks: captured.list.runs[0].tasks,
  };
  vi.spyOn(global, 'fetch').mockImplementation(async (input) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url.includes('/benchmarks/tasks')) return response({ tasks: [] });
    if (url.includes('/benchmarks/run-requests')) return response({ requests: [] });
    if (url.includes('/benchmarks/runs')) {
      reads.push(url);
      const offset = new URL(url).searchParams.get('offset') === '100' ? 100 : 0;
      return response({
        runs: [{ ...group, run_id: offset ? 'group-next' : 'group-first' }],
        pagination: { offset, limit: 100, total: 150 },
      });
    }
    return response({});
  });
  renderWithProviders(<BenchmarksView />);
  await waitFor(() => expect(screen.getByTestId('run-row-group-first')).toBeInTheDocument());
  expect(screen.getByTestId('run-status-bar')).toHaveAttribute(
    'aria-label',
    '2 passed, 0 failed, 9998 queued',
  );
  expect(screen.getByText('150 items')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Next' }));
  await waitFor(() => expect(screen.getByTestId('run-row-group-next')).toBeInTheDocument());
  expect(reads.every((url) => new URL(url).searchParams.get('grouped') === '1')).toBe(true);
  expect(reads.some((url) => new URL(url).searchParams.get('offset') === '100')).toBe(true);
});

it('retry history retains the released infrastructure error and exact links for both attempts', async () => {
  session();
  const opened = vi.fn();
  const first = captured.detail.run.tasks[0];
  const current = {
    ...first,
    group_attempt: 2,
    child_run_id: 'retry-child',
    agent_id: 'retry-agent',
    attempt_history: [
      {
        group_attempt: 1,
        child_run_id: first.child_run_id,
        agent_id: first.agent_id,
        passed: null,
        status: 'INFRA_ERROR',
        lifecycle_stage: 'released',
        failure_reason: 'Original infrastructure error',
        duration_seconds: 10,
        cost_cents: 11,
        tree_agent_count: 1,
      },
      {
        group_attempt: 2,
        child_run_id: 'retry-child',
        agent_id: 'retry-agent',
        passed: true,
        status: 'passed',
        lifecycle_stage: 'released',
        failure_reason: null,
        duration_seconds: 20,
        cost_cents: 13,
        tree_agent_count: 1,
      },
    ],
  };
  vi.spyOn(global, 'fetch').mockImplementation(async () =>
    response({
      run: {
        ...captured.detail.run,
        tasks: [current, captured.detail.run.tasks[1]],
      },
    }),
  );
  renderWithProviders(
    <BenchmarkRunView runId="group-first" onBack={() => {}} onOpenAgent={opened} />,
  );
  const row = await screen.findByTestId(`run-view-task-${first.row_id}`);
  expect(within(row).getByText('Attempt 2')).toBeInTheDocument();
  fireEvent.click(within(row).getByText('2 attempts'));
  expect(within(row).getByText('INFRA_ERROR')).toBeInTheDocument();
  expect(within(row).getByText('Original infrastructure error')).toBeInTheDocument();
  fireEvent.click(within(row).getByRole('button', { name: 'Open attempt 1 agent' }));
  fireEvent.click(within(row).getByRole('button', { name: 'Open attempt 2 agent' }));
  expect(opened.mock.calls).toEqual([
    [first.child_run_id, first.agent_id],
    ['retry-child', 'retry-agent'],
  ]);
});
