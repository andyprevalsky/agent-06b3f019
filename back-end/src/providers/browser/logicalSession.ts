/** One durable, initially unmaterialized browser per GP owner and per Home. */
import { createHash } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { EMPTY_BROWSER_BASELINE } from './checkpoint';
import { runTransactionWithRetry } from '../database';
import { rootBrowserAgentId } from './worldStateMerge';
import { browserUseEnabled, DEFAULT_BROWSER_PROVIDER, tilionEnabled } from './config';
import { storedBrowserProvider } from './types';

export function logicalBrowserTaskId(agentId: string): string {
  const namespace = Buffer.from('6ba7b8119dad11d180b400c04fd430c8', 'hex');
  const bytes = createHash('sha1')
    .update(namespace)
    .update(`rose-browser-owner:${agentId}`)
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6]! & 15) | 80;
  bytes[8] = (bytes[8]! & 63) | 128;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export async function createLogicalBrowserInTransaction(
  tx: Prisma.TransactionClient,
  userId: string,
  agentId: string,
  emptyRef: string = EMPTY_BROWSER_BASELINE
) {
  if (agentId !== rootBrowserAgentId(userId)) {
    const agent = await tx.agent.findUniqueOrThrow({
      where: { id: agentId },
      select: { userId: true },
    });
    if (agent.userId !== userId) throw new Error('Logical browser owner mismatch');
  }
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`browser-network:${userId}`}, 0))`;
  const context = await tx.browserContext.upsert({
    where: { userId },
    update: {},
    create: { userId },
  });
  const configured = storedBrowserProvider(
    process.env.BROWSER_PROVIDER ?? DEFAULT_BROWSER_PROVIDER
  );
  const disabled =
    (configured === 'browser-use' && !browserUseEnabled()) ||
    (configured === 'tilion' && !tilionEnabled());
  const provider = disabled ? 'kernel' : configured;
  const existingHome = await tx.browserSession.findUnique({
    where: { logicalOwnerKey: `home:${userId}` },
  });
  if (!existingHome) {
    const legacy = await tx.browserSession.findFirst({
      where: {
        contextId: context.id,
        agentId: rootBrowserAgentId(userId),
        logicalOwnerKey: null,
        status: { in: ['ACTIVE', 'PAUSED'] },
      },
      orderBy: { createdAt: 'desc' },
    });
    if (legacy)
      await tx.browserSession.update({
        where: { id: legacy.id },
        data: { logicalOwnerKey: `home:${userId}`, baselineCheckpointRef: emptyRef },
      });
  }
  const home = await tx.browserSession.upsert({
    where: { logicalOwnerKey: `home:${userId}` },
    update: {},
    create: {
      id: logicalBrowserTaskId(rootBrowserAgentId(userId)),
      contextId: context.id,
      agentId: rootBrowserAgentId(userId),
      sessionId: null,
      status: 'PAUSED',
      provider,
      logicalOwnerKey: `home:${userId}`,
      baselineCheckpointRef: emptyRef,
    },
  });
  if (agentId === rootBrowserAgentId(userId)) return home;
  const baseline = home.checkpointRef ?? home.baselineCheckpointRef;
  if (!baseline) throw new Error('Home baseline is unavailable');
  return tx.browserSession.upsert({
    where: { logicalOwnerKey: `agent:${agentId}` },
    update: {},
    create: {
      id: logicalBrowserTaskId(agentId),
      contextId: context.id,
      agentId,
      sessionId: null,
      status: 'PAUSED',
      provider,
      logicalOwnerKey: `agent:${agentId}`,
      baselineCheckpointRef: baseline,
    },
  });
}

export async function ensureLogicalBrowser(userId: string, agentId: string) {
  return runTransactionWithRetry((tx) => createLogicalBrowserInTransaction(tx, userId, agentId));
}
