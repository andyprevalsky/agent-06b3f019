import { prisma } from '../database';
import { announceBrowserSessionBinding } from '../browser/sessionBindingAnnounce';
import type { BrowserSessionStatus } from '@prisma/client';
import type { SteelNativeEffect, SteelLifecycleMutation } from './lifecycleClaim';
import { steel, releaseSteelRemoteSession } from './session';

export interface SteelReplacementProfileDependencies {
  verifyLifecycleOwnership?: () => Promise<void>;
  runOwnedNative?: SteelNativeEffect;
  mutateLifecycle?: SteelLifecycleMutation;
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
  task: {
    id: string;
    sessionId: string;
    providerProfileId: string;
    status: BrowserSessionStatus;
    closedAt: Date | null;
    providerProfileSource: string | null;
    providerProfilePersist: boolean;
  },
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
  await dependencies.verifyLifecycleOwnership?.();
  const mutate: SteelLifecycleMutation =
    dependencies.mutateLifecycle ?? (async (callback) => callback(prisma));
  const claim = await mutate((transaction) =>
    transaction.browserSession.updateMany({
      where: {
        id: task.id,
        sessionId: task.sessionId,
        provider: 'steel',
        providerProfileId: task.providerProfileId,
        status: task.status,
        closedAt: task.closedAt,
        providerProfileSource: task.providerProfileSource,
        providerProfilePersist: task.providerProfilePersist,
      },
      data: { status: 'PAUSED', closedAt: null },
    })
  );
  if (claim.count !== 1) throw new Error('Steel profile writer changed before replacement claim');
  // An intentional CLOSED/PAUSED resume may already hold a released writer.
  // Preserve recovery custody without issuing a duplicate native release.
  if (native.status === 'released') return;
  try {
    await dependencies.verifyLifecycleOwnership?.();
    const release = () =>
      (dependencies.releaseSession ?? releaseSteelRemoteSession)(task.sessionId);
    await (dependencies.runOwnedNative
      ? dependencies.runOwnedNative(task.sessionId, 'release', release)
      : release());
  } catch (error) {
    // A lost release acknowledgement must not restore a false ACTIVE pointer.
    // Exact released evidence keeps PAUSED recovery; otherwise ERROR retains custody.
    const observed = await inspect(task.sessionId).catch(() => null);
    const ownsClaim = await (dependencies.verifyLifecycleOwnership?.() ?? Promise.resolve()).then(
      () => true,
      () => false
    );
    if (ownsClaim) {
      const released = observed?.id === task.sessionId && observed.status === 'released';
      const changed = await mutate((transaction) =>
        transaction.browserSession.updateMany({
          where: {
            id: task.id,
            sessionId: task.sessionId,
            provider: 'steel',
            status: 'PAUSED',
            closedAt: null,
            providerProfileId: task.providerProfileId,
            providerProfileSource: task.providerProfileSource,
            providerProfilePersist: task.providerProfilePersist,
          },
          data: { status: released ? 'PAUSED' : 'ERROR', closedAt: null },
        })
      );
      if (changed.count === 1) await announceBrowserSessionBinding({ id: task.id });
    }
    throw error;
  }
}
