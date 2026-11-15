/**
 * STATE MACHINE: DesktopIntegrationRow (Rose Desktop, flag on)
 *
 *   [NOT CONNECTED + ready]        icon · name · "Connect" (runs the existing connect flow)
 *   [NOT CONNECTED + desktop-only] icon · name · "Desktop only" · Download for Mac
 *   [NOT CONNECTED + coming-soon]  icon · name · "Coming soon"
 *   [CONNECTED]  the stock app-icon tile glows rose (amber while an account needs
 *                reconnecting); the row's ONE account chip (synced | syncing |
 *                warning | error), × disconnects it; one gradient bar while it syncs
 *     chip [SYNCING] --progress reaches 100% or state synced--> [SYNCED] (bar disappears)
 *     chip [WARNING] (needs_reconnect / EXPIRED) → "needs reconnect"
 *     chip [ERROR] (sync_failed) → "sync failed" + its lastError on a line under the chip
 *   [CONNECTED, multiAccount] rows that listed several accounts before Rose Desktop
 *     (Gmail addresses, Plaid institutions, compute subscriptions): one chip per
 *     account, one bar per syncing account, "+ Add account" re-runs connect
 *     chip [SYNCING + light] (Gmail `history`) → "checking for new mail", no bar
 *     addLabel → "+ <addLabel>" instead of "+ Add account"
 *     rowSync (the backend reports one account for the whole row) → one row bar,
 *       no per-chip bars
 *   bar text: provider phase as words, bytes as sizes, "N of M <unit>", "~ETA left"
 *   [CONNECTED, layout=rows] (compute subscriptions): one line per account instead
 *     of chips — label, its team-sharing caption (if any), the account's trailing
 *     usage meter, and a ⋯ menu holding its reconnect / remove actions (DesktopAccountRows)
 *   [CONNECTED, an account has `share`] (any shareable account — Gmail, iMessage,
 *     WhatsApp, Plaid, LinkedIn, Granola, Fireflies — with a team to share with):
 *     one account per line — its chip, then its team-sharing caption (AccountTeamShare)
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
import DesktopAccountRows from './DesktopAccountRows';
import DropdownIconFrame, { warningGlowGradient } from './DropdownIconFrame';
import SyncProgressBar from './SyncProgressBar';

export interface DesktopAccountView {
  /** Integration row name; keys the sync-progress adapter. */
  provider: string;
  /** Gmail address / Plaid item / compute account; undefined = the row's one account. */
  accountId?: string;
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
  /** A light sync state: the chip says what is happening and no bar is drawn. */
  hideProgress?: boolean;
  /** Why the last sync failed, printed under the chip (not only as a tooltip). */
  errorText?: string;
  /** Row layout only: right-aligned content beside the label (compute usage meter). */
  trailing?: ReactNode;
  /** The account's team-sharing caption: right after its chip, or beside its label in row layout. */
  share?: ReactNode;
}

/** Sync of a multi-account row whose backend reports one account for the whole row. */
export interface RowSync {
  provider: string;
  syncing: boolean;
  hideProgress?: boolean;
  errorText?: string;
}

/** The stock app-icon tile: DropdownIconFrame preset + the existing glyph/asset. */
export interface DesktopIcon {
  preset: { iconScale?: number; iconFit?: 'contain' | 'cover' | 'fill' };
  glyph: ReactNode;
  /** Frame class, e.g. pinning a currentColor glyph dark on the light tile. */
  className?: string;
}

export interface DesktopIntegrationView {
  key: string;
  name: string;
  icon: DesktopIcon;
  accounts: DesktopAccountView[];
  availability: 'ready' | 'desktop-only' | 'coming-soon';
  onConnect?: () => void;
  connecting?: boolean;
  /** Listed several accounts before Rose Desktop: "+ Add account" stays. */
  multiAccount?: boolean;
  rowSync?: RowSync;
  /** `rows` = one line per account with a ⋯ menu (compute); default wraps chips. */
  layout?: 'chips' | 'rows';
  /** Row-scoped extras (sign-in modal, inline error). */
  extra?: ReactNode;
  /** multiAccount add button text; default "+ Add account". */
  addLabel?: string;
}

/** Shared row look (the iPhone row reuses these so every integration row matches). */
export const DESKTOP_ROW_CLASSES = 'border-b border-border/60 py-2.5';
export const DESKTOP_ROW_NAME_CLASSES =
  'min-w-0 flex-1 truncate text-sm font-medium text-foreground';
export const ACTION_CLASSES =
  'shrink-0 text-[12.5px] font-semibold text-[#e8507f] hover:opacity-80 disabled:opacity-50 dark:text-[#ff7aa2]';
const BADGE_CLASSES =
  'shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground';
const ERROR_LINE_CLASSES = 'text-xs text-destructive dark:text-red-300';

export function DesktopSectionHeader({ children }: { children: ReactNode }) {
  return (
    <h3 className="mb-1.5 mt-5 text-[11px] font-semibold uppercase tracking-[0.06em] text-muted-foreground first:mt-1">
      {children}
    </h3>
  );
}

function defaultTitle(tone: DesktopAccountView['tone']): string {
  if (tone === 'warning') return 'Needs reconnect';
  return tone;
}

/** One chip; flips a syncing account to synced the moment its progress hits 100%. */
function DesktopAccountChip({ account }: { account: DesktopAccountView }) {
  const progress = useSyncProgress(account.provider, account.accountId);
  const tone = account.tone === 'syncing' && isProgressComplete(progress) ? 'synced' : account.tone;
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
      title={account.title ?? defaultTitle(tone)}
      onRemove={account.onRemove}
      removeLabel={account.removeLabel ?? `Disconnect ${account.label}`}
      removing={account.removing}
      disabled={account.disabled}
      onResync={account.onResync}
      resyncLabel={account.resyncLabel}
      resyncing={account.resyncing}
    />
  );
}

function RowIcon({ view }: { view: DesktopIntegrationView }) {
  const connected = view.accounts.length > 0;
  const damaged = view.accounts.some((a) => a.tone === 'warning');
  return (
    <DropdownIconFrame
      {...view.icon.preset}
      className={view.icon.className}
      isSynced={connected}
      glowGradient={damaged ? warningGlowGradient : undefined}
    >
      {view.icon.glyph}
    </DropdownIconFrame>
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

const accountKey = (account: DesktopAccountView) =>
  `${account.provider}:${account.accountId ?? ''}`;

function SyncBars({ view }: { view: DesktopIntegrationView }) {
  const syncing = view.accounts.filter((a) => a.tone === 'syncing' && a.hideProgress !== true);
  if (view.rowSync !== undefined) {
    const { rowSync } = view;
    const show = (rowSync.syncing || syncing.length > 0) && rowSync.hideProgress !== true;
    return show ? <SyncProgressBar provider={rowSync.provider} /> : null;
  }
  const many = view.accounts.length > 1;
  return (
    <>
      {syncing.map((account) => (
        <SyncProgressBar
          key={accountKey(account)}
          provider={account.provider}
          accountId={account.accountId}
          prefix={many ? account.label : undefined}
        />
      ))}
    </>
  );
}

function AccountsBlock({ view }: { view: DesktopIntegrationView }) {
  const many = view.accounts.length > 1;
  const shared = view.accounts.some((account) => account.share !== undefined);
  const rowError = view.rowSync?.errorText;
  return (
    <div className="ml-[46px] mt-2 flex flex-col gap-2">
      {view.layout === 'rows' ? (
        <DesktopAccountRows accounts={view.accounts} testId={`accounts-${view.key}`} />
      ) : (
        <div
          className={shared ? 'flex flex-col gap-1.5' : 'flex flex-wrap gap-1.5'}
          data-testid={`accounts-${view.key}`}
        >
          {view.accounts.map((account) =>
            shared ? (
              <div key={accountKey(account)} className="flex min-w-0 items-center gap-2.5">
                <DesktopAccountChip account={account} />
                {account.share}
              </div>
            ) : (
              <DesktopAccountChip key={accountKey(account)} account={account} />
            ),
          )}
        </div>
      )}
      {view.accounts
        .filter((account) => account.errorText !== undefined)
        .map((account) => (
          <p
            key={`error:${accountKey(account)}`}
            data-testid="account-sync-error"
            className={ERROR_LINE_CLASSES}
          >
            {many ? `${account.label}: ` : ''}
            {account.errorText}
          </p>
        ))}
      {rowError !== undefined && (
        <p data-testid="account-sync-error" className={ERROR_LINE_CLASSES}>
          {rowError}
        </p>
      )}
      <SyncBars view={view} />
      {view.multiAccount === true && view.availability === 'ready' && view.onConnect && (
        <button
          type="button"
          onClick={view.onConnect}
          disabled={view.connecting}
          aria-label={view.addLabel ?? `Add ${view.name} account`}
          className="inline-flex w-fit items-center gap-1 text-xs text-muted-foreground hover:text-[#e8507f] disabled:opacity-60 dark:hover:text-[#ff7aa2]"
        >
          {view.connecting && <Loader2 className="h-3 w-3 animate-spin" />}+{' '}
          {view.addLabel ?? 'Add account'}
        </button>
      )}
    </div>
  );
}

export default function DesktopIntegrationRow({ view }: { view: DesktopIntegrationView }) {
  const connected = view.accounts.length > 0;
  return (
    <div className={DESKTOP_ROW_CLASSES} data-testid={`integration-row-${view.key}`}>
      <div className="flex items-center gap-3">
        <RowIcon view={view} />
        <span className={DESKTOP_ROW_NAME_CLASSES}>{view.name}</span>
        {!connected && <RowAction view={view} />}
      </div>
      {connected && <AccountsBlock view={view} />}
      {view.extra}
    </div>
  );
}
