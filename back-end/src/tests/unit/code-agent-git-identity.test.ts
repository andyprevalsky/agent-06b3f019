#!/usr/bin/env tsx
/**
 * Owning regression: code-agent commits are authored by the GitHub account
 * whose token pushes them, never by an address GitHub cannot link.
 *
 * Failure (2026-11-12): every sandbox configured `Rose Agent <agent@roselabs.ai>`.
 * GitHub links no account to that email (the commit's `author` is null), so
 * Vercel refused each such main HEAD with "GitHub couldn't verify an account
 * for the commit" and production stayed on an old front-end build.
 *
 * Invariants:
 *  - the identity comes from GET /user with the exact pushing token, as the
 *    account's GitHub no-reply address (`<id>+<login>@users.noreply.github.com`);
 *  - author and committer are both set (Vercel and GitHub read either);
 *  - one GitHub call per token per process; a failure is retried, not cached;
 *  - an unresolvable account fails the spawn instead of committing as nobody;
 *  - both cloud spawn paths (Claude Code, Codex) give these envs to the sandbox.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';

import {
  codeSandboxGithubEnvs,
  codeSandboxGitIdentityEnvs,
  GitCommitIdentityError,
  githubNoreplyEmail,
  resetGitCommitIdentityCacheForTests,
  resolveGitCommitIdentity,
} from '../../providers/codeAgentGitIdentity';

interface Call {
  url: string;
  authorization: string | null;
}

function fakeGithub(responses: Record<string, { status: number; body: unknown }>): {
  fetchImpl: typeof fetch;
  calls: Call[];
} {
  const calls: Call[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : input.toString();
    const authorization = new Headers(init?.headers).get('Authorization');
    calls.push({ url, authorization });
    const token = (authorization ?? '').replace(/^Bearer /, '');
    const answer = responses[token] ?? { status: 401, body: { message: 'Bad credentials' } };
    return new Response(JSON.stringify(answer.body), { status: answer.status });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

const ANDY = { id: 25310436, login: 'andyprevalsky', name: null, type: 'User' };

test('the pushing token resolves to its account no-reply address, author and committer', async () => {
  resetGitCommitIdentityCacheForTests();
  const github = fakeGithub({ 'push-token': { status: 200, body: ANDY } });
  const envs = await codeSandboxGitIdentityEnvs(
    'https://github.com/Rose-Ai-Labs/rose',
    'push-token',
    github.fetchImpl
  );
  assert.deepEqual(envs, {
    GIT_AUTHOR_NAME: 'andyprevalsky',
    GIT_AUTHOR_EMAIL: '25310436+andyprevalsky@users.noreply.github.com',
    GIT_COMMITTER_NAME: 'andyprevalsky',
    GIT_COMMITTER_EMAIL: '25310436+andyprevalsky@users.noreply.github.com',
  });
  assert.equal(github.calls.length, 1);
  assert.equal(github.calls[0].url, 'https://api.github.com/user');
  assert.equal(github.calls[0].authorization, 'Bearer push-token', 'asks about the pushing token');
  for (const value of Object.values(envs)) {
    assert.doesNotMatch(value, /agent@roselabs\.ai|Rose Agent/);
  }
});

test('a profile name is used as the author name; the email stays the linked no-reply', async () => {
  resetGitCommitIdentityCacheForTests();
  const github = fakeGithub({
    named: { status: 200, body: { id: 7, login: 'octo', name: '  Octo Cat ' } },
  });
  const identity = await resolveGitCommitIdentity('named', github.fetchImpl);
  assert.deepEqual(identity, {
    login: 'octo',
    name: 'Octo Cat',
    email: githubNoreplyEmail(7, 'octo'),
  });
  assert.equal(identity.email, '7+octo@users.noreply.github.com');
});

test('one GitHub call per token per process; different tokens resolve separately', async () => {
  resetGitCommitIdentityCacheForTests();
  const github = fakeGithub({
    a: { status: 200, body: { id: 1, login: 'a-user' } },
    b: { status: 200, body: { id: 2, login: 'b-user' } },
  });
  const [first, second] = await Promise.all([
    resolveGitCommitIdentity('a', github.fetchImpl),
    resolveGitCommitIdentity('a', github.fetchImpl),
  ]);
  await resolveGitCommitIdentity('a', github.fetchImpl);
  const other = await resolveGitCommitIdentity('b', github.fetchImpl);
  assert.equal(first, second);
  assert.equal(other.login, 'b-user');
  assert.deepEqual(
    github.calls.map((call) => call.authorization),
    ['Bearer a', 'Bearer b']
  );
});

test('an unresolvable account fails loudly, is not cached, and leaks no token', async () => {
  resetGitCommitIdentityCacheForTests();
  let healthy = false;
  const calls: string[] = [];
  const fetchImpl = (async (_input: string | URL | Request, init?: RequestInit) => {
    calls.push(new Headers(init?.headers).get('Authorization') ?? '');
    return healthy
      ? new Response(JSON.stringify(ANDY), { status: 200 })
      : new Response(JSON.stringify({ message: 'API rate limit exceeded' }), { status: 403 });
  }) as typeof fetch;
  await assert.rejects(
    codeSandboxGitIdentityEnvs('https://github.com/o/r', 'secret-token-123', fetchImpl),
    (error: unknown) =>
      error instanceof GitCommitIdentityError &&
      /403/.test(error.message) &&
      !error.message.includes('secret-token-123')
  );
  healthy = true;
  const envs = await codeSandboxGitIdentityEnvs(
    'https://github.com/o/r',
    'secret-token-123',
    fetchImpl
  );
  assert.equal(envs.GIT_AUTHOR_EMAIL, '25310436+andyprevalsky@users.noreply.github.com');
  assert.equal(calls.length, 2, 'the failure was retried on the next spawn');

  const unreachable = (async () => {
    throw new Error('getaddrinfo ENOTFOUND api.github.com');
  }) as typeof fetch;
  await assert.rejects(
    resolveGitCommitIdentity('other-token', unreachable),
    /GitHub \/user unreachable: getaddrinfo ENOTFOUND/
  );
  const malformed = fakeGithub({ odd: { status: 200, body: { login: 'no-id' } } });
  await assert.rejects(
    resolveGitCommitIdentity('odd', malformed.fetchImpl),
    /no account id\/login/
  );
});

test('a session with nothing to push gets no identity and makes no GitHub call', async () => {
  resetGitCommitIdentityCacheForTests();
  const github = fakeGithub({});
  assert.deepEqual(await codeSandboxGitIdentityEnvs(undefined, 't', github.fetchImpl), {});
  assert.deepEqual(await codeSandboxGitIdentityEnvs(null, 't', github.fetchImpl), {});
  assert.deepEqual(await codeSandboxGitIdentityEnvs('  ', 't', github.fetchImpl), {});
  assert.deepEqual(
    await codeSandboxGitIdentityEnvs('https://github.com/o/r', '', github.fetchImpl),
    {},
    'no token: nothing pushes, nothing to resolve'
  );
  assert.equal(github.calls.length, 0);
});

test('a sandbox gets the push credential and the identity of the account behind it', async () => {
  resetGitCommitIdentityCacheForTests();
  const saved = process.env.GITHUB_TOKEN;
  process.env.GITHUB_TOKEN = 'push-token';
  try {
    const github = fakeGithub({ 'push-token': { status: 200, body: ANDY } });
    const repoSession = await codeSandboxGithubEnvs(
      'https://github.com/Rose-Ai-Labs/rose',
      null,
      '',
      github.fetchImpl
    );
    assert.equal(repoSession.GITHUB_REPO_URL, 'https://github.com/Rose-Ai-Labs/rose');
    assert.equal(repoSession.GITHUB_TOKEN, 'push-token');
    assert.equal(repoSession.GIT_AUTHOR_EMAIL, '25310436+andyprevalsky@users.noreply.github.com');
    assert.equal(
      repoSession.GIT_COMMITTER_EMAIL,
      '25310436+andyprevalsky@users.noreply.github.com'
    );

    // A project session clones its repo with the same token (projects/session.ts):
    // it gets the identity, while its credential travels in the clone URL.
    const projectSession = await codeSandboxGithubEnvs(
      undefined,
      'https://github.com/Rose-Ai-Labs/rose',
      'Codex',
      github.fetchImpl
    );
    assert.equal(projectSession.GITHUB_TOKEN, undefined);
    assert.equal(projectSession.GIT_AUTHOR_NAME, 'andyprevalsky');
    assert.deepEqual(await codeSandboxGithubEnvs(undefined, null, '', github.fetchImpl), {});
    assert.equal(github.calls.length, 1, 'the identity is resolved once for both sessions');

    delete process.env.GITHUB_TOKEN;
    await assert.rejects(
      codeSandboxGithubEnvs('https://github.com/o/r', null, '', github.fetchImpl),
      /GITHUB_TOKEN not configured/
    );
  } finally {
    if (saved === undefined) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = saved;
  }
});

test('both cloud spawn paths give the sandbox these envs before acquiring it', () => {
  const source = readFileSync(resolve(__dirname, '../../providers/e2b.ts'), 'utf8');
  for (const [name, next, label] of [
    ['createClaudeCodeSession', 'export async function createCodexCodeSession', "''"],
    ['createCodexCodeSession', null, "'Codex'"],
  ] as const) {
    const start = source.indexOf(`export async function ${name}(`);
    assert.ok(start >= 0, `${name} exists`);
    const end = next === null ? source.length : source.indexOf(next, start);
    const body = source.slice(start, end);
    const inject = body.indexOf(
      `await codeSandboxGithubEnvs(githubRepoUrl, projectWorkspace?.project.repoUrl, ${label})`
    );
    assert.ok(inject >= 0, `${name} merges the GitHub envs and identity into the sandbox envs`);
    const acquire = body.indexOf('acquireCodeSandbox(');
    assert.ok(acquire > inject, `${name} injects them before the sandbox is acquired`);
  }
});
