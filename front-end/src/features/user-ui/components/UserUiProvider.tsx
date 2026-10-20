/**
 * STATE MACHINE: UserUiProvider
 *
 *   [LOGGED_OUT] userId null → stock UI, no request
 *   [LOADING]    userId set  → GET /api/user-ui/active
 *   [STOCK]      versionId null / load failed → stock UI
 *   [ACTIVE]     manifest loaded → theme tokens on <html>, background image,
 *                slots and shell exposed through UserUiContext
 *   [SAFE]       ?rose_safe=1 | Cmd/Ctrl+Shift+. | SafeModeControl →
 *                theme, background, slots, shell and live inline frames all off
 *                (inline views fall back to poster/summary); persisted per tab
 *
 *   [ACTIVE] <--toggle--> [SAFE]
 *   window focus (and DEV ?rose_ui_live=1 every 5s) → refetch active version
 *   LIVE REFRESH (Rose Desktop flag only):
 *     open agent new message / status change, a sub-agent of its shown tree
 *     changing state, refreshActiveUserUi(), `user_ui.published`
 *       → [REFRESH PENDING] one GET per 750ms window (deduped, cancelled on
 *         unmount; reuses the chat's agent:<id> / bus channels, opens none)
 *       → newer versionId → [ACTIVE vN+1]: theme tokens + background swap in
 *         place (previous theme held until the new theme.json loads); the
 *         app backdrop still stays opaque until the agent's first USER message
 *
 * SafeModeControl is host DOM above every user frame, so a shell cannot hide it.
 */
import { useMemo, useRef, type ReactNode } from 'react';

import { useRoseDesktop } from '@/hooks/roseDesktopContext';

import { joinUserContentUrl, resolveBackground } from '../config';
import {
  InlineLiveCapStore,
  useActiveUserUi,
  UserUiContext,
  useSafeMode,
  useUserUiTheme,
  type UserUiContextValue,
} from '../hooks';
import type { ActiveUserUi, UserUiSlotName } from '../types';
import { SafeModeControl } from './SafeModeControl';

interface UserUiProviderProps {
  /** Logged-in (non-anonymous) user id; null keeps the stock UI. */
  userId: string | null;
  children: ReactNode;
}

function slotUrlFor(active: ActiveUserUi | null, enabled: boolean) {
  return (name: UserUiSlotName): string | null => {
    const entry = enabled ? active?.manifest.slots?.[name]?.entry : undefined;
    return active && entry ? joinUserContentUrl(active.baseUrl, entry) : null;
  };
}

export function UserUiProvider({ userId, children }: UserUiProviderProps) {
  const liveRefresh = useRoseDesktop();
  const active = useActiveUserUi(userId, { liveRefresh });
  const [safeMode, setSafeMode] = useSafeMode();
  const theme = useUserUiTheme(active, safeMode);
  const liveCapRef = useRef<InlineLiveCapStore | null>(null);
  if (liveCapRef.current === null) liveCapRef.current = new InlineLiveCapStore();
  const liveCap = liveCapRef.current;

  const value = useMemo<UserUiContextValue>(() => {
    const enabled = active !== null && !safeMode;
    const shellEntry = enabled ? active.manifest.shell?.entry : undefined;
    const slotUrl = slotUrlFor(active, enabled);
    return {
      active,
      safeMode,
      setSafeMode,
      background: enabled
        ? resolveBackground(
            theme?.theme ?? null,
            theme?.baseUrl ?? active.baseUrl,
            slotUrl('background') !== null,
          )
        : null,
      slotUrl,
      shellUrl: active && shellEntry ? joinUserContentUrl(active.baseUrl, shellEntry) : null,
      liveCap,
    };
  }, [active, safeMode, setSafeMode, theme, liveCap]);

  return (
    <UserUiContext.Provider value={value}>
      {children}
      <SafeModeControl />
    </UserUiContext.Provider>
  );
}
