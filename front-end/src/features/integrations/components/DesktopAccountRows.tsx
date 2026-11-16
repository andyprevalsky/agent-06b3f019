/**
 * STATE MACHINE: DesktopAccountRows (row layout for multi-account rows, e.g. compute)
 *
 *   one row per account: [⚠] label [· detail] [team-sharing caption]   trailing (usage meter)   ⋯
 *     the caption (AccountTeamShare) opens its own team picker; see TeamSharing
 *     tone synced  → plain label
 *     tone warning → amber label + ⚠ (e.g. "Reconnect")
 *   ⋯ [CLOSED] --click--> [MENU OPEN]: ↻ resync item (e.g. "Re-authenticate", when
 *     the account has one) and a red 🗑 "Remove"
 *     [MENU OPEN] --resync item--> onResync, [CLOSED]
 *     [MENU OPEN] --Remove--> onRemove, [CLOSED]
 *     [MENU OPEN] --escape / outside click--> [CLOSED]
 *   removing → the ⋯ button shows a spinner and is disabled
 *   resyncing (a sign-in already in flight) → the resync item is disabled, so a second
 *     connect cannot replace the first one's remote browser
 *
 * Pure presentation; the row's owner supplies the actions.
 */

import { useState } from 'react';
import { AlertTriangle, Loader2, MoreHorizontal, RefreshCw, Trash2 } from 'lucide-react';

import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';

import type { DesktopAccountView } from './DesktopIntegrationRow';

const MENU_ITEM_CLASSES =
  'flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-sm font-medium hover:bg-muted disabled:pointer-events-none disabled:opacity-40';

function AccountMenu({ account }: { account: DesktopAccountView }) {
  const [open, setOpen] = useState(false);
  const busy = account.removing === true;
  if (account.onRemove === undefined && account.onResync === undefined) return null;
  const run = (action: (() => void) | undefined) => () => {
    setOpen(false);
    action?.();
  };
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={`${account.label} options`}
          disabled={busy}
          className="grid h-6 w-6 shrink-0 place-items-center rounded text-muted-foreground hover:bg-black/5 hover:text-foreground disabled:opacity-50 dark:hover:bg-white/10"
        >
          {busy ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <MoreHorizontal className="h-4 w-4" />
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        className="z-[230] w-48 rounded-xl p-1.5"
        role="menu"
        onCloseAutoFocus={(e) => e.preventDefault()}
      >
        {account.onResync !== undefined && (
          <button
            type="button"
            role="menuitem"
            className={MENU_ITEM_CLASSES}
            disabled={account.resyncing === true}
            onClick={run(account.onResync)}
          >
            <RefreshCw className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
            {account.resyncLabel ?? 'Reconnect'}
          </button>
        )}
        {account.onRemove !== undefined && (
          <button
            type="button"
            role="menuitem"
            aria-label={account.removeLabel}
            disabled={account.disabled}
            className={`${MENU_ITEM_CLASSES} text-red-600 dark:text-[#f0786b]`}
            onClick={run(account.onRemove)}
          >
            <Trash2 className="h-4 w-4 shrink-0" aria-hidden="true" />
            Remove
          </button>
        )}
      </PopoverContent>
    </Popover>
  );
}

function AccountRow({ account }: { account: DesktopAccountView }) {
  const warning = account.tone === 'warning' || account.tone === 'error';
  return (
    <li
      className="flex h-9 items-center gap-3 border-b border-border/50 last:border-b-0"
      data-testid="account-row"
      data-tone={account.tone}
      title={account.title}
    >
      <span
        className={`flex min-w-0 flex-1 items-center gap-1.5 text-[13px] ${
          warning ? 'text-amber-700 dark:text-amber-200' : 'text-foreground/90'
        }`}
      >
        {warning && <AlertTriangle className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />}
        <span className="min-w-0 truncate">{account.label}</span>
        {account.detail !== undefined && account.detail !== '' && (
          <span className="shrink-0 opacity-70">· {account.detail}</span>
        )}
        {account.share}
      </span>
      {account.trailing}
      <AccountMenu account={account} />
    </li>
  );
}

export default function DesktopAccountRows({
  accounts,
  testId,
}: {
  accounts: DesktopAccountView[];
  testId: string;
}) {
  return (
    <ul className="flex flex-col" data-testid={testId}>
      {accounts.map((account) => (
        <AccountRow key={`${account.provider}:${account.accountId ?? ''}`} account={account} />
      ))}
    </ul>
  );
}
