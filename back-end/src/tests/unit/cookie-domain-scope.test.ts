#!/usr/bin/env tsx

// RCA #5 (ecommerce slice): the benchmark browser-credential live fixture ran a
// FULL ~22k-cookie sync inside a 420s cap — on a warm-restored box (which skips
// run.sh's boot cred sync) it always timed out ("Live fixture could not refresh
// complete browser auth state"), failing every logged-in browser task. The fix
// scopes the cookie read to just the domains a task declares
// (environment.live_cookie_domains → SEED_COOKIE_DOMAINS), shrinking the read
// ~130× (measured: doordash 165 / amazon 76 / opentable 36 of 22064). This pins
// the filter so the scoping — and its suffix-safety — can't silently regress.

import assert from 'node:assert/strict';

import { parseCookieDomains, cookieSyncWhere } from '../../../scripts/cookie-domain-scope';

function test(name: string, fn: () => void): void {
  try {
    fn();
    process.stdout.write(`  ✅ ${name}\n`);
  } catch (error) {
    process.stderr.write(`  ❌ ${name}\n`);
    throw error;
  }
}

test('parseCookieDomains splits, trims, lowercases, and drops blanks', () => {
  assert.deepEqual(parseCookieDomains(' DoorDash.com , amazon.com ,, '), [
    'doordash.com',
    'amazon.com',
  ]);
});

test('parseCookieDomains treats undefined/empty as no scope', () => {
  assert.deepEqual(parseCookieDomains(undefined), []);
  assert.deepEqual(parseCookieDomains(''), []);
  assert.deepEqual(parseCookieDomains('   '), []);
});

test('no domains → full account scope (userId only), so the fallback is a full sync', () => {
  assert.deepEqual(cookieSyncWhere('u1', []), { userId: 'u1' });
});

test('a domain matches host-only, domain, and subdomain cookies', () => {
  const where = cookieSyncWhere('u1', ['doordash.com']);
  assert.equal(where.userId, 'u1');
  assert.deepEqual(where.OR, [
    { domain: 'doordash.com' }, // host-only cookie
    { domain: '.doordash.com' }, // domain cookie
    { domain: { endsWith: '.doordash.com' } }, // www.doordash.com, api.doordash.com, …
  ]);
});

test('suffix clause requires a leading dot so a look-alike domain cannot match', () => {
  // The subdomain clause is endsWith ".doordash.com", NOT "doordash.com", so
  // "evil-doordash.com" is excluded — only true subdomains slip through.
  const clause = (cookieSyncWhere('u1', ['doordash.com']).OR as Array<Record<string, unknown>>)[2];
  assert.deepEqual(clause, { domain: { endsWith: '.doordash.com' } });
  assert.equal('evil-doordash.com'.endsWith('.doordash.com'), false);
  assert.equal('www.doordash.com'.endsWith('.doordash.com'), true);
});

test('multiple domains produce three clauses each', () => {
  const where = cookieSyncWhere('u1', ['amazon.com', 'uber.com']);
  assert.equal((where.OR as unknown[]).length, 6);
});

process.stdout.write('cookie-domain-scope: all tests passed\n');
