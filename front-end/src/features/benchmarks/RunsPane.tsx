/**
 * STATE MACHINE: RunsPane
 *
 *   (parent polls) props(runs, requests) ──► render
 *     requests in {queued, running, failed-without-run} render FIRST (current
 *     work + failures that never produced a run); uploaded runs render below,
 *     newest first.
 *   click run row ──► onOpenRun(run_id) (parent opens the in-app run view)
 *   click request row:
 *     runId linked ──► onOpenRun(runId) (its live/final run view)
 *     no run yet   ──► expanded(request.id) inline detail (full task list,
 *                      claimer, full error, poller hint) ──click──► collapsed
 *
 * Rows are single-line summaries — the run view owns per-task detail.
 */

import { useState } from 'react';
import { ChevronDown, ChevronRight, Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { HubRun, HubRunRequest } from '@/lib/api/benchmarksHub';

interface StatusCounts {
  passed: number;
  failed: number;
  queued: number;
}

// A run's per-task outcomes bucketed for the status bar: passed / failed and
// everything still in flight (passed === null → queued or running) as "queued".
function runCounts(run: HubRun): StatusCounts {
  let passed = 0;
  let failed = 0;
  let queued = 0;
  for (const t of run.tasks) {
    if (t.passed === true) passed++;
    else if (t.passed === false) failed++;
    else queued++;
  }
  return { passed, failed, queued };
}

// A dispatch request has no per-task outcomes yet — a failed dispatch reads as
// all-failed, anything else (queued/running) as all-queued.
function requestCounts(request: HubRunRequest): StatusCounts {
  const total = Math.max(request.taskNames.length, 1);
  if (request.status === 'failed') return { passed: 0, failed: total, queued: 0 };
  return { passed: 0, failed: 0, queued: total };
}

// Segmented loading bar: green passed · red failed · blue queued, sized by
// count. The queued segment pulses while the run is live so in-flight work
// reads as "loading" at a glance.
function RunStatusBar({ passed, failed, queued, live }: StatusCounts & { live?: boolean }) {
  const total = passed + failed + queued;
  const segments = [
    { key: 'passed', count: passed, className: 'bg-emerald-500' },
    { key: 'failed', count: failed, className: 'bg-red-500' },
    { key: 'queued', count: queued, className: cn('bg-blue-500', live && 'animate-pulse') },
  ];
  return (
    <div
      className="flex h-2 w-24 shrink-0 overflow-hidden rounded-full bg-muted"
      role="img"
      aria-label={`${passed} passed, ${failed} failed, ${queued} queued`}
      title={`${passed} passed · ${failed} failed · ${queued} queued`}
      data-testid="run-status-bar"
    >
      {total > 0 &&
        segments.map((seg) =>
          seg.count === 0 ? null : (
            <div
              key={seg.key}
              className={seg.className}
              style={{ width: `${(seg.count / total) * 100}%` }}
              data-testid={`run-status-seg-${seg.key}`}
            />
          ),
        )}
    </div>
  );
}

// Compact colored counts beside the bar — only non-zero buckets show.
function StatusCountsLabel({ passed, failed, queued }: StatusCounts) {
  return (
    <span className="flex shrink-0 items-center gap-1.5 text-[11px] tabular-nums">
      {passed > 0 && <span className="text-emerald-600 dark:text-emerald-400">{passed}✓</span>}
      {failed > 0 && <span className="text-red-600 dark:text-red-400">{failed}✗</span>}
      {queued > 0 && <span className="text-blue-600 dark:text-blue-400">{queued}⋯</span>}
    </span>
  );
}

interface RunsPaneProps {
  runs: HubRun[];
  requests: HubRunRequest[];
  loading: boolean;
  error: string | null;
  onOpenRun: (runId: string) => void;
}

export function RunsPane({ runs, requests, loading, error, onOpenRun }: RunsPaneProps) {
  const [expandedRequest, setExpandedRequest] = useState<string | null>(null);
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

        {activeRequests.map((request) => {
          const isExpanded = expandedRequest === request.id;
          return (
            <button
              key={request.id}
              className="w-full text-left rounded-md border border-border bg-background/85 backdrop-blur-sm px-3 py-2 hover:bg-muted/70"
              onClick={() =>
                request.runId !== null
                  ? onOpenRun(request.runId)
                  : setExpandedRequest(isExpanded ? null : request.id)
              }
              data-testid={`request-row-${request.id}`}
            >
              <div className="flex items-center gap-2">
                <RunStatusBar {...requestCounts(request)} live={request.status !== 'failed'} />
                <span className="text-sm truncate flex-1">{request.taskNames.join(', ')}</span>
                {request.runId !== null ? (
                  <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                ) : isExpanded ? (
                  <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                ) : (
                  <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                )}
              </div>
              <div className="text-[11px] text-muted-foreground pt-0.5">
                dispatched {new Date(request.createdAt).toLocaleTimeString()}
                {request.claimedBy !== null && ` · claimed by ${request.claimedBy}`}
                {!isExpanded && request.error !== null && ` · ${request.error}`}
              </div>
              {isExpanded && (
                <div
                  className="pt-1.5 space-y-1 text-[11px] text-muted-foreground"
                  data-testid={`request-detail-${request.id}`}
                >
                  <div>
                    <span className="font-medium text-foreground">Tasks:</span>{' '}
                    {request.taskNames.join(', ')}
                  </div>
                  {request.error !== null && (
                    <div className="text-red-600/90 whitespace-pre-wrap break-words">
                      {request.error}
                    </div>
                  )}
                  {request.status === 'queued' && (
                    <div>
                      Waiting for a poller to claim it — run{' '}
                      <code className="bg-muted px-1 rounded">scripts/run-bench-hub-poller</code>{' '}
                      (add <code className="bg-muted px-1 rounded">--local</code> for this machine).
                    </div>
                  )}
                </div>
              )}
            </button>
          );
        })}

        {runs.map((run) => (
          <button
            key={run.run_id}
            className="w-full flex items-center gap-2 px-3 py-2 text-left rounded-md border border-border bg-background/85 backdrop-blur-sm hover:bg-muted/70"
            onClick={() => onOpenRun(run.run_id)}
            data-testid={`run-row-${run.run_id}`}
          >
            <RunStatusBar {...runCounts(run)} live={run.live} />
            <StatusCountsLabel {...runCounts(run)} />
            <span className="text-sm font-medium truncate flex-1">{run.run_id}</span>
            <span className="text-[11px] text-muted-foreground shrink-0">
              {run.tasks.length} task{run.tasks.length === 1 ? '' : 's'} ·{' '}
              {new Date(run.timestamp || run.uploaded_at).toLocaleString()}
            </span>
            <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          </button>
        ))}

        {!loading && error === null && runs.length === 0 && activeRequests.length === 0 && (
          <div className="py-6 text-sm text-muted-foreground">
            No runs yet — select tasks below and press Run.
          </div>
        )}
      </div>
    </div>
  );
}
