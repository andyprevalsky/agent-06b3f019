/**
 * STATE MACHINE: BenchmarkRunView (the in-app run view)
 *
 *   mount(runId) ──► loading ──GET /runs/:id ok──► ready(detail)
 *        │                │
 *        │                └─fail──► error (retry → loading)
 *   ready(live run) ──5s poll──► ready(refreshed detail)
 *   ready + click a task's "Open agent" ──► onOpenAgent(runId, agentId)
 *   Back ──► onBack() (parent restores the hub panes)
 *
 * The in-app version of the fleet report-card dashboard: run header with
 * verdict, summary tiles (pass/fail, cost, tokens, agents), and a per-task
 * table (flags, status, duration, cost, cache, agents, failure reason).
 */

import { useCallback, useEffect, useState } from 'react';
import { ArrowLeft, Loader2 } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import type { HubRunDetail } from '@/lib/api/benchmarksHub';
import { fetchHubRun } from '@/lib/api/benchmarksHub';
import { TaskFlagIcons } from './TaskFlagIcons';

const LIVE_POLL_MS = 5000;

function verdictBadge(detail: HubRunDetail) {
  if (detail.live)
    return (
      <Badge className="bg-orange-100 text-orange-700 dark:bg-orange-950 dark:text-orange-300">
        ● live
      </Badge>
    );
  if (detail.totals.failed === 0 && detail.totals.passed > 0)
    return (
      <Badge className="bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300">
        pass
      </Badge>
    );
  return (
    <Badge className="bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300">failed</Badge>
  );
}

function statusBadge(status: string) {
  const s = status.toLowerCase();
  if (s === 'running' || s === 'queued')
    return (
      <Badge className="bg-orange-100 text-orange-700 dark:bg-orange-950 dark:text-orange-300">
        {s}
      </Badge>
    );
  if (s === 'passed')
    return (
      <Badge className="bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300">
        pass
      </Badge>
    );
  return <Badge className="bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300">{s}</Badge>;
}

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function Tile({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-border bg-background/85 backdrop-blur-sm px-3 py-2 min-w-[92px]">
      <div className="text-[11px] text-muted-foreground">{label}</div>
      <div className="text-sm font-semibold">{value}</div>
    </div>
  );
}

interface BenchmarkRunViewProps {
  runId: string;
  onOpenAgent: (runId: string, agentId: string) => void;
  onBack: () => void;
}

export function BenchmarkRunView({ runId, onOpenAgent, onBack }: BenchmarkRunViewProps) {
  const [detail, setDetail] = useState<HubRunDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    async (background = false) => {
      if (!background) {
        setLoading(true);
        setError(null);
      }
      try {
        setDetail(await fetchHubRun(runId));
        setError(null);
      } catch (err) {
        if (!background) setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!background) setLoading(false);
      }
    },
    [runId],
  );

  useEffect(() => {
    void load();
  }, [load]);

  // Live runs keep moving — refresh the detail while the run is in flight.
  useEffect(() => {
    if (detail === null || !detail.live) return;
    const id = window.setInterval(() => {
      void load(true);
    }, LIVE_POLL_MS);
    return () => window.clearInterval(id);
  }, [detail, load]);

  return (
    <div className="flex flex-col h-full min-h-0 pt-20 pb-4" data-testid="benchmark-run-view">
      <div className="flex items-center gap-3 pb-3">
        <Button variant="outline" size="sm" onClick={onBack} data-testid="run-back">
          <ArrowLeft className="h-3.5 w-3.5 mr-1" /> Benchmarks
        </Button>
        <div className="min-w-0">
          <div className="text-sm font-semibold font-mono truncate">{runId}</div>
          {detail !== null && (
            <div className="text-[11px] text-muted-foreground">
              {detail.suite ?? 'run'} ·{' '}
              {new Date(detail.timestamp || detail.uploaded_at).toLocaleString()}
              {detail.source !== null && ` · via ${detail.source}`}
            </div>
          )}
        </div>
        {detail !== null && <span className="ml-auto shrink-0">{verdictBadge(detail)}</span>}
      </div>

      {loading && (
        <div className="flex items-center gap-2 py-8 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading run…
        </div>
      )}
      {error !== null && !loading && (
        <div className="py-8 text-sm text-red-600">
          {error}{' '}
          <button className="underline" onClick={() => void load()}>
            retry
          </button>
        </div>
      )}

      {detail !== null && !loading && error === null && (
        <>
          <div className="flex flex-wrap gap-2 pb-3" data-testid="run-tiles">
            <Tile
              label="Tasks"
              value={`${detail.totals.passed + detail.totals.failed}/${detail.tasks.length} done`}
            />
            <Tile label="Passed" value={String(detail.totals.passed)} />
            <Tile label="Failed" value={String(detail.totals.failed)} />
            <Tile label="Cost" value={`$${(detail.totals.cost_cents / 100).toFixed(2)}`} />
            <Tile
              label="Tokens"
              value={`${fmtTokens(detail.totals.tokens_in)} in · ${fmtTokens(detail.totals.tokens_out)} out`}
            />
            <Tile label="Agents" value={String(detail.totals.agents)} />
          </div>

          <div className="flex-1 min-h-0 overflow-y-auto rounded-xl border border-border bg-background/85 backdrop-blur-sm">
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-background border-b border-border">
                <tr className="text-left text-[11px] uppercase tracking-wide text-muted-foreground">
                  <th className="px-3 py-2 font-medium">Task</th>
                  <th className="px-3 py-2 font-medium">Status</th>
                  <th className="px-3 py-2 font-medium">Duration</th>
                  <th className="px-3 py-2 font-medium">Cost</th>
                  <th className="px-3 py-2 font-medium">Cache</th>
                  <th className="px-3 py-2 font-medium">Agents</th>
                  <th className="px-3 py-2" />
                </tr>
              </thead>
              <tbody>
                {detail.tasks.map((task) => (
                  <tr
                    key={task.name}
                    className="border-b border-border/50 hover:bg-muted/40"
                    data-testid={`run-view-task-${task.name}`}
                  >
                    <td className="px-3 py-2">
                      <span className="font-medium">{task.name}</span>
                      <TaskFlagIcons
                        simOn={task.world_model_mode === 'simulate'}
                        fastOn={task.fast_mode}
                      />
                      {task.failure_reason !== null && (
                        <div className="text-[11px] text-red-600/90 max-w-xl truncate">
                          {task.failure_reason}
                        </div>
                      )}
                    </td>
                    <td className="px-3 py-2">{statusBadge(task.status)}</td>
                    <td className="px-3 py-2 text-muted-foreground">
                      {task.duration_seconds !== null
                        ? `${Math.round(task.duration_seconds)}s`
                        : '—'}
                    </td>
                    <td className="px-3 py-2 text-muted-foreground">
                      {task.cost_cents !== null ? `$${(task.cost_cents / 100).toFixed(2)}` : '—'}
                    </td>
                    <td className="px-3 py-2 text-muted-foreground">
                      {task.cache_hit_pct !== null ? `${task.cache_hit_pct}%` : '—'}
                    </td>
                    <td className="px-3 py-2 text-muted-foreground">
                      {task.tree_agent_count ?? '—'}
                    </td>
                    <td className="px-3 py-2 text-right">
                      <Button
                        variant="outline"
                        size="sm"
                        className={cn('h-7 px-2 text-xs', task.agent_id === null && 'opacity-50')}
                        disabled={task.agent_id === null}
                        onClick={() => task.agent_id !== null && onOpenAgent(runId, task.agent_id)}
                        data-testid={`run-view-open-${task.name}`}
                      >
                        Open agent
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
