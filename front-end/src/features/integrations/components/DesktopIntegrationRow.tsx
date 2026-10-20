/**
 * STATE MACHINE: DesktopIntegrationRow (Rose Desktop, flag on)
 *
 *   [NO_ACCOUNTS + ready]        icon · name · "Connect" (runs the existing connect flow)
 *   [NO_ACCOUNTS + desktop-only] icon · name · "Desktop only" · Download for Mac
 *   [NO_ACCOUNTS + coming-soon]  icon · name · "Coming soon"
 *   [ACCOUNTS]  chips (synced | syncing | warning | error), × on each chip removes it,
 *               one progress bar per syncing account, "+ Add account" re-runs connect
 *     chip [SYNCING] --progress reaches 100%--> [SYNCED] (bar disappears)
 *
 * There is no Manage state and no details panel: everything is on the row.
 * Pure presentation; DesktopIntegrations owns data and actions.
 */

import type { ReactNode } from 'react';
import { Loader2 } from 'lucide-react';

import { isProgressComplete } from '../hooks/integrationAccounts';
import { useSyncProgress } from '../hooks/useSyncProgress';
import type { AccountTone } from '../types';
import ConnectedAccountChip from './ConnectedAccountChip';
import SyncProgressBar from './SyncProgressBar';

export interface DesktopAccountView {
  /** Integration row name; with `accountId` it keys the sync-progress adapter. */
  provider: string;
  accountId: string;
  label: string;
  detail?: string;
  tone: AccountTone;
  title?: string;
  onRemove?: () => void;
  removeLabel?: string;
  removing?: boolean;
  disabled?: boolean;
  onResync?: () => void;
  resyncLabel?: string;
  resyncing?: boolean;
}

export interface DesktopIntegrationView {
  key: string;
  name: string;
  /** Existing icon asset, already framed. */
  icon: ReactNode;
  accounts: DesktopAccountView[];
  availability: 'ready' | 'desktop-only' | 'coming-soon';
  onConnect?: () => void;
  connecting?: boolean;
  /** Row-scoped extras (sign-in modal, inline error). */
  extra?: ReactNode;
}

const ACTION_CLASSES =
  'shrink-0 text-[12.5px] font-semibold text-[#e8507f] hover:opacity-80 disabled:opacity-50 dark:text-[#ff7aa2]';
const BADGE_CLASSES =
  'shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground';

export function DesktopSectionHeader({ children }: { children: ReactNode }) {
  return (
    <h3 className="mb-1.5 mt-5 text-[11px] font-semibold uppercase tracking-[0.06em] text-muted-foreground first:mt-1">
      {children}
    </h3>
  );
}

/** One chip; flips a syncing account to synced the moment its progress hits 100%. */
function DesktopAccountChip({ account }: { account: DesktopAccountView }) {
  const progress = useSyncProgress(account.provider, account.accountId);
  const tone: AccountTone =
    account.tone === 'syncing' && isProgressComplete(progress) ? 'synced' : account.tone;
  const pctDetail =
    tone === 'syncing' && progress !== null && progress.pct !== null
      ? `${Math.round(progress.pct)}%`
      : undefined;
  return (
    <ConnectedAccountChip
      variant="desktop"
      label={account.label}
      detail={account.detail ?? pctDetail}
      tone={tone}
      title={account.title ?? (tone === 'warning' ? 'Needs reconnect' : tone)}
      onRemove={account.onRemove}
      removeLabel={account.removeLabel ?? `Remove ${account.label}`}
      removing={account.removing}
      disabled={account.disabled}
      onResync={account.onResync}
      resyncLabel={account.resyncLabel}
      resyncing={account.resyncing}
    />
  );
}

function RowAction({ view }: { view: DesktopIntegrationView }) {
  if (view.availability === 'coming-soon')
    return <span className={BADGE_CLASSES}>Coming soon</span>;
  if (view.availability === 'desktop-only') {
    return (
      <span className="flex shrink-0 items-center gap-2">
        <span className={BADGE_CLASSES}>Desktop only</span>
        <a href="/download" className={ACTION_CLASSES}>
          Download for Mac
        </a>
      </span>
    );
  }
  if (view.onConnect === undefined) return null;
  return (
    <button
      type="button"
      className={ACTION_CLASSES}
      onClick={view.onConnect}
      disabled={view.connecting}
      aria-label={`Connect ${view.name}`}
    >
      {view.connecting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : 'Connect'}
    </button>
  );
}

function AccountsBlock({ view }: { view: DesktopIntegrationView }) {
  const syncing = view.accounts.filter((a) => a.tone === 'syncing');
  const many = view.accounts.length > 1;
  return (
    <div className="ml-[46px] mt-2 flex flex-col gap-2">
      <div className="flex flex-wrap gap-1.5" data-testid={`accounts-${view.key}`}>
        {view.accounts.map((account) => (
          <DesktopAccountChip key={`${account.provider}:${account.accountId}`} account={account} />
        ))}
      </div>
      {syncing.map((account) => (
        <SyncProgressBar
          key={`${account.provider}:${account.accountId}`}
          provider={account.provider}
          accountId={account.accountId}
          prefix={many ? account.label : undefined}
        />
      ))}
      {view.availability === 'ready' && view.onConnect !== undefined && (
        <button
          type="button"
          onClick={view.onConnect}
          disabled={view.connecting}
          aria-label={`Add ${view.name} account`}
          className="inline-flex w-fit items-center gap-1 text-xs text-muted-foreground hover:text-[#e8507f] disabled:opacity-60 dark:hover:text-[#ff7aa2]"
        >
          {view.connecting && <Loader2 className="h-3 w-3 animate-spin" />}+ Add account
        </button>
      )}
    </div>
  );
}

export default function DesktopIntegrationRow({ view }: { view: DesktopIntegrationView }) {
  const hasAccounts = view.accounts.length > 0;
  return (
    <div className="border-b border-border/60 py-2.5" data-testid={`integration-row-${view.key}`}>
      <div className="flex items-center gap-3">
        {view.icon}
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
          {view.name}
        </span>
        {!hasAccounts && <RowAction view={view} />}
      </div>
      {hasAccounts && <AccountsBlock view={view} />}
      {view.extra}
    </div>
  );
}
