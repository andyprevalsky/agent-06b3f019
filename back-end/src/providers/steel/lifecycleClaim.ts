import { randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { prisma } from '../database';
import { steelSessionTimeoutMs } from './sessionLifetime';

const CLAIM_TYPE = 'steel_browser_task_lifecycle';

/** Serialize native lifecycle effects for one task without holding a DB transaction. */
export async function withSteelLifecycleClaim<T>(
  taskId: string,
  callback: () => Promise<T>
): Promise<T> {
  const operationKey = `steel-browser-task-lifecycle:${taskId}`;
  const ownerId = randomUUID();
  const now = new Date();
  const leaseMs = steelSessionTimeoutMs();
  const liveCutoff = new Date(now.getTime() - leaseMs);
  const expiresAt = new Date(now.getTime() + leaseMs);
  const rows = await prisma.$queryRaw<Array<{ externalId: string }>>(Prisma.sql`
    INSERT INTO "ToolSideEffect"
      (id, "operationKey", "operationType", status, "externalId", request, "createdAt", "updatedAt")
    VALUES
      (${randomUUID()}, ${operationKey}, ${CLAIM_TYPE}, 'STARTED', ${ownerId},
       ${JSON.stringify({ taskId, expiresAt: expiresAt.toISOString() })}::jsonb, ${now}, ${now})
    ON CONFLICT ("operationKey") DO UPDATE SET
      "operationType" = EXCLUDED."operationType",
      status = 'STARTED',
      "externalId" = EXCLUDED."externalId",
      request = EXCLUDED.request,
      response = NULL,
      error = NULL,
      "updatedAt" = EXCLUDED."updatedAt"
    WHERE "ToolSideEffect".status <> 'STARTED'
       OR "ToolSideEffect"."updatedAt" <= ${liveCutoff}
    RETURNING "externalId"
  `);
  if (rows[0]?.externalId !== ownerId) {
    throw new Error(`Steel browser lifecycle is already in progress for task ${taskId}`);
  }
  try {
    return await callback();
  } finally {
    await prisma.toolSideEffect.updateMany({
      where: { operationKey, operationType: CLAIM_TYPE, status: 'STARTED', externalId: ownerId },
      data: { status: 'RELEASED', response: { releasedAt: new Date().toISOString() } },
    });
  }
}
