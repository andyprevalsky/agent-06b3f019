/** Folder regressions registered by the existing projects blackbox suite. */
import './projects-folder-order.cases';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomBytes, randomUUID } from 'crypto';
import {
  anonymousSession,
  apiKeyHeaders,
  assert,
  call,
  expectStatus,
  type Session,
} from './projects-harness';
import { prisma } from '../../providers/database';
interface Project {
  id: string;
  name: string;
  folders: Folder[];
}
async function createProject(s: Session, body: Record<string, unknown>): Promise<Project> {
  const res = await call('/api/projects', { method: 'POST', auth: s.token, body });
  expectStatus(res, 201, 'create project');
  return res.data as unknown as Project;
}

interface Folder {
  id: string;
  name: string;
  projectId: string;
}

async function createFolder(s: Session, projectId: string, name: string): Promise<Folder> {
  const res = await call(`/api/projects/${projectId}/folders`, {
    method: 'POST',
    auth: s.token,
    body: { name },
  });
  expectStatus(res, 201, 'create folder');
  return res.data as unknown as Folder;
}

function folderAgent(s: Session, body: Record<string, unknown>) {
  return call('/api/agents', {
    method: 'POST',
    headers: apiKeyHeaders(s.userId),
    body: {
      goal: `folder blackbox ${randomBytes(6).toString('hex')}`,
      start_phase: 'execute',
      pause_state: true,
      task_queue: 'test-queue',
      ...body,
    },
  });
}

test('folders: bounded flat CRUD, owner scope, uniqueness and embedded project DTOs', async () => {
  const s = await anonymousSession();
  const other = await anonymousSession();
  const project = await createProject(s, { name: 'Folders' });
  const second = await createProject(s, { name: 'Second' });
  const base = `/api/projects/${project.id}/folders`;
  assert(
    Array.isArray((project as Project & { folders: Folder[] }).folders),
    'create project embeds empty folders'
  );
  expectStatus(await call(base), 401, 'folder list requires auth');
  for (const name of ['', '  ', 'x'.repeat(101), 123, null]) {
    expectStatus(
      await call(base, { method: 'POST', auth: s.token, body: { name } }),
      400,
      'invalid folder name'
    );
  }
  expectStatus(
    await call(base, {
      method: 'POST',
      auth: s.token,
      body: { name: 'nested', parentId: project.id },
    }),
    400,
    'folders are flat'
  );
  const first = await createFolder(s, project.id, '  Work  ');
  assert(first.name === 'Work' && first.projectId === project.id, 'trimmed name, project contract');
  const long = await createFolder(s, project.id, 'x'.repeat(100));
  expectStatus(
    await call(base, { method: 'POST', auth: s.token, body: { name: 'Work ' } }),
    409,
    'unique trimmed name'
  );
  await createFolder(s, second.id, 'Work');
  for (const method of ['GET', 'POST']) {
    expectStatus(
      await call(base, {
        method,
        auth: other.token,
        body: method === 'POST' ? { name: 'bad' } : undefined,
      }),
      404,
      'foreign project'
    );
  }
  for (const method of ['PUT', 'DELETE']) {
    expectStatus(
      await call(`${base}/${first.id}`, {
        method,
        auth: other.token,
        body: method === 'PUT' ? { name: 'bad' } : undefined,
      }),
      404,
      'foreign folder owner'
    );
    expectStatus(
      await call(`/api/projects/${second.id}/folders/${first.id}`, {
        method,
        auth: s.token,
        body: method === 'PUT' ? { name: 'bad' } : undefined,
      }),
      404,
      'wrong project path'
    );
  }
  expectStatus(
    await call(`${base}/${first.id}`, { method: 'PUT', auth: s.token, body: { name: long.name } }),
    409,
    'rename uniqueness'
  );
  expectStatus(
    await call(`${base}/${first.id}`, { method: 'PUT', auth: s.token, body: { name: ' ' } }),
    400,
    'rename validates'
  );
  const renamed = await call(`${base}/${first.id}`, {
    method: 'PUT',
    auth: s.token,
    body: { name: ' Renamed ' },
  });
  expectStatus(renamed, 200, 'rename');
  assert(renamed.data.name === 'Renamed', 'rename trims');
  const listed = await call(base, { auth: s.token });
  assert((listed.data.folders as Folder[]).length === 2, 'GET folders envelope');
  const projectList = await call('/api/projects', { auth: s.token });
  const listedProject = (projectList.data.projects as Array<Project & { folders: Folder[] }>).find(
    (p) => p.id === project.id
  );
  assert(
    listedProject?.folders.some((f) => f.id === first.id && f.name === 'Renamed'),
    'list embeds current folders'
  );
  for (const [path, body] of [
    [`/api/projects/${project.id}`, { name: 'Folders updated' }],
    ['/api/projects', { name: 'Folders updated' }],
  ] as const) {
    const updated = await call(path, { method: 'PUT', auth: s.token, body });
    expectStatus(updated, 200, 'project update');
    assert(
      (updated.data.folders as Folder[]).some((f) => f.id === first.id),
      'update/upsert embeds folders'
    );
  }
  expectStatus(
    await call(`${base}/${long.id}`, { method: 'DELETE', auth: s.token }),
    204,
    'delete folder'
  );
  expectStatus(
    await call(`${base}/${long.id}`, { method: 'DELETE', auth: s.token }),
    404,
    'missing folder'
  );
});

test('folders: agent assignment, inheritance, moves and deletion preserve placement invariants', async () => {
  const s = await anonymousSession();
  const other = await anonymousSession();
  const project = await createProject(s, { name: 'Placement' });
  const second = await createProject(s, { name: 'Move target' });
  const foreignProject = await createProject(other, { name: 'Foreign folder project' });
  const folder = await createFolder(s, project.id, 'Original');
  const destination = await createFolder(s, second.id, 'Target');
  const foreign = await createFolder(other, foreignProject.id, 'Private');
  expectStatus(await folderAgent(s, { folder_id: 'invalid' }), 400, 'UUID validation');
  expectStatus(await folderAgent(s, { folder_id: foreign.id }), 404, 'foreign folder');
  expectStatus(
    await folderAgent(s, { folder_id: '00000000-0000-4000-8000-000000000000' }),
    404,
    'missing folder'
  );
  expectStatus(
    await folderAgent(s, { folder_id: folder.id, project_id: second.id }),
    400,
    'folder/project mismatch'
  );
  expectStatus(
    await folderAgent(s, { folder_id: folder.id, project_id: null }),
    400,
    'Home/folder mismatch'
  );
  const root = await folderAgent(s, { folder_id: folder.id });
  expectStatus(root, 201, 'folder derives project');
  const rootId = root.data.agent_id as string;
  assert(
    root.data.project_id === project.id && root.data.folder_id === folder.id,
    'create response placement'
  );
  const sub = { parent_agent_id: rootId, parent_workflow_id: rootId, depth: 1, bus_id: rootId };
  for (const [extra, expectedProject, expectedFolder] of [
    [{}, project.id, folder.id],
    [{ folder_id: null }, project.id, null],
    [{ project_id: second.id }, second.id, null],
    [{ project_id: null }, null, null],
    [{ folder_id: destination.id }, second.id, destination.id],
  ] as const) {
    const child = await folderAgent(s, { ...sub, ...extra });
    expectStatus(child, 201, 'child placement');
    assert(
      child.data.project_id === expectedProject && child.data.folder_id === expectedFolder,
      'inheritance/explicit override'
    );
  }
  const retriedBody = { ...sub, agent_id: randomUUID(), goal: 'stable folder child' };
  const originalChild = await folderAgent(s, retriedBody);
  expectStatus(originalChild, 201, 'create stable child');
  const retry = await folderAgent(s, retriedBody);
  expectStatus(retry, 201, 'retry stable child');
  assert(
    retry.data.project_id === project.id && retry.data.folder_id === folder.id,
    'descendant retry returns stored placement'
  );
  const patch = (body: Record<string, unknown>, owner = s) =>
    call(`/api/agents/${rootId}`, { method: 'PATCH', headers: apiKeyHeaders(owner.userId), body });
  expectStatus(await patch({ folder_id: foreign.id }), 404, 'update rejects foreign folder');
  expectStatus(
    await patch({ project_id: second.id, folder_id: folder.id }),
    400,
    'update rejects conflicting placement'
  );
  const foreignPatch = await call(`/api/agents/${rootId}`, {
    method: 'PATCH',
    auth: other.token,
    body: { folder_id: null },
  });
  expectStatus(foreignPatch, 404, 'update owner authorization');
  const unchanged = await patch({ title: 'placement remains' });
  expectStatus(unchanged, 200, 'unrelated update');
  assert(
    (unchanged.data.agent as { folder_id: string }).folder_id === folder.id,
    'unrelated update retains folder'
  );
  const moved = await patch({ folder_id: destination.id });
  expectStatus(moved, 200, 'move derives project');
  const movedAgent = moved.data.agent as { project_id: string; folder_id: string };
  assert(
    movedAgent.project_id === second.id && movedAgent.folder_id === destination.id,
    'update response placement'
  );
  const rooted = await patch({ folder_id: null });
  expectStatus(rooted, 200, 'move to project root');
  assert(
    (rooted.data.agent as { project_id: string; folder_id: null }).project_id === second.id &&
      (rooted.data.agent as { folder_id: null }).folder_id === null,
    'null folder retains project'
  );
  await patch({ folder_id: folder.id });
  const list = await call('/api/agents', { headers: apiKeyHeaders(s.userId) });
  const item = (list.data.agents as Array<{ agent_id: string; folder_id: string }>).find(
    (a) => a.agent_id === rootId
  );
  assert(item?.folder_id === folder.id, 'list includes folder_id');
  const detail = await call(`/api/agents/${rootId}`, { headers: apiKeyHeaders(s.userId) });
  expectStatus(detail, 200, 'get agent');
  assert(
    (detail.data.agent as { folder_id: string }).folder_id === folder.id,
    'detail includes folder_id'
  );
  expectStatus(
    await call(`/api/projects/${project.id}/folders/${folder.id}`, {
      method: 'DELETE',
      auth: s.token,
    }),
    204,
    'delete assigned folder'
  );
  let row = await prisma.agent.findUniqueOrThrow({ where: { id: rootId } });
  assert(
    row.folderId === null && row.projectId === project.id,
    'folder deletion returns agent to project root'
  );
  await patch({ folder_id: destination.id });
  // Fresh prisma db push cannot express DEFERRABLE. Exercise that exact
  // constraint mode through the real API, then restore the migration mode.
  await prisma.$executeRawUnsafe(
    'ALTER TABLE "Agent" ALTER CONSTRAINT "Agent_folderId_fkey" NOT DEFERRABLE'
  );
  try {
    const [fk] = await prisma.$queryRaw<Array<{ condeferrable: boolean }>>`
      SELECT condeferrable FROM pg_constraint
      WHERE conrelid = '"Agent"'::regclass AND conname = 'Agent_folderId_fkey'
    `;
    assert(fk.condeferrable === false, 'project deletion exercises an immediate folder FK');
    expectStatus(
      await call(`/api/projects/${second.id}`, { method: 'DELETE', auth: s.token }),
      204,
      'delete project with folders and immediate FK'
    );
  } finally {
    await prisma.$executeRawUnsafe(
      'ALTER TABLE "Agent" ALTER CONSTRAINT "Agent_folderId_fkey" DEFERRABLE INITIALLY DEFERRED'
    );
  }
  row = await prisma.agent.findUniqueOrThrow({ where: { id: rootId } });
  assert(row.folderId === null && row.projectId === null, 'project deletion returns agent Home');
  assert(
    (await prisma.projectFolder.count({ where: { projectId: second.id } })) === 0,
    'project deletion cascades folders'
  );
  await prisma.agent.updateMany({ where: { userId: s.userId }, data: { deletedAt: new Date() } });
});

test('folders: batch validates atomically and persists inherited/explicit placement', async () => {
  const s = await anonymousSession();
  const project = await createProject(s, { name: 'Batch placement' });
  const folder = await createFolder(s, project.id, 'Batch folder');
  const parent = await folderAgent(s, { folder_id: folder.id });
  expectStatus(parent, 201, 'batch parent');
  const parentId = parent.data.agent_id as string;
  const make = (extra: Record<string, unknown>) => ({
    agent_id: randomUUID(),
    goal: 'batch folder test',
    start_phase: 'execute',
    pause_state: true,
    task_queue: 'test-queue',
    parent_agent_id: parentId,
    parent_workflow_id: parentId,
    depth: 1,
    bus_id: parentId,
    ...extra,
  });
  const batch = (agents: Record<string, unknown>[]) =>
    call('/api/agents/batch', {
      method: 'POST',
      headers: apiKeyHeaders(s.userId),
      body: { agents },
    });
  const good = make({});
  expectStatus(
    await batch([good, make({ folder_id: '00000000-0000-4000-8000-000000000000' })]),
    404,
    'batch invalid folder'
  );
  assert(
    (await prisma.agent.count({ where: { id: good.agent_id } })) === 0,
    'invalid batch creates no rows'
  );
  const agents = [
    good,
    make({ folder_id: null }),
    make({ project_id: null }),
    make({ folder_id: folder.id }),
  ];
  const result = await batch(agents);
  assert(
    result.status === 201 || result.status === 207,
    `batch creation status ${result.status}: ${result.text}`
  );
  const rows = await prisma.agent.findMany({
    where: { id: { in: agents.map((a) => a.agent_id) } },
  });
  const byId = new Map(rows.map((a) => [a.id, a]));
  for (const [index, expectedProject, expectedFolder] of [
    [0, project.id, folder.id],
    [1, project.id, null],
    [2, null, null],
    [3, project.id, folder.id],
  ] as const) {
    const row = byId.get(agents[index].agent_id);
    assert(
      row?.projectId === expectedProject && row.folderId === expectedFolder,
      `batch placement ${index}`
    );
  }
  const responses = result.data.results as Array<{
    agent_id: string;
    project_id: string | null;
    folder_id: string | null;
  }>;
  assert(
    responses[0].project_id === project.id && responses[0].folder_id === folder.id,
    'batch response includes placement'
  );
  // Reconcile a durable pending child after its parent's placement changes.
  const pendingId = good.agent_id;
  await prisma.agent.update({
    where: { id: pendingId },
    data: {
      status: 'STARTING_UP',
      temporalWorkflowId: pendingId,
      temporalFirstExecutionRunId: null,
      temporalWorkflowStartPending: true,
      temporalWorkflowStartLeaseUntil: null,
    },
  });
  const folderB = await createFolder(s, project.id, 'Parent destination');
  const movedParent = await call(`/api/agents/${parentId}`, {
    method: 'PATCH',
    headers: apiKeyHeaders(s.userId),
    body: { folder_id: folderB.id },
  });
  expectStatus(movedParent, 200, 'move pending child parent to folder B');
  const retry = await batch([good]);
  assert(retry.status === 201 || retry.status === 207, 'pending batch retry status');
  const storedChild = await prisma.agent.findUniqueOrThrow({ where: { id: pendingId } });
  assert(
    storedChild.projectId === project.id && storedChild.folderId === folder.id,
    'pending retry preserves stored child placement A'
  );
  const retried = (retry.data.results as typeof responses)[0];
  assert(
    retried.project_id === project.id && retried.folder_id === folder.id,
    `pending retry response must retain child placement A: ${JSON.stringify(retried)}`
  );
  await prisma.agent.updateMany({ where: { userId: s.userId }, data: { deletedAt: new Date() } });
});

// Exercise migrate-deploy SQL as well as db-push: existing Agent.projectId FK
// precedes the new ProjectFolder FK and exposes the dual-cascade ordering.
test('folders: migration preserves both deletion paths with the existing project FK', () => {
  const migration = readFileSync(
    resolve(__dirname, '../../../prisma/migrations/20261030210000_project_folders/migration.sql'),
    'utf8'
  );
  const schema = `folder_migration_${randomBytes(8).toString('hex')}`;
  const psqlUrl = new URL(process.env.DATABASE_URL!);
  // Coverage adds Prisma pool options that the native psql client rejects.
  for (const key of ['connection_limit', 'pool_timeout', 'pgbouncer', 'schema', 'socket_timeout'])
    psqlUrl.searchParams.delete(key);
  const result = spawnSync('psql', [psqlUrl.toString(), '-v', 'ON_ERROR_STOP=1', '-q'], {
    encoding: 'utf8',
    timeout: 30_000,
    input: `BEGIN;
CREATE SCHEMA "${schema}";
SET LOCAL search_path TO "${schema}", public;
CREATE TABLE "Project" (id TEXT PRIMARY KEY);
CREATE TABLE "Agent" (id TEXT PRIMARY KEY, "projectId" TEXT REFERENCES "Project"(id) ON DELETE SET NULL ON UPDATE CASCADE);
${migration}
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = '${schema}' AND c.relname = 'ProjectFolder' AND c.relrowsecurity) THEN
    RAISE EXCEPTION 'folder table must deny direct client access with RLS';
  END IF;
END $$;
INSERT INTO "Project" VALUES ('project');
INSERT INTO "ProjectFolder" VALUES ('folder', 'Work', 'project');
INSERT INTO "Agent" VALUES ('agent', 'project', 'folder');
DELETE FROM "ProjectFolder" WHERE id = 'folder';
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM "Agent" WHERE id = 'agent' AND "projectId" = 'project' AND "folderId" IS NULL) THEN
    RAISE EXCEPTION 'folder deletion must preserve project';
  END IF;
END $$;
INSERT INTO "ProjectFolder" VALUES ('folder', 'Work', 'project');
UPDATE "Agent" SET "folderId" = 'folder' WHERE id = 'agent';
DELETE FROM "Project" WHERE id = 'project';
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM "Agent" WHERE id = 'agent' AND "projectId" IS NULL AND "folderId" IS NULL) THEN
    RAISE EXCEPTION 'project deletion must clear both IDs';
  END IF;
  IF EXISTS (SELECT 1 FROM "ProjectFolder") THEN RAISE EXCEPTION 'orphan folder'; END IF;
END $$;
SET CONSTRAINTS ALL IMMEDIATE;
ROLLBACK;`,
  });
  assert(result.status === 0, `migration deletion invariants: ${result.stderr || result.error}`);
});
