import { randomUUID } from 'crypto';
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

export const authAssistanceGateCleanupTests: TestCase[] = [
  ['gate cleanup preserves a concurrently appended waiter', testGateWaiterAppendWinsMetadataCas],
];
