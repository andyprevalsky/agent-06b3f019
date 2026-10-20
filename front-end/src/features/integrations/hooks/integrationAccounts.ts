/**
 * Parser for the multi-account integrations contract (lane L-INTEG-CORE):
 *
 *   GET /api/integrations → integrations[].accounts[] + accountsByProvider =
 *     { provider, accountId, label|null, state, lastSyncAt, lastError,
 *       progress: { pct, done, total, unit, eta_sec, phase, startedAt, updatedAt } }
 *   GET /api/integrations/progress?since → the same accountsByProvider when changed
 *
 * Pure functions, no state machine. Every field is treated as untrusted:
 *   - `accounts` absent  → null (callers fall back to today's per-row status)
 *   - `total` null       → pct null (indeterminate bar, never a fake pct)
 *   - `eta_sec` null     → etaSec null (ETA text hidden)
 *   - pct >= 100         → the account reads as synced (bar disappears)
 *   - failed / needs_reconnect → error / warning tone, progress dropped (no bar)
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

/**
 * The provider's accounts, or null when the backend did not send `accounts`
 * (callers then derive accounts from the row exactly as before).
 */
export function parseIntegrationAccounts(
  row: ConnectedIntegration | undefined,
): IntegrationAccount[] | null {
  const raw: unknown = row?.accounts;
  if (!Array.isArray(raw)) return null;
  const accounts: IntegrationAccount[] = [];
  for (const entry of raw as unknown[]) {
    if (entry === null || typeof entry !== 'object') continue;
    const wire = entry as Record<string, unknown>;
    const accountId = typeof wire.accountId === 'string' ? wire.accountId : '';
    if (accountId === '') continue;
    const state = typeof wire.state === 'string' ? wire.state : 'synced';
    const tone = accountToneForState(state);
    // A damaged account shows no bar: needs_reconnect / failed outrank progress.
    const progress =
      tone === 'syncing' || tone === 'synced'
        ? parseSyncProgress(wire.progress as SyncProgressWire | null | undefined)
        : null;
    const labeled = typeof wire.label === 'string' && wire.label !== '';
    accounts.push({
      accountId,
      label: labeled ? (wire.label as string) : accountId,
      unlabeled: !labeled,
      state,
      progress,
      tone: tone === 'syncing' && isProgressComplete(progress) ? 'synced' : tone,
      lastSyncAt: typeof wire.lastSyncAt === 'string' ? wire.lastSyncAt : null,
      lastError:
        typeof wire.lastError === 'string' && wire.lastError !== '' ? wire.lastError : null,
    });
  }
  return accounts;
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
    const syncing = accounts.some((a) => accountToneForState(String(a.state)) === 'syncing');
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

/** Find one account's raw-parsed entry across the integrations list. */
export function findIntegrationAccount(
  integrations: ConnectedIntegration[],
  provider: string,
  accountId: string,
): IntegrationAccount | null {
  const row = integrations.find((i) => i.name === provider);
  return parseIntegrationAccounts(row)?.find((a) => a.accountId === accountId) ?? null;
}
