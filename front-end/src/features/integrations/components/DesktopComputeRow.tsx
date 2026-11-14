/**
 * STATE MACHINE: DesktopComputeRow (Rose Desktop, flag on)
 *
 *   [NO_ACCOUNTS] --Connect--> useComputeAccounts.connect() --> sign-in modal
 *   [ACCOUNTS]    one line per account: email (needs_reconnect keeps its amber
 *                 ⚠ "· Reconnect" status), its 7d usage bar (SubscriptionUsageMeter),
 *                 ⋯ menu = Re-authenticate (the same connect flow; re-signing an
 *                 account refreshes it in place; disabled while a sign-in runs) + Remove (existing compute
 *                 removal, no confirm, as today); "+ Add account" = connect flow
 *   [LEGACY]      only the desktop-synced credential row exists → one "This Mac"
 *                 line disconnected through the confirmed row DELETE; no usage
 *
 * Usage is whatever agents last reported on the account's token (they carry it
 * on the lease heartbeat they already send); useComputeAccounts refetches it in
 * the background and ticks `now` so cooldowns expire on screen. The meter shows
 * the next reset as visible text (no hover on iOS); a long email truncates first.
 * Compute accounts carry no sync progress; lines are synced or warning only.
 */

import claudeIcon from '@/assets/claude-color.svg';

import { useComputeAccounts } from '../hooks/useComputeAccounts';
import type { ConnectedIntegration } from '../types';
import { ComputeConnectModal } from './ComputeAccountsSection';
import { ChatGPTIcon } from './ComputeSection';
import DesktopIntegrationRow, {
  type DesktopAccountView,
  type DesktopIcon,
} from './DesktopIntegrationRow';
import { singleAccount, type RemovalPort } from './desktopAccounts';
import SubscriptionUsageMeter from './SubscriptionUsageMeter';
import { dropdownIconImageClassName, DropdownIconPreset } from './DropdownIconFrame';

interface DesktopComputeRowProps {
  provider: 'claude' | 'codex';
  isAvailable: boolean;
  /** Desktop-synced credential row (`claude_code` / `gpt_code`), if any. */
  legacyRow: ConnectedIntegration | undefined;
  localSyncing: boolean;
  removal: RemovalPort;
}

const CLAUDE_ICON: DesktopIcon = {
  preset: DropdownIconPreset.claude,
  glyph: <img src={claudeIcon} alt="" aria-hidden="true" className={dropdownIconImageClassName} />,
};

// The ChatGPT glyph is currentColor; pin it dark so it stays visible on the
// light icon tile in dark mode.
const CHATGPT_ICON: DesktopIcon = {
  preset: DropdownIconPreset.chatgpt,
  glyph: <ChatGPTIcon />,
  className: 'text-[#111111]',
};

export default function DesktopComputeRow({
  provider,
  isAvailable,
  legacyRow,
  localSyncing,
  removal,
}: DesktopComputeRowProps) {
  const state = useComputeAccounts(provider);
  const name = provider === 'claude' ? 'Claude Subscription' : 'ChatGPT Subscription';
  const providerLabel = provider === 'claude' ? 'Claude' : 'ChatGPT';
  const cloudAccounts: DesktopAccountView[] = state.accounts.map((account) => {
    const label = account.accountEmail ?? account.accountId;
    const warning = account.state === 'needs_reconnect';
    return {
      provider,
      accountId: account.accountId,
      label,
      tone: warning ? 'warning' : 'synced',
      detail: warning ? 'Reconnect' : undefined,
      title: account.lastErrorReason ?? undefined,
      onRemove: () => void state.remove(account),
      removeLabel: `Remove ${providerLabel} account ${label}`,
      removing: state.removing === account.accountId,
      disabled: state.removing !== null,
      onResync: isAvailable ? () => void state.connect() : undefined,
      resyncLabel: 'Re-authenticate',
      resyncing: state.isConnecting,
      trailing: <SubscriptionUsageMeter account={account} now={state.now} />,
    };
  });
  const accounts =
    cloudAccounts.length > 0
      ? cloudAccounts
      : singleAccount(
          legacyRow,
          { displayName: providerLabel, label: 'This Mac', localSyncing },
          removal,
        );
  return (
    <DesktopIntegrationRow
      view={{
        key: provider,
        name,
        icon: provider === 'claude' ? CLAUDE_ICON : CHATGPT_ICON,
        accounts,
        availability: isAvailable || accounts.length > 0 ? 'ready' : 'desktop-only',
        onConnect: isAvailable ? () => void state.connect() : undefined,
        connecting: state.isConnecting || localSyncing,
        multiAccount: true,
        layout: 'rows',
        extra: (
          <>
            {state.error !== null && (
              <p className="ml-[46px] mt-1 text-xs text-destructive">{state.error}</p>
            )}
            <ComputeConnectModal state={state} providerLabel={providerLabel} />
          </>
        ),
      }}
    />
  );
}
