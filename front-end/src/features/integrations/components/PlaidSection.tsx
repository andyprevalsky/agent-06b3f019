/**
 * STATE MACHINE: PlaidSection
 *
 *   [DISCONNECTED] --plus action--> [CONNECTING]
 *     --Plaid Link success--> [EXCHANGING] --done--> [CONNECTED]
 *   [CONNECTED] --plus action--> [CONNECTING another account]
 *   [REQUIRES_REAUTH/ERROR] --"Reconnect" chip--> [CONNECTING update mode] --done--> [CONNECTED]
 *   [CONNECTED] --account chip remove--> [DISCONNECTING] --done--> [DISCONNECTED]
 *
 * The repair affordance renders inline with the institution chips as a labeled
 * "Reconnect" control, never as a standalone icon-only button in the card body.
 */

import { Fragment } from 'react';
import { Loader2, Plus, Wrench } from 'lucide-react';

import ConnectedAccountChip from './ConnectedAccountChip';
import DropdownIconFrame, { DropdownIconPreset } from './DropdownIconFrame';
import PlaidLogoIcon from './PlaidLogoIcon';
import {
  chipToneForState,
  itemChipLabel,
  itemChipTitle,
  itemNeedsUpdate,
  visibleInstitutionItems,
} from './plaidItemView';
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

function getPlaidDetailText(items: PlaidItem[], itemsLoading: boolean): string | null {
  if (itemsLoading) return 'Loading connected accounts...';
  if (items.length > 0) return null;

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
      className="h-9 w-9 rounded-lg flex items-center justify-center transition-all duration-200 disabled:opacity-60 bg-foreground text-background hover:bg-foreground/90"
    >
      {isLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}
    </button>
  );
}

/**
 * Repair affordance for a broken connection.
 *
 * Deliberately labeled and chip-adjacent: an icon-only wrench floating in the
 * card body reads as a stray glyph rather than an action, and gives no hint
 * about which institution is broken or why.
 */
function PlaidRepairButton({
  item,
  isLoading,
  onClick,
}: {
  item: PlaidItem;
  isLoading: boolean;
  onClick: () => void;
}) {
  const needsReauth = item.status === 'REQUIRES_REAUTH';
  const institution = item.institutionName ?? 'This institution';
  return (
    <button
      type="button"
      aria-label={`Repair ${item.institutionName ?? 'Plaid item'}`}
      onClick={onClick}
      disabled={isLoading}
      title={
        needsReauth
          ? `${institution} needs you to sign in again before balances and transactions can sync.`
          : `${institution} stopped syncing. Reconnect it to restore balances and transactions.`
      }
      className="group inline-flex h-5 max-w-full shrink-0 items-center gap-1 rounded border border-amber-500/30 bg-amber-500/10 px-1.5 text-[11px] font-medium leading-none text-amber-900 transition-colors hover:border-amber-500/50 hover:bg-amber-500/20 disabled:opacity-60 dark:text-amber-100"
    >
      {isLoading ? (
        <Loader2 className="h-2.5 w-2.5 shrink-0 animate-spin" />
      ) : (
        <Wrench className="h-2.5 w-2.5 shrink-0" />
      )}
      <span className="truncate">Reconnect</span>
    </button>
  );
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
        <Fragment key={item.id}>
          <ConnectedAccountChip
            label={itemChipLabel(item)}
            tone={chipToneForState(item.sync.state)}
            removing={disconnectingItemId === item.id}
            disabled={connectLoading}
            onRemove={() => onDisconnect(item.id)}
            removeLabel={`Disconnect ${item.institutionName ?? 'Plaid connection'} and its connected accounts`}
            title={itemChipTitle(item)}
          />
          {itemNeedsUpdate(item) && (
            <PlaidRepairButton
              item={item}
              // Reconnect and disconnect mutate the same Plaid item, so each must
              // be inert while the other is in flight.
              isLoading={connectLoading || disconnectingItemId === item.id}
              onClick={() => onUpdate(item.id)}
            />
          )}
        </Fragment>
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
              <div className="mt-1 flex min-w-0 flex-wrap items-center gap-1.5">{itemChips}</div>
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
      {error !== null && error !== '' && (
        <div className="px-4 py-2 border-t border-border/50 text-xs text-destructive">{error}</div>
      )}
    </div>
  );
}
