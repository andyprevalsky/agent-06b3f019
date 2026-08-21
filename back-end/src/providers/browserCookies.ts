/**
 * Canonical browser-cookie selection + normalisation.
 *
 * ONE path, reused by every surface that injects the user's cookies into a
 * remote browser: the browser AGENT (providers/steel) and the compute-account
 * CONNECTORS (domains/compute-grants). Before this existed the two diverged --
 * the agent path hardcoded `sameSite: 'Lax'` (silently downgrading every
 * `SameSite=None` SSO cookie so it was never sent cross-site), lacked
 * `__Host-`/url handling, and never de-duplicated across browser profiles. The
 * connector path had all three fixes. Splitting them meant a fix in one never
 * reached the other, so they live here and both import them.
 *
 * The final injection call differs by API (Playwright `addCookies` vs CDP
 * `Network.setCookies`), but the ATTRIBUTE derivation below is identical, so it
 * is the shared part; each caller maps the canonical cookie onto its own API.
 */

/**
 * Identity providers whose cookies ride ALONGSIDE the target realm's.
 *
 * Federated sign-in walls ("Continue with Google") need the IdP's own session
 * cookie, which lives on the IdP domain, not the site being signed into. Always
 * carrying these is what lets an account chooser render instead of a password
 * prompt.
 *
 * NOTE: Google specifically binds sessions to device/IP (DBSC), so a replayed
 * Google session is still rejected in a cloud browser regardless of how cleanly
 * its cookies are injected -- verified empirically. These realms help the
 * non-device-bound providers and keep the target site's own cross-site cookies
 * intact; they are not a claim that Google SSO works headless.
 */
export const SSO_REALMS = [
  'google.com',
  'accounts.google.com',
  'facebook.com',
  'appleid.apple.com',
  'login.microsoftonline.com',
  'live.com',
  'github.com',
];

/** Prisma `where` matchers for one realm: exact, dot-prefixed, and any subdomain. */
export function domainVariants(realm: string): Array<Record<string, unknown>> {
  const normalized = realm.trim().toLowerCase().replace(/^\.+/, '');
  const parent = normalized.startsWith('www.') ? normalized.slice('www.'.length) : normalized;
  const exact = [...new Set([normalized, parent])];
  return [
    ...exact.flatMap((domain) => [{ domain }, { domain: `.${domain}` }]),
    ...exact.map((domain) => ({ domain: { endsWith: `.${domain}` } })),
  ];
}

/**
 * Cookie-selection `where` fragment: the target realm PLUS every SSO realm.
 *
 * Unconditional by design -- the browser agent always gets SSO cookies.
 */
export function cookieSelectionWhere(authRealm: string): { OR: Array<Record<string, unknown>> } {
  return { OR: [...domainVariants(authRealm), ...SSO_REALMS.flatMap(domainVariants)] };
}

/** Chrome's integer SameSite → the string form both Playwright and CDP accept. */
export function chromeSameSiteToString(value: number | null): 'None' | 'Lax' | 'Strict' | undefined {
  if (value === 0) return 'None';
  if (value === 1) return 'Lax';
  if (value === 2) return 'Strict';
  return undefined;
}

export interface CanonicalCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  secure: boolean;
  httpOnly: boolean;
  expires?: number;
  sameSite?: 'None' | 'Lax' | 'Strict';
  sourceScheme?: string;
}

/**
 * The url a cookie belongs to.
 *
 * ALWAYS needed: a `__Host-` cookie carries no domain, so without a url the
 * browser cannot resolve which host it belongs to and silently drops the whole
 * batch. Scheme is https whenever the cookie requires Secure.
 */
export function cookieUrlFor(c: Pick<CanonicalCookie, 'domain' | 'path' | 'secure' | 'name'>): string {
  const host = c.domain.replace(/^\./, '');
  const secure = c.secure || c.name.startsWith('__Host-') || c.name.startsWith('__Secure-');
  return `${secure ? 'https' : 'http'}://${host}${c.path.startsWith('/') ? c.path : '/'}`;
}

/**
 * Apply the cookie-prefix rules Chrome enforces.
 *
 *  - `__Host-` MUST be host-only (no domain), `path=/`, Secure.
 *  - `__Secure-` MUST be Secure.
 *  - `SameSite=None` requires Secure.
 *
 * Sending any of these wrong makes the browser reject the cookie silently.
 */
export function normaliseCookie(c: CanonicalCookie): CanonicalCookie {
  const isHost = c.name.startsWith('__Host-');
  const needsSecure = isHost || c.name.startsWith('__Secure-') || c.sameSite === 'None';
  return {
    ...c,
    secure: needsSecure ? true : c.secure,
    path: isHost ? '/' : c.path,
    domain: isHost ? '' : c.domain,
    sourceScheme: needsSecure ? 'Secure' : c.sourceScheme,
  };
}

/**
 * Keep cookies from exactly ONE coherent browser profile.
 *
 * A user has several browser profiles, each with its own IdP session, and every
 * one stores `SID` / `__Secure-1PSID` / `HSID` for the same domain. Injecting
 * them all into a single jar means last-write-wins per name, yielding `SID` from
 * one profile and `HSID` from another -- a Frankenstein session the IdP lists
 * but marks "Signed out". The winner is a COHERENT profile (each master cookie
 * appears at most once), preferring a real named profile over the sync's
 * catch-all empty-label bucket, then the most complete session.
 */
export function pickCoherentProfile<
  T extends { name: string; browserSource: string | null; browserProfile: string | null },
>(rows: T[]): { rows: T[]; profile: string; total: number } {
  const key = (r: T): string => `${r.browserSource ?? 'unknown'}::${r.browserProfile ?? 'default'}`;
  const groups = new Map<string, T[]>();
  for (const row of rows) {
    const k = key(row);
    const list = groups.get(k);
    if (list === undefined) groups.set(k, [row]);
    else list.push(row);
  }

  const CRITICAL = ['SID', 'HSID', 'SSID', 'SAPISID', '__Secure-1PSID'];
  const isCoherent = (list: T[]): boolean =>
    CRITICAL.every((n) => list.filter((r) => r.name === n).length <= 1);
  const named = (k: string): boolean => !/::(default|)$/i.test(k);

  let best: { k: string; rows: T[]; coherent: boolean } | null = null;
  for (const [k, list] of groups) {
    const coherent = isCoherent(list);
    const better =
      best === null ||
      (coherent && !best.coherent) ||
      (coherent === best.coherent && named(k) && !named(best.k)) ||
      (coherent === best.coherent &&
        named(k) === named(best.k) &&
        list.length > best.rows.length);
    if (better) best = { k, rows: list, coherent };
  }
  return { rows: best?.rows ?? [], profile: best?.k ?? 'none', total: rows.length };
}
