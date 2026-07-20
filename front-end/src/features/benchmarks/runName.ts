import type { HubRun } from '@/lib/api/benchmarksHub';

/**
 * A human-readable label for a run, shown next to the opaque run_id so the Runs
 * list reads semantically instead of as a wall of UUIDs / timestamp-pid ids.
 * Prefers an explicit bundle-supplied name; otherwise derives one from the
 * run's task names (deduped) — 1 task shows its name, ≤3 join with commas, and
 * longer slices summarize as "first, second +N more". Falls back to
 * suite/source, then a literal "run".
 *
 * Kept in its own module (not RunsPane.tsx) so the component file only exports
 * components — the parallel python hub mirrors this in
 * agents/benchmarks/agent_link_server.py:_derive_run_name.
 */
export function deriveRunName(run: HubRun): string {
  const explicit = run.name?.trim();
  if (explicit) return explicit;
  const names: string[] = [];
  for (const t of run.tasks) {
    const n = t.name?.trim();
    if (n && !names.includes(n)) names.push(n);
  }
  if (names.length === 0) return run.suite?.trim() || run.source?.trim() || 'run';
  if (names.length <= 3) return names.join(', ');
  return `${names.slice(0, 2).join(', ')} +${names.length - 2} more`;
}
