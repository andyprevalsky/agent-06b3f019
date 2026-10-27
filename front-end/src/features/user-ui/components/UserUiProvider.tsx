/**
 * STATE MACHINE: UserUiProvider
 *
 *   [LOGGED_OUT] userId null → stock UI, no request
 *   [LOADING]    userId set  → GET /api/user-ui/active
 *   [STOCK]      versionId null / load failed → stock UI
 *   [ACTIVE]     manifest loaded → shell (if published) and the active version
 *                (inline views pinned to it resolve without /versions) exposed
 *                through UserUiContext
 *   [SAFE]       ?rose_safe=1 | Cmd/Ctrl+Shift+. | SafeModeControl →
 *                shell and live inline frames off (inline views fall back to
 *                poster/summary); persisted per tab
 *
 *   [ACTIVE] <--toggle--> [SAFE]
 *   window focus (and DEV ?rose_ui_live=1 every 5s) → refetch active version
 *   LIVE REFRESH (Rose Desktop flag only):
 *     open agent new message / status change, a sub-agent of its shown tree
 *     changing state, USER_UI_ACTIVE_CHANGED, refreshActiveUserUi(),
 *     `user_ui.published`
 *       → [REFRESH PENDING] one GET per 750ms window (deduped, cancelled on
 *         unmount; reuses the chat's agent:<id> / bus channels, opens none)
 *       → newer versionId → [ACTIVE vN+1] in place (no remount, no reload)
 *
 * WHOLE-APP SETTINGS REMOVED (UI ledger row 89): theme.json tokens, the
 * background image + fade and the named slots are never fetched or rendered;
 * a manifest that still names `theme` or `slots` is treated as stock UI for
 * those parts (the fields are ignored, no request, no error).
 *
 * SafeModeControl is host DOM above every user frame, so a shell cannot hide it.
 */
import { useMemo, useRef, type ReactNode } from 'react';

import { useRoseDesktop } from '@/hooks/roseDesktopContext';

import { joinUserContentUrl } from '../config';
import {
  InlineLiveCapStore,
  useActiveUserUi,
  UserUiContext,
  useSafeMode,
  type UserUiContextValue,
} from '../hooks';
import { SafeModeControl } from './SafeModeControl';

interface UserUiProviderProps {
  /** Logged-in (non-anonymous) user id; null keeps the stock UI. */
  userId: string | null;
  children: ReactNode;
}

export function UserUiProvider({ userId, children }: UserUiProviderProps) {
  const liveRefresh = useRoseDesktop();
  const active = useActiveUserUi(userId, { liveRefresh });
  const [safeMode, setSafeMode] = useSafeMode();
  const liveCapRef = useRef<InlineLiveCapStore | null>(null);
  if (liveCapRef.current === null) liveCapRef.current = new InlineLiveCapStore();
  const liveCap = liveCapRef.current;

  const value = useMemo<UserUiContextValue>(() => {
    const shellEntry = active !== null && !safeMode ? active.manifest.shell?.entry : undefined;
    return {
      active,
      safeMode,
      setSafeMode,
      shellUrl: active && shellEntry ? joinUserContentUrl(active.baseUrl, shellEntry) : null,
      liveCap,
    };
  }, [active, safeMode, setSafeMode, liveCap]);

  return (
    <UserUiContext.Provider value={value}>
      {children}
      <SafeModeControl />
    </UserUiContext.Provider>
  );
}
