#!/usr/bin/env tsx
/**
 * A teammate's agent uses the owner's team-shared GitHub repo (github_repo grant):
 * the repo resolves for code agents and is listed in the agent inventory, its clone
 * is checked against the OWNER's grant, and the owner's folder (project restore,
 * startup script, env files) never reaches the teammate. Unshare, owner disconnect,
 * a lost owner grant, an invited-only reader and an owner who left remove it at
 * once; a non-member never gets it.
 */
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { prisma } from '../../providers/database';
import {
  GithubRepoRefNotFoundError,
  repoAccessUserFor,
  resolveAgentRepoRef,
  resolveCodeSessionWorkspace,
  resolveGithubRepoRef,
} from '../../providers/githubRepos/resolve';
import { connectGithubRepo, disconnectGithubRepo } from '../../providers/githubRepos/store';
import { githubRepoIdentity } from '../../providers/githubRepos/refs';
import { apiKeyHeaders, call, expectStatus } from './projects-harness';
import {
  grantCount,
  ownerLeaves,
  ownerRejoins,
  randomUUID,
  share,
  teamFixture,
  unshare,
  type TeamFixture,
} from './teams-capabilities.harness';

const OWNER_STARTUP = 'echo OWNER-ONLY-STARTUP-SCRIPT';
const fixtureUsers: string[] = [];
after(async () => {
  await prisma.githubRepoConnection.deleteMany({ where: { userId: { in: fixtureUsers } } });
  await prisma.githubRepoAccess.deleteMany({ where: { userId: { in: fixtureUsers } } });
  await prisma.project.deleteMany({ where: { userId: { in: fixtureUsers } } });
});

async function ownerRepo(f: TeamFixture) {
  fixtureUsers.push(f.owner.userId, f.reader.userId);
  const slug = randomUUID().slice(0, 8);
  const repoUrl = `https://github.com/teamcap-${slug}/private-repo`;
  const folder = await prisma.project.create({
    data: {
      userId: f.owner.userId,
      name: 'Owner folder',
      repoUrl,
      syncSalt: slug,
      startupScript: OWNER_STARTUP,
    },
  });
  await prisma.githubRepoAccess.create({ data: { userId: f.owner.userId, repoUrl } });
  const connection = await connectGithubRepo({
    userId: f.owner.userId,
    identity: githubRepoIdentity(repoUrl)!,
    defaultBranch: 'main',
    connectedRoseProjectRef: folder.id,
    source: 'connect',
  });
  return { repoUrl, ref: connection.canonicalRef, integrationId: connection.integrationId, folder };
}

async function inventory(userId: string) {
  const res = await call('/api/integrations/github/repos', { headers: apiKeyHeaders(userId) });
  expectStatus(res, 200, 'repo inventory');
  return res.data.repos as Array<Record<string, unknown>>;
}

/** Everything a teammate's agent can reach of the shared repo (all must agree). */
async function readerSees(f: TeamFixture, userId: string, ref: string): Promise<boolean> {
  const resolved = await resolveGithubRepoRef(userId, ref);
  const listed = (await inventory(userId)).some((repo) => repo.canonical_ref === ref);
  const http = await call(`/api/integrations/github/repos/resolve?ref=${encodeURIComponent(ref)}`, {
    headers: apiKeyHeaders(userId),
  });
  const visible = [resolved !== null, listed, http.status === 200];
  assert(
    visible.every((seen) => seen === visible[0]),
    `inconsistent visibility ${visible}`
  );
  return visible[0];
}

async function codexCreateStatus(userId: string, ref: string) {
  return call('/api/codex-code-session/create', {
    method: 'POST',
    headers: apiKeyHeaders(userId),
    body: { agent_id: randomUUID(), goal: 'shared repo', user_id: userId, github_repo_ref: ref },
  });
}

test('shared repo resolves for an accepted teammate with owner access, never the owner folder', async () => {
  const f = await teamFixture('github');
  const repo = await ownerRepo(f);
  assert.equal(await readerSees(f, f.reader.userId, repo.ref), false, 'private before sharing');
  await share(f, repo.integrationId);
  assert.equal(await grantCount(f.reader.userId, 'github_repo'), 1);

  const listed = (await inventory(f.reader.userId)).find((row) => row.canonical_ref === repo.ref);
  assert.ok(listed, 'shared repo is in the agent inventory');
  assert.equal(listed.connected_rose_project_ref, null, 'never the owner folder');
  assert.deepEqual(listed.shared, {
    team_id: f.teamId,
    team_name: 'github team',
    owner_user_id: f.owner.userId,
    owner_name: 'github owner',
  });
  assert.ok(!JSON.stringify(listed).includes(repo.folder.id));
  const ownList = (await inventory(f.owner.userId)).find((row) => row.canonical_ref === repo.ref);
  assert.equal(ownList?.connected_rose_project_ref, repo.folder.id, 'owner keeps its folder');
  assert.equal(ownList?.shared, undefined);

  const resolved = await resolveGithubRepoRef(f.reader.userId, repo.ref);
  assert.equal(resolved?.userId, f.owner.userId);
  assert.equal(resolved?.connectedRoseProjectRef, null);
  assert.equal(resolved?.shared?.ownerUserId, f.owner.userId);
  // Every legacy spelling of the repo resolves the same shared connection.
  assert.equal(
    (await resolveGithubRepoRef(f.reader.userId, `${repo.repoUrl}.git`))?.canonicalRef,
    repo.ref
  );

  // A code agent created by the teammate persists the shared ref.
  assert.deepEqual(
    await resolveAgentRepoRef(f.reader.userId, {
      explicitRef: repo.ref,
      projectId: null,
      explicitProject: false,
      parent: null,
    }),
    { githubRepoRef: repo.ref, githubRepoUrl: repo.repoUrl }
  );

  // Code session: the repo clones under the OWNER's grant; no owner folder restores,
  // with or without the teammate's own (repo-less) project.
  const readerFolder = await prisma.project.create({
    data: { userId: f.reader.userId, name: 'Reader folder', syncSalt: randomUUID() },
  });
  for (const input of [
    { githubRepoRef: repo.ref },
    { agentRepoRef: repo.ref },
    { githubRepoRef: repo.ref, projectId: readerFolder.id },
    { agentRepoRef: repo.ref, projectId: readerFolder.id },
  ]) {
    const workspace = await resolveCodeSessionWorkspace(f.reader.userId, input);
    assert.equal(workspace.repoOverrideUrl, repo.repoUrl, JSON.stringify(input));
    assert.equal(workspace.repoAccessUserId, f.owner.userId, JSON.stringify(input));
    assert.equal(workspace.projectWorkspace, null, `owner folder leaked: ${JSON.stringify(input)}`);
    assert.equal(repoAccessUserFor(workspace, repo.repoUrl, f.reader.userId), f.owner.userId);
    assert.equal(
      repoAccessUserFor(workspace, 'https://github.com/x/y', f.reader.userId),
      f.reader.userId
    );
  }
  assert.equal(
    await prisma.githubRepoAccess.count({ where: { userId: f.reader.userId } }),
    0,
    'the teammate is never granted the private repo itself'
  );
  // The owner's own session still restores its folder (unchanged behavior).
  const ownSession = await resolveCodeSessionWorkspace(f.owner.userId, { githubRepoRef: repo.ref });
  assert.equal(ownSession.projectWorkspace?.project.startupScript, OWNER_STARTUP);
  assert.equal(ownSession.repoAccessUserId, f.owner.userId);

  // The teammate cannot disconnect the owner's repo.
  expectStatus(
    await call(`/api/integrations/github/repos/${encodeURIComponent(repo.ref)}`, {
      method: 'DELETE',
      headers: apiKeyHeaders(f.reader.userId),
    }),
    404,
    'teammate disconnect'
  );
  assert.equal(await prisma.githubRepoConnection.count({ where: { userId: f.owner.userId } }), 1);

  // Non-members and invited-only readers never see it.
  assert.equal(await readerSees(f, f.outsider.userId, repo.ref), false, 'outsider');
  assert.equal(await readerSees(f, f.invited.userId, repo.ref), false, 'invited only');
});

test('unshare, owner grant loss, disconnect and owner leaving revoke the shared repo at once', async () => {
  const f = await teamFixture('github-revoke');
  const repo = await ownerRepo(f);
  const live = () => readerSees(f, f.reader.userId, repo.ref);
  await share(f, repo.integrationId);
  assert.equal(await live(), true);

  await unshare(f, repo.integrationId);
  assert.equal(await live(), false, 'unshare');
  await assert.rejects(
    resolveCodeSessionWorkspace(f.reader.userId, { githubRepoRef: repo.ref }),
    (error: unknown) => error instanceof GithubRepoRefNotFoundError
  );
  const denied = await codexCreateStatus(f.reader.userId, repo.ref);
  expectStatus(denied, 403, 'code session after unshare');
  assert.equal(denied.data.code, 'GITHUB_ACCESS_DENIED');
  // A persisted ref falls back to the teammate's own (absent) access, never the owner's.
  const stale = await resolveCodeSessionWorkspace(f.reader.userId, { agentRepoRef: repo.ref });
  assert.equal(stale.repoOverrideUrl, undefined);
  assert.equal(stale.repoAccessUserId, undefined);

  await share(f, repo.integrationId);
  assert.equal(await live(), true, 'shared again');
  await prisma.githubRepoAccess.deleteMany({ where: { userId: f.owner.userId } });
  assert.equal(await live(), false, 'owner lost its clone grant');
  await prisma.githubRepoAccess.create({ data: { userId: f.owner.userId, repoUrl: repo.repoUrl } });
  assert.equal(await live(), true);

  assert.equal(await disconnectGithubRepo(f.owner.userId, repo.ref), true);
  assert.equal(await live(), false, 'owner disconnected');
  await connectGithubRepo({
    userId: f.owner.userId,
    identity: githubRepoIdentity(repo.repoUrl)!,
    defaultBranch: 'main',
    connectedRoseProjectRef: null,
    source: 'connect',
  });
  await share(f, repo.integrationId);
  assert.equal(await live(), true, 'reconnected and shared again');

  await ownerLeaves(f);
  assert.equal(await live(), false, 'owner left the team');
  await ownerRejoins(f);
  assert.equal(await live(), false, 'rejoining never restores the share');
});
