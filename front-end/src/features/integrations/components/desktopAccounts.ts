/**
 * accounts → chips mapping for the Rose Desktop integrations list.
 *
 * Pure functions, no state machine. Backend contract (lane L-CULL-INTEG):
 * every integration row has ONE account (`integrations[].accounts` = [one
 * entry] with state + progress). Only rows that already listed several
 * accounts before Rose Desktop keep them, with their existing flows: Gmail
 * addresses, Plaid institutions and compute subscriptions.
 *
 *   singleAccount     the row's one chip (from its account, or from its status
 *                     when the backend sends no `accounts`); not connected → none;
 *                     × = confirmed row DELETE; sync_failed → lastError line
 *   gmailAccountViews one chip per address (existing disconnect / reconnect);
 *                     progress matched by address; idle = not syncing (synced),
 *                     phase `history` = light "checking for new mail" (no bar)
 *   plaidAccountViews one chip per institution (existing disconnect / update);
 *                     progress matched by item id
 *   rowSyncFor        the backend reports ONE account for a Gmail / Plaid row
 *                     that lists several: one bar for the whole row instead of
 *                     per-chip bars (a single address / item simply matches it)
 */

import { parseIntegrationAccount, parseIntegrationAccounts } from '../hooks/integrationAccounts';
import { gmailAccounts } from '../hooks/useIntegrationData';
import type { PendingRemoval } from '../hooks/useIntegrationRemoval';
import type { AccountTone, ConnectedIntegration, IntegrationAccount, PlaidItem } from '../types';
import type { DesktopAccountView, RowSync } from './DesktopIntegrationRow';
import {
  chipToneForState,
  itemChipLabel,
  itemChipTitle,
  itemNeedsUpdate,
  visibleInstitutionItems,
} from './plaidItemView';

export interface RemovalPort {
  request: (target: PendingRemoval) => void;
  /** Row whose DELETE is in flight (its chip shows a spinner). */
  removingName: string | null;
}

/** Shown under a failed chip when the backend sent no lastError. */
export const SYNC_FAILED_TEXT = 'The last sync failed.';

export function rowStatusTone(row: ConnectedIntegration, localSyncing = false): AccountTone {
  if (localSyncing || row.status === 'SYNCING') return 'syncing';
  if (row.status === 'SYNC_FAILED') return 'error';
  if (row.status === 'EXPIRED') return 'warning';
  return 'synced';
}

export function toneDetail(tone: AccountTone): string | undefined {
  if (tone === 'warning') return 'needs reconnect';
  if (tone === 'error') return 'sync failed';
  return undefined;
}

export interface RowFallback {
  /** Integration name the user sees, e.g. "Chrome". */
  displayName: string;
  /** Chip label when the backend sends no label. */
  label: string;
  /** Quiet detail on a healthy chip, e.g. "1,204 messages". */
  detail?: string;
  /** A local connect/sync for this row is running right now (legacy backends). */
  localSyncing?: boolean;
}

/** The row's one chip; [] while the integration is not connected. */
export function singleAccount(
  row: ConnectedIntegration | undefined,
  fallback: RowFallback,
  removal: RemovalPort,
): DesktopAccountView[] {
  if (row === undefined) return [];
  const account = parseIntegrationAccount(row);
  let label = fallback.label;
  let tone: AccountTone;
  let lastError: string | null = null;
  if (account !== null) {
    if (row.status === 'NOT_CONNECTED' && account.state.trim().toLowerCase() === 'idle') return [];
    if (!account.unlabeled) label = account.label;
    tone = account.tone;
    lastError = account.lastError;
  } else {
    if (row.status === 'NOT_CONNECTED') return [];
    tone = rowStatusTone(row, fallback.localSyncing);
  }
  return [
    {
      provider: row.name,
      label,
      tone,
      detail: toneDetail(tone) ?? (tone === 'synced' ? fallback.detail : undefined),
      title: lastError ?? undefined,
      errorText: tone === 'error' ? (lastError ?? SYNC_FAILED_TEXT) : undefined,
      onRemove: () =>
        removal.request({ name: row.name, label: `${fallback.displayName} · ${label}` }),
      removeLabel: `Disconnect ${fallback.displayName}`,
      removing: removal.removingName === row.name,
    },
  ];
}

/**
 * Contract entry of one of a row's own accounts. A row with a single account
 * and a single entry always match (the backend's one-account shape).
 */
function matchEntry(
  contract: IntegrationAccount[],
  ownCount: number,
  ids: (string | null)[],
): IntegrationAccount | undefined {
  const byId = contract.find((c) => ids.includes(c.accountId) || ids.includes(c.label));
  if (byId !== undefined) return byId;
  return contract.length === 1 && ownCount === 1 ? contract[0] : undefined;
}

/**
 * One bar for a Gmail / Plaid row whose backend reports one account for the
 * whole row while the row lists several (no entry matches any of them).
 */
export function rowSyncFor(
  row: ConnectedIntegration | undefined,
  ownIds: string[][],
  options: { lightPhase?: string } = {},
): RowSync | undefined {
  const contract = parseIntegrationAccounts(row) ?? [];
  if (row === undefined || contract.length === 0) return undefined;
  if (ownIds.some((ids) => matchEntry(contract, ownIds.length, ids) !== undefined)) {
    return undefined;
  }
  const entry = contract[0];
  return {
    provider: row.name,
    syncing: entry.tone === 'syncing',
    hideProgress: options.lightPhase !== undefined && entry.progress?.phase === options.lightPhase,
    errorText: entry.tone === 'error' ? (entry.lastError ?? SYNC_FAILED_TEXT) : undefined,
  };
}

export interface GmailPort {
  disconnectingEmail: string | null;
  resyncingEmail: string | null;
  onDisconnect: (email: string) => void;
  onResync: (email: string) => void;
}

/** Gmail's incremental sync (`history`): a light state, never the full bar. */
export const GMAIL_LIGHT_PHASE = 'history';

type GmailSyncView = Pick<
  DesktopAccountView,
  'tone' | 'detail' | 'title' | 'hideProgress' | 'errorText'
>;

/** Tone, detail and bar choice of one healthy Gmail address from its contract entry. */
function gmailSyncView(match: IntegrationAccount | undefined): GmailSyncView {
  // No entry, or `idle` (connected, not syncing): a plain synced chip.
  if (match === undefined) return { tone: 'synced' };
  if (match.tone === 'syncing' && match.progress?.phase === GMAIL_LIGHT_PHASE) {
    return { tone: 'syncing', detail: 'checking for new mail', hideProgress: true };
  }
  return {
    tone: match.tone,
    detail: toneDetail(match.tone),
    title: match.lastError ?? undefined,
    errorText: match.tone === 'error' ? (match.lastError ?? SYNC_FAILED_TEXT) : undefined,
  };
}

/** One chip per Gmail address, keeping the existing disconnect / reconnect flows. */
export function gmailAccountViews(
  integrations: ConnectedIntegration[],
  gmail: GmailPort,
): DesktopAccountView[] {
  const row = integrations.find((i) => i.name === 'gmail');
  const contract = parseIntegrationAccounts(row) ?? [];
  const addresses = gmailAccounts(row);
  return addresses.map((account) => {
    const damaged = account.state !== 'connected';
    const match = matchEntry(contract, addresses.length, [account.email]);
    const health: GmailSyncView = damaged
      ? {
          tone: 'warning',
          detail: 'Needs Reconnection',
          title: account.lastErrorReason ?? 'This account needs to be reconnected.',
        }
      : gmailSyncView(match);
    return {
      provider: 'gmail',
      accountId: match?.accountId ?? account.email,
      label: account.email,
      ...health,
      onRemove: () => gmail.onDisconnect(account.email),
      removeLabel: `Disconnect ${account.email}`,
      removing: gmail.disconnectingEmail === account.email,
      onResync: damaged ? () => gmail.onResync(account.email) : undefined,
      resyncLabel: `Reconnect ${account.email}`,
      resyncing: gmail.resyncingEmail === account.email,
    };
  });
}

export interface PlaidPort {
  items: PlaidItem[];
  connectLoading: boolean;
  disconnectingItemId: string | null;
  onUpdate: (itemId: string) => void;
  onDisconnect: (itemId: string) => void;
}

/** Ids a Plaid item may carry in the progress contract. */
export function plaidItemIds(item: PlaidItem): string[] {
  return [item.id, item.plaidItemId];
}

/** One chip per institution, keeping the existing Plaid disconnect / update flows. */
export function plaidAccountViews(
  integrations: ConnectedIntegration[],
  plaid: PlaidPort,
): DesktopAccountView[] {
  const contract = parseIntegrationAccounts(integrations.find((i) => i.name === 'plaid')) ?? [];
  const items = visibleInstitutionItems(plaid.items);
  return items.map((item) => {
    const needsUpdate = itemNeedsUpdate(item);
    const label = itemChipLabel(item);
    const match = matchEntry(contract, items.length, plaidItemIds(item));
    const busy = plaid.connectLoading || plaid.disconnectingItemId === item.id;
    return {
      provider: 'plaid',
      accountId: match?.accountId ?? item.id,
      label,
      tone: chipToneForState(item.sync.state),
      detail: needsUpdate ? 'needs reconnect' : undefined,
      title: itemChipTitle(item),
      onRemove: () => plaid.onDisconnect(item.id),
      removeLabel: `Disconnect ${item.institutionName ?? 'Plaid connection'} and its connected accounts`,
      removing: plaid.disconnectingItemId === item.id,
      disabled: plaid.connectLoading,
      onResync: needsUpdate ? () => plaid.onUpdate(item.id) : undefined,
      resyncLabel: `Reconnect ${label}`,
      resyncing: needsUpdate && busy,
    };
  });
}

export function countDetail(value: unknown, unit: string): string | undefined {
  return typeof value === 'number' && value > 0
    ? `${value.toLocaleString('en-US')} ${unit}`
    : undefined;
}

export function stringConfig(row: ConnectedIntegration | undefined, key: string): string | null {
  const value = row?.config?.[key];
  return typeof value === 'string' && value !== '' ? value : null;
}
