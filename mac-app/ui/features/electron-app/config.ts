/**
 * Configuration constants for the electron-app shell.
 *
 * Config layer: imports own types only. Holds feature flags and env reads.
 */

/**
 * Backend API base URL for user-settings and onboarding-complete calls.
 *
 * Resolved at build time from `VITE_BACKEND_API_URL`. Production builds must
 * provide it so packaged apps cannot silently call a developer localhost.
 */
export function resolveBackendUrl(rawUrl: string | undefined, isProd: boolean): string {
  const url = rawUrl?.trim();
  if (url !== undefined && url !== '') return url;
  if (isProd) {
    throw new Error('Missing VITE_BACKEND_API_URL for packaged Mac app');
  }
  return 'http://localhost:3001';
}

export const BACKEND_URL: string = resolveBackendUrl(
  import.meta.env.VITE_BACKEND_API_URL as string | undefined,
  import.meta.env.PROD
);

/**
 * Dev-only override: when true, always render the Onboarding flow regardless
 * of session/onboarding state. Useful for exercising the UI without resetting
 * the user's backend state. Ship as `false`.
 */
export const FORCE_SHOW_ONBOARDING = false;

/**
 * Dev-only override: when true, skip the auth step of onboarding and drop the
 * user directly into the data/integrations step. Only meaningful alongside
 * `FORCE_SHOW_ONBOARDING`. Ship as `false`.
 */
export const FORCE_SKIP_AUTH = false;
