import { useCallback } from 'react';

/** Header, sidebar and app menus retain the action without its full agent slice. */
export function useTerminalLogoutAction(logout: () => Promise<void>) {
  return useCallback(() => {
    void logout();
  }, [logout]);
}
