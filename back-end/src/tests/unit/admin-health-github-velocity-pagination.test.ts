#!/usr/bin/env tsx

/**
 * Owning-boundary regression: the Company Health tab waited ~35s on GitHub
 * commit pagination, one request per 100-commit page. Pages after the first
 * must be fetched concurrently (bounded), while still counting every commit
 * exactly once, falling back to a serial walk when the Link header is absent
 * or the final page is still full, and cancelling in-flight pages on failure.
 */

import assert from 'node:assert';

process.env.GITHUB_TOKEN = 'working_token';
delete process.env.GITHUB_DISPATCH_TOKEN;
process.env.ADMIN_HEALTH_GITHUB_REPO = 'Rose-Ai-Labs/rose';
delete process.env.LINEAR_API_KEY;

const PER_PAGE = 100;
const MAX_CONCURRENCY = 20;
const COMMIT_DATE = '2026-08-20T12:00:00.000Z';

interface FakeGithub {
  pageSizes: number[];
  linkLastPage: number | null;
  failPage?: number;
  delayMs: number;
}

const originalFetch = globalThis.fetch;
let fake: FakeGithub;
let requestedPages: number[] = [];
let abortedPages: number[] = [];
let inFlight = 0;
let peakInFlight = 0;

function commits(count: number) {
  return Array.from({ length: count }, () => ({
    commit: { committer: { date: COMMIT_DATE }, author: { date: COMMIT_DATE } },
  }));
}

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(input instanceof Request ? input.url : input.toString());
  if (url.hostname !== 'api.github.com' || !url.pathname.endsWith('/commits')) {
    throw new Error(`Unexpected fetch in github-pagination test: ${url}`);
  }
  assert.strictEqual(url.searchParams.get('per_page'), String(PER_PAGE));
  const page = Number(url.searchParams.get('page'));
  const signal = init?.signal;
  assert.ok(signal, 'every GitHub page must carry the shared deadline signal');
  requestedPages.push(page);
  inFlight += 1;
  peakInFlight = Math.max(peakInFlight, inFlight);
  try {
    await new Promise<void>((resolve, reject) => {
      if (signal.aborted) {
        abortedPages.push(page);
        reject(signal.reason);
        return;
      }
      const timer = setTimeout(resolve, fake.delayMs);
      signal.addEventListener(
        'abort',
        () => {
          clearTimeout(timer);
          abortedPages.push(page);
          reject(signal.reason);
        },
        { once: true }
      );
    });
  } finally {
    inFlight -= 1;
  }
  if (page === fake.failPage) {
    return new Response(JSON.stringify({ message: 'rate limited' }), { status: 403 });
  }
  const headers = new Headers();
  if (fake.linkLastPage !== null) {
    const link = (target: number, rel: string) => {
      const next = new URL(url);
      next.searchParams.set('page', String(target));
      return `<${next.toString()}>; rel="${rel}"`;
    };
    const parts = [];
    if (page < fake.linkLastPage) parts.push(link(page + 1, 'next'));
    parts.push(link(fake.linkLastPage, 'last'));
    headers.set('Link', parts.join(', '));
  }
  return Response.json(commits(fake.pageSizes[page - 1] ?? 0), { headers });
}) as typeof fetch;

function reset(next: FakeGithub): void {
  fake = next;
  requestedPages = [];
  abortedPages = [];
  inFlight = 0;
  peakInFlight = 0;
}

function fullPages(count: number, lastSize: number): number[] {
  return [...Array.from({ length: count - 1 }, () => PER_PAGE), lastSize];
}

function totalCommits(buckets: Array<{ githubCommits: number | null }>): number {
  return buckets.reduce((sum, bucket) => sum + (bucket.githubCommits ?? 0), 0);
}

async function main(): Promise<void> {
  const { buildPeriods } = await import('../../domains/admin-health/time');
  const { fetchVelocityByPeriod } = await import('../../domains/admin-health/velocity');
  const periods = buildPeriods('weekly', new Date('2026-08-21T15:00:00.000Z'));
  const sortedPages = () => [...requestedPages].sort((a, b) => a - b);

  // 1. Link header names the last page: pages 2..N run concurrently, bounded,
  //    each requested once, every commit counted.
  const pageCount = 60;
  reset({ pageSizes: fullPages(pageCount, 37), linkLastPage: pageCount, delayMs: 20 });
  const parallel = await fetchVelocityByPeriod(periods);
  assert.strictEqual(parallel.current.dev.githubCommitsLanded.status, 'ready');
  assert.strictEqual(totalCommits(parallel.buckets), (pageCount - 1) * PER_PAGE + 37);
  assert.deepStrictEqual(
    sortedPages(),
    Array.from({ length: pageCount }, (_, index) => index + 1),
    'every page must be requested exactly once'
  );
  assert.strictEqual(requestedPages[0], 1, 'page 1 must be fetched first to read the Link header');
  assert.ok(peakInFlight > 1, `pages must be fetched concurrently (peak ${peakInFlight})`);
  assert.ok(
    peakInFlight <= MAX_CONCURRENCY,
    `GitHub page concurrency must stay bounded (peak ${peakInFlight})`
  );

  // 2. A single partial page needs no further requests.
  reset({ pageSizes: [12], linkLastPage: null, delayMs: 0 });
  const single = await fetchVelocityByPeriod(periods);
  assert.strictEqual(totalCommits(single.buckets), 12);
  assert.deepStrictEqual(requestedPages, [1]);

  // 3. No Link header: walk serially until a partial page, as before.
  reset({ pageSizes: fullPages(4, 5), linkLastPage: null, delayMs: 0 });
  const serial = await fetchVelocityByPeriod(periods);
  assert.strictEqual(totalCommits(serial.buckets), 3 * PER_PAGE + 5);
  assert.deepStrictEqual(requestedPages, [1, 2, 3, 4]);
  assert.strictEqual(peakInFlight, 1);

  // 4. Commits landed mid-walk: the advertised last page is full, so keep going.
  reset({ pageSizes: fullPages(7, 3), linkLastPage: 5, delayMs: 0 });
  const grown = await fetchVelocityByPeriod(periods);
  assert.strictEqual(totalCommits(grown.buckets), 6 * PER_PAGE + 3);
  assert.deepStrictEqual(sortedPages(), [1, 2, 3, 4, 5, 6, 7]);

  // 5. A failed page fails the metric (no partial graph) and cancels the rest.
  reset({ pageSizes: fullPages(80, 10), linkLastPage: 80, failPage: 3, delayMs: 20 });
  const failed = await fetchVelocityByPeriod(periods);
  assert.strictEqual(failed.current.dev.githubCommitsLanded.status, 'error');
  assert.strictEqual(failed.current.dev.githubCommitsLanded.detail, 'GitHub 403');
  assert.ok(failed.buckets.every((bucket) => bucket.githubCommits === null));
  assert.ok(abortedPages.length > 0, 'in-flight pages must be cancelled after a failure');
  const issuedAfterFailure = requestedPages.length - abortedPages.length;
  assert.ok(
    issuedAfterFailure < 80,
    `pages after a failure must not keep hitting GitHub (${issuedAfterFailure} completed)`
  );
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.strictEqual(inFlight, 0, 'no GitHub request may outlive a failed metric');

  process.stdout.write('admin-health-github-velocity-pagination: ok\n');
}

main()
  .catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = 1;
  })
  .finally(() => {
    globalThis.fetch = originalFetch;
  });
