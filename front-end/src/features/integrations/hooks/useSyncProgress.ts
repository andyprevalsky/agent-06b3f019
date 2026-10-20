/**
 * ONE adapter for "how far along is this integration's sync?".
 *
 * STATE MACHINE (per account)
 *
 *   [NO_DATA]        no `accounts[0].progress` (or legacy backend) → null;
 *                    a syncing chip shows the indeterminate bar
 *   [INDETERMINATE]  progress without a total → { pct: null, ... }
 *   [RUNNING]        { pct < 100, done, total, unit, etaSec|null }
 *   [DONE]           pct reaches 100 or state synced → chip flips to synced,
 *                    bar disappears
 *
 * System context:
 *
 *   GET /api/integrations → integrations[].accounts[0] + accountsByProvider
 *   GET /api/integrations/progress?since=<cursor> (useAccountsProgressPoll,
 *            │   every 5 s via useSyncRefresh only while anything syncs and
 *            │   the Integrations panel is mounted — it unmounts when closed)
 *            ▼  mergeAccountsByProvider (fresh account per row + progress-only rows)
 *   SyncProgressContext (Rose Desktop integrations list)
 *            ▼
 *   useSyncProgress(provider, accountId?) → { pct, done, total, unit, etaSec, phase } | null
 *
 * `provider` is the integration row name (`chrome`, `imessage`, `gmail`,
 * `plaid`, ...). A row has one account; `accountId` picks a Gmail address or
 * Plaid item (multi-account before Rose Desktop).
 */

import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';

import { fetchIntegrationsProgressApi } from '../api/accounts';
import type { AccountsByProvider, ConnectedIntegration, SyncProgress } from '../types';
import { findIntegrationAccount } from './integrationAccounts';

export interface SyncProgressSource {
  integrations: ConnectedIntegration[];
}

export const SyncProgressContext = createContext<SyncProgressSource | null>(null);

/**
 * `{ pct, done, total, unit, etaSec, phase }` of one sync, or null when unreported:
 * the row's one account, or (Gmail address / Plaid item) the entry `accountId`.
 */
export function useSyncProgress(provider: string, accountId?: string): SyncProgress | null {
  const source = useContext(SyncProgressContext);
  if (source === null) return null;
  return findIntegrationAccount(source.integrations, provider, accountId)?.progress ?? null;
}

/**
 * The freshest per-provider accounts: the full list's `accountsByProvider`
 * until a progress poll reports a change, then the poll's. A newer full list
 * (e.g. after the user's own delete — the delta cannot see deletes) replaces
 * the overlay. `poll()` is the cheap GET /api/integrations/progress?since=
 * call; it passes the cursor back and never overlaps itself.
 */
export function useAccountsProgressPoll(
  base: AccountsByProvider | null,
  onChanged?: () => void,
): { accountsByProvider: AccountsByProvider | null; poll: () => void } {
  const [overlay, setOverlay] = useState<AccountsByProvider | null>(null);
  const cursorRef = useRef<string | null>(null);
  const inFlightRef = useRef(false);
  const onChangedRef = useRef(onChanged);
  onChangedRef.current = onChanged;

  useEffect(() => {
    setOverlay(null);
  }, [base]);

  const poll = useCallback(() => {
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    fetchIntegrationsProgressApi(cursorRef.current)
      .then((delta) => {
        if (delta === null) return;
        cursorRef.current = delta.cursor;
        if (delta.changed && delta.accountsByProvider) {
          setOverlay(delta.accountsByProvider);
          onChangedRef.current?.();
        }
      })
      .catch((err: unknown) => console.warn('[Integrations] progress poll failed', err))
      .finally(() => {
        inFlightRef.current = false;
      });
  }, []);

  return { accountsByProvider: overlay ?? base, poll };
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
