#!/usr/bin/env tsx

/**
 * Owning-boundary regressions for the GitHub token pool (2026-11-06): the
 * primary GITHUB_TOKEN (Andy's user token) hit 0/5000 twice within an hour,
 * failing every reader. Reads now spread across GITHUB_TOKEN_2..9:
 *  - the member with the most remaining quota (from x-ratelimit-*) is used;
 *  - a rate-limited or 401 member is retried on the next and then skipped;
 *  - a machine account's 404 is re-asked with the primary (private repos);
 *  - `identity: 'primary'` writes never leave GITHUB_TOKEN/GITHUB_DISPATCH_TOKEN;
 *  - merge-facts reads use the pool while publish POSTs stay primary;
 *  - admin-health candidates follow the pool ranking.
 */

import assert from 'node:assert';

process.env.GITHUB_TOKEN = 'primary';
process.env.GITHUB_TOKEN_2 = 'bot2';
process.env.GITHUB_TOKEN_3 = 'bot3';
process.env.GITHUB_DISPATCH_TOKEN = 'dispatch';

type Call = { url: string; method: string; auth: string };
const calls: Call[] = [];
let respond: (call: Call) => Response = () => new Response('unset', { status: 500 });
const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const call = {
    url: String(input),
    method: init?.method ?? 'GET',
    auth: new Headers(init?.headers).get('Authorization') ?? '',
  };
  calls.push(call);
  return respond(call);
}) as typeof fetch;

function limited(remaining: number, status = 200, body = '{}'): Response {
  return new Response(body, {
    status,
    headers: {
      'x-ratelimit-remaining': String(remaining),
      'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 3600),
    },
  });
}

async function main(): Promise<void> {
  const pool = await import('../../providers/githubTokenPool');
  const { githubFetch, githubTokenCandidates, resetGithubTokenPoolForTests } = pool;
  const reset = () => {
    calls.length = 0;
    resetGithubTokenPoolForTests();
  };

  // Unknown quota keeps pool order; dispatch stays last.
  reset();
  assert.deepStrictEqual(githubTokenCandidates(), ['primary', 'bot2', 'bot3', 'dispatch']);
  assert.deepStrictEqual(githubTokenCandidates('primary'), ['primary', 'dispatch']);

  // Learned quota reorders members: most remaining first.
  const quota: Record<string, number> = {
    'Bearer primary': 10,
    'Bearer bot2': 4000,
    'Bearer bot3': 200,
  };
  respond = (call) => limited(quota[call.auth] ?? 5000);
  reset();
  for (const token of ['primary', 'bot2', 'bot3']) {
    pool.recordGithubResponse(token, 200, limited(quota[`Bearer ${token}`]).headers);
  }
  await githubFetch('https://api.github.com/repos/o/r', {}, { fetchImpl: fakeFetch });
  assert.deepStrictEqual(
    calls.map((c) => c.auth),
    ['Bearer bot2']
  );

  // A rate-limited member is retried on the next and then skipped until reset.
  reset();
  respond = (call) =>
    call.auth === 'Bearer primary'
      ? limited(0, 403, JSON.stringify({ message: 'API rate limit exceeded for user ID 1.' }))
      : limited(4999);
  const first = await githubFetch('https://api.github.com/x', {}, { fetchImpl: fakeFetch });
  assert.strictEqual(first.status, 200);
  assert.deepStrictEqual(
    calls.map((c) => c.auth),
    ['Bearer primary', 'Bearer bot2']
  );
  calls.length = 0;
  await githubFetch('https://api.github.com/x', {}, { fetchImpl: fakeFetch });
  assert.deepStrictEqual(
    calls.map((c) => c.auth),
    ['Bearer bot3'],
    'an exhausted member is not tried again before its reset; an unobserved member counts as full'
  );
  assert.strictEqual(githubTokenCandidates().at(-1), 'primary', 'exhausted member ranks last');

  // Secondary limit (403 + message, no remaining=0) also moves on.
  reset();
  respond = (call) =>
    call.auth === 'Bearer primary'
      ? new Response(JSON.stringify({ message: 'You have exceeded a secondary rate limit' }), {
          status: 403,
          headers: { 'retry-after': '60' },
        })
      : limited(4999);
  assert.strictEqual(
    (await githubFetch('https://api.github.com/y', {}, { fetchImpl: fakeFetch })).status,
    200
  );
  assert.deepStrictEqual(
    calls.map((c) => c.auth),
    ['Bearer primary', 'Bearer bot2']
  );

  // A plain 403 (permission, not a limit) is returned, not retried.
  reset();
  respond = () =>
    new Response(JSON.stringify({ message: 'Resource not accessible' }), { status: 403 });
  assert.strictEqual(
    (await githubFetch('https://api.github.com/z', {}, { fetchImpl: fakeFetch })).status,
    403
  );
  assert.strictEqual(calls.length, 1);

  // 401 skips to the next member and blocks the bad one.
  reset();
  respond = (call) =>
    call.auth === 'Bearer primary'
      ? new Response(JSON.stringify({ message: 'Bad credentials' }), { status: 401 })
      : limited(4999);
  await githubFetch('https://api.github.com/w', {}, { fetchImpl: fakeFetch });
  assert.deepStrictEqual(
    calls.map((c) => c.auth),
    ['Bearer primary', 'Bearer bot2']
  );
  assert.strictEqual(githubTokenCandidates().at(-1), 'primary');

  // A machine account's 404 is re-asked with the primary; the primary's answer wins.
  reset();
  pool.recordGithubResponse('primary', 200, limited(1).headers);
  respond = (call) =>
    call.auth === 'Bearer primary' ? limited(1, 200, '{"private":true}') : limited(4000, 404);
  const privateRepo = await githubFetch(
    'https://api.github.com/repos/andy/private',
    {},
    {
      fetchImpl: fakeFetch,
    }
  );
  assert.strictEqual(privateRepo.status, 200);
  assert.deepStrictEqual(
    calls.map((c) => c.auth),
    ['Bearer bot2', 'Bearer primary']
  );

  // Primary identity never uses a machine account, even when primary is exhausted.
  reset();
  respond = (call) =>
    call.auth === 'Bearer primary' || call.auth === 'Bearer dispatch'
      ? limited(0, 403, JSON.stringify({ message: 'API rate limit exceeded' }))
      : limited(4999);
  const write = await githubFetch(
    'https://api.github.com/repos/o/r/pulls',
    { method: 'POST', body: '{}' },
    { fetchImpl: fakeFetch, identity: 'primary' }
  );
  assert.strictEqual(write.status, 403);
  assert.deepStrictEqual(
    calls.map((c) => c.auth),
    ['Bearer primary', 'Bearer dispatch']
  );

  // No member configured: unauthenticated, as before.
  reset();
  const saved = { ...process.env };
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('GITHUB_TOKEN') || key === 'GITHUB_DISPATCH_TOKEN') delete process.env[key];
  }
  respond = () => limited(59);
  await githubFetch('https://api.github.com/public', {}, { fetchImpl: fakeFetch });
  assert.deepStrictEqual(
    calls.map((c) => c.auth),
    ['']
  );
  Object.assign(process.env, saved);

  // Merge facts: GET via the pool, publish POST via the primary.
  const { githubJson } = await import('../../providers/codeSessions/mergeFacts');
  reset();
  pool.recordGithubResponse('primary', 200, limited(3).headers);
  respond = () => limited(4000, 200, '[]');
  await githubJson(fakeFetch, '/repos/o/r/pulls?head=o:b');
  await githubJson(fakeFetch, '/repos/o/r/pulls', { method: 'POST', body: { title: 't' } });
  assert.deepStrictEqual(
    calls.map((c) => [c.method, c.auth]),
    [
      ['GET', 'Bearer bot2'],
      ['POST', 'Bearer primary'],
    ]
  );

  // Admin-health candidates follow the pool ranking.
  const { githubApiTokenCandidates } = await import('../../domains/admin-health/config');
  reset();
  pool.recordGithubResponse('primary', 200, limited(0).headers);
  assert.deepStrictEqual(githubApiTokenCandidates(), ['bot2', 'bot3', 'dispatch', 'primary']);

  // GitHub App member: one RS256-signed mint, cached, refreshed before expiry,
  // ranked by its own quota; a failed mint never blocks the static members.
  const { generateKeyPairSync, createVerify } = await import('node:crypto');
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  process.env.GITHUB_APP_ID = '424242';
  process.env.GITHUB_APP_INSTALLATION_ID = '777';
  process.env.GITHUB_APP_PRIVATE_KEY_B64 = Buffer.from(
    privateKey.export({ type: 'pkcs8', format: 'pem' }) as string
  ).toString('base64');
  let mints = 0;
  let mintStatus = 201;
  let expiresInMs = 3_600_000;
  respond = (call) => {
    if (call.url.endsWith('/app/installations/777/access_tokens')) {
      mints += 1;
      const [header, payload, signature] = call.auth.replace('Bearer ', '').split('.');
      assert.ok(
        createVerify('RSA-SHA256')
          .update(`${header}.${payload}`)
          .verify(publicKey, Buffer.from(signature, 'base64url')),
        'app JWT is signed with the configured private key'
      );
      assert.strictEqual(JSON.parse(Buffer.from(payload, 'base64url').toString()).iss, '424242');
      assert.strictEqual(call.method, 'POST');
      return mintStatus === 201
        ? Response.json(
            {
              token: `app-installation-${mints}`,
              expires_at: new Date(Date.now() + expiresInMs).toISOString(),
            },
            { status: 201 }
          )
        : new Response('{"message":"boom"}', { status: mintStatus });
    }
    return limited(call.auth.startsWith('Bearer app-installation') ? 14000 : 100);
  };
  reset();
  pool.recordGithubResponse('primary', 200, limited(100).headers);
  pool.recordGithubResponse('bot2', 200, limited(100).headers);
  pool.recordGithubResponse('bot3', 200, limited(100).headers);
  await Promise.all([
    githubFetch('https://api.github.com/repos/o/r', {}, { fetchImpl: fakeFetch }),
    githubFetch('https://api.github.com/repos/o/r', {}, { fetchImpl: fakeFetch }),
  ]);
  assert.strictEqual(mints, 1, 'concurrent callers share one mint');
  assert.deepStrictEqual(
    calls.filter((c) => !c.url.includes('/app/')).map((c) => c.auth),
    ['Bearer app-installation-1', 'Bearer app-installation-1']
  );
  await githubFetch('https://api.github.com/repos/o/r', {}, { fetchImpl: fakeFetch });
  assert.strictEqual(mints, 1, 'an unexpired installation token is reused');

  // Near expiry: minted again, and the old token's state is dropped.
  reset();
  expiresInMs = 4 * 60_000;
  await githubFetch('https://api.github.com/repos/o/r', {}, { fetchImpl: fakeFetch });
  await githubFetch('https://api.github.com/repos/o/r', {}, { fetchImpl: fakeFetch });
  assert.strictEqual(mints - 1, 2, 'a token inside the refresh margin is re-minted');

  // A failed mint falls back to the static members.
  reset();
  mintStatus = 500;
  calls.length = 0;
  const fallback = await githubFetch(
    'https://api.github.com/repos/o/r',
    {},
    { fetchImpl: fakeFetch }
  );
  assert.strictEqual(fallback.status, 200);
  assert.deepStrictEqual(
    calls.filter((c) => !c.url.includes('/app/')).map((c) => c.auth),
    ['Bearer primary']
  );

  // Primary-identity writes never use the app.
  reset();
  mintStatus = 201;
  await githubFetch(
    'https://api.github.com/repos/o/r/pulls',
    { method: 'POST' },
    {
      fetchImpl: fakeFetch,
      identity: 'primary',
    }
  );
  assert.deepStrictEqual(
    calls.map((c) => c.auth),
    ['Bearer primary']
  );

  process.stdout.write('github-token-pool: ok\n');
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
