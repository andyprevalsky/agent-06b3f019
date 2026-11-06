/**
 * Presentational rows for the Rose Desktop left bar (UI ledger rows 17/29/30/63):
 * account row: signed in = cursive initial + name (Rose profile name first, see
 * accountDisplayName; member icon while the profile loads), anonymous = member
 * icon (both open Settings); no session = member icon labelled "Sign in" (opens login).
 * the top row (Back ← while expanded | Search; Andy 2026-10-28 replaced the Home
 * row and the black "New Super Agent" button with the Home project's "+"; the
 * mobile drawer keeps that button: #f2f2ef fill / #1f1f1d label in dark),
 * plain nav rows (Archived, Browse, Health) and the account row. Stateless.
 *
 * Mac app (Electron, hiddenInset title bar): RoseMacTitleBarInset adds a
 * draggable strip above the top row so Back | Search clears the traffic lights
 * (Andy 2026-11-06); the web layout has no strip.
 *
 * Every row keeps its icon at the same x whether the bar is collapsed (64px)
 * or hover-expanded (236px); labels fade in. Active = color/weight, no fills.
 */

import type { User } from '@supabase/supabase-js';
import { ArrowLeft, Plus, Search } from 'lucide-react';
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

/** The mobile drawer's raw black New Super Agent button (the desktop bar uses Home's "+"). */
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

/** The Mac app's hiddenInset title bar: traffic lights sit in the window's top ~28px. */
function isMacAppWindow(): boolean {
  return typeof window !== 'undefined' && window.api?.isElectron === true;
}

/**
 * Mac app only: a draggable strip (the window's title-bar area) above the top
 * row, so Back | Search sit below the traffic lights instead of touching them.
 */
export function RoseMacTitleBarInset() {
  if (!isMacAppWindow()) return null;
  return (
    <div
      aria-hidden="true"
      data-testid="rose-sidebar-titlebar-inset"
      className="h-6 w-full flex-none [-webkit-app-region:drag]"
    />
  );
}

export function RoseSearchRow({
  isExpanded,
  value,
  onChange,
  onBack,
}: {
  isExpanded: boolean;
  value: string;
  onChange: (next: string) => void;
  /** Back (←): collapses the expanded bar; shown left of Search while expanded. */
  onBack?: () => void;
}) {
  const showBack = isExpanded && onBack !== undefined;
  return (
    <div
      data-testid="rose-sidebar-top-row"
      className="flex h-[38px] flex-none items-center [-webkit-app-region:no-drag]"
    >
      {showBack && (
        <button
          type="button"
          aria-label="Back"
          title="Back"
          onClick={onBack}
          data-testid="sidebar-collapse-hint"
          className="flex h-full flex-none items-center pl-[22px] pr-1 text-[hsl(240_8%_40%)] dark:text-[#a3a39d] hover:text-[hsl(240_15%_8%)] dark:hover:text-[#ecece8]"
        >
          <ArrowLeft className="h-5 w-5" strokeWidth={1.7} />
        </button>
      )}
      <label
        className={cn(
          ROW,
          'min-w-0 flex-1 text-[hsl(240_6%_60%)] dark:text-[#a3a39d]',
          showBack && 'pl-3',
        )}
      >
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
    </div>
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
  profileName = null,
  profileLoading = false,
  isExpanded,
  isActive,
  onOpenSettings,
  onLoginClick,
}: {
  user: User | null;
  /** The Rose profile name (backend User row); preferred over auth metadata. */
  profileName?: string | null;
  profileLoading?: boolean;
  isExpanded: boolean;
  isActive: boolean;
  onOpenSettings: () => void;
  onLoginClick: () => void;
}) {
  // No session at all: the row signs in. A session (anonymous or not) opens Settings.
  const signedIn = user !== null && user.is_anonymous !== true;
  const label =
    user === null ? 'Sign in' : signedIn ? accountDisplayName(user, profileName) : 'Guest';
  return (
    <RoseNavRow
      icon={
        <AccountGlyph
          user={signedIn ? user : null}
          profileName={profileName}
          loading={profileLoading}
        />
      }
      label={label}
      isExpanded={isExpanded}
      isActive={isActive}
      onClick={user === null ? onLoginClick : onOpenSettings}
    />
  );
}
