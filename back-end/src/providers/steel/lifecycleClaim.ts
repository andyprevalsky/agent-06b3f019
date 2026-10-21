import { retryWithBackoff } from '../retry';
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
      const status =
        (error as { status?: number; statusCode?: number })?.status ??
        (error as { statusCode?: number })?.statusCode;
      // A timed-out or ambiguous create may still allocate after this promise
      // rejects. Durable custody must survive for exact native reconciliation.
      settled =
        !invoked ||
        (error as { steelNativeRequestNotIssued?: boolean })?.steelNativeRequestNotIssued ===
          true ||
        effect !== 'create' ||
        (status !== undefined && status >= 400 && status < 500 && status !== 408);
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
    return await callback(assertOwned, runNative, mutateOwned, resolveNativeCustody);
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

const RESUME_TYPE = 'browser_task_resume';
const RESUME_WAIT_MS = 30_000;
const keyFor = (taskId: string) => `steel-browser-task-lifecycle:${taskId}`;
type Native = { id: string; status: string };
type Request = {
  source: string;
  provider: string;
  requestId: string;
  ownershipIdentity: string;
  expiresAt: string;
  phase: 'allocated' | 'creating' | 'hydrating';
  nativeId?: string;
  nativeOutstanding: true;
  compatibility: string;
};
type Scope = {
  beforeCreate(
    provider: string
  ): Promise<{ marker: string; ownershipIdentity: string; recoveredId?: string }>;
  assertOwned(): Promise<void>;
  beforeHydration(expectedSessionId: string): Promise<void>;
  recovering(): boolean;
  sourceEnded(): boolean;
};
const scope = new AsyncLocalStorage<Scope>();
export const browserResumeScope = () => scope.getStore();

export interface ResumeLifecycleDependencies<T> {
  readBinding(): Promise<{ sessionId: string; status: string }>;
  resume(): Promise<T>;
  follow(): Promise<T>;
  compatibility: string;
  canFollow(): Promise<boolean>;
  reuseCompleted: boolean;
  sourceEnded(): boolean;
  inspect(provider: string, marker: string, identity: string): Promise<Native | null>;
}

/**
 * The ledger holds no credentials. An expired uncertain create is adopted only
 * by exact provider marker; zero matches stay unknown and never authorize POST.
 */
export async function withBrowserResumeLifecycle<T>(
  taskId: string,
  deps: ResumeLifecycleDependencies<T>
): Promise<T> {
  const operationKey = keyFor(taskId);
  const identity = steelEnvironmentIdentity();
  if (identity === SHARED_STEEL_IDENTITY)
    throw new Error('Browser resume requires an isolated ownership identity');
  const initial = await deps.readBinding();
  const owner = randomUUID();
  const until = Date.now() + RESUME_WAIT_MS;
  let recoveredId: string | undefined;
  let joinedInFlight = false;
  let request!: Request;
  const acquired = await retryWithBackoff<
    { kind: 'followed'; result: T } | { kind: 'claimed' } | null
  >(
    async () => {
      const row = await prisma.toolSideEffect.findUnique({ where: { operationKey } });
      const current = await deps.readBinding();
      if (row?.operationType === RESUME_TYPE && row.status === 'RELEASED') {
        const ready = row.response as { phase?: string; sessionId?: string } | null;
        if ((row.request as Prisma.JsonObject | null)?.ownershipIdentity !== identity) {
          throw new Error('Browser resume ownership identity changed');
        }
        if (
          (deps.reuseCompleted || joinedInFlight) &&
          (row.request as Prisma.JsonObject | null)?.compatibility === deps.compatibility &&
          ready?.phase === 'ready' &&
          ready.sessionId === current.sessionId &&
          current.status === 'ACTIVE'
        ) {
          if (await deps.canFollow()) return { kind: 'followed', result: await deps.follow() };
        }
      }
      if (row?.status === 'STARTED') {
        const held = row.request as unknown as Request;
        if (row.operationType === RESUME_TYPE && held.compatibility === deps.compatibility)
          joinedInFlight = true;
        if (row.operationType === RESUME_TYPE && held.compatibility !== deps.compatibility) {
          throw new Error('Browser resume request is incompatible with the in-flight operation');
        }
        if (row.operationType !== RESUME_TYPE || Date.parse(held.expiresAt) > Date.now()) {
          if (Date.now() >= until) throw new Error('Browser resume is still in progress');
          return null;
        }
        if (held.ownershipIdentity !== identity)
          throw new Error('Browser resume ownership identity changed');
        if (held.phase === 'hydrating')
          throw new Error('Browser resume hydration outcome remains unknown');
        const native = await deps.inspect(held.provider, held.requestId, identity);
        if (!native || native.status !== 'active')
          throw new Error('Browser resume create outcome remains unknown');
        if (held.nativeId && held.nativeId !== native.id)
          throw new Error('Browser resume native identity changed');
        if (current.sessionId !== held.source && current.sessionId !== native.id)
          throw new Error('Browser resume source binding changed');
        request = {
          ...held,
          nativeId: native.id,
          expiresAt: new Date(Date.now() + steelSessionTimeoutMs()).toISOString(),
        };
        const claimed = await prisma.toolSideEffect.updateMany({
          where: {
            operationKey,
            operationType: RESUME_TYPE,
            status: 'STARTED',
            externalId: row.externalId,
            updatedAt: row.updatedAt,
          },
          data: { externalId: owner, request: request as unknown as Prisma.InputJsonObject },
        });
        if (claimed.count !== 1) return null;
        recoveredId = native.id;
        return { kind: 'claimed' };
      }
      if (current.sessionId !== initial.sessionId)
        throw new Error('Browser resume source binding changed without a ready receipt');
      request = {
        source: current.sessionId,
        provider: '',
        requestId: randomUUID(),
        ownershipIdentity: identity,
        expiresAt: new Date(Date.now() + steelSessionTimeoutMs()).toISOString(),
        phase: 'allocated',
        nativeOutstanding: true,
        compatibility: deps.compatibility,
      };
      const rows = await prisma.$queryRaw<Array<{ externalId: string }>>(Prisma.sql`
      INSERT INTO "ToolSideEffect" (id, "operationKey", "operationType", status, "externalId", request, "createdAt", "updatedAt")
      VALUES (${randomUUID()}, ${operationKey}, ${RESUME_TYPE}, 'STARTED', ${owner}, ${JSON.stringify(request)}::jsonb, NOW(), NOW())
      ON CONFLICT ("operationKey") DO UPDATE SET "operationType" = ${RESUME_TYPE}, status = 'STARTED',
        "externalId" = ${owner}, request = ${JSON.stringify(request)}::jsonb, response = NULL, "updatedAt" = NOW()
      WHERE "ToolSideEffect".status <> 'STARTED'
      RETURNING "externalId"
    `);
      return rows[0]?.externalId === owner ? { kind: 'claimed' } : null;
    },
    {
      maxRetries: 601,
      initialBackoffMs: 50,
      fixedDelays: Array.from({ length: 600 }, () => 50),
      shouldRetryResult: (value) => value === null,
      isRetryable: () => false,
      component: 'BrowserResumeCustody',
    }
  );
  if (acquired === null) throw new Error('Browser resume is still in progress');
  if (acquired.kind === 'followed') return acquired.result;

  const assertOwned = async () => {
    const row = await prisma.toolSideEffect.findUnique({ where: { operationKey } });
    if (
      row?.externalId !== owner ||
      row.status !== 'STARTED' ||
      Date.now() >= Date.parse(request.expiresAt)
    ) {
      throw new Error('Browser resume lifecycle ownership lost');
    }
  };
  let createEntered = false;
  return scope.run(
    {
      assertOwned,
      recovering: () => recoveredId !== undefined,
      sourceEnded: deps.sourceEnded,
      beforeHydration: async (expectedSessionId) => {
        await assertOwned();
        const current = await deps.readBinding();
        if (current.sessionId !== expectedSessionId) {
          throw new Error('Browser resume binding changed before hydration');
        }
        request = { ...request, phase: 'hydrating', nativeId: expectedSessionId };
        const changed = await prisma.toolSideEffect.updateMany({
          where: { operationKey, externalId: owner, status: 'STARTED' },
          data: { request: request as unknown as Prisma.InputJsonObject },
        });
        if (changed.count !== 1)
          throw new Error('Browser resume lifecycle ownership lost before hydration');
      },
      beforeCreate: async (provider) => {
        await assertOwned();
        if (createEntered)
          throw new Error('Browser resume native attempt requires reconciliation before retry');
        createEntered = true;
        request = { ...request, provider, phase: 'creating' };
        const changed = await prisma.toolSideEffect.updateMany({
          where: { operationKey, externalId: owner, status: 'STARTED' },
          data: { request: request as unknown as Prisma.InputJsonObject },
        });
        if (changed.count !== 1)
          throw new Error('Browser resume lifecycle ownership lost before create');
        return { marker: request.requestId, ownershipIdentity: identity, recoveredId };
      },
    },
    async () => {
      const result = await deps.resume();
      await assertOwned();
      const current = await deps.readBinding();
      if (current.status !== 'ACTIVE' || current.sessionId !== request.nativeId) {
        throw new Error('Browser resume did not retain its hydrated binding');
      }
      const changed = await prisma.toolSideEffect.updateMany({
        where: { operationKey, externalId: owner, status: 'STARTED' },
        data: {
          status: 'RELEASED',
          response: { phase: 'ready', source: request.source, sessionId: current.sessionId },
        },
      });
      if (changed.count !== 1)
        throw new Error('Browser resume lifecycle ownership lost before ready');
      return result;
    }
  );
}
