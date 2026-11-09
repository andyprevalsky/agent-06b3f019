#!/usr/bin/env tsx

/**
 * githubRateLimit: classification follows GitHub's documented rules, and
 * githubFetch honours them with a bounded wait.
 *
 * GitHub responses here come from the verbatim fixtures (real captures). The
 * extra header combinations and non-limit statuses are SYNTHETIC classifier
 * inputs for edge cases, not claims about what GitHub sends.
 */

import assert from 'node:assert/strict';
import {
  activeGithubRateLimit,
  classifyGithubRateLimit,
  githubFetch,
  GithubRateLimitedError,
  resetGithubRateLimitStateForTests,
} from '../../providers/githubRateLimit';
import { loadRateLimitFixture, rateLimitResponse, toResponse } from '../helpers/fake-github';

const NOW = 1_800_000_000_000;

function classify(reply: ReturnType<typeof rateLimitResponse>, nowMs = NOW) {
  return classifyGithubRateLimit(reply.status, toResponse(reply).headers, reply.body, nowMs);
}

function classifyParts(status: number, headers: Record<string, string>, body = '{}') {
  return classifyGithubRateLimit(status, new Headers(headers), body, NOW);
}

async function main(): Promise<void> {
  // The real primary capture: reset from x-ratelimit-reset, resource core.
  const resetEpochS = NOW / 1000 + 600;
  const primary = classify(rateLimitResponse('primary', { resetEpochS }));
  assert.deepEqual(primary, {
    kind: 'primary',
    status: 403,
    resetAtMs: resetEpochS * 1000,
    resource: 'core',
  });
  assert.equal(
    JSON.parse(loadRateLimitFixture('primary').body).message.startsWith('API rate limit exceeded'),
    true
  );

  // The real secondary body carries no reset: GitHub says wait at least a minute.
  const secondary = classify(rateLimitResponse('secondary'));
  assert.equal(secondary?.kind, 'secondary');
  assert.equal(secondary?.resetAtMs, NOW + 60_000);

  // retry-after wins when present; seconds or an HTTP date.
  assert.equal(
    classify(rateLimitResponse('secondary', { retryAfterS: 120 }))?.resetAtMs,
    NOW + 120_000
  );
  assert.equal(
    classifyParts(429, { 'retry-after': new Date(NOW + 30_000).toUTCString() })?.resetAtMs,
    NOW + 30_000
  );

  // 429 is always a limit; other 403s and statuses are not.
  assert.equal(classifyParts(429, {})?.resetAtMs, NOW + 60_000);
  assert.equal(
    classifyParts(403, {}, '{"message":"Forbidden"}'),
    null,
    'a plain 403 is not a limit'
  );
  assert.equal(classifyParts(403, { 'x-ratelimit-remaining': '4999' }), null);
  assert.equal(classifyParts(404, { 'x-ratelimit-remaining': '0' }), null);
  assert.equal(classifyParts(200, { 'retry-after': '5' }), null);
  assert.equal(classifyParts(403, {}, 'not json'), null);

  // githubFetch ------------------------------------------------------------
  const limited = (retryAfterS: number) => async () =>
    toResponse(rateLimitResponse('secondary', { retryAfterS }));

  // A GET is retried once the (short) limit ends.
  resetGithubRateLimitStateForTests();
  let calls = 0;
  const startedAt = Date.now();
  const ok = await githubFetch(
    'http://github.test/repos/a/b',
    {},
    {
      maxWaitMs: 5_000,
      fetchImpl: (async () => {
        calls += 1;
        return calls === 1 ? limited(1)() : Response.json({ ok: true });
      }) as unknown as typeof fetch,
    }
  );
  assert.equal(ok.status, 200);
  assert.equal(calls, 2);
  assert.ok(Date.now() - startedAt >= 1_900, 'waited retry-after plus the clock buffer');

  // A sent write is never replayed.
  resetGithubRateLimitStateForTests();
  calls = 0;
  await assert.rejects(
    githubFetch(
      'http://github.test/repos/a/b/pulls',
      { method: 'POST', body: '{}' },
      {
        maxWaitMs: 60_000,
        fetchImpl: (async () => {
          calls += 1;
          return limited(1)();
        }) as unknown as typeof fetch,
      }
    ),
    (error: unknown) => error instanceof GithubRateLimitedError && error.sent
  );
  assert.equal(calls, 1);

  // A limit beyond the budget fails at once, without waiting; later calls never reach GitHub.
  resetGithubRateLimitStateForTests();
  calls = 0;
  const impl = (async () => {
    calls += 1;
    return limited(300)();
  }) as unknown as typeof fetch;
  const before = Date.now();
  await assert.rejects(
    githubFetch('http://github.test/x', {}, { maxWaitMs: 1_000, fetchImpl: impl }),
    (error: unknown) =>
      error instanceof GithubRateLimitedError &&
      error.retryAfterSeconds() >= 299 &&
      error.message.includes(error.resetAt)
  );
  assert.ok(Date.now() - before < 500, 'it did not wait');
  assert.ok(activeGithubRateLimit() !== null);
  await assert.rejects(
    githubFetch('http://github.test/y', { method: 'POST' }, { fetchImpl: impl }),
    (error: unknown) => error instanceof GithubRateLimitedError && !error.sent
  );
  assert.equal(calls, 1, 'a blocked call is never sent');

  // maxWaitMs 0 (change-watch polls) never waits for any limit.
  resetGithubRateLimitStateForTests();
  calls = 0;
  await assert.rejects(
    githubFetch('http://github.test/z', {}, { maxWaitMs: 0, fetchImpl: limited(1) as never })
  );

  resetGithubRateLimitStateForTests();
  process.stdout.write('github rate limit: classification and bounded waiting hold\n');
}

main().catch((error) => {
  process.stderr.write(
    `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`
  );
  process.exit(1);
});
