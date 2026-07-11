/**
 * STATE MACHINE: BenchmarksView (the in-app Benchmark Hub)
 *
 *   mount ──► hub(loading) ──catalog+runs fetched──► hub(ready)
 *     hub polls runs + run-requests every POLL_MS while mounted (live runs).
 *   hub + click run row ──► run(runId) (in-app run view: tiles + task table)
 *     run + "Open agent" ──► agent(runId, agentId)
 *       agent + Back ──► run (the run view it came from)
 *     run + Back ──► hub
 *   hub + task edited ──► hub (catalog row replaced in place)
 *   hub + run dispatched ──► hub (requests refetched immediately)
 *
 * Layout: stacked — Runs on top at a fixed height (internally scrollable;
 * recent runs matter most), Tasks fills the rest. This view is team-gated by
 * the sidebar (ADMIN_USER_IDS or dev mode); the backend enforces the same
 * gate on every endpoint.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { HubRun, HubRunRequest, HubTask } from '@/lib/api/benchmarksHub';
import { fetchHubRunRequests, fetchHubRuns, fetchHubTasks } from '@/lib/api/benchmarksHub';
import { BenchmarkAgentView } from './BenchmarkAgentView';
import { BenchmarkRunView } from './BenchmarkRunView';
import { RunsPane } from './RunsPane';
import { TasksPane } from './TasksPane';

const POLL_MS = 5000;

export function BenchmarksView() {
  const [tasks, setTasks] = useState<HubTask[]>([]);
  const [tasksLoading, setTasksLoading] = useState(true);
  const [tasksError, setTasksError] = useState<string | null>(null);

  const [runs, setRuns] = useState<HubRun[]>([]);
  const [requests, setRequests] = useState<HubRunRequest[]>([]);
  const [runsLoading, setRunsLoading] = useState(true);
  const [runsError, setRunsError] = useState<string | null>(null);

  const [openRun, setOpenRun] = useState<string | null>(null);
  const [openAgent, setOpenAgent] = useState<{ runId: string; agentId: string } | null>(null);
  const pollRef = useRef<number | null>(null);

  const loadTasks = useCallback(async () => {
    setTasksLoading(true);
    setTasksError(null);
    try {
      setTasks(await fetchHubTasks());
    } catch (err) {
      setTasksError(err instanceof Error ? err.message : String(err));
    } finally {
      setTasksLoading(false);
    }
  }, []);

  const loadRuns = useCallback(async (background = false) => {
    if (!background) setRunsLoading(true);
    try {
      const [nextRuns, nextRequests] = await Promise.all([fetchHubRuns(), fetchHubRunRequests()]);
      setRuns(nextRuns);
      setRequests(nextRequests);
      setRunsError(null);
    } catch (err) {
      if (!background) setRunsError(err instanceof Error ? err.message : String(err));
    } finally {
      if (!background) setRunsLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadTasks();
    void loadRuns();
  }, [loadTasks, loadRuns]);

  // Poll runs + requests while the hub is visible so live runs move on their own.
  useEffect(() => {
    pollRef.current = window.setInterval(() => {
      void loadRuns(true);
    }, POLL_MS);
    return () => {
      if (pollRef.current !== null) window.clearInterval(pollRef.current);
    };
  }, [loadRuns]);

  if (openAgent !== null) {
    return (
      <BenchmarkAgentView
        runId={openAgent.runId}
        agentId={openAgent.agentId}
        onBack={() => setOpenAgent(null)}
      />
    );
  }

  if (openRun !== null) {
    return (
      <BenchmarkRunView
        runId={openRun}
        onOpenAgent={(runId, agentId) => setOpenAgent({ runId, agentId })}
        onBack={() => setOpenRun(null)}
      />
    );
  }

  return (
    <div className="flex flex-col h-full min-h-0 pt-20 pb-4" data-testid="benchmarks-view">
      <div className="pb-3">
        <h1 className="text-lg font-semibold">Benchmarks</h1>
        <p className="text-xs text-muted-foreground">
          Eval catalog, live + past runs, and dispatch — runs execute on cloud bench machines via
          the hub poller.
        </p>
      </div>
      <div className="flex-1 min-h-0 flex flex-col gap-4">
        {/* Runs on top at a fixed height — only the most recent few matter, so
            the list scrolls internally instead of stealing space from Tasks.
            No wrapper card: rows sit directly on the page. */}
        <div className="h-60 shrink-0">
          <RunsPane
            runs={runs}
            requests={requests}
            loading={runsLoading}
            error={runsError}
            onOpenRun={(runId) => setOpenRun(runId)}
          />
        </div>
        <div className="flex-1 min-h-0 rounded-xl border border-border bg-background/85 backdrop-blur-sm p-4">
          <TasksPane
            tasks={tasks}
            loading={tasksLoading}
            error={tasksError}
            onRetry={() => void loadTasks()}
            onTaskUpdated={(updated) =>
              setTasks((prev) => prev.map((t) => (t.name === updated.name ? updated : t)))
            }
            onDispatched={() => void loadRuns()}
          />
        </div>
      </div>
    </div>
  );
}
