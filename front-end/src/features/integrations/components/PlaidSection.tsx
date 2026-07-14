/**
 * STATE MACHINE: PlaidSection
 *
 *   [DISCONNECTED] --plus action--> [CONNECTING]
 *     --Plaid Link success--> [EXCHANGING] --done--> [CONNECTED]
 *   [CONNECTED] --plus action--> [CONNECTING another account]
 *   [REQUIRES_REAUTH/ERROR] --repair item--> [CONNECTING update mode] --done--> [CONNECTED]
 *   [CONNECTED] --account chip remove--> [DISCONNECTING] --done--> [DISCONNECTED]
 */

import { Loader2, Plus, Wrench } from 'lucide-react';

import ConnectedAccountChip from './ConnectedAccountChip';
import DropdownIconFrame, { DropdownIconPreset } from './DropdownIconFrame';
import PlaidLogoIcon from './PlaidLogoIcon';
import type { PlaidItem, PlaidSyncState } from '../types';

interface PlaidSectionProps {
  items: PlaidItem[];
  itemsLoading: boolean;
  connectLoading: boolean;
  disconnectingItemId: string | null;
  error: string | null;
  onConnect: () => void;
  onUpdate: (itemId: string) => void;
  onDisconnect: (itemId: string) => void;
}

function getPlaidDetailText(items: PlaidItem[], itemsLoading: boolean): string | null {
  if (itemsLoading) return 'Loading connected accounts...';
  if (items.length > 0) return null;

  return 'Connect via Plaid for balances, transactions, investments & more';
}

function PlaidActionButton({
  ariaLabel,
  isLoading,
  onClick,
  variant = 'primary',
}: {
  ariaLabel: string;
  isLoading: boolean;
  onClick: () => void;
  variant?: 'primary' | 'ghost';
}) {
  const classes =
    variant === 'primary'
      ? 'bg-foreground text-background hover:bg-foreground/90'
      : 'bg-transparent text-muted-foreground hover:text-foreground hover:bg-muted';
  return (
    <button
      type="button"
      aria-label={ariaLabel}
      onClick={onClick}
      disabled={isLoading}
      className={`h-9 w-9 rounded-lg flex items-center justify-center transition-all duration-200 disabled:opacity-60 ${classes}`}
    >
      {isLoading ? (
        <Loader2 className="w-4 h-4 animate-spin" />
      ) : variant === 'ghost' ? (
        <Wrench className="w-4 h-4" />
      ) : (
        <Plus className="w-4 h-4" />
      )}
    </button>
  );
}

function itemNeedsUpdate(item: PlaidItem): boolean {
  return item.status === 'REQUIRES_REAUTH' || item.status === 'ERROR';
}

function chipToneForState(state: PlaidSyncState): 'synced' | 'syncing' | 'warning' | 'error' {
  if (state === 'synced') return 'synced';
  if (state === 'syncing') return 'syncing';
  if (state === 'needs_repair') return 'warning';
  return 'error';
}

function itemChipLabel(item: PlaidItem): string {
  return item.institutionName ?? 'Financial institution';
}

function itemChipTitle(item: PlaidItem): string {
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

function visibleInstitutionItems(items: PlaidItem[]): PlaidItem[] {
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

export default function PlaidSection({
  items,
  itemsLoading,
  connectLoading,
  disconnectingItemId,
  error,
  onConnect,
  onUpdate,
  onDisconnect,
}: PlaidSectionProps) {
  const isConnected = items.length > 0;
  const detailText = getPlaidDetailText(items, itemsLoading);
  const visibleItems = visibleInstitutionItems(items);
  const itemChips = (
    <>
      {visibleItems.map((item) => (
        <ConnectedAccountChip
          key={item.id}
          label={itemChipLabel(item)}
          tone={chipToneForState(item.sync.state)}
          removing={disconnectingItemId === item.id}
          onRemove={() => onDisconnect(item.id)}
          removeLabel={`Disconnect ${item.institutionName ?? 'Plaid connection'} and its connected accounts`}
          title={itemChipTitle(item)}
        />
      ))}
    </>
  );

  return (
    <div className="rounded-lg border border-border bg-card/60 overflow-hidden">
      <div className="p-4 flex items-center justify-between">
        <div className="flex min-w-0 items-center gap-3">
          <DropdownIconFrame {...DropdownIconPreset.plaid} isSynced={isConnected}>
            <PlaidLogoIcon />
          </DropdownIconFrame>
          <div className="flex min-w-0 flex-col">
            <div className="flex min-w-0 items-center gap-1.5">
              <h3 className="truncate font-medium">Banks &amp; Financial Accounts</h3>
            </div>
            {detailText !== null && (
              <span className="truncate text-xs text-muted-foreground">{detailText}</span>
            )}
            {visibleItems.length > 0 && (
              <div className="mt-1 flex min-w-0 flex-wrap gap-1.5">{itemChips}</div>
            )}
          </div>
        </div>
        <PlaidActionButton
          ariaLabel={
            isConnected
              ? 'Connect another financial account'
              : 'Connect a bank or financial account'
          }
          isLoading={connectLoading}
          onClick={onConnect}
        />
      </div>
      {visibleItems.some(itemNeedsUpdate) && (
        <div className="flex flex-wrap gap-1.5 px-4 pb-4">
          {visibleItems.filter(itemNeedsUpdate).map((item) => (
            <PlaidActionButton
              key={`repair-${item.id}`}
              ariaLabel={`Repair ${item.institutionName ?? 'Plaid item'}`}
              isLoading={connectLoading}
              onClick={() => onUpdate(item.id)}
              variant="ghost"
            />
          ))}
        </div>
      )}
      {error !== null && error !== '' && (
        <div className="px-4 py-2 border-t border-border/50 text-xs text-destructive">{error}</div>
      )}
    </div>
  );
}
