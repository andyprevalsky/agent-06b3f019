import { randomUUID } from 'node:crypto';
import { prisma } from '../database';
import { CODE_SESSION_STATES } from './store';

export async function revertCodeSessionProvider(
  codeSessionId: string,
  switchedTo: string,
  switchedFrom: string,
  expectedLeaseOwner: string | null,
  killSandbox: (sandboxId: string) => Promise<void>
): Promise<boolean> {
  const current = await prisma.codeSession.findUnique({ where: { id: codeSessionId } });
  if (
    current === null ||
    current.codeProvider !== switchedTo ||
    current.cliSessionId !== null ||
    current.state === CODE_SESSION_STATES.RETIRED
  )
    return false;
  // Failed-start pause may have released the spawn lease. Never take another
  // retry's lease, even when it uses the same provider and has no CLI id yet.
  if (
    expectedLeaseOwner === null ||
    !expectedLeaseOwner.startsWith('provider-switch:') ||
    current.leaseOwner !== expectedLeaseOwner
  )
    return false;
  // Local fallback custody is not an E2B allocation: retain its provider/home
  // rather than orphaning or deleting a live local workspace through Sandbox.kill.
  if (current.sandboxKind === 'local' && current.sandboxId !== null) return false;
  const rollbackOwner = `provider-revert:${randomUUID()}`;
  const claimed = await prisma.codeSession.updateMany({
    where: {
      id: current.id,
      codeProvider: switchedTo,
      cliSessionId: null,
      state: current.state,
      sandboxId: current.sandboxId,
      sandboxKind: current.sandboxKind,
      leaseOwner: current.leaseOwner,
      leaseExpiresAt: current.leaseExpiresAt,
    },
    data: { leaseOwner: rollbackOwner, leaseExpiresAt: new Date(Date.now() + 60 * 60 * 1000) },
  });
  if (claimed.count !== 1) return false;
  let releaseConfirmed = current.state === CODE_SESSION_STATES.PAUSED;
  try {
    // Keep the provider and binding until exact native cleanup succeeds. A
    // failed kill leaves the paused resource discoverable and correctly typed.
    if (current.sandboxKind === 'e2b' && current.sandboxId !== null) {
      await killSandbox(current.sandboxId);
    }
    releaseConfirmed = true;
    const reverted = await prisma.codeSession.updateMany({
      where: {
        id: current.id,
        codeProvider: switchedTo,
        cliSessionId: null,
        state: current.state,
        sandboxId: current.sandboxId,
        sandboxKind: current.sandboxKind,
        leaseOwner: rollbackOwner,
      },
      data: {
        codeProvider: switchedFrom,
        state: CODE_SESSION_STATES.PAUSED,
        sandboxId: null,
        sandboxKind: null,
        homeDir: null,
      },
    });
    return reverted.count === 1;
  } finally {
    await prisma.codeSession.updateMany({
      where: {
        id: current.id,
        leaseOwner: rollbackOwner,
        ...(releaseConfirmed ? {} : { state: CODE_SESSION_STATES.PAUSED }),
      },
      data: { leaseOwner: null, leaseExpiresAt: null },
    });
  }
}
