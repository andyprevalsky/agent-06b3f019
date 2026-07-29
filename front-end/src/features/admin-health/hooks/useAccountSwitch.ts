/**
 * STATE MACHINE: useAccountSwitch
 *
 *   [IDLE] --switchTo(userId)--> [SWITCHING(userId)]
 *   [SWITCHING] --ok--> the page reloads as the target account (terminal)
 *   [SWITCHING] --err--> [IDLE, switchError]  (the session is left untouched)
 *
 * The switch itself lives in lib/adminUsers so the Users page and the always-on
 * account switcher share one implementation without importing each other.
 */

import { useCallback, useState } from 'react';

import { switchToAccount } from '@/lib/adminUsers';

export function useAccountSwitch() {
  const [switchingUserId, setSwitchingUserId] = useState<string | null>(null);
  const [switchError, setSwitchError] = useState<string | null>(null);

  const switchTo = useCallback(async (userId: string) => {
    setSwitchingUserId(userId);
    setSwitchError(null);
    try {
      await switchToAccount(userId);
    } catch (error: unknown) {
      setSwitchingUserId(null);
      setSwitchError(error instanceof Error ? error.message : String(error));
    }
  }, []);

  return { switchTo, switchingUserId, switchError };
}
