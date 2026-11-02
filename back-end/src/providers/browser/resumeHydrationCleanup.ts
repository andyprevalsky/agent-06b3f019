/** Confirm and settle only an exact-owned failed native hydration candidate. */
import { Prisma } from '@prisma/client';
import { runTransactionWithRetry } from '../database';
import { createLogger } from '../logger';
import { isConfirmedBrowserEnd } from './sessionPersist';
import { releaseSupersededBrowser } from './sessionCleanup';
import { storedBrowserProvider, type BrowserSessionHealth } from './types';
import type { HydrationTarget, ResumeLifecycleDependencies } from './resumeLifecycle';

export type Request = {
  source: string | null;
  provider: string;
  requestId: string;
  ownershipIdentity: string;
  expiresAt: string;
  phase: 'allocated' | 'creating' | 'hydrating';
  nativeId?: string;
  nativeOutstanding: boolean;
  compatibility: string;
  hydrationTargets?: HydrationTarget[];
};

export type ResumeBinding = {
  sessionId: string | null;
  status: string;
  contextId?: string;
  logicalOwnerKey?: string | null;
  controlState?: string;
  controlLeaseExpiresAt?: Date | null;
  checkpointRef?: string | null;
  checkpointRevision?: number;
  provider?: string;
  baselineCheckpointRef?: string | null;
  currentUrl?: string | null;
  startUrl?: string | null;
  wsUrl?: string | null;
  debugUrl?: string | null;
};

const log = createLogger('BrowserResumeCustody');

export function failedHydrationCleanup(
  taskId: string,
  health: (id: string) => Promise<Pick<BrowserSessionHealth, 'sessionId' | 'status'>>
): Pick<ResumeLifecycleDependencies<unknown>, 'release' | 'ended'> {
  return {
    release: (provider, nativeId) =>
      releaseSupersededBrowser({
        taskId,
        previousProvider: storedBrowserProvider(provider),
        previousSessionId: nativeId,
        operation: 'resume',
      }),
    ended: async (nativeId) => {
      const observed = await health(nativeId);
      return observed.sessionId === nativeId && isConfirmedBrowserEnd(observed.status);
    },
  };
}

export async function abandonFailedHydration(context: {
  taskId: string;
  operationKey: string;
  owner: string;
  request: Request;
  initial: ResumeBinding;
  candidate: string;
  cause: unknown;
  assertOwned(tx?: Prisma.TransactionClient): Promise<void>;
  deps: ResumeLifecycleDependencies<unknown>;
  settleRequest(request: Request): void;
}): Promise<void> {
  const {
    taskId,
    operationKey,
    owner,
    request,
    initial,
    candidate,
    cause,
    assertOwned,
    deps,
    settleRequest,
  } = context;
  const detail = {
    taskId,
    provider: request.provider,
    candidate,
    cause: cause instanceof Error ? cause.message : String(cause),
  };
  try {
    await assertOwned();
    const binding = await deps.readBinding();
    if (
      binding.sessionId !== candidate ||
      binding.contextId !== initial.contextId ||
      binding.logicalOwnerKey !== initial.logicalOwnerKey ||
      !['ACTIVE', 'PAUSED'].includes(binding.status) ||
      (binding.controlState !== undefined &&
        binding.controlState !== 'AGENT' &&
        (binding.controlLeaseExpiresAt === null ||
          binding.controlLeaseExpiresAt === undefined ||
          binding.controlLeaseExpiresAt.getTime() > Date.now()))
    )
      throw new Error('Failed hydration candidate ownership changed');
    const retainCandidate = request.provider === '' || candidate === request.source;
    if (!retainCandidate) {
      if (!(await deps.release(request.provider, candidate))) {
        log.error(
          'Browser resume kept custody: failed hydration candidate release unconfirmed',
          detail
        );
        return;
      }
      if (!(await deps.ended(candidate))) {
        log.error(
          'Browser resume kept custody: failed hydration candidate still reported live',
          detail
        );
        return;
      }
    }
    const settled = { ...request, nativeId: candidate, nativeOutstanding: false };
    await runTransactionWithRetry(async (tx) => {
      await assertOwned(tx);
      const paused = await tx.browserSession.updateMany({
        where: {
          id: taskId,
          sessionId: candidate,
          contextId: initial.contextId,
          logicalOwnerKey: initial.logicalOwnerKey,
          status: { in: ['ACTIVE', 'PAUSED'] },
          OR: [{ controlState: 'AGENT' }, { controlLeaseExpiresAt: { lte: new Date() } }],
        },
        data: { status: 'PAUSED', closedAt: null },
      });
      if (paused.count !== 1) throw new Error('Failed hydration candidate binding changed');
      const changed = await tx.toolSideEffect.updateMany({
        where: { operationKey, externalId: owner, status: 'STARTED' },
        data: {
          status: 'RELEASED',
          request: settled as unknown as Prisma.InputJsonObject,
          response: {
            phase: 'rejected',
            source: request.source,
            ...(retainCandidate ? { retained: candidate } : { abandoned: candidate }),
          },
        },
      });
      if (changed.count !== 1) throw new Error('Failed hydration candidate custody changed');
    });
    settleRequest(settled);
    log.warn('Browser resume settled its failed hydration candidate', {
      ...detail,
      retained: retainCandidate,
    });
  } catch (cleanupError) {
    log.error('Browser resume kept custody: failed hydration cleanup did not complete', {
      ...detail,
      cleanupError: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
    });
  }
}
