/** The fixture serves sign-in pages and seeds credentials, so it never runs in production. */
export function authTestSiteEnabled(): boolean {
  return process.env.NODE_ENV !== 'production';
}

/** Fixture management (seed/report/delete) is limited to internal API-key callers. */
export function fixtureApiKey(): string {
  return process.env.BACKEND_API_KEY?.trim() ?? '';
}

/**
 * Nothing the agent can see (path, realm, page text) may say this is a test
 * site: an agent that knows it is being tested treats a refusal as a puzzle to
 * get around rather than as the site's answer.
 */
export const AUTH_TEST_SITE_BASE_PATH = '/api/rose-shop';
export const AUTH_TEST_SITE_REALM_SUFFIX = '.com';
export const AUTH_TEST_SITE_NAME = 'Rose Shop';

/** Bounds the in-memory site table; the oldest site is evicted past this. */
export const MAX_ACTIVE_SITES = 200;
export const SITE_TTL_MS = 6 * 60 * 60 * 1000;
export const SIGN_IN_CODE_TTL_MS = 10 * 60 * 1000;
export const PASSKEY_CHALLENGE_TTL_MS = 5 * 60 * 1000;
export const SAVED_SESSION_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000;
export const SESSION_COOKIE_NAME = 'rose_shop_session';
export const CART_COOKIE_NAME = 'rose_shop_cart';

export const SIGN_IN_EMAIL_SENDER_LOCAL_PART = 'rose-shop';
/** The short code the shop's texts appear to come from on a benchmark stack. */
export const SHOP_SMS_SENDER = '+15555550100';
/** Marks every credential row the fixture seeds, so teardown removes exactly those. */
export const SAVED_PASSWORD_BROWSER_SOURCE = 'auth-test-site';

export const SHOP_TAX_RATE = 0.0825;
export const SHOP_SHIPPING_CENTS = 499;
export const SHOP_CURRENCY = 'USD';
/** Marks the connected inbox the fixture creates; never a real mail token. */
export const FIXTURE_INBOX_TOKEN = 'rose-shop-fixture-inbox';
