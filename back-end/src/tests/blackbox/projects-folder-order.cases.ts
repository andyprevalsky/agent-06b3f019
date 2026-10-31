/** Persisted folder ordering through the public project API and migration SQL. */
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomBytes, randomUUID } from 'crypto';
import { anonymousSession, assert, call, expectStatus, type Session } from './projects-harness';
import { prisma } from '../../providers/database';

interface Folder {
  id: string;
  name: string;
  sortOrder: number;
}

async function project(s: Session, name: string): Promise<string> {
  const response = await call('/api/projects', { method: 'POST', auth: s.token, body: { name } });
  expectStatus(response, 201, 'create ordering project');
  return response.data.id as string;
}

async function folder(s: Session, id: string, name: string): Promise<Folder> {
  const response = await call(`/api/projects/${id}/folders`, {
    method: 'POST',
    auth: s.token,
    body: { name },
  });
  expectStatus(response, 201, 'create ordered folder');
  return response.data as unknown as Folder;
}

function ids(folders: Folder[]): string {
  return folders.map((item) => item.id).join(',');
}

test('folders: order persists across every project DTO, rename and append', async () => {
  const s = await anonymousSession();
  const id = await project(s, 'Persistent order');
  const base = `/api/projects/${id}`;
  const z = await folder(s, id, 'Z');
  const a = await folder(s, id, 'A');
  const m = await folder(s, id, 'M');
  const reordered = await call(`${base}/folders/order`, {
    method: 'PUT',
    auth: s.token,
    body: { folderIds: [m.id, z.id, a.id] },
  });
  expectStatus(reordered, 200, 'save order');
  const expected = [m.id, z.id, a.id].join(',');
  assert(ids(reordered.data.folders as Folder[]) === expected, 'response matches desired order');
  assert(
    (reordered.data.folders as Folder[]).every((item, index) => item.sortOrder === index),
    'dense zero-based ranks returned'
  );
  expectStatus(
    await call(`${base}/folders/${z.id}`, {
      method: 'PUT',
      auth: s.token,
      body: { name: 'AAA renamed' },
    }),
    200,
    'rename preserves order'
  );
  const listed = await call(`${base}/folders`, { auth: s.token });
  assert(ids(listed.data.folders as Folder[]) === expected, 'list uses saved order after rename');
  for (const [path, method, body] of [
    [base, 'GET', undefined],
    [base, 'PUT', { name: 'Persistent order updated' }],
    ['/api/projects', 'PUT', { name: 'Persistent order updated' }],
  ] as const) {
    const response = await call(path, { method, auth: s.token, body });
    expectStatus(response, 200, 'embedded project order');
    assert(ids(response.data.folders as Folder[]) === expected, `${method} ${path} order`);
  }
  const projects = await call('/api/projects', { auth: s.token });
  const embedded = (projects.data.projects as Array<{ id: string; folders: Folder[] }>).find(
    (item) => item.id === id
  );
  assert(embedded !== undefined && ids(embedded.folders) === expected, 'project list order');
  const appended = await folder(s, id, '000 sorts before names');
  const final = await call(`${base}/folders`, { auth: s.token });
  assert(
    ids(final.data.folders as Folder[]) === `${expected},${appended.id}`,
    'new folder appends'
  );
  assert(appended.sortOrder === 3, 'append uses next persisted rank');
});

test('folders: malformed, foreign and stale orders cannot partially mutate membership or ranks', async () => {
  const s = await anonymousSession();
  const other = await anonymousSession();
  const id = await project(s, 'Order validation');
  const foreignProject = await project(other, 'Private order');
  const a = await folder(s, id, 'A');
  const b = await folder(s, id, 'B');
  const foreign = await folder(other, foreignProject, 'Private');
  const path = `/api/projects/${id}/folders/order`;
  expectStatus(await call(path, { method: 'PUT', body: { folderIds: [b.id, a.id] } }), 401, 'auth');
  expectStatus(
    await call(path, {
      method: 'PUT',
      auth: other.token,
      body: { folderIds: [b.id, a.id] },
    }),
    404,
    'owner isolation'
  );
  const before = await prisma.projectFolder.findMany({
    where: { projectId: id },
    orderBy: { id: 'asc' },
  });
  for (const body of [
    {},
    { folderIds: [] },
    { folderIds: 'wrong' },
    { folderIds: null },
    { folderIds: [''] },
    { folderIds: [123] },
    { folderIds: ['not-a-uuid'] },
    { folderIds: [a.id, a.id] },
    { folderIds: [a.id.toUpperCase(), a.id] },
    { folderIds: [a.id, b.id], extra: true },
    { folderIds: Array.from({ length: 1001 }, () => randomUUID()) },
  ]) {
    expectStatus(await call(path, { method: 'PUT', auth: s.token, body }), 400, 'malformed order');
  }
  for (const folderIds of [[a.id], [b.id, foreign.id], [a.id, b.id, randomUUID()]]) {
    const response = await call(path, { method: 'PUT', auth: s.token, body: { folderIds } });
    expectStatus(response, 409, 'stale membership');
    assert(response.data.code === 'folder_order_stale', 'typed stale response');
  }
  const c = await folder(s, id, 'C');
  expectStatus(
    await call(path, {
      method: 'PUT',
      auth: s.token,
      body: { folderIds: [b.id, a.id] },
    }),
    409,
    'stale after creation'
  );
  expectStatus(
    await call(`/api/projects/${id}/folders/${c.id}`, {
      method: 'DELETE',
      auth: s.token,
    }),
    204,
    'delete new member'
  );
  expectStatus(
    await call(path, {
      method: 'PUT',
      auth: s.token,
      body: { folderIds: [c.id, b.id, a.id] },
    }),
    409,
    'stale after deletion'
  );
  const after = await prisma.projectFolder.findMany({
    where: { projectId: id },
    orderBy: { id: 'asc' },
  });
  assert(JSON.stringify(before) === JSON.stringify(after), 'no rejected request changes rows');
  const foreignRows = await call(`/api/projects/${foreignProject}/folders`, { auth: other.token });
  assert(ids(foreignRows.data.folders as Folder[]) === foreign.id, 'foreign membership unchanged');
});

test('folders: racing creation and reorder preserve every folder and one coherent order', async () => {
  const s = await anonymousSession();
  const id = await project(s, 'Concurrent order');
  const a = await folder(s, id, 'A');
  const b = await folder(s, id, 'B');
  const path = `/api/projects/${id}/folders`;
  const [reorder, created] = await Promise.all([
    call(`${path}/order`, { method: 'PUT', auth: s.token, body: { folderIds: [b.id, a.id] } }),
    folder(s, id, 'C'),
  ]);
  assert(reorder.status === 200 || reorder.status === 409, 'serialized reorder or stale conflict');
  const rows = (await call(path, { auth: s.token })).data.folders as Folder[];
  const expected = reorder.status === 200 ? [b.id, a.id, created.id] : [a.id, b.id, created.id];
  assert(ids(rows) === expected.join(','), 'creation is appended to one complete order');
  assert(
    rows.every((item, index) => item.sortOrder === index),
    'concurrent writes retain dense ranks'
  );
  const [deleted, secondReorder] = await Promise.all([
    call(`${path}/${b.id}`, { method: 'DELETE', auth: s.token }),
    call(`${path}/order`, {
      method: 'PUT',
      auth: s.token,
      body: { folderIds: [created.id, b.id, a.id] },
    }),
  ]);
  expectStatus(deleted, 204, 'racing deletion');
  assert(
    secondReorder.status === 200 || secondReorder.status === 409,
    'deletion serializes with reorder'
  );
  const finalRows = (await call(path, { auth: s.token })).data.folders as Folder[];
  const finalExpected = secondReorder.status === 200 ? [created.id, a.id] : [a.id, created.id];
  assert(
    ids(finalRows) === finalExpected.join(','),
    'deletion preserves the surviving complete order'
  );
  const added = await Promise.all([folder(s, id, 'D'), folder(s, id, 'E')]);
  const appendedRows = (await call(path, { auth: s.token })).data.folders as Folder[];
  assert(
    ids(appendedRows.slice(0, 2)) === finalExpected.join(','),
    'concurrent appends retain prior order'
  );
  assert(
    new Set(appendedRows.map((item) => item.sortOrder)).size === 4,
    'concurrent appends allocate distinct ranks'
  );
  assert(
    added.every((item) => appendedRows.slice(2).some((row) => row.id === item.id)),
    'both concurrent creations survive'
  );
});

test('folders: additive ordering migration backfills each project alphabetically with ID ties', () => {
  const migration = readFileSync(
    resolve(
      __dirname,
      '../../../prisma/migrations/20261031002500_project_folder_order/migration.sql'
    ),
    'utf8'
  );
  const schema = `folder_order_${randomBytes(8).toString('hex')}`;
  const url = new URL(process.env.DATABASE_URL!);
  for (const key of ['connection_limit', 'pool_timeout', 'pgbouncer', 'schema', 'socket_timeout']) {
    url.searchParams.delete(key);
  }
  // A single psql session keeps the isolated search_path across the migration's transaction.
  const result = spawnSync('psql', [url.toString(), '-v', 'ON_ERROR_STOP=1', '-q'], {
    encoding: 'utf8',
    timeout: 30_000,
    input: `CREATE SCHEMA "${schema}";
SET search_path TO "${schema}", public;
CREATE TABLE "ProjectFolder" (id TEXT PRIMARY KEY, name TEXT NOT NULL, "projectId" TEXT NOT NULL);
INSERT INTO "ProjectFolder" VALUES ('z', 'Z', 'p'), ('b', 'A', 'p'), ('a', 'A', 'p'), ('x', 'X', 'q');
${migration}
DO $$ BEGIN
  IF (SELECT string_agg(id, ',' ORDER BY "sortOrder") FROM "ProjectFolder" WHERE "projectId" = 'p') <> 'a,b,z'
    OR (SELECT "sortOrder" FROM "ProjectFolder" WHERE id = 'x') <> 0 THEN
    RAISE EXCEPTION 'ordering migration must preserve per-project name/id order';
  END IF;
  IF (SELECT COUNT(*) FROM "ProjectFolder") <> 4 THEN RAISE EXCEPTION 'migration lost folders'; END IF;
END $$;`,
  });
  const cleanup = spawnSync('psql', [url.toString(), '-v', 'ON_ERROR_STOP=1', '-q'], {
    encoding: 'utf8',
    timeout: 30_000,
    input: `DROP SCHEMA IF EXISTS "${schema}" CASCADE;`,
  });
  assert(result.status === 0, `ordering migration: ${result.stderr || result.error}`);
  assert(cleanup.status === 0, `ordering migration cleanup: ${cleanup.stderr || cleanup.error}`);
});
