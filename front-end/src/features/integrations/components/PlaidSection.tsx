/**
 * STATE MACHINE: PlaidSection
 *
 *   [COLLAPSED] --toggle--> [EXPANDED] --toggle--> [COLLAPSED]
 *
 *   Sub-flow:
 *     [DISCONNECTED] --click "Connect"--> [CONNECTING]
 *       --Plaid Link success--> [EXCHANGING] --done--> [CONNECTED]
 *     [CONNECTED]   --click "Disconnect <item>"--> [DISCONNECTING]
 *       --done--> [CONNECTED, items - 1] (or [DISCONNECTED] if last item)
 */

import { Loader2, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';

import SectionToggleButton from './SectionToggleButton';
import SyncItemButton from './SyncItemButton';
import type { PlaidItem } from '../types';

interface PlaidSectionProps {
  expanded: boolean;
  onToggle: () => void;
  items: PlaidItem[];
  itemsLoading: boolean;
  connectLoading: boolean;
  disconnectingItemId: string | null;
  error: string | null;
  onConnect: () => void;
  onDisconnect: (itemId: string) => void;
}

function PlaidIcon() {
  return (
    <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" aria-hidden>
      <defs>
        <linearGradient id="plaidGradientIntegrations" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="#10b981" />
          <stop offset="100%" stopColor="#22c55e" />
        </linearGradient>
      </defs>
      <path
        d="M12 2L3 7v10l9 5 9-5V7l-9-5zm0 2.2L18.8 8 12 11.8 5.2 8 12 4.2zM5 9.5l6 3.4v7.3l-6-3.4V9.5zm14 0v7.3l-6 3.4v-7.3l6-3.4z"
        fill="url(#plaidGradientIntegrations)"
      />
    </svg>
  );
}

function ItemRow({
  item,
  disconnecting,
  onDisconnect,
}: {
  item: PlaidItem;
  disconnecting: boolean;
  onDisconnect: () => void;
}) {
  return (
    <div className="px-4 py-3 flex items-center justify-between gap-2 border-b border-border/50 last:border-b-0">
      <div className="flex flex-col min-w-0">
        <span className="text-sm font-medium truncate">
          {item.institutionName ?? 'Connected institution'}
        </span>
        <span className="text-xs text-muted-foreground truncate">
          {item.accounts.length} account{item.accounts.length === 1 ? '' : 's'}
          {item.accounts.length > 0 ? ' — ' : ''}
          {item.accounts.map((a) => `${a.name}${a.mask ? ` ••${a.mask}` : ''}`).join(', ')}
        </span>
      </div>
      <Button
        size="sm"
        variant="ghost"
        onClick={onDisconnect}
        disabled={disconnecting}
        className="h-8 px-2 text-muted-foreground hover:text-destructive"
        aria-label={`Disconnect ${item.institutionName ?? 'institution'}`}
      >
        {disconnecting ? (
          <Loader2 className="w-3.5 h-3.5 animate-spin" />
        ) : (
          <Trash2 className="w-3.5 h-3.5" />
        )}
      </Button>
    </div>
  );
}

function ConnectRow({
  loading,
  onConnect,
  hasItems,
}: {
  loading: boolean;
  onConnect: () => void;
  hasItems: boolean;
}) {
  return (
    <div className="px-4 py-3 flex items-center justify-between border-t border-border/50">
      <div className="flex items-center gap-3">
        <PlaidIcon />
        <span className="text-sm">
          {hasItems ? 'Connect another account' : 'Connect a bank or financial account'}
        </span>
      </div>
      <SyncItemButton isLoading={loading} isSynced={hasItems} onClick={onConnect} />
    </div>
  );
}

function PoweredByPlaid() {
  return (
    <div className="px-4 py-2 border-t border-border/50 text-[10px] text-muted-foreground flex items-center justify-end gap-1">
      <span>Powered by</span>
      <a
        href="https://plaid.com"
        target="_blank"
        rel="noreferrer noopener"
        className="font-medium underline-offset-2 hover:underline"
      >
        Plaid
      </a>
    </div>
  );
}

export default function PlaidSection({
  expanded,
  onToggle,
  items,
  itemsLoading,
  connectLoading,
  disconnectingItemId,
  error,
  onConnect,
  onDisconnect,
}: PlaidSectionProps) {
  const isConnected = items.length > 0;
  return (
    <div className="rounded-lg border border-border bg-card/60 overflow-hidden">
      <div className="p-4 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-lg flex items-center justify-center bg-background">
            <PlaidIcon />
          </div>
          <div className="flex flex-col">
            <h3 className="font-medium">Banks &amp; Financial Accounts</h3>
            <span className="text-xs text-muted-foreground">
              Connect via Plaid for balances, transactions, investments &amp; more
            </span>
          </div>
        </div>
        <SectionToggleButton isConnected={isConnected} onClick={onToggle} />
      </div>
      {expanded && (
        <div className="border-t border-border">
          {itemsLoading ? (
            <div className="px-4 py-4 flex items-center gap-2 text-xs text-muted-foreground">
              <Loader2 className="w-3 h-3 animate-spin" />
              Loading connected accounts…
            </div>
          ) : (
            <>
              {items.map((item) => (
                <ItemRow
                  key={item.id}
                  item={item}
                  disconnecting={disconnectingItemId === item.id}
                  onDisconnect={() => onDisconnect(item.id)}
                />
              ))}
              <ConnectRow
                loading={connectLoading}
                onConnect={onConnect}
                hasItems={items.length > 0}
              />
              {error !== null && error !== '' && (
                <div className="px-4 py-2 border-t border-border/50 text-xs text-destructive">
                  {error}
                </div>
              )}
              <PoweredByPlaid />
            </>
          )}
        </div>
      )}
    </div>
  );
}
