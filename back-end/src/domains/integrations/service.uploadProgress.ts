/**
 * Sync progress for an upload whose item counts the server already knows
 * (cookies, passwords, VCF contacts): one run per upload over the legacy
 * (`''`) row of each Integration the upload writes.
 *
 *   start()        first sync of a row: syncing, done 0 of the row's total
 *                  re-upload of a row whose last run finished synced: no write,
 *                  the row keeps reading synced with its count (a refresh)
 *   advance(done)  syncing, done so far (at the upload's existing batch boundary;
 *                  first syncs only)
 *   finish()       synced, done = total (every row: a refresh records its run here)
 *   fail(error)    failed, with the error (every row)
 *   step(work)     run one step of the upload; a throw is reported as fail and rethrown
 *
 * Why refreshes open no bar: the Mac app re-uploads every connected browser's
 * full cookie set (and Chrome's passwords) every 5 minutes. Reopening the bar
 * at "0 of N" for each of those runs made a synced row read as reset to 0 for
 * most of every cycle. A refresh still ends in its own synced / failed run, so
 * a failed re-upload is shown.
 *
 * Best-effort: every write goes through reportProgressBestEffort, so a progress
 * read or write never fails or changes the upload.
 */

import { providersLastSynced, reportProgressBestEffort } from './service.progress';
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
  const providers = [...params.totals.keys()];
  /** Rows this upload refreshes (last run synced): they get no syncing writes. */
  let refreshing = new Set<string>();
  const each = (write: (total: number) => RunWrite, rows: string[] = providers) =>
    Promise.all(
      rows.map((provider) => {
        const total = params.totals.get(provider) ?? 0;
        return reportProgressBestEffort({
          userId: params.userId,
          provider,
          accountId: '',
          input: { runId, unit: params.unit, total, ...write(total) },
        });
      })
    );
  const firstSyncs = () => providers.filter((provider) => !refreshing.has(provider));
  const fail = (error: unknown) =>
    each(() => ({
      state: 'failed',
      error: error instanceof Error ? error.message : String(error),
    }));
  return {
    start: async () => {
      refreshing = await providersLastSynced(params.userId, providers);
      return each(() => ({ state: 'syncing', done: 0 }), firstSyncs());
    },
    advance: (done: number) => each(() => ({ state: 'syncing', done }), firstSyncs()),
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
