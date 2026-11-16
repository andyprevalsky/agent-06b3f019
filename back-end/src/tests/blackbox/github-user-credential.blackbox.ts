#!/usr/bin/env tsx
/**
 * A user's own GitHub credential, and projects shared at spawn
 * (docs/plans/completed/projects-are-repos.md, round 4), over HTTP + local Postgres.
 * GitHub is a fetch stub in this process; the credential routes run on an
 * in-process app (so the stub answers their verification), agent placement on
 * the isolated test backend.
 *
 *   PUT /api/projects/github-credential {keyId, encryptedToken} ─► verified (GET /user) ─► stored
 *   GET  …/github-credential[?repo=]  login + scopes (never the token), can Rose reach the repo
 *   DELETE …/github-credential        user only (a rose_cli_ login is refused)
 *   checkGithubRepoAccess ─► the user's token can push ─► allowed (never a stored grant:
 *     access follows the live credential, so removing it denies the private repo at once)
 *   code session (both modes) ─► clone/push token, GH_TOKEN and commit identity are the user's
 *
 *   TeamProjectShare (accepted members, sharer still a member, still the sharer's project)
 *     github_repo_ref=<shared id> ─► teammate's agent placed there; its session restores the
 *     owner's code and settings, never the owner's env files, template snapshot or credential
 *
 * Usage: bash scripts/run-blackbox-tests.sh github-user-credential
 */
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { after, test } from 'node:test';

const USER_TOKEN = `ghp_user_${randomBytes(12).toString('hex')}`;
const OWNER_TOKEN = `ghp_owner_${randomBytes(12).toString('hex')}`;
const PLATFORM_TOKEN = `platform-${randomBytes(8).toString('hex')}`;
const SLUG = `bbcred${randomBytes(4).toString('hex')}`;
const PRIVATE = `${SLUG}/private`;
const READONLY = `${SLUG}/readonly`;
const PUBLIC = `${SLUG}/public-tool`;
// The test process's own pushes and clones use this platform token, never the .env one.
process.env.GITHUB_TOKEN = PLATFORM_TOKEN;
process.env.GITHUB_DISPATCH_TOKEN = '';

const accounts: Record<string, { id: number; login: string; name: string; push: string[] }> = {
  [USER_TOKEN]: { id: 101, login: 'cred-user', name: 'Cred User', push: [PRIVATE] },
  [OWNER_TOKEN]: { id: 202, login: 'cred-owner', name: 'Cred Owner', push: [PRIVATE, PUBLIC] },
  [PLATFORM_TOKEN]: { id: 1, login: 'rose-platform', name: 'Rose', push: [] },
};
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (url.hostname !== 'api.github.com') return realFetch(input, init);
  const token = (new Headers(init?.headers).get('Authorization') ?? '').replace(/^Bearer /, '');
  const account = accounts[token];
  const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), { status, headers });
  if (url.pathname === '/user') {
    return account === undefined
      ? json(401, { message: 'Bad credentials' })
      : json(200, account, { 'x-oauth-scopes': 'repo, read:org' });
  }
  const repo = /^\/repos\/([^/]+\/[^/]+)$/.exec(url.pathname)?.[1];
  if (repo === PUBLIC) {
    return json(200, {
      private: false,
      permissions: { push: account?.push.includes(PUBLIC) ?? false },
    });
  }
  if (repo === PRIVATE || repo === READONLY) {
    if (account === undefined || account === accounts[PLATFORM_TOKEN]) {
      return json(200, { private: true });
    }
    return json(200, { private: true, permissions: { push: account.push.includes(repo) } });
  }
  return json(404, { message: 'Not Found' });
}) as typeof fetch;

async function main(): Promise<void> {
  // First import: refuses a non-local DATABASE_URL before any module can query.
  const harness = await import('./projects-harness');
  const { anonymousSession, apiKeyHeaders, call, expectStatus } = harness;
  const express = (await import('express')).default;
  const { prisma } = await import('../../providers/database');
  const { default: credentialRouter } =
    await import('../../domains/projects/routes.githubCredential');
  const { checkGithubRepoAccess } = await import('../../providers/github');
  const { codeSandboxGithubEnvs, resetGitCommitIdentityCacheForTests } =
    await import('../../providers/codeAgentGitIdentity');
  const { resetGithubUserCredentialCacheForTests } =
    await import('../../providers/githubUserCredentials');
  const { encryptProjectBinary, encryptProjectSecret, projectSyncKeyId } =
    await import('../../providers/projects/secrets');
  const { writeSyncSnapshot } = await import('../../providers/projects/store');
  const { prepareSessionProject } = await import('../../providers/projects/session');
  const { resolveCodeSessionWorkspace, GithubRepoRefNotFoundError } =
    await import('../../providers/githubRepos/resolve');

  const app = express();
  app.use(express.json());
  app.use('/api/projects/github-credential', credentialRouter);
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const local = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  after(async () => {
    server.close();
    globalThis.fetch = realFetch;
    await prisma.$disconnect();
  });
  async function credential(
    method: string,
    headers: Record<string, string>,
    body?: unknown,
    query = ''
  ) {
    const res = await realFetch(`${local}/api/projects/github-credential${query}`, {
      method,
      headers: { 'content-type': 'application/json', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, text, data: text === '' ? {} : JSON.parse(text) };
  }
  const envelope = (token: string) => ({
    keyId: projectSyncKeyId(),
    encryptedToken: encryptProjectSecret(token),
  });
  const owned = (userId: string, name: string, extra: Record<string, unknown> = {}) =>
    prisma.project.create({ data: { userId, name, syncSalt: 'salt', ...extra } });
  const reset = () => {
    resetGithubUserCredentialCacheForTests();
    resetGitCommitIdentityCacheForTests();
  };
  const ok = async <T extends { status: number; text: string }>(
    work: Promise<T>,
    label: string
  ) => {
    const res = await work;
    assert.equal(res.status, 200, `${label}: ${res.text.slice(0, 300)}`);
    return res;
  };
  const refusal = (work: Promise<unknown>) =>
    work.then(
      () => null,
      (error: unknown) => error
    );

  test('github credential: imported encrypted, verified with GitHub, never returned', async () => {
    reset();
    const s = await anonymousSession();
    const asUser = apiKeyHeaders(s.userId);
    assert.deepEqual((await ok(credential('GET', asUser), 'status')).data, {
      connected: false,
      login: null,
      scopes: [],
      verifiedAt: null,
    });
    const rejected = await credential('PUT', asUser, envelope('ghp_not_a_real_token'));
    assert.equal(rejected.status, 400, rejected.text);
    assert.equal(rejected.data.code, 'GITHUB_CREDENTIAL_REJECTED');
    const stale = await credential('PUT', asUser, { ...envelope(USER_TOKEN), keyId: 'old-key' });
    assert.equal(stale.status, 409, 'a rotated sync key is refused');
    assert.equal(
      await prisma.integration.count({
        where: { userId: s.userId, name: 'github_user_credential' },
      }),
      0,
      'nothing stored for a rejected credential'
    );

    const imported = await credential('PUT', asUser, envelope(USER_TOKEN));
    assert.equal(imported.status, 200, imported.text);
    assert.equal(imported.data.login, 'cred-user');
    assert.deepEqual(imported.data.scopes, ['repo', 'read:org']);
    const status = await credential('GET', asUser);
    assert.equal(status.data.connected, true);
    const row = await prisma.integration.findFirstOrThrow({
      where: { userId: s.userId, name: 'github_user_credential' },
    });
    const surfaces = [
      imported.text,
      status.text,
      JSON.stringify(row),
      (await call('/api/integrations', { auth: s.token })).text,
      (
        await call('/api/integrations/github_user_credential', {
          method: 'PATCH',
          auth: s.token,
          body: { config: { encrypted_token: 'overwritten' } },
        })
      ).text,
    ];
    for (const text of surfaces) assert(!text.includes(USER_TOKEN), 'the token is never exposed');
    const envelopeText = (row.config as { encrypted_token: string }).encrypted_token;
    for (const text of [surfaces[0], surfaces[1], surfaces[3], surfaces[4]]) {
      assert(!text.includes(envelopeText), 'the envelope never leaves the backend');
    }
    const kept = await prisma.integration.findFirstOrThrow({ where: { id: row.id } });
    assert.equal(
      (kept.config as { encrypted_token: string }).encrypted_token,
      envelopeText,
      'a generic integration update cannot overwrite it'
    );

    // A CLI login may import and read, never delete; the user can.
    const minted = await call('/api/projects/cli-login-codes', {
      method: 'POST',
      auth: s.token,
      body: {},
    });
    expectStatus(minted, 201, 'mint');
    const exchanged = await call('/api/projects/cli-login-codes/exchange', {
      method: 'POST',
      body: { code: minted.data.code },
      headers: { 'X-Forwarded-For': `198.51.100.${randomBytes(1)[0]}` },
    });
    const cli = { Authorization: `Bearer ${exchanged.data.credential as string}` };
    assert.equal((await credential('GET', cli)).data.login, 'cred-user', 'CLI login reads status');
    assert.equal((await credential('DELETE', cli)).status, 403, 'CLI login cannot delete');
    assert.deepEqual((await credential('DELETE', asUser)).data, { deleted: true });
    assert.equal((await credential('GET', asUser)).data.connected, false);
  });

  test('github credential: the user token grants its repos and runs their code sessions as them', async () => {
    reset();
    const user = await anonymousSession();
    const other = await anonymousSession();
    const asUser = apiKeyHeaders(user.userId);
    await ok(credential('PUT', asUser, envelope(USER_TOKEN)), 'import');
    const privateUrl = `https://github.com/${PRIVATE}`;

    // Status: can Rose reach this checkout's origin (SSH spelling too), and how.
    const viaSsh = await credential(
      'GET',
      asUser,
      undefined,
      `?repo=${encodeURIComponent(`git@github.com:${PRIVATE}.git`)}`
    );
    assert.equal(viaSsh.data.repo.access, 'user_credential', viaSsh.text);
    const readonly = await credential(
      'GET',
      asUser,
      undefined,
      `?repo=https://github.com/${READONLY}`
    );
    assert.equal(readonly.data.repo.access, 'none', 'read-only access is not enough');
    assert.match(readonly.data.repo.reason, /private/);
    const notGithub = await credential('GET', asUser, undefined, '?repo=git@gitlab.com:a/b.git');
    assert.equal(notGithub.data.repo.access, 'not_github');
    const othersView = await credential(
      'GET',
      apiKeyHeaders(other.userId),
      undefined,
      `?repo=${privateUrl}`
    );
    assert.equal(othersView.data.repo.access, 'none', "another user never uses this user's token");

    const access = await checkGithubRepoAccess(user.userId, privateUrl);
    assert.equal(access.allowed, true);
    assert.equal(
      await prisma.githubRepoAccess.count({ where: { userId: user.userId, repoUrl: privateUrl } }),
      0,
      'access through the credential is never stored as a grant'
    );
    assert.equal((await checkGithubRepoAccess(other.userId, privateUrl)).allowed, false);

    // github_repo_url session: clone/push, gh and commits are the user's.
    const direct = await codeSandboxGithubEnvs(privateUrl, null, '', user.userId);
    assert.equal(direct.GITHUB_TOKEN, USER_TOKEN);
    assert.equal(direct.GH_TOKEN, USER_TOKEN);
    assert.equal(direct.GIT_AUTHOR_EMAIL, '101+cred-user@users.noreply.github.com');
    assert.equal(direct.GIT_COMMITTER_NAME, 'Cred User');
    // Project session: the clone URL carries the user's token, gh too.
    const project = await owned(user.userId, `cred-${randomUUID()}`, { repoUrl: privateUrl });
    const workspace = await prepareSessionProject(user.userId, project.id);
    assert.equal(new URL(workspace.cloneUrl!).password, USER_TOKEN, 'project clone as the user');
    const projectEnvs = await codeSandboxGithubEnvs(undefined, privateUrl, '', user.userId);
    assert.equal(projectEnvs.GH_TOKEN, USER_TOKEN);
    assert.equal(projectEnvs.GITHUB_TOKEN, undefined, 'a project session clones via its URL');
    assert.equal(projectEnvs.GIT_AUTHOR_EMAIL, '101+cred-user@users.noreply.github.com');
    // A project ref on that repo, never connected, starts on the user's own access.
    const selected = await resolveCodeSessionWorkspace(user.userId, { githubRepoRef: project.id });
    assert.equal(selected.projectWorkspace?.project.id, project.id);

    // Without a credential: the platform token, no GH_TOKEN, the platform identity.
    const platform = await codeSandboxGithubEnvs(
      `https://github.com/${PUBLIC}`,
      null,
      '',
      other.userId
    );
    assert.equal(platform.GITHUB_TOKEN, PLATFORM_TOKEN);
    assert.equal(platform.GH_TOKEN, undefined);
    assert.equal(platform.GIT_AUTHOR_EMAIL, '1+rose-platform@users.noreply.github.com');
    // Removed: the private repo is denied at once (no leftover grant), and says how to fix it;
    // the next session carries no credential for it (neither the removed token nor the
    // platform token, which was never granted this private repo).
    await credential('DELETE', asUser);
    const denied = await checkGithubRepoAccess(user.userId, privateUrl);
    assert.equal(denied.allowed, false, 'removing the credential removes its access');
    assert.match(denied.error ?? '', /Import it from your computer in the Rose Mac app/);
    const after = await prepareSessionProject(user.userId, project.id);
    assert.equal(new URL(after.cloneUrl!).password, '', 'no credential for an ungranted repo');
  });

  test('sharing at spawn: a teammate runs a shared project with its code, never the owner env or credential', async () => {
    reset();
    const owner = await anonymousSession();
    const mate = await anonymousSession();
    const invited = await anonymousSession();
    const ownerHeaders = apiKeyHeaders(owner.userId);
    await ok(credential('PUT', ownerHeaders, envelope(OWNER_TOKEN)), 'owner import');
    const team = await prisma.team.create({
      data: { name: `team-${SLUG}`, ownerUserId: owner.userId },
    });
    const member = (userId: string, status: string) =>
      prisma.teamMember.create({ data: { teamId: team.id, userId, status, role: 'MEMBER' } });
    const ownerMember = await member(owner.userId, 'ACCEPTED');
    await member(mate.userId, 'ACCEPTED');
    await member(invited.userId, 'INVITED');
    const localProject = await owned(owner.userId, `shared-local-${SLUG}`, {
      startupScript: 'echo shared',
      defaultBranch: 'trunk',
      templateSnapshotId: 'tpl-owner',
      templateSnapshotAt: new Date(),
    });
    const githubProject = await owned(owner.userId, `shared-gh-${SLUG}`, {
      repoUrl: `https://github.com/${PUBLIC}`,
    });
    const unshared = await owned(owner.userId, `unshared-${SLUG}`);
    for (const project of [localProject, githubProject]) {
      await prisma.teamProjectShare.create({
        data: { teamId: team.id, projectId: project.id, ownerUserId: owner.userId },
      });
    }
    const secret = `OWNER_SECRET=${randomBytes(8).toString('hex')}`;
    await prisma.projectEnvFile.create({
      data: {
        projectId: localProject.id,
        path: '.env',
        kind: 'env',
        source: 'sync',
        encryptedContent: encryptProjectSecret(secret),
        sizeBytes: secret.length,
        fingerprint: createHash('sha256').update(secret).digest('hex'),
        variables: [{ name: 'OWNER_SECRET' }],
      },
    });
    const bundle = Buffer.from('# v2 git bundle\nfixture\n\n');
    await writeSyncSnapshot(localProject.id, 1, {
      manifest: {
        version: 1,
        git: {
          remoteUrl: null,
          branch: 'trunk',
          headSha: null,
          unpushedCommits: 0,
          dirtyPaths: [],
          bundleKind: 'full',
        },
      },
      encryptedGitBundle: encryptProjectBinary(bundle),
      gitBundleFingerprint: 'fp',
      encryptedUncommittedPatch: null,
      patchFingerprint: null,
    });

    // The teammate's agent is placed in the shared project (single and batch create).
    const create = (s: { userId: string }, ref: string, extra: Record<string, unknown> = {}) =>
      call('/api/agents', {
        method: 'POST',
        headers: apiKeyHeaders(s.userId),
        body: {
          goal: `shared spawn ${randomBytes(4).toString('hex')}`,
          start_phase: 'execute',
          pause_state: true,
          task_queue: 'test-queue',
          github_repo_ref: ref,
          ...extra,
        },
      });
    const placed = await create(mate, localProject.id);
    expectStatus(placed, 201, 'teammate agent in a shared project');
    assert.equal(placed.data.project_id, localProject.id);
    const rootId = placed.data.agent_id as string;
    const batchChild = {
      agent_id: randomUUID(),
      goal: 'shared batch child',
      start_phase: 'execute',
      pause_state: true,
      task_queue: 'test-queue',
      parent_agent_id: rootId,
      parent_workflow_id: rootId,
      depth: 1,
      bus_id: rootId,
      github_repo_ref: `rose-project:${localProject.id}`,
    };
    const batch = await call('/api/agents/batch', {
      method: 'POST',
      headers: apiKeyHeaders(mate.userId),
      body: { agents: [batchChild] },
    });
    assert(batch.status === 201 || batch.status === 207, batch.text);
    const childRow = await prisma.agent.findUniqueOrThrow({ where: { id: batchChild.agent_id } });
    assert.equal(childRow.projectId, localProject.id);
    for (const [who, ref] of [
      [invited, localProject.id],
      [mate, unshared.id],
    ] as const) {
      const refused = await create(who, ref);
      assert(
        refused.status === 404 && refused.data.code === 'GITHUB_REPO_NOT_CONNECTED',
        `not shared: ${refused.status} ${refused.text}`
      );
    }

    // Its session: the owner's code and settings, none of the owner's secrets.
    const viaRef = await resolveCodeSessionWorkspace(mate.userId, {
      githubRepoRef: localProject.id,
    });
    const viaPlacement = await resolveCodeSessionWorkspace(mate.userId, {
      projectId: localProject.id,
    });
    for (const { projectWorkspace } of [viaRef, viaPlacement]) {
      assert.equal(projectWorkspace?.project.id, localProject.id);
      assert.equal(projectWorkspace.project.startupScript, 'echo shared');
      assert.equal(projectWorkspace.project.defaultBranch, 'trunk');
      assert.deepEqual(projectWorkspace.gitBundle, bundle, 'its synced bundle');
      assert.deepEqual(projectWorkspace.files, [], "never the owner's env files");
      assert.equal(projectWorkspace.project.templateSnapshot, null, "never the owner's template");
      assert(!JSON.stringify(projectWorkspace).includes(secret));
    }
    const ownView = await prepareSessionProject(owner.userId, localProject.id);
    assert.equal(ownView.files.length, 1, 'the owner still gets their env file');

    // A shared GitHub project clones with the teammate's own access, never the owner's token.
    const mateGithub = await resolveCodeSessionWorkspace(mate.userId, {
      githubRepoRef: githubProject.id,
    });
    assert.equal(mateGithub.projectWorkspace?.project.repoUrl, `https://github.com/${PUBLIC}`);
    assert.equal(new URL(mateGithub.projectWorkspace.cloneUrl!).password, PLATFORM_TOKEN);
    const mateEnvs = await codeSandboxGithubEnvs(
      undefined,
      `https://github.com/${PUBLIC}`,
      '',
      mate.userId
    );
    assert(!JSON.stringify(mateEnvs).includes(OWNER_TOKEN), "never the owner's credential");
    const ownerEnvs = await codeSandboxGithubEnvs(
      undefined,
      `https://github.com/${PUBLIC}`,
      '',
      owner.userId
    );
    assert.equal(ownerEnvs.GH_TOKEN, OWNER_TOKEN, "the owner's own sessions use it");

    // The share stops counting when the sharer leaves the team.
    await prisma.teamMember.update({ where: { id: ownerMember.id }, data: { status: 'REMOVED' } });
    const gone = await refusal(
      resolveCodeSessionWorkspace(mate.userId, { githubRepoRef: localProject.id })
    );
    assert(gone instanceof GithubRepoRefNotFoundError, `sharer left: ${String(gone)}`);
    await prisma.agent.updateMany({
      where: { userId: { in: [mate.userId] } },
      data: { deletedAt: new Date() },
    });
    await prisma.team.delete({ where: { id: team.id } });
  });
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
