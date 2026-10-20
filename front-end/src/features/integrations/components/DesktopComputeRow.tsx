/**
 * STATE MACHINE: DesktopComputeRow (Rose Desktop, flag on)
 *
 *   [NO_ACCOUNTS] --Connect--> useComputeAccounts.connect() --> sign-in modal
 *   [ACCOUNTS]    chips; × = existing compute removal (no confirm, as today);
 *                 "+ Add account" = the same connect flow
 *   [LEGACY]      only the desktop-synced credential row exists → one "This Mac"
 *                 chip removed through the confirmed row DELETE
 *
 * Compute accounts carry no sync progress; chips are synced or warning only.
 */

import claudeIcon from '@/assets/claude-color.svg';

import { useComputeAccounts } from '../hooks/useComputeAccounts';
import type { ConnectedIntegration } from '../types';
import { ComputeConnectModal } from './ComputeAccountsSection';
import { ChatGPTIcon } from './ComputeSection';
import DesktopIntegrationRow, { type DesktopAccountView } from './DesktopIntegrationRow';
import { rowAccounts, type RemovalPort } from './desktopAccounts';
import DropdownIconFrame, {
  dropdownIconImageClassName,
  DropdownIconPreset,
} from './DropdownIconFrame';

interface DesktopComputeRowProps {
  provider: 'claude' | 'codex';
  isAvailable: boolean;
  /** Desktop-synced credential row (`claude_code` / `gpt_code`), if any. */
  legacyRow: ConnectedIntegration | undefined;
  localSyncing: boolean;
  removal: RemovalPort;
}

function ComputeIcon({ provider }: { provider: 'claude' | 'codex' }) {
  if (provider === 'claude') {
    return (
      <DropdownIconFrame {...DropdownIconPreset.claude}>
        <img src={claudeIcon} alt="" aria-hidden="true" className={dropdownIconImageClassName} />
      </DropdownIconFrame>
    );
  }
  // The ChatGPT glyph is currentColor; pin it dark so it stays visible on the
  // light icon tile in dark mode.
  return (
    <DropdownIconFrame {...DropdownIconPreset.chatgpt} className="text-[#111111]">
      <ChatGPTIcon />
    </DropdownIconFrame>
  );
}

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
    };
  });
  const accounts =
    cloudAccounts.length > 0
      ? cloudAccounts
      : rowAccounts(
          legacyRow,
          { displayName: providerLabel, label: 'This Mac', localSyncing },
          removal,
        );
  return (
    <DesktopIntegrationRow
      view={{
        key: provider,
        name,
        icon: <ComputeIcon provider={provider} />,
        accounts,
        availability: isAvailable || accounts.length > 0 ? 'ready' : 'desktop-only',
        onConnect: isAvailable ? () => void state.connect() : undefined,
        connecting: state.isConnecting || localSyncing,
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
