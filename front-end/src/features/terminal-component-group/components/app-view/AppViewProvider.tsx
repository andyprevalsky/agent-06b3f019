/**
 * STATE MACHINE: AppViewProvider (Rose Desktop full-screen app view, rows 10/39)
 *
 *   [NORMAL] --code-agent chip Open app--> [APP OPEN(task)]
 *   [APP OPEN] --another chip's Open app--> [APP OPEN(other task)]
 *   [APP OPEN] --Escape | agent row | Home | New Super Agent | mobile close--> [NORMAL]
 *   [APP OPEN] --signed-in user changes--> [NORMAL]
 *
 * The open view replaces the chat column (AgentChatArea renders the app view);
 * selection, realtime and composer state of the chat are untouched. Holds no
 * list and reads nothing: opening a view costs only the view's own reads.
 */
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';

import { AppViewContext, type AppViewTarget, type AppViewValue } from './appViewState';

interface AppViewProviderProps {
  /** Signed-in user; a change (sign-out, account switch) closes the view. */
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

export function AppViewProvider({ userId, children }: AppViewProviderProps) {
  const [target, setTarget] = useState<AppViewTarget | null>(null);
  const closeApp = useCallback(() => setTarget(null), []);
  const openApp = useCallback((next: AppViewTarget) => setTarget(next), []);

  useEffect(() => setTarget(null), [userId]);
  useEscapeToClose(target !== null, closeApp);

  const value = useMemo<AppViewValue>(
    () => ({ target, openApp, closeApp }),
    [target, openApp, closeApp],
  );
  return <AppViewContext.Provider value={value}>{children}</AppViewContext.Provider>;
}
