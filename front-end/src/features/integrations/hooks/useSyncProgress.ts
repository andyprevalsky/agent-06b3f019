/**
 * ONE adapter for "how far along is this account's sync?".
 *
 * STATE MACHINE (per account key)
 *
 *   [NO_DATA] --server reports {done,total}--> [RUNNING(pct<100)]
 *   [RUNNING] --refresh, done grows--> [RUNNING] (ETA from observed rate unless server sends eta_sec)
 *   [RUNNING] --pct reaches 100--> [DONE]  (caller flips the chip to synced, bar disappears)
 *   [NO_DATA] while the account is syncing --> caller shows the indeterminate bar
 *
 * System context:
 *
 *   GET /api/integrations ──┐  integration.syncProgress           (row providers)
 *                           ├─ emailCredentials[].syncProgress     (gmail, per address)
 *   GET /plaid/items ───────┘  item.sync.progress                  (plaid, per item)
 *            │
 *            ▼
 *   useSyncProgressSource(integrations, plaidItems)   ← Rose Desktop integrations list
 *            │  SyncProgressContext (+ first-seen samples for rate-based ETA)
 *            ▼
 *   useSyncProgress(provider, accountId) → { pct, done, total, unit, etaSec } | null
 *
 * Wire shape every provider is expected to send: `{ pct?, done, total, unit, eta_sec? }`.
 * Providers that do not report it yet return null here; their syncing chips show
 * the indeterminate bar until the backend adds it.
 */

import { createContext, useContext, useEffect, useMemo, useRef } from 'react';

import type {
  ConnectedIntegration,
  PlaidItem,
  SyncProgress,
  SyncProgressProvider,
  SyncProgressWire,
} from '../types';

interface ProgressSample {
  t: number;
  done: number;
}

export interface SyncProgressSource {
  integrations: ConnectedIntegration[];
  plaidItems: PlaidItem[];
  /** First observation of each running sync, keyed by `progressKey`. */
  samples: ReadonlyMap<string, ProgressSample>;
  /** When this snapshot was taken (ms); ETA rates are measured up to here. */
  observedAt: number;
}

export const SyncProgressContext = createContext<SyncProgressSource | null>(null);

/** Stable identity of one account's progress, independent of which row reports it. */
export function progressKey(provider: SyncProgressProvider, accountId: string): string {
  return `${provider}:${accountId}`;
}

/**
 * Locate the raw progress for one account.
 *
 * gmail is per address (`accountId` = email), plaid is per item (`accountId` =
 * item id); every other provider is one integration row (`accountId` = row name).
 */
export function findProgressWire(
  source: Pick<SyncProgressSource, 'integrations' | 'plaidItems'>,
  provider: SyncProgressProvider,
  accountId: string,
): SyncProgressWire | null {
  if (provider === 'plaid') {
    return source.plaidItems.find((item) => item.id === accountId)?.sync.progress ?? null;
  }
  if (provider === 'gmail') {
    const gmail = source.integrations.find((i) => i.name === 'gmail');
    return gmail?.emailCredentials?.find((c) => c.email === accountId)?.syncProgress ?? null;
  }
  return source.integrations.find((i) => i.name === accountId)?.syncProgress ?? null;
}

function listProgressWires(
  integrations: ConnectedIntegration[],
  plaidItems: PlaidItem[],
): Array<{ key: string; wire: SyncProgressWire }> {
  const found: Array<{ key: string; wire: SyncProgressWire }> = [];
  for (const row of integrations) {
    for (const credential of row.emailCredentials ?? []) {
      if (credential.syncProgress != null && credential.email !== null) {
        found.push({ key: progressKey('gmail', credential.email), wire: credential.syncProgress });
      }
    }
    // Row-level progress is keyed by row name; the provider prefix only groups.
    if (row.syncProgress != null) found.push({ key: `row:${row.name}`, wire: row.syncProgress });
  }
  for (const item of plaidItems) {
    if (item.sync.progress != null) {
      found.push({ key: progressKey('plaid', item.id), wire: item.sync.progress });
    }
  }
  return found;
}

function sampleKey(provider: SyncProgressProvider, accountId: string): string {
  return provider === 'gmail' || provider === 'plaid'
    ? progressKey(provider, accountId)
    : `row:${accountId}`;
}

function finite(n: unknown): n is number {
  return typeof n === 'number' && Number.isFinite(n);
}

/**
 * Normalize a wire report: clamp counts, derive pct, and estimate the ETA from
 * the rate observed since `sample` when the server does not send one.
 */
export function normalizeSyncProgress(
  wire: SyncProgressWire,
  sample: ProgressSample | undefined,
  now: number,
): SyncProgress | null {
  if (!finite(wire.total) || wire.total <= 0 || !finite(wire.done)) return null;
  const total = Math.round(wire.total);
  const done = Math.min(Math.max(Math.round(wire.done), 0), total);
  const rawPct = finite(wire.pct) ? wire.pct : (done / total) * 100;
  const pct = Math.min(Math.max(rawPct, 0), 100);
  let etaSec: number | null = finite(wire.eta_sec) ? Math.max(Math.round(wire.eta_sec), 0) : null;
  if (etaSec === null && sample !== undefined && now > sample.t && done > sample.done) {
    const perSecond = (done - sample.done) / ((now - sample.t) / 1000);
    etaSec = Math.ceil((total - done) / perSecond);
  }
  return { pct, done, total, unit: wire.unit || 'items', etaSec: pct >= 100 ? 0 : etaSec };
}

/** Context value for the integrations list; keeps first-seen samples across refreshes. */
export function useSyncProgressSource(
  integrations: ConnectedIntegration[],
  plaidItems: PlaidItem[],
): SyncProgressSource {
  const samplesRef = useRef(new Map<string, ProgressSample>());
  return useMemo(() => {
    const now = Date.now();
    const samples = samplesRef.current;
    const live = new Set<string>();
    for (const { key, wire } of listProgressWires(integrations, plaidItems)) {
      live.add(key);
      const prior = samples.get(key);
      // A smaller `done` means a new sync run started: restart the rate window.
      if (prior === undefined || wire.done < prior.done) samples.set(key, { t: now, done: wire.done });
    }
    for (const key of [...samples.keys()]) if (!live.has(key)) samples.delete(key);
    return { integrations, plaidItems, samples, observedAt: now };
  }, [integrations, plaidItems]);
}

/** `{ pct, done, total, unit, etaSec }` for one account's running sync, or null if unreported. */
export function useSyncProgress(
  provider: SyncProgressProvider,
  accountId: string,
): SyncProgress | null {
  const source = useContext(SyncProgressContext);
  if (source === null) return null;
  const wire = findProgressWire(source, provider, accountId);
  if (wire === null) return null;
  return normalizeSyncProgress(
    wire,
    source.samples.get(sampleKey(provider, accountId)),
    source.observedAt,
  );
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
