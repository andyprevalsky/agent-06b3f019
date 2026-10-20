/**
 * STATE MACHINE: UserAppsProvider (Rose Desktop Apps, UI ledger rows 10/39)
 *
 * LIST (useUserAppsList): [EMPTY] --GET /apps ok--> [LOADED]; refetched once per
 *   USER_UI_ACTIVE_CHANGED; userId null (flag off / anonymous) → never loaded.
 *
 * VIEW:
 *   [NORMAL] --left-bar app row | trajectory preview card--> [APP OPEN(target)]
 *   [APP OPEN] --another app / card--> [APP OPEN(other)]
 *   [APP OPEN] --Escape | agent row | Home | New Super Agent | + New app--> [NORMAL]
 *   [APP OPEN] --userId changes--> [NORMAL]
 *   [APP OPEN(app)] --the app leaves the list (restore to a version without it)-->
 *     the view resolves to nothing, so the chat shows again
 *
 * The open view replaces the chat column (AgentChatArea renders UserAppScreen);
 * selection, realtime and composer state of the chat are untouched.
 */
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';

import { UserAppsContext, type AppTarget, type UserAppsValue } from './userAppsState';
import { useUserAppsList } from './useUserAppsList';

interface UserAppsProviderProps {
  /** Signed-in Rose Desktop user (null: flag off, anonymous, archive → no Apps). */
  userId: string | null;
  children: ReactNode;
}

function useEscapeToClose(open: boolean, close: () => void) {
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !event.defaultPrevented) close();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, close]);
}

export function UserAppsProvider({ userId, children }: UserAppsProviderProps) {
  const list = useUserAppsList(userId);
  const [target, setTarget] = useState<AppTarget | null>(null);
  const closeApp = useCallback(() => setTarget(null), []);
  const openApp = useCallback((next: AppTarget) => setTarget(next), []);

  useEffect(() => setTarget(null), [userId]);
  useEscapeToClose(target !== null, closeApp);

  const value = useMemo<UserAppsValue>(
    () => ({ ...list, target, openApp, closeApp }),
    [list, target, openApp, closeApp],
  );
  return <UserAppsContext.Provider value={value}>{children}</UserAppsContext.Provider>;
}
