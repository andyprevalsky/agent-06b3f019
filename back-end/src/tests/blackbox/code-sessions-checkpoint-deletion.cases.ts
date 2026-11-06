/**
 * Checkpoint deletion cases, run inside code-sessions.blackbox.ts with its local
 * object store (CODE_SESSION_STORAGE_LOCAL_DIR):
 *
 *   retire ──► delete artifacts, manifest last ──► markRetired
 *     a failed manifest read or artifact delete keeps the manifest (the only
 *     index of the artifact keys) and the session, so a later retire finishes;
 *   TTL sweep ──► one session that keeps failing never stops the others.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { Sandbox } from 'e2b';
import { prisma } from '../../providers/database';
import { checkpointKey } from '../../providers/codeSessions/artifactStore';
import {
  checkpointCodeSession,
  retireCodeSession,
  sweepExpiredCodeSessions,
} from '../../providers/codeSessions/lifecycle';
import { localSandboxFs } from '../../providers/codeSessions/sandboxFs';

export interface CheckpointDeletionContext {
  fixtureDir: string;
  seedWorkspace: (home: string) => unknown;
}

const DAY_MS = 24 * 60 * 60 * 1000;

function storagePath(userId: string, codeSessionId: string, seq: number, name: string): string {
  return join(
    process.env.CODE_SESSION_STORAGE_LOCAL_DIR ?? '',
    checkpointKey(userId, codeSessionId, seq, name)
  );
}

/** A transient delete failure: a non-empty directory where the artifact file was. */
function blockDelete(path: string): void {
  rmSync(path);
  mkdirSync(path);
  writeFileSync(join(path, 'blocker'), 'x');
}

export function registerCheckpointDeletionCases(ctx: CheckpointDeletionContext): void {
  async function withUser(fn: (userId: string) => Promise<void>): Promise<void> {
    const userId = `code-session-delete-${randomUUID()}`;
    await prisma.user.create({ data: { userId, name: 'Code Session Delete' } });
    try {
      await fn(userId);
    } finally {
      await prisma.codeSession.deleteMany({ where: { userId } });
      await prisma.user.deleteMany({ where: { userId } });
    }
  }

  async function sessionWithCheckpoints(userId: string, saves: number, ageDays = 0) {
    const owner = randomUUID();
    const home = join(ctx.fixtureDir, `home-delete-${randomUUID()}`);
    ctx.seedWorkspace(home);
    const row = await prisma.codeSession.create({
      data: { userId, rootAgentId: owner, ownerAgentId: owner, repoKey: '', state: 'PAUSED' },
    });
    for (let i = 0; i < saves; i += 1) {
      writeFileSync(join(home, 'workspace', `save-${i}.txt`), `${i}\n`);
      const current = await prisma.codeSession.findUniqueOrThrow({ where: { id: row.id } });
      assert.ok(
        await checkpointCodeSession({
          session: current,
          fs: localSandboxFs(home),
          reason: 'close',
          agentId: owner,
        })
      );
    }
    if (ageDays > 0) {
      await prisma.codeSession.update({
        where: { id: row.id },
        data: { lastActiveAt: new Date(Date.now() - ageDays * DAY_MS) },
      });
    }
    return row;
  }

  test('retiring never drops a checkpoint manifest whose read or artifact delete failed; a later retire finishes the job', async (t) => {
    t.mock.method(Sandbox, 'kill', async () => true);
    await withUser(async (userId) => {
      const session = await sessionWithCheckpoints(userId, 2);
      const path = (seq: number, name: string) => storagePath(userId, session.id, seq, name);
      // seq 1: the manifest cannot be read (a transient storage read error).
      chmodSync(path(1, 'manifest.json'), 0o000);
      // seq 2: one artifact cannot be deleted (a transient storage delete error).
      blockDelete(path(2, 'worktree.tar.gz'));
      try {
        const row = await prisma.codeSession.findUniqueOrThrow({ where: { id: session.id } });
        await assert.rejects(retireCodeSession(row));
        assert.ok(existsSync(path(1, 'manifest.json')), 'an unread manifest is kept for the retry');
        assert.ok(
          existsSync(path(2, 'manifest.json')),
          'a manifest whose artifacts remain is kept'
        );
        const held = await prisma.codeSession.findUniqueOrThrow({ where: { id: session.id } });
        assert.notEqual(held.state, 'RETIRED', 'an incomplete delete never marks it retired');
      } finally {
        if (existsSync(path(1, 'manifest.json'))) chmodSync(path(1, 'manifest.json'), 0o644);
        rmSync(path(2, 'worktree.tar.gz'), { recursive: true, force: true });
      }
      const again = await prisma.codeSession.findUniqueOrThrow({ where: { id: session.id } });
      await retireCodeSession(again);
      const retired = await prisma.codeSession.findUniqueOrThrow({ where: { id: session.id } });
      assert.equal(retired.state, 'RETIRED');
      for (const seq of [1, 2]) {
        const dir = join(path(seq, 'manifest.json'), '..');
        assert.deepEqual(existsSync(dir) ? readdirSync(dir) : [], [], `checkpoint ${seq} deleted`);
      }
    });
  });

  test('one session whose checkpoint delete keeps failing does not stop the TTL sweep from retiring the others', async (t) => {
    t.mock.method(Sandbox, 'kill', async () => true);
    await withUser(async (userId) => {
      const stuck = await sessionWithCheckpoints(userId, 1, 30);
      const next = await sessionWithCheckpoints(userId, 1, 20);
      const blocked = storagePath(userId, stuck.id, 1, 'worktree.tar.gz');
      blockDelete(blocked);
      try {
        await sweepExpiredCodeSessions(userId);
        const rows = await prisma.codeSession.findMany({
          where: { id: { in: [stuck.id, next.id] } },
          select: { id: true, state: true },
        });
        const state = new Map(rows.map((row) => [row.id, row.state]));
        assert.notEqual(
          state.get(stuck.id),
          'RETIRED',
          'the stuck session stays for the next sweep'
        );
        assert.equal(state.get(next.id), 'RETIRED', 'the sweep goes on to the next session');
      } finally {
        rmSync(blocked, { recursive: true, force: true });
      }
    });
  });
}
