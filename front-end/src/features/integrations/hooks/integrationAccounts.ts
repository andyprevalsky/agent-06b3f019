/**
 * Parser for the multi-account integrations contract (lane L-INTEG-CORE):
 *
 *   GET /api/integrations → integrations[].accounts[] =
 *     { accountId, label, state, progress: { pct, done, total, unit, eta_sec }, lastSyncAt }
 *
 * Pure functions, no state machine. Every field is treated as untrusted:
 *   - `accounts` absent  → null (callers fall back to today's per-row status)
 *   - `total` null       → pct null (indeterminate bar, never a fake pct)
 *   - `eta_sec` null     → etaSec null (ETA text hidden)
 *   - pct >= 100         → the account reads as synced (bar disappears)
 */

import type {
  AccountTone,
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
  return { pct, done, total, unit, etaSec: pct !== null && pct >= 100 ? 0 : etaSec };
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
    const progress = parseSyncProgress(wire.progress as SyncProgressWire | null | undefined);
    const tone = accountToneForState(state);
    accounts.push({
      accountId,
      label: typeof wire.label === 'string' && wire.label !== '' ? wire.label : accountId,
      state,
      progress,
      tone: tone === 'syncing' && isProgressComplete(progress) ? 'synced' : tone,
      lastSyncAt: typeof wire.lastSyncAt === 'string' ? wire.lastSyncAt : null,
    });
  }
  return accounts;
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
