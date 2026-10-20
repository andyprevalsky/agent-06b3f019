/**
 * Pure IntegrationSyncProgress row → wire mappers, shared by the write path
 * (service.progress) and the account view (service.accountsView).
 *
 *   ProgressRow ──► progressOf ──► IntegrationAccountProgress
 *               └─► snapshotOf ──► ProgressSnapshot (what a writer gets back)
 *
 * Kept free of the provider registry so backend sync jobs that report progress
 * (for example the Plaid sync) do not import the account adapters, whose
 * cleanup hooks import those same jobs.
 */

import type { ProgressRow } from './repo.progress';
import {
  SYNC_STATES,
  toWireAccountId,
  type IntegrationAccountProgress,
  type ProgressSnapshot,
  type SyncState,
} from './syncAccountsContract';

export const iso = (value: Date | null): string | null =>
  value === null ? null : value.toISOString();
const num = (value: bigint | null): number | null => (value === null ? null : Number(value));

export function asSyncState(value: string): SyncState {
  return (SYNC_STATES as readonly string[]).includes(value) ? (value as SyncState) : 'idle';
}

export function progressOf(row: ProgressRow | null, state: SyncState): IntegrationAccountProgress {
  if (row === null) {
    return {
      pct: state === 'synced' ? 100 : null,
      done: null,
      total: null,
      unit: null,
      eta_sec: null,
      phase: null,
      startedAt: null,
      updatedAt: null,
    };
  }
  return {
    pct: state === 'synced' ? 100 : row.pct,
    done: num(row.done),
    total: num(row.total),
    unit: row.unit,
    eta_sec: row.etaSec,
    phase: row.phase,
    startedAt: iso(row.startedAt),
    updatedAt: iso(row.updatedAt),
  };
}

export function snapshotOf(row: ProgressRow): ProgressSnapshot {
  const state = asSyncState(row.state);
  return {
    provider: row.provider,
    accountId: toWireAccountId(row.accountId),
    runId: row.runId,
    seq: row.seq,
    state,
    progress: progressOf(row, state),
    lastSyncAt: iso(row.lastSyncedAt),
    lastError: row.lastError,
  };
}
