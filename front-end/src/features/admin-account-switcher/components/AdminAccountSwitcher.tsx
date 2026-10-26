/**
 * STATE MACHINE: AdminAccountSwitcher
 *
 * Visibility:
 *   [HIDDEN] -- viewer is an admin OR is mid-impersonation --> [PILL]
 *   (an admin who switches into a NON-admin keeps the pill, because the stashed
 *    admin session is the only way back — hiding it would strand them)
 *   pillOnlyWhileAway (Rose Desktop accounts, whose switcher lives in Settings):
 *   the floating pill renders only while impersonating ([PILL:away], the exit);
 *   [PILL:own] is HIDDEN so the top-right corner holds only the app icons.
 *
 * Variant:
 *   pill   (default) floating top-right pill; the panel drops down beneath it
 *   inline Rose Desktop Settings panel section: same pill + panel, in normal
 *          flow (the panel opens below the row, never absolutely positioned),
 *          neutral light/dark colors to match the flat Settings drawer
 *
 * Pill:
 *   [PILL:own]  neutral, shows the signed-in admin's name
 *   [PILL:away] purple, shows "Viewing as <name>" + an exit control
 *   [PILL] --click--> [PANEL]
 *   [PANEL] --click outside / Escape / switch --> [PILL]
 *
 * Panel:
 *   Current account · quick-switch admin chips (always visible, one click back
 *   to Andy or Tamy) · search box that expands into selectable results.
 *
 * The pill variant renders inside the app shell's fixed top-right control rail so
 * it is reachable from any view without colliding with sibling global controls;
 * the inline variant renders inside the Rose Desktop Settings panel.
 */

import { ArrowLeftRight, Loader2, Search, ShieldCheck, X } from 'lucide-react';
import { useEffect, useRef } from 'react';

import { ADMIN_ACCOUNTS } from '@/lib/adminAccounts';
import { displayLabel } from '@/lib/adminUsers';
import { cn } from '@/lib/utils';

import { useAdminAccountSwitcher } from '../hooks/useAdminAccountSwitcher';
import type { SwitchableAccount } from '../types';

export type AdminAccountSwitcherVariant = 'pill' | 'inline';

interface AdminAccountSwitcherProps {
  /** True when the signed-in viewer is on the product-wide admin allowlist. */
  isAdmin: boolean;
  /** Display name for the viewer's own account, shown when not impersonating. */
  ownAccountLabel: string | null;
  /** 'pill' (default): floating top-right; 'inline': the Rose Desktop Settings section. */
  variant?: AdminAccountSwitcherVariant;
  /** Pill only: render it only while impersonating (Rose Desktop hosts it in Settings). */
  pillOnlyWhileAway?: boolean;
}

const PILL_CONTAINER_CLASS = 'relative flex max-w-full min-w-0 flex-col items-end';
const INLINE_CONTAINER_CLASS = 'relative my-4 flex max-w-full min-w-0 flex-col items-start';
const PILL_OWN_CLASS = 'border-border/60 bg-background/90 text-foreground';
const INLINE_OWN_CLASS =
  'border-gray-200 bg-white text-[hsl(240_15%_8%)] dark:border-white/[0.09] dark:bg-[#2f2f2c] dark:text-[#e4e4df]';
const AWAY_CLASS = 'border-purple-400/60 bg-purple-600/95 text-white';

export function AdminAccountSwitcher({
  isAdmin,
  ownAccountLabel,
  variant = 'pill',
  pillOnlyWhileAway = false,
}: AdminAccountSwitcherProps) {
  const switcher = useAdminAccountSwitcher();
  const containerRef = useRef<HTMLDivElement>(null);
  const { open, setOpen, impersonated } = switcher;

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open, setOpen]);

  // An impersonating viewer keeps the control even when the account they landed
  // in is not an admin — it holds the only route back to their own session.
  if (!isAdmin && impersonated === null) return null;

  const away = impersonated !== null;
  const inline = variant === 'inline';
  // The Settings section is the home of a Rose Desktop switcher; the floating
  // pill stays only as the exit while impersonating.
  if (!inline && pillOnlyWhileAway && !away) return null;
  const pillLabel = away ? `Viewing as ${switcher.currentLabel}` : (ownAccountLabel ?? 'Admin');

  return (
    <div
      ref={containerRef}
      className={inline ? INLINE_CONTAINER_CLASS : PILL_CONTAINER_CLASS}
      data-testid="admin-account-switcher"
      data-variant={variant}
    >
      <div
        className={cn(
          'flex max-w-full min-w-0 items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-medium',
          !inline && 'shadow-lg backdrop-blur-md',
          'transition-colors',
          away ? AWAY_CLASS : inline ? INLINE_OWN_CLASS : PILL_OWN_CLASS,
        )}
        data-testid={away ? 'admin-impersonation-badge' : 'admin-account-pill'}
        role="status"
      >
        <button
          type="button"
          onClick={() => setOpen(!open)}
          className="flex min-w-0 items-center gap-1.5 whitespace-nowrap"
          aria-expanded={open}
          aria-haspopup="dialog"
          aria-label="Switch account"
        >
          {away ? (
            <ArrowLeftRight className="h-3.5 w-3.5 shrink-0" />
          ) : (
            <ShieldCheck className="h-3.5 w-3.5 shrink-0" />
          )}
          <span className="min-w-0 max-w-[16rem] truncate">{pillLabel}</span>
        </button>
        {away && (
          <button
            type="button"
            onClick={switcher.switchBack}
            className="-mr-1 rounded-full p-0.5 transition-colors hover:bg-white/20"
            aria-label="Return to my account"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        )}
      </div>

      {open && (
        <SwitcherPanel switcher={switcher} ownAccountLabel={ownAccountLabel} inline={inline} />
      )}
    </div>
  );
}

const PILL_PANEL_CLASS =
  'absolute right-0 top-full mt-2 w-[22rem] max-w-[calc(100vw-2rem)] overflow-hidden rounded-xl border border-border/60 bg-background/98 shadow-2xl backdrop-blur-md';
/** In flow below the Settings row (the drawer scrolls; nothing is clipped). */
const INLINE_PANEL_CLASS =
  'mt-2 w-full max-w-[22rem] overflow-hidden rounded-xl border border-gray-200 bg-white dark:border-white/[0.09] dark:bg-[#2f2f2c]';

function SwitcherPanel({
  switcher,
  ownAccountLabel,
  inline,
}: {
  switcher: ReturnType<typeof useAdminAccountSwitcher>;
  ownAccountLabel: string | null;
  inline: boolean;
}) {
  const { impersonated, query, setQuery, results, error, switchingUserId } = switcher;

  return (
    <div
      className={inline ? INLINE_PANEL_CLASS : PILL_PANEL_CLASS}
      role="dialog"
      aria-label="Account switcher"
    >
      <section className="border-b border-border/50 px-4 py-3">
        <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
          Current account
        </p>
        <div className="mt-1 flex items-center justify-between gap-2">
          <div className="min-w-0">
            <p className="truncate text-sm font-medium">
              {impersonated === null ? (ownAccountLabel ?? 'Admin') : displayLabel(impersonated)}
            </p>
            {impersonated !== null && (
              <p className="truncate text-xs text-muted-foreground">
                {impersonated.email ?? impersonated.phone ?? impersonated.userId}
              </p>
            )}
          </div>
          {impersonated !== null && (
            <button
              type="button"
              onClick={switcher.switchBack}
              className="shrink-0 rounded-lg border border-purple-500/40 bg-purple-500/10 px-2.5 py-1 text-xs font-medium text-purple-600 transition-colors hover:bg-purple-500/20 dark:text-purple-300"
            >
              Back to me
            </button>
          )}
        </div>
      </section>

      <section className="border-b border-border/50 px-4 py-3">
        <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
          Admin accounts
        </p>
        <div className="mt-2 flex flex-wrap gap-2">
          {ADMIN_ACCOUNTS.map((account) => (
            <button
              key={account.userId}
              type="button"
              onClick={() => void switcher.switchTo(account.userId)}
              disabled={switchingUserId !== null}
              className="inline-flex items-center gap-1.5 rounded-lg border border-border/70 px-2.5 py-1 text-xs font-medium transition-colors hover:bg-muted disabled:opacity-50"
            >
              {switchingUserId === account.userId ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : (
                <ShieldCheck className="h-3 w-3" />
              )}
              {account.name}
            </button>
          ))}
        </div>
      </section>

      <section className="px-4 py-3">
        <label className="flex items-center gap-2 rounded-lg border border-border/70 px-2.5 py-1.5">
          <Search className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search name, email, or phone"
            aria-label="Search accounts"
            autoFocus
            className="w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
          />
        </label>

        {error !== null && <p className="mt-2 text-xs text-destructive">{error}</p>}

        {query.trim() !== '' && (
          <SearchResults
            results={results}
            switchingUserId={switchingUserId}
            onSelect={(userId) => void switcher.switchTo(userId)}
          />
        )}
      </section>
    </div>
  );
}

function SearchResults({
  results,
  switchingUserId,
  onSelect,
}: {
  results: SwitchableAccount[] | null;
  switchingUserId: string | null;
  onSelect: (userId: string) => void;
}) {
  if (results === null) {
    return (
      <div className="flex h-16 items-center justify-center">
        <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (results.length === 0) {
    return <p className="mt-3 text-xs text-muted-foreground">No accounts match that search.</p>;
  }

  return (
    <ul className="mt-2 max-h-64 divide-y divide-border/40 overflow-y-auto">
      {results.map((person) => (
        <li key={person.key}>
          <button
            type="button"
            onClick={() => onSelect(person.userId)}
            disabled={switchingUserId !== null}
            className="flex w-full items-center justify-between gap-2 px-1 py-2 text-left transition-colors hover:bg-muted/60 disabled:opacity-50"
          >
            <span className="min-w-0">
              <span className="block truncate text-sm font-medium">{displayLabel(person)}</span>
              <span className="block truncate text-xs text-muted-foreground">
                {person.email ?? person.phone ?? person.userId}
              </span>
            </span>
            {switchingUserId === person.userId ? (
              <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" />
            ) : (
              <ArrowLeftRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            )}
          </button>
        </li>
      ))}
    </ul>
  );
}
