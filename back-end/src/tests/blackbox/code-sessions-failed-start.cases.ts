import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { Sandbox } from 'e2b';
import { prisma } from '../../providers/database';
import {
  CodeSessionHeldError,
  releaseSandboxAfterFailedRestore,
  releaseSandboxAfterFailedStart,
} from '../../providers/e2bCodeSessionSandbox';
import type { ProjectWorkspace } from '../../providers/projects/types';
import { restoreSandboxProject } from '../../providers/projects/workspace';
import { registerFailedProviderRollbackCases } from './code-sessions-failed-provider-rollback.cases';
import { CodeAgentCredentialError } from '../../providers/claudeCodeSandboxAuth';
import { createWithCodeSession } from '../../providers/codeSessions/spawn';

export function registerFailedStartPauseCases(userId: string, agentId: string) {
  registerFailedProviderRollbackCases();
  for (const switched of [true, false]) {
    test(`original start error survives ${switched ? 'rollback kill' : 'pause write'} failure`, async (t) => {
      const seed = await prisma.codeSession.create({
        data: {
          userId,
          rootAgentId: agentId,
          ownerAgentId: agentId,
          repoKey: '',
          codeProvider: switched ? 'claude' : 'codex',
          state: 'PAUSED',
        },
      });
      const original = new CodeAgentCredentialError(
        'Cannot start code session',
        'fixture credentials'
      );
      const cleanupError = new Error('fixture cleanup rejected');
      const sandboxId = `failed-revert-${randomUUID()}`;
      const originalUpdate = prisma.codeSession.updateMany;
      const update = originalUpdate.bind(prisma.codeSession);
      let failingPause = false;
      prisma.codeSession.updateMany = (async (...args: Parameters<typeof update>) => {
        if (failingPause) throw cleanupError;
        return update(...args);
      }) as typeof originalUpdate;
      t.mock.method(Sandbox, 'kill', async () => {
        throw cleanupError;
      });
      try {
        await assert.rejects(
          createWithCodeSession(
            {
              userId,
              agentId,
              repoUrl: null,
              codeProvider: 'codex',
              codeSessionId: seed.id,
            },
            async (session) => {
              assert(session);
              if (switched) {
                await update({
                  where: { id: seed.id },
                  data: {
                    state: 'ACTIVE',
                    sandboxId,
                    sandboxKind: 'e2b',
                  },
                });
              } else failingPause = true;
              throw original;
            }
          ),
          (error: unknown) => error === original
        );
        const held = await prisma.codeSession.findUniqueOrThrow({ where: { id: seed.id } });
        assert.equal(held.codeProvider, 'codex');
        if (switched) {
          assert.equal(held.sandboxId, sandboxId);
          assert.match(held.leaseOwner ?? '', /^provider-revert:/);
        } else assert.notEqual(held.leaseOwner, null);
      } finally {
        prisma.codeSession.updateMany = originalUpdate;
        failingPause = false;
        await prisma.codeSession.delete({ where: { id: seed.id } });
      }
    });
  }
  test('a spawn refused because the user holds the live CLI leaves the session live', async () => {
    // The user chats with this session's CLI directly and an older ws-server
    // refuses the attaching spawn (CodeSessionHeldError). The session is live:
    // it must not be marked PAUSED (it would read as stopped and let another
    // spawn take the lease and stop that ws-server); only this lease is dropped.
    const seed = await prisma.codeSession.create({
      data: {
        userId,
        rootAgentId: agentId,
        ownerAgentId: agentId,
        repoKey: '',
        codeProvider: 'claude',
        state: 'PAUSED',
      },
    });
    try {
      const held = new CodeSessionHeldError();
      await assert.rejects(
        createWithCodeSession(
          { userId, agentId, repoUrl: null, codeProvider: 'claude', codeSessionId: seed.id },
          async (session) => {
            assert(session);
            throw held;
          }
        ),
        (error: unknown) => error === held
      );
      const row = await prisma.codeSession.findUniqueOrThrow({ where: { id: seed.id } });
      assert.notEqual(row.state, 'PAUSED', 'a held session is live, never marked PAUSED');
      assert.equal(row.leaseOwner, null, "the refused spawn's lease is released");
    } finally {
      await prisma.codeSession.delete({ where: { id: seed.id } });
    }
  });

  test('confirmed switched native pause retains custody through outer rollback', async (t) => {
    const seed = await prisma.codeSession.create({
      data: {
        userId,
        rootAgentId: agentId,
        ownerAgentId: agentId,
        repoKey: '',
        codeProvider: 'claude',
        state: 'PAUSED',
      },
    });
    const sandboxId = `confirmed-switched-failed-start-${randomUUID()}`;
    let kills = 0;
    t.mock.method(Sandbox, 'kill', async (id: string) => {
      assert.equal(id, sandboxId);
      const held = await prisma.codeSession.findUniqueOrThrow({ where: { id: seed.id } });
      assert.equal(held.codeProvider, 'codex');
      assert.equal(held.sandboxId, sandboxId);
      assert.equal(held.state, 'PAUSED');
      assert.match(held.leaseOwner ?? '', /^provider-revert:/);
      kills++;
      return true;
    });
    try {
      await assert.rejects(
        createWithCodeSession(
          {
            userId,
            agentId,
            repoUrl: null,
            codeProvider: 'codex',
            codeSessionId: seed.id,
          },
          async (session) => {
            assert(session);
            await releaseSandboxAfterFailedStart(
              { sandboxId, pause: async () => true } as unknown as Sandbox,
              session
            );
            const paused = await prisma.codeSession.findUniqueOrThrow({ where: { id: seed.id } });
            assert.equal(paused.state, 'PAUSED');
            assert.equal(paused.leaseOwner, session.leaseOwner);
            assert.match(paused.leaseOwner ?? '', /^provider-switch:/);
            throw new Error('fixture startup failed after confirmed pause');
          }
        ),
        /fixture startup failed after confirmed pause/
      );
      const reverted = await prisma.codeSession.findUniqueOrThrow({ where: { id: seed.id } });
      assert.equal(kills, 1);
      assert.equal(reverted.codeProvider, 'claude');
      assert.equal(reverted.state, 'PAUSED');
      assert.equal(reverted.sandboxId, null);
      assert.equal(reverted.sandboxKind, null);
      assert.equal(reverted.leaseOwner, null);
    } finally {
      await prisma.codeSession.delete({ where: { id: seed.id } });
    }
  });
  test('switched failed startup retains unique custody when native pause is unconfirmed', async () => {
    const seed = await prisma.codeSession.create({
      data: {
        userId,
        rootAgentId: agentId,
        ownerAgentId: agentId,
        repoKey: '',
        codeProvider: 'claude',
        state: 'PAUSED',
      },
    });
    const sandboxId = `switched-failed-start-${randomUUID()}`;
    try {
      await assert.rejects(
        createWithCodeSession(
          {
            userId,
            agentId,
            repoUrl: null,
            codeProvider: 'codex',
            codeSessionId: seed.id,
          },
          async (session) => {
            assert(session);
            await releaseSandboxAfterFailedStart(
              {
                sandboxId,
                pause: async () => {
                  throw new Error('switch pause acknowledgement unavailable');
                },
              } as unknown as Sandbox,
              session
            );
            throw new Error('startup failed');
          }
        ),
        /switch pause acknowledgement unavailable/
      );
      const held = await prisma.codeSession.findUniqueOrThrow({ where: { id: seed.id } });
      assert.equal(held.codeProvider, 'codex');
      assert.equal(held.state, 'ACTIVE');
      assert.equal(held.sandboxId, sandboxId);
      assert.match(held.leaseOwner ?? '', /^provider-switch:/);
    } finally {
      await prisma.codeSession.delete({ where: { id: seed.id } });
    }
  });
  test('failed startup does not report an unconfirmed sandbox pause or release its lease', async () => {
    const sandboxId = `failed-start-${randomUUID()}`;
    let sessionId = '';
    const leaseOwner = `failed-start:${randomUUID()}`;
    const sandbox = {
      sandboxId,
      pause: async () => {
        throw new Error('pause acknowledgement unavailable');
      },
    } as unknown as Sandbox;
    await assert.rejects(
      createWithCodeSession(
        { userId, agentId, repoUrl: null, codeProvider: 'claude', leaseOwner },
        async (session) => {
          assert(session);
          sessionId = session.id;
          await releaseSandboxAfterFailedStart(sandbox, session);
          throw new Error('startup failed');
        }
      ),
      /pause acknowledgement unavailable/
    );
    const held = await prisma.codeSession.findUniqueOrThrow({ where: { id: sessionId } });
    assert.equal(held.state, 'ACTIVE', 'unknown pause must not be reported as paused');
    assert.equal(held.sandboxId, sandboxId, 'retain the exact sandbox for reconciliation');
    assert.equal(held.leaseOwner, leaseOwner, 'unknown pause must not release ownership');
  });

  // A resumed sandbox keeps the session's filesystem, which can be newer than
  // its last checkpoint: a project restore that fails on it must leave it
  // resumable (paused), exactly like the readiness failure after it.
  const failingRestoreSandbox = (pause: () => Promise<unknown>) => {
    const calls = { pauses: 0, kills: 0 };
    const sandbox = {
      sandboxId: `failed-restore-${randomUUID()}`,
      commands: {
        run: async () => {
          throw Object.assign(new Error('mkdir failed'), { exitCode: 1 });
        },
      },
      files: { write: async () => undefined },
      pause: async () => {
        calls.pauses += 1;
        return pause();
      },
      kill: async () => {
        calls.kills += 1;
        throw new Error('kill rejected');
      },
    };
    return { sandbox: sandbox as unknown as Sandbox, calls, id: sandbox.sandboxId };
  };
  const stubWorkspace = {
    project: { id: 'failed-restore-project', name: 'Failed Restore' },
    revision: 1,
    manifest: null,
    redactions: [],
    cloneUrl: null,
  } as unknown as ProjectWorkspace;

  test('a failed project restore pauses, never kills, a persistent session sandbox', async () => {
    const { sandbox, calls, id } = failingRestoreSandbox(async () => true);
    let sessionId = '';
    try {
      await assert.rejects(
        createWithCodeSession(
          { userId, agentId, repoUrl: null, codeProvider: 'claude' },
          async (session) => {
            assert(session);
            sessionId = session.id;
            return restoreSandboxProject(randomUUID(), sandbox, stubWorkspace, false, (held) =>
              releaseSandboxAfterFailedRestore(held, session)
            );
          }
        ),
        /Could not prepare/
      );
      assert.deepEqual(calls, { pauses: 1, kills: 0 }, 'the persistent sandbox was killed');
      const held = await prisma.codeSession.findUniqueOrThrow({ where: { id: sessionId } });
      assert.equal(held.state, 'PAUSED');
      assert.equal(held.sandboxId, id, 'the paused sandbox stays recorded for the retry');
    } finally {
      if (sessionId !== '') await prisma.codeSession.delete({ where: { id: sessionId } });
    }
  });

  test('a failed project restore with an unconfirmed pause retains the persistent lease', async () => {
    const { sandbox, calls, id } = failingRestoreSandbox(async () => {
      throw new Error('restore pause acknowledgement unavailable');
    });
    const leaseOwner = `failed-restore:${randomUUID()}`;
    let sessionId = '';
    try {
      await assert.rejects(
        createWithCodeSession(
          { userId, agentId, repoUrl: null, codeProvider: 'claude', leaseOwner },
          async (session) => {
            assert(session);
            sessionId = session.id;
            return restoreSandboxProject(randomUUID(), sandbox, stubWorkspace, false, (held) =>
              releaseSandboxAfterFailedRestore(held, session)
            );
          }
        ),
        /pause unconfirmed.*restore pause acknowledgement unavailable/
      );
      assert.deepEqual(calls, { pauses: 1, kills: 0 });
      const held = await prisma.codeSession.findUniqueOrThrow({ where: { id: sessionId } });
      assert.equal(held.state, 'ACTIVE', 'an unconfirmed pause must not be reported as paused');
      assert.equal(held.sandboxId, id);
      assert.equal(held.leaseOwner, leaseOwner);
    } finally {
      if (sessionId !== '') await prisma.codeSession.delete({ where: { id: sessionId } });
    }
  });

  test('a failed project restore still kills a one-shot sandbox and keeps the restore error', async () => {
    const { sandbox, calls } = failingRestoreSandbox(async () => true);
    await assert.rejects(
      restoreSandboxProject(randomUUID(), sandbox, stubWorkspace, false, (held) =>
        releaseSandboxAfterFailedRestore(held, null)
      ),
      /Could not prepare/
    );
    assert.deepEqual(calls, { pauses: 0, kills: 1 }, 'a one-shot sandbox must be killed');
  });
}
