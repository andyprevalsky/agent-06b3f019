/**
 * integration-progress — service layer
 *
 * One sync run's progress reporter for a Mac pipeline. A run has a fresh id and
 * an increasing `seq`, so the backend orders its writes and rejects late ones;
 * the pipeline calls `report` at its existing batch boundaries and once with its
 * terminal state (`synced` / `failed`), which the backend always stores.
 *
 *   pipeline batch ─► run.report({state, done, total, unit, phase}) ─► POST …/progress
 *
 * Every write is best-effort: a failed, coalesced (202) or stale (409) POST never
 * fails the sync.
 *
 * Layer rule: service imports own repo/types/config and shared providers only.
 */

import { randomUUID } from 'crypto';
import { DEFAULT_ACCOUNT_ID } from './config';
import { postProgress } from './repo';
import type { ProgressPostResult, ProgressRunWrite } from './types';

export interface ProgressRun {
  readonly runId: string;
  /** Post one write; its `seq` is taken synchronously, in call order. */
  report: (write: ProgressRunWrite, accessToken: string) => Promise<ProgressPostResult>;
}

/** Start a run for the provider's Integration row (the legacy `default` account). */
export function startProgressRun(provider: string): ProgressRun {
  const runId = randomUUID();
  let seq = 0;
  return {
    runId,
    report: (write, accessToken) => {
      seq += 1;
      return postProgress(provider, DEFAULT_ACCOUNT_ID, { runId, seq, ...write }, accessToken);
    },
  };
}
