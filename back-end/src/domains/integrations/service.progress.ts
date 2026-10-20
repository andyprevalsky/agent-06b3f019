/**
 * Write path for sync progress (one row per existing Integration row), shared
 * by backend sync jobs (`reportProgressBestEffort` at their batch boundaries)
 * and the Mac app (HTTP route).
 *
 *   input ─► validate key ─► lock(account) ─► read row ─► decideProgressWrite
 *        ─► create | update | (duplicate / coalesced / stale: no write) ─► snapshot
 *
 * 10k rule: one row per account, one lock per account, at most one write per
 * second per syncing account plus its state transitions.
 */

import { createLogger } from '../../providers/logger';
import * as repo from './repo.progress';
import { decideProgressWrite, type ProgressFields } from './service.progressRules';
import { snapshotOf } from './service.progressSnapshot';
import {
  assertProviderSlug,
  MAX_PROGRESS_ACCOUNTS_PER_USER,
  progressWriteSchema,
  toStorageAccountId,
  type ProgressWriteInput,
  type ProgressWriteOutcome,
  type SyncState,
} from './syncAccountsContract';

const log = createLogger('IntegrationProgress');

export class ProgressAccountLimitError extends Error {
  constructor() {
    super(`At most ${MAX_PROGRESS_ACCOUNTS_PER_USER} integration accounts may report progress`);
  }
}

export interface ReportProgressParams {
  userId: string;
  provider: string;
  /** Wire or storage account id (`''` / `'default'` = the legacy default account). */
  accountId: string;
  input: ProgressWriteInput;
  /** Injected for tests; defaults to the current time. */
  now?: Date;
}

type Tx = repo.Tx;

async function createFirstProgress(
  tx: Tx,
  key: repo.ProgressKey,
  fields: ProgressFields,
  now: Date
): Promise<ProgressWriteOutcome> {
  if ((await repo.countProgressRowsForUser(tx, key.userId)) >= MAX_PROGRESS_ACCOUNTS_PER_USER) {
    throw new ProgressAccountLimitError();
  }
  return {
    applied: true,
    snapshot: snapshotOf(await repo.createProgress(tx, key, { ...fields, updatedAt: now })),
  };
}

async function judgeAgainstStored(
  tx: Tx,
  existing: repo.ProgressRow,
  input: ProgressWriteInput,
  now: Date
): Promise<ProgressWriteOutcome> {
  const stored = { ...existing, state: existing.state as SyncState };
  const decision = decideProgressWrite(stored, input, now);
  if (decision.kind === 'write') {
    const updated = await repo.updateProgress(tx, existing.id, {
      ...decision.fields,
      updatedAt: now,
    });
    return { applied: true, snapshot: snapshotOf(updated) };
  }
  const snapshot = snapshotOf(existing);
  if (decision.kind === 'duplicate') return { applied: false, reason: 'duplicate', snapshot };
  if (decision.kind === 'coalesced') {
    return {
      applied: false,
      reason: 'coalesced',
      retryAfterMs: decision.retryAfterMs,
      snapshot,
    };
  }
  log.info('Stale progress write ignored', {
    userId: existing.userId,
    provider: existing.provider,
    runId: input.runId,
    detail: decision.detail,
  });
  return { applied: false, reason: 'stale', detail: decision.detail, snapshot };
}

export async function reportIntegrationProgress(
  params: ReportProgressParams
): Promise<ProgressWriteOutcome> {
  assertProviderSlug(params.provider);
  const input = progressWriteSchema.parse(params.input);
  const key = {
    userId: params.userId,
    provider: params.provider,
    accountId: toStorageAccountId(params.accountId),
  };
  const now = params.now ?? new Date();

  return repo.withAccountProgressLock(key, async (tx) => {
    const existing = await repo.findProgress(tx, key);
    if (existing !== null) return judgeAgainstStored(tx, existing, input, now);
    const decision = decideProgressWrite(null, input, now);
    if (decision.kind !== 'write') throw new Error('A first progress write is always applied');
    return createFirstProgress(tx, key, decision.fields, now);
  });
}

/**
 * The pipeline-side write: one progress report at an existing batch or phase
 * boundary. Best-effort by contract — it never throws and never changes the
 * sync's outcome; a failed write is logged and the next boundary supersedes it.
 */
export async function reportProgressBestEffort(params: ReportProgressParams): Promise<void> {
  try {
    await reportIntegrationProgress(params);
  } catch (error: unknown) {
    log.warn('Progress write failed (sync unaffected)', {
      userId: params.userId,
      provider: params.provider,
      state: params.input.state,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/** Drop one row's progress (after the row is gone). Returns rows removed. */
export async function clearAccountProgress(userId: string, provider: string, accountId: string) {
  return repo.deleteProgress({ userId, provider, accountId: toStorageAccountId(accountId) });
}
