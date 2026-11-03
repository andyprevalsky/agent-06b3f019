/**
 * Presentation helpers for Plaid items, shared by the stock PlaidSection card
 * and the Rose Desktop integrations list so both render the same chips.
 *
 * Pure functions: no state machine.
 */

import type { PlaidItem, PlaidSyncState } from '../types';

export function itemNeedsUpdate(item: PlaidItem): boolean {
  return item.status === 'REQUIRES_REAUTH' || item.status === 'ERROR';
}

export function chipToneForState(
  state: PlaidSyncState,
): 'synced' | 'syncing' | 'warning' | 'error' {
  if (state === 'synced') return 'synced';
  if (state === 'syncing') return 'syncing';
  if (state === 'needs_repair') return 'warning';
  return 'error';
}

export function itemChipLabel(item: PlaidItem): string {
  return item.institutionName ?? 'Financial institution';
}

export function itemChipTitle(item: PlaidItem): string {
  const accountNames = item.accounts.map((account) => account.name).join(', ');
  const lastSynced = item.lastSyncAt ?? 'not yet synced';
  return accountNames === ''
    ? `Last synced: ${lastSynced}`
    : `Accounts: ${accountNames}. Last synced: ${lastSynced}`;
}

function itemDisplayKey(item: PlaidItem): string {
  return (item.institutionId ?? item.institutionName ?? item.id).trim().toLowerCase();
}

function itemDisplayRank(item: PlaidItem): number {
  if (item.status === 'ACTIVE' && item.sync.state === 'synced') return 0;
  if (item.status === 'ACTIVE') return 1;
  if (!itemNeedsUpdate(item)) return 2;
  return 3;
}

/** One chip per institution: the healthiest item wins when an institution was linked twice. */
export function visibleInstitutionItems(items: PlaidItem[]): PlaidItem[] {
  const byInstitution = new Map<string, PlaidItem>();
  for (const item of items) {
    const key = itemDisplayKey(item);
    const existing = byInstitution.get(key);
    if (existing === undefined || itemDisplayRank(item) < itemDisplayRank(existing)) {
      byInstitution.set(key, item);
    }
  }
  return [...byInstitution.values()];
}
