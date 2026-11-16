/**
 * Repositories shared through a team, as the teammate's GET /api/projects
 * lists them (registered by projects.blackbox.ts, real HTTP + local Postgres).
 *
 *   owner ─PUT /api/teams/:id/projects/:projectId─► TeamProjectShare
 *   teammate GET /api/projects ─► own rows (shared: null), then each shared
 *        repository once: shared {ownerName, teamName}, isFolder false, no env
 *        files, scripts or subfolders; a shared plain folder is not a repository
 *   valid only while the teammate's and the owner's memberships are ACCEPTED and
 *   the owner still owns the project; every other route stays owner-only (404);
 *   a CLI credential (rose push) never lists a teammate's repository
 */
// First import: refuses a non-local DATABASE_URL before any module can query.
import {
  anonymousSession,
  apiKeyHeaders,
  assert,
  call,
  expectStatus,
  type Session,
} from './projects-harness';
import { randomBytes, randomUUID } from 'crypto';
import { test } from 'node:test';
import { prisma } from '../../providers/database';
import { join, team, user, type User } from './teams-harness';

interface Row {
  id: string;
  name: string;
  repoUrl: string | null;
  isFolder: boolean;
  isRepository: boolean;
  shared: { ownerName: string; teamName: string } | null;
  envFileCount: number;
  startupScript: string | null;
  maintenance: { script: string | null };
  folders: unknown[];
}

const SECRET = `shared-secret-${randomBytes(10).toString('hex')}`;

/** A signed-in session whose account can join teams (named, with an email). */
async function teammateSession(name: string): Promise<Session & User> {
  const session = await anonymousSession();
  const email = `shared-${session.userId}@example.test`;
  await prisma.user.update({
    where: { userId: session.userId },
    data: { email, name, isAnonymous: false },
  });
  // Anonymous sessions are keyed by a server-minted UUID, the same shape teams-harness users have.
  return { ...session, userId: session.userId as User['userId'], email };
}

function ownerCall(owner: User, path: string, method = 'GET', body?: unknown) {
  return call(path, { method, body, headers: apiKeyHeaders(owner.userId) });
}

async function ownerCreate(owner: User, path: string, body: Record<string, unknown>) {
  const res = await ownerCall(owner, path, 'POST', body);
  expectStatus(res, 201, `owner POST ${path}`);
  return res.data.id as string;
}

async function share(owner: User, teamId: string, projectId: string): Promise<void> {
  expectStatus(
    await ownerCall(owner, `/api/teams/${teamId}/projects/${projectId}`, 'PUT', {}),
    200,
    'share project'
  );
}

async function list(auth: string): Promise<{ rows: Row[]; text: string }> {
  const res = await call('/api/projects', { auth });
  expectStatus(res, 200, 'list projects');
  return { rows: res.data.projects as Row[], text: res.text };
}

async function sharedIds(s: Session): Promise<string[]> {
  return (await list(s.token)).rows.filter((row) => row.shared !== null).map((row) => row.id);
}

test('shared repositories: a teammate lists them once, read-only, without owner secrets', async () => {
  const owner = await user('Owner Name');
  const member = await teammateSession('Member');
  const outsider = await anonymousSession();
  const teamA = String((await team(owner, 'Design Team')).id);
  const teamB = String((await team(owner, 'Second Team')).id);
  await join(owner, member, teamA);
  await join(owner, member, teamB);

  const repoUrl = `https://github.com/sh${randomBytes(4).toString('hex')}/app`;
  const repo = await ownerCreate(owner, '/api/projects', {
    name: 'Shared repo',
    repoUrl,
    startupScript: 'echo PRIVATE-SCRIPT',
    maintenance: { script: 'echo PRIVATE-SYNC' },
  });
  await ownerCreate(owner, `/api/projects/${repo}/env-files`, {
    path: '.env',
    variables: [{ name: 'TOKEN', value: SECRET }],
  });
  await ownerCreate(owner, `/api/projects/${repo}/folders`, { name: 'PRIVATE-SUBFOLDER' });
  const plainFolder = await ownerCreate(owner, '/api/folders', { name: 'Shared folder' });
  const syncedFolder = await ownerCreate(owner, '/api/folders', { name: 'Synced folder' });
  await prisma.project.update({ where: { id: syncedFolder }, data: { syncRevision: 1 } });
  const unshared = await ownerCreate(owner, '/api/projects', { name: 'Not shared' });
  await share(owner, teamA, repo);
  await share(owner, teamB, repo);
  await share(owner, teamA, plainFolder);
  await share(owner, teamB, syncedFolder);

  const mine = await call('/api/projects', {
    method: 'POST',
    auth: member.token,
    body: { name: 'Shared repo' },
  });
  expectStatus(mine, 201, "the teammate's own project of the same name");

  const { rows, text } = await list(member.token);
  const own = rows.filter((row) => row.shared === null);
  assert(
    own.length === 1 && own[0].id === mine.data.id,
    `own rows first, unchanged: ${JSON.stringify(own)}`
  );
  const shared = rows.filter((row) => row.shared !== null);
  assert(
    JSON.stringify(shared.map((row) => row.id)) === JSON.stringify([repo, syncedFolder]),
    `each shared repository once, plain folders and unshared rows never: ${JSON.stringify(shared)}`
  );
  const [sharedRepo, sharedSynced] = shared;
  assert(
    JSON.stringify(sharedRepo.shared) ===
      JSON.stringify({ ownerName: 'Owner Name', teamName: 'Design Team' }) &&
      JSON.stringify(sharedSynced.shared) ===
        JSON.stringify({ ownerName: 'Owner Name', teamName: 'Second Team' }),
    `owner and team names: ${JSON.stringify(shared.map((row) => row.shared))}`
  );
  for (const row of shared) {
    assert(
      row.isFolder === false &&
        row.isRepository === true &&
        row.envFileCount === 0 &&
        row.startupScript === null &&
        row.maintenance.script === null &&
        row.folders.length === 0,
      `read-only repository without owner settings: ${JSON.stringify(row)}`
    );
  }
  assert(sharedRepo.repoUrl === repoUrl && sharedRepo.name === 'Shared repo', 'its repo and name');
  assert(
    !text.includes(SECRET) && !text.includes('PRIVATE-') && !text.includes(unshared),
    'no env value, script, subfolder or unshared project reaches the teammate'
  );
  const memberFolders = await call('/api/folders', { auth: member.token });
  expectStatus(memberFolders, 200, 'teammate folders');
  assert(
    (memberFolders.data.folders as unknown[]).length === 0,
    'a shared row is never a folder of the teammate'
  );

  const ownerList = await ownerCall(owner, '/api/projects');
  const ownerRows = ownerList.data.projects as Row[];
  assert(
    ownerRows.length === 4 &&
      new Set(ownerRows.map((row) => row.id)).size === 4 &&
      ownerRows.every((row) => row.shared === null),
    `the owner sees their own rows once, never as shared: ${ownerList.text}`
  );
  assert((await list(outsider.token)).rows.length === 0, 'someone outside the teams sees nothing');

  // Every route but the list stays owner-only: the teammate gets the 404 a missing project gets.
  const fileId = (
    await prisma.projectEnvFile.findFirstOrThrow({
      where: { projectId: repo },
      select: { id: true },
    })
  ).id;
  const syncBody = { baseRevision: 0, keyId: 'k', manifest: {}, files: [] };
  for (const [method, path, body] of [
    ['GET', `/api/projects/${repo}`],
    ['PUT', `/api/projects/${repo}`, { startupTimeoutS: 5 }],
    ['DELETE', `/api/projects/${repo}`],
    ['GET', `/api/projects/${repo}/env-files`],
    ['POST', `/api/projects/${repo}/env-files`, { path: '.env.other' }],
    [
      'PUT',
      `/api/projects/${repo}/env-files/${fileId}`,
      { variables: [{ name: 'X', value: 'y' }] },
    ],
    ['DELETE', `/api/projects/${repo}/env-files/${fileId}`],
    ['GET', `/api/projects/${repo}/sync`],
    ['POST', `/api/projects/${repo}/sync`, syncBody],
    ['POST', `/api/projects/${repo}/folders`, { name: 'Mine' }],
    ['GET', `/api/folders/${repo}`],
    ['PATCH', `/api/folders/${repo}`, { name: 'Renamed' }],
    ['DELETE', `/api/folders/${repo}`],
  ] as Array<[string, string, unknown?]>) {
    expectStatus(await call(path, { method, body, auth: member.token }), 404, `${method} ${path}`);
  }
  const untouched = await prisma.project.findUniqueOrThrow({
    where: { id: repo },
    include: { _count: { select: { envFiles: true, folders: true } } },
  });
  assert(
    untouched.userId === owner.userId &&
      untouched.name === 'Shared repo' &&
      untouched.startupTimeoutS === 120 &&
      untouched._count.envFiles === 1 &&
      untouched._count.folders === 1,
    `the owner's project is untouched: ${JSON.stringify(untouched)}`
  );

  // A CLI credential pushes the teammate's own projects only.
  const minted = await call('/api/projects/cli-login-codes', {
    method: 'POST',
    auth: member.token,
    body: {},
  });
  expectStatus(minted, 201, 'mint a CLI code');
  const exchanged = await call('/api/projects/cli-login-codes/exchange', {
    method: 'POST',
    body: { code: minted.data.code },
    headers: { 'X-Forwarded-For': `198.51.100.${randomBytes(4).toString('hex')}` },
  });
  expectStatus(exchanged, 200, 'exchange the CLI code');
  const viaCli = await list(exchanged.data.credential as string);
  assert(
    JSON.stringify(viaCli.rows.map((row) => row.id)) === JSON.stringify([mine.data.id]),
    `the CLI lists no shared repository: ${viaCli.text}`
  );
});

test('shared repositories: listed only while both memberships are accepted and the owner owns it', async () => {
  const owner = await user('Owner');
  const member = await teammateSession('Member');
  const other = await user('Someone else');
  const teamId = String((await team(owner, 'Team')).id);
  await join(owner, member, teamId);
  const repo = await ownerCreate(owner, '/api/projects', {
    name: `Repo ${randomUUID().slice(0, 8)}`,
    repoUrl: 'https://github.com/acme/app',
  });
  await share(owner, teamId, repo);
  assert(JSON.stringify(await sharedIds(member)) === JSON.stringify([repo]), 'listed');

  const membership = (userId: string) =>
    prisma.teamMember.findUniqueOrThrow({ where: { teamId_userId: { teamId, userId } } });
  const setStatus = (userId: string, status: string) =>
    prisma.teamMember.update({ where: { teamId_userId: { teamId, userId } }, data: { status } });

  await setStatus(owner.userId, 'INVITED');
  assert(
    (await sharedIds(member)).length === 0,
    "not while the owner's membership is not accepted"
  );
  await setStatus(owner.userId, 'ACCEPTED');
  await setStatus(member.userId, 'INVITED');
  assert((await sharedIds(member)).length === 0, "not while the teammate's is not accepted");
  await setStatus(member.userId, 'ACCEPTED');
  await prisma.project.update({ where: { id: repo }, data: { userId: other.userId } });
  assert((await sharedIds(member)).length === 0, 'not once the owner no longer owns it');
  await prisma.project.update({ where: { id: repo }, data: { userId: owner.userId } });
  assert(JSON.stringify(await sharedIds(member)) === JSON.stringify([repo]), 'listed again');

  const memberRow = await membership(member.userId);
  expectStatus(
    await ownerCall(owner, `/api/teams/${teamId}/members/${memberRow.id}`, 'DELETE'),
    204,
    'owner removes the teammate'
  );
  assert((await sharedIds(member)).length === 0, 'not after leaving the team');
});
