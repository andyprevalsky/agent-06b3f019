/**
 * API boundary for the agent-pay-modal feature. Sole consumer of the
 * `${VITE_BACKEND_API_URL}/api/user-settings` endpoint inside this feature.
 * Hooks/components never call `fetch()` directly.
 *
 * Auth: we receive the bearer token as a parameter rather than reading it
 * here — `getSession()` is a synchronous call the hook layer makes at the
 * exact moment of the request (so a stale token inside a React closure
 * can't leak through).
 */

import { SAVE_FAILURE_MESSAGE } from './config';
import type { UserSettingsPatchBody, UserSettingsResponse } from './types';

export function resolveBackendUrl(rawUrl: string | undefined, isProd: boolean): string {
  const url = rawUrl?.trim();
  if (url !== undefined && url !== '') return url;
  if (isProd) {
    throw new Error('Missing VITE_BACKEND_API_URL for packaged Mac app');
  }
  return 'http://localhost:3001';
}

const BACKEND_URL = (): string =>
  resolveBackendUrl(
    import.meta.env.VITE_BACKEND_API_URL as string | undefined,
    import.meta.env.PROD
  );

/**
 * Fetches the current user-settings payload. Throws when the response is
 * not OK; the hook layer catches and converts that into a silent-recovery
 * no-op (the form stays empty but usable).
 */
export const fetchUserSettings = async (accessToken: string): Promise<UserSettingsResponse> => {
  const response = await fetch(`${BACKEND_URL()}/api/user-settings`, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch user settings: ${response.status}`);
  }

  return (await response.json()) as UserSettingsResponse;
};

/**
 * PATCHes the user-settings record. Throws when the response is not OK;
 * the hook layer surfaces a friendly banner on failure.
 */
export const patchUserSettings = async (
  accessToken: string,
  body: UserSettingsPatchBody
): Promise<void> => {
  const response = await fetch(`${BACKEND_URL()}/api/user-settings`, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    throw new Error(SAVE_FAILURE_MESSAGE);
  }
};
