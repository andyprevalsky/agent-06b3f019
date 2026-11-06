#!/usr/bin/env tsx

/**
 * Owning-boundary regression: a present-but-stale GITHUB_TOKEN must not leave
 * the Company Health "GitHub Commits Landed" series stuck on status=error when
 * GITHUB_DISPATCH_TOKEN can still read the repo (prod failure mode 2026-08-21).
 */

import assert from 'node:assert';

process.env.GITHUB_TOKEN = 'stale_github_pat_should_401';
process.env.GITHUB_DISPATCH_TOKEN = 'working_dispatch_token';
process.env.ADMIN_HEALTH_GITHUB_REPO = 'Rose-Ai-Labs/rose';
delete process.env.LINEAR_API_KEY;

const originalFetch = globalThis.fetch;
const originalTimeout = AbortSignal.timeout;
const authHeaders: string[] = [];
let commitFetches = 0;

globalThis.fetch = (async (
  input: string | URL | Request,
  init?: RequestInit
): Promise<Response> => {
  const url = new URL(input instanceof Request ? input.url : input.toString());
  if (url.hostname !== 'api.github.com' || !url.pathname.endsWith('/commits')) {
    throw new Error(`Unexpected fetch in github-velocity test: ${url}`);
  }
  commitFetches += 1;
  const authorization = new Headers(init?.headers).get('Authorization') ?? '';
  authHeaders.push(authorization);
  if (authorization === 'Bearer stale_github_pat_should_401') {
    return new Response(JSON.stringify({ message: 'Bad credentials' }), { status: 401 });
  }
  if (authorization === 'Bearer no_access_pat') {
    return new Response(JSON.stringify({ message: 'Not Found' }), { status: 404 });
  }
  if (authorization === 'Bearer rate_limited_pat') {
    return new Response(JSON.stringify({ message: 'API rate limit exceeded' }), { status: 429 });
  }
  if (authorization === 'Bearer working_dispatch_token') {
    return Response.json([
      {
        commit: {
          committer: { date: '2026-08-20T12:00:00.000Z' },
          author: { date: '2026-08-20T12:00:00.000Z' },
        },
      },
      {
        commit: {
          committer: { date: '2026-08-13T12:00:00.000Z' },
          author: { date: '2026-08-13T12:00:00.000Z' },
        },
      },
    ]);
  }
  throw new Error(`Unexpected Authorization header: ${authorization}`);
}) as typeof fetch;

async function main(): Promise<void> {
  const { githubApiTokenCandidates } = await import('../../domains/admin-health/config');
  assert.deepStrictEqual(githubApiTokenCandidates(), [
    'stale_github_pat_should_401',
    'working_dispatch_token',
  ]);

  const { buildPeriods } = await import('../../domains/admin-health/time');
  const { fetchVelocityByPeriod } = await import('../../domains/admin-health/velocity');

  const periods = buildPeriods('weekly', new Date('2026-08-21T15:00:00.000Z'));
  const result = await fetchVelocityByPeriod(periods);

  assert.strictEqual(
    result.current.dev.githubCommitsLanded.status,
    'ready',
    'stale GITHUB_TOKEN must fall back to GITHUB_DISPATCH_TOKEN instead of status=error'
  );
  assert.strictEqual(result.current.dev.githubCommitsLanded.value, 1);
  assert.ok(
    result.buckets.some((bucket) => bucket.githubCommits === 1),
    'commits must land in a weekly bucket for the chart series'
  );
  assert.strictEqual(commitFetches, 2, 'must try stale token then dispatch token');
  assert.deepStrictEqual(authHeaders, [
    'Bearer stale_github_pat_should_401',
    'Bearer working_dispatch_token',
  ]);

  // A rate-limited token (HTTP 429) falls through to the next pool member like a 401/403.
  process.env.GITHUB_TOKEN = 'rate_limited_pat';
  process.env.GITHUB_DISPATCH_TOKEN = 'working_dispatch_token';
  authHeaders.length = 0;
  commitFetches = 0;
  const rateLimited = await fetchVelocityByPeriod(periods);
  assert.strictEqual(
    rateLimited.current.dev.githubCommitsLanded.status,
    'ready',
    'a 429 on one pool member must fall back to the next member'
  );
  assert.deepStrictEqual(authHeaders, ['Bearer rate_limited_pat', 'Bearer working_dispatch_token']);

  // A member that cannot see the private repo gets GitHub's 404; the next member is tried.
  process.env.GITHUB_TOKEN = 'no_access_pat';
  process.env.GITHUB_DISPATCH_TOKEN = 'working_dispatch_token';
  authHeaders.length = 0;
  commitFetches = 0;
  const noAccess = await fetchVelocityByPeriod(periods);
  assert.strictEqual(
    noAccess.current.dev.githubCommitsLanded.status,
    'ready',
    'a 404 on one pool member must fall back to the next member'
  );
  assert.deepStrictEqual(authHeaders, ['Bearer no_access_pat', 'Bearer working_dispatch_token']);

  // Stale-only still errors (no silent empty graph).
  process.env.GITHUB_TOKEN = 'stale_github_pat_should_401';
  delete process.env.GITHUB_DISPATCH_TOKEN;
  authHeaders.length = 0;
  commitFetches = 0;
  const staleOnly = await fetchVelocityByPeriod(periods);
  assert.strictEqual(staleOnly.current.dev.githubCommitsLanded.status, 'error');
  assert.strictEqual(staleOnly.current.dev.githubCommitsLanded.detail, 'GitHub 401');
  assert.ok(staleOnly.buckets.every((bucket) => bucket.githubCommits === null));

  // A stalled page must end the whole GitHub metric, leaving other admin-health metrics available.
  process.env.GITHUB_TOKEN = 'working_dispatch_token';
  AbortSignal.timeout = () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(new Error('GitHub deadline exceeded')), 20);
    return controller.signal;
  };
  globalThis.fetch = ((_input: string | URL | Request, init?: RequestInit) => {
    assert.ok(init?.signal, 'GitHub pagination must receive the shared deadline');
    return new Promise<Response>((_resolve, reject) => {
      init.signal!.addEventListener('abort', () => reject(init.signal!.reason), { once: true });
    });
  }) as typeof fetch;
  const stalled = await fetchVelocityByPeriod(periods);
  assert.strictEqual(stalled.current.dev.githubCommitsLanded.status, 'error');
  assert.ok(stalled.buckets.every((bucket) => bucket.githubCommits === null));

  process.stdout.write('admin-health-github-velocity-fallback: ok\n');
}

main()
  .catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = 1;
  })
  .finally(() => {
    globalThis.fetch = originalFetch;
    AbortSignal.timeout = originalTimeout;
  });
