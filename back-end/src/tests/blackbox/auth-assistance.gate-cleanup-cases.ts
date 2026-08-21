import { randomUUID } from 'crypto';
import { Prisma } from '@prisma/client';
import { closeInterruptedAttentionRequests } from '../../providers/staleWorkflowTools';

type TestCase = [string, () => Promise<void>];

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function testGateWaiterAppendWinsMetadataCas(): Promise<void> {
  const agentId = randomUUID();
  const originalMetadata = { attentionKind: 'gate' };
  let currentMetadata: unknown = originalMetadata;
  const client = {
    agentAttentionRequest: {
      findMany: async () => [
        { id: 'racing-gate', gateKey: 'source_connect:racing', metadata: originalMetadata },
      ],
      updateMany: async (args: { where: { metadata?: { equals?: unknown } } }) => {
        // Model appendGateWaiter committing after cleanup's read but before its
        // update reaches the row lock.
        currentMetadata = {
          ...originalMetadata,
          gateWaiters: [{ agentId: randomUUID(), workflowId: randomUUID() }],
        };
        return {
          count:
            JSON.stringify(args.where.metadata?.equals) === JSON.stringify(currentMetadata) ? 1 : 0,
        };
      },
    },
  } as unknown as Parameters<typeof closeInterruptedAttentionRequests>[0];

  const closed = await closeInterruptedAttentionRequests(client, agentId, agentId);
  assert(closed === 0, 'cleanup metadata CAS must not erase a concurrently appended waiter');
}

async function testNullMetadataUsesSqlOrJsonNullCas(): Promise<void> {
  let comparedWithAnyNull = false;
  const client = {
    agentAttentionRequest: {
      findMany: async () => [{ id: 'null-metadata', gateKey: null, metadata: null }],
      updateMany: async (args: { where: { metadata?: { equals?: unknown } } }) => {
        comparedWithAnyNull = args.where.metadata?.equals === Prisma.AnyNull;
        return { count: comparedWithAnyNull ? 1 : 0 };
      },
    },
  } as unknown as Parameters<typeof closeInterruptedAttentionRequests>[0];

  const closed = await closeInterruptedAttentionRequests(client, randomUUID(), randomUUID());
  assert(comparedWithAnyNull, 'nullable JSON metadata CAS must match SQL NULL and JSON null');
  assert(closed === 1, 'null-metadata attention request should be closed by the CAS');
}

export const authAssistanceGateCleanupTests: TestCase[] = [
  ['gate cleanup preserves a concurrently appended waiter', testGateWaiterAppendWinsMetadataCas],
  [
    'gate cleanup compares nullable JSON metadata with AnyNull',
    testNullMetadataUsesSqlOrJsonNullCas,
  ],
];
