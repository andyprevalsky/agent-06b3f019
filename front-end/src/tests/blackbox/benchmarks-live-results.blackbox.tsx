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
    dispatch: null,
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
  status = 'passed';
  await act(async () => {
    await vi.advanceTimersByTimeAsync(5000);
  });
  expect(screen.getByTestId('run-status-bar')).toHaveAttribute(
    'aria-label',
    '1 passed, 0 failed, 0 queued',
  );
  fireEvent.click(screen.getByTestId('run-row-run-abc'));
  await waitFor(() => expect(screen.getByTestId('run-view-task-chat-mode')).toBeInTheDocument());
  expect(
    within(screen.getByTestId('run-view-task-chat-mode')).getByText('pass'),
  ).toBeInTheDocument();
  expect(screen.getByText('● live')).toBeInTheDocument();
  status = 'failed';
  await act(async () => {
    await vi.advanceTimersByTimeAsync(5000);
  });
  expect(
    within(screen.getByTestId('run-view-task-chat-mode')).getByText('failed'),
  ).toBeInTheDocument();
  expect(screen.getByText('● live')).toBeInTheDocument();
  live = false;
  await act(async () => {
    await vi.advanceTimersByTimeAsync(5000);
  });
  expect(screen.queryByText('● live')).not.toBeInTheDocument();
  const terminalReads = detailReads;
  await act(async () => {
    await vi.advanceTimersByTimeAsync(15000);
  });
  expect(detailReads).toBe(terminalReads);
});
