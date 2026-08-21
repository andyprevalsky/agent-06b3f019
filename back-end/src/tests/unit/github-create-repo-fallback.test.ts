#!/usr/bin/env tsx

/**
 * Owning-boundary regression: createGithubRepo must fall through a 401/403
 * GITHUB_TOKEN to GITHUB_DISPATCH_TOKEN (same prod failure mode that blanked
 * the admin-health commits graph on 2026-08-21).
 */

import assert from 'node:assert';

process.env.GITHUB_TOKEN = 'stale_github_pat_should_401';
process.env.GITHUB_DISPATCH_TOKEN = 'working_dispatch_token';

const originalFetch = globalThis.fetch;
const authHeaders: string[] = [];

globalThis.fetch = (async (
  _input: string | URL | Request,
  init?: RequestInit
): Promise<Response> => {
  const authorization = new Headers(init?.headers).get('Authorization') ?? '';
  authHeaders.push(authorization);
  if (authorization === 'Bearer stale_github_pat_should_401') {
    return new Response(JSON.stringify({ message: 'Bad credentials' }), { status: 401 });
  }
  if (authorization === 'Bearer working_dispatch_token') {
    return Response.json({ html_url: 'https://github.com/example/agent-test' });
  }
  throw new Error(`Unexpected Authorization header: ${authorization}`);
}) as typeof fetch;

async function main(): Promise<void> {
  const { createGithubRepo } = await import('../../providers/github');

  const url = await createGithubRepo('agent-test');
  assert.strictEqual(url, 'https://github.com/example/agent-test');
  assert.deepStrictEqual(authHeaders, [
    'Bearer stale_github_pat_should_401',
    'Bearer working_dispatch_token',
  ]);

  authHeaders.length = 0;
  process.env.GITHUB_TOKEN = 'stale_github_pat_should_401';
  delete process.env.GITHUB_DISPATCH_TOKEN;
  const failed = await createGithubRepo('agent-test-2');
  assert.strictEqual(failed, null);
  assert.deepStrictEqual(authHeaders, ['Bearer stale_github_pat_should_401']);

  authHeaders.length = 0;
  delete process.env.GITHUB_TOKEN;
  delete process.env.GITHUB_DISPATCH_TOKEN;
  const missing = await createGithubRepo('agent-test-3');
  assert.strictEqual(missing, null);
  assert.deepStrictEqual(authHeaders, []);

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
