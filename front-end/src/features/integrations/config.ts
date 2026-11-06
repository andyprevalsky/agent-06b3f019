import type { BrowserType } from '@/features/integration-handlers-context';
import { BACKEND_BASE_URL } from '@/lib/backendUrl';

export const API_BASE_URL = BACKEND_BASE_URL;

export const API_BASE_WITH_PATH = `${API_BASE_URL}/api`;

export const VALID_BROWSER_TYPES: BrowserType[] = [
  'chrome',
  'edge',
  'brave',
  'arc',
  'opera',
  'vivaldi',
  'chromium',
  'atlas',
  'safari',
];

/** How long (ms) to poll for Gmail OAuth completion in Electron. */
export const GMAIL_POLL_TIMEOUT_MS = 120_000;

/** Interval (ms) between Gmail OAuth polls in Electron. */
export const GMAIL_POLL_INTERVAL_MS = 2_000;

// ─── Plaid (consolidated from former features/plaid) ────────────────────────

/**
 * LocalStorage key holding the Plaid `link_token` while the user is mid-flow
 * through an OAuth-bank redirect. The OAuth-return page reads this back and
 * resumes Link with `receivedRedirectUri` so the user does not have to retype
 * credentials.
 */
export const PLAID_OAUTH_LINK_TOKEN_STORAGE_KEY = 'rose:plaid:oauth:link_token';
export const PLAID_OAUTH_CONTEXT_STORAGE_KEY = 'rose:plaid:oauth:context';

/**
 * In-app route that Plaid redirects OAuth banks back to. Must be registered in
 * the Plaid Dashboard (Team Settings → API → Allowed redirect URIs) for the
 * relevant environment.
 */
export const PLAID_OAUTH_REDIRECT_PATH = '/plaid-oauth-redirect';

/**
 * Rose page Granola returns the browser to after sign-in. It posts the code to
 * the backend with the signed-in user's own session (never an unauthenticated
 * callback). The Mac app opens sign-in in the system browser, so it returns to
 * the public site.
 */
export const GRANOLA_CALLBACK_PATH = '/integrations/granola/callback';
export const GRANOLA_RETURN_KEY = 'rose.granola.returnPath';
export const GRANOLA_PUBLIC_ORIGIN = 'https://www.roselabs.ai';

/** The backend redirects here after Google's consent, reopening the desktop app. */
export const DESKTOP_OAUTH_RETURN_URL = 'roselabs://oauth-complete';
