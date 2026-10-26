#!/usr/bin/env tsx
/**
 * Black-box tests for /api/projects (PJ2) and Agent.projectId (UI ledger 57).
 *
 * Invariants covered:
 *   - auth boundary: no credentials → 401
 *   - defaults: defaultBranch "main", startupTimeoutS 120, autoWake false
 *   - validation: bad branch / timeout / env-file name / traversal → 400;
 *     duplicate project name or env-file path → 409
 *   - PUT /api/projects upserts by name (201 new, 200 existing)
 *   - owner scoping: another user's project is 404 on every route and absent
 *     from their list; agents cannot be filed under a foreign project
 *   - env files: values never appear in any response; stored only as
 *     credential envelopes (DB read: ciphertext lacks the value, decrypts to
 *     it); add / edit value / remove variable / rename / delete
 *   - search: by variable name, file path, description; never by value
 *   - agents: POST /api/agents accepts project_id, sub-agents inherit it,
 *     GET /api/agents returns project_id; deleting a project returns its
 *     agents to Home (null)
 *   - Rose out of the box (PJ4): a Rose dev account's project list carries a
 *     configured "Rose" project (repo, branch, startup script, six declared env
 *     files, GitHub grant) — created or filled in once, idempotent, never
 *     overwriting later edits; other accounts are untouched
 *
 * Usage: bash scripts/run-blackbox-tests.sh projects
 */
import { randomBytes } from 'crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { after, test } from 'node:test';
import { decryptCredentialEnvelope } from '../../providers/claudeCredentials';
import { prisma } from '../../providers/database';
import { ROSE_DEV_USER_IDS } from '../../utils/roseDevAccess';
import {
  anonymousSession,
  apiKeyHeaders,
  assert,
  call,
  expectStatus,
  type Session,
} from './projects-harness';

const SECRET = `pj-secret-${randomBytes(12).toString('hex')}`;
const SECRET2 = `pj-rotated-${randomBytes(12).toString('hex')}`;

after(async () => {
  await prisma.$disconnect();
});

interface Project {
  id: string;
  name: string;
  defaultBranch: string;
  startupScript: string | null;
  startupTimeoutS: number;
  lifecycle: { autoWake: boolean };
  envFileCount: number;
  githubConnected: boolean;
  updatedAt: string;
}

interface EnvFile {
  id: string;
  path: string;
  description: string | null;
  source: string;
  variables: Array<{ name: string; description?: string }>;
  hasContent: boolean;
  matches?: string[];
}

async function createProject(s: Session, body: Record<string, unknown>): Promise<Project> {
  const res = await call('/api/projects', { method: 'POST', auth: s.token, body });
  expectStatus(res, 201, 'create project');
  return res.data as unknown as Project;
}

test('auth boundary: unauthenticated requests are rejected', async () => {
  const res = await call('/api/projects');
  assert(res.status === 401, `expected 401, got ${res.status}`);
});

test('create applies defaults; validation rejects bad settings', async () => {
  const s = await anonymousSession();
  const project = await createProject(s, { name: 'Defaults' });
  assert(project.defaultBranch === 'main', `default branch ${project.defaultBranch}`);
  assert(project.startupTimeoutS === 120, `default timeout ${project.startupTimeoutS}`);
  assert(project.lifecycle.autoWake === false, 'autoWake defaults off');
  assert(project.startupScript === null, 'no startup script by default');

  for (const body of [
    { name: 'Bad', defaultBranch: '../main' },
    { name: 'Bad', startupTimeoutS: 0 },
    { name: 'Bad', startupTimeoutS: 1.5 },
    { name: '' },
    { name: 'Bad', unknownField: true },
  ]) {
    const res = await call('/api/projects', { method: 'POST', auth: s.token, body });
    expectStatus(res, 400, `invalid body ${JSON.stringify(body)}`);
  }
  const dup = await call('/api/projects', {
    method: 'POST',
    auth: s.token,
    body: { name: 'Defaults' },
  });
  expectStatus(dup, 409, 'duplicate name');

  const updated = await call(`/api/projects/${project.id}`, {
    method: 'PUT',
    auth: s.token,
    body: {
      defaultBranch: 'develop',
      startupScript: 'echo hi',
      startupTimeoutS: 30,
      lifecycle: { autoWake: true },
      repoUrl: 'https://user:tok3n-should-strip@github.com/acme/app',
    },
  });
  expectStatus(updated, 200, 'update settings');
  const u = updated.data as unknown as Project & { repoUrl: string };
  assert(u.defaultBranch === 'develop' && u.startupTimeoutS === 30, 'settings persisted');
  assert(u.lifecycle.autoWake === true, 'autoWake persisted');
  assert(u.repoUrl === 'https://github.com/acme/app', `credentials stripped: ${u.repoUrl}`);

  const upsertExisting = await call('/api/projects', {
    method: 'PUT',
    auth: s.token,
    body: { name: 'Defaults', startupTimeoutS: 45 },
  });
  expectStatus(upsertExisting, 200, 'upsert existing');
  assert((upsertExisting.data as unknown as Project).id === project.id, 'upsert keeps id');
  const upsertNew = await call('/api/projects', {
    method: 'PUT',
    auth: s.token,
    body: { name: 'Fresh' },
  });
  expectStatus(upsertNew, 201, 'upsert new');

  const list = await call('/api/projects', { auth: s.token });
  expectStatus(list, 200, 'list');
  const names = (list.data.projects as Project[]).map((p) => p.name).sort();
  assert(JSON.stringify(names) === JSON.stringify(['Defaults', 'Fresh']), `list ${names}`);
});

test('githubConnected reflects a GithubRepoAccess grant for the repo, per user', async () => {
  const s = await anonymousSession();
  const other = await anonymousSession();
  const slug = `acme-${randomBytes(4).toString('hex')}`;
  const granted = await createProject(s, {
    name: 'Granted',
    repoUrl: `https://github.com/${slug}/app.git`,
  });
  const ungranted = await createProject(s, {
    name: 'Ungranted',
    repoUrl: `https://github.com/${slug}/other`,
  });
  const noRepo = await createProject(s, { name: 'No repo' });
  for (const p of [granted, ungranted, noRepo]) {
    assert(p.githubConnected === false, 'no grant yet');
  }
  await prisma.githubRepoAccess.create({
    data: { userId: s.userId, repoUrl: `https://github.com/${slug}/app` },
  });
  try {
    const list = await call('/api/projects', { auth: s.token });
    expectStatus(list, 200, 'list');
    const flags = Object.fromEntries(
      (list.data.projects as Project[]).map((p) => [p.name, p.githubConnected])
    );
    assert(
      flags.Granted === true && flags.Ungranted === false && flags['No repo'] === false,
      `list flags ${JSON.stringify(flags)}`
    );
    const one = await call(`/api/projects/${granted.id}`, { auth: s.token });
    expectStatus(one, 200, 'get');
    assert(one.data.githubConnected === true, 'detail reports the grant');

    const theirs = await createProject(other, {
      name: 'Same repo',
      repoUrl: `https://github.com/${slug}/app`,
    });
    assert(theirs.githubConnected === false, "another user's grant never counts");
  } finally {
    await prisma.githubRepoAccess.deleteMany({ where: { userId: s.userId } });
  }
});

test('owner scoping: another user cannot see or touch a project', async () => {
  const a = await anonymousSession();
  const b = await anonymousSession();
  const project = await createProject(a, { name: 'Private' });
  const file = await call(`/api/projects/${project.id}/env-files`, {
    method: 'POST',
    auth: a.token,
    body: { path: '.env', variables: [{ name: 'TOKEN', value: SECRET }] },
  });
  expectStatus(file, 201, 'owner adds env file');
  const fileId = (file.data as unknown as EnvFile).id;
  const probes: Array<[string, string, unknown?]> = [
    ['GET', `/api/projects/${project.id}`],
    ['PUT', `/api/projects/${project.id}`, { startupTimeoutS: 5 }],
    ['DELETE', `/api/projects/${project.id}`],
    ['GET', `/api/projects/${project.id}/env-files`],
    ['POST', `/api/projects/${project.id}/env-files`, { path: '.env.b' }],
    [
      'PUT',
      `/api/projects/${project.id}/env-files/${fileId}`,
      { variables: [{ name: 'X', value: 'y' }] },
    ],
    ['DELETE', `/api/projects/${project.id}/env-files/${fileId}`],
    ['GET', `/api/projects/${project.id}/sync`],
  ];
  for (const [method, path, body] of probes) {
    const res = await call(path, { method, auth: b.token, body });
    expectStatus(res, 404, `foreign ${method} ${path}`);
  }
  const listB = await call('/api/projects', { auth: b.token });
  assert((listB.data.projects as Project[]).length === 0, 'B lists none of A');
  // API-key callers are scoped by X-User-Id the same way.
  const viaKey = await call(`/api/projects/${project.id}`, { headers: apiKeyHeaders(b.userId) });
  expectStatus(viaKey, 404, 'foreign via API key');
  const ownerViaKey = await call(`/api/projects/${project.id}`, {
    headers: apiKeyHeaders(a.userId),
  });
  expectStatus(ownerViaKey, 200, 'owner via API key');
  const still = await prisma.projectEnvFile.count({ where: { projectId: project.id } });
  assert(still === 1, 'foreign DELETE left the env file intact');
});

test('env files: values encrypted at rest, never returned; CRUD and search', async () => {
  const s = await anonymousSession();
  const project = await createProject(s, { name: 'Secrets' });
  const base = `/api/projects/${project.id}/env-files`;

  for (const path of ['config.json', '../.env', '/etc/.env', 'a/.git/.env']) {
    const res = await call(base, { method: 'POST', auth: s.token, body: { path } });
    expectStatus(res, 400, `reject path ${path}`);
  }

  const created = await call(base, {
    method: 'POST',
    auth: s.token,
    body: {
      path: 'back-end/.env',
      description: 'Backend runtime secrets',
      variables: [
        { name: 'STRIPE_TOKEN', value: SECRET, description: 'payments sandbox key' },
        { name: 'PORT', value: '3001' },
      ],
    },
  });
  expectStatus(created, 201, 'create env file');
  assert(!created.text.includes(SECRET), 'create response must not echo the value');
  const file = created.data as unknown as EnvFile;
  assert(file.hasContent && file.source === 'managed', 'managed file with content');
  assert(
    JSON.stringify(file.variables) ===
      JSON.stringify([
        { name: 'STRIPE_TOKEN', description: 'payments sandbox key' },
        { name: 'PORT' },
      ]),
    `variable metadata ${JSON.stringify(file.variables)}`
  );
  const dupe = await call(base, {
    method: 'POST',
    auth: s.token,
    body: { path: './back-end/.env' },
  });
  expectStatus(dupe, 409, 'duplicate path (normalized)');

  const row = await prisma.projectEnvFile.findUniqueOrThrow({ where: { id: file.id } });
  const rowText = JSON.stringify(row);
  assert(!rowText.includes(SECRET), 'DB row must not contain the plaintext value');
  const key = process.env.CLAUDE_CREDENTIAL_DECRYPTION_KEY;
  assert(key, 'CLAUDE_CREDENTIAL_DECRYPTION_KEY must be configured for the test');
  const plaintext = decryptCredentialEnvelope(row.encryptedContent!, key);
  assert(plaintext?.includes(`STRIPE_TOKEN=${SECRET}`), 'envelope decrypts to the stored value');

  const edited = await call(`${base}/${file.id}`, {
    method: 'PUT',
    auth: s.token,
    body: {
      variables: [
        { name: 'STRIPE_TOKEN', value: SECRET2 },
        { name: 'NEW_FLAG', value: 'on-value' },
      ],
      removeVariables: ['PORT'],
    },
  });
  expectStatus(edited, 200, 'edit values');
  assert(!edited.text.includes(SECRET2), 'edit response must not echo the value');
  const names = (edited.data as unknown as EnvFile).variables.map((v) => v.name);
  assert(JSON.stringify(names) === JSON.stringify(['STRIPE_TOKEN', 'NEW_FLAG']), `names ${names}`);
  assert(
    (edited.data as unknown as EnvFile).variables[0].description === 'payments sandbox key',
    'description kept across value edits'
  );
  const rotated = await prisma.projectEnvFile.findUniqueOrThrow({ where: { id: file.id } });
  const rotatedText = decryptCredentialEnvelope(rotated.encryptedContent!, key) ?? '';
  assert(rotatedText.includes(SECRET2) && !rotatedText.includes(SECRET), 'value rotated');
  assert(!rotatedText.includes('PORT='), 'removed variable dropped');

  await call(base, {
    method: 'POST',
    auth: s.token,
    body: {
      path: 'agents/.env.benchmark-temporal',
      declared: true,
      description: 'Temporal override',
    },
  });

  const search = async (q: string) => {
    const res = await call(`${base}?q=${encodeURIComponent(q)}`, { auth: s.token });
    expectStatus(res, 200, `search ${q}`);
    assert(!res.text.includes(SECRET2), 'search response must not contain values');
    return res.data.envFiles as EnvFile[];
  };
  const byName = await search('stripe');
  assert(byName.length === 1 && byName[0].matches?.[0] === 'STRIPE_TOKEN', 'search by name');
  const byDescription = await search('payments');
  assert(
    byDescription.length === 1 && byDescription[0].matches?.[0] === 'STRIPE_TOKEN',
    'variable description'
  );
  const byPath = await search('benchmark-temporal');
  assert(byPath.length === 1 && byPath[0].source === 'declared', 'search by path');
  const byFileDescription = await search('runtime secrets');
  assert(
    byFileDescription.length === 1 && byFileDescription[0].path === 'back-end/.env',
    'file description'
  );
  const byValue = await search(SECRET2.slice(0, 20));
  assert(byValue.length === 0, 'values are never searchable');

  const renamed = await call(`${base}/${file.id}`, {
    method: 'PUT',
    auth: s.token,
    body: { path: 'back-end/.env.local' },
  });
  expectStatus(renamed, 200, 'rename path');
  const renamedFile = renamed.data as unknown as EnvFile;
  assert(renamedFile.path === 'back-end/.env.local', 'renamed');
  const del = await call(`${base}/${renamedFile.id}`, { method: 'DELETE', auth: s.token });
  expectStatus(del, 204, 'delete env file');
  const left = await call(base, { auth: s.token });
  assert((left.data.envFiles as EnvFile[]).length === 1, 'only the declared file remains');
  const listed = await call(`/api/projects/${project.id}`, { auth: s.token });
  assert((listed.data as unknown as Project).envFileCount === 1, 'envFileCount reflects CRUD');
});

test('agents: project_id on create, inherited by sub-agents, listed, cleared on delete', async () => {
  const s = await anonymousSession();
  const other = await anonymousSession();
  const project = await createProject(s, { name: 'Agents' });
  const foreign = await createProject(other, { name: 'Foreign' });
  const create = (body: Record<string, unknown>) =>
    call('/api/agents', {
      method: 'POST',
      headers: apiKeyHeaders(s.userId),
      body: {
        goal: `projects blackbox ${randomBytes(4).toString('hex')}`,
        start_phase: 'execute',
        pause_state: true,
        task_queue: 'test-queue',
        ...body,
      },
    });

  const rejected = await create({ project_id: foreign.id });
  expectStatus(rejected, 404, 'foreign project_id');
  const root = await create({ project_id: project.id });
  expectStatus(root, 201, 'create in project');
  const rootId = root.data.agent_id as string;
  assert(root.data.project_id === project.id, `create returns project_id ${root.data.project_id}`);

  const home = await create({});
  expectStatus(home, 201, 'create Home agent');
  assert(home.data.project_id === null, 'root without project_id is Home');

  const sub = { parent_agent_id: rootId, parent_workflow_id: rootId, depth: 1, bus_id: rootId };
  const child = await create(sub);
  expectStatus(child, 201, 'create sub-agent');
  const childRow = await prisma.agent.findUniqueOrThrow({
    where: { id: child.data.agent_id as string },
  });
  assert(childRow.projectId === project.id, 'sub-agent inherits the parent project');
  const explicitHome = await create({ ...sub, project_id: null });
  expectStatus(explicitHome, 201, 'sub-agent explicitly Home');
  const explicitRow = await prisma.agent.findUniqueOrThrow({
    where: { id: explicitHome.data.agent_id as string },
  });
  assert(explicitRow.projectId === null, 'explicit null keeps the sub-agent in Home');

  const list = await call('/api/agents', { headers: apiKeyHeaders(s.userId) });
  expectStatus(list, 200, 'list agents');
  const rows = list.data.agents as Array<{ agent_id: string; project_id: string | null }>;
  const byId = new Map(rows.map((r) => [r.agent_id, r.project_id]));
  assert(byId.get(rootId) === project.id, 'list returns project_id for project agents');
  assert(byId.get(home.data.agent_id as string) === null, 'list returns null for Home agents');

  const deleted = await call(`/api/projects/${project.id}`, { method: 'DELETE', auth: s.token });
  expectStatus(deleted, 204, 'delete project');
  const after = await prisma.agent.findUniqueOrThrow({ where: { id: rootId } });
  assert(after.projectId === null, 'deleting a project returns its agents to Home');
  await prisma.agent.updateMany({
    where: { userId: s.userId },
    data: { deletedAt: new Date() },
  });
});

const ROSE_DEV_USER = ROSE_DEV_USER_IDS[0];
const ROSE_REPO = 'https://github.com/Rose-Ai-Labs/rose';
const ROSE_ENV_PATHS = [
  'agents/.env',
  'agents/.env.benchmark-temporal',
  'back-end/.env',
  'front-end/.env',
  'mac-app/.env',
  'research/.env',
];
const ROSE_STARTUP = readFileSync(
  resolve(__dirname, '../../../../agents/benchmarks/fixtures/projects/rose-startup.sh'),
  'utf8'
);

async function resetRoseDevProjects(): Promise<void> {
  await prisma.project.deleteMany({ where: { userId: ROSE_DEV_USER } });
  await prisma.githubRepoAccess.deleteMany({
    where: { userId: ROSE_DEV_USER, repoUrl: ROSE_REPO },
  });
}

async function devCall(path: string, init: { method?: string; body?: unknown } = {}) {
  return call(path, { ...init, headers: apiKeyHeaders(ROSE_DEV_USER) });
}

async function devRose(): Promise<Project & { repoUrl: string | null }> {
  const list = await devCall('/api/projects');
  expectStatus(list, 200, 'dev list');
  const roses = (list.data.projects as (Project & { repoUrl: string | null })[]).filter(
    (p) => p.name === 'Rose'
  );
  assert(roses.length === 1, `exactly one Rose project, got ${roses.length}`);
  return roses[0];
}

async function devEnvFiles(projectId: string): Promise<EnvFile[]> {
  const res = await devCall(`/api/projects/${projectId}/env-files`);
  expectStatus(res, 200, 'dev env files');
  return res.data.envFiles as EnvFile[];
}

test('Rose out of the box: a name-only Rose project is configured on the next list (PJ4)', async () => {
  await prisma.user.upsert({
    where: { userId: ROSE_DEV_USER },
    create: { userId: ROSE_DEV_USER, name: 'Rose dev (projects blackbox)' },
    update: {},
  });
  await resetRoseDevProjects();
  try {
    // Andy's prod state on 2026-10-26: "Rose" created by name only.
    const created = await devCall('/api/projects', { method: 'POST', body: { name: 'Rose' } });
    expectStatus(created, 201, 'name-only Rose');
    const rose = await devRose();
    assert(rose.id === (created.data as unknown as Project).id, 'configures the existing row');
    assert(rose.repoUrl === ROSE_REPO, `repo ${rose.repoUrl}`);
    assert(rose.defaultBranch === 'main', `branch ${rose.defaultBranch}`);
    assert(rose.startupScript === ROSE_STARTUP, 'startup script = PJ4 fixture');
    assert(rose.startupTimeoutS === 120, `timeout ${rose.startupTimeoutS}`);
    assert(rose.githubConnected === true, 'GitHub connected via a repo grant');
    assert(rose.envFileCount === 6, `env files ${rose.envFileCount}`);
    const files = await devEnvFiles(rose.id);
    assert(
      JSON.stringify(files.map((f) => f.path)) === JSON.stringify(ROSE_ENV_PATHS),
      `env paths ${files.map((f) => f.path)}`
    );
    assert(
      files.every((f) => f.source === 'declared' && !f.hasContent),
      'declared, no values (values arrive only through codebase sync)'
    );
    const detail = await devCall(`/api/projects/${rose.id}`);
    expectStatus(detail, 200, 'dev detail');
    assert(detail.data.githubConnected === true, 'detail reports the grant');

    // Idempotent: listing again changes nothing and duplicates nothing.
    const again = await devRose();
    assert(again.id === rose.id && again.updatedAt === rose.updatedAt, 'no rewrite on re-list');
    assert(again.envFileCount === 6, 'no duplicate env files');
    const grants = await prisma.githubRepoAccess.count({
      where: { userId: ROSE_DEV_USER, repoUrl: ROSE_REPO },
    });
    assert(grants === 1, `one grant, got ${grants}`);

    // Later edits stick: clearing the script or removing a file is not undone.
    const cleared = await devCall(`/api/projects/${rose.id}`, {
      method: 'PUT',
      body: { startupScript: '' },
    });
    expectStatus(cleared, 200, 'clear startup script');
    const removed = await devCall(`/api/projects/${rose.id}/env-files/${files[0].id}`, {
      method: 'DELETE',
    });
    assert(removed.status === 204 || removed.status === 200, `delete env file ${removed.status}`);
    const edited = await devRose();
    assert(edited.startupScript === null, 'cleared script stays cleared');
    assert(edited.envFileCount === 5, `removed file stays removed (${edited.envFileCount})`);
  } finally {
    await resetRoseDevProjects();
  }
});

test('Rose out of the box: a dev account without a Rose project gets one; concurrent lists create one', async () => {
  await prisma.user.upsert({
    where: { userId: ROSE_DEV_USER },
    create: { userId: ROSE_DEV_USER, name: 'Rose dev (projects blackbox)' },
    update: {},
  });
  await resetRoseDevProjects();
  try {
    const lists = await Promise.all([devCall('/api/projects'), devCall('/api/projects')]);
    for (const list of lists) expectStatus(list, 200, 'concurrent dev list');
    const rows = await prisma.project.findMany({ where: { userId: ROSE_DEV_USER, name: 'Rose' } });
    assert(rows.length === 1, `one Rose row, got ${rows.length}`);
    const rose = await devRose();
    assert(rose.repoUrl === ROSE_REPO && rose.startupScript === ROSE_STARTUP, 'configured');
    assert(rose.githubConnected === true && rose.envFileCount === 6, 'connected, six files');
  } finally {
    await resetRoseDevProjects();
  }
});

test('Rose out of the box: other accounts keep a name-only Rose project untouched', async () => {
  const s = await anonymousSession();
  const created = await createProject(s, { name: 'Rose' });
  const list = await call('/api/projects', { auth: s.token });
  expectStatus(list, 200, 'list');
  const [rose] = list.data.projects as (Project & { repoUrl: string | null })[];
  assert(rose.id === created.id && rose.repoUrl === null, 'no repo');
  assert(rose.startupScript === null && rose.envFileCount === 0, 'no script, no files');
  assert(rose.githubConnected === false, 'not connected');
  const grants = await prisma.githubRepoAccess.count({ where: { userId: s.userId } });
  assert(grants === 0, 'no grant');
});
