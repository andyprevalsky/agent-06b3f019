import { prisma } from '../database';
import { createLogger } from '../logger';
import { steel, releaseSteelRemoteSession } from './session';
import { withSteelLifecycleClaim, type SteelNativeEffect } from './lifecycleClaim';
import {
  SHARED_STEEL_IDENTITY,
  inFlightSteelSessionIds,
  isOwnedSteelSessionId,
  steelEnvironmentIdentity,
  steelOwnershipMarker,
} from './sessionIdentity';

const TYPE = 'steel_candidate_cleanup';
const log = createLogger('SteelCandidateCleanup');
const key = (id: string): string => `steel-candidate-cleanup:${id}`;

export async function prepareSteelCandidateCleanup(
  taskId: string,
  sessionId: string,
  profileId?: string
): Promise<void> {
  await prisma.toolSideEffect.create({
    data: {
      operationKey: key(sessionId),
      operationType: TYPE,
      status: 'PENDING',
      externalId: sessionId,
      request: {
        taskId,
        sessionId,
        ...(profileId ? { profileId } : {}),
        ownershipIdentity: steelEnvironmentIdentity(),
      },
    },
  });
}

export async function settleSteelCandidateCleanup(
  sessionId: string,
  status: 'RELEASED' | 'COMMITTED'
): Promise<void> {
  await prisma.toolSideEffect.updateMany({
    where: {
      operationKey: key(sessionId),
      operationType: TYPE,
      externalId: sessionId,
      status: 'PENDING',
      request: { path: ['ownershipIdentity'], equals: steelEnvironmentIdentity() },
    },
    data: { status },
  });
}

export interface SteelCandidateCleanupIntent {
  taskId: string;
  sessionId: string;
  profileId?: string;
  ownershipIdentity: string;
}

export interface SteelCandidateCleanupDependencies {
  identity: () => string;
  isOwned: (sessionId: string, identity: string) => boolean;
  listPending: (identity: string) => Promise<SteelCandidateCleanupIntent[]>;
  held: (sessionId: string) => Promise<boolean>;
  inFlight: (candidates: string[]) => Promise<ReadonlySet<string>> | ReadonlySet<string>;
  release: (sessionId: string) => Promise<void>;
  inspect: (sessionId: string) => Promise<{ id: string; status: string }>;
  claim: typeof withSteelLifecycleClaim;
  settle: typeof settleSteelCandidateCleanup;
}

const defaults: SteelCandidateCleanupDependencies = {
  identity: steelEnvironmentIdentity,
  isOwned: (id, identity) =>
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id) &&
    isOwnedSteelSessionId(id, steelOwnershipMarker(identity)),
  listPending: async (identity) => {
    const rows = await prisma.toolSideEffect.findMany({
      where: {
        operationType: TYPE,
        status: 'PENDING',
        request: { path: ['ownershipIdentity'], equals: identity },
      },
      select: { externalId: true, operationKey: true, request: true },
    });
    return rows.flatMap((row) => {
      const request = row.request as unknown as SteelCandidateCleanupIntent | null;
      return request &&
        typeof request.taskId === 'string' &&
        typeof request.sessionId === 'string' &&
        request.sessionId === row.externalId &&
        row.operationKey === key(request.sessionId) &&
        request.ownershipIdentity === identity &&
        (request.profileId === undefined || typeof request.profileId === 'string')
        ? [request]
        : [];
    });
  },
  held: async (sessionId) =>
    (await prisma.browserSession.findFirst({
      where: { sessionId, status: { in: ['ACTIVE', 'PAUSED'] } },
      select: { id: true },
    })) !== null,
  inFlight: inFlightSteelSessionIds,
  release: releaseSteelRemoteSession,
  inspect: (id) => steel.sessions.retrieve(id),
  claim: withSteelLifecycleClaim,
  settle: settleSteelCandidateCleanup,
};

/** Recover only durable candidate custody belonging to this exact environment. */
export async function reconcileSteelCandidateCleanup(
  overrides: Partial<SteelCandidateCleanupDependencies> = {}
): Promise<{ released: number; failed: number }> {
  const deps = { ...defaults, ...overrides };
  const identity = deps.identity();
  const summary = { released: 0, failed: 0 };
  if (identity === SHARED_STEEL_IDENTITY) return summary;
  for (const intent of await deps.listPending(identity)) {
    if (intent.ownershipIdentity !== identity || !deps.isOwned(intent.sessionId, identity))
      continue;
    if (
      (await deps.inFlight([intent.sessionId])).has(intent.sessionId) ||
      (await deps.held(intent.sessionId))
    )
      continue;
    try {
      await deps.claim(intent.taskId, async (assertTaskOwned, runTaskNative) => {
        const cleanup = async (
          assertProfileOwned?: () => Promise<void>,
          runProfileNative?: SteelNativeEffect
        ): Promise<void> => {
          await assertTaskOwned();
          await assertProfileOwned?.();
          if (
            (await deps.inFlight([intent.sessionId])).has(intent.sessionId) ||
            (await deps.held(intent.sessionId))
          )
            return;
          await assertTaskOwned();
          await assertProfileOwned?.();
          const release = () => deps.release(intent.sessionId);
          await runTaskNative(intent.sessionId, 'release', () =>
            runProfileNative ? runProfileNative(intent.sessionId, 'release', release) : release()
          );
          await assertTaskOwned();
          await assertProfileOwned?.();
          const terminal = await deps.inspect(intent.sessionId);
          if (terminal.id !== intent.sessionId || terminal.status !== 'released') {
            throw new Error('Owned Steel candidate release remains unconfirmed');
          }
          await deps.settle(intent.sessionId, 'RELEASED');
          summary.released++;
        };
        if (intent.profileId) await deps.claim(`profile:${intent.profileId}`, cleanup);
        else await cleanup();
      });
    } catch (error) {
      summary.failed++;
      log.error('Failed to reconcile owned Steel candidate', {
        sessionId: intent.sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return summary;
}
