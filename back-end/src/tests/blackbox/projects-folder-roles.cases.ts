/**
 * Folders vs repositories, registered by projects.blackbox.ts over real HTTP +
 * local Postgres. A Project row is a left-bar folder (isFolder), a repository
 * (isRepository = repoUrl || syncRevision > 0 || !isFolder), or both:
 *
 *   POST /api/folders                    → folder (isFolder true)
 *   POST|PUT /api/projects (new row)     → repository (isFolder false); PUT on an
 *   GitHub connect / lazy link           → repository   existing name keeps its flag
 *   GET  /api/folders                    → folders only;  GET /api/projects → every owned row
 *   DELETE /api/folders/:id   both → repository stays (agents Home, subfolders gone)
 *                             folder → deleted;  repository only → 404, untouched
 *   DELETE /api/projects/:id  both → folder stays (agents, subfolders) without its repo,
 *                             env files, synced code, template snapshot or repo connection;
 *                             anything else → deleted
 *
 * GitHub is never called: every connected repo is pre-granted (GithubRepoAccess).
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
import { randomBytes } from 'crypto';
import { test } from 'node:test';
import { prisma } from '../../providers/database';
import { githubRepoIdentity } from '../../providers/githubRepos/refs';
import { connectGithubRepo } from '../../providers/githubRepos/store';

interface Row {
  id: string;
  name: string;
  repoUrl: string | null;
  isFolder: boolean;
  isRepository: boolean;
  shared: unknown;
  envFileCount: number;
}

interface FolderRow {
  id: string;
  name: string;
  subfolders: { id: string }[];
  github_repo: unknown;
}

const slugOf = () => `fr${randomBytes(5).toString('hex')}`;
const urlOf = (slug: string, repo: string) => `https://github.com/${slug}/${repo}`;

async function projects(s: Session): Promise<Row[]> {
  const res = await call('/api/projects', { auth: s.token });
  expectStatus(res, 200, 'list projects');
  return res.data.projects as Row[];
}

async function folders(s: Session): Promise<FolderRow[]> {
  const res = await call('/api/folders', { auth: s.token });
  expectStatus(res, 200, 'list folders');
  return res.data.folders as FolderRow[];
}

async function newFolder(s: Session, name: string): Promise<string> {
  const res = await call('/api/folders', { method: 'POST', auth: s.token, body: { name } });
  expectStatus(res, 201, `create folder ${name}`);
  return res.data.id as string;
}

async function subfolder(s: Session, projectId: string, name: string): Promise<string> {
  const res = await call(`/api/projects/${projectId}/folders`, {
    method: 'POST',
    auth: s.token,
    body: { name },
  });
  expectStatus(res, 201, `create subfolder ${name}`);
  return res.data.id as string;
}

async function connect(s: Session, repoUrl: string, projectId?: string): Promise<string> {
  await prisma.githubRepoAccess.createMany({
    data: [{ userId: s.userId, repoUrl }],
    skipDuplicates: true,
  });
  const res = await call('/api/integrations/github/repos', {
    method: 'POST',
    auth: s.token,
    body: {
      repo_url: repoUrl,
      ...(projectId !== undefined ? { connected_rose_project_ref: projectId } : {}),
    },
  });
  expectStatus(res, 201, `connect ${repoUrl}`);
  return res.data.connected_rose_project_ref as string;
}

async function envFile(s: Session, projectId: string): Promise<void> {
  const res = await call(`/api/projects/${projectId}/env-files`, {
    method: 'POST',
    auth: s.token,
    body: {
      path: '.env',
      variables: [{ name: 'TOKEN', value: `v-${randomBytes(6).toString('hex')}` }],
    },
  });
  expectStatus(res, 201, 'add env file');
}

async function agent(s: Session, placement: Record<string, unknown>): Promise<string> {
  const res = await call('/api/agents', {
    method: 'POST',
    headers: apiKeyHeaders(s.userId),
    body: {
      goal: `folder roles ${randomBytes(4).toString('hex')}`,
      start_phase: 'execute',
      pause_state: true,
      task_queue: 'test-queue',
      ...placement,
    },
  });
  expectStatus(res, 201, 'create agent');
  return res.data.agent_id as string;
}

const placementOf = (id: string) =>
  prisma.agent.findUniqueOrThrow({ where: { id }, select: { projectId: true, folderId: true } });

async function connectionStatus(userId: string, canonicalRef: string) {
  const [connection, integration] = await Promise.all([
    prisma.githubRepoConnection.findUnique({
      where: { userId_canonicalRef: { userId, canonicalRef } },
      select: { connectedRoseProjectRef: true },
    }),
    prisma.integration.findFirst({
      where: { userId, name: 'github_repo', accountId: canonicalRef },
      select: { status: true },
    }),
  ]);
  return { linkedTo: connection?.connectedRoseProjectRef ?? null, status: integration?.status };
}

test('folder vs repository: creation sets the role and the two lists split by it', async () => {
  const s = await anonymousSession();
  const slug = slugOf();
  const work = await newFolder(s, 'Work');
  const apiRepo = await call('/api/projects', {
    method: 'POST',
    auth: s.token,
    body: { name: 'Api repo' },
  });
  expectStatus(apiRepo, 201, 'POST /api/projects');
  const cliRepo = await call('/api/projects', {
    method: 'PUT',
    auth: s.token,
    body: { name: 'Cli repo' },
  });
  expectStatus(cliRepo, 201, 'PUT /api/projects creates');
  const upsertFolder = await call('/api/projects', {
    method: 'PUT',
    auth: s.token,
    body: { name: 'Work', startupTimeoutS: 60 },
  });
  expectStatus(upsertFolder, 200, 'PUT /api/projects on an existing folder');
  assert(
    upsertFolder.data.id === work && upsertFolder.data.isFolder === true,
    `an upsert keeps the existing row's flag: ${upsertFolder.text}`
  );
  const connected = await connect(s, urlOf(slug, 'tool'));
  // Connected before repos were projects: the list links it to a new project.
  await connectGithubRepo({
    userId: s.userId,
    identity: githubRepoIdentity(urlOf(slug, 'legacy'))!,
    defaultBranch: 'main',
    connectedRoseProjectRef: null,
    source: 'connect',
  });
  // A folder that also became a repository: by repo, and by synced code.
  const withRepo = await newFolder(s, 'Folder with repo');
  await connect(s, urlOf(slug, 'both'), withRepo);
  const synced = await newFolder(s, 'Synced folder');
  await prisma.project.update({ where: { id: synced }, data: { syncRevision: 1 } });

  const rows = await projects(s);
  const legacy = rows.find((row) => row.repoUrl === urlOf(slug, 'legacy'));
  assert(legacy !== undefined, `the lazy link created the legacy project: ${JSON.stringify(rows)}`);
  const roles = Object.fromEntries(
    rows.map((row) => [row.id, [row.isFolder, row.isRepository, row.shared]])
  );
  const expected: Record<string, [boolean, boolean, null]> = {
    [work]: [true, false, null],
    [apiRepo.data.id as string]: [false, true, null],
    [cliRepo.data.id as string]: [false, true, null],
    [connected]: [false, true, null],
    [legacy.id]: [false, true, null],
    [withRepo]: [true, true, null],
    [synced]: [true, true, null],
  };
  const sorted = (map: Record<string, unknown>) =>
    JSON.stringify(Object.entries(map).sort(([a], [b]) => a.localeCompare(b)));
  assert(
    sorted(roles) === sorted(expected),
    `roles ${JSON.stringify(roles)} expected ${JSON.stringify(expected)}`
  );
  const folderIds = (await folders(s)).map((folder) => folder.id).sort();
  assert(
    JSON.stringify(folderIds) === JSON.stringify([work, withRepo, synced].sort()),
    `GET /api/folders lists only folders: ${folderIds}`
  );
});

test('DELETE /api/folders/:id: a folder that is also a repository stays a repository', async () => {
  const s = await anonymousSession();
  const slug = slugOf();
  const repoRef = `gh:${slug}/kept`;

  // Folder only: deleted, its agents go Home.
  const plain = await newFolder(s, 'Plain');
  const plainSub = await subfolder(s, plain, 'Inside');
  const plainAgent = await agent(s, { folder_id: plainSub });
  expectStatus(
    await call(`/api/folders/${plain}`, { method: 'DELETE', auth: s.token }),
    204,
    'delete a plain folder'
  );
  assert((await prisma.project.count({ where: { id: plain } })) === 0, 'plain folder deleted');
  const plainPlacement = await placementOf(plainAgent);
  assert(
    plainPlacement.projectId === null && plainPlacement.folderId === null,
    'its agent is Home'
  );

  // Both: the folder role goes, the repository stays.
  const both = await newFolder(s, 'Both');
  assert((await connect(s, urlOf(slug, 'kept'), both)) === both, 'connected through the folder');
  await envFile(s, both);
  const sub = await subfolder(s, both, 'Sub');
  const rootAgent = await agent(s, { project_id: both });
  const subAgent = await agent(s, { folder_id: sub });
  expectStatus(
    await call(`/api/folders/${both}`, { method: 'DELETE', auth: s.token }),
    204,
    'delete a folder that is a repository'
  );
  const kept = await prisma.project.findUniqueOrThrow({ where: { id: both } });
  assert(
    kept.isFolder === false && kept.repoUrl === urlOf(slug, 'kept'),
    `the repository stays: ${JSON.stringify(kept)}`
  );
  assert(
    (await prisma.projectEnvFile.count({ where: { projectId: both } })) === 1,
    'its env files stay'
  );
  assert(
    (await prisma.projectFolder.count({ where: { projectId: both } })) === 0,
    'its subfolders are removed'
  );
  for (const id of [rootAgent, subAgent]) {
    const placement = await placementOf(id);
    assert(
      placement.projectId === null && placement.folderId === null,
      `agent ${id} is Home: ${JSON.stringify(placement)}`
    );
  }
  const repo = await connectionStatus(s.userId, repoRef);
  assert(
    repo.linkedTo === both && repo.status === 'CONNECTED',
    `its GitHub repo stays connected: ${JSON.stringify(repo)}`
  );
  assert(!(await folders(s)).some((folder) => folder.id === both), 'no longer a folder');
  const row = (await projects(s)).find((project) => project.id === both);
  assert(
    row?.isFolder === false && row.isRepository && row.envFileCount === 1,
    `still a repository: ${JSON.stringify(row)}`
  );

  // Repository only: not a folder, so the folder API leaves it alone.
  const missing = await call(`/api/folders/${both}`, { method: 'DELETE', auth: s.token });
  expectStatus(missing, 404, 'a repository that is not a folder');
  assert(missing.data.error === 'Folder not found', `error ${missing.text}`);
  assert(
    (await prisma.project.findUniqueOrThrow({ where: { id: both } })).repoUrl !== null,
    'untouched'
  );
  assert((await connectionStatus(s.userId, repoRef)).status === 'CONNECTED', 'still connected');
});

test('DELETE /api/projects/:id: a repository that is also a folder stays a folder', async () => {
  const s = await anonymousSession();
  const slug = slugOf();
  const repoRef = `gh:${slug}/stripped`;
  const both = await newFolder(s, 'Folder repo');
  assert((await connect(s, urlOf(slug, 'stripped'), both)) === both, 'connected');
  await envFile(s, both);
  const sub = await subfolder(s, both, 'Sub');
  const rootAgent = await agent(s, { project_id: both });
  const subAgent = await agent(s, { folder_id: sub });
  const now = new Date();
  await prisma.project.update({
    where: { id: both },
    data: {
      syncRevision: 3,
      lastSyncedAt: now,
      maintenanceNightly: true,
      templateSnapshotId: 'snap-current',
      templateSnapshotAt: now,
      templateSnapshotSha: 'abc123',
      templateSnapshotSize: { cpu: 2, memoryGb: 4 },
    },
  });
  await prisma.projectSyncSnapshot.create({
    data: { projectId: both, revision: 3, manifest: {}, encryptedGitBundle: 'bundle' },
  });

  // A live template sync run would publish onto the stripped folder: refused.
  await prisma.project.update({
    where: { id: both },
    data: { maintenanceRunId: 'run-live', maintenanceLeaseUntil: new Date(Date.now() + 60_000) },
  });
  const busy = await call(`/api/projects/${both}`, { method: 'DELETE', auth: s.token });
  expectStatus(busy, 409, 'repository removal during a live template sync');
  assert(
    (await prisma.project.findUniqueOrThrow({ where: { id: both } })).repoUrl !== null,
    'a refused removal changes nothing'
  );
  await prisma.project.update({
    where: { id: both },
    data: { maintenanceRunId: null, maintenanceLeaseUntil: null },
  });

  expectStatus(
    await call(`/api/projects/${both}`, { method: 'DELETE', auth: s.token }),
    204,
    'remove the repository of a folder'
  );
  const row = await prisma.project.findUniqueOrThrow({ where: { id: both } });
  assert(
    row.isFolder &&
      row.repoUrl === null &&
      row.syncRevision === 0 &&
      row.lastSyncedAt === null &&
      row.templateSnapshotAt === null &&
      row.templateSnapshotSha === null &&
      row.templateSnapshotSize === null &&
      !row.maintenanceNightly,
    `the folder stays without its repository: ${JSON.stringify(row)}`
  );
  assert(
    (await prisma.projectEnvFile.count({ where: { projectId: both } })) === 0 &&
      (await prisma.projectSyncSnapshot.count({ where: { projectId: both } })) === 0,
    'env files and synced code are gone'
  );
  assert(
    (await prisma.projectFolder.count({ where: { projectId: both } })) === 1,
    'subfolders stay'
  );
  const placements = await Promise.all([placementOf(rootAgent), placementOf(subAgent)]);
  assert(
    JSON.stringify(placements) ===
      JSON.stringify([
        { projectId: both, folderId: null },
        { projectId: both, folderId: sub },
      ]),
    `agents stay in the folder: ${JSON.stringify(placements)}`
  );
  const repo = await connectionStatus(s.userId, repoRef);
  assert(
    repo.linkedTo === null && repo.status === 'NOT_CONNECTED',
    `its GitHub repo is disconnected: ${JSON.stringify(repo)}`
  );
  const listed = await projects(s);
  assert(
    listed.length === 1 && listed[0].id === both && listed[0].isFolder && !listed[0].isRepository,
    `no longer a repository, and the lazy link re-creates nothing: ${JSON.stringify(listed)}`
  );
  const folder = (await folders(s)).find((f) => f.id === both);
  assert(
    folder?.github_repo === null && folder.subfolders.length === 1,
    `still a folder: ${JSON.stringify(folder)}`
  );

  // Folder only or repository only: deleted as before.
  const plain = await newFolder(s, 'Plain folder');
  const repoOnly = await connect(s, urlOf(slug, 'only'));
  for (const id of [plain, repoOnly]) {
    expectStatus(
      await call(`/api/projects/${id}`, { method: 'DELETE', auth: s.token }),
      204,
      'delete'
    );
    assert((await prisma.project.count({ where: { id } })) === 0, `${id} deleted`);
  }
  expectStatus(
    await call(`/api/projects/${plain}`, { method: 'DELETE', auth: s.token }),
    404,
    'deleted rows are gone'
  );
});
