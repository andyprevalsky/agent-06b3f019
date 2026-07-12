/**
 * Benchmark Hub dispatch: the run-request queue (create/claim/progress/
 * complete with atomic transitions) and the composed run view (stored-run
 * detail + dispatch lifecycle for the startup timeline).
 */

import { z } from 'zod';
import * as hubStore from '../../providers/benchmarkHubStore';
import * as repo from './repo';

export const runRequestSchema = z
  .object({
    task_names: z.array(z.string().min(1)).min(1).max(50),
    sim_on: z.array(z.string().min(1)).max(50).optional(),
    // Claim scope: pollers only claim matching requests (tests use a private
    // scope so they never race the stack's default poller). Unscoped = user.
    scope: z.string().min(1).max(120).optional(),
  })
  .strict();

export class UnknownTasksError extends Error {
  constructor(public readonly unknown: string[]) {
    super(`Unknown tasks: ${unknown.join(', ')}`);
  }
}

export async function createRunRequest(
  input: z.infer<typeof runRequestSchema>,
  requestedBy: string
) {
  const known = new Set(await repo.findExistingTaskNames(input.task_names));
  const unknown = input.task_names.filter((n) => !known.has(n));
  if (unknown.length > 0) throw new UnknownTasksError(unknown);
  const request = await repo.createRunRequestRow({
    taskNames: input.task_names,
    simOn: input.sim_on ?? [],
    requestedBy,
    scope: input.scope ?? null,
  });
  // INVARIANT: every dispatched run links to a run dashboard from the moment
  // it exists. Create the placeholder run (queued tasks) under the same
  // hub-<request-id> the poller streams to; snapshots/final upserts replace it.
  const runId = `hub-${request.id}`;
  await hubStore.putRun(
    {
      run_id: runId,
      timestamp: new Date().toISOString(),
      suite: 'hub-dispatch',
      source: 'hub-dispatch',
      tasks: input.task_names.map((name) => ({ name, status: 'queued' })),
    },
    { live: true }
  );
  return repo.updateRunRequestRow(request.id, { runId });
}

export async function listRunRequests(statuses?: string[]) {
  return repo.listRunRequestRows(statuses);
}

/** Atomic queued→running claim; only one poller can win a request. */
export async function claimRunRequest(id: string, claimedBy: string) {
  const claimed = await repo.transitionQueuedToRunning(id, claimedBy);
  if (!claimed) return null;
  return repo.findRunRequest(id);
}

/**
 * The run view's full payload: stored-run detail plus the dispatch request's
 * lifecycle (queued/claimed timestamps, claimer, error) so the view can render
 * the startup timeline the fleet dashboard had while a run is still spinning up.
 */
export async function getRunView(runId: string) {
  const detail = await hubStore.getRunDetail(runId);
  if (detail === null) return null;
  const request = await repo.findRunRequestByRunId(runId);
  return {
    ...detail,
    dispatch:
      request === null
        ? null
        : {
            status: request.status,
            created_at: request.createdAt.toISOString(),
            claimed_at: request.claimedAt === null ? null : request.claimedAt.toISOString(),
            claimed_by: request.claimedBy,
            updated_at: request.updatedAt.toISOString(),
            error: request.error,
          },
  };
}

export const runRequestUpdateSchema = z
  .object({
    action: z.enum(['claim', 'progress', 'complete', 'fail', 'cancel']),
    claimed_by: z.string().min(1).max(200).optional(),
    progress: z.unknown().optional(),
    run_id: z.string().min(1).max(200).optional(),
    error: z.string().max(4000).optional(),
  })
  .strict();

export async function updateRunRequest(id: string, update: z.infer<typeof runRequestUpdateSchema>) {
  if (update.action === 'claim') {
    return claimRunRequest(id, update.claimed_by ?? 'unknown');
  }
  const existing = await repo.findRunRequest(id);
  if (existing === null) return null;
  if (update.action === 'progress') {
    return repo.updateRunRequestRow(id, {
      progress: (update.progress ?? {}) as repo.JsonInput,
      ...(update.run_id !== undefined ? { runId: update.run_id } : {}),
    });
  }
  if (update.action === 'complete') {
    return repo.updateRunRequestRow(id, {
      status: 'completed',
      ...(update.run_id !== undefined ? { runId: update.run_id } : {}),
    });
  }
  if (update.action === 'fail') {
    const failed = await repo.updateRunRequestRow(id, {
      status: 'failed',
      error: update.error ?? 'unknown failure',
    });
    // Keep the linked run dashboard truthful: mark still-pending placeholder
    // tasks failed with the dispatch error (real uploaded results are kept).
    if (failed.runId !== null) {
      const bundle = await hubStore.getRunBundle(failed.runId);
      if (bundle !== null && Array.isArray(bundle.tasks)) {
        // Any task without a real verdict (placeholder OR mid-run snapshot —
        // passed is undefined/null either way) is failed by the dispatch dying.
        const tasks = (bundle.tasks as Array<Record<string, unknown>>).map((t) =>
          typeof t.passed !== 'boolean'
            ? {
                ...t,
                status: 'failed',
                passed: false,
                failure_reason: update.error ?? 'dispatch failed',
              }
            : t
        );
        await hubStore.putRun({ ...bundle, tasks }, { live: false });
      }
    }
    return failed;
  }
  // cancel: only queued requests can be cancelled (a running claim owns it)
  const cancelled = await repo.transitionQueuedToCancelled(id);
  if (!cancelled) return null;
  const row = await repo.findRunRequest(id);
  if (row !== null && row.runId !== null) {
    await hubStore.deleteRun(row.runId); // placeholder dashboard goes with it
  }
  return row;
}
