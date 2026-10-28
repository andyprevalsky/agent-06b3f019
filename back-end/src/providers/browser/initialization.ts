import { randomUUID } from 'node:crypto';
import { prisma, runTransactionWithRetry } from '../database';
import { retryWithBackoff } from '../retry';
import { nativeRequestRejected } from '../steel/lifecycleClaim';
import { BrowserProviderRateLimitError } from './types';
import { announceBrowserSessionBinding } from './sessionBindingAnnounce';

const OPERATION_TYPE = 'browser_session_initialization';
const keyFor = (taskId: string) => `browser-initialization:${taskId}`;

/**
 * Provider persistence remains PAUSED until preparation and this receipt commit.
 * A missing receipt is a browser created before this readiness protocol.
 */
export async function waitForBrowserInitialization(taskId: string, userId: string): Promise<void> {
  const deadline = Date.now() + 30_000;
  const ready = await retryWithBackoff(
    async () => {
      const receipt = await prisma.toolSideEffect.findUnique({
        where: { operationKey: keyFor(taskId) },
      });
      if (receipt === null) return true;
      const request = receipt.request as { taskId?: string; userId?: string } | null;
      if (
        receipt.operationType !== OPERATION_TYPE ||
        request?.taskId !== taskId ||
        request.userId !== userId
      )
        throw new Error('Browser initialization owner changed');
      if (receipt.status === 'SUCCEEDED') return true;
      if (receipt.status !== 'STARTED')
        throw new Error('Browser initialization failed before readiness');
      if (Date.now() >= deadline) throw new Error('Browser initialization is still in progress');
      return false;
    },
    {
      maxRetries: 35,
      fixedDelays: [50, 100, 200, 400, ...Array<number>(30).fill(1000)],
      shouldRetryResult: (value) => !value,
      isRetryable: () => false,
      component: 'BrowserInitialization',
    }
  );
  if (!ready) throw new Error('Browser initialization is still in progress');
}

/** Resume must not replace an initializer's partial or uncertain binding. */
export async function assertBrowserInitializationReady(taskId: string): Promise<void> {
  const receipt = await prisma.toolSideEffect.findUnique({
    where: { operationKey: keyFor(taskId) },
  });
  if (receipt !== null && receipt.status !== 'SUCCEEDED')
    throw new Error('Browser initialization failed before readiness');
}

/** One first materializer; followers join its durable completion, never its partial binding. */
export async function initializeLogicalBrowser<T extends { session_id: string }>(
  taskId: string,
  userId: string,
  initialize: () => Promise<T>
): Promise<T | null> {
  const owner = randomUUID();
  const operationKey = keyFor(taskId);
  const claimed = await prisma.toolSideEffect.createMany({
    data: [
      {
        operationKey,
        operationType: OPERATION_TYPE,
        externalId: owner,
        request: { taskId, userId },
      },
    ],
    skipDuplicates: true,
  });
  if (claimed.count === 0) {
    await waitForBrowserInitialization(taskId, userId);
    return null;
  }
  try {
    const result = await initialize();
    await runTransactionWithRetry(async (tx) => {
      const activated = await tx.browserSession.updateMany({
        where: {
          id: taskId,
          sessionId: result.session_id,
          logicalOwnerKey: { not: null },
          context: { userId },
          status: 'PAUSED',
          controlState: 'AGENT',
        },
        data: { status: 'ACTIVE' },
      });
      if (activated.count !== 1) throw new Error('Browser initialization binding changed');
      const completed = await tx.toolSideEffect.updateMany({
        where: { operationKey, externalId: owner, status: 'STARTED' },
        data: { status: 'SUCCEEDED', response: { sessionId: result.session_id } },
      });
      if (completed.count !== 1) throw new Error('Browser initialization ownership lost');
    });
    await announceBrowserSessionBinding({ id: taskId });
    return result;
  } catch (error) {
    if (error instanceof BrowserProviderRateLimitError || nativeRequestRejected(error)) {
      // A typed rejection plus no binding proves this exact attempt allocated
      // nothing. Release only its receipt, under the logical row lock; never
      // infer safety from a missing binding alone or steal an uncertain attempt.
      const released = await runTransactionWithRetry(async (tx) => {
        await tx.$queryRaw`SELECT id FROM "BrowserSession" WHERE id = ${taskId} FOR UPDATE`;
        const binding = await tx.browserSession.findUnique({ where: { id: taskId } });
        if (binding?.sessionId !== null || binding.logicalOwnerKey === null) return false;
        const deleted = await tx.toolSideEffect.deleteMany({
          where: { operationKey, externalId: owner, status: 'STARTED' },
        });
        return deleted.count === 1;
      });
      if (released) throw error;
    }
    // Failed/unknown preparation remains unavailable. Do not steal a crashed init.
    await prisma.toolSideEffect.updateMany({
      where: { operationKey, externalId: owner, status: 'STARTED' },
      data: { status: 'FAILED' },
    });
    throw error;
  }
}
