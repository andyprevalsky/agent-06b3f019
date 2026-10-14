import { prisma } from '../database';
import type { BrowserSessionStatus } from '@prisma/client';
import { steel, releaseSteelRemoteSession } from './session';

export interface SteelReplacementProfileDependencies {
  inspectSession?: (sessionId: string) => Promise<{
    id: string;
    profileId?: string | null;
    persistProfile?: boolean;
    status: string;
  }>;
  releaseSession?: (sessionId: string) => Promise<void>;
}

/** Claim and finish the exact profile writer; never release a foreign source. */
export async function finishSteelProfileWriter(
  task: { id: string; sessionId: string; providerProfileId: string; status: BrowserSessionStatus },
  dependencies: SteelReplacementProfileDependencies
): Promise<void> {
  const inspect = dependencies.inspectSession ?? ((id: string) => steel.sessions.retrieve(id));
  const native = await inspect(task.sessionId);
  if (
    native.id !== task.sessionId ||
    native.profileId !== task.providerProfileId ||
    !native.persistProfile
  ) {
    throw new Error('Steel profile writer does not match the recorded task session');
  }
  const claim = await prisma.browserSession.updateMany({
    where: {
      id: task.id,
      sessionId: task.sessionId,
      provider: 'steel',
      providerProfileId: task.providerProfileId,
      status: task.status,
    },
    data: { status: 'ERROR', closedAt: null },
  });
  if (claim.count !== 1) throw new Error('Steel profile writer changed before replacement claim');
  try {
    await (dependencies.releaseSession ?? releaseSteelRemoteSession)(task.sessionId);
  } catch (error) {
    // A lost release acknowledgement must not restore a false ACTIVE pointer.
    // Exact native confirmation can discharge custody; otherwise ERROR retains it.
    const observed = await inspect(task.sessionId).catch(() => null);
    if (observed?.id === task.sessionId && observed.status === 'released') {
      await prisma.browserSession.updateMany({
        where: { id: task.id, sessionId: task.sessionId, status: 'ERROR' },
        data: { status: 'CLOSED', closedAt: new Date() },
      });
    }
    throw error;
  }
}
