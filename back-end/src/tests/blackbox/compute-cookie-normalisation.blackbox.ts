#!/usr/bin/env tsx
/**
 * Chrome cookie-acceptance rules.
 *
 * Chrome rejects malformed cookies SILENTLY, so every one of these bugs
 * presented as "the cookies didn't inject" with a success count in the logs.
 * Verbatim cases from the Google sign-in failure: the account chooser listed one
 * account as "Signed out" because its session cookies were all dropped.
 */
import { pickSingleProfile } from '../../domains/compute-grants/repo';
import {
  cookieUrlFor,
  countAccepted,
  normaliseCookieForChrome,
  type CdpCookieInput,
} from '../../domains/compute-grants/cdp';

const tests: Array<{ name: string; fn: () => void }> = [];
const test = (name: string, fn: () => void) => tests.push({ name, fn });
function assert(c: unknown, m: string): asserts c {
  if (!c) throw new Error(m);
}

const base: CdpCookieInput = {
  name: 'x',
  value: 'v',
  domain: '.google.com',
  path: '/foo',
  secure: false,
  httpOnly: false,
};

test('__Host- cookies must be sent with NO domain', () => {
  const out = normaliseCookieForChrome({ ...base, name: '__Host-GAPS' });
  assert(out.domain === '', `__Host- must drop the domain, got "${out.domain}"`);
  assert(out.path === '/', '__Host- requires path=/');
  assert(out.secure, '__Host- requires Secure');
});

test('__Secure- cookies are forced Secure', () => {
  const out = normaliseCookieForChrome({ ...base, name: '__Secure-1PSID' });
  assert(out.secure, '__Secure- requires Secure or Chrome drops it');
  assert(out.domain === '.google.com', '__Secure- keeps its domain (unlike __Host-)');
});

test('SameSite=None implies Secure', () => {
  // Google writes its multi-login cookies SameSite=None; without Secure they are
  // rejected, and without SameSite they default to Lax and are never sent on the
  // cross-site request the account chooser makes.
  const out = normaliseCookieForChrome({ ...base, sameSite: 'None' });
  assert(out.secure, 'SameSite=None requires Secure');
  assert(out.sameSite === 'None', 'SameSite must be preserved, not defaulted to Lax');
});

test('ordinary cookies are passed through untouched', () => {
  const out = normaliseCookieForChrome({ ...base, name: 'ACCOUNT_CHOOSER', secure: true });
  assert(
    out.domain === '.google.com' && out.path === '/foo',
    'plain cookies must not be rewritten'
  );
});

test('REGRESSION: accepted count reflects the browser, not the send', () => {
  const sent: CdpCookieInput[] = [
    { ...base, name: 'kept' },
    { ...base, name: '__Host-dropped' },
  ];
  // Chrome kept one and silently dropped the other.
  const n = countAccepted(sent, [{ name: 'kept', domain: 'google.com' }]);
  assert(n === 1, `expected 1 accepted, got ${n} -- counting sends hides total rejection`);
});

test('REGRESSION: a fully rejected batch reports zero', () => {
  const n = countAccepted(
    [
      { ...base, name: 'a' },
      { ...base, name: 'b' },
    ],
    []
  );
  assert(n === 0, `a rejected batch must report 0, got ${n}`);
});

test('leading-dot domains match their host form', () => {
  const n = countAccepted([{ ...base, name: 'SID' }], [{ name: 'SID', domain: 'google.com' }]);
  assert(n === 1, '.google.com and google.com are the same jar entry');
});

test('REGRESSION: a __Host- cookie still resolves a host via url', () => {
  // __Host- carries NO domain, so without a url Chrome cannot tell which host
  // the cookie belongs to and drops the entire batch. Stripping the domain
  // without supplying a url took the account chooser from one account to zero.
  const c: CdpCookieInput = { ...base, name: '__Host-GAPS', domain: '.google.com', path: '/x' };
  const normalised = normaliseCookieForChrome(c);
  assert(normalised.domain === '', '__Host- must not carry a domain');
  const url = cookieUrlFor(c);
  assert(url === 'https://google.com/x', `url must resolve the host, got ${url}`);
});

test('url is https whenever the cookie requires Secure', () => {
  const url = cookieUrlFor({ ...base, name: '__Secure-1PSID', secure: false });
  assert(url.startsWith('https://'), `Secure cookies need an https url, got ${url}`);
});

test('url strips the leading dot from domain cookies', () => {
  const url = cookieUrlFor({ ...base, domain: '.accounts.google.com', path: '/', secure: true });
  assert(url === 'https://accounts.google.com/', `unexpected url ${url}`);
});

test('REGRESSION: cookies from multiple profiles are never mixed', () => {
  // Each Chrome profile has its OWN Google session. Injecting all of them into
  // one jar means last-write-wins per cookie name, yielding SID from one profile
  // and HSID from another -- which Google rejects as a set, listing accounts but
  // marking every one "Signed out".
  // The empty-profile bucket is BIGGER but incoherent (3 SIDs merged); a smaller
  // coherent profile must still win, else Google marks every account signed out.
  const rows = [
    { name: 'SID', browserSource: 'chrome', browserProfile: '' },
    { name: 'SID', browserSource: 'chrome', browserProfile: '' },
    { name: 'SID', browserSource: 'chrome', browserProfile: '' },
    { name: 'HSID', browserSource: 'chrome', browserProfile: '' },
    { name: 'SID', browserSource: 'chrome', browserProfile: 'Default' },
    { name: 'HSID', browserSource: 'chrome', browserProfile: 'Default' },
  ];
  const { rows: kept, profile } = pickSingleProfile(rows);
  assert(profile === 'chrome::Default', `coherent profile must win, got ${profile}`);
  assert(kept.length === 2, `expected the coherent set, got ${kept.length}`);
  assert(kept.filter((r) => r.name === 'SID').length === 1, 'winner must have exactly one SID');
});

test('picking a profile never invents or drops everything', () => {
  const { rows: kept } = pickSingleProfile([
    { name: 'a', browserSource: 'chrome', browserProfile: 'P' },
  ]);
  assert(kept.length === 1, 'a single-profile input must survive intact');
  assert(pickSingleProfile([]).rows.length === 0, 'empty input stays empty');
});

let passed = 0;
const failures: string[] = [];
console.log('\ncookie normalisation for Chrome acceptance\n');
for (const t of tests) {
  try {
    t.fn();
    passed += 1;
    console.log(`  PASS  ${t.name}`);
  } catch (e) {
    failures.push(t.name);
    console.log(`  FAIL  ${t.name}\n        ${e instanceof Error ? e.message : e}`);
  }
}
console.log(`\nRESULTS: ${passed}/${tests.length} passed`);
if (failures.length > 0) process.exit(1);
