import assert from 'node:assert/strict';
import { mock } from 'node:test';
import type { Message, Prisma } from '@prisma/client';

async function main(): Promise<void> {
  let query: Prisma.MessageFindManyArgs | undefined;
  let rows: Message[] = [];
  let ownerFilter: Prisma.AgentFindFirstArgs | undefined;
  await mock.module('../../providers/database', {
    namedExports: {
      prisma: {
        agent: {
          findFirst: async (args: Prisma.AgentFindFirstArgs) => {
            ownerFilter = args;
            return {
              id: 'parent',
              userId: 'owner',
              parentAgentId: null,
              tools: [],
              verifier: null,
            };
          },
        },
        toolUsage: { findMany: async () => [] },
        agentTaskProgressEstimate: { findMany: async () => [] },
        message: {
          findMany: async (args: Prisma.MessageFindManyArgs) => {
            query = args;
            return rows;
          },
        },
      },
      runTransactionWithRetry: () => {
        throw new Error('unexpected transaction');
      },
    },
  });
  const { findMessages } = await import('../../domains/agents/repo');
  const floor = new Date('2026-10-15T00:00:00Z');
  // Reflect.apply keeps this reproduction runnable against the old two-argument API.
  await Reflect.apply(findMessages, undefined, ['parent', floor, 'browser-call']);
  assert.deepEqual(
    query,
    {
      where: {
        agentId: 'parent',
        AND: [
          {
            OR: [
              { timestamp: { gt: floor } },
              {
                role: 'TOOL',
                AND: [
                  { metadata: { path: ['userPause', 'reason'], equals: 'user' } },
                  {
                    metadata: {
                      path: ['userPause', 'recordedAt'],
                      gt: '2026-10-14T23:55:00.000Z',
                    },
                  },
                ],
              },
            ],
          },
        ],
        OR: [
          { role: 'USER' },
          {
            role: 'TOOL',
            AND: [
              { metadata: { path: ['toolCallId'], equals: 'browser-call' } },
              { metadata: { path: ['toolName'], equals: 'spawn_browser_agent' } },
              { metadata: { path: ['action_type'], equals: 'session_starting' } },
            ],
          },
        ],
      },
      orderBy: { timestamp: 'asc' },
    },
    'projection must reach the DB so large irrelevant transcripts are never loaded'
  );
  await findMessages('parent', floor);
  assert.deepEqual(
    query,
    {
      where: {
        agentId: 'parent',
        AND: [
          {
            OR: [
              { timestamp: { gt: floor } },
              {
                role: 'TOOL',
                AND: [
                  { metadata: { path: ['userPause', 'reason'], equals: 'user' } },
                  {
                    metadata: {
                      path: ['userPause', 'recordedAt'],
                      gt: '2026-10-14T23:55:00.000Z',
                    },
                  },
                ],
              },
            ],
          },
        ],
      },
      orderBy: { timestamp: 'asc' },
    },
    'ordinary GET includes in-place pause annotations while retaining producer timestamps'
  );
  await mock.module('../../providers/benchmarkHubStore', {
    namedExports: {
      findAgentAcrossRuns: () => {
        throw new Error('unexpected archive read');
      },
      findAncestorsAcrossRuns: () => [],
      findTreeAcrossRuns: () => [],
    },
  });
  const { getAgentDetail } = await import('../../domains/agents/agentQueryService');
  const metadata = { browserTaskId: 'native-task', arbitrary: ['keep', 'all'] };
  rows = [
    {
      id: 'user-row',
      timestamp: new Date(floor.getTime() + 500),
      role: 'USER',
      text: '  Exact bytes\n🦋  ',
      metadata,
      filePointer: null,
    } as unknown as Message,
  ];
  const detail = await getAgentDetail('parent', {
    userId: 'owner',
    since: floor,
    browserToolCallId: 'browser-call',
  });
  assert.ok(detail);
  assert.equal(detail.messages[0].text, rows[0].text);
  assert.deepEqual(detail.messages[0].metadata, metadata);
  assert.ok(query?.where?.OR, 'detail service must forward the projection to the repository');
  assert.deepEqual(ownerFilter?.where, { id: 'parent', userId: 'owner', deletedAt: null });
  process.stdout.write('PASS browser feedback repository projection and ordinary query\n');
}
void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
