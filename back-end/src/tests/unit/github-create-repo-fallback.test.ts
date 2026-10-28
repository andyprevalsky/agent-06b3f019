#!/usr/bin/env tsx

/**
 * Owning-boundary regressions for createGithubRepo:
 *  - a 401/403 GITHUB_TOKEN falls through to GITHUB_DISPATCH_TOKEN (2026-08-21);
 *  - only production (or GITHUB_AGENT_REPOS=on) creates agent repos: on
 *    2026-10-28 local/benchmark stacks sharing the production token made 96% of
 *    creates and tripped GitHub's secondary limit for production users;
 *  - a secondary-limit response blocks every create until its Retry-After;
 *  - "name already exists" returns the existing repo (idempotent retries);
 *  - creates are paced process-wide, and a full queue skips instead of waiting.
 */

import assert from 'node:assert';

process.env.GITHUB_REPO_CREATE_MIN_INTERVAL_MS = '150';
process.env.GITHUB_REPO_CREATE_MAX_WAIT_MS = '200';
process.env.GITHUB_AGENT_REPOS = 'on';
process.env.GITHUB_TOKEN = 'stale_github_pat_should_401';
process.env.GITHUB_DISPATCH_TOKEN = 'working_dispatch_token';

const originalFetch = globalThis.fetch;
type Call = { url: string; method: string; auth: string; at: number };
const calls: Call[] = [];
let respond: (call: Call) => Response = () => new Response('unset', { status: 500 });

globalThis.fetch = (async (
  input: string | URL | Request,
  init?: RequestInit
): Promise<Response> => {
  const call = {
    url: String(input),
    method: init?.method ?? 'GET',
    auth: new Headers(init?.headers).get('Authorization') ?? '',
    at: Date.now(),
  };
  calls.push(call);
  return respond(call);
}) as typeof fetch;

async function main(): Promise<void> {
  const github = await import('../../providers/github');
  const { createGithubRepo, agentRepoCreationEnabled, resetGithubRepoCreateStateForTests } = github;
  const reset = () => {
    calls.length = 0;
    resetGithubRepoCreateStateForTests();
  };

  // Token fallback (unchanged behaviour).
  respond = (call) =>
    call.auth === 'Bearer stale_github_pat_should_401'
      ? new Response(JSON.stringify({ message: 'Bad credentials' }), { status: 401 })
      : Response.json({ html_url: 'https://github.com/example/agent-test' });
  reset();
  assert.strictEqual(await createGithubRepo('agent-test'), 'https://github.com/example/agent-test');
  assert.deepStrictEqual(
    calls.map((c) => c.auth),
    ['Bearer stale_github_pat_should_401', 'Bearer working_dispatch_token']
  );
  reset();
  delete process.env.GITHUB_DISPATCH_TOKEN;
  assert.strictEqual(await createGithubRepo('agent-test-2'), null);
  assert.strictEqual(calls.length, 1);
  reset();
  delete process.env.GITHUB_TOKEN;
  assert.strictEqual(await createGithubRepo('agent-test-3'), null);
  assert.strictEqual(calls.length, 0);
  process.env.GITHUB_TOKEN = 'working_dispatch_token';

  // Production gate: no override → only Render creates.
  assert.strictEqual(agentRepoCreationEnabled({ RENDER: 'true' }), true);
  assert.strictEqual(agentRepoCreationEnabled({}), false, 'local/benchmark stacks must not create');
  assert.strictEqual(
    agentRepoCreationEnabled({ RENDER: 'true', GITHUB_AGENT_REPOS: 'off' }),
    false
  );
  delete process.env.GITHUB_AGENT_REPOS;
  delete process.env.RENDER;
  reset();
  assert.strictEqual(await createGithubRepo('agent-local'), null);
  assert.strictEqual(calls.length, 0, 'a non-production stack must not call GitHub');
  process.env.GITHUB_AGENT_REPOS = 'on';

  // Secondary limit: block all creates for Retry-After, without calling GitHub again.
  respond = () =>
    new Response(
      JSON.stringify({
        message:
          'You have exceeded a secondary rate limit and have been temporarily blocked from content creation.',
      }),
      { status: 403, headers: { 'retry-after': '120' } }
    );
  reset();
  assert.strictEqual(await createGithubRepo('agent-limited'), null);
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(await createGithubRepo('agent-limited-2'), null);
  assert.strictEqual(calls.length, 1, 'a blocked create must not hit GitHub until Retry-After');

  // Name already exists: return the existing repo.
  respond = (call) => {
    if (call.method === 'POST')
      return new Response(
        JSON.stringify({
          message: 'Repository creation failed.',
          errors: [{ message: 'name already exists on this account' }],
        }),
        { status: 422 }
      );
    if (call.url.endsWith('/user')) return Response.json({ login: 'rose-agent' });
    return Response.json({ html_url: 'https://github.com/rose-agent/agent-again' });
  };
  reset();
  assert.strictEqual(
    await createGithubRepo('agent-again'),
    'https://github.com/rose-agent/agent-again'
  );
  assert.ok(calls.some((c) => c.url === 'https://api.github.com/repos/rose-agent/agent-again'));

  // Pacing: creates are spaced; one that would wait past the limit is skipped.
  respond = () => Response.json({ html_url: 'https://github.com/rose-agent/paced' });
  reset();
  const results = await Promise.all([
    createGithubRepo('agent-p1'),
    createGithubRepo('agent-p2'),
    createGithubRepo('agent-p3'),
  ]);
  const posts = calls.filter((c) => c.method === 'POST');
  assert.strictEqual(posts.length, 2, 'the third create would wait 300 ms > 200 ms and is skipped');
  assert.deepStrictEqual(
    results.map((r) => r !== null),
    [true, true, false]
  );
  assert.ok(
    posts[1].at - posts[0].at >= 140,
    `creates must be spaced, got ${posts[1].at - posts[0].at} ms`
  );

  process.stdout.write('github-create-repo-fallback: ok\n');
}

main()
  .catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = 1;
  })
  .finally(() => {
    globalThis.fetch = originalFetch;
  });
