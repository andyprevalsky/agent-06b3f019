#!/usr/bin/env tsx
/**
 * Black-box contract for GitHub rate limits on the code-agent publish path.
 *
 *   fake GitHub (verbatim real limit responses) ──► publishCodeSessionBranch
 *        │                                              ├─ branch pushed to a real local origin
 *        │                                              ├─ POST /pulls limited: ONE write, never replayed
 *        │                                              └─ CodePublishError 429 + reset time, token-free
 *        └─ codeSessionHttpError: the 429 body agents read (code, reset_at, retry_after_seconds)
 *
 * Merge facts and the access check are covered in code-session-merge-facts and
 * github-agent-repo; the response fixtures and their drift guard live in
 * tests/fixtures/github-rate-limit and tests/unit/github-rate-limit-fixtures.test.ts.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { CodePublishError, publishCodeSessionBranch } from '../../providers/codePreview/publish';
import { codeSessionHttpError } from '../../providers/codeSessions/spawn';
import { localSandboxFs } from '../../providers/codeSessions/sandboxFs';
import {
  GithubRateLimitedError,
  resetGithubRateLimitStateForTests,
} from '../../providers/githubRateLimit';
import { rateLimitResponse, startFakeGithub } from '../helpers/fake-github';

const TOKEN = 'ghp_ratelimit_test_token_must_never_appear_in_output_0123456789';
const savedEnv = {
  api: process.env.GITHUB_API_BASE_URL,
  token: process.env.GITHUB_TOKEN,
};
process.env.GITHUB_TOKEN = TOKEN;
const fixtureDir = mkdtempSync(join(tmpdir(), 'github-rate-limit-'));

after(() => {
  resetGithubRateLimitStateForTests();
  if (savedEnv.api === undefined) delete process.env.GITHUB_API_BASE_URL;
  else process.env.GITHUB_API_BASE_URL = savedEnv.api;
  if (savedEnv.token === undefined) delete process.env.GITHUB_TOKEN;
  else process.env.GITHUB_TOKEN = savedEnv.token;
  rmSync(fixtureDir, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

/** A work branch with one commit, ahead of a real local origin. */
function workBranch(label: string): { home: string; origin: string; head: string } {
  const home = join(fixtureDir, `${label}-home`);
  const origin = join(fixtureDir, `${label}-origin.git`);
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin]);
  mkdirSync(home, { recursive: true });
  const workspace = join(home, 'workspace');
  execFileSync('git', ['clone', '-q', origin, workspace], { stdio: 'ignore' });
  git(workspace, 'config', 'user.name', 'Test');
  git(workspace, 'config', 'user.email', 'test@example.com');
  git(workspace, 'checkout', '-q', '-b', 'main');
  writeFileSync(join(workspace, 'README.md'), 'rose\n');
  git(workspace, 'add', '-A');
  git(workspace, 'commit', '-q', '-m', 'initial');
  git(workspace, 'push', '-q', 'origin', 'main');
  git(workspace, 'checkout', '-q', '-b', 'rose/ui-header');
  writeFileSync(join(workspace, 'header.txt'), 'sticky header\n');
  git(workspace, 'add', '-A');
  git(workspace, 'commit', '-q', '-m', 'Make the header sticky');
  return { home, origin, head: git(workspace, 'rev-parse', 'HEAD') };
}

const session = {
  id: 'session-rate-limit',
  repoUrl: 'https://github.com/Rose-Ai-Labs/rose',
  branch: 'rose/ui-header',
  mergeTarget: 'main',
  lastRepoFacts: null,
};

test('publish: a limited PR create is one write, a 429 with the reset time, and the branch is already pushed', async () => {
  resetGithubRateLimitStateForTests();
  const { home, origin, head } = workBranch('publish-secondary');
  // Real secondary-limit response (status + body) with GitHub's documented retry-after.
  const fake = await startFakeGithub(() => rateLimitResponse('secondary', { retryAfterS: 120 }));
  process.env.GITHUB_API_BASE_URL = fake.baseUrl;
  try {
    const before = Date.now();
    const error = await publishCodeSessionBranch({ session, fs: localSandboxFs(home) }).then(
      () => null,
      (caught: unknown) => caught
    );
    const after = Date.now();
    assert.ok(error instanceof CodePublishError, `expected CodePublishError, got ${error}`);
    assert.equal(error.status, 429, 'a rate limit is not a 502 upstream failure');
    assert.equal(error.code, 'GITHUB_RATE_LIMITED');
    const reset = /retry after (\d{4}-\d\d-\d\dT[\d:.]+Z)\./.exec(error.message)?.[1];
    assert.ok(reset, `the message carries the reset time: ${error.message}`);
    const resetMs = Date.parse(reset);
    assert.ok(
      resetMs >= before + 119_000 && resetMs <= after + 121_000,
      `reset follows retry-after: ${reset}`
    );
    assert.equal(
      fake.requests.filter((request) => request.method === 'POST').length,
      1,
      'a sent write is never replayed'
    );
    assert.equal(
      git(origin, 'rev-parse', 'refs/heads/rose/ui-header'),
      head,
      'the work branch reached origin before the PR create was limited, so a retry is safe'
    );
    assert.ok(!error.message.includes(TOKEN), 'no token in the error');

    // While blocked, a second publish reaches GitHub zero more times.
    const sent = fake.requests.length;
    await assert.rejects(
      publishCodeSessionBranch({ session, fs: localSandboxFs(home) }),
      (caught: unknown) => caught instanceof CodePublishError && caught.status === 429
    );
    assert.equal(fake.requests.length, sent, 'while blocked, no call reaches GitHub');
  } finally {
    await fake.close();
  }
});

test('publish: a primary limit on the default-branch read stops before any push or write', async () => {
  resetGithubRateLimitStateForTests();
  const { home, origin } = workBranch('publish-primary');
  const resetEpochS = Math.floor(Date.now() / 1000) + 3600;
  const fake = await startFakeGithub(() => rateLimitResponse('primary', { resetEpochS }));
  process.env.GITHUB_API_BASE_URL = fake.baseUrl;
  try {
    await assert.rejects(
      publishCodeSessionBranch({
        session: { ...session, mergeTarget: null },
        fs: localSandboxFs(home),
      }),
      (caught: unknown) =>
        caught instanceof CodePublishError &&
        caught.status === 429 &&
        caught.code === 'GITHUB_RATE_LIMITED' &&
        caught.message.includes(new Date(resetEpochS * 1000).toISOString())
    );
    assert.equal(fake.requests.length, 1, 'one limited read, no retries into a 1-hour block');
    assert.throws(
      () => git(origin, 'rev-parse', 'refs/heads/rose/ui-header'),
      'nothing was pushed when the base branch could not be read'
    );
  } finally {
    await fake.close();
  }
});

test('the create-session 429 body tells the agent the code, the reset time and the wait', () => {
  const resetAtMs = Date.now() + 90_000;
  const mapped = codeSessionHttpError(
    new GithubRateLimitedError({ kind: 'primary', status: 403, resetAtMs, resource: 'core' })
  );
  assert.ok(mapped);
  assert.equal(mapped.status, 429);
  assert.equal(mapped.body.code, 'GITHUB_RATE_LIMITED');
  assert.equal(mapped.body.reset_at, new Date(resetAtMs).toISOString());
  assert.ok(
    Number(mapped.body.retry_after_seconds) >= 89 && Number(mapped.body.retry_after_seconds) <= 91
  );
  assert.match(mapped.body.error, /GitHub rate limit reached \(primary, core\); retry after /);
  assert.ok(!JSON.stringify(mapped).includes(TOKEN));
});
