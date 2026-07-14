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
import { Badge } from '@/components/ui/badge';
import type { HubRun, HubRunRequest } from '@/lib/api/benchmarksHub';

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
                {statusBadge(request.status, false)}
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
            {statusBadge(runVerdict(run), run.live)}
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
