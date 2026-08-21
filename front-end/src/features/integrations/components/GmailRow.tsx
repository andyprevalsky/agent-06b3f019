/**
 * STATE MACHINE: GmailRow
 *
 *   [NO_ACCOUNTS] --plus click--> [CONNECTING] --OAuth--> [CHIPS]
 *
 *   per chip:
 *     [CONNECTED]        rose chip
 *     [DAMAGED]          amber chip + warning icon + resync control
 *     [DAMAGED] --resync--> [REPAIRING] --ok--> [CONNECTED]
 *                                      --needs re-consent--> [CONNECTING]
 *
 * Split out of MessagesSyncSection so each file stays within its line budget;
 * this is the only row with per-account state, so it carries the most logic.
 */

import { Loader2, Plus } from 'lucide-react';

import { gmailAccounts, hasDamagedGmailAccount } from '../hooks/useIntegrationData';
import type { ConnectedIntegration } from '../types';
import ConnectedAccountChip from './ConnectedAccountChip';
import DropdownIconFrame, { DropdownIconPreset, warningGlowGradient } from './DropdownIconFrame';
import { GmailIcon } from './MessageSyncIcons';

function GmailEmails({
  connectedIntegrations,
  disconnectingEmail,
  resyncingEmail,
  onGmailDisconnect,
  onGmailResync,
}: {
  connectedIntegrations: ConnectedIntegration[];
  disconnectingEmail: string | null;
  resyncingEmail: string | null;
  onGmailDisconnect: (email: string) => void;
  onGmailResync: (email: string) => void;
}) {
  const gmail = connectedIntegrations.find((i) => i.name === 'gmail');
  const accounts = gmailAccounts(gmail);
  if (accounts.length === 0) return null;

  return (
    <div className="mt-1 flex min-w-0 flex-wrap gap-1.5">
      {accounts.map((account) => {
        const damaged = account.state !== 'connected';
        return (
          <ConnectedAccountChip
            key={account.email}
            label={account.email}
            tone={damaged ? 'warning' : 'synced'}
            detail={damaged ? 'Needs Reconnection' : undefined}
            removing={disconnectingEmail === account.email}
            onRemove={() => onGmailDisconnect(account.email)}
            removeLabel={`Disconnect ${account.email}`}
            // The repair affordance only exists on damaged accounts, so a
            // healthy chip keeps its original single-action behaviour.
            onResync={damaged ? () => onGmailResync(account.email) : undefined}
            resyncLabel={`Reconnect ${account.email}`}
            resyncing={resyncingEmail === account.email}
            title={
              damaged
                ? (account.lastErrorReason ?? 'This account needs to be reconnected.')
                : 'Disconnect Gmail account'
            }
          />
        );
      })}
    </div>
  );
}

export default function GmailRow({
  connectedIntegrations,
  connectingProvider,
  disconnectingEmail,
  resyncingEmail,
  onGmailConnect,
  onGmailDisconnect,
  onGmailResync,
}: {
  connectedIntegrations: ConnectedIntegration[];
  connectingProvider: 'gmail' | null;
  disconnectingEmail: string | null;
  resyncingEmail: string | null;
  onGmailConnect: () => void;
  onGmailDisconnect: (email: string) => void;
  onGmailResync: (email: string) => void;
}) {
  const isConnected = connectedIntegrations.some((i) => i.name === 'gmail');
  const isDamaged = hasDamagedGmailAccount(connectedIntegrations);
  return (
    <div className="px-4 py-2 flex items-center justify-between border-b border-border/50">
      <div className="flex items-center gap-3">
        <DropdownIconFrame
          {...DropdownIconPreset.gmail}
          isSynced={isConnected}
          glowGradient={isDamaged ? warningGlowGradient : undefined}
        >
          <GmailIcon />
        </DropdownIconFrame>
        <div className="flex min-w-0 flex-col">
          <div className="flex min-w-0 items-center">
            <span className="truncate text-sm">Gmail</span>
          </div>
          <GmailEmails
            connectedIntegrations={connectedIntegrations}
            disconnectingEmail={disconnectingEmail}
            resyncingEmail={resyncingEmail}
            onGmailDisconnect={onGmailDisconnect}
            onGmailResync={onGmailResync}
          />
        </div>
      </div>
      <button
        onClick={onGmailConnect}
        disabled={connectingProvider === 'gmail'}
        className="h-8 w-8 rounded-md flex items-center justify-center transition-all duration-200 bg-muted hover:bg-muted/80 text-muted-foreground hover:text-foreground disabled:opacity-60"
      >
        {connectingProvider === 'gmail' ? (
          <Loader2 className="w-3.5 h-3.5 animate-spin" />
        ) : (
          <Plus className="w-3.5 h-3.5" />
        )}
      </button>
    </div>
  );
}
