import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mock } from 'node:test';

// This in-memory SQL stand-in executes WHERE/order/LIMIT; no application DB or
// provider is opened. Canned rows would hide this particular regression.
const db = new DatabaseSync(':memory:');
db.exec(`CREATE TABLE CodeSession(id TEXT PRIMARY KEY,userId TEXT,ownerAgentId TEXT,repoKey TEXT,state TEXT,lastActiveAt INTEGER,createdAt INTEGER,leaseOwner TEXT,leaseExpiresAt INTEGER,closingTaskId TEXT);
CREATE TABLE Integration(id TEXT PRIMARY KEY,userId TEXT,name TEXT,type TEXT,config TEXT);`);
const now = new Date('2026-11-06T00:00:00Z');
process.env.CODE_SESSION_TTL_DAYS = '14';
let retired = 0;
const value = (v: unknown): string | number | null =>
  v instanceof Date ? v.getTime() : (v as string | number | null);
function whereSql(w: Record<string, unknown>, params: Array<string | number | null>): string {
  return Object.entries(w)
    .map(([k, v]) => {
      if (k === 'OR' || k === 'AND')
        return `(${(v as Record<string, unknown>[]).map((x) => whereSql(x, params)).join(` ${k} `)})`;
      if (v === null) return `"${k}" IS NULL`;
      if (typeof v === 'object' && !(v instanceof Date))
        return Object.entries(v as Record<string, unknown>)
          .map(([op, x]) => {
            const operators: Record<string, string> = { not: '<>', gte: '>=', lte: '<=', lt: '<' };
            assert.ok(operators[op], `unknown predicate ${op}`);
            params.push(value(x));
            return `"${k}" ${operators[op]} ?`;
          })
          .join(' AND ');
      params.push(value(v));
      return `"${k}" = ?`;
    })
    .join(' AND ');
}
function rows(sql: string, params: Array<string | number | null>) {
  return db
    .prepare(sql)
    .all(...params)
    .map((r) => ({
      ...r,
      lastActiveAt: new Date(r.lastActiveAt as number),
      createdAt: new Date(r.createdAt as number),
      leaseExpiresAt: r.leaseExpiresAt === null ? null : new Date(r.leaseExpiresAt as number),
    }));
}
const prisma = {
  $queryRaw: async (q: { sql: string; values: unknown[] }) => rows(q.sql, q.values.map(value)),
  codeSession: {
    findMany: async ({
      where,
      orderBy,
      take,
    }: {
      where: Record<string, unknown>;
      orderBy: { createdAt: string };
      take: number;
    }) => {
      const params: Array<string | number | null> = [];
      const sql = whereSql(where, params);
      assert.equal(orderBy.createdAt, 'asc');
      return rows(`SELECT * FROM CodeSession WHERE ${sql} ORDER BY createdAt ASC LIMIT ?`, [
        ...params,
        take,
      ]);
    },
    updateMany: async ({
      where,
      data,
    }: {
      where: Record<string, unknown>;
      data: Record<string, unknown>;
    }) => {
      if (data.state === 'RETIRED') retired++;
      const params: Array<string | number | null> = [];
      const assignments = Object.entries(data).map(([k, v]) => {
        params.push(value(v));
        return `"${k}" = ?`;
      });
      const sql = whereSql(where, params);
      return {
        count: Number(
          db.prepare(`UPDATE CodeSession SET ${assignments.join(',')} WHERE ${sql}`).run(...params)
            .changes
        ),
      };
    },
    findUniqueOrThrow: async ({ where }: { where: { id: string } }) => {
      const row = rows('SELECT * FROM CodeSession WHERE id=?', [where.id])[0];
      assert.ok(row);
      return row;
    },
  },
  integration: {
    findFirst: async ({
      where: w,
    }: {
      where: { userId: string; name: string; type: string; config: { equals: string } };
    }) =>
      db
        .prepare(
          `SELECT id FROM Integration WHERE userId=? AND name=? AND type=? AND config ->> 'code_session_id'=? LIMIT 1`
        )
        .get(w.userId, w.name, w.type, w.config.equals) ?? null,
  },
};
function session(id: string, days: number, created: number, other: Record<string, unknown> = {}) {
  const row = {
    id,
    userId: 'user',
    ownerAgentId: 'owner',
    repoKey: 'https://example.test/repo',
    state: 'PAUSED',
    lastActiveAt: now.getTime() - days * 86400000,
    createdAt: created,
    leaseOwner: null,
    leaseExpiresAt: null,
    closingTaskId: null,
    ...other,
  };
  db.prepare('INSERT INTO CodeSession VALUES (?,?,?,?,?,?,?,?,?,?)').run(
    ...Object.values(row).map(value)
  );
}
let serial = 0;
function pin(id: string, user = 'user', name = 'cli', type = 'TOOL_SETUP') {
  db.prepare('INSERT INTO Integration VALUES (?,?,?,?,?)').run(
    `pin-${++serial}`,
    user,
    name,
    type,
    JSON.stringify({ code_session_id: id })
  );
}
async function main() {
  await mock.module('../../providers/database', { namedExports: { prisma } });
  await mock.module('../../providers/logger', {
    namedExports: { createLogger: () => ({ info() {}, warn() {}, error() {} }) },
  });
  const { ownerCodeSessions, resolveCodeSession } =
    await import('../../providers/codeSessions/store');
  for (let n = 0; n < 10; n++) session(`expired-${n}`, 20, n);
  session('active-eleventh', 1, 10);
  assert.deepEqual(
    (await ownerCodeSessions('user', 'owner', 'https://example.test/repo.git/', now)).map(
      (r) => r.id
    ),
    ['active-eleventh'],
    'ten expired unpinned rows must not hide the eleventh active session'
  );
  session('pinned-twelfth', 30, 11);
  pin('pinned-twelfth');
  pin('pinned-twelfth');
  session('foreign-pin', 30, 12);
  pin('foreign-pin', 'other-user');
  session('wrong-name-pin', 30, 13);
  pin('wrong-name-pin', 'user', 'other');
  session('wrong-type-pin', 30, 14);
  pin('wrong-type-pin', 'user', 'cli', 'OTHER');
  session('foreign-user', 1, 15, { userId: 'other-user' });
  pin('foreign-user');
  session('foreign-owner', 1, 16, { ownerAgentId: 'other-owner' });
  pin('foreign-owner');
  session('foreign-repo', 1, 17, { repoKey: 'https://elsewhere.test/repo' });
  pin('foreign-repo');
  session('retired-pin', 1, 18, { state: 'RETIRED' });
  pin('retired-pin');
  assert.deepEqual(
    (await ownerCodeSessions('user', 'owner', 'https://example.test/repo', now)).map((r) => r.id),
    ['active-eleventh', 'pinned-twelfth']
  );
  for (let n = 0; n < 12; n++) session(`current-${n}`, 1, 20 + n);
  const selected = await ownerCodeSessions('user', 'owner', 'https://example.test/repo', now);
  assert.equal(selected.length, 10);
  assert.deepEqual(
    selected.map((r) => r.id),
    ['active-eleventh', 'pinned-twelfth', ...Array.from({ length: 8 }, (_, n) => `current-${n}`)]
  );
  const result = await resolveCodeSession({
    userId: 'user',
    ownerAgentId: 'owner',
    rootAgentId: 'root',
    repoUrl: 'https://example.test/repo.git',
    codeProvider: 'claude',
    leaseOwner: 'tool:one',
    now,
    planBranch: async () => {
      throw Error('existing session must be reused');
    },
  });
  const retry = await resolveCodeSession({
    userId: 'user',
    ownerAgentId: 'owner',
    rootAgentId: 'root',
    repoUrl: 'https://example.test/repo',
    codeProvider: 'claude',
    leaseOwner: 'tool:one',
    now,
    planBranch: async () => {
      throw Error('same lease must reuse');
    },
  });
  assert.equal(retry.session.id, 'active-eleventh');
  await assert.rejects(
    resolveCodeSession({
      userId: 'user',
      ownerAgentId: 'owner',
      rootAgentId: 'root',
      repoUrl: 'https://example.test/repo',
      codeProvider: 'claude',
      leaseOwner: 'tool:two',
      now,
      shared: true,
      planBranch: async () => {
        throw Error('shared busy must not fork');
      },
    }),
    /in use by another code agent/
  );
  const parallel = await resolveCodeSession({
    userId: 'user',
    ownerAgentId: 'owner',
    rootAgentId: 'root',
    repoUrl: 'https://example.test/repo',
    codeProvider: 'claude',
    leaseOwner: 'tool:two',
    now,
    planBranch: async () => {
      throw Error('free eligible parallel session must be reused');
    },
  });
  assert.equal(parallel.session.id, 'pinned-twelfth');
  assert.equal(result.created, false);
  assert.equal(result.session.id, 'active-eleventh');
  assert.equal(result.session.leaseOwner, 'tool:one');
  assert.equal(retired, 0);
  assert.equal(
    db.prepare("SELECT COUNT(*) AS n FROM CodeSession WHERE state='RETIRED'").get()?.n,
    1
  );
  process.stdout.write(
    'Owner selection eligibility before LIMIT, scoped pins, ordering, bounded results and lease reuse PASS\n'
  );
}
main()
  .catch((e) => {
    process.stderr.write(`${e instanceof Error ? e.stack : String(e)}\n`);
    process.exitCode = 1;
  })
  .finally(() => db.close());
