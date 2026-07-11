/**
 * STATE MACHINE: RunsPane
 *
 *   (parent polls) props(runs, requests) ──► render
 *     requests in {queued, running} render FIRST (current work, live badge,
 *     poller progress); runs (uploaded index) render below, newest first.
 *   click run row ──► expanded(run_id) ──click again──► collapsed
 *   expanded + click task's "Open agent" ──► onOpenAgent(runId, agentId)
 *     (parent swaps the hub for the in-app transcript view)
 *
 * A queued/running request whose runId matches an uploaded live run is shown
 * once (the run row wins — it carries per-task status).
 */

import { useState } from 'react';
import { ChevronDown, ChevronRight, Loader2 } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import type { HubRun, HubRunRequest } from '@/lib/api/benchmarksHub';
import { TaskFlagIcons } from './TaskFlagIcons';

function statusBadge(status: string, live: boolean) {
  const s = status.toLowerCase();
  if (live || s === 'running' || s === 'queued') {
    return (
      <Badge className="bg-orange-100 text-orange-700 dark:bg-orange-950 dark:text-orange-300 gap-1">
        {s === 'queued' ? 'queued' : '● live'}
      </Badge>
    );
  }
  if (s === 'passed' || s === 'completed') {
    return (
      <Badge className="bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300">
        pass
      </Badge>
    );
  }
  if (s === 'cancelled') return <Badge variant="secondary">cancelled</Badge>;
  return <Badge className="bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300">{s}</Badge>;
}

function runVerdict(run: HubRun): string {
  if (run.live) return 'running';
  const failed = run.tasks.filter((t) => t.passed === false).length;
  if (run.tasks.length === 0) return 'empty';
  return failed === 0 ? 'passed' : 'failed';
}

interface RunsPaneProps {
  runs: HubRun[];
  requests: HubRunRequest[];
  loading: boolean;
  error: string | null;
  onOpenAgent: (runId: string, agentId: string) => void;
}

export function RunsPane({ runs, requests, loading, error, onOpenAgent }: RunsPaneProps) {
  const [expanded, setExpanded] = useState<string | null>(null);

  const liveRunIds = new Set(runs.map((r) => r.run_id));
  // Show in-flight requests AND failed dispatches (a failure with no uploaded
  // run would otherwise vanish silently); completed requests are represented
  // by their uploaded run rows.
  const activeRequests = requests.filter(
    (r) =>
      (r.status === 'queued' || r.status === 'running' || r.status === 'failed') &&
      (r.runId === null || !liveRunIds.has(r.runId)),
  );

  return (
    <div className="flex flex-col h-full min-h-0" data-testid="runs-pane">
      <div className="flex items-center gap-2 pb-2">
        <h2 className="text-sm font-semibold tracking-wide text-foreground">Runs</h2>
        <span className="text-xs text-muted-foreground">
          {runs.length + activeRequests.length} item
          {runs.length + activeRequests.length === 1 ? '' : 's'}
        </span>
        {loading && <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />}
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto space-y-1.5">
        {error !== null && <div className="py-4 text-sm text-red-600">{error}</div>}

        {activeRequests.map((request) => (
          <div
            key={request.id}
            className="rounded-md border border-border px-3 py-2"
            data-testid={`request-row-${request.id}`}
          >
            <div className="flex items-center gap-2">
              {statusBadge(request.status, false)}
              <span className="text-sm truncate">{request.taskNames.join(', ')}</span>
            </div>
            <div className="text-[11px] text-muted-foreground pt-0.5">
              dispatched {new Date(request.createdAt).toLocaleTimeString()}
              {request.claimedBy !== null && ` · claimed by ${request.claimedBy}`}
              {request.error !== null && ` · ${request.error}`}
            </div>
          </div>
        ))}

        {runs.map((run) => {
          const verdict = runVerdict(run);
          const isExpanded = expanded === run.run_id;
          return (
            <div
              key={run.run_id}
              className="rounded-md border border-border"
              data-testid={`run-row-${run.run_id}`}
            >
              <button
                className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-muted/50 rounded-md"
                onClick={() => setExpanded(isExpanded ? null : run.run_id)}
              >
                {isExpanded ? (
                  <ChevronDown className="h-3.5 w-3.5 shrink-0" />
                ) : (
                  <ChevronRight className="h-3.5 w-3.5 shrink-0" />
                )}
                {statusBadge(verdict, run.live)}
                <span className="text-sm font-medium truncate flex-1">{run.run_id}</span>
                <span className="text-[11px] text-muted-foreground shrink-0">
                  {run.tasks.length} task{run.tasks.length === 1 ? '' : 's'} ·{' '}
                  {new Date(run.timestamp || run.uploaded_at).toLocaleString()}
                </span>
              </button>

              {isExpanded && (
                <div className="border-t border-border/60 px-3 py-1.5 space-y-1">
                  {run.tasks.map((task) => (
                    <div
                      key={`${run.run_id}-${task.name}`}
                      className="flex items-center gap-2 py-1"
                      data-testid={`run-task-${task.name}`}
                    >
                      {statusBadge(task.status, false)}
                      <span className="text-sm truncate flex-1">
                        {task.name}
                        <TaskFlagIcons
                          simOn={task.world_model_mode === 'simulate'}
                          fastOn={task.fast_mode}
                        />
                      </span>
                      <span className="text-[11px] text-muted-foreground shrink-0">
                        {task.duration_seconds !== null
                          ? `${Math.round(task.duration_seconds)}s`
                          : '—'}
                        {task.cost_cents !== null && ` · $${(task.cost_cents / 100).toFixed(2)}`}
                        {task.tree_agent_count !== null && ` · ${task.tree_agent_count} agents`}
                      </span>
                      <Button
                        variant="outline"
                        size="sm"
                        className={cn('h-7 px-2 text-xs', task.agent_id === null && 'opacity-50')}
                        disabled={task.agent_id === null}
                        onClick={() =>
                          task.agent_id !== null && onOpenAgent(run.run_id, task.agent_id)
                        }
                        data-testid={`open-agent-${task.name}`}
                      >
                        Open agent
                      </Button>
                    </div>
                  ))}
                  {run.tasks.some((t) => t.failure_reason !== null) && (
                    <div className="text-[11px] text-red-600/90 pb-1">
                      {run.tasks
                        .filter((t) => t.failure_reason !== null)
                        .map((t) => `${t.name}: ${t.failure_reason}`)
                        .join(' · ')}
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}

        {!loading && error === null && runs.length === 0 && activeRequests.length === 0 && (
          <div className="py-6 text-sm text-muted-foreground">
            No runs yet — select tasks on the right and press Run.
          </div>
        )}
      </div>
    </div>
  );
}
