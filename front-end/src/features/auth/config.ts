/**
 * Auth feature — configuration constants.
 *
 * Env reads, defaults, and magic values live here.
 * May import from own types only.
 */

import { BACKEND_BASE_URL } from '@/lib/backendUrl';
import { getClientSource, type ClientSource } from '@/lib/clientSource';

/** Backend API base URL (no trailing slash). */
export const AUTH_API_BASE_URL = BACKEND_BASE_URL;

/** Whether the auth feature should auto-login with dev credentials on boot. */
export function shouldEnableDevAutoLogin({
  isDev,
  isVitest,
  clientSource,
}: {
  readonly isDev: boolean;
  readonly isVitest: boolean;
  readonly clientSource: ClientSource;
}): boolean {
  return isDev && !isVitest && clientSource !== 'MAC_APP';
}

export const IS_DEV_AUTO_LOGIN = shouldEnableDevAutoLogin({
  isDev: import.meta.env.DEV,
  isVitest: Boolean(import.meta.env.VITEST),
  clientSource: getClientSource(),
});
