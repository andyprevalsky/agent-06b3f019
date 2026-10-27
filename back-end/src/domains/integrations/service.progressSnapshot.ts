/**
 * Pure IntegrationSyncProgress row → wire mappers, shared by the write path
 * (service.progress) and the account view (service.accountsView).
 *
 *   ProgressRow ──► progressOf ──► IntegrationAccountProgress (bar numbers)
 *               └─► snapshotOf ──► ProgressSnapshot (what a writer gets back)
 */

import type { ProgressRow } from './repo.progress';
import {
  PROGRESS_UNITS,
  SYNC_STATES,
  toWireAccountId,
  type IntegrationAccountProgress,
  type ProgressSnapshot,
  type ProgressUnit,
  type SyncState,
} from './syncAccountsContract';

export const iso = (value: Date | null): string | null =>
  value === null ? null : value.toISOString();
const num = (value: bigint | null): number | null => (value === null ? null : Number(value));

export function asSyncState(value: string): SyncState {
  return (SYNC_STATES as readonly string[]).includes(value) ? (value as SyncState) : 'idle';
}

function asUnit(value: string | null): ProgressUnit | null {
  return value !== null && (PROGRESS_UNITS as readonly string[]).includes(value)
    ? (value as ProgressUnit)
    : null;
}

/** The bar numbers of one stored run; a synced run always reads 100%. */
export function progressOf(row: ProgressRow): IntegrationAccountProgress {
  const state = asSyncState(row.state);
  return {
    pct: state === 'synced' ? 100 : row.pct,
    done: num(row.done),
    total: num(row.total),
    unit: asUnit(row.unit),
    eta_sec: row.etaSec,
    phase: row.phase,
  };
}

export function snapshotOf(row: ProgressRow): ProgressSnapshot {
  return {
    provider: row.provider,
    accountId: toWireAccountId(row.accountId),
    runId: row.runId,
    seq: row.seq,
    state: asSyncState(row.state),
    progress: progressOf(row),
    lastSyncAt: iso(row.lastSyncedAt),
    lastError: row.lastError,
  };
}
