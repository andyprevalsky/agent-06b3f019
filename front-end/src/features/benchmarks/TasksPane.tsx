/**
 * STATE MACHINE: TasksPane
 *
 *   loading ──fetch ok──► ready ──user filters──► ready (derived visibleTasks)
 *      │                    │
 *      └─fetch fail──► error│(retry → loading)
 *                           │
 *   ready + toggle checkbox / select-all-filtered ──► ready (selection set)
 *   catalog refetch (props.tasks) ──► ready (selection pruned to names that
 *      still exist in the catalog)
 *   ready + click Run (selection ≥ 1) ──► dispatching ──201──► ready
 *      (selection cleared, onDispatched() tells the Runs pane to refresh)
 *
 * Task definitions are read-only (served from agents/benchmarks/tasks.json).
 *
 * Filters compose: text search ∧ tag filter ∧ group filter. "Select all"
 * operates on the FILTERED set. The Run button floats bottom-right and shows
 * the selection count.
 */

import { useEffect, useMemo, useState } from 'react';
import { Loader2, Play, Search } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import type { HubTask } from '@/lib/api/benchmarksHub';
import { createHubRunRequest } from '@/lib/api/benchmarksHub';
import { TaskFlagIcons } from './TaskFlagIcons';

const GROUPS = [
  'pre-deploy',
  'daily',
  'rose-bench',
  'process-bench',
  'polar-bench',
  'incomplete',
] as const;

function formatDuration(seconds: number | null): string {
  if (seconds === null) return '—';
  if (seconds < 90) return `${Math.round(seconds)}s`;
  return `${(seconds / 60).toFixed(1)}m`;
}

function passRateTone(rate: number | null): string {
  if (rate === null) return 'text-muted-foreground';
  if (rate >= 0.8) return 'text-emerald-600 dark:text-emerald-400';
  if (rate >= 0.5) return 'text-amber-600 dark:text-amber-400';
  return 'text-red-600 dark:text-red-400';
}

interface TasksPaneProps {
  tasks: HubTask[];
  loading: boolean;
  error: string | null;
  onRetry: () => void;
  onDispatched: () => void;
}

export function TasksPane({ tasks, loading, error, onRetry, onDispatched }: TasksPaneProps) {
  const [search, setSearch] = useState('');
  const [tagFilter, setTagFilter] = useState<string | null>(null);
  const [groupFilter, setGroupFilter] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [dispatching, setDispatching] = useState(false);
  const [dispatchError, setDispatchError] = useState<string | null>(null);

  const allTags = useMemo(() => {
    const counts = new Map<string, number>();
    for (const task of tasks) {
      for (const tag of task.tags) counts.set(tag, (counts.get(tag) ?? 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([tag]) => tag);
  }, [tasks]);

  const visibleTasks = useMemo(() => {
    const query = search.trim().toLowerCase();
    return tasks.filter((task) => {
      if (groupFilter !== null && task.group !== groupFilter) return false;
      if (tagFilter !== null && !task.tags.includes(tagFilter)) return false;
      if (query !== '') {
        const haystack = `${task.name} ${task.title ?? ''} ${task.description ?? ''}`.toLowerCase();
        if (!haystack.includes(query)) return false;
      }
      return true;
    });
  }, [tasks, search, tagFilter, groupFilter]);

  // A catalog refresh can drop or rename tasks — prune stale names from the
  // selection so Run can never dispatch tasks that no longer exist. Returning
  // `prev` unchanged lets React bail out, so this can't loop.
  useEffect(() => {
    setSelected((prev) => {
      const names = new Set(tasks.map((t) => t.name));
      const pruned = [...prev].filter((name) => names.has(name));
      return pruned.length === prev.size ? prev : new Set(pruned);
    });
  }, [tasks]);

  const allVisibleSelected =
    visibleTasks.length > 0 && visibleTasks.every((t) => selected.has(t.name));

  const toggleTask = (name: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  };

  const toggleAllVisible = () => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (allVisibleSelected) {
        for (const t of visibleTasks) next.delete(t.name);
      } else {
        for (const t of visibleTasks) next.add(t.name);
      }
      return next;
    });
  };

  const dispatchRun = async () => {
    if (selected.size === 0 || dispatching) return;
    setDispatching(true);
    setDispatchError(null);
    try {
      await createHubRunRequest([...selected]);
      setSelected(new Set());
      onDispatched();
    } catch (err) {
      setDispatchError(err instanceof Error ? err.message : String(err));
    } finally {
      setDispatching(false);
    }
  };

  return (
    <div className="relative flex flex-col h-full min-h-0" data-testid="tasks-pane">
      <div className="flex items-center gap-2 pb-2">
        <h2 className="text-sm font-semibold tracking-wide text-foreground">Tasks</h2>
        <span className="text-xs text-muted-foreground">
          {visibleTasks.length}/{tasks.length}
        </span>
      </div>

      <div className="relative pb-2">
        <Search className="absolute left-2.5 top-2.5 h-3.5 w-3.5 text-muted-foreground" />
        <Input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search tasks…"
          className="h-8 pl-8 text-sm"
          data-testid="task-search"
        />
      </div>

      <div className="flex flex-wrap gap-1.5 pb-1.5" data-testid="group-filters">
        {GROUPS.map((group) => (
          <Badge
            key={group}
            variant={groupFilter === group ? 'default' : 'outline'}
            className="cursor-pointer select-none"
            onClick={() => setGroupFilter(groupFilter === group ? null : group)}
            data-testid={`group-${group}`}
          >
            {group}
          </Badge>
        ))}
      </div>

      <div className="flex flex-wrap gap-1 pb-2 max-h-16 overflow-y-auto" data-testid="tag-filters">
        {allTags.map((tag) => (
          <Badge
            key={tag}
            variant={tagFilter === tag ? 'default' : 'secondary'}
            className="cursor-pointer select-none text-[11px]"
            onClick={() => setTagFilter(tagFilter === tag ? null : tag)}
            data-testid={`tag-${tag}`}
          >
            {tag}
          </Badge>
        ))}
      </div>

      <div className="flex items-center gap-2 border-b border-border pb-1.5">
        <Checkbox
          checked={allVisibleSelected}
          onCheckedChange={toggleAllVisible}
          aria-label="Select all filtered tasks"
          data-testid="select-all"
        />
        <span className="text-xs text-muted-foreground">
          {selected.size > 0 ? `${selected.size} selected` : 'Select all (filtered)'}
        </span>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto" data-testid="task-list">
        {loading && (
          <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading catalog…
          </div>
        )}
        {error !== null && !loading && (
          <div className="py-6 text-sm text-red-600">
            {error}{' '}
            <button className="underline" onClick={onRetry}>
              retry
            </button>
          </div>
        )}
        {!loading &&
          error === null &&
          visibleTasks.map((task) => (
            <div
              key={task.name}
              className={cn(
                'group flex items-start gap-2 rounded-md px-1.5 py-2 border-b border-border/50',
                'hover:bg-muted/50',
              )}
              data-testid={`task-row-${task.name}`}
            >
              <Checkbox
                checked={selected.has(task.name)}
                onCheckedChange={() => toggleTask(task.name)}
                aria-label={`Select ${task.name}`}
                className="mt-0.5"
                data-testid={`task-check-${task.name}`}
              />
              <div className="flex-1 min-w-0">
                <div className="flex items-center">
                  <span className="text-sm font-medium truncate">{task.title || task.name}</span>
                  <TaskFlagIcons
                    simOn={task.world_model_mode === 'simulate'}
                    fastOn={task.stats?.last_fast_mode === true}
                  />
                </div>
                <div className="text-[11px] text-muted-foreground truncate">{task.name}</div>
                <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 pt-0.5 text-[11px]">
                  <span className={passRateTone(task.stats?.pass_rate ?? null)}>
                    {task.stats?.pass_rate !== null && task.stats !== null
                      ? `${Math.round((task.stats.pass_rate ?? 0) * 100)}% pass`
                      : 'no runs'}
                  </span>
                  {task.stats !== null && (
                    <span className="text-muted-foreground">
                      {task.stats.passes}/{task.stats.attempts} · p50{' '}
                      {formatDuration(task.stats.p50_duration_seconds)} · p95{' '}
                      {formatDuration(task.stats.p95_duration_seconds)}
                    </span>
                  )}
                  <Badge variant="outline" className="text-[10px] px-1 py-0">
                    {task.group}
                  </Badge>
                  {task.tags.slice(0, 4).map((tag) => (
                    <span key={tag} className="text-muted-foreground/70">
                      #{tag}
                    </span>
                  ))}
                </div>
              </div>
            </div>
          ))}
        {!loading && error === null && visibleTasks.length === 0 && (
          <div className="py-6 text-sm text-muted-foreground">No tasks match the filters.</div>
        )}
      </div>

      {dispatchError !== null && (
        <div className="pt-1 text-xs text-red-600" data-testid="dispatch-error">
          {dispatchError}
        </div>
      )}

      {/* Floating run button — fixed to the pane's bottom-right */}
      <div className="absolute bottom-4 right-4 z-10">
        <Button
          onClick={() => void dispatchRun()}
          disabled={selected.size === 0 || dispatching}
          className="shadow-lg rounded-full h-11 px-5"
          data-testid="run-selected"
        >
          {dispatching ? (
            <Loader2 className="h-4 w-4 animate-spin mr-1.5" />
          ) : (
            <Play className="h-4 w-4 mr-1.5" />
          )}
          Run{selected.size > 0 ? ` ${selected.size}` : ''}
        </Button>
      </div>
    </div>
  );
}
