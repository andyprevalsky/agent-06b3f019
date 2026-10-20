/**
 * Sync progress for an upload whose item counts the server already knows
 * (cookies, passwords, VCF contacts): one run per upload over the legacy
 * (`''`) row of each Integration the upload writes.
 *
 *   start()        syncing, done 0 of each row's total
 *   advance(done)  syncing, done so far (at the upload's existing batch boundary)
 *   finish()       synced, done = total
 *   fail(error)    failed, with the error
 *   step(work)     run one step of the upload; a throw is reported as fail and rethrown
 *
 * Best-effort: every write goes through reportProgressBestEffort, so a progress
 * write never fails or changes the upload.
 */

import { reportProgressBestEffort } from './service.progress';
import type { ProgressUnit, ProgressWriteInput } from './syncAccountsContract';

type RunWrite = Omit<ProgressWriteInput, 'runId' | 'unit' | 'total'>;

export function uploadRunProgress(params: {
  userId: string;
  /** Run id prefix naming the upload (`cookies-upload`, `passwords-upload`, …). */
  run: string;
  unit: ProgressUnit;
  /** Integration name → the items this upload writes to it. */
  totals: ReadonlyMap<string, number>;
}) {
  const runId = `${params.run}:${params.userId}:${Date.now()}`;
  const each = (write: (total: number) => RunWrite) =>
    Promise.all(
      [...params.totals].map(([provider, total]) =>
        reportProgressBestEffort({
          userId: params.userId,
          provider,
          accountId: '',
          input: { runId, unit: params.unit, total, ...write(total) },
        })
      )
    );
  const fail = (error: unknown) =>
    each(() => ({
      state: 'failed',
      error: error instanceof Error ? error.message : String(error),
    }));
  return {
    start: () => each(() => ({ state: 'syncing', done: 0 })),
    advance: (done: number) => each(() => ({ state: 'syncing', done })),
    finish: () => each((total) => ({ state: 'synced', done: total })),
    fail,
    step: async <T>(work: () => Promise<T>): Promise<T> => {
      try {
        return await work();
      } catch (error: unknown) {
        await fail(error);
        throw error;
      }
    },
  };
}
