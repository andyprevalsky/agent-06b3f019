/**
 * Parser for the integrations progress contract (lane L-CULL-INTEG):
 *
 *   GET /api/integrations → integrations[].accounts[] + accountsByProvider =
 *     { provider, accountId, label|null, state, lastSyncAt, lastError,
 *       progress: { pct, done, total, unit, eta_sec, phase } | null }
 *   GET /api/integrations/progress?since → the same accountsByProvider when changed
 *
 * Pure functions, no state machine. Every field is treated as untrusted:
 *   - `accounts` absent  → null (callers fall back to the row's status)
 *   - one entry per row  → that row's account; Gmail addresses and Plaid items
 *                          (multi-account before Rose Desktop) match by id
 *   - `total` null       → pct null (indeterminate bar, never a fake pct)
 *   - `eta_sec` null     → etaSec null (ETA text hidden)
 *   - pct >= 100         → the account reads as synced (bar disappears)
 *   - sync_failed / needs_reconnect / EXPIRED → error / warning tone, no bar
 *   - label null         → `unlabeled` (callers show their own row label)
 */

import type {
  AccountTone,
  AccountsByProvider,
  ConnectedIntegration,
  IntegrationAccount,
  SyncProgress,
  SyncProgressWire,
} from '../types';

function finite(n: unknown): n is number {
  return typeof n === 'number' && Number.isFinite(n);
}

/** Normalize one wire progress report; null when it carries nothing usable. */
export function parseSyncProgress(wire: SyncProgressWire | null | undefined): SyncProgress | null {
  if (wire === null || wire === undefined || typeof wire !== 'object') return null;
  const total = finite(wire.total) && wire.total > 0 ? Math.round(wire.total) : null;
  const rawDone = finite(wire.done) ? Math.max(Math.round(wire.done), 0) : null;
  const done = rawDone !== null && total !== null ? Math.min(rawDone, total) : rawDone;
  let pct: number | null = null;
  // Without a total any percentage would be a guess: the bar stays indeterminate.
  if (total !== null) {
    const raw = finite(wire.pct) ? wire.pct : done !== null ? (done / total) * 100 : null;
    pct = raw === null ? null : Math.min(Math.max(raw, 0), 100);
  }
  const etaSec = finite(wire.eta_sec) && wire.eta_sec >= 0 ? Math.round(wire.eta_sec) : null;
  const unit = typeof wire.unit === 'string' && wire.unit !== '' ? wire.unit : 'items';
  const phase = typeof wire.phase === 'string' && wire.phase.trim() !== '' ? wire.phase : null;
  return { pct, done, total, unit, etaSec: pct !== null && pct >= 100 ? 0 : etaSec, phase };
}

/** True once a determinate sync reached 100%: the chip flips to synced. */
export function isProgressComplete(progress: SyncProgress | null): boolean {
  return progress !== null && progress.pct !== null && progress.pct >= 100;
}

/** Map any server state string onto the four chip tones. */
export function accountToneForState(state: string): AccountTone {
  const s = state.trim().toLowerCase();
  if (s === 'syncing' || s === 'pending' || s === 'in_progress' || s === 'backfilling') {
    return 'syncing';
  }
  if (s === 'needs_reconnect' || s === 'needs_repair' || s === 'expired' || s === 'warning') {
    return 'warning';
  }
  if (s === 'error' || s === 'sync_failed' || s === 'failed') return 'error';
  return 'synced';
}

function parseEntry(entry: Record<string, unknown>): IntegrationAccount | null {
  const accountId = typeof entry.accountId === 'string' ? entry.accountId : '';
  if (accountId === '') return null;
  const state = typeof entry.state === 'string' ? entry.state : 'synced';
  const tone = accountToneForState(state);
  // A damaged account shows no bar: needs_reconnect / sync_failed outrank progress.
  const progress =
    tone === 'syncing' || tone === 'synced'
      ? parseSyncProgress(entry.progress as SyncProgressWire | null | undefined)
      : null;
  const labeled = typeof entry.label === 'string' && entry.label !== '';
  return {
    accountId,
    label: labeled ? (entry.label as string) : accountId,
    unlabeled: !labeled,
    state,
    progress,
    tone: tone === 'syncing' && isProgressComplete(progress) ? 'synced' : tone,
    lastSyncAt: typeof entry.lastSyncAt === 'string' ? entry.lastSyncAt : null,
    lastError:
      typeof entry.lastError === 'string' && entry.lastError !== '' ? entry.lastError : null,
  };
}

/**
 * Every account entry of a row, or null when the backend sent no `accounts`
 * (callers then derive the account from the row status exactly as before).
 * Single-account rows read the first entry (parseIntegrationAccount); only
 * rows that were already multi-account before Rose Desktop (Gmail addresses,
 * Plaid items) match entries to their own accounts by id.
 */
export function parseIntegrationAccounts(
  row: ConnectedIntegration | undefined,
): IntegrationAccount[] | null {
  const raw: unknown = row?.accounts;
  if (!Array.isArray(raw)) return null;
  const accounts: IntegrationAccount[] = [];
  for (const entry of raw as unknown[]) {
    if (entry === null || typeof entry !== 'object') continue;
    const parsed = parseEntry(entry as Record<string, unknown>);
    if (parsed !== null) accounts.push(parsed);
  }
  return accounts;
}

/** The row's one account (its first entry), or null without `accounts`. */
export function parseIntegrationAccount(
  row: ConnectedIntegration | undefined,
): IntegrationAccount | null {
  return parseIntegrationAccounts(row)?.[0] ?? null;
}

/**
 * The list the Rose Desktop rows read: each row's `accounts` replaced by the
 * freshest `accountsByProvider` entry (full list or progress poll), plus a
 * synthetic row for a provider that has only reported progress so far (its
 * first sync started before its Integration row exists).
 */
export function mergeAccountsByProvider(
  integrations: ConnectedIntegration[],
  accountsByProvider: AccountsByProvider | null,
): ConnectedIntegration[] {
  if (accountsByProvider === null) return integrations;
  const merged = integrations.map((row) => {
    const fresh = accountsByProvider[row.name];
    return fresh === undefined ? row : { ...row, accounts: fresh };
  });
  for (const [provider, accounts] of Object.entries(accountsByProvider)) {
    if (merged.some((row) => row.name === provider)) continue;
    if (!Array.isArray(accounts) || accounts.length === 0) continue;
    const syncing = accountToneForState(String(accounts[0].state)) === 'syncing';
    merged.push({
      id: `progress:${provider}`,
      name: provider,
      status: syncing ? 'SYNCING' : 'CONNECTED',
      isActive: false,
      accounts,
    });
  }
  return merged;
}

/**
 * One account of `provider` across the integrations list: the entry with
 * `accountId`, or the row's one account when no id is given.
 */
export function findIntegrationAccount(
  integrations: ConnectedIntegration[],
  provider: string,
  accountId?: string,
): IntegrationAccount | null {
  const row = integrations.find((i) => i.name === provider);
  if (accountId === undefined) return parseIntegrationAccount(row);
  return parseIntegrationAccounts(row)?.find((a) => a.accountId === accountId) ?? null;
}
