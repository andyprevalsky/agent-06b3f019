import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { Sandbox } from 'e2b';
import { prisma } from '../../providers/database';
import { releaseSandboxAfterFailedStart } from '../../providers/e2bCodeSessionSandbox';
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
}
