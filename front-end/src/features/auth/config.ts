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

/** Dev auto-login credential pair. Defaults to the local developer test account. */
export const DEV_AUTO_LOGIN_PHONE = import.meta.env.VITE_DEV_AUTO_LOGIN_PHONE ?? '+19729777432';
export const DEV_AUTO_LOGIN_OTP = import.meta.env.VITE_DEV_AUTO_LOGIN_OTP ?? '181818';

/** Whether the auth feature should auto-login with dev credentials on boot. */
export function shouldEnableDevAutoLogin({
  isDev,
  isVitest,
  clientSource,
  optedOut = false,
}: {
  readonly isDev: boolean;
  readonly isVitest: boolean;
  readonly clientSource: ClientSource;
  /** `?no-auto-login` opt-out — lets e2e specs exercise the manual login path deterministically. */
  readonly optedOut?: boolean;
}): boolean {
  return isDev && !isVitest && clientSource !== 'MAC_APP' && !optedOut;
}

export const IS_DEV_AUTO_LOGIN = shouldEnableDevAutoLogin({
  isDev: import.meta.env.DEV,
  isVitest: Boolean(import.meta.env.VITEST),
  clientSource: getClientSource(),
  optedOut:
    typeof window !== 'undefined' &&
    new URLSearchParams(window.location.search).has('no-auto-login'),
});
