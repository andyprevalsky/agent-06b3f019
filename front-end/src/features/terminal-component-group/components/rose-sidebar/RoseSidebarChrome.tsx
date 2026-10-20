/**
 * Presentational rows for the Rose Desktop left bar (UI ledger rows 17/29/30/63):
 * account row: signed in = cursive initial, anonymous = member icon (both open
 * Settings); no session = member icon labelled "Sign in" (opens login).
 * Home (label just "Home"), the raw black "New Super Agent" button (row 76; dark mode
 * inverts it: #f2f2ef fill, #1f1f1d label/plus, mock panels/dark.js .nb), the
 * Search row, plain nav rows (Archived, Browse, Health) and the account row. Stateless.
 *
 * Every row keeps its icon at the same x whether the bar is collapsed (64px)
 * or hover-expanded (236px); labels fade in. Active = color/weight, no fills.
 */

import type { User } from '@supabase/supabase-js';
import { Home, Plus, Search } from 'lucide-react';
import type { ReactNode } from 'react';

import { cn } from '@/lib/utils';

import { accountDisplayName } from './accountDisplayName';
import { AccountGlyph } from './accountIdentity';
import { ROSE_ACTIVE_COLOR } from './roseSidebarLayout';

const ROW =
  'flex h-[38px] w-full flex-none items-center gap-3 whitespace-nowrap px-[22px] text-left text-[13px]';

function Label({ isExpanded, children }: { isExpanded: boolean; children: ReactNode }) {
  return (
    <span
      className={cn(
        'min-w-0 truncate transition-opacity duration-200',
        isExpanded ? 'opacity-100' : 'opacity-0',
      )}
    >
      {children}
    </span>
  );
}

export function RoseHomeRow({ isExpanded, onClick }: { isExpanded: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      aria-label="Home"
      onClick={onClick}
      className={cn(ROW, 'font-semibold text-[hsl(240_15%_8%)] dark:text-[#ecece8]')}
    >
      <Home className="h-[21px] w-[21px] flex-none" strokeWidth={1.7} />
      <Label isExpanded={isExpanded}>Home</Label>
    </button>
  );
}

export function RoseNewAgentButton({
  isExpanded,
  onClick,
}: {
  isExpanded: boolean;
  onClick: () => void;
}) {
  return (
    <div className="flex-none px-3 pb-2 pt-1.5">
      <button
        type="button"
        aria-label="New Super Agent"
        onClick={onClick}
        className={cn(
          'flex h-10 w-full items-center gap-2 overflow-hidden whitespace-nowrap rounded-[10px] bg-gray-950 text-sm font-semibold text-white hover:bg-gray-800',
          'dark:bg-[#f2f2ef] dark:text-[#1f1f1d] dark:hover:bg-[#e4e4df]',
          isExpanded ? 'justify-start px-3.5' : 'justify-center',
        )}
      >
        <Plus className="h-4 w-4 flex-none" />
        {isExpanded && <span>New Super Agent</span>}
      </button>
    </div>
  );
}

export function RoseSearchRow({
  isExpanded,
  value,
  onChange,
}: {
  isExpanded: boolean;
  value: string;
  onChange: (next: string) => void;
}) {
  return (
    <label className={cn(ROW, 'text-[hsl(240_6%_60%)] dark:text-[#a3a39d]')}>
      <Search className="h-[19px] w-[19px] flex-none" strokeWidth={1.7} />
      <input
        type="search"
        aria-label="Search agents"
        placeholder="Search"
        value={value}
        tabIndex={isExpanded ? 0 : -1}
        onChange={(e) => onChange(e.target.value)}
        className={cn(
          'min-w-0 flex-1 bg-transparent text-[hsl(240_15%_8%)] dark:text-[#ecece8] outline-none placeholder:text-[hsl(240_6%_60%)] dark:placeholder:text-[#a3a39d] transition-opacity duration-200',
          isExpanded ? 'opacity-100' : 'opacity-0',
        )}
      />
    </label>
  );
}

export function RoseNavRow({
  icon,
  label,
  isExpanded,
  isActive = false,
  onClick,
}: {
  icon: ReactNode;
  label: string;
  isExpanded: boolean;
  isActive?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={isActive}
      onClick={onClick}
      className={cn(
        ROW,
        isActive
          ? 'font-semibold'
          : 'text-[hsl(240_8%_40%)] dark:text-[#a3a39d] hover:text-[hsl(240_15%_8%)] dark:hover:text-[#ecece8]',
      )}
      style={isActive ? { color: ROSE_ACTIVE_COLOR } : undefined}
    >
      <span className="grid h-5 w-5 flex-none place-items-center">{icon}</span>
      <Label isExpanded={isExpanded}>{label}</Label>
    </button>
  );
}

export function RoseAccountRow({
  user,
  isExpanded,
  isActive,
  onOpenSettings,
  onLoginClick,
}: {
  user: User | null;
  isExpanded: boolean;
  isActive: boolean;
  onOpenSettings: () => void;
  onLoginClick: () => void;
}) {
  // No session at all: the row signs in. A session (anonymous or not) opens Settings.
  const signedIn = user !== null && user.is_anonymous !== true;
  const label = user === null ? 'Sign in' : signedIn ? accountDisplayName(user) : 'Guest';
  return (
    <RoseNavRow
      icon={<AccountGlyph user={signedIn ? user : null} />}
      label={label}
      isExpanded={isExpanded}
      isActive={isActive}
      onClick={user === null ? onLoginClick : onOpenSettings}
    />
  );
}
