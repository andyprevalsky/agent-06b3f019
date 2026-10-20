/**
 * ONE adapter for "how far along is this account's sync?".
 *
 * STATE MACHINE (per account)
 *
 *   [NO_DATA]        no `accounts[].progress` (or legacy backend) → null;
 *                    a syncing chip shows the indeterminate bar
 *   [INDETERMINATE]  progress without a total → { pct: null, ... }
 *   [RUNNING]        { pct < 100, done, total, unit, etaSec|null }
 *   [DONE]           pct reaches 100 → chip flips to synced, bar disappears
 *
 * System context:
 *
 *   GET /api/integrations → integrations[].accounts[].progress
 *            │   (refetched by useSyncRefresh while anything syncs)
 *            ▼
 *   SyncProgressContext (Rose Desktop integrations list)
 *            ▼
 *   useSyncProgress(provider, accountId) → { pct, done, total, unit, etaSec } | null
 *
 * `provider` is the integration row name (`chrome`, `imessage`, `gmail`,
 * `plaid`, ...); `accountId` is the account's id within that row.
 */

import { createContext, useContext, useEffect, useRef } from 'react';

import type { ConnectedIntegration, SyncProgress } from '../types';
import { findIntegrationAccount } from './integrationAccounts';

export interface SyncProgressSource {
  integrations: ConnectedIntegration[];
}

export const SyncProgressContext = createContext<SyncProgressSource | null>(null);

/** `{ pct, done, total, unit, etaSec }` for one account's sync, or null when unreported. */
export function useSyncProgress(provider: string, accountId: string): SyncProgress | null {
  const source = useContext(SyncProgressContext);
  if (source === null) return null;
  return findIntegrationAccount(source.integrations, provider, accountId)?.progress ?? null;
}

/** Re-read sync state on an interval while anything is syncing; stops when nothing is. */
export function useSyncRefresh(active: boolean, intervalMs: number, refresh: () => void): void {
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => refreshRef.current(), intervalMs);
    return () => clearInterval(id);
  }, [active, intervalMs]);
}
