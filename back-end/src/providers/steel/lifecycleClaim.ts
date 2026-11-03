import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { prisma, runTransactionWithRetry } from '../database';
import { createLogger } from '../logger';
import { steelSessionTimeoutMs } from './sessionLifetime';
import {
  isOwnedSteelSessionId,
  steelEnvironmentIdentity,
  SHARED_STEEL_IDENTITY,
} from './sessionIdentity';

const CLAIM_TYPE = 'steel_browser_task_lifecycle';
const log = createLogger('SteelLifecycleClaim');
export type SteelNativeEffect = <T>(
  sessionId: string,
  effect: 'create' | 'release',
  callback: () => Promise<T>
) => Promise<T>;
export type SteelLifecycleMutation = <T>(
  callback: (transaction: Prisma.TransactionClient) => Promise<T>,
  transaction?: Prisma.TransactionClient
) => Promise<T>;

export type SteelNativeCustodyResolver = (
  sessionId: string,
  inspect: () => Promise<{ id: string; status: string }>,
  release: () => Promise<void>
) => Promise<boolean>;
const nativeTaskScope = new AsyncLocalStorage<{
  taskId: string;
  args: Parameters<Parameters<typeof withSteelLifecycleClaim>[1]>;
}>();

/**
 * A provider's HTTP 4xx answer (other than 408) to a native request proves the
 * request allocated nothing; timeouts, transport errors and 5xx stay uncertain.
 */
export function nativeRequestRejected(error: unknown): boolean {
  const status =
    (error as { status?: number; statusCode?: number })?.status ??
    (error as { statusCode?: number })?.statusCode;
  return status !== undefined && status >= 400 && status < 500 && status !== 408;
}

/** An expired native request remains custody until its exact resource is terminal. */
async function recoverOutstandingNative(operationKey: string): Promise<void> {
  const row = await prisma.toolSideEffect.findUnique({ where: { operationKey } });
  const request = row?.request as Prisma.JsonObject | null;
  const identity = steelEnvironmentIdentity();
  if (
    !row ||
    row.operationType !== CLAIM_TYPE ||
    row.status !== 'STARTED' ||
    !row.externalId ||
    !request ||
    request.nativeOutstanding !== true ||
    typeof request.expiresAt !== 'string' ||
    !Number.isFinite(Date.parse(request.expiresAt)) ||
    Date.parse(request.expiresAt) > Date.now() ||
    request.ownershipIdentity !== identity ||
    identity === SHARED_STEEL_IDENTITY ||
    typeof request.nativeSessionId !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      request.nativeSessionId
    ) ||
    !isOwnedSteelSessionId(request.nativeSessionId) ||
    (request.nativeEffect !== 'create' && request.nativeEffect !== 'release')
  )
    return;
  const recoveryOwner = randomUUID();
  const claimed = await prisma.toolSideEffect.updateMany({
    where: {
      operationKey,
      operationType: CLAIM_TYPE,
      status: 'STARTED',
      externalId: row.externalId,
      updatedAt: row.updatedAt,
    },
    data: { externalId: recoveryOwner },
  });
  if (claimed.count !== 1) return;
  try {
    const { steel, releaseSteelRemoteSession } = await import('./session');
    const native = await steel.sessions.retrieve(request.nativeSessionId);
    if (native.id !== request.nativeSessionId) return;
    if (request.nativeEffect === 'create' && native.status !== 'released') {
      const held = await prisma.browserSession.findFirst({
        where: { sessionId: native.id, status: { in: ['ACTIVE', 'PAUSED'] } },
        select: { id: true },
      });
      if (held) {
        // A committed binding now holds the exact allocated resource; recovery
        // transfers custody to that binding instead of closing its browser.
        await prisma.toolSideEffect.updateMany({
          where: {
            operationKey,
            operationType: CLAIM_TYPE,
            status: 'STARTED',
            externalId: recoveryOwner,
          },
          data: {
            status: 'RELEASED',
            request: { ...request, nativeOutstanding: false },
            response: { recoveredAt: new Date().toISOString(), custodyTransferredTo: held.id },
          },
        });
        return;
      }
      await releaseSteelRemoteSession(native.id);
    }
    const confirmed =
      native.status === 'released'
        ? native
        : await steel.sessions.retrieve(request.nativeSessionId);
    if (confirmed.id !== request.nativeSessionId || confirmed.status !== 'released') return;
    await prisma.toolSideEffect.updateMany({
      where: {
        operationKey,
        operationType: CLAIM_TYPE,
        status: 'STARTED',
        externalId: recoveryOwner,
      },
      data: {
        status: 'RELEASED',
        request: { ...request, nativeOutstanding: false },
        response: { recoveredAt: new Date().toISOString() },
      },
    });
  } catch (error) {
    // In particular, 404 cannot establish that a still-running create never allocates.
    log.error('Outstanding Steel lifecycle custody remains unresolved', {
      operationKey,
      ownerId: recoveryOwner,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/** Serialize native lifecycle effects for one task without holding a DB transaction. */
export async function withSteelLifecycleClaim<T>(
  taskId: string,
  callback: (
    assertOwned: () => Promise<void>,
    runNative: SteelNativeEffect,
    mutateOwned: SteelLifecycleMutation,
    resolveNativeCustody: SteelNativeCustodyResolver
  ) => Promise<T>
): Promise<T> {
  const enclosing = nativeTaskScope.getStore();
  if (enclosing?.taskId === taskId) return callback(...enclosing.args);
  const operationKey = `steel-browser-task-lifecycle:${taskId}`;
  const ownerId = randomUUID();
  const now = new Date();
  const leaseMs = steelSessionTimeoutMs();
  const expiresAt = new Date(now.getTime() + leaseMs);
  const request = {
    taskId,
    expiresAt: expiresAt.toISOString(),
    nativeOutstanding: false,
    ownershipIdentity: steelEnvironmentIdentity(),
  };
  const acquire = () =>
    prisma.$queryRaw<Array<{ externalId: string }>>(Prisma.sql`
    INSERT INTO "ToolSideEffect"
      (id, "operationKey", "operationType", status, "externalId", request, "createdAt", "updatedAt")
    VALUES
      (${randomUUID()}, ${operationKey}, ${CLAIM_TYPE}, 'STARTED', ${ownerId},
       ${JSON.stringify(request)}::jsonb, ${now}, ${now})
    ON CONFLICT ("operationKey") DO UPDATE SET
      "operationType" = EXCLUDED."operationType",
      status = 'STARTED',
      "externalId" = EXCLUDED."externalId",
      request = EXCLUDED.request,
      response = NULL,
      error = NULL,
      "updatedAt" = EXCLUDED."updatedAt"
    WHERE "ToolSideEffect".status <> 'STARTED'
       OR (("ToolSideEffect".request->>'expiresAt')::timestamptz <= ${now}
           AND COALESCE(("ToolSideEffect".request->>'nativeOutstanding')::boolean, false) = false)
    RETURNING "externalId"
  `);
  let rows = await acquire();
  if (rows[0]?.externalId !== ownerId) {
    await recoverOutstandingNative(operationKey);
    rows = await acquire();
  }
  if (rows[0]?.externalId !== ownerId) {
    throw new Error(`Steel browser lifecycle is already in progress for task ${taskId}`);
  }
  const assertOwned = async (): Promise<void> => {
    const checkedAt = new Date();
    if (checkedAt.getTime() >= expiresAt.getTime()) {
      throw new Error(`Steel browser lifecycle claim expired for task ${taskId}`);
    }
    const retained = await prisma.toolSideEffect.updateMany({
      where: { operationKey, operationType: CLAIM_TYPE, status: 'STARTED', externalId: ownerId },
      data: { updatedAt: checkedAt },
    });
    if (retained.count !== 1) {
      throw new Error(`Steel browser lifecycle claim ownership changed for task ${taskId}`);
    }
    // The ownership check itself may outlive the deadline; never authorize a
    // later lifecycle effect merely because its query started before expiry.
    if (Date.now() >= expiresAt.getTime()) {
      throw new Error(`Steel browser lifecycle claim expired for task ${taskId}`);
    }
  };
  const mutateOwned: SteelLifecycleMutation = async (mutation, existingTransaction) => {
    const lockedMutation = async (transaction: Prisma.TransactionClient) => {
      const claims = await transaction.$queryRaw<
        Array<{ externalId: string | null; status: string; request: Prisma.JsonObject }>
      >(Prisma.sql`
        SELECT "externalId", status, request FROM "ToolSideEffect"
        WHERE "operationKey" = ${operationKey} AND "operationType" = ${CLAIM_TYPE}
        FOR UPDATE
      `);
      const held = claims[0];
      if (!held || held.externalId !== ownerId || held.status !== 'STARTED') {
        throw new Error(`Steel browser lifecycle claim ownership changed for task ${taskId}`);
      }
      const persistedDeadline =
        typeof held.request.expiresAt === 'string' ? Date.parse(held.request.expiresAt) : NaN;
      if (
        !Number.isFinite(persistedDeadline) ||
        Date.now() >= persistedDeadline ||
        Date.now() >= expiresAt.getTime()
      ) {
        throw new Error(`Steel browser lifecycle claim expired for task ${taskId}`);
      }
      const result = await mutation(transaction);
      // Roll back a DB mutation that crossed the unchanged absolute deadline.
      if (Date.now() >= persistedDeadline || Date.now() >= expiresAt.getTime()) {
        throw new Error(`Steel browser lifecycle claim expired for task ${taskId}`);
      }
      return result;
    };
    return existingTransaction
      ? lockedMutation(existingTransaction)
      : runTransactionWithRetry(lockedMutation);
  };
  let nativeOutstanding = false;
  let outstandingSessionId: string | undefined;
  const runNative: SteelNativeEffect = async (sessionId, effect, nativeCallback) => {
    await assertOwned();
    if (nativeOutstanding)
      throw new Error(`Steel browser lifecycle native effect already pending for task ${taskId}`);
    const marked = await prisma.toolSideEffect.updateMany({
      where: { operationKey, operationType: CLAIM_TYPE, status: 'STARTED', externalId: ownerId },
      data: {
        request: {
          ...request,
          nativeOutstanding: true,
          nativeSessionId: sessionId,
          nativeEffect: effect,
        },
      },
    });
    if (marked.count !== 1)
      throw new Error(`Steel browser lifecycle claim ownership changed for task ${taskId}`);
    nativeOutstanding = true;
    outstandingSessionId = sessionId;
    let settled = false;
    let invoked = false;
    try {
      await assertOwned();
      invoked = true;
      const result = await nativeCallback();
      settled = true;
      return result;
    } catch (error) {
      // A timed-out or ambiguous create may still allocate after this promise
      // rejects. Durable custody must survive for exact native reconciliation.
      settled =
        !invoked ||
        (error as { steelNativeRequestNotIssued?: boolean })?.steelNativeRequestNotIssued ===
          true ||
        effect !== 'create' ||
        nativeRequestRejected(error);
      if (!invoked && error instanceof Error) {
        Object.assign(error, { steelNativeRequestNotIssued: true });
      }
      throw error;
    } finally {
      if (settled)
        try {
          const cleared = await prisma.toolSideEffect.updateMany({
            where: {
              operationKey,
              operationType: CLAIM_TYPE,
              status: 'STARTED',
              externalId: ownerId,
            },
            data: {
              request: {
                ...request,
                nativeOutstanding: false,
                nativeSessionId: sessionId,
                nativeEffect: effect,
              },
            },
          });
          if (cleared.count === 1) nativeOutstanding = false;
        } catch (error) {
          log.error('Failed to clear Steel native lifecycle custody', {
            operationKey,
            ownerId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
    }
  };
  const resolveNativeCustody: SteelNativeCustodyResolver = async (sessionId, inspect, release) => {
    await assertOwned();
    if (!nativeOutstanding || outstandingSessionId !== sessionId) return false;
    let observed = await inspect().catch(() => null);
    if (observed?.id !== sessionId || !['live', 'released'].includes(observed.status)) return false;
    if (observed.status !== 'released') {
      // The unresolved create retains durable custody throughout exact cleanup.
      // In particular, no other UUID may be allocated before terminal proof.
      await assertOwned();
      await release();
      observed = await inspect().catch(() => null);
    }
    if (observed?.id !== sessionId || observed.status !== 'released') return false;
    await mutateOwned(async (transaction) => {
      await transaction.toolSideEffect.updateMany({
        where: { operationKey, operationType: CLAIM_TYPE, status: 'STARTED', externalId: ownerId },
        data: {
          request: {
            ...request,
            nativeOutstanding: false,
            nativeSessionId: sessionId,
            nativeEffect: 'create',
          },
        },
      });
    });
    nativeOutstanding = false;
    return true;
  };
  try {
    await assertOwned();
    const args: Parameters<typeof callback> = [
      assertOwned,
      runNative,
      mutateOwned,
      resolveNativeCustody,
    ];
    return await nativeTaskScope.run({ taskId, args }, () => callback(...args));
  } finally {
    if (!nativeOutstanding) {
      await prisma.toolSideEffect
        .updateMany({
          where: {
            operationKey,
            operationType: CLAIM_TYPE,
            status: 'STARTED',
            externalId: ownerId,
          },
          data: { status: 'RELEASED', response: { releasedAt: new Date().toISOString() } },
        })
        .catch((error: unknown) => {
          log.error('Failed to release Steel lifecycle claim; durable custody retained', {
            operationKey,
            ownerId,
            error: error instanceof Error ? error.message : String(error),
          });
        });
    }
  }
}

export {
  browserResumeScope,
  resumeNativeCreate,
  withBrowserResumeClaim,
  withBrowserResumeLifecycle,
  type ResumeLifecycleDependencies,
} from '../browser/resumeLifecycle';
