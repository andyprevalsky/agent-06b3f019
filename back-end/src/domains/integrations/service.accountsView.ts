/**
 * Pure derivation of per-account chips from Integration rows, provider account
 * sources (email credentials, Plaid items) and IntegrationSyncProgress rows.
 *
 *   rows ──► adapter.list ──► known accounts ─┐
 *                                              ├─► IntegrationAccount[] per provider
 *   progress rows (same provider+accountId) ──┘     (+ progress-only accounts)
 *
 * State precedence: a provider health of `needs_reconnect` always wins (only
 * re-consent fixes it); otherwise a progress row, when present, is
 * authoritative; otherwise the legacy health (row status / credential state).
 */

import type { EmailCredentialSource, PlaidItemSource } from './repo.accounts';
import type { ProgressRow } from './repo.progress';
import { resolveAccountAdapter } from './service.accountRegistry';
import {
  SYNC_STATES,
  toWireAccountId,
  type AccountsByProvider,
  type IntegrationAccount,
  type IntegrationAccountProgress,
  type ProgressSnapshot,
  type SyncState,
} from './syncAccountsContract';

/** Fields of an Integration row the account view reads (full or light rows fit). */
export interface AccountViewRow {
  id: string;
  name: string;
  accountId: string;
  accountEmail: string | null;
  status: string;
  lastSyncAt: Date | null;
  lastSuccessfulSyncAt: Date | null;
  failureReason: string | null;
  emailCredentials?: EmailCredentialSource[];
}

interface KnownAccount {
  provider: string;
  storageAccountId: string;
  rowId: string | null;
  label: string | null;
  health: SyncState;
  lastSyncAt: Date | null;
  lastError: string | null;
}

const ROW_STATUS_HEALTH: Record<string, SyncState> = {
  CONNECTED: 'synced',
  SYNCING: 'syncing',
  SYNC_FAILED: 'failed',
  EXPIRED: 'needs_reconnect',
  NOT_CONNECTED: 'idle',
};

const iso = (value: Date | null): string | null => (value === null ? null : value.toISOString());
const num = (value: bigint | null): number | null => (value === null ? null : Number(value));

function asSyncState(value: string): SyncState {
  return (SYNC_STATES as readonly string[]).includes(value) ? (value as SyncState) : 'idle';
}

function rowAccount(row: AccountViewRow): KnownAccount {
  const health = ROW_STATUS_HEALTH[row.status] ?? 'idle';
  return {
    provider: row.name,
    storageAccountId: row.accountId,
    rowId: row.id,
    label: row.accountEmail,
    health,
    lastSyncAt: row.lastSuccessfulSyncAt ?? row.lastSyncAt,
    lastError: health === 'failed' || health === 'needs_reconnect' ? row.failureReason : null,
  };
}

function credentialAccounts(row: AccountViewRow): KnownAccount[] {
  const accounts: KnownAccount[] = [];
  for (const credential of row.emailCredentials ?? []) {
    if (credential.email === null || credential.email === '') continue;
    let health: SyncState = row.status === 'SYNCING' ? 'syncing' : 'synced';
    if (credential.state === 'needs_reconnect') health = 'needs_reconnect';
    else if (credential.state === 'sync_failed') health = 'failed';
    accounts.push({
      provider: row.name,
      storageAccountId: credential.email,
      rowId: row.id,
      label: credential.email,
      health,
      // The shared row's sync time is not a per-address claim.
      lastSyncAt: null,
      lastError: health === 'synced' || health === 'syncing' ? null : credential.lastErrorReason,
    });
  }
  return accounts;
}

function plaidAccounts(row: AccountViewRow, items: PlaidItemSource[]): KnownAccount[] {
  return items
    .filter((item) => item.integrationId === row.id)
    .map((item) => {
      let health: SyncState = item.cursor === null ? 'syncing' : 'synced';
      if (item.status === 'REQUIRES_REAUTH') health = 'needs_reconnect';
      else if (item.status === 'ERROR') health = 'failed';
      return {
        provider: row.name,
        storageAccountId: item.id,
        rowId: row.id,
        label: item.institutionName,
        health,
        lastSyncAt: item.lastSyncAt,
        lastError: health === 'failed' || health === 'needs_reconnect' ? item.errorMessage : null,
      };
    });
}

function knownAccountsOf(row: AccountViewRow, plaidItems: PlaidItemSource[]): KnownAccount[] {
  const kind = resolveAccountAdapter(row.name).list;
  if (kind === 'email_credentials') return credentialAccounts(row);
  if (kind === 'plaid_items') return plaidAccounts(row, plaidItems);
  return [rowAccount(row)];
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

function toAccount(known: KnownAccount, progress: ProgressRow | null): IntegrationAccount {
  const progressState = progress === null ? null : asSyncState(progress.state);
  const state =
    known.health === 'needs_reconnect' ? 'needs_reconnect' : (progressState ?? known.health);
  const lastSyncAt = progress?.lastSyncedAt ?? known.lastSyncAt;
  return {
    provider: known.provider,
    accountId: toWireAccountId(known.storageAccountId),
    label: known.label,
    state,
    progress: progressOf(progress, state),
    lastSyncAt: iso(lastSyncAt),
    lastError:
      state === 'needs_reconnect' && known.health === 'needs_reconnect'
        ? known.lastError
        : (progress?.lastError ?? known.lastError),
  };
}

/** Every account of every provider the user has a row or a progress report for. */
export function buildAccountsView(input: {
  rows: AccountViewRow[];
  plaidItems: PlaidItemSource[];
  progress: ProgressRow[];
}): AccountsByProvider {
  const progressByKey = new Map(
    input.progress.map((p) => [`${p.provider}\u0000${p.accountId}`, p])
  );
  const accountsByProvider: AccountsByProvider = {};
  const push = (account: IntegrationAccount) => {
    (accountsByProvider[account.provider] ??= []).push(account);
  };

  for (const row of input.rows) {
    for (const known of knownAccountsOf(row, input.plaidItems)) {
      const key = `${known.provider}\u0000${known.storageAccountId}`;
      push(toAccount(known, progressByKey.get(key) ?? null));
      progressByKey.delete(key);
    }
  }
  // A first sync can report progress before its account row exists.
  for (const progress of progressByKey.values()) {
    const snapshot = snapshotOf(progress);
    push({
      provider: snapshot.provider,
      accountId: snapshot.accountId,
      label: null,
      state: snapshot.state,
      progress: snapshot.progress,
      lastSyncAt: snapshot.lastSyncAt,
      lastError: snapshot.lastError,
    });
  }
  return accountsByProvider;
}
