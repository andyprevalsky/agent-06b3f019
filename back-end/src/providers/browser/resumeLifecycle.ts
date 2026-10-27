/** Shared logical provider materialization owner; native Steel custody stays in lifecycleClaim. */
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { retryWithBackoff } from '../retry';
import { prisma, runTransactionWithRetry } from '../database';
import { steelSessionTimeoutMs } from '../steel/sessionLifetime';
import { steelEnvironmentIdentity, SHARED_STEEL_IDENTITY } from '../steel/sessionIdentity';
import {
  nativeRequestRejected,
  type withSteelLifecycleClaim,
  type SteelLifecycleMutation,
} from '../steel/lifecycleClaim';

const RESUME_TYPE = 'browser_task_resume';
const RESUME_WAIT_MS = 30_000;
const keyFor = (taskId: string) => `steel-browser-task-lifecycle:${taskId}`;
type Native = { id: string; status: string };
type Request = {
  source: string | null;
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
  taskId: string;
  beforeCreate(
    provider: string,
    nativeId?: string
  ): Promise<{ marker: string; ownershipIdentity: string; recoveredId?: string }>;
  assertOwned(transaction?: Prisma.TransactionClient): Promise<void>;
  beforeHydration(expectedSessionId: string): Promise<void>;
  nativeCreate<T>(create: () => Promise<T>): Promise<T>;
  recovering(): boolean;
  sourceEnded(): boolean;
};
const scope = new AsyncLocalStorage<Scope>();
export const browserResumeScope = () => scope.getStore();
/** Issue a provider create, recording a definite rejection for resume custody. */
export const resumeNativeCreate = <T>(create: () => Promise<T>): Promise<T> =>
  scope.getStore()?.nativeCreate(create) ?? create();

/** Steel replacement borrows the enclosing logical resume owner, never a second task lease. */
export const withBrowserResumeClaim: typeof withSteelLifecycleClaim = async (taskId, callback) => {
  const held = scope.getStore();
  if (!held || held.taskId !== taskId) throw new Error('Browser resume owner does not match task');
  const mutate: SteelLifecycleMutation = async (action, existing) => {
    const owned = async (tx: Prisma.TransactionClient) => {
      await tx.$queryRaw`SELECT id FROM "ToolSideEffect" WHERE "operationKey" = ${keyFor(taskId)} FOR UPDATE`;
      await held.assertOwned(tx);
      const result = await action(tx);
      await held.assertOwned(tx);
      return result;
    };
    return existing ? owned(existing) : runTransactionWithRetry(owned);
  };
  return callback(
    held.assertOwned,
    async (_id, effect, action) => {
      await held.assertOwned();
      return effect === 'create' ? held.nativeCreate(action) : action();
    },
    mutate,
    async () => false
  );
};

type ResumeBinding = {
  sessionId: string | null;
  status: string;
  contextId?: string;
  logicalOwnerKey?: string | null;
  controlState?: string;
  controlLeaseExpiresAt?: Date | null;
};
export interface ResumeLifecycleDependencies<T> {
  readBinding(): Promise<ResumeBinding>;
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
          if (await deps.canFollow()) {
            const assertReady = async () => {
              const latest = await prisma.toolSideEffect.findUnique({ where: { operationKey } });
              const binding = await deps.readBinding();
              const latestRequest = latest?.request as Prisma.JsonObject | null;
              const latestReady = latest?.response as { phase?: string; sessionId?: string } | null;
              if (
                latest?.id !== row.id ||
                latest?.operationType !== RESUME_TYPE ||
                latest.status !== 'RELEASED' ||
                latest.externalId !== row.externalId ||
                latestRequest?.requestId !== (row.request as Prisma.JsonObject | null)?.requestId ||
                latestRequest?.ownershipIdentity !== identity ||
                latestRequest?.compatibility !== deps.compatibility ||
                latestReady?.phase !== 'ready' ||
                latestReady.sessionId !== current.sessionId ||
                binding.status !== 'ACTIVE' ||
                binding.sessionId !== current.sessionId ||
                binding.contextId !== current.contextId ||
                binding.logicalOwnerKey !== current.logicalOwnerKey ||
                (binding.controlState !== undefined &&
                  binding.controlState !== 'AGENT' &&
                  (binding.controlLeaseExpiresAt === null ||
                    binding.controlLeaseExpiresAt === undefined ||
                    binding.controlLeaseExpiresAt.getTime() > Date.now()))
              )
                throw new Error('Browser ready receipt or binding changed during follow');
            };
            await assertReady();
            const result = await deps.follow();
            await assertReady();
            return { kind: 'followed', result };
          }
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

  const assertOwned = async (transaction?: Prisma.TransactionClient) => {
    const row = await (transaction ?? prisma).toolSideEffect.findUnique({
      where: { operationKey },
    });
    if (
      row?.externalId !== owner ||
      row.operationType !== RESUME_TYPE ||
      row.status !== 'STARTED' ||
      Date.now() >= Date.parse(request.expiresAt)
    ) {
      throw new Error('Browser resume lifecycle ownership lost');
    }
  };
  let createEntered = false;
  let createRejected = false;
  return scope.run(
    {
      taskId,
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
      beforeCreate: async (provider, nativeId) => {
        await assertOwned();
        const binding = await deps.readBinding();
        if (binding.sessionId !== request.source && binding.sessionId !== recoveredId)
          throw new Error('Browser resume source binding changed before create');
        // A definitely rejected create allocated nothing, so the provider may
        // retry within this resume (e.g. Kernel re-resolving a deleted proxy).
        if (createEntered && !createRejected)
          throw new Error('Browser resume native attempt requires reconciliation before retry');
        createEntered = true;
        createRejected = false;
        request = {
          ...request,
          provider,
          phase: 'creating',
          ...(nativeId && !recoveredId ? { requestId: nativeId } : {}),
        };
        const changed = await prisma.toolSideEffect.updateMany({
          where: { operationKey, externalId: owner, status: 'STARTED' },
          data: { request: request as unknown as Prisma.InputJsonObject },
        });
        if (changed.count !== 1)
          throw new Error('Browser resume lifecycle ownership lost before create');
        return { marker: request.requestId, ownershipIdentity: identity, recoveredId };
      },
      nativeCreate: async (create) => {
        try {
          return await create();
        } catch (error) {
          createRejected = recoveredId === undefined && nativeRequestRejected(error);
          throw error;
        }
      },
    },
    async () => {
      let result: T;
      try {
        result = await deps.resume();
      } catch (error) {
        // A definitely rejected create allocated nothing, so no outcome remains
        // to reconcile: release custody so the next resume can create at once.
        if (request.phase === 'allocated' || (createRejected && request.phase === 'creating')) {
          await prisma.toolSideEffect.updateMany({
            where: { operationKey, externalId: owner, status: 'STARTED' },
            data: {
              status: 'RELEASED',
              response: { phase: 'rejected', source: request.source },
            },
          });
        }
        throw error;
      }
      await assertOwned();
      const current = await deps.readBinding();
      if (
        (current.status !== 'ACTIVE' && current.status !== 'PAUSED') ||
        current.sessionId !== request.nativeId
      ) {
        throw new Error('Browser resume did not retain its hydrated binding');
      }
      const readyStatus = current.status;
      await runTransactionWithRetry(async (tx) => {
        const changed = await tx.toolSideEffect.updateMany({
          where: { operationKey, externalId: owner, status: 'STARTED' },
          data: {
            status: 'RELEASED',
            response: { phase: 'ready', source: request.source, sessionId: current.sessionId },
          },
        });
        if (changed.count !== 1)
          throw new Error('Browser resume lifecycle ownership lost before ready');
        const ready = await tx.browserSession.updateMany({
          where: {
            id: taskId,
            sessionId: request.nativeId,
            status: readyStatus,
            OR: [{ controlState: 'AGENT' }, { controlLeaseExpiresAt: { lte: new Date() } }],
          },
          data: { status: 'ACTIVE', closedAt: null },
        });
        if (ready.count !== 1) throw new Error('Browser resume lost binding before ready');
      });
      return result;
    }
  );
}
