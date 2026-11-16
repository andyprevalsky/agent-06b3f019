/**
 * Projects are repos (docs/plans/completed/projects-are-repos.md P4, P5), registered
 * by projects.blackbox.ts over real HTTP + local Postgres.
 *
 *   POST /api/integrations/github/repos (no project) ─► the user's project with that
 *        repo (canonical compare), else a new one named <repo> (<owner>/<repo> when taken)
 *   GET  /api/projects ─► a connection without a project gets one, once, even concurrently
 *   DELETE /api/projects/:id ─► its repo is disconnected and stays gone (DELETE /api/folders/:id
 *        never removes a repository: 404 for one that is not a folder)
 *   github_repo_ref=<project id> | rose-project:<id> ─► the agent is placed in exactly that
 *        project and its code session restores exactly it (a project without GitHub too)
 *
 * GitHub is never called: every repo is pre-granted (GithubRepoAccess is the access cache).
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
import { githubRepoIdentity } from '../../providers/githubRepos/refs';
import {
  GithubRepoRefNotFoundError,
  resolveCodeSessionWorkspace,
} from '../../providers/githubRepos/resolve';
import { connectGithubRepo } from '../../providers/githubRepos/store';

interface ProjectRow {
  id: string;
  name: string;
  repoUrl: string | null;
  defaultBranch: string;
}

interface RepoRow {
  canonical_ref: string;
  connected_rose_project_ref: string | null;
}

const slugOf = () => `bb${randomBytes(5).toString('hex')}`;
const urlOf = (slug: string, repo: string) => `https://github.com/${slug}/${repo}`;

async function grant(userId: string, urls: string[]): Promise<void> {
  await prisma.githubRepoAccess.createMany({
    data: urls.map((repoUrl) => ({ userId, repoUrl })),
    skipDuplicates: true,
  });
}

function connect(s: Session, body: Record<string, unknown>) {
  return call('/api/integrations/github/repos', { method: 'POST', auth: s.token, body });
}

async function connected(s: Session, body: Record<string, unknown>): Promise<string> {
  const res = await connect(s, body);
  expectStatus(res, 201, `connect ${String(body.repo_url)}`);
  const projectId = res.data.connected_rose_project_ref;
  assert(typeof projectId === 'string', `connect links a project: ${res.text}`);
  return projectId;
}

async function listProjects(s: Session): Promise<ProjectRow[]> {
  const res = await call('/api/projects', { auth: s.token });
  expectStatus(res, 200, 'list projects');
  return res.data.projects as ProjectRow[];
}

async function createProject(s: Session, body: Record<string, unknown>): Promise<ProjectRow> {
  const res = await call('/api/projects', { method: 'POST', auth: s.token, body });
  expectStatus(res, 201, 'create project');
  return res.data as unknown as ProjectRow;
}

async function inventory(s: Session): Promise<RepoRow[]> {
  const res = await call('/api/integrations/github/repos', { auth: s.token });
  expectStatus(res, 200, 'repo inventory');
  return res.data.repos as RepoRow[];
}

test('repos are projects: connecting a GitHub repo creates or links its project', async () => {
  const s = await anonymousSession();
  const slug = slugOf();
  await grant(
    s.userId,
    ['tool', 'app', 'taken', 'raced', 'explicit'].map((repo) => urlOf(slug, repo))
  );

  // A new repo becomes a project named after it; reconnecting keeps that one.
  const toolId = await connected(s, { repo_url: `${urlOf(slug, 'tool')}.git` });
  let projects = await listProjects(s);
  const tool = projects.find((p) => p.id === toolId);
  assert(
    tool?.name === 'tool' && tool.repoUrl === urlOf(slug, 'tool'),
    `repo project ${JSON.stringify(tool)}`
  );
  assert((await connected(s, { repo_url: `${slug}/tool` })) === toolId, 'reconnect keeps it');

  // A project that already carries the repo (any spelling) is linked, not duplicated.
  const app = await createProject(s, {
    name: 'My App',
    repoUrl: `https://github.com/${slug.toUpperCase()}/App.git`,
  });
  assert((await connected(s, { repo_url: urlOf(slug, 'app') })) === app.id, 'linked by repo');

  // The repo's name is taken by a different project: <owner>/<repo>.
  const taken = await createProject(s, { name: 'taken' });
  const takenRepoId = await connected(s, { repo_url: urlOf(slug, 'taken') });
  projects = await listProjects(s);
  const takenRepo = projects.find((p) => p.id === takenRepoId);
  assert(
    takenRepo?.name === `${slug}/taken` && takenRepo.repoUrl === urlOf(slug, 'taken'),
    `owner/repo name when the repo name is taken: ${JSON.stringify(takenRepo)}`
  );
  assert(projects.find((p) => p.id === taken.id)?.repoUrl === null, 'the other project is kept');

  // Concurrent connects of one repo converge on one project (the name race).
  const raced = await Promise.all(
    [1, 2, 3].map(() => connected(s, { repo_url: urlOf(slug, 'raced') }))
  );
  assert(new Set(raced).size === 1, `one project for concurrent connects: ${raced}`);

  // An explicit project keeps the current behaviour: that project, no new one.
  const explicit = await createProject(s, { name: 'Explicit' });
  const viaExplicit = await connected(s, {
    repo_url: urlOf(slug, 'explicit'),
    connected_rose_project_ref: explicit.id,
  });
  assert(viaExplicit === explicit.id, 'explicit project ref kept');

  projects = await listProjects(s);
  const withRepo = (repo: string) =>
    projects.filter((p) => p.repoUrl !== null && p.repoUrl.toLowerCase() === urlOf(slug, repo));
  for (const repo of ['tool', 'taken', 'raced', 'explicit']) {
    assert(withRepo(repo).length === 1, `exactly one project for ${repo}: ${withRepo(repo)}`);
  }
  assert(withRepo('raced')[0].id === raced[0], 'the raced project is the linked one');
  const names = projects.map((p) => p.name).sort();
  const expected = ['Explicit', 'My App', 'raced', 'taken', `${slug}/taken`, 'tool'].sort();
  assert(JSON.stringify(names) === JSON.stringify(expected), `projects ${names}`);
  const repos = await inventory(s);
  assert(
    repos.length === 5 && repos.every((repo) => repo.connected_rose_project_ref !== null),
    `every connection has its project: ${JSON.stringify(repos)}`
  );
});

test('repos are projects: GET /api/projects links connections without a project, once', async () => {
  const s = await anonymousSession();
  const slug = slugOf();
  const legacyUrl = urlOf(slug, 'legacy');
  const linkedUrl = urlOf(slug, 'linked');
  await grant(s.userId, [legacyUrl, linkedUrl]);
  const existing = await createProject(s, { name: 'Existing', repoUrl: `${linkedUrl}.git` });
  // Connected before repos were projects: no connectedRoseProjectRef.
  for (const url of [legacyUrl, linkedUrl]) {
    await connectGithubRepo({
      userId: s.userId,
      identity: githubRepoIdentity(url)!,
      defaultBranch: 'develop',
      connectedRoseProjectRef: null,
      source: 'connect',
    });
  }

  const lists = await Promise.all([1, 2, 3].map(() => call('/api/projects', { auth: s.token })));
  for (const list of lists) {
    expectStatus(list, 200, 'concurrent list');
    const rows = (list.data.projects as ProjectRow[]).filter((p) => p.repoUrl === legacyUrl);
    assert(rows.length === 1, `every concurrent list shows the new project once: ${list.text}`);
  }
  const links = new Map(
    (
      await prisma.githubRepoConnection.findMany({
        where: { userId: s.userId },
        select: { canonicalRef: true, connectedRoseProjectRef: true },
      })
    ).map((row) => [row.canonicalRef, row.connectedRoseProjectRef])
  );
  assert(links.get(`gh:${slug}/linked`) === existing.id, 'linked to the project with the repo');
  const projects = await listProjects(s);
  const legacy = projects.find((p) => p.id === links.get(`gh:${slug}/legacy`));
  assert(
    legacy?.name === 'legacy' && legacy.repoUrl === legacyUrl && legacy.defaultBranch === 'develop',
    `legacy connection's project ${JSON.stringify(legacy)}`
  );
  assert(projects.length === 2, `no duplicates: ${projects.map((p) => p.name)}`);
  assert((await listProjects(s)).length === 2, 'steady state: nothing more is created');
});

test('repos are projects: deleting a project disconnects its repo, which stays gone', async () => {
  const s = await anonymousSession();
  const slug = slugOf();
  await grant(
    s.userId,
    ['gone', 'folder-gone', 'kept'].map((repo) => urlOf(slug, repo))
  );
  const goneId = await connected(s, { repo_url: urlOf(slug, 'gone') });
  const folderGoneId = await connected(s, { repo_url: urlOf(slug, 'folder-gone') });
  const keptId = await connected(s, { repo_url: urlOf(slug, 'kept') });

  const deleted = await call(`/api/projects/${goneId}`, { method: 'DELETE', auth: s.token });
  expectStatus(deleted, 204, 'delete project');
  // A connected repo is not a left-bar folder: the folder API leaves it alone.
  const folder = await call(`/api/folders/${folderGoneId}`, { method: 'DELETE', auth: s.token });
  expectStatus(folder, 404, 'a repository is not a folder');
  expectStatus(
    await call(`/api/projects/${folderGoneId}`, { method: 'DELETE', auth: s.token }),
    204,
    'delete the second project'
  );

  const refs = (await inventory(s)).map((repo) => repo.canonical_ref);
  assert(JSON.stringify(refs) === JSON.stringify([`gh:${slug}/kept`]), `inventory ${refs}`);
  const integrations = await prisma.integration.findMany({
    where: { userId: s.userId, name: 'github_repo' },
    select: { accountId: true, status: true, isActive: true },
  });
  const status = new Map(integrations.map((row) => [row.accountId, row]));
  for (const repo of ['gone', 'folder-gone']) {
    const row = status.get(`gh:${slug}/${repo}`);
    assert(row?.status === 'NOT_CONNECTED' && !row.isActive, `${repo} disconnected`);
  }
  assert(status.get(`gh:${slug}/kept`)?.status === 'CONNECTED', 'other repos stay connected');
  const projects = await listProjects(s);
  assert(
    projects.length === 1 && projects[0].id === keptId,
    `a deleted project is not resurrected: ${projects.map((p) => p.name)}`
  );

  // Connecting it again makes it a project again.
  const back = await connected(s, { repo_url: urlOf(slug, 'gone') });
  assert(back !== goneId && (await listProjects(s)).some((p) => p.id === back), 'reconnected');
});

test('project refs: github_repo_ref=<project id> places the agent in exactly that project', async () => {
  const s = await anonymousSession();
  const other = await anonymousSession();
  const slug = slugOf();
  const repoUrl = urlOf(slug, 'shared');
  const repoRef = `gh:${slug}/shared`;
  await grant(s.userId, [repoUrl]);
  // Two projects on one repo: the connection is linked to the oldest.
  const first = await createProject(s, { name: 'Shared A', repoUrl });
  const second = await createProject(s, { name: 'Shared B', repoUrl, startupScript: 'echo b' });
  assert((await connected(s, { repo_url: repoUrl })) === first.id, 'linked to the oldest');
  const local = await createProject(s, { name: 'Local only', startupScript: 'echo local' });
  const elsewhere = await createProject(s, { name: 'Elsewhere' });
  const foreign = await createProject(other, { name: 'Foreign' });
  const body = (extra: Record<string, unknown>) => ({
    goal: `project ref blackbox ${randomBytes(4).toString('hex')}`,
    start_phase: 'execute',
    pause_state: true,
    task_queue: 'test-queue',
    ...extra,
  });
  const create = (extra: Record<string, unknown>) =>
    call('/api/agents', { method: 'POST', headers: apiKeyHeaders(s.userId), body: body(extra) });
  const row = (id: string) =>
    prisma.agent.findUniqueOrThrow({
      where: { id },
      select: { projectId: true, githubRepoRef: true, githubRepoUrl: true },
    });
  const placed = async (extra: Record<string, unknown>, label: string) => {
    const res = await create(extra);
    expectStatus(res, 201, label);
    return { id: res.data.agent_id as string, row: await row(res.data.agent_id as string) };
  };

  // A project without GitHub: placed there, no repo ref, never 404.
  const inLocal = await placed({ github_repo_ref: local.id }, 'local-only project ref');
  assert(
    JSON.stringify(inLocal.row) ===
      JSON.stringify({ projectId: local.id, githubRepoRef: null, githubRepoUrl: null }),
    `local-only placement ${JSON.stringify(inLocal.row)}`
  );
  // A GitHub project: exactly that one (not the connection's), carrying its repo ref.
  const inSecond = await placed({ github_repo_ref: `rose-project:${second.id}` }, 'prefixed ref');
  assert(
    JSON.stringify(inSecond.row) ===
      JSON.stringify({ projectId: second.id, githubRepoRef: repoRef, githubRepoUrl: null }),
    `GitHub project placement ${JSON.stringify(inSecond.row)}`
  );
  // A sub-agent's explicit project ref wins over the parent's project; batch spawns too.
  const root = await placed({ project_id: elsewhere.id }, 'root elsewhere');
  const sub = { parent_agent_id: root.id, parent_workflow_id: root.id, depth: 1, bus_id: root.id };
  const child = await placed({ ...sub, github_repo_ref: local.id }, 'sub-agent');
  assert(child.row.projectId === local.id, `sub-agent placement ${JSON.stringify(child.row)}`);
  const batchChild = { agent_id: randomUUID(), ...body({ ...sub, github_repo_ref: second.id }) };
  const batch = await call('/api/agents/batch', {
    method: 'POST',
    headers: apiKeyHeaders(s.userId),
    body: { agents: [batchChild] },
  });
  assert(batch.status === 201 || batch.status === 207, `batch ${batch.status} ${batch.text}`);
  const batchRow = await row(batchChild.agent_id);
  assert(
    batchRow.projectId === second.id && batchRow.githubRepoRef === repoRef,
    `batch placement ${JSON.stringify(batchRow)}`
  );
  // Another user's (or no) project: the unchanged 404 the agents side keys on.
  for (const ref of [foreign.id, randomUUID()]) {
    const res = await create({ github_repo_ref: ref });
    assert(
      res.status === 404 && res.data.code === 'GITHUB_REPO_NOT_CONNECTED',
      `unowned project ref ${res.status} ${res.text}`
    );
  }
  const contradiction = await create({ project_id: elsewhere.id, github_repo_ref: local.id });
  expectStatus(contradiction, 400, 'project_id and a different project ref');

  // The code session restores exactly the named project, whatever the agent's own.
  const pinned = await resolveCodeSessionWorkspace(s.userId, {
    githubRepoRef: second.id,
    projectId: elsewhere.id,
  });
  assert(pinned.projectWorkspace?.project.id === second.id, 'exactly the named GitHub project');
  assert(pinned.projectWorkspace.project.startupScript === 'echo b', 'its startup script');
  assert(pinned.repoOverrideUrl === repoUrl, `its repo ${pinned.repoOverrideUrl}`);
  const repoLess = await resolveCodeSessionWorkspace(s.userId, {
    githubRepoRef: `rose-project:${local.id}`,
    agentRepoRef: repoRef,
    projectId: elsewhere.id,
  });
  assert(repoLess.projectWorkspace?.project.id === local.id, 'exactly the project without GitHub');
  assert(repoLess.projectWorkspace.project.startupScript === 'echo local', 'its startup script');
  assert(repoLess.repoOverrideUrl === undefined, 'no repo to clone');
  const refused = await resolveCodeSessionWorkspace(other.userId, { githubRepoRef: local.id }).then(
    () => null,
    (error: unknown) => error
  );
  assert(refused instanceof GithubRepoRefNotFoundError, `another user is refused: ${refused}`);
});
