/** The fixture serves sign-in pages and seeds credentials, so it never runs in production. */
export function authTestSiteEnabled(): boolean {
  return process.env.NODE_ENV !== 'production';
}

/** Fixture management (seed/report/delete) is limited to internal API-key callers. */
export function fixtureApiKey(): string {
  return process.env.BACKEND_API_KEY?.trim() ?? '';
}

export const AUTH_TEST_SITE_BASE_PATH = '/api/test-sites/larkspur';
export const AUTH_TEST_SITE_NAME = 'Larkspur Members';

/** Bounds the in-memory site table; the oldest site is evicted past this. */
export const MAX_ACTIVE_SITES = 200;
export const SITE_TTL_MS = 6 * 60 * 60 * 1000;
export const SIGN_IN_CODE_TTL_MS = 10 * 60 * 1000;
export const SESSION_COOKIE_NAME = 'larkspur_session';

export const SIGN_IN_EMAIL_SENDER_LOCAL_PART = 'larkspur-members';
export const SAVED_PASSWORD_BROWSER_SOURCE = 'auth-test-site';
