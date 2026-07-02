/**
 * STATE MACHINE: PlaidSection
 *
 *   [DISCONNECTED] --click action--> [CONNECTING]
 *     --Plaid Link success--> [EXCHANGING] --done--> [CONNECTED]
 *   [CONNECTED] --click action--> [CONNECTING another account]
 *   [REQUIRES_REAUTH/ERROR] --repair item--> [CONNECTING update mode] --done--> [CONNECTED]
 *   [CONNECTED] --disconnect item--> [DISCONNECTING] --done--> [DISCONNECTED]
 */

import { Loader2, RefreshCw, Trash2 } from 'lucide-react';

import ConnectedStatusText from './ConnectedStatusText';
import DropdownIconFrame, { dropdownIconPreset } from './DropdownIconFrame';
import PlaidLogoIcon from './PlaidLogoIcon';
import type { PlaidItem } from '../types';

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

function getPlaidDetailText(items: PlaidItem[], itemsLoading: boolean): string {
  if (itemsLoading) return 'Loading connected accounts...';

  const connectedInstitutionNames = items
    .map((item) => item.institutionName)
    .filter((name): name is string => typeof name === 'string' && name.trim() !== '');

  if (connectedInstitutionNames.length > 0) return connectedInstitutionNames.join(', ');

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
  variant?: 'primary' | 'ghost' | 'danger';
}) {
  const classes =
    variant === 'primary'
      ? 'bg-foreground text-background hover:bg-foreground/90'
      : variant === 'danger'
        ? 'bg-transparent text-muted-foreground hover:text-destructive hover:bg-destructive/10'
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
      ) : variant === 'danger' ? (
        <Trash2 className="w-4 h-4" />
      ) : (
        <RefreshCw className="w-4 h-4" />
      )}
    </button>
  );
}

function itemNeedsUpdate(item: PlaidItem): boolean {
  return item.status === 'REQUIRES_REAUTH' || item.status === 'ERROR';
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

  return (
    <div className="rounded-lg border border-border bg-card/60 overflow-hidden">
      <div className="p-4 flex items-center justify-between">
        <div className="flex min-w-0 items-center gap-3">
          <DropdownIconFrame {...dropdownIconPreset.plaid} isSynced={isConnected}>
            <PlaidLogoIcon />
          </DropdownIconFrame>
          <div className="flex min-w-0 flex-col">
            <h3 className="font-medium">Banks &amp; Financial Accounts</h3>
            <ConnectedStatusText isConnected={isConnected} />
            <span className="truncate text-xs text-muted-foreground">{detailText}</span>
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
      {error !== null && error !== '' && (
        <div className="px-4 py-2 border-t border-border/50 text-xs text-destructive">{error}</div>
      )}
      {items.length > 0 && (
        <div className="border-t border-border/50">
          {items.map((item) => (
            <div key={item.id} className="flex items-center justify-between gap-3 px-4 py-2">
              <div className="min-w-0">
                <div className="truncate text-sm">{item.institutionName ?? 'Connected institution'}</div>
                <div className="truncate text-xs text-muted-foreground">
                  {item.accounts.length} account{item.accounts.length === 1 ? '' : 's'} / {item.status}
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-1">
                {itemNeedsUpdate(item) && (
                  <PlaidActionButton
                    ariaLabel={`Repair ${item.institutionName ?? 'Plaid item'}`}
                    isLoading={connectLoading}
                    onClick={() => onUpdate(item.id)}
                    variant="ghost"
                  />
                )}
                <PlaidActionButton
                  ariaLabel={`Disconnect ${item.institutionName ?? 'Plaid item'}`}
                  isLoading={disconnectingItemId === item.id}
                  onClick={() => onDisconnect(item.id)}
                  variant="danger"
                />
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
