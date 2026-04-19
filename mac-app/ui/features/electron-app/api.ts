/**
 * Data access for the electron-app shell.
 *
 * Two surfaces:
 *   1. Backend HTTP — GET /api/user-settings, POST /api/auth/complete-onboarding.
 *   2. Electron IPC — window.api.onboarding.setComplete / window.api.shortcut.enable.
 *
 * This file is the SOLE consumer of `fetch` and `window.api.*` within the
 * feature. Components/hooks must route all IO through here so the blackbox
 * MSW + IPC-mock harness can drive the same seams in tests.
 *
 * No UI rendering, no business logic beyond "get bytes in / get bytes out".
 */

import { getSession } from '@/lib/supabase';
import { BACKEND_URL } from './config';
import type { UserSettingsResponse } from './types';

/**
 * Mirror completed-onboarding state into the Electron main process.
 *
 * Persists the flag in electron-store and enables the global OS shortcut that
 * launches the Quick Query window. Idempotent — safe to call multiple times.
 */
export const syncElectronOnboardingComplete = async (): Promise<void> => {
  if (window.api?.onboarding?.setComplete !== undefined) {
    await window.api.onboarding.setComplete(true);
  }
  if (window.api?.shortcut?.enable !== undefined) {
    await window.api.shortcut.enable();
  }
};

/**
 * Fetch the onboarding-complete flag for the current user from the backend.
 *
 * Returns `false` when there is no session token or the request fails (both
 * cases mean "show onboarding"); returns the parsed boolean otherwise.
 * Never throws — callers get a trinary (true/false/null) style result where
 * `null` is reserved for "not yet checked" at the caller level.
 */
export const fetchOnboardingComplete = async (): Promise<boolean | null> => {
  const session = getSession();
  if (session?.access_token === undefined || session.access_token === '') {
    console.log('[ElectronApp] No session token, showing onboarding');
    return false;
  }

  console.log('[ElectronApp] Fetching onboarding status from backend...');
  const response = await fetch(`${BACKEND_URL}/api/user-settings`, {
    headers: {
      Authorization: `Bearer ${session.access_token}`,
    },
  });

  if (!response.ok) {
    console.error('[ElectronApp] Failed to fetch user-settings:', response.status);
    return false;
  }

  const data = (await response.json()) as UserSettingsResponse;
  const complete = data.onboardingCompletedAt !== null && data.onboardingCompletedAt !== undefined;
  console.log('[ElectronApp] Onboarding status from backend:', {
    onboardingCompletedAt: data.onboardingCompletedAt,
    complete,
  });
  return complete;
};

/**
 * Best-effort POST to mark the user's onboarding as complete on the backend.
 *
 * No-ops when there is no session token. Swallowed failures are logged but do
 * not throw — the local electron-side sync is the source of truth for the
 * next render cycle, so a transient backend error should not block the UX.
 */
export const markOnboardingCompleteOnBackend = async (): Promise<void> => {
  const session = getSession();
  console.log('[ElectronApp] Session for onboarding complete:', {
    hasSession: session !== null && session !== undefined,
    hasToken: session?.access_token !== undefined && session.access_token !== '',
  });
  if (session?.access_token === undefined || session.access_token === '') return;

  const response = await fetch(`${BACKEND_URL}/api/auth/complete-onboarding`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${session.access_token}`,
      'Content-Type': 'application/json',
    },
  });
  const data = (await response.json()) as unknown;
  console.log('[ElectronApp] Backend complete-onboarding response:', {
    status: response.status,
    data,
  });
};
