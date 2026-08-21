#!/usr/bin/env tsx
import assert from 'node:assert/strict';
import {
  chromeExpiryToEpochSeconds,
  cookieDomainsFor,
  seedCookieRows,
  type CdpCookieSink,
} from '../../domains/compute-grants/cookieSeeding';
import type { LocalCookieRow } from '../../domains/compute-grants/repo';

function row(
  name: string,
  profile: string,
  overrides: Partial<LocalCookieRow> = {}
): LocalCookieRow {
  return {
    name,
    value: `${name}-value`,
    domain: '.example.com',
    path: '/',
    isSecure: true,
    isHttpOnly: true,
    expiresUtc: 13_644_473_600_000_000n,
    sameSite: 1,
    browserSource: 'chrome',
    browserProfile: profile,
    ...overrides,
  };
}

async function main(): Promise<void> {
  const domains = cookieDomainsFor(['https://www.claude.ai/login', 'https://claude.ai/settings']);
  assert.equal(domains[0], 'claude.ai');
  assert(domains.includes('accounts.google.com'));
  assert.equal(new Set(domains).size, domains.length);
  assert.equal(chromeExpiryToEpochSeconds(null), undefined);
  assert.equal(chromeExpiryToEpochSeconds(0n), undefined);
  assert.equal(chromeExpiryToEpochSeconds(11_000_000_000_000_000n), undefined);
  assert.equal(chromeExpiryToEpochSeconds(13_644_473_600_000_000n), 2_000_000_000);

  const batches: Array<Array<{ name: string; expires?: number; sameSite?: string }>> = [];
  const batchSink: CdpCookieSink = {
    setCookies: async (cookies) => {
      batches.push(cookies);
      return cookies.length;
    },
    setCookie: async () => {
      throw new Error('single-cookie fallback should not run');
    },
  };
  const rows = [
    row('first', 'Profile A'),
    row('second', 'Profile A', { expiresUtc: null, sameSite: 0 }),
    row('discarded', 'Profile B'),
  ];
  assert.equal(await seedCookieRows(batchSink, 'user-1', 'claude', domains, rows), 2);
  assert.deepEqual(
    batches[0]?.map((cookie) => cookie.name),
    ['first', 'second']
  );
  assert.equal(batches[0]?.[0]?.expires, 2_000_000_000);
  assert.equal(batches[0]?.[0]?.sameSite, 'Lax');
  assert.equal(batches[0]?.[1]?.expires, undefined);
  assert.equal(batches[0]?.[1]?.sameSite, 'None');

  const attempted: string[] = [];
  const fallbackSink: CdpCookieSink = {
    setCookies: async () => {
      throw new Error('one malformed cookie');
    },
    setCookie: async (cookie) => {
      attempted.push(cookie.name);
      if (cookie.name === 'second') throw new Error('still malformed');
      return 1;
    },
  };
  assert.equal(await seedCookieRows(fallbackSink, 'user-1', 'codex', domains, rows), 1);
  assert.deepEqual(attempted, ['first', 'second']);
  assert.equal(await seedCookieRows(batchSink, 'user-1', 'claude', domains, []), 0);
}

void main();
