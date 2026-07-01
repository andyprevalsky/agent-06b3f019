/**
 * STATE MACHINE: PlaidSection
 *
 *   [DISCONNECTED] --click action--> [CONNECTING]
 *     --Plaid Link success--> [EXCHANGING] --done--> [CONNECTED]
 *   [CONNECTED] --click action--> [CONNECTING another account]
 */

import { Loader2, RefreshCw } from 'lucide-react';

import ConnectedStatusText from './ConnectedStatusText';
import DropdownIconFrame, { dropdownIconPreset } from './DropdownIconFrame';
import PlaidLogoIcon from './PlaidLogoIcon';
import type { PlaidItem } from '../types';

interface PlaidSectionProps {
  items: PlaidItem[];
  itemsLoading: boolean;
  connectLoading: boolean;
  error: string | null;
  onConnect: () => void;
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
}: {
  ariaLabel: string;
  isLoading: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-label={ariaLabel}
      onClick={onClick}
      disabled={isLoading}
      className="h-9 w-9 rounded-lg flex items-center justify-center transition-all duration-200 bg-foreground text-background hover:bg-foreground/90 disabled:opacity-60"
    >
      {isLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
    </button>
  );
}

export default function PlaidSection({
  items,
  itemsLoading,
  connectLoading,
  error,
  onConnect,
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
    </div>
  );
}
