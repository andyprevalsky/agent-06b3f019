/**
 * Write path for per-account sync progress, shared by backend jobs (call
 * `reportIntegrationProgress` directly) and the Mac app (HTTP route).
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
import { snapshotOf } from './service.accountsView';
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

/** Drop one account's progress (after its data is gone). Returns rows removed. */
export async function clearAccountProgress(userId: string, provider: string, accountId: string) {
  return repo.deleteProgress({ userId, provider, accountId: toStorageAccountId(accountId) });
}

export async function clearProviderProgress(userId: string, provider: string) {
  return repo.deleteProviderProgress(userId, provider);
}
