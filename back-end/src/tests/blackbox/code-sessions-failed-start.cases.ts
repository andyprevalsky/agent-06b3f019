import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import type { Sandbox } from 'e2b';
import { prisma } from '../../providers/database';
import { releaseSandboxAfterFailedStart } from '../../providers/e2bCodeSessionSandbox';
import { createWithCodeSession } from '../../providers/codeSessions/spawn';

export function registerFailedStartPauseCases(userId: string, agentId: string) {
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
