/**
 * Shared auth-cookie name heuristics used by Steel injection and integrations
 * discovery. Lives in providers/ so providers never import domains/.
 */

// Auth cookie name patterns that indicate a logged-in session
export const AUTH_COOKIE_PATTERNS = [
  'session',
  'sess',
  'auth',
  'token',
  'login',
  'logged',
  'user',
  'usr',
  'sso',
  'jwt',
  'bearer',
  'access',
  'refresh',
  'credential',
  'identity',
  'account',
  'member',
  'subscriber',
];

// False positive patterns (tracking cookies, not auth)
export const FALSE_POSITIVE_COOKIES = [
  'cf_clearance',
  '_ga',
  '_gid',
  '_gcl',
  '_fbp',
  '_fbc',
  'mp_',
  '_hp5_',
  '_hjSession',
  'OptanonConsent',
  '_pin_unauth',
  'intercom-',
  '__stripe_mid',
  '_rdt_uuid',
  '_tt_enable_cookie',
  '_ttp',
  '_uetvid',
  'hubspotutk',
  '__hstc',
  '__kla_id',
  'ajs_anonymous_id',
  'ph_phc_',
  '_clck',
  '_clsk',
  '_scid',
  '_sctr',
  'FPID',
  'FPAU',
  '_derived_epik',
  '_zitok',
  'receive-cookie-deprecation',
  // Instacart / TikTok / Ahoy visitor markers (not login session)
  'ttcsid',
  'ahoy_visitor',
  'device_uuid',
  'privacy_opt_out',
];

/** True when a cookie name looks like a real auth/session credential. */
export function isAuthCredentialCookieName(name: string): boolean {
  const nameLower = name.toLowerCase();
  if (FALSE_POSITIVE_COOKIES.some((fp) => nameLower.includes(fp.toLowerCase()))) {
    return false;
  }
  return AUTH_COOKIE_PATTERNS.some((pattern) => nameLower.includes(pattern.toLowerCase()));
}
