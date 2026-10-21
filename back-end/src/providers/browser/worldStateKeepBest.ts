/**
 * Keep-best: how the user's one browser template (plan row A6) resolves a
 * collision. Pure, so the rule is stated, implemented and tested in one place.
 *
 * ACCOUNTS. The template keeps several accounts per site, the way the cookie
 * system already does: one account per CookieBundle (browserSource,
 * browserProfile), as each synced Chrome profile is its own account. A template
 * account is the bundle (`rose_root`, <account>). A task's state for a site
 * belongs to the account its injected bundle came from (`templateAccountFor`:
 * `chrome:Profile 1` for that synced profile, a template account keeps its own
 * key); with nothing injected, to the template account whose login the jar
 * already holds; otherwise to '' (the Rose browser's own account). Different
 * accounts never compete; keep-best only resolves two states of ONE account.
 *
 * DEFINITIONS, for the closing task's state I and the template's state T of
 * one (site, account), evaluated at the close's time `now` under the site lock:
 *   auth cookie   a non-empty cookie of the site whose name looks like a
 *                 credential (isAuthCredentialCookieName)
 *   VALID         holds an auth cookie unexpired at `now` (a session cookie
 *                 counts as unexpired); EXPIRED: holds auth cookies, none
 *                 unexpired; EMPTY: holds none
 *   fp(X)         fingerprint of X's unexpired auth cookies (domain, name,
 *                 path, value; expiry ignored)
 *   expiry(X)     latest finite expiry among those cookies; none if session-only
 *   validated(X)  T: when its login was last validated. I: `now` when the task
 *                 has sign-in evidence for the site (the agent typed a saved
 *                 password or asserted a passkey there, or the user completed a
 *                 live-view sign-in on this task); else T's time when
 *                 fp(I) = fp(T) (the same login); else none
 *   age(X)        T: the age recorded with its login. I: `now` with evidence or
 *                 when the site's login changed during the task; the injected
 *                 login's age when the task kept what it was given; else the
 *                 task's start
 *   LOGGED_OUT(I) no evidence, and I lacks an auth cookie key (domain, name,
 *                 path) that the task's fork started with, or that a VALID T holds
 *
 * RULES, first match wins:
 *   1. I EMPTY                               keep T   no_login
 *   2. I EXPIRED                             keep T   expired
 *   3. LOGGED_OUT(I)                         keep T   signed_out
 *   4. no evidence, fp(I) in T's superseded  keep T   superseded (a login this
 *      account already replaced, or that the user forgot)
 *   5. fp(I) = fp(T), expiry(I) <= expiry(T) keep T   unchanged (evidence only
 *      refreshes validated(T))
 *   6. T not VALID                           take I   rule template_invalid
 *   7. validated(I) != validated(T)          later wins, none is earliest   rule validated
 *   8. expiry(I) != expiry(T)                later wins, none is earliest   rule later_expiry
 *   9. otherwise                             newer age wins; an exact tie keeps T   rule newer
 *
 * So a valid login is never replaced by an expired, empty or logged-out one
 * (1-3), an unchanged stale copy never undoes a newer login (4), and ties go to
 * the newer state (9). Taking I rewrites that account's cookies, bumps its
 * revision once and records T's and the fork's base logins as superseded.
 * Keeping T writes nothing (bar rule 5's validation refresh), so a retried
 * close reaches the same decision without writing.
 */
import { createHash } from 'node:crypto';
import { isAuthCredentialCookieName } from '../authCookies';
import { authRealmFromCookieDomain } from '../authRealm';

export const ROOT_BROWSER_SOURCE = 'rose_root';
/** The Rose browser's own template account. */
export const DEFAULT_TEMPLATE_ACCOUNT = '';
const MAX_AUTH_KEYS_PER_SITE = 64;
const MAX_SUPERSEDED = 16;

export interface WorldStateCookie {
  name: string;
  value: string;
  domain: string;
  path?: string;
  expires?: number;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: 'Strict' | 'Lax' | 'None';
}

/** The one CookieBundle (account) injection chose for a realm. */
export interface InjectedCookieBundle {
  browserSource: string;
  browserProfile: string;
  freshestCookieUtc: bigint | null;
}

export type KeepBestRule = 'template_invalid' | 'validated' | 'later_expiry' | 'newer';
export type KeptOutcome =
  'unchanged' | 'kept' | 'no_login' | 'expired' | 'signed_out' | 'superseded';
export type KeepBestDecision =
  | { take: 'incoming'; rule: KeepBestRule }
  | { take: 'template'; outcome: KeptOutcome; rule: KeepBestRule | null };

export interface SiteCredentialState {
  status: 'valid' | 'expired' | 'empty';
  /** fp(X); '' unless VALID. */
  fingerprint: string;
  /** (domain, name, path) keys of the unexpired auth cookies. */
  keys: string[];
  /** expiry(X) in unix seconds; null when session-only or not VALID. */
  expiresAt: number | null;
}

export interface KeepBestInput {
  incoming: SiteCredentialState;
  template: SiteCredentialState;
  hasEvidence: boolean;
  /** Auth keys the task's fork started with; [] when unforked. */
  forkBaseKeys: string[];
  supersededFingerprints: string[];
  templateValidatedAtMs: number | null;
  templateAgeMs: number | null;
  incomingAgeMs: number;
  nowMs: number;
}

function cookieIsLive(expires: number | undefined, nowEpochSeconds: number): boolean {
  if (expires === undefined || !Number.isFinite(expires) || expires <= 0) return true;
  return expires > nowEpochSeconds;
}

function hasFiniteExpiry(expires: number | undefined): expires is number {
  return expires !== undefined && Number.isFinite(expires) && expires > 0;
}

export function siteCookies<T extends Pick<WorldStateCookie, 'name' | 'domain'>>(
  cookies: T[],
  site: string
): T[] {
  return cookies.filter(
    (cookie) => cookie.name !== '' && authRealmFromCookieDomain(cookie.domain) === site
  );
}

function authKey(cookie: WorldStateCookie): string {
  return `${cookie.domain.toLowerCase()}|${cookie.name}|${cookie.path ?? '/'}`;
}

/** Classify one site's credentials in a jar (definitions above). */
export function assessSiteCredentials(
  cookies: WorldStateCookie[],
  site: string,
  nowEpochSeconds: number = Math.floor(Date.now() / 1000)
): SiteCredentialState {
  const auth = siteCookies(cookies, site).filter(
    (cookie) => cookie.value !== '' && isAuthCredentialCookieName(cookie.name)
  );
  const live = auth.filter((cookie) => cookieIsLive(cookie.expires, nowEpochSeconds));
  if (live.length === 0) {
    return {
      status: auth.length === 0 ? 'empty' : 'expired',
      fingerprint: '',
      keys: [],
      expiresAt: null,
    };
  }
  const pairs = live
    .map((cookie) => [authKey(cookie), cookie.value] as const)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const finite = live.map((cookie) => cookie.expires).filter(hasFiniteExpiry);
  return {
    status: 'valid',
    fingerprint: createHash('sha256').update(JSON.stringify(pairs)).digest('hex'),
    keys: [...new Set(pairs.map(([key]) => key))].slice(0, MAX_AUTH_KEYS_PER_SITE),
    expiresAt: finite.length === 0 ? null : Math.floor(Math.max(...finite)),
  };
}

/** Fingerprint + key set of one site's live auth cookies; '' when signed out. */
export function siteAuthSnapshot(
  cookies: WorldStateCookie[],
  site: string,
  nowEpochSeconds?: number
): { fingerprint: string; keys: string[] } {
  const state = assessSiteCredentials(cookies, site, nowEpochSeconds);
  return { fingerprint: state.fingerprint, keys: state.keys };
}

/** The template account a bundle's login belongs to (see ACCOUNTS above). */
export function templateAccountFor(
  bundle: { browserSource: string; browserProfile: string } | null
): string {
  if (bundle === null) return DEFAULT_TEMPLATE_ACCOUNT;
  if (bundle.browserSource === ROOT_BROWSER_SOURCE) return bundle.browserProfile;
  return `${bundle.browserSource}:${bundle.browserProfile}`;
}

/** null is the earliest; returns >0 when a is later. */
function compareLater(a: number | null, b: number | null): number {
  if (a === b) return 0;
  if (a === null) return -1;
  if (b === null) return 1;
  return a - b;
}

/** True when expiry `a` is strictly later than `b` (none is earliest). */
export function expiryIsLater(a: number | null, b: number | null): boolean {
  return compareLater(a, b) > 0;
}

/** validated(I) from the definitions above. */
export function incomingValidatedAtMs(input: KeepBestInput): number | null {
  if (input.hasEvidence) return input.nowMs;
  const sameLogin =
    input.incoming.fingerprint !== '' && input.incoming.fingerprint === input.template.fingerprint;
  return sameLogin ? input.templateValidatedAtMs : null;
}

function loggedOut(input: KeepBestInput): boolean {
  if (input.hasEvidence) return false;
  const current = new Set(input.incoming.keys);
  const lost = (keys: string[]) => keys.some((key) => !current.has(key));
  return (
    lost(input.forkBaseKeys) || (input.template.status === 'valid' && lost(input.template.keys))
  );
}

/** Apply rules 1-9 above. */
export function decideKeepBest(input: KeepBestInput): KeepBestDecision {
  const { incoming, template } = input;
  if (incoming.status === 'empty') return { take: 'template', outcome: 'no_login', rule: null };
  if (incoming.status === 'expired') return { take: 'template', outcome: 'expired', rule: null };
  if (loggedOut(input)) return { take: 'template', outcome: 'signed_out', rule: null };
  if (!input.hasEvidence && input.supersededFingerprints.includes(incoming.fingerprint)) {
    return { take: 'template', outcome: 'superseded', rule: null };
  }
  if (
    incoming.fingerprint === template.fingerprint &&
    !expiryIsLater(incoming.expiresAt, template.expiresAt)
  ) {
    return { take: 'template', outcome: 'unchanged', rule: null };
  }
  if (template.status !== 'valid') return { take: 'incoming', rule: 'template_invalid' };
  const validated = compareLater(incomingValidatedAtMs(input), input.templateValidatedAtMs);
  if (validated !== 0) {
    return validated > 0
      ? { take: 'incoming', rule: 'validated' }
      : { take: 'template', outcome: 'kept', rule: 'validated' };
  }
  const expiry = compareLater(incoming.expiresAt, template.expiresAt);
  if (expiry !== 0) {
    return expiry > 0
      ? { take: 'incoming', rule: 'later_expiry' }
      : { take: 'template', outcome: 'kept', rule: 'later_expiry' };
  }
  return compareLater(input.incomingAgeMs, input.templateAgeMs) > 0
    ? { take: 'incoming', rule: 'newer' }
    : { take: 'template', outcome: 'kept', rule: 'newer' };
}

/** Superseded logins after replacing an account's login with `current`. */
export function nextSuperseded(previous: string[], retired: string[], current: string): string[] {
  return [...new Set([...retired, ...previous])]
    .filter((fingerprint) => fingerprint !== '' && fingerprint !== current)
    .slice(0, MAX_SUPERSEDED);
}

/** Verified credential heads are owned exclusively by an authenticated proof writer. */
export function assertLegacyBrowserAccount(account: string): void {
  if (account.startsWith('verified:'))
    throw new Error('Verified browser credentials require authenticated account proof');
}
