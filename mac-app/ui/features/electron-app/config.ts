/**
 * Configuration constants for the electron-app shell.
 *
 * Config layer: imports own types only. Holds feature flags and env reads.
 */

/**
 * Backend API base URL for user-settings and onboarding-complete calls.
 *
 * Resolved at build time from `VITE_BACKEND_API_URL`; defaults to localhost so
 * local dev runs against the Node backend on :3001.
 */
export const BACKEND_URL: string =
  (import.meta.env.VITE_BACKEND_API_URL as string | undefined) ?? 'http://localhost:3001';

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
