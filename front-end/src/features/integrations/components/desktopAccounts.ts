/**
 * accounts → chips mapping for the Rose Desktop integrations list.
 *
 * Pure functions, no state machine. Each builder prefers the multi-account
 * contract (`integrations[].accounts`, hooks/integrationAccounts) and falls
 * back to today's per-row status when the backend does not send it:
 *
 *   contract present  → one chip per account (an 'idle' account of a NOT_CONNECTED
 *                       row is no chip; an unlabeled one uses the row's label);
 *                       × = per-account DELETE (confirmed); 501 → reason under it
 *   contract absent   → one chip for a connected row; × = row DELETE (confirmed)
 *   Gmail / Plaid     → existing per-address / per-item flows, unchanged; the
 *                       contract only contributes sync tone and progress ids
 */

import { parseIntegrationAccounts } from '../hooks/integrationAccounts';
import { gmailAccounts } from '../hooks/useIntegrationData';
import { removalKey, type PendingRemoval } from '../hooks/useIntegrationRemoval';
import type { AccountTone, ConnectedIntegration, PlaidItem } from '../types';
import type { DesktopAccountView } from './DesktopIntegrationRow';
import {
  chipToneForState,
  itemChipLabel,
  itemChipTitle,
  itemNeedsUpdate,
  visibleInstitutionItems,
} from './plaidItemView';

export interface RemovalPort {
  request: (target: PendingRemoval) => void;
  removingKey: string | null;
  /** removalKey → reason the backend cannot remove that account yet (DELETE 501). */
  blockedReasons?: Readonly<Record<string, string>>;
}

export function rowStatusTone(row: ConnectedIntegration, localSyncing = false): AccountTone {
  if (localSyncing || row.status === 'SYNCING') return 'syncing';
  if (row.status === 'SYNC_FAILED') return 'error';
  if (row.status === 'EXPIRED') return 'warning';
  return 'synced';
}

function toneDetail(tone: AccountTone): string | undefined {
  if (tone === 'warning') return 'needs reconnect';
  if (tone === 'error') return 'sync failed';
  return undefined;
}

export interface RowFallback {
  /** Integration name the user sees, e.g. "Chrome". */
  displayName: string;
  /** Chip label when the backend sends no account list. */
  label: string;
  detail?: string;
  /** A local connect/sync for this row is running right now. */
  localSyncing?: boolean;
}

/** Chips for a provider that is one integration row (browsers, passwords, iMessage, ...). */
export function rowAccounts(
  row: ConnectedIntegration | undefined,
  fallback: RowFallback,
  removal: RemovalPort,
): DesktopAccountView[] {
  if (row === undefined) return [];
  const contract = parseIntegrationAccounts(row);
  if (contract !== null) {
    return contract
      .filter((account) => !(account.state === 'idle' && row.status === 'NOT_CONNECTED'))
      .map((account) => {
        const label = account.unlabeled ? fallback.label : account.label;
        const key = removalKey(row.name, account.accountId);
        return {
          provider: row.name,
          accountId: account.accountId,
          label,
          tone: account.tone,
          detail: toneDetail(account.tone),
          title: account.lastError ?? undefined,
          onRemove: () =>
            removal.request({
              name: row.name,
              accountId: account.accountId,
              label: `${fallback.displayName} · ${label}`,
            }),
          removeLabel: `Remove ${fallback.displayName} account ${label}`,
          removing: removal.removingKey === key,
          removeBlockedReason: removal.blockedReasons?.[key],
        };
      });
  }
  if (row.status === 'NOT_CONNECTED') return [];
  const tone = rowStatusTone(row, fallback.localSyncing);
  return [
    {
      provider: row.name,
      accountId: row.name,
      label: fallback.label,
      tone,
      detail: fallback.detail ?? toneDetail(tone),
      onRemove: () =>
        removal.request({ name: row.name, label: `${fallback.displayName} · ${fallback.label}` }),
      removeLabel: `Remove ${fallback.displayName} account ${fallback.label}`,
      removing: removal.removingKey === removalKey(row.name),
    },
  ];
}

export interface GmailPort {
  disconnectingEmail: string | null;
  resyncingEmail: string | null;
  onDisconnect: (email: string) => void;
  onResync: (email: string) => void;
}

/** One chip per Gmail address, keeping the existing disconnect / reconnect flows. */
export function gmailAccountViews(
  integrations: ConnectedIntegration[],
  gmail: GmailPort,
): DesktopAccountView[] {
  const row = integrations.find((i) => i.name === 'gmail');
  const contract = parseIntegrationAccounts(row) ?? [];
  return gmailAccounts(row).map((account) => {
    const damaged = account.state !== 'connected';
    const match = contract.find((c) => c.accountId === account.email || c.label === account.email);
    return {
      provider: 'gmail',
      accountId: match?.accountId ?? account.email,
      label: account.email,
      tone: damaged ? 'warning' : (match?.tone ?? 'synced'),
      detail: damaged ? 'Needs Reconnection' : undefined,
      title: damaged
        ? (account.lastErrorReason ?? 'This account needs to be reconnected.')
        : undefined,
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

/** One chip per institution, keeping the existing Plaid disconnect / update flows. */
export function plaidAccountViews(
  integrations: ConnectedIntegration[],
  plaid: PlaidPort,
): DesktopAccountView[] {
  const contract = parseIntegrationAccounts(integrations.find((i) => i.name === 'plaid')) ?? [];
  return visibleInstitutionItems(plaid.items).map((item) => {
    const needsUpdate = itemNeedsUpdate(item);
    const label = itemChipLabel(item);
    const match = contract.find((c) => c.accountId === item.id || c.accountId === item.plaidItemId);
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

/** Rows whose name ends with `_passkeys` are passkey stores (one per relying party). */
export function passkeyRows(integrations: ConnectedIntegration[]): ConnectedIntegration[] {
  return integrations.filter((i) => i.name.endsWith('_passkeys'));
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
