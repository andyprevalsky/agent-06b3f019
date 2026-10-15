import type { BrowserSession } from '@prisma/client';
import { prisma } from '../database';
import {
  acquireWorkflowDeploymentLease,
  type WorkflowDeploymentLease,
} from '../workflowDeploymentLease';

/** A writable profile is uploaded only after its exact source session closes. */
export async function prepareWritableSteelProfileHandoff(
  session: Pick<
    BrowserSession,
    | 'id'
    | 'sessionId'
    | 'provider'
    | 'status'
    | 'closedAt'
    | 'providerProfileSource'
    | 'providerProfilePersist'
  >,
  binding: { profileId: string; persistProfile: boolean } | undefined,
  release: (sessionId: string) => Promise<void>
): Promise<WorkflowDeploymentLease | null> {
  if (session.provider !== 'steel' || binding === undefined || !binding.persistProfile) return null;

  const lease = await acquireWorkflowDeploymentLease({
    operationKey: `browser:steel-profile-handoff:${session.id}:${session.sessionId}`,
    operationType: 'BROWSER_PROFILE_HANDOFF_LEASE',
  });
  try {
    await lease.assertOwned();
    // PAUSED retains recovery custody after failure or process death. Compare
    // the snapshot even for an intentional resume of an already-CLOSED row.
    const checkpoint = await prisma.browserSession.updateMany({
      where: {
        id: session.id,
        sessionId: session.sessionId,
        provider: 'steel',
        status: session.status,
        closedAt: session.closedAt,
        providerProfileId: binding.profileId,
        providerProfileSource: session.providerProfileSource,
        providerProfilePersist: session.providerProfilePersist,
      },
      data: { status: 'PAUSED', closedAt: null },
    });
    if (checkpoint.count !== 1) {
      throw new Error(
        `Browser session changed before Steel profile handoff for task ${session.id}`
      );
    }
    await lease.assertOwned();
    await release(session.sessionId);
    return lease;
  } catch (error) {
    await lease.release();
    throw error;
  }
}
