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

function move(s: Session, projectId: string, folderId: string, beforeId: string | null) {
  return call(`/api/projects/${projectId}/folders/${folderId}/position`, {
    method: 'PUT',
    auth: s.token,
    body: { beforeId },
  });
}

test('folders: single move persists across project DTOs, rename and append', async () => {
  const s = await anonymousSession();
  const id = await project(s, 'Persistent move');
  const base = `/api/projects/${id}`;
  const z = await folder(s, id, 'Z');
  const a = await folder(s, id, 'A');
  const m = await folder(s, id, 'M');
  const moved = await move(s, id, m.id, z.id);
  expectStatus(moved, 200, 'move before first');
  const expected = [m.id, z.id, a.id].join(',');
  assert(ids(moved.data.folders as Folder[]) === expected, 'move response order');
  expectStatus(
    await call(`${base}/folders/${z.id}`, {
      method: 'PUT',
      auth: s.token,
      body: { name: 'AAA renamed' },
    }),
    200,
    'rename preserves position'
  );
  const listed = await call(`${base}/folders`, { auth: s.token });
  assert(ids(listed.data.folders as Folder[]) === expected, 'list persisted after rename');
  for (const [path, method, body] of [
    [base, 'GET', undefined],
    [base, 'PUT', { name: 'Persistent move updated' }],
    ['/api/projects', 'PUT', { name: 'Persistent move updated' }],
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
  const end = await move(s, id, m.id, null);
  expectStatus(end, 200, 'move to end');
  assert(
    ids(end.data.folders as Folder[]) === [z.id, a.id, appended.id, m.id].join(','),
    'null means end'
  );
});

test('folders: malformed, foreign, missing and self moves never partially write', async () => {
  const s = await anonymousSession();
  const other = await anonymousSession();
  const id = await project(s, 'Move validation');
  const sibling = await project(s, 'Same owner other project');
  const privateId = await project(other, 'Private move');
  const a = await folder(s, id, 'A');
  const b = await folder(s, id, 'B');
  const cross = await folder(s, sibling, 'Cross project');
  const foreign = await folder(other, privateId, 'Foreign');
  const path = `/api/projects/${id}/folders/${a.id}/position`;
  expectStatus(await call(path, { method: 'PUT', body: { beforeId: b.id } }), 401, 'auth');
  expectStatus(await move(other, id, a.id, b.id), 404, 'foreign project owner');
  const before = await prisma.projectFolder.findMany({
    where: { projectId: id },
    orderBy: { id: 'asc' },
  });
  for (const body of [
    {},
    { beforeId: '' },
    { beforeId: 123 },
    { beforeId: [] },
    { beforeId: 'not-a-uuid' },
    { beforeId: b.id, extra: true },
  ]) {
    expectStatus(await call(path, { method: 'PUT', auth: s.token, body }), 400, 'malformed move');
  }
  expectStatus(await move(s, id, a.id, a.id), 400, 'source cannot precede itself');
  for (const source of [randomUUID(), cross.id, foreign.id]) {
    expectStatus(await move(s, id, source, b.id), 404, 'source missing from owned project');
  }
  for (const target of [randomUUID(), cross.id, foreign.id]) {
    const response = await move(s, id, a.id, target);
    expectStatus(response, 409, 'stale or cross-project destination');
    assert(response.data.code === 'folder_order_stale', 'typed stale target');
  }
  const deleted = await folder(s, id, 'Deleted');
  expectStatus(
    await call(`/api/projects/${id}/folders/${deleted.id}`, {
      method: 'DELETE',
      auth: s.token,
    }),
    204,
    'delete stale destination'
  );
  expectStatus(await move(s, id, a.id, deleted.id), 409, 'deleted target');
  expectStatus(await move(s, id, deleted.id, b.id), 404, 'deleted source');
  const after = await prisma.projectFolder.findMany({
    where: { projectId: id },
    orderBy: { id: 'asc' },
  });
  assert(
    JSON.stringify(before) === JSON.stringify(after),
    'rejected moves leave every original row unchanged'
  );
  const foreignRows = await call(`/api/projects/${privateId}/folders`, { auth: other.token });
  assert(ids(foreignRows.data.folders as Folder[]) === foreign.id, 'foreign membership unchanged');
});

test('folders: move up, down and end preserve order across deletion gaps', async () => {
  const s = await anonymousSession();
  const id = await project(s, 'Gapped moves');
  const values: Folder[] = [];
  for (const name of ['A', 'B', 'C', 'D', 'E']) values.push(await folder(s, id, name));
  const [a, b, c, d, e] = values;
  for (const removed of [b, d])
    expectStatus(
      await call(`/api/projects/${id}/folders/${removed.id}`, {
        method: 'DELETE',
        auth: s.token,
      }),
      204,
      'create gap by deletion'
    );
  for (const [source, target, expected] of [
    [a.id, e.id, [c.id, a.id, e.id]],
    [e.id, c.id, [e.id, c.id, a.id]],
    [e.id, null, [c.id, a.id, e.id]],
  ] as const) {
    const response = await move(s, id, source, target);
    expectStatus(response, 200, 'gapped move');
    assert(
      ids(response.data.folders as Folder[]) === expected.join(','),
      'gapped move relative order'
    );
  }
});

test('folders: moving within tied ranks preserves the existing relative order', async () => {
  const s = await anonymousSession();
  const id = await project(s, 'Legacy tied folder ranks');
  const rows = ['A', 'B', 'C', 'D'].map((name) => ({
    id: randomUUID(),
    projectId: id,
    name,
    sortOrder: 0,
  }));
  // Legacy writers omit an explicit rank; insertion order must not define display order.
  await prisma.projectFolder.createMany({ data: [rows[3], rows[1], rows[0], rows[2]] });
  const before = await call(`/api/projects/${id}/folders`, { auth: s.token });
  expectStatus(before, 200, 'list tied ranks before move');
  assert(
    ids(before.data.folders as Folder[]) === rows.map((row) => row.id).join(','),
    'equal ranks start in the existing A,B,C,D name order'
  );
  assert(
    (before.data.folders as Folder[]).every((row) => row.sortOrder === 0),
    'fixture exercises four equal ranks'
  );
  const response = await move(s, id, rows[2].id, rows[1].id);
  expectStatus(response, 200, 'move C before B within tied ranks');
  const expected = [rows[0].id, rows[2].id, rows[1].id, rows[3].id].join(',');
  assert(
    ids(response.data.folders as Folder[]) === expected,
    `moving C before B must preserve A,C,B,D; got ${(response.data.folders as Folder[]).map((row) => row.name).join(',')}`
  );
  const after = await call(`/api/projects/${id}/folders`, { auth: s.token });
  expectStatus(after, 200, 'list tied ranks after move');
  assert(ids(after.data.folders as Folder[]) === expected, 'tied-rank move persists A,C,B,D');
});

test('folders: moves work beyond 1000 folders with a constant-size request', async () => {
  const s = await anonymousSession();
  const id = await project(s, 'Large move');
  const rows = Array.from({ length: 1005 }, (_, index) => ({
    id: randomUUID(),
    projectId: id,
    name: `Folder ${index}`,
    sortOrder: index * 2,
  }));
  await prisma.projectFolder.createMany({ data: rows });
  const first = rows[0].id;
  const last = rows[rows.length - 1].id;
  const movedFirst = await move(s, id, last, first);
  expectStatus(movedFirst, 200, 'large project move first');
  assert(
    ids(movedFirst.data.folders as Folder[]) ===
      [last, ...rows.slice(0, -1).map((row) => row.id)].join(','),
    'last folder moved first and every other folder kept relative order'
  );
  const movedLast = await move(s, id, last, null);
  expectStatus(movedLast, 200, 'large project move end');
  assert(
    ids(movedLast.data.folders as Folder[]) === rows.map((row) => row.id).join(','),
    'same folder moved last and all 1005 folders preserved'
  );
});

test('folders: moves serialize with create, delete and parallel appends', async () => {
  const s = await anonymousSession();
  const id = await project(s, 'Concurrent move');
  const a = await folder(s, id, 'A');
  const b = await folder(s, id, 'B');
  const path = `/api/projects/${id}/folders`;
  const [moved, c] = await Promise.all([move(s, id, b.id, a.id), folder(s, id, 'C')]);
  expectStatus(moved, 200, 'move and create');
  const listed = (await call(path, { auth: s.token })).data.folders as Folder[];
  assert(
    ids(listed) === [b.id, a.id, c.id].join(','),
    'concurrent create appends after moved pair'
  );
  const [deleted, secondMove] = await Promise.all([
    call(`${path}/${b.id}`, { method: 'DELETE', auth: s.token }),
    move(s, id, c.id, b.id),
  ]);
  expectStatus(deleted, 204, 'racing target deletion');
  assert(
    secondMove.status === 200 || secondMove.status === 409,
    'move commits or rejects stale target'
  );
  const finalRows = (await call(path, { auth: s.token })).data.folders as Folder[];
  const expected = secondMove.status === 200 ? [c.id, a.id] : [a.id, c.id];
  assert(ids(finalRows) === expected.join(','), 'race preserves coherent survivor order');
  const added = await Promise.all([folder(s, id, 'D'), folder(s, id, 'E')]);
  const appended = (await call(path, { auth: s.token })).data.folders as Folder[];
  assert(
    ids(appended.slice(0, 2)) === expected.join(','),
    'concurrent appends preserve survivor order'
  );
  assert(
    new Set(appended.map((item) => item.sortOrder)).size === 4,
    'concurrent appends have distinct ranks'
  );
  assert(
    added.every((item) => appended.slice(2).some((row) => row.id === item.id)),
    'both creations survive'
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
