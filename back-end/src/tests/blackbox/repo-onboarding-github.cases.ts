/**
 * `rose github status|import` (the user's own GitHub credential), registered by
 * repo-onboarding.blackbox.ts, which owns the fixture checkouts, the CLI path and
 * the sync key pair. A fake API; a fake `gh` first on PATH; no inherited git
 * credential helpers (an isolated HOME and git config).
 *
 *   status ─► GET /api/projects/github-credential?repo=<origin> ─► can Rose reach it, how to fix
 *   import ─► gh auth token | git credential fill ─► sync-key envelope ─► PUT …/github-credential
 *             (the token is never printed, never sent in the clear)
 */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';

const run = promisify(execFile);

export function registerGithubCliCases(ctx: {
  root: string;
  cli: string;
  fixture: (label: string, remote?: string) => string;
  decrypt: (encoded: string) => string;
  publicKeyPem: () => string;
}): void {
  const GITHUB_TOKEN_FIXTURE = `gho_${'f'.repeat(36)}`;
  async function withGithubApi<T>(
    access: string,
    fn: (
      api: string,
      seen: { queries: string[]; uploads: Array<Record<string, string>> }
    ) => Promise<T>
  ) {
    const seen = { queries: [] as string[], uploads: [] as Array<Record<string, string>> };
    const server = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      if (req.method === 'HEAD' && req.url === '/') {
        res.end();
        return;
      }
      const url = new URL(req.url ?? '/', 'http://fixture');
      res.setHeader('Content-Type', 'application/json');
      const account = { connected: true, login: 'octo', scopes: ['repo'], verifiedAt: 'now' };
      if (url.pathname === '/api/projects/sync-key') {
        res.end(
          JSON.stringify({
            keyId: 'test-key',
            publicKeyPem: ctx.publicKeyPem(),
          })
        );
      } else if (url.pathname === '/api/projects/github-credential' && req.method === 'PUT') {
        seen.uploads.push(JSON.parse(Buffer.concat(chunks).toString()));
        res.end(JSON.stringify(account));
      } else if (url.pathname === '/api/projects/github-credential') {
        seen.queries.push(url.searchParams.get('repo') ?? '');
        res.end(
          JSON.stringify({
            ...account,
            repo: {
              repoUrl: 'https://github.com/example/app',
              canonicalRef: 'gh:example/app',
              access,
              ...(access === 'none' ? { reason: 'Access denied: example/app is private.' } : {}),
            },
          })
        );
      } else {
        res.statusCode = 404;
        res.end(JSON.stringify({ error: 'not found' }));
      }
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const address = server.address();
    assert(address && typeof address === 'object');
    try {
      return await fn(`http://127.0.0.1:${address.port}`, seen);
    } finally {
      await new Promise<void>((r, j) => server.close((e) => (e ? j(e) : r())));
    }
  }
  /** A shell with a fake `gh` first on PATH and no inherited git credential helpers. */
  function githubShell(label: string, gh: 'token' | 'logged-out', helperToken?: string) {
    const bin = join(ctx.root, `${label}-bin`);
    mkdirSync(bin);
    writeFileSync(
      join(bin, 'gh'),
      gh === 'token'
        ? `#!/bin/sh\n[ "$1 $2" = "auth token" ] && echo ${GITHUB_TOKEN_FIXTURE} && exit 0\nexit 1\n`
        : '#!/bin/sh\necho "You are not logged into any GitHub hosts." >&2\nexit 1\n',
      { mode: 0o755 }
    );
    return {
      ...process.env,
      PATH: `${bin}:${process.env.PATH ?? ''}`,
      HOME: join(ctx.root, `${label}-home`),
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
      ...(helperToken !== undefined
        ? {
            GIT_CONFIG_COUNT: '1',
            GIT_CONFIG_KEY_0: 'credential.helper',
            GIT_CONFIG_VALUE_0: `!f() { test "$1" = get && echo username=x-access-token && echo password=${helperToken}; }; f`,
          }
        : {}),
      ROSE_TOKEN: '',
      ROSE_API_KEY: 'personal-api-key',
      ROSE_USER_ID: '',
    };
  }
  function github(dir: string, api: string, env: NodeJS.ProcessEnv, ...args: string[]) {
    return run(process.execPath, [ctx.cli, 'github', ...args, '--dir', dir, '--api', api], {
      env,
      timeout: 60_000,
    });
  }
  test('github status says whether Rose can reach the checkout origin and how to fix it', async () => {
    const dir = ctx.fixture('gh-status', 'git@github.com:example/app.git');
    const env = githubShell('gh-status', 'logged-out');
    await withGithubApi('none', async (api, seen) => {
      const result = await github(dir, api, env, 'status');
      assert.deepEqual(seen.queries, ['git@github.com:example/app.git'], 'asks about the origin');
      assert.match(result.stdout, /Rose cannot reach example\/app: Access denied/);
      assert.match(result.stdout, /github import/);
      assert.match(result.stdout, /never printed/);
      const json = await github(dir, api, env, 'status', '--json');
      assert.equal(JSON.parse(json.stdout).access, 'none');
    });
    await withGithubApi('user_credential', async (api) => {
      const result = await github(dir, api, env, 'status');
      assert.match(result.stdout, /Rose can reach example\/app with your GitHub account octo/);
    });
  });
  test('github import uploads the gh credential encrypted and never prints it', async () => {
    const dir = ctx.fixture('gh-import');
    const env = githubShell('gh-import', 'token');
    await withGithubApi('none', async (api, seen) => {
      const result = await github(dir, api, env, 'import', '--json');
      assert.equal(seen.uploads.length, 1);
      assert.equal(seen.uploads[0].keyId, 'test-key');
      assert.equal(ctx.decrypt(seen.uploads[0].encryptedToken), GITHUB_TOKEN_FIXTURE);
      assert(!JSON.stringify(seen.uploads).includes(GITHUB_TOKEN_FIXTURE), 'sent encrypted only');
      assert(!`${result.stdout}${result.stderr}`.includes(GITHUB_TOKEN_FIXTURE), 'never printed');
      const body = JSON.parse(result.stdout);
      assert.equal(body.login, 'octo');
      assert.equal(body.source, 'gh');
    });
  });
  test('github import falls back to git credential fill, and says so when there is none', async () => {
    const dir = ctx.fixture('gh-fallback');
    const helperToken = `ghp_${'h'.repeat(36)}`;
    await withGithubApi('none', async (api, seen) => {
      const result = await github(
        dir,
        api,
        githubShell('gh-helper', 'logged-out', helperToken),
        'import'
      );
      assert.equal(ctx.decrypt(seen.uploads[0].encryptedToken), helperToken);
      assert.match(result.stdout, /from git credential fill/);
      assert(!`${result.stdout}${result.stderr}`.includes(helperToken), 'never printed');
      await assert.rejects(
        github(dir, api, githubShell('gh-none', 'logged-out'), 'import'),
        /No GitHub credential found on this computer.*gh auth login/s
      );
      assert.equal(seen.uploads.length, 1, 'nothing uploaded without a credential');
    });
  });
}
